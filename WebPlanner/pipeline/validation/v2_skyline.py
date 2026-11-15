"""V2 skyline validation (F13): predicted vs detected skyline elevation angle per image column,
then median and P90 by distance class (near < 0.5 km, mid 0.5-2 km, far > 2 km;
horizon.yaml ``distance_classes_km``). Only the far-field figure may be quoted in the video
(SPEC F13); near-field misses are reported, not hidden.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from pipeline.horizon import config as hcfg
from pipeline.horizon.cahvor import CameraModel, pixels_to_az_el
from pipeline.horizon.rays import HorizonProfile, classify_distance

CLASSES = ("near", "mid", "far")


def compare_columns(model: CameraModel, q, profile: HorizonProfile, sky_rows,
                    columns=None) -> dict:
    """Per-column record for one frame. ``sky_rows`` from sky.detect_skyline (NaN = none)."""
    rows = np.asarray(sky_rows, dtype=float)
    cols = np.arange(rows.size) if columns is None else np.asarray(columns)
    ok = np.isfinite(rows)
    cols, rows = cols[ok], rows[ok]
    az, el_det = pixels_to_az_el(model, q, np.column_stack([cols.astype(float), rows]))
    el_pred = profile.elevation_at(az)
    dist = profile.distance_at(az)
    return {
        "column": cols.tolist(), "row_detected": rows.tolist(), "az_deg": az.tolist(),
        "el_detected_deg": el_det.tolist(), "el_predicted_deg": el_pred.tolist(),
        "error_deg": (el_det - el_pred).tolist(), "distance_m": dist.tolist(),
        "distance_class": classify_distance(dist).tolist(),
    }


def summarise(records) -> dict:
    """Median (signed and absolute) and P90 of |error| per distance class over all frames."""
    err = np.concatenate([np.asarray(r["error_deg"], dtype=float) for r in records]) \
        if records else np.array([])
    cls = np.concatenate([np.asarray(r["distance_class"], dtype=object) for r in records]) \
        if records else np.array([], dtype=object)
    out = {}
    for c in CLASSES:
        e = err[(cls == c) & np.isfinite(err)]
        out[c] = {"n": int(e.size),
                  "median_deg": float(np.median(e)) if e.size else None,
                  "median_abs_deg": float(np.median(np.abs(e))) if e.size else None,
                  "p90_abs_deg": float(np.percentile(np.abs(e), 90)) if e.size else None}
    return out


def manual_check_sample(frame_ids, frac: float | None = None) -> list[str]:
    """Deterministic manual-check subset (horizon.yaml v2.manual_check_frac): the ceil(frac*n)
    frames with the smallest SHA-1 of their id (no RNG seed needed)."""
    f = hcfg.load()["v2"]["manual_check_frac"] if frac is None else frac
    ids = sorted(set(frame_ids), key=lambda s: hashlib.sha1(str(s).encode()).hexdigest())
    return sorted(ids[: math.ceil(f * len(ids))])


# --------------------------------------------------------------------------------------------
# validation/v2.json writer (contract v2.schema.json v1.0.0: summary + frames, open otherwise)
# --------------------------------------------------------------------------------------------

V2_OUT = hcfg.REPO / "data" / "interim" / "horizon" / "validation" / "v2.json"
MANUAL_CHECKS = hcfg.REPO / "data" / "interim" / "horizon" / "validation" / "manual_checks.json"
_ROUND = {"row_detected": 2, "az_deg": 3, "el_detected_deg": 4, "el_predicted_deg": 4,
          "error_deg": 4, "distance_m": 1}


def _rounded(rec: dict) -> dict:
    out = {}
    for k, v in rec.items():
        nd = _ROUND.get(k)
        out[k] = v if nd is None else [None if v_ is None or not np.isfinite(v_)
                                       else round(float(v_), nd) for v_ in v]
    return out


def evaluate_frame(frame: dict, profile: HorizonProfile | None, img) -> dict:
    """One ``frames[]`` entry (without manual-check fields). ``frame`` is a navcam_frames.json
    record; ``img`` the decoded image (array) or None. Failures are returned, never dropped."""
    from pipeline.horizon.cahvor import CameraModel as _CM  # noqa: PLC0415
    from pipeline.horizon.sky import detect_skyline  # noqa: PLC0415

    base = {"image_id": frame["image_id"], "sol": frame.get("sol"),
            "station": frame.get("station"), "stop_id": frame.get("stop_id"),
            "status": "failed", "failure": None, "hand_aligned": False}
    if img is None:
        return {**base, "failure": "image not cached"}
    if profile is None:
        return {**base, "failure": f"no horizon for stop {frame.get('stop_id')}"}
    det = detect_skyline(img)
    rows = np.where(det.in_ref_band, np.nan, det.rows)
    base["detected_frac"] = round(float(np.mean(np.isfinite(rows))), 4)
    in_ref = float(np.mean(det.in_ref_band))
    lim = hcfg.value(hcfg.load()["v2_frame_fail"]["max_in_ref_band_frac"])
    if in_ref > lim:
        return {**base, "failure": f"no clear sky at the top of the frame: boundary inside the "
                                   f"reference band in {in_ref:.0%} of columns (> {lim:.0%})"}
    if not np.isfinite(rows).any():
        return {**base, "failure": "no sky boundary detected (sky detector)"}
    cm = frame["camera_model"]
    model = _CM(cm["type"], cm["C"], cm["A"], cm["H"], cm["V"], O=cm.get("O"), R=cm.get("R"))
    rec = compare_columns(model, frame["attitude_quaternion"], profile, rows)
    if not np.isfinite(np.asarray(rec["error_deg"], dtype=float)).any():
        return {**base, "failure": "predicted skyline unknown in every detected column"}
    return {**base, "status": "ok", "summary": summarise([rec]), "columns": _rounded(rec)}


def build_v2(entries: list[dict], *, hand_aligned: bool = False,
             manual: dict | None = None) -> dict:
    """Assemble and validate validation/v2.json from per-frame entries (every frame tried).

    ``manual`` maps image_id -> bool (manual verdict on the detected skyline). ``available`` is
    false in the hand-aligned fallback (brief WS3) or with fewer than v2.min_stops stops; the
    summary values are then null (contract)."""
    from pipeline.horizon.contracts import validate  # noqa: PLC0415

    cfg = hcfg.load()
    manual = manual or {}
    sample = set(manual_check_sample([e["image_id"] for e in entries]))
    frames = []
    for e in entries:
        f = dict(e)
        f["manual_check"] = e["image_id"] in sample
        f["manual_ok"] = manual.get(e["image_id"])
        frames.append(f)
    ok = [f for f in frames if f["status"] == "ok" and f.get("manual_ok") is not False]
    n_stops = len({f.get("stop_id") or f["image_id"] for f in ok})
    available = (not hand_aligned) and n_stops >= cfg["v2"]["min_stops"]
    summary = summarise([f["columns"] for f in ok])
    if not available:
        summary = {c: {"n": summary[c]["n"], "median_deg": None, "median_abs_deg": None,
                       "p90_abs_deg": None} for c in CLASSES}
    method = "hand-aligned" if hand_aligned else (
        "automatic+manual_check" if any(v is not None for v in manual.values()) else "automatic")
    doc = {"available": bool(available), "method": method,
           "manual_check_frac": cfg["v2"]["manual_check_frac"],
           "distance_classes_km": list(cfg["distance_classes_km"]), "n_stops": n_stops,
           "n_frames_tried": len(frames), "n_frames_ok": len(ok),
           "min_stops": cfg["v2"]["min_stops"], "summary": summary, "frames": frames}
    validate(doc, "v2.schema.json")
    return doc


def station_skyline_error(doc: dict) -> dict:
    """{station: {near, mid, far}} = median |error| over that station's ok frames (card field
    skyline_error_deg; WS3 assumption: the card shows the median absolute error)."""
    by: dict[str, list] = {}
    for f in doc["frames"]:
        if f.get("station") and f["status"] == "ok" and f.get("manual_ok") is not False:
            by.setdefault(f["station"], []).append(f["columns"])
    return {s: {c: v["median_abs_deg"] for c, v in summarise(recs).items()}
            for s, recs in by.items()}


def _angle_from_north(az) -> float | None:
    if az is None or not np.isfinite(float(az)):
        return None
    return abs((float(az) + 180.0) % 360.0 - 180.0)


def far_note(doc: dict, frames_by_id: dict | None = None,
             best_cuts: dict | None = None) -> dict:
    """D7 (user 2026-11-14 15:01 CET) far-class note for v2.json (horizon.yaml d7_far_note).

    ``frames_by_id``: navcam_frames.json records (``pointing_site.az_centre_deg``);
    ``best_cuts``: image_id -> (best cut range km, median detected - predicted(cut) deg), the
    manual-check sheet's visibility-range diagnostic. Far-fail frames are the V2-ok frames used
    in the summary whose far-class median error exceeds ``far_fail_abs_deg``."""
    cfg = hcfg.load()
    nc = cfg["d7_far_note"]
    lim = float(cfg["manual_check_sheet"]["far_fail_abs_deg"])
    half, rng, tol = (float(nc["north_half_width_deg"]), float(nc["match_range_km"]),
                      float(nc["match_tol_deg"]))
    frames_by_id, best_cuts = frames_by_id or {}, best_cuts or {}
    ff = []
    for f in doc["frames"]:
        far = ((f.get("summary") or {}).get("far") or {}).get("median_deg")
        if (f["status"] == "ok" and f.get("manual_ok") is not False and far is not None
                and abs(far) > lim):
            ff.append(f)
    north = unknown_az = 0
    rim, counts = [], {}
    n_match = n_match_tol = n_cut_unknown = 0
    for f in ff:
        pointing = (frames_by_id.get(f["image_id"]) or {}).get("pointing_site") or {}
        d = _angle_from_north(pointing.get("az_centre_deg"))
        if d is None:
            unknown_az += 1
        elif d <= half:
            north += 1
        m = _median_where(f.get("columns") or {}, "distance_m", "far")
        if m is not None:
            rim.append(m / 1000.0)
        km, err = best_cuts.get(f["image_id"], (None, None))
        if km is None:
            n_cut_unknown += 1
            continue
        label = f"{float(km):g}"
        counts[label] = counts.get(label, 0) + 1
        if float(km) <= rng:
            n_match += 1
            if err is not None and abs(float(err)) <= tol:
                n_match_tol += 1
    return {
        "status": "not_validated",
        "decision": nc["decision"],
        "reason": "far rim hidden by haze in north-facing frames: the automatic detector "
                  "finds nearby terrain, not the rim (no manual review)",
        "far_fail_abs_deg": lim,
        "n_far_fail": len(ff),
        "north_half_width_deg": half,
        "n_far_fail_north": north,
        "n_far_fail_az_unknown": unknown_az,
        "rim_dist_km_min": round(min(rim), 1) if rim else None,
        "rim_dist_km_max": round(max(rim), 1) if rim else None,
        "rim_dist_basis": "per far-fail frame, median predicted-skyline distance over its far "
                          "columns; min and max over those frames",
        "match_range_km": rng,
        "match_tol_deg": tol,
        "n_match_near_terrain": n_match,
        "n_match_near_terrain_within_tol": n_match_tol,
        "n_best_cut_unknown": n_cut_unknown,
        "best_cut_range_km_counts": dict(sorted(counts.items(), key=lambda kv: float(kv[0]))),
        "frames": [f["image_id"] for f in ff],
    }


_FAR_NOTE_KEYS = (("far_fail_abs_deg", "deg"), ("n_far_fail", "1"),
                  ("north_half_width_deg", "deg"), ("n_far_fail_north", "1"),
                  ("n_far_fail_az_unknown", "1"), ("rim_dist_km_min", "km"),
                  ("rim_dist_km_max", "km"), ("match_range_km", "km"), ("match_tol_deg", "deg"),
                  ("n_match_near_terrain", "1"), ("n_match_near_terrain_within_tol", "1"),
                  ("n_best_cut_unknown", "1"))


def write_v2(doc: dict, path=V2_OUT, *, record_manifest: bool = True) -> Path:
    """Validate and write v2.json; record v2.n_stops, v2.n_frames_{tried,ok},
    v2.{class}.{n,median_deg,median_abs_deg,p90_abs_deg} and, with a D7 ``far_note``, every
    number in it as v2.far_note.* (manifest file = web path validation/v2.json)."""
    from pipeline.horizon.contracts import validate  # noqa: PLC0415
    from pipeline.provenance.manifest import record  # noqa: PLC0415

    validate(doc, "v2.schema.json")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, separators=(",", ":")))
    if record_manifest:
        rel = "validation/v2.json"
        for k in ("n_stops", "n_frames_tried", "n_frames_ok"):
            record(f"v2.{k}", doc[k], "1", file=rel, script=__file__)
        for c in CLASSES:
            for k in ("n", "median_deg", "median_abs_deg", "p90_abs_deg"):
                record(f"v2.{c}.{k}", doc["summary"][c][k], "1" if k == "n" else "deg",
                       file=rel, script=__file__)
        fn = doc.get("far_note")
        if fn:
            for k, units in _FAR_NOTE_KEYS:
                record(f"v2.far_note.{k}", fn[k], units, file=rel, script=__file__)
            for km, n in fn["best_cut_range_km_counts"].items():
                record(f"v2.far_note.best_cut_range_km_counts.{km}", n, "1", file=rel,
                       script=__file__)
        # card keys skyline_error_deg.{S}.* are recorded with the card (pipeline/horizon/cards.py)
    return path


def compute_v2(frames_json=None, horizons_dir=None, *, manual_json=MANUAL_CHECKS) -> dict:
    """v2.json content (not written): every frame in navcam_frames.json against
    horizons/{stop_id}.json (navcam eye height)."""
    from PIL import Image  # noqa: PLC0415

    root = hcfg.REPO / "data" / "interim" / "horizon"
    frames_json = Path(frames_json or root / "navcam_frames.json")
    horizons_dir = Path(horizons_dir or root / "horizons")
    frames = json.loads(frames_json.read_text())["frames"]
    entries, profiles = [], {}
    for fr in frames:
        sid = fr.get("stop_id")
        if sid not in profiles:
            hp = horizons_dir / f"{sid}.json"
            profiles[sid] = HorizonProfile.read_json(hp) if hp.exists() else None
        p = hcfg.REPO / fr["local_path"]
        img = np.asarray(Image.open(p).convert("L")) if p.exists() else None
        entries.append(evaluate_frame(fr, profiles[sid], img))
    manual_path = Path(manual_json)
    manual = json.loads(manual_path.read_text()) if manual_path.exists() else {}
    return build_v2(entries, manual=manual)


def run_v2(frames_json=None, horizons_dir=None, out=V2_OUT, *, manual_json=MANUAL_CHECKS,
           record_manifest: bool = True) -> dict:
    """compute_v2 + write_v2 (without the D7 far note; ``main`` adds it)."""
    doc = compute_v2(frames_json, horizons_dir, manual_json=manual_json)
    write_v2(doc, out, record_manifest=record_manifest)
    return doc


def write_composites(doc: dict, frames_json=None, horizons_dir=None, out_dir=None) -> int:
    """V2 check composites validation/overlays/{image_id}.jpg: frame + predicted skyline (overlay
    colour) + the detector's line (detected colour) for every frame with a stop horizon."""
    from PIL import Image  # noqa: PLC0415

    from pipeline.horizon.overlay import (  # noqa: PLC0415
        composite,
        frame_camera,
        render_overlay,
        skyline_pixels,
    )

    root = hcfg.REPO / "data" / "interim" / "horizon"
    frames = json.loads(Path(frames_json or root / "navcam_frames.json").read_text())["frames"]
    hdir = Path(horizons_dir or root / "horizons")
    odir = Path(out_dir or root / "validation" / "overlays")
    odir.mkdir(parents=True, exist_ok=True)
    det = {f["image_id"]: f for f in doc["frames"]}
    n = 0
    for fr in frames:
        hp, ip = hdir / f"{fr['stop_id']}.json", hcfg.REPO / fr["local_path"]
        if not (hp.exists() and ip.exists()):
            continue
        prof = HorizonProfile.read_json(hp)
        grey = np.asarray(Image.open(ip).convert("L"))
        size = (grey.shape[1], grey.shape[0])
        model, q = frame_camera(fr)
        ov = render_overlay(size, skyline_pixels(prof, model, q, size))
        rows = None
        e = det.get(fr["image_id"], {})
        if e.get("status") == "ok":
            rows = np.full(size[0], np.nan)
            c = e["columns"]
            rows[np.asarray(c["column"], dtype=int)] = [np.nan if r is None else r
                                                        for r in c["row_detected"]]
        composite(grey, ov, detected_rows=rows).save(odir / f"{fr['image_id']}.jpg", quality=85)
        n += 1
    return n


# --------------------------------------------------------------------------------------------
# D7 preparation: manual-check sheet (horizon.yaml manual_check_sheet). Does not decide D7.
# --------------------------------------------------------------------------------------------

MANUAL_SHEET_DIR = hcfg.REPO / "data" / "interim" / "horizon" / "validation" / "manual_check"
SHEET_FIELDS = ["image_id", "why", "sol", "stop_id", "station", "frame_az_deg", "v2_status",
                "failure", "near_err_median_deg", "mid_err_median_deg", "far_err_median_deg",
                "far_n", "far_pred_el_median_deg", "far_det_el_median_deg",
                "far_dist_km_median", "best_cut_range_km", "far_det_minus_pred_cut_median_deg",
                "composite", "verdict", "note"]


def cut_engine(engine, max_range_m: float):
    """Horizon engine over the same bands with ``sampling`` truncated at ``max_range_m`` (terrain
    beyond it ignored): the sheet's visibility-range diagnostic."""
    from pipeline.horizon.rays import HorizonEngine  # noqa: PLC0415

    cfg = hcfg.load()
    # segments past the range become empty (start beyond end), so the band order is unchanged
    seg = [{**s_, "to_m": min(float(s_["to_m"]), float(max_range_m))} for s_ in cfg["sampling"]]
    return HorizonEngine(engine.bands, cfg={**cfg, "sampling": seg})


def best_cut(entry: dict, engine, observer: dict, az_step_deg: float):
    """(range_km, median error, profile) of the cut range whose skyline best matches the
    detector over the frame's far columns; (None, None, None) without far columns."""
    best = (None, None, None)
    for km in hcfg.load()["manual_check_sheet"]["cut_ranges_km"]:
        eng = cut_engine(engine, float(km) * 1000.0)
        prof = eng.horizon(observer["x"], observer["y"], z_obs=observer["z"],
                           az_step_deg=az_step_deg)
        e = cut_error(entry, prof)
        if e is not None and (best[1] is None or abs(e) < abs(best[1])):
            best = (float(km), e, prof)
    return best


def cut_error(entry: dict, prof_cut: HorizonProfile):
    """Median (detected - predicted from the cut horizon) over the frame's far-class columns."""
    c = entry.get("columns") or {}
    az = [a for a, k in zip(c.get("az_deg", []), c.get("distance_class", []), strict=False)
          if k == "far"]
    det = [d for d, k in zip(c.get("el_detected_deg", []), c.get("distance_class", []),
                             strict=False) if k == "far"]
    if not az:
        return None
    e = np.asarray(det, dtype=float) - prof_cut.elevation_at(np.asarray(az, dtype=float))
    e = e[np.isfinite(e)]
    return round(float(np.median(e)), 3) if e.size else None


def _median_where(cols: dict, key: str, cls: str):
    v = [x for x, c in zip(cols.get(key, []), cols.get("distance_class", []), strict=False)
         if c == cls and x is not None]
    return round(float(np.median(v)), 3) if v else None


def manual_check_rows(doc: dict, frames_by_id: dict | None = None) -> list[dict]:
    """Rows of the manual-check sheet: the 20 % sample, every ok frame whose far-class median
    error exceeds ``far_fail_abs_deg``, and (if configured) the failed frames. ``verdict`` and
    ``note`` are left empty for the human reviewer."""
    sc = hcfg.load()["manual_check_sheet"]
    lim = float(sc["far_fail_abs_deg"])
    frames_by_id = frames_by_id or {}
    rows = []
    for f in doc["frames"]:
        why = []
        if f.get("manual_check"):
            why.append("sample_20pct")
        sm = f.get("summary") or {}
        far = (sm.get("far") or {}).get("median_deg")
        if f["status"] == "ok" and far is not None and abs(far) > lim:
            why.append("far_fail")
        if f["status"] != "ok" and sc["include_failed_frames"]:
            why.append("frame_failed")
        if not why:
            continue
        cols = f.get("columns") or {}
        dist = _median_where(cols, "distance_m", "far")
        fr = frames_by_id.get(f["image_id"], {})
        az = (fr.get("pointing_site") or {}).get("az_centre_deg")
        rows.append({
            "image_id": f["image_id"], "why": "+".join(why), "sol": f.get("sol"),
            "stop_id": f.get("stop_id"), "station": f.get("station") or "",
            "frame_az_deg": az, "v2_status": f["status"], "failure": f.get("failure") or "",
            **{f"{c}_err_median_deg": None if (sm.get(c) or {}).get("median_deg") is None
               else round(sm[c]["median_deg"], 3) for c in CLASSES},
            "far_n": (sm.get("far") or {}).get("n"),
            "far_pred_el_median_deg": _median_where(cols, "el_predicted_deg", "far"),
            "far_det_el_median_deg": _median_where(cols, "el_detected_deg", "far"),
            "far_dist_km_median": None if dist is None else round(dist / 1000.0, 1),
            "best_cut_range_km": None, "far_det_minus_pred_cut_median_deg": None,
            "composite": f"{f['image_id']}.jpg", "verdict": "", "note": "",
        })
    return rows


def _read_sheet(path) -> list[dict]:
    """Rows of a manual-check CSV as written by this module or re-saved by a spreadsheet app
    (UTF-8 with or without BOM; ',', ';' or tab delimiter). Requires image_id and verdict."""
    text = Path(path).read_text(encoding="utf-8-sig")
    head = text.splitlines()[0] if text else ""
    delim = max((",", ";", "\t"), key=head.count)
    rows = list(csv.DictReader(text.splitlines(), delimiter=delim))
    cols = {c.strip() for c in (rows[0].keys() if rows else head.split(delim))}
    missing = {"image_id", "verdict"} - cols
    if missing:
        raise ValueError(f"{path}: column(s) {sorted(missing)} missing (header: {head!r})")
    return [{(k or "").strip(): (v or "").strip() for k, v in r.items()} for r in rows]


def read_manual_verdicts(path) -> dict:
    """image_id -> manual_ok from a filled sheet: ``ok`` -> True, any other listed verdict ->
    False, empty or ``unsure`` -> not judged. Verdicts are matched case-insensitively. An unknown
    verdict, or one image_id with two different verdicts, raises ValueError."""
    allowed = set(hcfg.load()["manual_check_sheet"]["verdicts"])
    out, seen = {}, {}
    for r in _read_sheet(path):
        iid, v = r.get("image_id", ""), r.get("verdict", "").lower()
        if not iid or not v or v == "unsure":
            continue
        if v not in allowed:
            raise ValueError(f"{iid}: verdict {v!r} not in {sorted(allowed)}")
        if seen.setdefault(iid, v) != v:
            raise ValueError(f"{iid}: two different verdicts ({seen[iid]!r}, {v!r})")
        out[iid] = v == "ok"
    return out


def _carry_over_sheet(out_dir: Path) -> dict:
    """Before the sheet is rewritten: image_id -> (verdict, note) already filled in, and a copy
    of a filled sheet in ``<out_dir>/../manual_check_backups/`` (UTC-stamped)."""
    import shutil  # noqa: PLC0415
    from datetime import UTC, datetime  # noqa: PLC0415

    old = out_dir / "manual_check.csv"
    if not old.exists():
        return {}
    try:
        rows = _read_sheet(old)
    except (ValueError, OSError, csv.Error, UnicodeDecodeError):
        rows = []
    keep = {r["image_id"]: (r.get("verdict", ""), r.get("note", "")) for r in rows
            if r.get("image_id") and (r.get("verdict") or r.get("note"))}
    if keep or not rows:  # filled, or unreadable: keep a copy either way
        bdir = out_dir.parent / "manual_check_backups"
        bdir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        dst, k = bdir / f"manual_check_{stamp}.csv", 1
        while dst.exists():
            dst, k = bdir / f"manual_check_{stamp}_{k}.csv", k + 1
        shutil.copy2(old, dst)
    return keep


def write_manual_check_sheet(doc: dict, frames_json=None, horizons_dir=None,
                             out_dir=MANUAL_SHEET_DIR, engine=None) -> list[dict]:
    """manual_check.csv + one captioned composite per listed frame + contact sheets. With the
    canonical bands available, each composite also shows the cut (<= 30 km) skyline."""
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    from pipeline.horizon.overlay import (  # noqa: PLC0415
        composite,
        frame_camera,
        render_overlay,
        skyline_pixels,
    )

    root = hcfg.REPO / "data" / "interim" / "horizon"
    frames = json.loads(Path(frames_json or root / "navcam_frames.json").read_text())["frames"]
    by_id = {f["image_id"]: f for f in frames}
    hdir = Path(horizons_dir or root / "horizons")
    out_dir = Path(out_dir)
    filled = _carry_over_sheet(out_dir)
    if out_dir.exists():
        for old in out_dir.glob("*"):
            old.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = manual_check_rows(doc, by_id)
    for r in rows:
        r["verdict"], r["note"] = filled.get(r["image_id"], (r["verdict"], r["note"]))
    det = {f["image_id"]: f for f in doc["frames"]}
    try:
        font = ImageFont.load_default(size=16)
    except TypeError:
        font = ImageFont.load_default()
    if engine is None:
        try:
            from pipeline.horizon.bands import load_engine  # noqa: PLC0415

            engine = load_engine()
        except (FileNotFoundError, ValueError, OSError):
            engine = None
    sc = hcfg.load()["manual_check_sheet"]
    ov_cut = {"overlay": {**hcfg.load()["overlay"], "line_rgba": sc["cut_rgba"]}}
    thumbs = []
    for r in rows:
        fr = by_id.get(r["image_id"])
        ip = hcfg.REPO / fr["local_path"] if fr else None
        if fr is None or not ip.exists():
            r["composite"] = ""
            continue
        grey = np.asarray(Image.open(ip).convert("L"))
        size = (grey.shape[1], grey.shape[0])
        hp = hdir / f"{fr['stop_id']}.json"
        if hp.exists():
            model, q = frame_camera(fr)
            prof = HorizonProfile.read_json(hp)
            ov = render_overlay(size, skyline_pixels(prof, model, q, size))
            if engine is not None:
                km, err, pc = best_cut(det.get(r["image_id"], {}), engine, prof.observer,
                                       prof.az_step_deg)
                r["best_cut_range_km"], r["far_det_minus_pred_cut_median_deg"] = km, err
                if pc is not None:
                    ov = Image.alpha_composite(
                        render_overlay(size, skyline_pixels(pc, model, q, size), cfg=ov_cut), ov)
        else:
            ov = Image.new("RGBA", size, (0, 0, 0, 0))
        rows_det = None
        e = det.get(r["image_id"], {})
        if e.get("status") == "ok":
            rows_det = np.full(size[0], np.nan)
            c = e["columns"]
            rows_det[np.asarray(c["column"], dtype=int)] = [np.nan if v is None else v
                                                            for v in c["row_detected"]]
        img = composite(grey, ov, detected_rows=rows_det)
        cap = Image.new("RGB", (img.width, 84), (0, 0, 0))
        d = ImageDraw.Draw(cap)
        d.text((6, 4), f"{r['image_id']}  sol {r['sol']}  stop {r['stop_id']}  "
                       f"az {r['frame_az_deg']}  [{r['why']}]", fill=(255, 255, 255), font=font)
        d.text((6, 24), (f"far: predicted {r['far_pred_el_median_deg']} deg, detected "
                         f"{r['far_det_el_median_deg']} deg, error {r['far_err_median_deg']} deg "
                         f"at {r['far_dist_km_median']} km" if r["v2_status"] == "ok"
                         else f"V2 failed: {r['failure'][:110]}"), fill=(255, 215, 0), font=font)
        d.text((6, 44), f"best match: terrain <= {r['best_cut_range_km']} km only, detected - "
                        f"predicted = {r['far_det_minus_pred_cut_median_deg']} deg",
               fill=(80, 230, 80), font=font)
        d.text((6, 64), "orange = predicted (all terrain)  green = predicted, best cut range  "
                        "cyan = detected", fill=(180, 180, 180), font=font)
        full = Image.new("RGB", (img.width, img.height + cap.height))
        full.paste(cap, (0, 0))
        full.paste(img, (0, cap.height))
        full.save(out_dir / r["composite"], quality=85)
        t = full.copy()
        t.thumbnail((400, 400))
        thumbs.append((r["image_id"], t))
    with (out_dir / "manual_check.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=SHEET_FIELDS)
        w.writeheader()
        w.writerows(rows)
    per, cols = 12, 4
    for k in range(0, len(thumbs), per):
        chunk = thumbs[k:k + per]
        tw = max(t.width for _, t in chunk)
        th = max(t.height for _, t in chunk)
        nrow = math.ceil(len(chunk) / cols)
        sheet = Image.new("RGB", (cols * tw, nrow * th), (40, 40, 40))
        for i, (_, t) in enumerate(chunk):
            sheet.paste(t, ((i % cols) * tw, (i // cols) * th))
        sheet.save(out_dir / f"contact_{k // per + 1:02d}.jpg", quality=80)
    (out_dir / "HOW_TO.txt").write_text(
        "Manual check of the V2 skyline frames (D7 preparation; D7 itself is not decided here).\n"
        "One composite per frame: orange = predicted skyline from the DEM (all bands), green = "
        "predicted from terrain within the cut range only (no far rim), cyan = sky detector.\n"
        "best_cut_range_km: the terrain range (km) whose predicted skyline best matches the "
        "detector; a short range with a small far_det_minus_pred_cut_median_deg on a far_fail "
        "frame means only nearby terrain is seen (haze).\n"
        "Fill the `verdict` column of manual_check.csv with one of: "
        + ", ".join(hcfg.load()["manual_check_sheet"]["verdicts"]) + ".\n"
        "  ok              the detected line follows the true skyline in the photo\n"
        "  rim_not_visible the far rim is hidden by haze; the detector found lower terrain\n"
        "  detector_wrong  the detector line is not the skyline for another reason\n"
        "  model_wrong     the detector is right but the predicted line is off\n"
        "  unsure          not judged\n"
        "Then: python -m pipeline.validation.v2_skyline --import-manual <csv> (writes "
        "manual_checks.json; frames judged other than ok leave the V2 summary on the next run).\n")
    return rows


def main(argv=None) -> int:
    import argparse  # noqa: PLC0415

    ap = argparse.ArgumentParser(description="V2 skyline validation (F13)")
    ap.add_argument("--no-manifest", action="store_true")
    ap.add_argument("--import-manual", metavar="CSV",
                    help="write manual_checks.json from a filled manual-check sheet and stop")
    a = ap.parse_args(argv)
    if a.import_manual:
        import sys  # noqa: PLC0415

        try:
            v = read_manual_verdicts(a.import_manual)
        except (ValueError, OSError, csv.Error, UnicodeDecodeError) as exc:
            print(f"--import-manual: {exc}; nothing written", file=sys.stderr)
            return 2
        if V2_OUT.exists():
            known = {f["image_id"] for f in json.loads(V2_OUT.read_text())["frames"]}
            unknown = sorted(set(v) - known)
            if unknown:
                print(f"note: {len(unknown)} judged frame(s) not in the current v2.json "
                      f"(kept, no effect until they return): {unknown}")
        MANUAL_CHECKS.parent.mkdir(parents=True, exist_ok=True)
        MANUAL_CHECKS.write_text(json.dumps(v, indent=1))
        print(f"{len(v)} verdicts ({sum(v.values())} ok) -> {MANUAL_CHECKS}")
        return 0
    doc = compute_v2()
    n = write_composites(doc)
    # the sheet (optional since D7) also computes the best-cut evidence used by the far note
    rows = write_manual_check_sheet(doc)
    frames = json.loads((hcfg.REPO / "data" / "interim" / "horizon" / "navcam_frames.json")
                        .read_text())["frames"]
    cuts = {r["image_id"]: (r["best_cut_range_km"], r["far_det_minus_pred_cut_median_deg"])
            for r in rows}
    doc["far_note"] = far_note(doc, {f["image_id"]: f for f in frames}, cuts)
    write_v2(doc, record_manifest=not a.no_manifest)
    print(f"{len(rows)} frames on the manual-check sheet in {MANUAL_SHEET_DIR}")
    print(json.dumps({k: doc[k] for k in ("available", "method", "n_stops", "n_frames_tried",
                                          "n_frames_ok", "summary")}, indent=1))
    print(json.dumps({k: v for k, v in doc["far_note"].items() if k != "frames"}, indent=1))
    print(f"{n} check composites in data/interim/horizon/validation/overlays/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
