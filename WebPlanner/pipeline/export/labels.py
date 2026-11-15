"""Geographic label objects for the U13 label system -> ``labels.json`` (DESIGN §6.2, U13; WS16).

Contract: ``contracts/labels.schema.json`` (design contracts v1). Every coordinate is read from
the file named in the label's ``ref`` (data root = the published tree, web/public/data/); none is
typed here (AGENTS.md rule 7):

* ``PAD``: ``pad.json`` top-level ``pad`` (D21 official pad, frozen by D42).
* ``P{rank}``: the D21 rover parking options, ``scenarios/pads/index.json`` pads with
  ``picker: true`` (the official pad is ``PAD``), ref ``scenarios/pads/index.json#{id}``.
* Stations: every entry of ``stations.json`` (S1, S2, S4, S6, S7, S8; names as published), ref
  ``stations.json#{id}``. Kind ``route_station`` for the stops of the official plan (route of the
  default scenario, ``route_{default}.geojson``, cross-checked against the official pad's route in
  the pads index), else ``scored_site`` for ``config/stations.yaml extras.ids`` and ``station``.
* Landmarks: names from ``config/landmarks.yaml`` candidates; coordinates ONLY from the IAU
  gazetteer CSV through ``pipeline.horizon.cards.load_iau_landmarks`` (features within
  ``config/horizon.yaml landmarks_source.max_dist_km`` of the official pad). A name matches the
  gazetteer ``clean_name`` exactly, or after dropping a trailing parenthetical alias
  ("Aeolis Mons (Mount Sharp)" -> "Aeolis Mons"). A name without a match is skipped and logged
  (D33: verified coordinates only). Matched names are IAU names: status ``official``.
  ``bearing_deg`` / ``dist_m`` from the official pad (great circle, Mars 2000 sphere) are the
  hover numbers; they are recorded in the manifest (rule 6).

``priority`` = 1-based position of the kind in ``config/design.yaml labels.priority`` without the
runtime-only ``selected`` (§6.2: pad 1, station 3, landmark 6); ``minzoom`` from
``labels.minzoom`` (route stations and scored sites are stations: ``MINZOOM_KEY``).
Output is deterministic: sorted by (priority, route order, code), no timestamps, fixed rounding.

Usage: ``python -m pipeline.export.labels`` reads data/interim/engine/public/ (the files
``make web`` publishes), writes data/interim/export/labels.json (copied to
web/public/data/labels.json by ``make web``) and records the manifest fragment.
``--src web/public/data --out web/public/data/labels.json --no-record`` regenerates the
published file in place from the published inputs.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from pipeline.horizon import config as hcfg  # noqa: E402
from pipeline.horizon.cards import load_iau_landmarks  # noqa: E402
from pipeline.horizon.geo import great_circle  # noqa: E402

CONFIG = REPO / "config"
SRC = REPO / "data" / "interim" / "engine" / "public"
OUT = REPO / "data" / "interim" / "export" / "labels.json"
WEB_PATH = "labels.json"
VERSION = "1"
COORD_DECIMALS = 6  # contracts/labels.schema.json: "6 decimals"
BEARING_DECIMALS = 2  # as pipeline/horizon/cards.py landmark_view
# labels.minzoom has keys landmark, pad, station, overlay; these kinds are stations (U13 placement
# rule 4: "stations from mid zoom")
MINZOOM_KEY = {"route_station": "station", "scored_site": "station", "user_point": "station"}
# DESIGN §2.2 U13 identifier table (codes only; positions come from the gazetteer)
LANDMARK_CODES = {
    "Aeolis Mons (Mount Sharp)": "MSH",
    "Gediz Vallis": "GDV",
    "Gale crater rim": "RIM",
    "Peace Vallis": "PCV",
    "Aeolis Palus": "APL",
    "Boxwork unit": "BOX",
    "Vera Rubin Ridge": "VRR",
    "Greenheugh Pediment": "GRP",
}
PAD_NAME = "Rover pad"  # DESIGN §6.2 example; web/src/ui/copy.json cards.pad.title
PARKING_NAME = "Parking option {rank}"  # copy.json cards.pad.alternativeTitle (D21 picker)
_ALIAS = re.compile(r"\s*\([^)]*\)\s*$")


def iau_name(name: str) -> str:
    """Gazetteer name for a landmarks.yaml name: drop a trailing parenthetical alias."""
    return _ALIAS.sub("", name)


def _design() -> dict:
    return yaml.safe_load((CONFIG / "design.yaml").read_text())["labels"]


def _ll(rec: dict) -> dict:
    return {"lon": round(float(rec["lon"]), COORD_DECIMALS),
            "lat": round(float(rec["lat"]), COORD_DECIMALS)}


def _read(root: Path, rel: str):
    return json.loads((root / rel).read_text())


def route_stops(src: Path) -> list[str]:
    """Stops of the official plan: the default scenario's route, checked against the pads index."""
    default = _read(src, "scenarios/index.json")["default"]
    route = _read(src, f"route_{default}.geojson")
    stops = [f["properties"]["to"] for f in route["features"] if f["properties"]["to"] != "pad"]
    official = [p for p in _read(src, "scenarios/pads/index.json")["pads"] if p.get("official")]
    if len(official) != 1 or official[0].get("route", {}).get("stops") != stops:
        raise ValueError(f"route_{default}.geojson stops {stops} differ from the official pad's "
                         "route in scenarios/pads/index.json")
    return stops


def build(src: Path = SRC, iau_csv: Path | None = None,
          log: Callable[[str], None] = print) -> dict:
    """The labels.json document from the published-tree files under ``src``."""
    cfg = _design()
    kinds = [k for k in cfg["priority"] if k != "selected"]
    minzoom = cfg["minzoom"]

    def label(code: str, name: str, kind: str, pos: dict, ref: str, status=None, **extra) -> dict:
        return {"code": code, "name": name, "kind": kind, "status": status, **_ll(pos),
                "priority": kinds.index(kind) + 1, "minzoom": minzoom[MINZOOM_KEY.get(kind, kind)],
                "ref": ref, **extra}

    out: list[tuple[tuple, dict]] = []
    pad_doc = _read(src, "pad.json")
    pad = pad_doc["pad"]
    out.append(((0,), label("PAD", PAD_NAME, "pad", pad, "pad.json")))

    pads = _read(src, "scenarios/pads/index.json")
    if pads.get("official") != pad.get("id"):
        raise ValueError(f"pads index official {pads.get('official')!r} is not pad.json pad "
                         f"{pad.get('id')!r}")
    for p in pads["pads"]:
        if p.get("picker") and not p.get("official"):
            out.append(((1, int(p["rank"])),
                        label(f"P{int(p['rank'])}", PARKING_NAME.format(rank=int(p["rank"])),
                              "pad", p, f"scenarios/pads/index.json#{p['id']}")))

    stops = route_stops(src)
    scored = set(yaml.safe_load((CONFIG / "stations.yaml").read_text())["extras"]["ids"])
    for s in _read(src, "stations.json"):
        sid = s["id"]
        kind = ("route_station" if sid in stops else "scored_site" if sid in scored
                else "station")
        order = (stops.index(sid),) if sid in stops else (sid,)
        out.append((order, label(sid, s["name"], kind, s, f"stations.json#{sid}")))

    src_cfg = hcfg.load()["landmarks_source"]
    csv_path = Path(iau_csv) if iau_csv is not None else REPO / src_cfg["csv"]
    if not csv_path.exists():
        raise FileNotFoundError(f"{csv_path}: IAU gazetteer CSV missing (docs/discovery.md 3.5)")
    gaz = {lm["name"]: lm for lm in load_iau_landmarks(csv_path, pad["lon"], pad["lat"])}
    cands = yaml.safe_load((CONFIG / "landmarks.yaml").read_text())["candidates"]
    for c in cands:
        name = c["name"]
        lm = gaz.get(iau_name(name))
        if lm is None:
            log(f"labels: skip landmark {name!r} ({c.get('kind')}): no gazetteer feature named "
                f"{iau_name(name)!r} within {src_cfg['max_dist_km']} km of the pad "
                f"({src_cfg['approval']}); D33 verified coordinates only")
            continue
        if name not in LANDMARK_CODES:
            raise KeyError(f"landmark {name!r} has no U13 code (DESIGN §2.2 U13)")
        pos = _ll(lm)
        b, d = great_circle(pad["lon"], pad["lat"], pos["lon"], pos["lat"])
        out.append(((name,), label(LANDMARK_CODES[name], name, "landmark", pos, "landmarks.yaml",
                                   status="official", bearing_deg=round(b, BEARING_DECIMALS),
                                   dist_m=round(d))))

    labels = [lb for _, lb in sorted(out, key=lambda t: (t[1]["priority"], t[0]))]
    codes = [lb["code"] for lb in labels]
    if len(codes) != len(set(codes)):
        raise ValueError(f"duplicate label codes: {codes}")
    return {"version": VERSION, "labels": labels}


def write(doc: dict, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    return out


def record_manifest(doc: dict) -> int:
    """Rule 6: the landmark hover numbers (bearing, distance from the pad) of labels.json."""
    from pipeline.provenance.manifest import drop, record

    keys = []
    for lb in doc["labels"]:
        if lb["kind"] == "landmark":
            k = f"labels.{lb['code']}"
            record(f"{k}.bearing_deg", lb["bearing_deg"], "deg", WEB_PATH, __file__)
            record(f"{k}.dist_m", lb["dist_m"], "m", WEB_PATH, __file__)
            keys += [f"{k}.bearing_deg", f"{k}.dist_m"]
    stale = [f"labels.{c}.{f}" for c in LANDMARK_CODES.values() for f in ("bearing_deg", "dist_m")
             if f"labels.{c}.{f}" not in keys]
    drop(stale, __file__)
    return len(keys)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", type=Path, default=SRC, help="published-tree inputs (data root)")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--iau-csv", type=Path, default=None)
    ap.add_argument("--no-record", action="store_true", help="skip the manifest fragment")
    a = ap.parse_args(argv)
    doc = build(a.src, a.iau_csv)
    write(doc, a.out)
    n = {}
    for lb in doc["labels"]:
        n[lb["kind"]] = n.get(lb["kind"], 0) + 1
    print(f"labels: {len(doc['labels'])} labels {n} -> {a.out}")
    if not a.no_record:
        print(f"labels: {record_manifest(doc)} manifest entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
