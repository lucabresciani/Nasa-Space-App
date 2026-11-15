#!/usr/bin/env python3
"""`make web`: copy and transform pipeline outputs in data/interim/ into web/public/data/.

AGENTS.md: web-facing files reach web/public/data/ only via `make web` (owner C). Steps:

1. Plan. Every rule in RULES (owner, source glob under data/interim/, destination under
   web/public/data/) is expanded. A rule with no match is reported as missing under its owner
   and skipped: nothing is ever faked or filled in.
2. Refuse. A JSON/GeoJSON source with a top-level ``"dummy": true`` or ``"synthetic": true``, a
   source that resolves into web/public/data-dummy/, a source whose mtime is before H0, and a
   manifest fragment written by the dummy generator all stop the run before the public tree is
   touched (exit 1).
3. Copy. web/public/data/ is emptied (``.gitkeep`` kept) and every planned file is copied with
   its mtime kept (``shutil.copy2``), so the H0 check sees when the producer wrote it.
   Transforms (format only, no new values):
   * WS1 basemap tiles ``{z}/{x}/{y}.png`` -> WebP per ``config/web.yaml web_export.basemap``;
     if the tiles exceed ``budget_mb`` the top zoom is dropped (z18 first) until they fit; a
     ``tiles/basemap/tilejson.json`` (contracts/tilejson.schema.json) describes exactly the
     tiles written.
   * WS1 ``cellstate_3m.tif`` -> ``terrain/cellstate.png`` + ``terrain/cellstate.json``
     (contracts/cellstate.schema.json): one pixel per routing cell, RGBA, counts = state
     (0 assessed, 1 blocked), A = 0 unknown. ``cellstate_3m_conservative.tif`` (v1.1.2) ->
     ``terrain/cellstate_conservative.{png,json}`` the same way (variant from the file name).
   * Station cards (C decision 2026-11-14 11:42): ``cards/{S}.json`` = WS3's
     ``horizon/public/cards/{S}.json`` (navcam, skyline error, panorama, landmarks) merged with
     WS2's ``engine/public/cards/{S}.timeline.json`` (timeline, margin, contingency, access).
     A station lacking either part gets no card (and no card images): it is reported missing
     under the owner of the absent part. Parts that disagree (station id, science point, access
     cell) are refused. The ``*.timeline.json`` parts never reach the web tree.
4. Manifest. ``pipeline.provenance.manifest.merge`` (WS6) of the data/interim/manifest/
   fragments -> web/public/data/manifest.json. Until WS1 records through ``manifest.record``,
   its ``terrain/manifest_pending.json`` (same entry format) is merged as WS1's fragment.
   Entries citing a web file that this run does not write (a skipped owner's, an output still
   missing, a card not built) are left out, as are a skipped owner's entries citing its
   ``data/interim/`` sources; entries citing other pipeline-internal ``data/`` files stay.
5. Validate. ``tools/validate_contracts.py`` (contracts, dummy flags, 50 MB) and
   ``pipeline.provenance.check_h0`` (no manifest time or file mtime before H0).
6. Report. Files present and missing, grouped by owner workstream; size per top-level folder.

Exit 0 only if every step passes. Sources: contracts/README.md "`make web` sources".
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import shutil
import sys
import tempfile
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from fnmatch import fnmatchcase
from pathlib import Path

import numpy as np
import yaml

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

INTERIM = REPO / "data" / "interim"
PUBLIC = REPO / "web" / "public" / "data"
DUMMY_TREE = REPO / "web" / "public" / "data-dummy"
CONFIG_DIR = REPO / "config"
SCRIPT = "tools/make_web.py"
KEEP = {".gitkeep"}
JSON_SUFFIXES = {".json", ".geojson"}
REFUSE_FLAGS = ("dummy", "synthetic")
DUMMY_SCRIPT = "tools/make_dummy.py"
BASEMAP_DEST = "tiles/basemap"
TILEJSON = f"{BASEMAP_DEST}/tilejson.json"
CELLSTATE_JSON = "terrain/cellstate.json"
CELLSTATE_PNG = "terrain/cellstate.png"
CELLSTATE_CONS_JSON = "terrain/cellstate_conservative.json"  # v1.1.2
CELLSTATE_CONS_PNG = "terrain/cellstate_conservative.png"
# variant (from the source file name, WS1) -> manifest key prefix of its pct
CELLSTATE_KEYS = {"nominal": "terrain.cellstate.pct", "conservative":
                  "terrain.cellstate_conservative.pct"}
CELLSTATE_CODES = {"0": "assessed", "1": "blocked", "2": "unknown"}
TILE_SUFFIX = {"webp": ".webp", "png": ".png"}
CARD_PARTS = {"WS3": re.compile(r"^(S[0-9]+)\.json$"),
              "WS2": re.compile(r"^(S[0-9]+)\.timeline\.json$")}
CARD_PART_NAME = {"WS3": "horizon part (WS3)", "WS2": "timeline part (WS2)"}
CARD_PART_SRC = {"WS3": "data/interim/horizon/public/cards/{S}.json",
                 "WS2": "data/interim/engine/public/cards/{S}.timeline.json"}
CARD_DROP = {"WS3": ("station", "producer", "built_utc"), "WS2": ("station",)}
# Web paths a producer writes but that must not be published yet (web path -> reason). Reported
# as "withheld" (never copied, never "missing"); their manifest entries are left out.
# pad.json was withheld 14:58-15:30 and released after WS2 session 5 (pad = pad_default).
WITHHELD: dict[str, str] = {}
WS1_PENDING = "terrain/manifest_pending.json"
WS1_FRAGMENT = "pipeline__terrain__build.json"


@dataclass(frozen=True)
class Rule:
    """Copy every file matching ``root/pattern`` (both relative to data/interim/).

    Destination: ``to`` for a single-file rule, else the path relative to ``root`` (the root
    mirrors web/public/data/), prefixed by ``to`` when ``kind`` is "tiles". ``web`` is the web
    path pattern shown in the missing report.
    """

    owner: str
    root: str
    pattern: str
    to: str | None = None
    kind: str = "copy"  # copy | tiles | cellstate | card_part | card_image

    @property
    def src(self) -> str:
        return f"{self.root}/{self.pattern}"

    @property
    def web(self) -> str:
        if self.kind == "tiles":
            return f"{self.to}/{{z}}/{{x}}/{{y}}"
        if self.kind == "card_part":
            return f"cards/{{S}}.json ({CARD_PART_NAME[self.owner]})"
        return self.to or self.pattern

    @property
    def skip_patterns(self) -> list[str]:
        """Web paths whose manifest entries are left out when this rule's owner is skipped."""
        own = f"data/interim/{self.src}"  # entries that cite the interim source itself
        if self.kind == "tiles":
            return [f"{self.to}/*", own]
        if self.kind == "card_part":  # no card can be merged without this part
            return ["cards/*.json", "cards/*/*", own]
        return [self.to or self.pattern, own]


# contracts/README.md path table -> producer output paths. Only these patterns are copied, never
# internal files (rasters, horizons/, nav_synthetic/, run reports).
RULES: list[Rule] = [
    # WS1 terrain (pipeline/terrain/grid.py OUT = data/interim/terrain/)
    Rule("WS1", "terrain", "coverage.json", to="validation/coverage.json"),
    Rule("WS1", "terrain", "coverage.png", to="validation/coverage.png"),
    Rule("WS1", "terrain", "coreg.json", to="validation/coreg.json"),
    Rule("WS1", "terrain", "cellstate_3m.tif", to=CELLSTATE_JSON, kind="cellstate"),
    Rule("WS1", "terrain", "cellstate_3m_conservative.tif", to=CELLSTATE_CONS_JSON,
         kind="cellstate"),
    Rule("WS1", "terrain/tiles/basemap", "*/*/*.png", to=BASEMAP_DEST, kind="tiles"),
    # WS2 engine: engine/public/ mirrors web/public/data/ (pipeline/engine/scenarios.py PUBLIC)
    Rule("WS2", "engine/public", "scenarios/index.json"),
    Rule("WS2", "engine/public", "scenarios/*/isochrones.geojson"),
    Rule("WS2", "engine/public", "scenarios/bands_*.geojson"),
    Rule("WS2", "engine/public", "scenarios/*/edges.geojson"),
    Rule("WS2", "engine/public", "scenarios/*/partner.geojson"),
    Rule("WS2", "engine/public", "stations.json"),
    Rule("WS2", "engine/public", "route_*.geojson"),
    Rule("WS2", "engine/public", "timeline_*.json"),
    Rule("WS2", "engine/public", "trade_table.json"),
    Rule("WS2", "engine/public", "pad.json"),
    Rule("WS2", "engine/public", "siting.png"),
    Rule("WS2", "engine/public", "siting_png.json"),
    Rule("WS2", "engine/public", "cards/*.timeline.json", kind="card_part"),
    # v1.1.4 D21 rover parking options (C layout 16:17): ranking table + per picker pad its
    # summary and nominal-suit layers; no isochrones or field rasters (those stay in interim)
    Rule("WS2", "engine/public", "scenarios/pads/index.json"),
    Rule("WS2", "engine/public", "scenarios/pads/*/summary.json"),
    Rule("WS2", "engine/public", "scenarios/pads/*/bands_*.geojson"),
    Rule("WS2", "engine/public", "scenarios/pads/*/edges.geojson"),
    Rule("WS2", "engine/public", "scenarios/pads/*/partner.geojson"),
    Rule("WS2", "engine/public", "scenarios/pads/*/route_*.geojson"),
    Rule("WS2", "engine/public", "scenarios/pads/*/timeline_*.json"),
    # v1.1.5: physiology golden vectors (D41; pipeline/engine/golden.py)
    Rule("WS2", "engine/public", "physio/golden.json"),
    # WS3 horizon: V2 (pipeline/validation/v2_skyline.py V2_OUT); horizon/public/ mirrors the
    # web tree for the card images (+ card horizon part) and the 3D horizon ring
    Rule("WS3", "horizon/validation", "v2.json", to="validation/v2.json"),
    Rule("WS3", "horizon/public", "cards/*.json", kind="card_part"),
    Rule("WS3", "horizon/public", "cards/*/*.png", kind="card_image"),
    Rule("WS3", "horizon/public", "fp3d/horizon_ring.json"),
    # WS4 conditions (pipeline/conditions/config.py INTERIM / conditions/)
    *(Rule("WS4", "conditions", f"{n}.json", to=f"conditions/{n}.json")
      for n in ("rad", "clock", "rems", "donki")),
    # WS6 validation (pipeline/validation/v1_tilt.py, pipeline/provenance/kats.py)
    Rule("WS6", "validation", "v1.json", to="validation/v1.json"),
    Rule("WS6", "validation", "v1.svg", to="validation/v1.svg"),
    Rule("WS6", "validation", "kats.json", to="validation/kats.json"),
    *(Rule("WS16", "export", f"{t}/{f}") for t in ("terrain", "terrain_low") for f in ("tiles.json", "*/*/*.png")),  # noqa: E501 U1 elevation tiles (pipeline/export/terrain_tiles.py)
    # WS7 fields, WS8 3D: export/ mirrors the web tree (pipeline/export/*)
    Rule("WS7", "export", "fields/index.json"),
    Rule("WS7", "export", "fields/*/*.png"),
    Rule("WS8", "export", "fp3d/index.json"),
    Rule("WS8", "export", "fp3d/near/*.f32.gz"),
    Rule("WS8", "export", "fp3d/near_tex/*.jpg"),
    Rule("WS8", "export", "fp3d/far.f32.gz"),
    Rule("WS8", "export", "fp3d/far_tex.jpg"),  # WS8 STATUS: 8 m ortho over the far mesh
    Rule("WS16", "export", "labels.json"),  # U13 labels (pipeline/export/labels.py, DESIGN §6.2)
    *(Rule("WS16", "export", f) for f in ("overlays/index.json", "overlays/contours.geojson", "overlays/*.png", "overlays/*/*/*/*.png", "highlights/*.geojson")),  # noqa: E501 U7 overlays + highlights (pipeline/export/contours.py, overlays.py, highlights.py)
    # WS9 navigation, real run only (pipeline/navigation/real.py REAL_OUT; never nav_synthetic/)
    Rule("WS9", "navigation", "nav/montecarlo_*.json"),
    Rule("WS9", "navigation", "nav/fixes.json"),
    Rule("WS9", "navigation", "nav/tracks_*.geojson"),
    Rule("WS9", "navigation", "nav/fix_interval_summary.json"),
    Rule("WS9", "navigation", "fields/fix_interval_*.png"),
    Rule("WS9", "navigation", "localisation/*.json"),
    # WS10 visual odometry (pipeline/navigation/vo_probe.py OUT, vo.py)
    Rule("WS10", "vo", "probe.json", to="vo/probe.json"),
    Rule("WS10", "vo", "drift.json", to="vo/drift.json"),
]


def load_settings(config_dir: Path = CONFIG_DIR) -> dict:
    """``web_export.basemap`` from config/web.yaml."""
    cfg = yaml.safe_load((config_dir / "web.yaml").read_text(encoding="utf-8"))
    b = cfg["web_export"]["basemap"]
    if b["format"] not in TILE_SUFFIX:
        raise ValueError(f"config/web.yaml basemap.format {b['format']!r} not in {TILE_SUFFIX}")
    return b


def load_site(config_dir: Path = CONFIG_DIR) -> dict:
    return yaml.safe_load((config_dir / "site.yaml").read_text(encoding="utf-8"))


@dataclass
class Copy:
    owner: str
    src: Path
    dst: Path  # relative to the public tree
    kind: str = "copy"
    tile: tuple[int, int, int] | None = None


@dataclass
class CardMerge:
    station: str
    parts: dict[str, Path]  # owner -> source part
    doc: dict  # the merged card

    @property
    def dst(self) -> Path:
        return Path("cards") / f"{self.station}.json"


@dataclass
class Plan:
    copies: list[Copy] = field(default_factory=list)
    missing: list[tuple[str, str, str]] = field(default_factory=list)  # (owner, web, source)
    refused: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    cards: list[CardMerge] = field(default_factory=list)
    unbuilt_cards: list[str] = field(default_factory=list)  # stations with a part but no card

    @property
    def tiles(self) -> list[Copy]:
        return [c for c in self.copies if c.kind == "tiles"]


def flagged(path: Path) -> str | None:
    """The refusal flag ("dummy"/"synthetic") set to true at the top level, else None."""
    if path.suffix.lower() not in JSON_SUFFIXES:
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None  # the validator reports unreadable JSON after the copy
    if isinstance(doc, dict):
        for flag in REFUSE_FLAGS:
            if doc.get(flag) is True:
                return flag
    return None


def tile_zxy(rel: Path) -> tuple[int, int, int] | None:
    try:
        z, x, y = rel.parts
        return int(z), int(x), int(Path(y).stem)
    except ValueError:
        return None


def plan(interim: Path = INTERIM, rules: list[Rule] = RULES, dummy_tree: Path = DUMMY_TREE,
         settings: dict | None = None, h0: datetime | None = None) -> Plan:
    settings = load_settings() if settings is None else settings
    p = Plan()
    seen: dict[Path, Path] = {}
    dummy_root = dummy_tree.resolve()
    h0_ts = h0.timestamp() if h0 is not None else None
    card_parts: dict[str, dict[str, Path]] = defaultdict(dict)
    for rule in rules:
        matches = sorted(q for q in interim.glob(rule.src) if q.is_file())
        if not matches:
            p.missing.append((rule.owner, rule.web, f"data/interim/{rule.src}"))
            continue
        above = 0
        for src in matches:
            real = src.resolve()
            if real == dummy_root or dummy_root in real.parents:
                p.refused.append(f"refused: {src} resolves into {dummy_tree} ({rule.owner})")
                continue
            flag = flagged(src)
            if flag:
                p.refused.append(f'refused: {src} has "{flag}": true ({rule.owner})')
                continue
            if h0_ts is not None and src.stat().st_mtime < h0_ts:
                p.refused.append(f"refused: {src} was written before H0 ({rule.owner})")
                continue
            if rule.kind == "card_part":
                m = CARD_PARTS[rule.owner].match(src.name)
                if m is None:
                    p.skipped.append(f"skipped: {src} is not a {CARD_PART_NAME[rule.owner]} "
                                     f"(name {CARD_PARTS[rule.owner].pattern})")
                else:
                    card_parts[m.group(1)][rule.owner] = src
                continue
            tile = None
            if rule.kind == "tiles":
                rel = src.relative_to(interim / rule.root)
                tile = tile_zxy(rel)
                if tile is None:
                    p.skipped.append(f"skipped: {src} is not a {{z}}/{{x}}/{{y}}.png tile")
                    continue
                if tile[0] > int(settings["maxzoom"]):
                    above += 1
                    continue
                dst = Path(rule.to) / rel.with_suffix(TILE_SUFFIX[settings["format"]])
            elif rule.to:
                dst = Path(rule.to)
            else:
                dst = src.relative_to(interim / rule.root)
            if dst.as_posix() in WITHHELD:
                p.skipped.append(f"withheld: data/interim/{src.relative_to(interim).as_posix()} "
                                 f"-> {dst.as_posix()} ({WITHHELD[dst.as_posix()]})")
                continue
            if dst in seen:
                p.refused.append(f"refused: {src} and {seen[dst]} both map to {dst}")
                continue
            seen[dst] = src
            p.copies.append(Copy(rule.owner, src, dst, rule.kind, tile))
        if above:
            p.skipped.append(f"skipped: {above} tiles of data/interim/{rule.src} above maxzoom "
                             f"{settings['maxzoom']} (config/web.yaml)")
    pair_cards(p, card_parts, {r.owner for r in rules if r.kind == "card_part"}, seen)
    return p


# --------------------------------------------------------------------------- station cards


class CardMergeError(ValueError):
    pass


def _same(a, b, tol: float = 1e-6) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) <= tol


def merge_card(station: str, horizon: dict, timeline: dict,
               sources: dict[str, str] | None = None) -> dict:
    """``cards/{station}.json`` from WS3's horizon part and WS2's timeline part.

    Nothing is computed: every key comes from one part. Refused (CardMergeError) when a part
    names another station, both parts set the same key, or they disagree on the science point
    or the access cell (WS3's horizon observer must stand where WS2's route ends)."""
    for owner, doc in (("WS3", horizon), ("WS2", timeline)):
        if not isinstance(doc, dict):
            raise CardMergeError(f"{station}: {CARD_PART_NAME[owner]} is not an object")
        if doc.get("station", station) != station:
            raise CardMergeError(f"{station}: {CARD_PART_NAME[owner]} is for station "
                                 f"{doc.get('station')!r}")
    h = {k: v for k, v in horizon.items() if k not in CARD_DROP["WS3"]}
    t = {k: v for k, v in timeline.items() if k not in CARD_DROP["WS2"]}
    clash = sorted(set(h) & set(t))
    if clash:
        raise CardMergeError(f"{station}: both parts set {clash}")
    obs = h.get("observer") or {}
    sci = t.get("science") or {}
    acc = t.get("access") or {}
    if "science_lon" in obs and sci and not (_same(obs.get("science_lon"), sci.get("lon"))
                                             and _same(obs.get("science_lat"), sci.get("lat"))):
        raise CardMergeError(f"{station}: science point differs (WS3 observer "
                             f"{obs.get('science_lon')}, {obs.get('science_lat')}; WS2 "
                             f"{sci.get('lon')}, {sci.get('lat')})")
    if acc:
        at_access = obs.get("position") == "access_cell"
        if acc.get("lon") is None and at_access:
            raise CardMergeError(f"{station}: WS3 horizon is at an access cell but WS2 has none "
                                 "(re-run the WS3 cards after the engine run)")
        if acc.get("lon") is not None and obs and not (
                at_access and _same(obs.get("lon"), acc["lon"])
                and _same(obs.get("lat"), acc.get("lat"))):
            raise CardMergeError(f"{station}: WS3 horizon observer ({obs.get('position')}, "
                                 f"{obs.get('lon')}, {obs.get('lat')}) is not WS2's access cell "
                                 f"({acc['lon']}, {acc.get('lat')}) (re-run the WS3 cards after "
                                 "the engine run)")
    parts = {"WS3": {"producer": horizon.get("producer"), "built_utc": horizon.get("built_utc")},
             "WS2": {"producer": timeline.get("producer", "WS2 pipeline/engine/cards.py")}}
    for owner, src in (sources or {}).items():
        parts[owner] = {"source": src, **parts[owner]}
    return {"station": station, **t, **h, "parts": {"merged_by": SCRIPT, **parts}}


def pair_cards(p: Plan, card_parts: dict[str, dict[str, Path]], owners: set[str],
               seen: dict[Path, Path]) -> None:
    """Merge the card parts station by station; a station lacking a part gets no card (missing
    under the absent part's owner, or a skip note if that owner is skipped) and no images."""
    for st in sorted(card_parts, key=lambda s: int(s[1:])):
        parts = card_parts[st]
        lacking = [o for o in CARD_PARTS if o not in parts]
        if lacking:
            p.unbuilt_cards.append(st)
            for o in lacking:
                if o in owners:
                    p.missing.append((o, f"cards/{st}.json ({CARD_PART_NAME[o]})",
                                      CARD_PART_SRC[o].format(S=st)))
                else:
                    p.skipped.append(f"skipped: cards/{st}.json not built ({o} skipped)")
            continue
        try:
            docs = {o: json.loads(parts[o].read_text(encoding="utf-8")) for o in CARD_PARTS}
            doc = merge_card(st, docs["WS3"], docs["WS2"],
                             {o: CARD_PART_SRC[o].format(S=st) for o in CARD_PARTS})
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, CardMergeError) as exc:
            p.refused.append(f"refused: card {st}: {exc}")
            continue
        cm = CardMerge(st, parts, doc)
        if cm.dst in seen:
            p.refused.append(f"refused: card {st} and {seen[cm.dst]} both map to {cm.dst}")
            continue
        seen[cm.dst] = parts["WS3"]
        p.cards.append(cm)
    built = {c.station for c in p.cards}
    images = [c for c in p.copies if c.kind == "card_image"]
    for c in images:
        if c.dst.parts[1] not in built:
            p.copies.remove(c)
            p.skipped.append(f"skipped: {c.src} (no card {c.dst.parts[1]})")


def write_cards(cards: list[CardMerge], public: Path) -> None:
    for c in cards:
        out = public / c.dst
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(c.doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        keep_mtime(max(q.stat().st_mtime for q in c.parts.values()), out)


def clear_public(public: Path) -> int:
    """Empty the public tree (keep .gitkeep). Returns the number of files removed."""
    n = 0
    if not public.is_dir():
        public.mkdir(parents=True)
        return 0
    for q in sorted(public.iterdir()):
        if q.name in KEEP:
            continue
        if q.is_dir() and not q.is_symlink():
            n += sum(1 for r in q.rglob("*") if r.is_file())
            shutil.rmtree(q)
        else:
            n += 1
            q.unlink()
    return n


def keep_mtime(src: Path | float, out: Path) -> None:
    """Give ``out`` the producer's mtime (a path's, or a timestamp): the H0 check must see when
    the data was made, not when make web ran."""
    t = src if isinstance(src, float) else src.stat().st_mtime
    os.utime(out, (t, t))


# --------------------------------------------------------------------------- basemap tiles


def encode_tile(args: tuple[str, str, str, int, int]) -> int:
    """Re-encode one tile; returns the output size in bytes (worker for the process pool)."""
    from PIL import Image

    src, out, fmt, quality, method = args
    with Image.open(src) as im:
        im.load()
        if fmt == "webp":
            im.save(out, "WEBP", quality=quality, method=method)
        else:
            im.save(out, "PNG", optimize=True)
    keep_mtime(Path(src), Path(out))
    return Path(out).stat().st_size


def tile_lonlat(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """[w, s, e, n] of an XYZ (Web Mercator tile scheme) tile; Mars lon/lat pass through (D4)."""
    n = 2.0**z

    def lat(yy: float) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    return x / n * 360.0 - 180.0, lat(y + 1), (x + 1) / n * 360.0 - 180.0, lat(y)


def union(boxes) -> list[float]:
    boxes = list(boxes)
    return [round(min(b[0] for b in boxes), 6), round(min(b[1] for b in boxes), 6),
            round(max(b[2] for b in boxes), 6), round(max(b[3] for b in boxes), 6)]


def tilejson_for(tiles: list[tuple[int, int, int]], settings: dict,
                 source: str | None = None) -> dict:
    """TileJSON (contracts/tilejson.schema.json) describing exactly these tiles.

    A zoom is *full* when it tiles the same extent as the zoom below it: its tile range reaches
    into the edge tile's children on every side (x0 <= 2 px0 + 1, x1 >= 2 px1, same for y).
    ``bounds`` = tile extent of the last full zoom above minzoom; every zoom above it (tiled over
    a smaller area, e.g. z17-18 over the focus area only) gets its own ``zoom_bounds`` entry."""
    by_z: dict[int, list] = defaultdict(list)
    rng: dict[int, list[int]] = {}
    for z, x, y in tiles:
        by_z[z].append(tile_lonlat(z, x, y))
        r = rng.setdefault(z, [x, x, y, y])
        r[:] = [min(r[0], x), max(r[1], x), min(r[2], y), max(r[3], y)]
    box = {z: union(b) for z, b in by_z.items()}
    zs = sorted(box)
    base = zs[0]
    for z in zs[1:]:
        if z != base + 1:
            break
        (x0, x1, y0, y1), (p0, p1, q0, q1) = rng[z], rng[base]
        if not (x0 <= 2 * p0 + 1 and x1 >= 2 * p1 and y0 <= 2 * q0 + 1 and y1 >= 2 * q1):
            break
        base = z
    bounds = box[base]
    fmt = settings["format"]
    doc = {
        "tilejson": "3.0.0",
        "name": "HiRISE basemap (WS1)",
        "scheme": "xyz",
        "format": fmt,
        "tileSize": int(settings["tile_size_px"]),
        "tiles": [f"{BASEMAP_DEST}/{{z}}/{{x}}/{{y}}{TILE_SUFFIX[fmt]}"],
        "minzoom": zs[0],
        "maxzoom": zs[-1],
        "bounds": bounds,
        "attribution": settings["attribution"],
        "zoom_bounds": {str(z): box[z] for z in zs if z > base},
        "tile_count": {str(z): len(by_z[z]) for z in zs},
    }
    if source:
        doc["source"] = source
    return doc


def write_tiles(tiles: list[Copy], public: Path, settings: dict, interim: Path,
                out=print, workers: int | None = None) -> dict | None:
    """Encode the basemap tiles, enforce the size budget, write the TileJSON. Returns it."""
    if not tiles:
        return None
    fmt = settings["format"]
    jobs = []
    for c in tiles:
        (public / c.dst).parent.mkdir(parents=True, exist_ok=True)
        jobs.append((str(c.src), str(public / c.dst), fmt, int(settings["quality"]),
                     int(settings["method"])))
    with ProcessPoolExecutor(max_workers=workers) as ex:
        sizes = list(ex.map(encode_tile, jobs, chunksize=16))
    kept = [(c.tile, s) for c, s in zip(tiles, sizes, strict=True)]
    budget = float(settings["budget_mb"]) * 1e6
    src_mb = sum(c.src.stat().st_size for c in tiles) / 1e6
    while sum(s for _, s in kept) > budget:
        zmax = max(t[0] for t, _ in kept)
        if zmax == min(t[0] for t, _ in kept):
            raise RuntimeError(f"basemap: one zoom level alone exceeds {settings['budget_mb']} MB")
        shutil.rmtree(public / BASEMAP_DEST / str(zmax))
        out(f"basemap: dropped z{zmax} (total over the {settings['budget_mb']} MB budget)")
        kept = [(t, s) for t, s in kept if t[0] != zmax]
    meta = interim / "terrain" / "basemap.json"
    source = None
    if meta.is_file():
        source = json.loads(meta.read_text(encoding="utf-8")).get("source")
    doc = tilejson_for([t for t, _ in kept], settings, source)
    path = public / TILEJSON
    path.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    keep_mtime(max(c.src.stat().st_mtime for c in tiles), path)
    total = sum(s for _, s in kept) / 1e6
    out(f"basemap: {len(kept)} tiles z{doc['minzoom']}-{doc['maxzoom']} as {fmt} "
        f"q{settings['quality']}: {total:.1f} MB (from {src_mb:.1f} MB PNG)")
    return doc


# --------------------------------------------------------------------------- cell states


def encode_cellstate(state: np.ndarray) -> tuple[bytes, dict]:
    """RGBA PNG per contracts/cellstate.schema.json: counts = state for 0/1 (R*256 + G), B = 0,
    A = 255 known; A = 0 for state 2 and any other code (unknown). Returns (png, pct)."""
    from PIL import Image

    state = np.asarray(state)
    known = (state == 0) | (state == 1)
    rgba = np.zeros(state.shape + (4,), dtype=np.uint8)
    rgba[..., 1] = np.where(state == 1, 1, 0)
    rgba[..., 3] = np.where(known, 255, 0)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    n = state.size
    pct = {"assessed": round(100 * np.count_nonzero(state == 0) / n, 2),
           "blocked": round(100 * np.count_nonzero(state == 1) / n, 2),
           "unknown": round(100 * np.count_nonzero(~known) / n, 2)}
    return buf.getvalue(), pct


def lonlat_bounds(transform, width: int, height: int, site: dict) -> list[float]:
    """[w, s, e, n] of a north-up raster in the analysis CRS (site.yaml), as lon/lat."""
    from pyproj import Transformer

    crs = site["crs"]
    tr = Transformer.from_crs(crs["analysis_proj"], f"+proj=longlat +R={crs['mars_radius_m']} "
                              "+no_defs", always_xy=True)
    xs = [transform.c, transform.c + transform.a * width]
    ys = [transform.f, transform.f + transform.e * height]
    lon, lat = tr.transform([xs[0], xs[1], xs[1], xs[0]], [ys[0], ys[0], ys[1], ys[1]])
    return [round(min(lon), 6), round(min(lat), 6), round(max(lon), 6), round(max(lat), 6)]


def cellstate_variant(src: Path) -> str:
    """WS1 names the conservative raster ``cellstate_3m_conservative.tif``."""
    return "conservative" if "conservative" in src.name else "nominal"


def cellstate_png(dst: Path) -> str:
    """The PNG beside a cell-state JSON web path (terrain/cellstate[_conservative].png)."""
    return dst.with_suffix(".png").as_posix()


@dataclass
class CellState:
    copy: Copy
    png: bytes
    doc: dict


def prepare_cellstate(c: Copy, site: dict, out=print,
                      fragment_dir: Path | None = None) -> CellState:
    """Read and encode one cell-state raster and record its ``pct`` keys. Runs before the
    public tree is cleared: ``git_commit()`` reads '-dirty' once the tracked web/public/data/
    files are rewritten, so recording later marks clean code dirty (WS6 audit 1)."""
    import rasterio

    with rasterio.open(c.src) as ds:
        state = ds.read(1)
        if abs(ds.transform.b) > 0 or abs(ds.transform.d) > 0 or ds.transform.e >= 0:
            raise ValueError(f"{c.src}: not a north-up grid")
        bounds = lonlat_bounds(ds.transform, ds.width, ds.height, site)
        res = float(ds.transform.a)
    png, pct = encode_cellstate(state)
    js = c.dst.as_posix()
    variant = cellstate_variant(c.src)
    doc = {"image": cellstate_png(c.dst), "bounds": bounds, "width": int(state.shape[1]),
           "height": int(state.shape[0]), "res_m": res, "variant": variant,
           "codes": CELLSTATE_CODES, "pct": pct,
           "source": f"data/interim/{c.src.relative_to(c.src.parents[1]).as_posix()} (WS1)"}
    from pipeline.provenance.manifest import record

    for k, v in pct.items():
        record(f"{CELLSTATE_KEYS[variant]}.{k}", v, "%", js, SCRIPT, fragment_dir=fragment_dir)
    out(f"cellstate ({variant}): {state.shape[1]} x {state.shape[0]} at {res:g} m -> "
        f"{doc['image']} ({len(png) / 1e6:.2f} MB; assessed {pct['assessed']} %, blocked "
        f"{pct['blocked']} %, unknown {pct['unknown']} %)")
    return CellState(c, png, doc)


def write_cellstate(cs: CellState, public: Path) -> None:
    im, js = cs.doc["image"], cs.copy.dst.as_posix()
    (public / im).parent.mkdir(parents=True, exist_ok=True)
    (public / im).write_bytes(cs.png)
    (public / js).write_text(json.dumps(cs.doc, indent=1) + "\n", encoding="utf-8")
    for p in (im, js):
        keep_mtime(cs.copy.src, public / p)


# --------------------------------------------------------------------------- manifest


def manifest_fragments(fragment_dir: Path, interim: Path, tmp: Path, out=print,
                       skip_files: list[str] = (), written: set[str] | None = None,
                       pattern: str = "*.json", bridge: bool = True) -> list[str]:
    """Stage the fragments to merge in ``tmp``; returns refusals (dummy-made fragments).
    Entries whose ``file`` matches a ``skip_files`` pattern (a skipped owner's paths), or names
    a web path (not ``data/...``) outside ``written`` (an output missing this run), are left
    out, so the manifest never names a web file that make web did not write."""

    def drop(f: str) -> bool:
        if any(fnmatchcase(f, pat) for pat in skip_files):
            return True
        return written is not None and bool(f) and not f.startswith("data/") \
            and f not in written

    refused = []
    tmp.mkdir(parents=True, exist_ok=True)
    for f in sorted(fragment_dir.glob(pattern)) if fragment_dir.is_dir() else []:
        frag = json.loads(f.read_text(encoding="utf-8"))
        bad = [k for k, e in frag.items()
               if isinstance(e, dict) and (e.get("script") == DUMMY_SCRIPT
                                           or e.get("commit") == "dummy")]
        if bad:
            refused.append(f"refused: manifest fragment {f} has dummy entries ({bad[:3]} ...)")
            continue
        kept = {k: e for k, e in frag.items()
                if not (isinstance(e, dict) and drop(str(e.get("file") or "")))}
        if len(kept) < len(frag):
            out(f"manifest: {len(frag) - len(kept)} entries of {f.name} left out (their file "
                "is not written this run: owner skipped or output missing)")
            (tmp / f.name).write_text(json.dumps(kept), encoding="utf-8")
            continue
        shutil.copy2(f, tmp / f.name)
    pending = interim / WS1_PENDING
    if bridge and pending.is_file() and not (tmp / WS1_FRAGMENT).exists():
        frag = json.loads(pending.read_text(encoding="utf-8"))
        kept = {k: e for k, e in frag.items()
                if not (isinstance(e, dict) and drop(str(e.get("file") or "")))}
        if len(kept) < len(frag):
            out(f"manifest: {len(frag) - len(kept)} entries of {WS1_PENDING} left out (their "
                "file is not written this run)")
        (tmp / WS1_FRAGMENT).write_text(json.dumps(kept), encoding="utf-8")
        out(f"manifest: merging WS1 data/interim/{WS1_PENDING} as {WS1_FRAGMENT} (bridge until "
            "WS1 records through pipeline.provenance.manifest.record)")
    return refused


# --------------------------------------------------------------------------- report


def size_report(public: Path) -> tuple[int, int, dict[str, int]]:
    files = [p for p in public.rglob("*") if p.is_file() and p.name not in KEEP]
    by_top: dict[str, int] = defaultdict(int)
    for p in files:
        rel = p.relative_to(public)
        by_top[rel.parts[0] if len(rel.parts) > 1 else "."] += p.stat().st_size
    return len(files), sum(by_top.values()), dict(sorted(by_top.items()))


def owner_report(p: Plan, out=print) -> None:
    present: dict[str, int] = defaultdict(int)
    for c in p.copies:
        present[c.owner] += 1
    for cm in p.cards:
        for o in cm.parts:
            present[o] += 1
    missing: dict[str, list] = defaultdict(list)
    for owner, web, src in p.missing:
        missing[owner].append((web, src))
    owners = sorted(set(present) | set(missing), key=lambda o: int(o[2:]))
    out("by owner:")
    for o in owners:
        out(f"  {o}: {present.get(o, 0)} files present, {len(missing.get(o, []))} expected "
            "outputs missing")
        for web, src in missing.get(o, []):
            out(f"    missing {web}  <- {src}")
    if p.cards or p.unbuilt_cards:
        out(f"cards: built {', '.join(c.station for c in p.cards) or 'none'}; not built "
            f"{', '.join(p.unbuilt_cards) or 'none'}")


def dangling(public: Path) -> list[str]:
    """Files that an index in the public tree names but that are not there."""
    out = []

    def need(ref: str, by: str) -> None:
        if not (public / ref).is_file():
            out.append(f"{ref} (named in {by})")

    idx = public / "scenarios" / "index.json"
    if idx.is_file():
        for sc in json.loads(idx.read_text()).get("scenarios", []):
            for ref in (sc.get("files") or {}).values():
                if isinstance(ref, str):
                    need(ref, f"scenarios/index.json {sc.get('id')}")
    pads = public / "scenarios" / "pads"
    if (pads / "index.json").is_file():  # v1.1.4 D21 picker
        for row in json.loads((pads / "index.json").read_text()).get("pads", []):
            if isinstance(row, dict) and isinstance(row.get("summary"), str):
                need(row["summary"], f"scenarios/pads/index.json {row.get('id')}")
    for summ in sorted(pads.glob("*/summary.json")) if pads.is_dir() else []:
        files = json.loads(summ.read_text()).get("files")
        for ref in (files.values() if isinstance(files, dict) else []):
            if isinstance(ref, str):
                need(ref, f"scenarios/pads/{summ.parent.name}/summary.json")
    fidx = public / "fields" / "index.json"
    if fidx.is_file():
        for name, f in json.loads(fidx.read_text()).get("fields", {}).items():
            need(f["file"], f"fields/index.json {name}")
    st = public / "stations.json"
    if st.is_file():
        for s in json.loads(st.read_text()):
            if isinstance(s, dict) and isinstance(s.get("card"), str):
                need(s["card"], f"stations.json {s.get('id')}")
    for card in sorted((public / "cards").glob("*.json")) if (public / "cards").is_dir() else []:
        doc = json.loads(card.read_text())
        nav = doc.get("navcam") or {}
        for ref in (nav.get("url_local"), nav.get("overlay_png"), doc.get("panorama_png")):
            if isinstance(ref, str):
                need(ref, f"cards/{card.name}")
    f3 = public / "fp3d" / "index.json"
    if f3.is_file():
        doc = json.loads(f3.read_text())
        for ch in (doc.get("chunk_grid") or {}).get("chunks") or []:
            for key in ("file", "tex"):
                if isinstance(ch.get(key), str):
                    need(ch[key], f"fp3d/index.json chunk {ch.get('i')}_{ch.get('j')}")
        far = doc.get("far") or {}
        for key in ("file", "tex"):
            if isinstance(far.get(key), str):
                need(far[key], "fp3d/index.json far")
        if isinstance(doc.get("horizon_ring"), str):
            need(doc["horizon_ring"], "fp3d/index.json")
    for rel, key in (("siting_png.json", "image"), (CELLSTATE_JSON, "image"),
                     (CELLSTATE_CONS_JSON, "image")):
        if (public / rel).is_file():
            need(json.loads((public / rel).read_text())[key], rel)
    return out


# --------------------------------------------------------------------------- run


def _validator():
    """tools/validate_contracts.py as a module (tools/ is a package only for tests)."""
    import importlib.util

    name = "homeline_validate_contracts"
    if name not in sys.modules:
        path = REPO / "tools" / "validate_contracts.py"
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return sys.modules[name]


def run(interim: Path = INTERIM, public: Path = PUBLIC, *, fragments: Path | None = None,
        dummy_tree: Path = DUMMY_TREE, rules: list[Rule] = RULES, settings: dict | None = None,
        site: dict | None = None, h0: datetime | None = None, record_dir: Path | None = None,
        skip_owners: tuple[str, ...] = (), out=print) -> int:
    from pipeline.provenance import check_h0, manifest

    vc = _validator()
    settings = load_settings() if settings is None else settings
    site = load_site() if site is None else site
    h0 = check_h0.load_h0() if h0 is None else h0
    fragments = interim / "manifest" if fragments is None else fragments

    skipped = [r for r in rules if r.owner in skip_owners]
    for o in skip_owners:
        out(f"skipped owner {o} (--skip-owner): its outputs are not copied this run")
    p = plan(interim, [r for r in rules if r.owner not in skip_owners], dummy_tree, settings, h0)
    with tempfile.TemporaryDirectory() as td:
        staged = Path(td) / "fragments"
        skip_files = [pat for r in skipped for pat in r.skip_patterns]
        skip_files += [pat for st in p.unbuilt_cards for pat in (f"cards/{st}.json",
                                                                  f"cards/{st}/*")]
        written = {c.dst.as_posix() for c in p.copies} | {c.dst.as_posix() for c in p.cards}
        written |= {cellstate_png(c.dst) for c in p.copies if c.kind == "cellstate"}
        if p.tiles:
            written.add(TILEJSON)
        p.refused += manifest_fragments(fragments, interim, staged, out, skip_files, written)
        for line in p.skipped:
            out(line)
        if p.refused:
            for line in p.refused:
                out(line)
            out(f"make web: REFUSED ({len(p.refused)}); {public} left unchanged")
            return 1

        # record before the tracked public tree is touched (else the commit reads '-dirty')
        cellstates = [prepare_cellstate(c, site, out, fragment_dir=record_dir or fragments)
                      for c in p.copies if c.kind == "cellstate"]
        if cellstates:
            # the cell-state keys were just recorded: stage that fragment again, through the
            # same filter (a key of a cell-state file not written this run stays out)
            manifest_fragments(record_dir or fragments, interim, staged, out, skip_files,
                               written, pattern="tools__make_web*.json", bridge=False)
        removed = clear_public(public)
        for c in p.copies:
            if c.kind in ("copy", "card_image"):
                (public / c.dst).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(c.src, public / c.dst)
        write_cards(p.cards, public)
        for cs in cellstates:
            write_cellstate(cs, public)
        write_tiles(p.tiles, public, settings, interim, out)
        n_src = len(p.copies) + sum(len(c.parts) for c in p.cards)
        out(f"make web: {n_src} source files, {len(p.cards)} cards merged ({removed} old files "
            "removed)")

        ok = True
        try:
            m = manifest.merge(staged, public / "manifest.json", dummy=False)
            out(f"manifest: {len(m) - 1} keys -> {public / 'manifest.json'}")
        except Exception as exc:  # DuplicateKeyError, ManifestError, schema errors
            out(f"manifest: FAILED: {exc}")
            ok = False

    report = vc.run(public, dummy_tree)
    for w in report.warnings:
        out(f"WARN  {w}")
    for e in report.errors:
        out(f"FAIL  {e}")
    out(f"validate_contracts: {'OK' if report.ok else 'FAILED'} "
        f"({len(report.errors)} errors, {len(report.warnings)} warnings)")
    ok = ok and report.ok

    problems = check_h0.check(public, h0)
    for line in problems:
        out(f"H0    {line}")
    out(f"H0 check: {'OK' if not problems else 'FAILED'} ({len(problems)} problems, "
        f"H0 = {h0.isoformat()})")
    ok = ok and not problems

    for line in dangling(public):
        out(f"DANGLING {line}")
    owner_report(p, out)
    n, total, by_top = size_report(public)
    out(f"size: {n} files, {total / 1e6:.1f} MB (" +
        ", ".join(f"{k} {v / 1e6:.1f}" for k, v in by_top.items()) + ")")
    out(f"make web: {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--interim", type=Path, default=INTERIM)
    ap.add_argument("--public", type=Path, default=PUBLIC)
    ap.add_argument("--plan", action="store_true", help="print the plan and exit (no writes)")
    ap.add_argument("--skip-owner", action="append", default=[], metavar="WSn",
                    help="leave this owner's outputs (and manifest entries) out, e.g. while its "
                         "run is in progress; repeatable")
    args = ap.parse_args(argv)
    if args.plan:
        from pipeline.provenance import check_h0

        p = plan(args.interim, h0=check_h0.load_h0())
        for c in p.copies:
            if c.kind != "tiles":
                print(f"{c.owner:5} {c.kind:9} {c.src} -> {c.dst}")
        for cm in p.cards:
            print(f"WS3+2 card      {cm.parts['WS3']} + {cm.parts['WS2']} -> {cm.dst}")
        if p.tiles:
            print(f"WS1   tiles     {len(p.tiles)} basemap tiles -> {BASEMAP_DEST}/")
        for line in p.skipped + p.refused:
            print(line)
        owner_report(p)
        return 1 if p.refused else 0
    return run(args.interim, args.public, skip_owners=tuple(args.skip_owner))


if __name__ == "__main__":
    sys.exit(main())
