"""REMS same-season climatology and the stale outreach feed (F14; contracts/rems.schema.json).

Climatology: PDS ``mslrem_1001`` MODRDR (``RMD``, best-estimate environment, 1-Hz rows) for the
sols of config ``rems.pds_mars_years`` whose Ls is in ``rems.ls_window_deg``. The full tables are
~12 MB per sol (discovery.md §4.2), so fetch.py reads ``rems.pds_rows_per_sol`` rows spread
evenly over each table with one multi-range HTTP request. Per sol, the daily minimum and maximum
are the extremes of those rows (missing = -999); a sol counts only if its valid rows cover at
least ``rems.pds_min_lmst_coverage_h`` distinct LMST hours. Statistics over sols: median, p10, p90.
Because the extremes come from a row sample, they can understate the 1-Hz extremes slightly.
Confidence-level columns are not interpreted (not applied). Variables = config
``rems.variables``: air temperature and pressure only (D37, config ``rems.dropped``).

Feed: the outreach JSON (``rems.feed_url``) stopped at sol 4995 / 2026-08-25 (config
``rems.feed_stale_since``). Its latest sol is shown, marked stale; it is never presented as
current (brief WS4 "Don't").
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import statistics
from datetime import date, datetime
from pathlib import Path
from typing import Any

from pipeline.conditions.config import (
    INTERIM,
    RAW,
    REPO,
    fmt_utc,
    load_conditions,
    reset_manifest_fragment,
)

WEB_PATH = "conditions/rems.json"
DEFAULT_OUT = INTERIM / WEB_PATH
SCHEMA_PATH = REPO / "contracts" / "rems.schema.json"

MISSING = -999.0
N_COLUMNS = 40  # LABEL/MODRDR6.FMT (discovery.md §4.2)
# config rems.variables name -> (0-based MODRDR column (MODRDR6.FMT order), name shown, units,
# K->degC?). D37: air temperature and pressure only (ground temperature, column 7, and UV,
# column 20, are not offered).
VARIABLES = {
    "air_temperature": (15, "air temperature (REMS AMBIENT_TEMP)", "degC", True),
    "pressure": (37, "pressure (REMS PRESSURE)", "Pa", False),
}
# feed field per (variable, 0 = daily min / 1 = daily max), for the cross-check
_FEED_CROSS = {("air_temperature", 1): "max_temp", ("air_temperature", 0): "min_temp"}


def columns(cfg: dict[str, Any] | None = None) -> dict[int, tuple[str, str, bool]]:
    """{MODRDR column: (name shown, units, K->degC?)} for config ``rems.variables``, in order."""
    names = (cfg or load_conditions())["rems"]["variables"]
    unknown = [n for n in names if n not in VARIABLES]
    if unknown:
        raise NotImplementedError(f"config rems.variables {unknown} not implemented in rems.py")
    return {VARIABLES[n][0]: VARIABLES[n][1:] for n in names}


def crosscheck_fields(cfg: dict[str, Any] | None = None) -> dict[tuple[int, int], str]:
    """{(MODRDR column, 0 min / 1 max): feed field} for the configured variables."""
    names = (cfg or load_conditions())["rems"]["variables"]
    return {(VARIABLES[n][0], k): f for (n, k), f in _FEED_CROSS.items() if n in names}
LMST_COL = 1  # "SSSSSMhh:mm:ss.sss"
KELVIN_0C = 273.15  # definition of the Celsius scale

_PART = re.compile(
    rb"Content-range:\s*bytes\s+(\d+)-(\d+)/(\d+)\r?\n\r?\n(.*?)\r?\n--", re.S | re.I)


def parse_multipart_rows(body: bytes, row_bytes: int) -> list[list[str]]:
    """Rows (as CSV fields) from a multipart/byteranges response of whole fixed-width rows."""
    rows = []
    for m in _PART.finditer(body):
        a, b = int(m.group(1)), int(m.group(2))
        if a % row_bytes or (b + 1 - a) != row_bytes:
            raise ValueError(f"range {a}-{b} is not one {row_bytes}-byte row")
        line = m.group(4).decode("ascii", errors="strict").strip()
        fields = next(csv.reader([line]))
        if len(fields) != N_COLUMNS:
            raise ValueError(f"MODRDR row has {len(fields)} fields, expected {N_COLUMNS}")
        rows.append(fields)
    return rows


def _val(s: str) -> float | None:
    try:
        x = float(s)
    except ValueError:
        return None
    return None if x <= MISSING + 0.5 else x


def sol_extremes(rows: list[list[str]], min_hours: int,
                 cols: dict[int, tuple[str, str, bool]] | None = None,
                 ) -> dict[int, tuple[float, float] | None]:
    """{column: (daily min, daily max)} for one sol; None when coverage is too thin."""
    out: dict[int, tuple[float, float] | None] = {}
    for col, (_, _, k2c) in (cols if cols is not None else columns()).items():
        vals, hours = [], set()
        for r in rows:
            v = _val(r[col])
            if v is None:
                continue
            vals.append(v - KELVIN_0C if k2c else v)
            m = re.search(r"M(\d\d):", r[LMST_COL])
            if m:
                hours.add(int(m.group(1)))
        out[col] = (min(vals), max(vals)) if vals and len(hours) >= min_hours else None
    return out


def _pct(xs: list[float], p: float) -> float:
    """Percentile with linear interpolation between order statistics (numpy 'linear')."""
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def _stats(xs: list[float], nd: int) -> dict[str, float | None]:
    if not xs:
        return {"median": None, "p10": None, "p90": None}
    return {"median": round(statistics.median(xs), nd), "p10": round(_pct(xs, 10), nd),
            "p90": round(_pct(xs, 90), nd)}


def climatology(index: dict[str, Any], cfg: dict[str, Any],
                feed: dict[str, Any] | None = None) -> dict[str, Any]:
    rc = cfg["rems"]
    min_h = int(rc["pds_min_lmst_coverage_h"])
    cols = columns(cfg)
    cross_f = crosscheck_fields(cfg)
    per_col: dict[int, tuple[list[float], list[float]]] = {c: ([], []) for c in cols}
    sols, used, years = [], set(), set()
    fsol = {int(s["sol"]): s for s in (feed or {}).get("soles", []) if str(s.get("sol")).isdigit()}
    diffs: dict[str, list[float]] = {v: [] for v in cross_f.values()}
    for name, meta in sorted(index.items()):
        if not name.startswith("rems/pds_rmd/"):
            continue
        if meta.get("mars_year") not in rc["pds_mars_years"]:
            continue
        rows = parse_multipart_rows((RAW / name).read_bytes(), int(meta["row_bytes"]))
        ext = sol_extremes(rows, min_h, cols)
        sols.append(meta["sol"])
        f = fsol.get(int(meta["sol"]))
        for (c, k), fk in cross_f.items():
            e = ext.get(c)
            try:
                fv = float(f[fk]) if f else None
            except (TypeError, ValueError):
                fv = None
            if e is not None and fv is not None:
                diffs[fk].append(e[k] - fv)
        for c, e in ext.items():
            if e is not None:
                per_col[c][0].append(e[0])
                per_col[c][1].append(e[1])
                used.add(meta["sol"])
                years.add(int(meta["mars_year"]))
    variables = []
    for c, (name, units, _) in cols.items():
        mins, maxs = per_col[c]
        nd = 1
        variables.append({"name": name, "units": units, "n_sols": len(mins),
                          "daily_min": _stats(mins, nd), "daily_max": _stats(maxs, nd)})
    cross = {f"{fk}_degC": {"n_sols": len(x),
                            "median_diff_degC": round(statistics.median(x), 1) if x else None}
             for fk, x in diffs.items()}
    return {"variables": variables, "sols_fetched": len(sols), "sols_used": len(used),
            "mars_years": sorted(years), "feed_crosscheck": cross}


# feed fields shown (air temperature, pressure, Ls); its ground temperature and UV are not (D37)
_FEED_NUM = {"min_temp": "min_temp_degC", "max_temp": "max_temp_degC", "pressure": "pressure_Pa",
             "ls": "ls_deg"}
_FEED_STR = ("atmo_opacity", "sunrise", "sunset", "season")  # feed UV index not shown (D37)


def latest_feed(feed: dict[str, Any], cfg: dict[str, Any], build_utc: datetime) -> dict[str, Any]:
    soles = [s for s in feed.get("soles", []) if str(s.get("sol", "")).isdigit()]
    if not soles:
        return {"sol": None, "terrestrial_date": None, "stale": True,
                "stale_since": cfg["rems"]["feed_stale_since"], "values": {}}
    s = max(soles, key=lambda r: int(r["sol"]))
    d = date.fromisoformat(s["terrestrial_date"])
    age = (build_utc.date() - d).days
    # config rems.feed_stale_since: the feed stopped there; any later entry would be news
    stale = d <= date.fromisoformat(str(cfg["rems"]["feed_stale_since"]))
    values: dict[str, Any] = {}
    for k, out_k in _FEED_NUM.items():
        try:
            values[out_k] = float(s.get(k))
        except (TypeError, ValueError):
            values[out_k] = None
    for k in _FEED_STR:
        v = s.get(k)
        values[k] = None if v in (None, "--", "") else str(v)
    return {"sol": int(s["sol"]), "terrestrial_date": d.isoformat(), "stale": stale,
            "stale_since": d.isoformat() if stale else None, "age_days": age, "values": values,
            "label": f"stale since {d:%d %b %Y}" if stale else "newer than config says: check",
            "note": "outreach feed, not current; shown for context only"}


def build_rems(cfg: dict[str, Any], build_utc: datetime) -> dict[str, Any]:
    idx = json.loads((RAW / "index.json").read_text())
    feed = json.loads((RAW / "rems/feed_msl_weather.json").read_text())
    clim = climatology(idx, cfg, feed)
    lf = latest_feed(feed, cfg, build_utc)
    if lf["stale_since"] != cfg["rems"]["feed_stale_since"]:
        lf["note"] += (f"; feed ends {lf['terrestrial_date']}, config rems.feed_stale_since says "
                       f"{cfg['rems']['feed_stale_since']}")
    rc = cfg["rems"]
    out = {
        "source": "PDS mslrem_1001 MODRDR (RMD), row sample",
        "ls_window_deg": list(rc["ls_window_deg"]),
        "sols_used": clim["sols_used"],
        "mars_years": clim["mars_years"],
        "variables": clim["variables"],
        "latest_feed": lf,
        "method": (
            f"{rc['pds_rows_per_sol']} rows per sol spread evenly over the 1-Hz MODRDR table; "
            f"daily min/max = extremes of the valid rows (sol kept if they cover >= "
            f"{rc['pds_min_lmst_coverage_h']} LMST hours); median, p10, p90 over sols; confidence "
            "flags not applied; extremes may understate the 1-Hz values slightly"),
        "sols_fetched": clim["sols_fetched"],
        "feed_crosscheck": {
            "note": "same sols: sampled PDS extreme minus the outreach feed's daily value",
            **clim["feed_crosscheck"]},
        "build_utc": fmt_utc(build_utc),
    }
    validate(out)
    return out


def validate(obj: dict[str, Any]) -> None:
    from jsonschema import Draft202012Validator, FormatChecker  # noqa: PLC0415

    schema = json.loads(SCHEMA_PATH.read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(obj)


def write_rems(obj: dict[str, Any], out_path: Path | None = None, *,
               fragment_dir: Path | None = None) -> Path:
    from pipeline.provenance import manifest  # noqa: PLC0415

    validate(obj)
    reset_manifest_fragment(__file__, fragment_dir)
    path = out_path or DEFAULT_OUT
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(obj, indent=1, allow_nan=False) + "\n").encode()
    path.write_bytes(data)
    rec = manifest.record
    for i, v in enumerate(obj["variables"]):
        for part in ("daily_min", "daily_max"):
            for st in ("median", "p10", "p90"):
                rec(f"rems.variables.{i}.{part}.{st}", v[part][st], v["units"],
                    WEB_PATH, __file__, fragment_dir=fragment_dir)
    rec("rems.sols_used", obj["sols_used"], "sol", WEB_PATH, __file__,
        fragment_dir=fragment_dir)
    lf = obj["latest_feed"]
    rec("rems.latest_feed.sol", lf["sol"], None, WEB_PATH, __file__,
        fragment_dir=fragment_dir)
    rec("rems.latest_feed.stale_since", lf["stale_since"], None, WEB_PATH, __file__,
        fragment_dir=fragment_dir)
    rec(f"file_sha256.{WEB_PATH}", hashlib.sha256(data).hexdigest(), None, WEB_PATH, __file__,
        fragment_dir=fragment_dir)
    return path
