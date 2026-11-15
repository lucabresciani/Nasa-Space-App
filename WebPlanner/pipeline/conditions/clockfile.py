"""conditions/clock.json (F14; contracts/clock.schema.json, loose object, v1.0.0).

Content (units in every numeric key name):
* ``h0``: Mars24 record at H0 (event.yaml h0_utc) at Gale: LMST, LTST, Ls, Mars year, MSL sol,
  sun azimuth/elevation, light time;
* ``sols``: the local Gale sols overlapping the event weekend (config horizons.window_utc):
  MSL sol, Ls at local noon, flat-horizon sunrise/sunset (UTC and LMST);
* ``light_time``: one-way Earth-Mars light time from the cached JPL Horizons table
  (quantity 21, geocentre to Mars centre), linear between rows;
* ``site``: the sun is computed at the D21 official pad (``pad.json`` top-level ``pad``; falls
  back to ``site.yaml pad_default`` only if ``pad.json`` is missing, flagged ``pad_fallback``);
  LMST and sol numbers stay on the MSL label longitude (config clock.gale_lon_east_deg);
* ``eva``: the simulated EVA (config clock.eva_start_lmst_h on the sol of eva_sol_ref_utc,
  length crew.yaml eva_h): start/end, sun series, flat-horizon ``t_dark_min`` (minutes from EVA
  start to sunset) and per-observer ``t_dark_min_by_observer`` from the WS3 F12 horizons
  (``data/interim/horizon/horizons/*.json``; null = unknown).
WS2 reads ``eva.t_dark_min`` (or the observer's value) for the route-margin daylight term.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from pipeline.conditions import config, marstime, sun
from pipeline.conditions.config import (
    INTERIM,
    RAW,
    REPO,
    eva_min,
    fmt_utc,
    h0_utc,
    load_conditions,
    pad_site,
    parse_utc,
)

WEB_PATH = "conditions/clock.json"
HORIZON_DIR = INTERIM / "horizon" / "horizons"
HORIZONS_CACHE = "horizons/mars_lighttime.json"

# --------------------------------------------------------------------------- Horizons

_ROW = re.compile(r"^\s*(\d{4}-[A-Za-z]{3}-\d{2} \d{2}:\d{2})\s+(\S+)\s+(\S+)\s+(\S+)\s*$")


def parse_horizons(result: str) -> list[tuple[datetime, float]]:
    """(UTC, one-way light time in minutes) rows between $$SOE and $$EOE (quantities 20,21)."""
    if "$$SOE" not in result or "$$EOE" not in result:
        raise ValueError("Horizons result has no $$SOE/$$EOE table")
    head, body = result.split("$$SOE", 1)
    if "1-way_down_LT" not in head:
        raise ValueError("Horizons table has no 1-way_down_LT column")
    out = []
    for ln in body.split("$$EOE", 1)[0].splitlines():
        m = _ROW.match(ln)
        if m:
            t = datetime.strptime(m.group(1), "%Y-%b-%d %H:%M").replace(tzinfo=UTC)
            out.append((t, float(m.group(4))))
    if len(out) < 2:
        raise ValueError("Horizons table has fewer than 2 rows")
    return out


def light_time_at(t: datetime, table: list[tuple[datetime, float]]) -> float | None:
    """Linear interpolation in the table; None outside it."""
    for (a, la), (b, lb) in zip(table, table[1:], strict=False):
        if a <= t <= b:
            return la + (lb - la) * ((t - a) / (b - a))
    return None


def load_light_time() -> tuple[list[tuple[datetime, float]] | None, str | None]:
    idx_p = RAW / "index.json"
    idx = json.loads(idx_p.read_text()) if idx_p.exists() else {}
    if HORIZONS_CACHE not in idx:
        return None, None
    table = parse_horizons(json.loads((RAW / HORIZONS_CACHE).read_text())["result"])
    return table, idx[HORIZONS_CACHE]["fetched_utc"]


# --------------------------------------------------------------------------- pieces


def _r(x: float | None, nd: int = 4) -> float | None:
    return None if x is None else round(float(x), nd)


def instant(t: datetime, lat: float, lon: float, table, sun_lon: float) -> dict[str, Any]:
    """Clock at ``lon`` (LMST/LTST, sol), sun at (``lat``, ``sun_lon``)."""
    mt = marstime.mars_time(t)
    lm = marstime.lmst_h(t, lon)
    lt = marstime.ltst_h(t, lon)
    p = sun.sun_position(t, lat, sun_lon)
    return {
        "utc": fmt_utc(t), "msl_sol": marstime.msl_sol(t, lon), "lmst": marstime.format_hms(lm),
        "lmst_h": _r(lm, 5), "ltst": marstime.format_hms(lt), "ltst_h": _r(lt, 5),
        "ls_deg": _r(mt.ls_deg), "mars_year": mt.mars_year,
        "sun_azimuth_deg": _r(p.azimuth_deg, 3), "sun_elevation_deg": _r(p.elevation_deg, 3),
        "light_time_min": None if table is None else _r(light_time_at(t, table), 4),
    }


def weekend_sols(lat: float, lon: float, horizon_deg: float,
                 sun_lon: float) -> list[dict[str, Any]]:
    a, b = (parse_utc(x) for x in load_conditions()["horizons"]["window_utc"])
    out, seen = [], set()
    t = a
    while t <= b:
        sol = marstime.msl_sol(t, lon)
        if sol not in seen:
            seen.add(sol)
            noon = marstime.utc_at_lmst(t, 12.0, lon)
            ev = sun.sunrise_sunset(t, lat, sun_lon, horizon_deg)
            rec: dict[str, Any] = {
                "msl_sol": sol,
                "lmst_midnight_utc": fmt_utc(marstime.utc_at_lmst(t, 0.0, lon)),
                "ls_deg_at_noon": _r(marstime.mars_time(noon).ls_deg),
            }
            for k in ("sunrise", "sunset"):
                u = None if ev is None else ev[k]
                rec[f"{k}_utc"] = None if u is None else fmt_utc(u)
                rec[f"{k}_lmst"] = None if u is None else marstime.format_hms(
                    marstime.lmst_h(u, lon))
            out.append(rec)
        t += timedelta(hours=1)
    return out


def observer_profiles() -> dict[str, dict[str, Any]]:
    """WS3 F12 horizon profiles (contract horizon.schema.json), keyed by observer_id."""
    if not HORIZON_DIR.is_dir():
        return {}
    out = {}
    for f in sorted(HORIZON_DIR.glob("*.json")):
        prof = json.loads(f.read_text())
        if "observer_id" in prof and "elevation_deg" in prof and "az_step_deg" in prof:
            out[str(prof["observer_id"])] = prof
    return out


def observer_latlon(prof: dict[str, Any], default: tuple[float, float]) -> tuple[float, float]:
    """(lat, lon_east) of a WS3 observer from its ``meta`` (else ``default``, the pad)."""
    m = prof.get("meta") or {}
    if m.get("lat") is None or m.get("lon") is None:
        return default
    return float(m["lat"]), float(m["lon"])


def eva_block(lat: float, lon: float, horizon_deg: float, sun_lon: float,
              site_label: str) -> dict[str, Any]:
    """EVA clock at ``lon`` (LMST); sun at the pad (``lat``, ``sun_lon``)."""
    ck = load_conditions()["clock"]
    start = sun.eva_start_utc()
    length = eva_min()
    step = float(ck["sun_series_step_min"])
    series = []
    for k in range(int(math.floor(length / step)) + 1):
        t = start + timedelta(minutes=k * step)
        p = sun.sun_position(t, lat, sun_lon)
        series.append([_r(k * step, 3), _r(marstime.lmst_h(t, lon), 5), _r(p.azimuth_deg, 3),
                       _r(p.elevation_deg, 3)])
    flat = sun.t_dark_min(start, lat, sun_lon, horizon_deg=horizon_deg)
    by_obs = {}
    for oid, prof in observer_profiles().items():
        o_lat, o_lon = observer_latlon(prof, (lat, sun_lon))
        by_obs[oid] = _r(sun.t_dark_min(start, o_lat, o_lon, profile=prof), 2)
    return {
        "note": ("Simulated EVA (not a real plan): start = config clock.eva_start_lmst_h "
                 "(09:00 LMST, decided D31) at Gale on the local sol containing "
                 "clock.eva_sol_ref_utc (assumed); "
                 "length = crew.yaml eva_h"),
        "start_utc": fmt_utc(start),
        "start_lmst": marstime.format_hms(marstime.lmst_h(start, lon)),
        "msl_sol": marstime.msl_sol(start, lon),
        "end_utc": fmt_utc(start + timedelta(minutes=length)),
        "eva_min": length,
        "sunset_flat_utc": None if flat is None else fmt_utc(start + timedelta(minutes=flat)),
        "t_dark_min": _r(flat, 2),
        "t_dark_definition": (f"minutes from EVA start until the sun's centre is below a flat "
                              f"horizon at {horizon_deg} deg at the pad ({site_label})"),
        "t_dark_min_by_observer": by_obs,
        "t_dark_by_observer_definition": (
            "same, against the observer's F12 point horizon (WS3; nearest azimuth ray), "
            "sun at the observer's lon/lat (horizon meta); "
            "null = horizon unknown toward the sun; empty = no WS3 horizons yet"),
        "sun_series_columns": ["t_eva_min", "lmst_h", "sun_azimuth_deg", "sun_elevation_deg"],
        "sun_series": series,
    }


def build_clock(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or load_conditions()
    ck = cfg["clock"]
    pad = pad_site()
    lat, sun_lon = pad["lat"], pad["lon"]
    lon = float(ck["gale_lon_east_deg"])
    if pad["fallback"]:
        print(f"clock: WARNING {pad['note']}")
    hz = float(ck["sun_horizon_elevation_deg"])
    table, fetched = load_light_time()
    out = {
        "algorithm": ck["algorithm"],
        "site": {"lat_deg": lat, "lon_east_deg": lon, "sun_lon_east_deg": sun_lon,
                 "pad_id": pad["id"], "pad_source": pad["source"],
                 "pad_fallback": pad["fallback"], "pad_note": pad["note"],
                 "note": (f"LMST longitude {lon} E matches the MSL image labels "
                          "(docs/discovery.md §4.5); the sun (sunrise, sunset, t_dark, sun "
                          f"series) is at lat_deg, sun_lon_east_deg = {pad['source']}"),
                 "sun_horizon_elevation_deg": hz},
        "h0": instant(h0_utc(), lat, lon, table, sun_lon),
        "sols": weekend_sols(lat, lon, hz, sun_lon),
        "light_time": {
            "source": ("JPL Horizons API, Earth geocentre to Mars centre, one-way down-leg "
                       "light time (quantity 21); linear between rows"),
            "fetched_utc": fetched,
            "columns": ["utc", "light_time_min"],
            "rows": [] if table is None else [[fmt_utc(t), v] for t, v in table],
        },
        "eva": eva_block(lat, lon, hz, sun_lon, pad["source"]),
    }
    validate(out)
    return out


def validate(obj: dict[str, Any]) -> None:
    schema = json.loads((REPO / "contracts" / "clock.schema.json").read_text())
    Draft202012Validator(schema).validate(obj)


_MANIFEST = (
    ("site.lat_deg", "deg"), ("site.sun_lon_east_deg", "deg"), ("site.lon_east_deg", "deg"),
    ("site.pad_fallback", None),
    ("h0.utc", None), ("h0.msl_sol", "sol"), ("h0.lmst", None), ("h0.ltst", None),
    ("h0.ls_deg", "deg"), ("h0.mars_year", "MY"), ("h0.sun_azimuth_deg", "deg"),
    ("h0.sun_elevation_deg", "deg"), ("h0.light_time_min", "min"),
    ("eva.start_utc", None), ("eva.start_lmst", None), ("eva.end_utc", None),
    ("eva.eva_min", "min"), ("eva.t_dark_min", "min"), ("eva.sunset_flat_utc", None),
)


def write_clock(obj: dict[str, Any], out_dir: Path | None = None, *,
                fragment_dir: Path | None = None) -> Path:
    from pipeline.provenance import manifest

    validate(obj)
    config.reset_manifest_fragment(__file__, fragment_dir)
    path = (out_dir or INTERIM) / WEB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(obj, indent=1, allow_nan=False) + "\n").encode()
    path.write_bytes(data)

    def rec(key: str, v: Any, units: str | None) -> None:
        manifest.record(f"clock.{key}", v, units, WEB_PATH, __file__, fragment_dir=fragment_dir)

    for key, units in _MANIFEST:
        a, b = key.split(".")
        rec(key, obj[a][b], units)
    for i, s in enumerate(obj["sols"]):
        rec(f"sols.{i}.msl_sol", s["msl_sol"], "sol")
        for k in ("sunrise_lmst", "sunset_lmst", "sunrise_utc", "sunset_utc"):
            rec(f"sols.{i}.{k}", s[k], None)
        rec(f"sols.{i}.ls_deg_at_noon", s["ls_deg_at_noon"], "deg")
    for oid, v in obj["eva"]["t_dark_min_by_observer"].items():
        rec(f"eva.t_dark_min_by_observer.{oid}", v, "min")
    for i, (_, v) in enumerate(obj["light_time"]["rows"]):
        rec(f"light_time.rows.{i}.light_time_min", v, "min")
    rec("eva.sun_series", obj["eva"]["sun_series"], "min, h, deg, deg (sun_series_columns)")
    manifest.record(f"file_sha256.{WEB_PATH}", hashlib.sha256(data).hexdigest(), None,
                    WEB_PATH, __file__, fragment_dir=fragment_dir)
    return path
