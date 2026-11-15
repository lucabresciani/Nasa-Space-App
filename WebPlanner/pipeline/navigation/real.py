"""WS9 real run (F21, F22; SPEC §2.4, §6.2): the dead-reckoning Monte Carlo on WS2's planned route,
the fix-interval map on WS2's T_home field and skyline fixes on WS3's Navcam frames.

    python -m pipeline.navigation.run real --dry-run   # list inputs (owner, purpose) only
    python -m pipeline.navigation.run real             # full run (refuses on a missing input)

Inputs (all under data/interim/, never web/public/data/):

* WS2 ``engine/public/route_{sc}.geojson`` (legs with per-vertex ``times_min``, else uniform speed
  between ``t_start_min`` and ``t_end_min``) and ``timeline_{sc}.json`` (fix events, nav.yaml
  ``real_run_ws9.fix_events``); ``engine/{sc}/t_home.tif`` (fix-interval map). ``sc`` defaults to
  variants.yaml ``scenarios.default``.
* WS1 ``terrain/slope_1m.tif`` (slip on slopes above ``slip_min_slope_deg``).
* WS3 ``horizon/navcam_frames.json`` + the cached frames, and the DEM bands WS3's horizon engine
  reads (horizon.yaml ``bands.{source}.path``: WS1's canonical dem_1m, ctx_20m, mola_hrsc_200m;
  C 11:15) (F22). ``--no-skyline`` skips F22 (G2 fallback: station fixes only).
* F22 gate (C, 2026-11-14 11:58): a station's skyline result becomes a position fix only if its
  error is within the F22 KAT tolerance (``skyline_fix.refine_grid_m``); else the surveyed
  station fix is kept and the run report says why.

Outputs (``data/interim/navigation/``, mirroring the web data paths for ``make web``):
``nav/montecarlo_{set}.json``, ``nav/tracks_{set}.geojson``, ``nav/fixes.json``,
``nav/fix_interval_summary.json`` (contracts v1.0.0: one file, the nav.yaml ``default_set``),
``fields/fix_interval_{set}.png`` on the HUD field grid (nav.yaml ``real_run_ws9.field_grid``),
``localisation/{image_id}.json``, and two files ``make web`` should not copy:
``fields_index_nav.json`` (the ``fields/index.json`` entries and grid for WS7's index) and
``run_report.json`` (every frame tried, failures included; every set's fix-interval summary).
Manifest entries (``nav.*`` keys) are recorded only when writing to the default output directory.
"""

from __future__ import annotations

import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pipeline.navigation import deadreckon as dr
from pipeline.navigation import fixinterval as fi
from pipeline.navigation import montecarlo as mc

INTERIM = dr.REPO / "data" / "interim"
REAL_OUT = INTERIM / "navigation"
SUBDIRS = ("nav", "fields")  # cleared before an F21 run (no stale files)
SKYLINE_REPORT = "skyline_report.json"  # F22 run report: every frame tried (not copied to web)
F21_FRAGMENTS = ("montecarlo", "fixinterval")  # pipeline__navigation__*.json
F22_FRAGMENTS = ("skylinefix",)


def _rcfg() -> dict:
    return dr.load_config()["real_run_ws9"]


def default_scenario() -> str:
    return str(dr._yaml("variants")["scenarios"]["default"])


# --------------------------------------------------------------------------------------------
# Inputs
# --------------------------------------------------------------------------------------------

@dataclass
class Input:
    name: str
    path: Path
    owner: str
    used_for: str
    required: bool = True  # required for the run as configured (F22 inputs only with skyline)

    @property
    def exists(self) -> bool:
        return self.path.exists()


def inputs(scenario: str | None = None, *, interim: Path = INTERIM,
           skyline: bool = True) -> list[Input]:
    sc = scenario or default_scenario()
    pub = interim / "engine" / "public"
    out = [
        Input("route", pub / f"route_{sc}.geojson", "WS2", "Monte Carlo trajectory (F21)"),
        Input("timeline", pub / f"timeline_{sc}.json", "WS2", "fix events (F21)"),
        Input("t_home", interim / "engine" / sc / "t_home.tif", "WS2", "fix-interval map (F21)"),
        Input("slope", interim / "terrain" / "slope_1m.tif", "WS1", "slip above 10 deg (F21)"),
        Input("navcam_frames", interim / "horizon" / "navcam_frames.json", "WS3",
              "skyline fixes (F22)", required=skyline),
    ]
    for src, p in skyline_band_paths(interim.parent.parent).items():
        out.append(Input(src, p, "WS1", "horizon engine for skyline fixes (F22)",
                         required=skyline))
    return out


BAND_SOURCES = ("dem_1m", "ctx_20m", "mola_hrsc_200m")


def skyline_band_paths(root: Path) -> dict[str, Path]:
    """DEM bands for F22 (nav.yaml ``real_run_ws9.skyline_bands`` = "horizon.yaml"): the paths
    WS3's horizon engine reads, horizon.yaml ``bands.{source}.path`` (repo-relative), under
    ``root`` (the repo, or a tmp tree's root in tests)."""
    if _rcfg()["skyline_bands"] != "horizon.yaml":
        raise ValueError("nav.yaml real_run_ws9.skyline_bands: only 'horizon.yaml' is supported")
    hb = dr._yaml("horizon")["bands"]
    return {src: Path(root) / hb[src]["path"] for src in BAND_SOURCES}


def dry_run(scenario: str | None = None, *, interim: Path = INTERIM, skyline: bool = True,
            log=print) -> dict:
    """Report every input (present / missing, owner, purpose) and light content checks;
    ``problems`` empty = the real run may start. Computes nothing, writes nothing."""
    sc = scenario or default_scenario()
    ins = inputs(sc, interim=interim, skyline=skyline)
    problems = [f"missing: {i.path} (owner {i.owner}; {i.used_for})"
                for i in ins if i.required and not i.exists]
    notes: list[str] = []
    by = {i.name: i for i in ins}
    if by["route"].exists:
        try:
            knots = route_knots(json.loads(by["route"].path.read_text()))
            notes.append(f"route: {knots['n_legs']} legs, {knots['t_min'][-1]:.2f} min, "
                         f"per-vertex times on {knots['timed_legs']}/{knots['n_legs']} legs")
        except (ValueError, KeyError) as e:
            problems.append(f"route {by['route'].path.name}: {e}")
    if by["timeline"].exists:
        try:
            fx = fixes_from_timeline(json.loads(by["timeline"].path.read_text()))
            notes.append("timeline fixes: " + ", ".join(
                f"{f.type}{'@' + f.station if f.station else ''} {f.t_eva_min:g} min" for f in fx))
            stations = [f.station for f in fx if f.station]
        except (ValueError, KeyError) as e:
            problems.append(f"timeline {by['timeline'].path.name}: {e}")
            stations = []
        if skyline and by["navcam_frames"].exists:
            allf = json.loads(by["navcam_frames"].path.read_text()).get("frames", [])
            frames = paired_frames(allf, stations)
            cached = [f for f in allf if (dr.REPO / f.get("local_path", "")).is_file()]
            notes.append(f"F22: {len(allf)} Navcam frames ({len(cached)} cached) tried; "
                         f"{len(frames)} paired with route stations "
                         f"{sorted({f['station'] for f in frames})}; stations without a paired "
                         f"frame (station fix kept): "
                         f"{sorted(set(stations) - {f['station'] for f in frames})}")
    rep = {"scenario": sc, "skyline": skyline,
           "inputs": [{"name": i.name, "path": str(i.path), "owner": i.owner,
                       "used_for": i.used_for, "required": i.required, "exists": i.exists}
                      for i in ins],
           "notes": notes, "problems": problems}
    log(f"WS9 real run, scenario {sc}, skyline fixes {'on' if skyline else 'off'}")
    for i in ins:
        flag = "ok     " if i.exists else ("MISSING" if i.required else "absent ")
        log(f"  {flag} {i.name:>15}  {i.path}  ({i.owner}: {i.used_for})")
    for n in notes:
        log(f"  note: {n}")
    log("PROBLEMS:\n  " + "\n  ".join(problems) if problems else "all inputs present")
    return rep


# --------------------------------------------------------------------------------------------
# Route -> trajectory, timeline -> fixes
# --------------------------------------------------------------------------------------------

def _leg_coords(geom: dict) -> list:
    if geom["type"] == "LineString":
        return list(geom["coordinates"])
    if geom["type"] == "MultiLineString":
        return [c for part in geom["coordinates"] for c in part]
    raise ValueError(f"route geometry {geom['type']} is not a line")


def route_knots(route_fc: dict) -> dict:
    """Timed knots (minutes since EVA start, lon, lat) of all route legs in time order. A leg
    with ``times_min`` (one per vertex, WS2) uses them; else uniform speed along the leg between
    ``t_start_min`` and ``t_end_min``. Gaps between legs are dwells (held at the last vertex)."""
    legs = []
    timed = 0
    for f in route_fc["features"]:
        p = f.get("properties") or {}
        c = np.asarray(_leg_coords(f["geometry"]), dtype=float)[:, :2]
        if c.shape[0] < 2:
            raise ValueError(f"leg {p.get('leg')} has < 2 vertices")
        tm = p.get("times_min")
        if tm is not None:
            tm = np.asarray(tm, dtype=float)
            if tm.shape[0] != c.shape[0]:
                raise ValueError(f"leg {p.get('leg')}: {tm.shape[0]} times_min for "
                                 f"{c.shape[0]} vertices")
            timed += 1
        else:
            if p.get("t_start_min") is None or p.get("t_end_min") is None:
                raise ValueError(f"leg {p.get('leg')}: no times_min and no t_start/t_end_min")
            x, y = dr.lonlat_to_xy(c[:, 0], c[:, 1])
            s = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
            t0, t1 = float(p["t_start_min"]), float(p["t_end_min"])
            tm = t0 + (t1 - t0) * (s / s[-1] if s[-1] > 0 else np.zeros_like(s))
        legs.append((float(tm[0]), tm, c))
    if not legs:
        raise ValueError("route has no legs")
    legs.sort(key=lambda leg: leg[0])
    t = np.concatenate([leg[1] for leg in legs])
    lonlat = np.concatenate([leg[2] for leg in legs])
    if np.any(np.diff(t) < -1e-9):
        raise ValueError("route legs overlap in time")
    return {"t_min": t, "lon": lonlat[:, 0], "lat": lonlat[:, 1], "n_legs": len(legs),
            "timed_legs": timed}


class SlopeSampler:
    """Nearest-pixel slope (deg) from a north-up GeoTIFF in the analysis CRS, read once over a
    window around the points; NaN off the raster or where unknown."""

    def __init__(self, path, xs, ys, margin_m: float = 50.0):
        import rasterio  # noqa: PLC0415
        from rasterio.windows import from_bounds  # noqa: PLC0415

        with rasterio.open(path) as ds:
            _check_crs(ds, path)
            w = from_bounds(float(np.min(xs)) - margin_m, float(np.min(ys)) - margin_m,
                            float(np.max(xs)) + margin_m, float(np.max(ys)) + margin_m,
                            ds.transform).round_offsets().round_lengths()
            self.z = ds.read(1, window=w, boundless=True, fill_value=np.nan).astype(float)
            if ds.nodata is not None and not np.isnan(ds.nodata):
                self.z[self.z == ds.nodata] = np.nan
            self.t = ds.window_transform(w)

    def __call__(self, x, y):
        x = np.asarray(x, dtype=float)
        y = np.asarray(y, dtype=float)
        c = np.floor((x - self.t.c) / self.t.a).astype(int)
        r = np.floor((y - self.t.f) / self.t.e).astype(int)
        ok = (r >= 0) & (r < self.z.shape[0]) & (c >= 0) & (c < self.z.shape[1])
        out = np.full(x.shape, np.nan)
        out[ok] = self.z[r[ok], c[ok]]
        return out


def _check_crs(ds, path) -> None:
    from pyproj import CRS  # noqa: PLC0415

    want = CRS.from_user_input(dr.site_config()["crs"]["analysis_proj"])
    if ds.crs is None or not CRS.from_user_input(ds.crs).equals(want):
        raise ValueError(f"{path}: CRS {ds.crs} is not the site.yaml analysis CRS")


def route_trajectory(route_fc: dict, *, slope_path=None, label: str = "route"):
    """F21 trajectory along the planned route (local metres from the first vertex, 1 s steps).
    Returns (Trajectory, info) with info on slope coverage."""
    k = route_knots(route_fc)
    x, y = dr.lonlat_to_xy(k["lon"], k["lat"])
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    origin = (float(x[0]), float(y[0]))
    t_s = k["t_min"] * 60.0
    if t_s[0] > 0:  # standing at the start before the first knot
        t_s, x, y = np.r_[0.0, t_s], np.r_[x[0], x], np.r_[y[0], y]
    info = {"slope_source": None, "slope_unknown_frac": None}
    if slope_path is not None:
        sampler = SlopeSampler(slope_path, x, y)
        rule = _rcfg()["unknown_slope"]
        if rule != "no_slip":
            raise ValueError(f"nav.yaml real_run_ws9.unknown_slope {rule!r} not implemented")
        stats = {}

        def slope_fn(lx, ly):
            s = sampler(np.asarray(lx) + origin[0], np.asarray(ly) + origin[1])
            stats["unknown"] = float(np.mean(~np.isfinite(s))) if s.size else 0.0
            return np.where(np.isfinite(s), s, 0.0)  # unknown slope: no slip term (assumed)

        traj = dr.timed_route(t_s, x - origin[0], y - origin[1], slope_deg=slope_fn,
                              origin_xy=origin, label=label)
        info = {"slope_source": str(slope_path), "slope_unknown_frac": stats.get("unknown")}
    else:
        traj = dr.timed_route(t_s, x - origin[0], y - origin[1], origin_xy=origin, label=label)
    return traj, info


def fixes_from_timeline(timeline: list, *, skyline: dict | None = None) -> list[dr.FixEvent]:
    """Fix events from timeline rows (nav.yaml ``real_run_ws9.fix_events``): rover fixes at the
    pad (sigma ``fix_sigma_m.rover``), surveyed-station fixes on arrival (``fix_sigma_m.station``).
    ``skyline``: {station: localisation row with image_id and error_m} from F22; per
    ``skyline_station_fix`` it replaces the station fix ("replace") or follows it ("add")."""
    cfg = dr.load_config()
    sig = cfg["fix_sigma_m"]
    ev = _rcfg()["fix_events"]
    mode = _rcfg()["skyline_station_fix"]
    if mode not in ("replace", "add"):
        raise ValueError(f"nav.yaml real_run_ws9.skyline_station_fix {mode!r}")
    skyline = skyline or {}
    out = []
    for row in timeline:
        e, st, t = row.get("event"), row.get("station"), float(row["t_min"])
        if e in ev["rover"]:
            out.append(dr.FixEvent(t, "rover", float(sig["rover"])))
        elif e in ev["station"]:
            if not st:
                raise ValueError(f"timeline '{e}' at {t} min has no station")
            sk = skyline.get(st)
            if sk is None or mode == "add":
                out.append(dr.FixEvent(t, "station", float(sig["station"]), station=st))
            if sk is not None:
                out.append(dr.FixEvent(t, "skyline", float(sk["error_m"]), station=st,
                                       error_m=float(sk["error_m"]), image_id=sk["image_id"]))
    if not out:
        raise ValueError("timeline gives no fix events")
    return out


# --------------------------------------------------------------------------------------------
# F22 on real Navcam frames
# --------------------------------------------------------------------------------------------

def paired_frames(frames: list[dict], stations) -> list[dict]:
    """Frames at a route station's drive end (WS3's ``station`` field; nav.yaml
    ``real_run_ws9.skyline_frames``): only these become F21 fix events."""
    want = set(stations)
    return [f for f in frames if f.get("station") in want]


def observe_frame(frame: dict, img) -> tuple[np.ndarray, np.ndarray]:
    """Detected skyline (azimuth, elevation per image column, site frame) of one Navcam frame,
    with WS3's V2 frame checks (horizon.yaml ``v2_frame_fail``). Raises ValueError with the
    reason when the frame cannot be used."""
    from pipeline.horizon import config as hcfg  # noqa: PLC0415
    from pipeline.horizon.cahvor import pixels_to_az_el  # noqa: PLC0415
    from pipeline.horizon.navcam import frame_model  # noqa: PLC0415
    from pipeline.horizon.sky import detect_skyline  # noqa: PLC0415

    det = detect_skyline(img)
    rows = np.where(det.in_ref_band, np.nan, det.rows)
    lim = hcfg.load()["v2_frame_fail"]["max_in_ref_band_frac"]
    if float(np.mean(det.in_ref_band)) > lim:
        raise ValueError(f"no clear sky at the top of the frame (boundary in the reference band "
                         f"in more than {lim:.0%} of columns)")
    cols = np.flatnonzero(np.isfinite(rows))
    if cols.size == 0:
        raise ValueError("no sky boundary detected")
    az, el = pixels_to_az_el(frame_model(frame), frame["attitude_quaternion"],
                             np.column_stack([cols.astype(float), rows[cols]]))
    return np.asarray(az, dtype=float), np.asarray(el, dtype=float)


def frame_true_xy(frame: dict) -> tuple[float, float]:
    """Camera position of a frame in the analysis CRS: WS3's drive-end lon/lat (``position_source``
    says whether it is co-registered) plus the camera offset (site frame N, E, Down)."""
    x, y = dr.lonlat_to_xy(float(frame["lon"]), float(frame["lat"]))
    n, e = (frame.get("camera_offset_site_ned_m") or [0.0, 0.0, 0.0])[:2]
    return float(x) + float(e), float(y) + float(n)


def load_engine(log=print):
    """WS3 horizon engine over the canonical bands (``skyline_band_paths``)."""
    from pipeline.horizon.rays import DemBand, HorizonEngine  # noqa: PLC0415

    log("F22: loading DEM bands for the horizon engine")
    return HorizonEngine([DemBand.from_geotiff(p, src)
                          for src, p in skyline_band_paths(dr.REPO).items()])


def skyline_real(frames: list[dict], *, engine=None, log=print) -> list[dict]:
    """F22 on every paired frame (failures reported, never dropped). True position =
    ``frame_true_xy``; prior per ``skyline_prior`` (standalone)."""
    from PIL import Image  # noqa: PLC0415

    from pipeline.navigation import skylinefix as sf  # noqa: PLC0415

    if _rcfg()["skyline_prior"] != "standalone":
        raise ValueError("only skyline_prior: standalone is implemented")
    engine = load_engine(log) if engine is None else engine
    rng = np.random.default_rng(int(dr.load_config()["monte_carlo"]["seed"]))
    rows = []
    for fr in frames:
        base = {"image_id": fr["image_id"], "station": fr.get("station"),
                "stop_id": fr.get("stop_id"), "position_source": fr.get("position_source")}
        p = dr.REPO / fr.get("local_path", "")
        try:
            if not fr.get("local_path") or not p.exists():
                raise ValueError(f"frame not cached ({fr.get('local_path')})")
            img = np.asarray(Image.open(p).convert("L"))
            az, el = observe_frame(fr, img)
            true_xy = frame_true_xy(fr)
            prior = sf.standalone_prior(true_xy, rng)
            res = sf.locate(engine, az, el, prior)
            rec = sf.localisation_record(res, true_xy)
            rows.append({**base, "status": "ok", "n_columns": int(az.size), **rec})
            log(f"F22 {fr['image_id']}: error {rec['error_m']} m, RMS {rec['rms_deg']} deg")
        except Exception as exc:  # report, never hide (AGENTS rule 7)
            rows.append({**base, "status": "failed", "reason": f"{type(exc).__name__}: {exc}",
                         "error_m": None})
            log(f"F22 {fr['image_id']}: FAILED {type(exc).__name__}: {exc}")
    return rows


def pick_station_fixes(rows: list[dict]) -> dict:
    """One skyline result per station: the lowest-RMS ok frame (``skyline_frame_pick``)."""
    if _rcfg()["skyline_frame_pick"] != "min_rms":
        raise ValueError("only skyline_frame_pick: min_rms is implemented")
    best: dict = {}
    for r in rows:
        if r["status"] != "ok" or not r.get("station"):
            continue
        cur = best.get(r["station"])
        if cur is None or r["rms_deg"] < cur["rms_deg"]:
            best[r["station"]] = r
    return best


def skyline_gate_tolerance_m() -> float:
    """F22 KAT tolerance (nav.yaml ``real_run_ws9.skyline_fix_gate.tolerance_from``)."""
    src = _rcfg()["skyline_fix_gate"]["tolerance_from"]
    if src != "skyline_fix.refine_grid_m":
        raise ValueError(f"nav.yaml skyline_fix_gate.tolerance_from {src!r} not supported")
    return float(dr.load_config()["skyline_fix"]["refine_grid_m"])


def gate_skyline_fixes(best: dict) -> tuple[dict, dict]:
    """C 11:58: a station's (lowest-RMS) skyline result becomes a position fix only if its error
    is within the F22 KAT tolerance. Returns (passed, rejected); rejected rows carry the reason
    (the surveyed station fix is kept for them)."""
    tol = skyline_gate_tolerance_m()
    passed, rejected = {}, {}
    for st, r in best.items():
        if r.get("error_m") is not None and float(r["error_m"]) <= tol:
            passed[st] = r
        else:
            rejected[st] = {"image_id": r["image_id"], "error_m": r.get("error_m"),
                            "rms_deg": r.get("rms_deg"), "tolerance_m": tol,
                            "reason": f"error {r.get('error_m')} m > F22 KAT tolerance {tol:g} m; "
                                      f"station fix kept"}
    return passed, rejected


def station_frame_summary(rows: list[dict]) -> list[dict]:
    """Every station-tagged frame tried, with its result and the gate verdict (failures too)."""
    tol = skyline_gate_tolerance_m()
    out = []
    for r in rows:
        if not r.get("station"):
            continue
        ok = r["status"] == "ok"
        out.append({"station": r["station"], "image_id": r["image_id"], "status": r["status"],
                    "error_m": r.get("error_m"), "rms_deg": r.get("rms_deg") if ok else None,
                    "sigma_m": r.get("sigma_m") if ok else None,
                    "reason": r.get("reason"), "tolerance_m": tol,
                    "passes_gate": bool(ok and r.get("error_m") is not None
                                        and float(r["error_m"]) <= tol)})
    return out


# --------------------------------------------------------------------------------------------
# Fix-interval map on the real T_home field
# --------------------------------------------------------------------------------------------

def read_t_home(path):
    """T_home (min, NaN unknown), resolution (m) and the affine transform."""
    import rasterio  # noqa: PLC0415

    with rasterio.open(path) as ds:
        _check_crs(ds, path)
        t = ds.transform
        if t.b != 0 or t.d != 0 or t.a <= 0 or t.e >= 0 or not math.isclose(t.a, -t.e):
            raise ValueError(f"{path}: not a north-up raster with square pixels")
        a = ds.read(1).astype(float)
        if ds.nodata is not None and not np.isnan(ds.nodata):
            a[a == ds.nodata] = np.nan
    return a, float(t.a), t


def field_grid() -> dict:
    """HUD field grid (nav.yaml ``real_run_ws9.field_grid``): pad +/- planning_radius_m at
    hud.yaml ``field_png.res_m``, north-up in the analysis CRS; lon/lat bounds [w, s, e, n]."""
    res = float(dr._yaml("hud")["field_png"]["res_m"])
    half = float(dr.site_config()["planning_radius_m"])
    px, py = dr.pad_xy()
    n = int(round(2 * half / res))
    x0, y1 = px - half, py + half
    w, s = dr.xy_to_lonlat(x0, y1 - n * res)
    e, nn = dr.xy_to_lonlat(x0 + n * res, y1)
    return {"x0": x0, "y1": y1, "res_m": res, "width": n, "height": n,
            "bounds": [round(float(v), 6) for v in (w, s, e, nn)]}


def resample_nearest(a, src_transform, grid: dict) -> np.ndarray:
    """Nearest-neighbour sample of raster ``a`` (affine ``src_transform``, north-up) at the
    centres of ``grid`` cells; NaN off the source raster."""
    res = grid["res_m"]
    xs = grid["x0"] + res * (np.arange(grid["width"]) + 0.5)
    ys = grid["y1"] - res * (np.arange(grid["height"]) + 0.5)
    c = np.floor((xs - src_transform.c) / src_transform.a).astype(int)
    r = np.floor((ys - src_transform.f) / src_transform.e).astype(int)
    okc = (c >= 0) & (c < a.shape[1])
    okr = (r >= 0) & (r < a.shape[0])
    out = np.full((grid["height"], grid["width"]), np.nan)
    sub = a[np.clip(r, 0, a.shape[0] - 1)][:, np.clip(c, 0, a.shape[1] - 1)]
    m = okr[:, None] & okc[None, :]
    out[m] = sub[m]
    return out


def field_entry(set_name: str, scenario: str) -> dict:
    """``fields/index.json`` entry for ``fix_interval_{set}`` (contracts/fields_index)."""
    pc = dr._yaml("hud")["field_scales"]["fix_interval"]
    return {"file": fi.png_path(set_name), "scale": pc["per_count"], "units": pc["units"],
            "scenario": scenario}


# --------------------------------------------------------------------------------------------
# Provenance
# --------------------------------------------------------------------------------------------

def clear_fragments(fragment_dir=None, names=F21_FRAGMENTS) -> list[Path]:
    """Remove WS9's own manifest fragments so a re-run leaves no stale keys."""
    from pipeline.provenance.manifest import _fragment_dir  # noqa: PLC0415

    d = _fragment_dir(fragment_dir)
    gone = []
    for name in names:
        p = d / f"pipeline__navigation__{name}.json"
        if p.exists():
            p.unlink()
            gone.append(p)
    return gone


# --------------------------------------------------------------------------------------------
# F22 run (all frames, standalone prior): python -m pipeline.navigation.run skyline
# --------------------------------------------------------------------------------------------

def skyline_run(*, out=REAL_OUT, interim: Path = INTERIM, record: bool | None = None,
                fragment_dir=None, engine=None, limit: int | None = None, log=print) -> dict:
    """F22 on every frame of WS3's navcam_frames.json (SPEC F22: report every frame tried,
    failures included). Writes ``localisation/{image_id}.json`` for each recovered frame and
    ``skyline_report.json`` with every row; the F21 run reads the report for fix events."""
    from pipeline.navigation import skylinefix as sf  # noqa: PLC0415

    out = Path(out).resolve()
    record = (out == REAL_OUT.resolve()) if record is None else record
    fj = interim / "horizon" / "navcam_frames.json"
    if not fj.exists():
        raise SystemExit(f"F22 refused: {fj} missing (owner WS3)")
    frames = json.loads(fj.read_text()).get("frames", [])[:limit]
    shutil.rmtree(out / "localisation", ignore_errors=True)
    if record:
        clear_fragments(fragment_dir, F22_FRAGMENTS)
    rows = skyline_real(frames, engine=engine, log=log)
    for r in rows:
        if r["status"] != "ok":
            continue
        rec = {k: r[k] for k in ("true", "recovered", "error_m", "rms_deg",
                                 "candidates_evaluated", "sigma_m", "prior", "prior_offset_m")}
        dp = f"localisation/{r['image_id']}.json"
        sf.write_json(rec, out / dp)
        if record:
            sf.record_manifest(rec, r["image_id"], dp, fragment_dir=fragment_dir)
    ok = [r["error_m"] for r in rows if r["status"] == "ok"]
    rep = {"frames_json": str(fj), "n_frames": len(rows), "n_ok": len(ok),
           "n_failed": len(rows) - len(ok),
           "error_m_median": float(np.median(ok)) if ok else None,
           "error_m_p25_p75": ([float(v) for v in np.percentile(ok, [25, 75])] if ok else None),
           "n_within_tolerance": sum(e <= skyline_gate_tolerance_m() for e in ok),
           "tolerance_m": skyline_gate_tolerance_m(),
           "station_frames": station_frame_summary(rows),
           "prior": _rcfg()["skyline_prior"], "rows": rows, "manifest_recorded": bool(record)}
    (out).mkdir(parents=True, exist_ok=True)
    (out / SKYLINE_REPORT).write_text(json.dumps(rep, indent=1, default=str))
    log(f"F22: {len(ok)}/{len(rows)} frames recovered; median error "
        f"{rep['error_m_median']} m")
    return rep


# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

def run(scenario: str | None = None, *, out=REAL_OUT, interim: Path = INTERIM, sets=None,
        runs: int | None = None, skyline: bool = True, record: bool | None = None,
        fragment_dir=None, engine=None, log=print) -> dict:
    """Full real run. Refuses when ``dry_run`` lists a problem. ``record`` defaults to True only
    for the default output directory (manifest keys describe the files ``make web`` copies)."""
    sc = scenario or default_scenario()
    out = Path(out).resolve()
    public = (dr.REPO / "web" / "public").resolve()
    if out == public or public in out.parents:
        raise ValueError("WS9 writes to data/interim/; make web copies to web/public/data/")
    # F22 inputs are needed only when the skyline report has to be computed first
    need_f22 = skyline and not (out / SKYLINE_REPORT).exists()
    rep = dry_run(sc, interim=interim, skyline=need_f22, log=log)
    if rep["problems"]:
        raise SystemExit("WS9 real run refused: missing or invalid inputs (see above)")
    record = (out == REAL_OUT.resolve()) if record is None else record
    cfg = dr.load_config()
    sets = list(cfg["sets"]) if sets is None else list(sets)
    default_set = str(cfg["default_set"])
    by = {i.name: i.path for i in inputs(sc, interim=interim, skyline=need_f22)}

    for sub in SUBDIRS:
        shutil.rmtree(out / sub, ignore_errors=True)
    if record:
        clear_fragments(fragment_dir)

    route = json.loads(by["route"].read_text())
    timeline = json.loads(by["timeline"].read_text())
    traj, tinfo = route_trajectory(route, slope_path=by["slope"], label=f"route_{sc}")
    log(f"trajectory: {traj.t_s[-1] / 60:.2f} min, {traj.distance_m[-1]:.0f} m, "
        f"slope unknown on {100 * (tinfo['slope_unknown_frac'] or 0):.1f}% of steps")

    report = {"scenario": sc, "sets": sets, "trajectory": {
        "duration_min": round(float(traj.t_s[-1] / 60.0), 3),
        "distance_m": round(float(traj.distance_m[-1]), 1), **tinfo},
        "skyline": None, "fix_interval": {}, "written": []}
    written: list[Path] = []

    # F22 results (skyline_run) become fix events at paired stations
    sky_best: dict = {}
    if skyline:
        rp = out / SKYLINE_REPORT
        if not rp.exists():
            skyline_run(out=out, interim=interim, record=record, fragment_dir=fragment_dir,
                        engine=engine, log=log)
        sky = json.loads(rp.read_text())
        stations = [f.station for f in fixes_from_timeline(timeline) if f.station]
        paired = paired_frames(sky["rows"], stations)
        sky_best, rejected = gate_skyline_fixes(pick_station_fixes(paired))
        report["skyline"] = {"report": SKYLINE_REPORT, "n_frames": sky["n_frames"],
                             "n_ok": sky["n_ok"],
                             "used": {st: r["image_id"] for st, r in sky_best.items()},
                             "rejected": rejected,
                             "station_frames": station_frame_summary(paired),
                             "stations_without_frame": sorted(
                                 set(stations) - {r["station"] for r in paired})}

    fixes = fixes_from_timeline(timeline, skyline=sky_best)
    written.append(mc.write_json(mc.fixes_json(fixes), out / "nav" / "fixes.json"))
    if record:
        mc.record_fixes_manifest(fixes, "nav/fixes.json", fragment_dir=fragment_dir)

    t_home, res_m, t_transform = read_t_home(by["t_home"])
    grid = field_grid()
    fields = {}
    for name in sets:
        p = dr.NavParams.from_config(name)
        res = dr.simulate(traj, p, runs=runs, fixes=fixes)
        summ = mc.summarise(res, p)
        summ["scenario"] = sc
        dp = f"nav/montecarlo_{name}.json"
        written.append(mc.write_json(summ, out / dp))
        written.append(mc.write_json(mc.tracks_geojson(res, p),
                                     out / f"nav/tracks_{name}.geojson"))
        if record:
            mc.record_manifest(summ, dp, fragment_dir=fragment_dir)

        d_max = fi.fix_interval(t_home, res_m, summ["r95_fit"])
        fs = fi.summarise(d_max, t_home, name)
        fs["scenario"] = sc
        report["fix_interval"][name] = fs
        if name == default_set:
            written.append(fi.write_summary(fs, out / fi.SUMMARY_PATH))
            if record:
                fi.record_manifest(fs, fi.SUMMARY_PATH, fragment_dir=fragment_dir)
        written.append(fi.write_png(resample_nearest(d_max, t_transform, grid),
                                    out / fi.png_path(name)))
        fields[f"fix_interval_{name}"] = field_entry(name, sc)
        log(f"{name}: r95 fit a={summ['r95_fit']['a']:.4g} b={summ['r95_fit']['b']:.4g}; "
            f"D_max median {fs['median_m']} m, edge p10 {fs['edge_p10_m']} m")

    idx = {"bounds": grid["bounds"], "width": grid["width"], "height": grid["height"],
           "res_m": grid["res_m"], "fields": fields,
           "note": "fields/index.json entries for WS7's index (same grid as the HUD fields)"}
    (out / "fields_index_nav.json").write_text(json.dumps(idx, indent=1))
    report["written"] = [str(p.relative_to(out)) for p in written]
    report["manifest_recorded"] = bool(record)
    rp = out / "run_report.json"
    rp.write_text(json.dumps(report, indent=1, default=str))
    return report
