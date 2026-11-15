"""WS10 X8 data probe: do Curiosity's public Navcam frames support visual-odometry drift?

SPEC §2.4 X8, §6.2; brief WS10 step 1. For the most recent MMGIS drives, query the raw-image
API for Navcam left/right frames taken *during* the drive (prev_drive < drive < end_drive at
the same site), pair them by spacecraft clock and product size, measure pose spacing from the
API's ``xyz`` (rover position in the site frame, m), and apply ``config/nav.yaml``
``vo_probe.go_rule`` mechanically. Writes ``data/interim/vo/probe.json`` (contract
``vo_probe.schema.json``). The go/no-go itself (D16) is N's decision; ``decision`` here is the
rule's mechanical result only.

Conventions (WS10 assumptions, listed in STATUS.md):
- A stereo pair = one NAV_LEFT_B and one NAV_RIGHT_B frame with the same spacecraft clock and
  the same ``subframe_rect`` and ``scale_factor``.
- Frames the API labels ``sample_type: thumbnail`` are previews and never count as stereo pairs.
- Pairs at the same (site, drive) form one pose; spacing = 3-D distance between consecutive
  poses' ``xyz``; unknown (NaN) across a site change (the site frame resets).
- A run of k pairs = k consecutive poses whose k-1 steps are all <= max spacing and whose pairs
  all carry a camera model; runs are counted within one product size (resolution class).

Outputs: ``data/interim/vo/probe.json`` plus manifest keys ``nav.vo_probe.*`` (rule 6).

Usage: ``uv run python -m pipeline.navigation.vo_probe [--offline] [--no-frames] [--focus-check]``
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import yaml
from jsonschema import Draft202012Validator

REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "config"
CONTRACT = REPO / "contracts" / "vo_probe.schema.json"
RAW_DIR = REPO / "data" / "raw" / "vo"
OUT = REPO / "data" / "interim" / "vo" / "probe.json"

MMGIS_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
RAW_API = "https://mars.nasa.gov/api/v1/raw_image_items/"
CAMERAS = ("NAV_LEFT_B", "NAV_RIGHT_B")
USER_AGENT = "homeline-pipeline/0.1 (research probe)"
TIMEOUT = (15, 90)  # connect, read (s): operational, not a model constant

THUMBNAIL = "thumbnail"


# ---------------------------------------------------------------------------------------------
# Config: the go rule
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class GoRule:
    min_drives: int
    min_run_pairs: int
    max_spacing_m: float
    need_camera_model: bool


_RULE_RE = re.compile(
    r">=\s*(?P<drives>\d+)\s+drives?\s+with\s+>=\s*(?P<run>\d+)\s+consecutive\s+stereo\s+pairs?"
    r"\s+at\s+<=\s*(?P<sp>[0-9.]+)\s*m\s+spacing(?P<cm>,?\s*with\s+camera\s+models?)?\s*$"
)


def parse_go_rule(text: str) -> GoRule:
    """Parse nav.yaml ``vo_probe.go_rule``; fail loudly if its wording changes."""
    m = _RULE_RE.match(text.strip())
    if not m:
        raise ValueError(f"cannot parse vo_probe.go_rule: {text!r}")
    return GoRule(int(m["drives"]), int(m["run"]), float(m["sp"]), bool(m["cm"]))


def load_probe_config(config_dir: Path = CONFIG) -> dict:
    nav = yaml.safe_load((config_dir / "nav.yaml").read_text())
    return nav["vo_probe"]


def load_aoi_focus(config_dir: Path = CONFIG) -> dict:
    return yaml.safe_load((config_dir / "site.yaml").read_text())["aoi_focus"]


# ---------------------------------------------------------------------------------------------
# Item parsing
# ---------------------------------------------------------------------------------------------

def _floats(s) -> list[float] | None:
    if not s or not isinstance(s, str):
        return None
    try:
        return [float(v) for v in s.strip().strip("()").split(",")]
    except ValueError:
        return None


def has_camera_model(item: dict) -> bool:
    """CAHV-family model with >= 4 finite 3-vectors (C, A, H, V)."""
    s = item.get("camera_model_component_list")
    if not item.get("camera_model_type") or not s:
        return False
    vecs = [_floats(p) for p in s.split(";")]
    vecs = [v for v in vecs if v and len(v) == 3 and all(math.isfinite(x) for x in v)]
    return len(vecs) >= 4


def has_attitude(item: dict) -> bool:
    q = _floats(item.get("attitude"))
    return bool(q) and len(q) == 4 and all(math.isfinite(x) for x in q)


def xyz(item: dict) -> tuple[float, float, float] | None:
    v = _floats(item.get("xyz"))
    return tuple(v) if v and len(v) == 3 else None


def frame_px(item: dict) -> tuple[int, int] | None:
    """Width, height from ``subframe_rect`` (x, y, w, h); checked against the JPEG on download."""
    v = _floats(item.get("subframe_rect"))
    return (int(v[2]), int(v[3])) if v and len(v) == 4 else None


def resolution_class(item: dict) -> str:
    return (item.get("extended") or {}).get("sample_type") or "unknown"


def strip_api_key(url: str) -> str:
    parts = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
         if k.lower() != "api_key"]
    return urlunsplit(parts._replace(query=urlencode(q, safe=":+|")))


# ---------------------------------------------------------------------------------------------
# During-drive selection, pairing, poses
# ---------------------------------------------------------------------------------------------

def during_drive(items: list[dict], prev: tuple[int, int], end: tuple[int, int]) -> list[dict]:
    """Items strictly between two drive ends (site, drive), allowing one site change."""
    (ps, pd), (es, ed) = prev, end
    out = []
    for it in items:
        s, d = it.get("site"), it.get("drive")
        if s is None or d is None:
            continue
        if ps == es:
            ok = s == ps and pd < d < ed
        else:
            ok = (s == ps and d > pd) or (s == es and d < ed)
        if ok:
            out.append(it)
    return out


@dataclass
class Pair:
    left: dict
    right: dict

    @property
    def sclk(self) -> float:
        return float(self.left["spacecraft_clock"])

    @property
    def has_camera_model(self) -> bool:
        return has_camera_model(self.left) and has_camera_model(self.right)

    @property
    def has_attitude(self) -> bool:
        return has_attitude(self.left) and has_attitude(self.right)


def _pair_key(it: dict):
    return (round(float(it["spacecraft_clock"]), 3), it.get("subframe_rect"),
            it.get("scale_factor"), resolution_class(it))


def pair_frames(left: list[dict], right: list[dict]) -> list[Pair]:
    rmap: dict = {}
    for it in right:
        rmap.setdefault(_pair_key(it), it)
    pairs = [Pair(it, rmap[_pair_key(it)]) for it in left if _pair_key(it) in rmap]
    pairs.sort(key=lambda p: p.sclk)
    return pairs


@dataclass
class Pose:
    sclk: float
    site: int
    drive: int
    xyz: tuple[float, float, float] | None
    pairs: list[Pair] = field(default_factory=list)

    @property
    def has_camera_model(self) -> bool:
        return any(p.has_camera_model for p in self.pairs)


def poses(pairs: list[Pair]) -> list[Pose]:
    by: dict[tuple[int, int], Pose] = {}
    for p in pairs:
        key = (p.left["site"], p.left["drive"])
        if key not in by:
            by[key] = Pose(p.sclk, key[0], key[1], xyz(p.left))
        by[key].pairs.append(p)
    return sorted(by.values(), key=lambda q: q.sclk)


def spacings(ps: list[Pose]) -> list[float]:
    out = []
    for a, b in zip(ps, ps[1:], strict=False):
        if a.site != b.site or a.xyz is None or b.xyz is None:
            out.append(float("nan"))
        else:
            out.append(math.dist(a.xyz, b.xyz))
    return out


def median_or_none(values: list[float]) -> float | None:
    v = [x for x in values if math.isfinite(x)]
    return float(statistics.median(v)) if v else None


def longest_run(steps: list[float], max_spacing: float) -> int:
    """Longest chain of poses (counted in poses) whose steps are all finite and <= max."""
    best = cur = 1
    for s in steps:
        cur = cur + 1 if (math.isfinite(s) and s <= max_spacing) else 1
        best = max(best, cur)
    return best


# ---------------------------------------------------------------------------------------------
# Summaries and the rule
# ---------------------------------------------------------------------------------------------

def _round(x, n=3):
    return None if x is None else round(float(x), n)


def summarise_class(pairs: list[Pair], rule: GoRule) -> dict:
    """Stats for one resolution class; runs need camera models when the rule says so."""
    ps = poses(pairs)
    steps = spacings(ps)
    best = 0
    if ps:
        # Split the pose chain at poses that fail the camera-model requirement.
        segs: list[list[Pose]] = [[]]
        for q in ps:
            if rule.need_camera_model and not q.has_camera_model:
                segs.append([])
            else:
                segs[-1].append(q)
        best = max((longest_run(spacings(s), rule.max_spacing_m) for s in segs if s), default=0)
    finite = [s for s in steps if math.isfinite(s)]
    sizes = Counter(frame_px(p.left) for p in pairs)
    size = sizes.most_common(1)[0][0] if sizes else None
    return {
        "pairs": len(pairs),
        "poses": len(ps),
        "pairs_with_camera_model": sum(p.has_camera_model for p in pairs),
        "pairs_with_attitude": sum(p.has_attitude for p in pairs),
        "frame_px": list(size) if size else None,
        "median_spacing_m": _round(median_or_none(steps)),
        "max_spacing_m": _round(max(finite)) if finite else None,
        "longest_run_pairs": best,
        "meets_run": best >= rule.min_run_pairs,
    }


def summarise_drive(left: list[dict], right: list[dict], *, prev: tuple[int, int],
                    end: tuple[int, int], sol: int, rule: GoRule, extra: dict | None = None,
                    ) -> dict:
    """Per-drive record: contract fields from usable (non-thumbnail) pairs + a breakdown."""
    lt, rt = during_drive(left, prev, end), during_drive(right, prev, end)
    pairs = pair_frames(lt, rt)
    by_cls: dict[str, list[Pair]] = defaultdict(list)
    for p in pairs:
        by_cls[resolution_class(p.left)].append(p)
    by_res = {c: summarise_class(v, rule) for c, v in sorted(by_cls.items())}
    usable = {c: s for c, s in by_res.items() if c != THUMBNAIL}
    usable_pairs = [p for c, v in by_cls.items() if c != THUMBNAIL for p in v]
    # Median spacing over usable poses (any usable class), for the contract field.
    med = median_or_none(spacings(poses(usable_pairs)))
    meets = [c for c, s in usable.items() if s["meets_run"]]
    rec = {
        "sol": sol,
        "drive": end[1],
        "site": end[0],
        "prev_site_drive": f"{prev[0]}_{prev[1]}",
        "end_site_drive": f"{end[0]}_{end[1]}",
        "stereo_pairs": len(usable_pairs),
        "median_spacing_m": _round(med),
        "has_camera_model": bool(usable_pairs) and all(p.has_camera_model for p in usable_pairs),
        "has_attitude": bool(usable_pairs) and all(p.has_attitude for p in usable_pairs),
        "frames_during": {"left": len(lt), "right": len(rt)},
        "by_resolution": by_res,
        "meets_go_rule": bool(meets),
        "meets_go_rule_at": meets,
    }
    if extra:
        rec.update(extra)
    return rec


def decide(drives: list[dict], rule: GoRule) -> str:
    return "go" if sum(d["meets_go_rule"] for d in drives) >= rule.min_drives else "no-go"


def decide_by_resolution(drives: list[dict], rule: GoRule) -> dict[str, dict]:
    classes = sorted({c for d in drives for c in d["by_resolution"]})
    out = {}
    for c in classes:
        n = sum(d["by_resolution"].get(c, {}).get("meets_run", False) for d in drives)
        out[c] = {"drives_meeting": n, "result": "go" if n >= rule.min_drives else "no-go"}
    return out


def build_probe(drives: list[dict], rule: GoRule, rule_text: str, meta: dict) -> dict:
    return {
        "drives": drives,
        "decision": decide(drives, rule),
        "decision_is": "mechanical result of nav.yaml vo_probe.go_rule; D16 is N's decision",
        "go_rule": rule_text,
        "go_rule_parsed": rule.__dict__,
        "drives_meeting_rule": sum(d["meets_go_rule"] for d in drives),
        "by_resolution": decide_by_resolution(drives, rule),
        **meta,
    }


def validate_probe(doc: dict) -> None:
    Draft202012Validator(json.loads(CONTRACT.read_text())).validate(doc)


# ---------------------------------------------------------------------------------------------
# Network + cache (data/raw/vo/)
# ---------------------------------------------------------------------------------------------

class Budget:
    def __init__(self, max_bytes: int):
        self.max_bytes, self.used = max_bytes, 0

    def add(self, n: int) -> None:
        self.used += n
        if self.used > self.max_bytes:
            raise RuntimeError(f"download budget exceeded: {self.used / 1e6:.1f} MB")


def _session():
    import requests

    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def _get(sess, url: str, budget: Budget, params: dict | None = None):
    r = sess.get(url, params=params, timeout=TIMEOUT)
    budget.add(len(r.content))
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code} for {strip_api_key(r.url)}")
    return r


def _index_add(raw_dir: Path, entry: dict) -> None:
    p = raw_dir / "index.json"
    idx = json.loads(p.read_text()) if p.exists() else {"files": {}}
    idx["files"][entry["file"]] = entry
    p.write_text(json.dumps(idx, indent=1))


def fetch_mmgis(sess, budget: Budget, raw_dir: Path, offline: bool) -> dict:
    path = raw_dir / "mmgis_MSL_waypoints.json"
    if not path.exists():
        if offline:
            raise FileNotFoundError(path)
        r = _get(sess, MMGIS_URL, budget)
        path.write_bytes(r.content)
        _index_add(raw_dir, {"file": path.name, "url": MMGIS_URL, "bytes": len(r.content),
                             "fetched_utc": _utcnow()})
    return json.loads(path.read_text())


def fetch_items(sess, budget: Budget, raw_dir: Path, sol: int, camera: str,
                offline: bool) -> list[dict]:
    """All raw-image items for one sol and camera (paginated), cached as JSON."""
    path = raw_dir / "rawapi" / f"sol{sol:05d}_{camera}.json"
    if path.exists():
        return json.loads(path.read_text())["items"]
    if offline:
        raise FileNotFoundError(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    items, page, nbytes = [], 0, 0
    while True:
        params = {"order": "date_taken asc", "per_page": 200, "page": page,
                  "condition_1": "msl:mission", "condition_2": f"{sol}:sol:in",
                  "search": camera}
        r = _get(sess, RAW_API, budget, params)
        nbytes += len(r.content)
        d = r.json()
        items.extend(d.get("items", []))
        if not d.get("more"):
            break
        page += 1
    query = strip_api_key(f"{RAW_API}?{urlencode(params, safe=':+|')}").replace(
        f"page={page}", "page=N")
    path.write_text(json.dumps({"query": query, "fetched_utc": _utcnow(), "pages": page + 1,
                                "items": items}))
    _index_add(raw_dir, {"file": str(path.relative_to(raw_dir)), "url": query, "bytes": nbytes,
                         "fetched_utc": _utcnow()})
    return items


def _utcnow() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------------------------
# Drive selection from MMGIS
# ---------------------------------------------------------------------------------------------

def drive_ends(mmgis: dict) -> list[dict]:
    fs = [f["properties"] for f in mmgis["features"]]
    return sorted(fs, key=lambda p: (p["sol"], p["site"], p["drive"]))


def select_recent(ends: list[dict], n: int) -> list[tuple[dict, dict]]:
    """The n most recent drive ends with their previous drive end."""
    return [(ends[i - 1], ends[i]) for i in range(len(ends) - 1, 0, -1)][:n]


def select_in_box(ends: list[dict], box: dict, n: int) -> list[tuple[dict, dict]]:
    out = []
    for i in range(len(ends) - 1, 0, -1):
        p = ends[i]
        if box["west"] <= p["lon"] <= box["east"] and box["south"] <= p["lat"] <= box["north"]:
            out.append((ends[i - 1], p))
            if len(out) == n:
                break
    return out


# ---------------------------------------------------------------------------------------------
# Frame check: a minimal qualifying run of usable frames per drive (indicative only)
# ---------------------------------------------------------------------------------------------

def _first_run(pairs: list[Pair], rule: GoRule) -> list[Pair]:
    """First min_run_pairs consecutive poses (one pair each) meeting the rule."""
    ps = [q for q in poses(pairs) if q.has_camera_model or not rule.need_camera_model]
    run: list[Pose] = []
    for q in ps:
        if run:
            st = spacings([run[-1], q])[0]
            if not (math.isfinite(st) and st <= rule.max_spacing_m):
                run = []
        run.append(q)
        if len(run) == rule.min_run_pairs:
            return [next(p for p in r.pairs if p.has_camera_model) for r in run]
    return []


def frame_check(sess, budget: Budget, raw_dir: Path, sol: int, pairs: list[Pair],
                offline: bool) -> dict:
    """Download one qualifying run; check JPEG size and content; ORB matches (cv2 defaults)."""
    import cv2
    import numpy as np

    fdir = raw_dir / "frames" / f"sol{sol:05d}"
    fdir.mkdir(parents=True, exist_ok=True)
    imgs, names = [], []
    for p in pairs:
        row = []
        for it in (p.left, p.right):
            url = strip_api_key(it.get("https_url") or it["url"])
            path = fdir / Path(urlsplit(url).path).name
            if not path.exists():
                if offline:
                    raise FileNotFoundError(path)
                r = _get(sess, url, budget)
                path.write_bytes(r.content)
                _index_add(raw_dir, {"file": str(path.relative_to(raw_dir)), "url": url,
                                     "bytes": len(r.content), "fetched_utc": _utcnow()})
            im = cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), cv2.IMREAD_GRAYSCALE)
            row.append(im)
        imgs.append(row)
        names.append(p.left["imageid"])
    shapes = Counter(tuple(int(x) for x in im.shape[::-1]) for row in imgs for im in row
                     if im is not None)
    orb = cv2.ORB_create()
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)

    def feats(im):
        return orb.detectAndCompute(im, None)

    def inliers(a, b):
        (ka, da), (kb, db) = a, b
        if da is None or db is None or len(ka) < 8 or len(kb) < 8:
            return 0, 0
        m = bf.match(da, db)
        if len(m) < 8:
            return len(m), 0
        pa = np.float32([ka[x.queryIdx].pt for x in m])
        pb = np.float32([kb[x.trainIdx].pt for x in m])
        _, mask = cv2.findFundamentalMat(pa, pb, cv2.FM_RANSAC)
        return len(m), int(mask.sum()) if mask is not None else 0

    fl = [[feats(im) for im in row] for row in imgs if all(i is not None for i in row)]
    kp = [len(f[0][0]) for f in fl]
    lr = [inliers(f[0], f[1])[1] for f in fl]
    tt = [inliers(a[0], b[0])[1] for a, b in zip(fl, fl[1:], strict=False)]
    stats = [float(im.std()) for row in imgs for im in row if im is not None]
    return {
        "pairs_downloaded": len(pairs),
        "first_left_imageid": names[0] if names else None,
        "jpeg_px": {f"{w}x{h}": n for (w, h), n in shapes.items()},
        "decode_failures": sum(im is None for row in imgs for im in row),
        "min_pixel_std_dn": _round(min(stats), 1) if stats else None,
        "orb_keypoints_left_median": _med_int(kp),
        "left_right_fundamental_inliers_median": _med_int(lr),
        "left_right_fundamental_inliers_min": min(lr) if lr else None,
        "frame_to_frame_fundamental_inliers_median": _med_int(tt),
        "frame_to_frame_fundamental_inliers_min": min(tt) if tt else None,
        "method": "OpenCV ORB_create() defaults, BFMatcher Hamming crossCheck, "
                  "findFundamentalMat FM_RANSAC defaults; indicative only, not a VO result",
    }


def _cache_mb(raw_dir: Path) -> float:
    p = raw_dir / "index.json"
    files = json.loads(p.read_text())["files"].values() if p.exists() else []
    return round(sum(f["bytes"] for f in files) / 1e6, 2)


def _med_int(v):
    return int(statistics.median(v)) if v else None


# ---------------------------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------------------------

def probe_drive(sess, budget, raw_dir, prev, end, rule, offline, do_frames) -> dict:
    sol = int(end["sol"])
    left = fetch_items(sess, budget, raw_dir, sol, CAMERAS[0], offline)
    right = fetch_items(sess, budget, raw_dir, sol, CAMERAS[1], offline)
    pk, ek = (prev["site"], prev["drive"]), (end["site"], end["drive"])
    rec = summarise_drive(left, right, prev=pk, end=ek, sol=sol, rule=rule, extra={
        "mmgis_dist_m": end.get("dist_m"),
        "sols_queried": [sol],
        "prev_sol": prev["sol"],
    })
    if prev["sol"] != sol:
        rec["note"] = "previous drive end is on an earlier sol; only the end sol was queried"
    if do_frames and rec["meets_go_rule"]:
        cls = rec["meets_go_rule_at"][0]
        pairs = [p for p in pair_frames(during_drive(left, pk, ek), during_drive(right, pk, ek))
                 if resolution_class(p.left) == cls]
        run = _first_run(pairs, rule)
        if run:
            rec["frame_check"] = {"resolution": cls,
                                  **frame_check(sess, budget, raw_dir, sol, run, offline)}
    return rec


def record_manifest(doc: dict, out: Path) -> None:
    """Provenance for the probe's headline numbers (AGENTS.md rule 6)."""
    from pipeline.provenance.manifest import record

    f = "vo/probe.json"
    record("nav.vo_probe.decision", doc["decision"], None, f, __file__)
    record("nav.vo_probe.drives_meeting_rule", doc["drives_meeting_rule"], "1", f, __file__)
    for d in doc["drives"]:
        k = f"nav.vo_probe.sol{d['sol']}"
        record(f"{k}.stereo_pairs", d["stereo_pairs"], "1", f, __file__)
        record(f"{k}.median_spacing_m", d["median_spacing_m"], "m", f, __file__)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--raw-dir", type=Path, default=RAW_DIR)
    ap.add_argument("--offline", action="store_true", help="use the cache only")
    ap.add_argument("--no-frames", action="store_true", help="metadata only")
    ap.add_argument("--max-mb", type=float, default=100.0, help="download budget (operational)")
    ap.add_argument("--focus-check", action="store_true",
                    help="also probe the most recent drives inside site.yaml aoi_focus (context)")
    a = ap.parse_args(argv)
    if "web/public" in str(a.out.resolve()):
        ap.error("the probe writes to data/interim only")
    t0 = time.time()
    cfg = load_probe_config()
    rule = parse_go_rule(cfg["go_rule"])
    budget = Budget(int(a.max_mb * 1e6))
    sess = None if a.offline else _session()
    a.raw_dir.mkdir(parents=True, exist_ok=True)
    try:
        ends = drive_ends(fetch_mmgis(sess, budget, a.raw_dir, a.offline))
        recent = select_recent(ends, int(cfg["drives"]))
        drives = [probe_drive(sess, budget, a.raw_dir, p, e, rule, a.offline, not a.no_frames)
                  for p, e in recent]
        # Context for N: the most recent drives inside site.yaml aoi_focus (not in the decision).
        focus = ([probe_drive(sess, budget, a.raw_dir, p, e, rule, a.offline, False)
                  for p, e in select_in_box(ends, load_aoi_focus(), rule.min_drives)]
                 if a.focus_check else [])
    except Exception as exc:  # report, never paper over (AGENTS rule 7)
        print(f"probe failed: {exc}", file=sys.stderr)
        return 2
    meta = {
        "selection": f"the {cfg['drives']} most recent MMGIS drive ends (nav.yaml "
                     "vo_probe.drives) and their previous drive end",
        "focus_check": {
            "selection": f"the {rule.min_drives} most recent MMGIS drive ends inside "
                         "site.yaml aoi_focus; context only, not part of the decision",
            "drives": focus,
            "drives_meeting_rule": sum(d["meets_go_rule"] for d in focus),
        },
        "sources": {"mmgis": MMGIS_URL, "raw_image_api": RAW_API},
        "generated_utc": _utcnow(),
        "downloaded_mb_this_run": round(budget.used / 1e6, 2),
        "raw_cache_mb": _cache_mb(a.raw_dir),
        "script": "pipeline/navigation/vo_probe.py",
    }
    doc = build_probe(drives, rule, cfg["go_rule"], meta)
    validate_probe(doc)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, indent=1))
    record_manifest(doc, a.out)
    print(f"wrote {a.out} in {time.time() - t0:.0f} s, {budget.used / 1e6:.1f} MB downloaded")
    for d in drives + focus:
        print(f"sol {d['sol']} {d['end_site_drive']}: pairs {d['stereo_pairs']}, median "
              f"{d['median_spacing_m']} m, meets rule at {d['meets_go_rule_at'] or '-'}; "
              + ", ".join(f"{c}: {s['pairs']}p run {s['longest_run_pairs']}"
                          for c, s in d["by_resolution"].items()))
    print(f"decision (mechanical): {doc['decision']}; by resolution: {doc['by_resolution']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
