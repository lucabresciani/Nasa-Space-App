"""RAD dose rates: CDAS parser, 20 May 2024 storm numbers, rad.json (F14; contract rad.schema).

Input: the CDAS REST ``format=text`` listing of config ``rad.dataset`` / ``rad.dose_variable``
(column ``rad.dose_component``), cached by ``fetch.py`` (docs/discovery.md §4.1: RAD L2 is not
on HAPI). Units come from the listing's unit row; fill (-1e31) and non-finite values are None.

Method (config ``rad``; each rule string is checked against what is implemented here):
* sample duration = gap to the next record, capped at the median spacing; the last record
  repeats the one before (``sample_duration``; cadence ~17 min, ~8 min in storms);
* each sample sits at the midpoint of its integration (``time_tag`` says where the tag sits);
* baseline = median of the samples in the 7 days before the storm window (``baseline``);
* peak = the largest sample in the storm window;
* onset / end = baseline crossings either side of the peak, linear between sample midpoints;
  if the rate is still above baseline at the storm-window end, the event ends at the last
  midpoint in the window, provided the data reach within two median spacings of the window end;
  otherwise the end and the excess are unknown (``event_bounds``);
* excess = integral of (rate - baseline) from onset to end, linear between sample midpoints
  (``interpolation``), in mGy; dose equivalent = excess x Q with Q = 1 (never 3 for the SEP);
* the excess is a lower bound when the event is still above baseline at the window end
  (``excess_bound``, D36); the end-of-window rate is the last valid sample in the window,
  reported against the baseline (``end_of_window_rate``, D36);
* tripwire time "± h": h = half the median sample duration, the shift if the time tag marked
  the sample centre instead of its start (``tripwire_time_halfwidth``, D35); label in whole
  minutes, rounded half up (``tripwire_time_halfwidth_display``);
* tripwire and leash: tripwire.py.
Labels (D34): the dose column is shown as ``dose_component_label`` with ``dose_component_status``.
Unknown stays unknown: anything that cannot be computed is None.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import statistics
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from pipeline.conditions import tripwire
from pipeline.conditions.config import (
    INTERIM,
    REPO,
    fmt_utc,
    load_conditions,
    parse_utc,
    require,
    reset_manifest_fragment,
)

SCHEMA_PATH = REPO / "contracts" / "rad.schema.json"
WEB_PATH = "conditions/rad.json"  # path under web/public/data/ (make web copies it)

INTERPOLATION = "linear between sample midpoints"
SAMPLE_DURATION = ("gap to the next record, capped at the median spacing; the last record "
                   "repeats the one before")
EVENT_BOUNDS = ("baseline crossings either side of the peak; the storm-window end if still "
                "above baseline")
EXCESS_BOUND = "lower bound if the event is still above baseline at the storm-window end"
END_OF_WINDOW_RATE = "last valid sample in the storm window, vs baseline"
HALFWIDTH = "half the median sample duration"
HALFWIDTH_DISPLAY = "whole minutes, rounded half up"
TIME_TAGS = {"start": 0.5, "center": 0.0, "end": -0.5}  # midpoint = tag + k * duration
CDAS_FILL = -1.0e31  # docs/discovery.md §4.1

_DOSE = {"ugy": 1.0, "microgy": 1.0, "mgy": 1000.0, "gy": 1.0e6}
_PER = {"day": 1.0, "d": 1.0, "h": 24.0, "hr": 24.0, "hour": 24.0, "min": 1440.0, "s": 86400.0}


class UnitsError(ValueError):
    """Dose-rate units that cannot be converted to uGy/day."""


def to_ugy_day_factor(units: str | None) -> float:
    """Multiplier converting a dose rate in ``units`` to uGy/day."""
    if not isinstance(units, str):
        raise UnitsError(f"dose-rate units missing: {units!r}")
    u = units.strip().lower().replace("µ", "u").replace("μ", "u").replace(" ", "")
    u = re.sub(r"_?\([^)]*\)$", "", u).replace("gray", "gy")  # "uGray/day_(good_Q)"
    m = re.fullmatch(r"([a-z]+)/([a-z]+)", u)
    if not m or m.group(1) not in _DOSE or m.group(2) not in _PER:
        raise UnitsError(f"cannot convert dose-rate units {units!r} to uGy/day")
    return _DOSE[m.group(1)] * _PER[m.group(2)]


# --------------------------------------------------------------------------- parsing


@dataclass(frozen=True)
class RadSeries:
    tag: list[datetime]  # record time tags as published (UTC)
    mid: list[datetime]  # sample midpoints (UTC)
    value: list[float | None]  # uGy/day; None = fill
    durations: list[timedelta]  # integration time per sample (sample_duration rule)
    median_spacing: timedelta
    component: str
    units_in: str


def _check_rule(value: Any, implemented: str, key: str) -> None:
    if str(value).strip() != implemented:
        raise NotImplementedError(f"config {key} = {value!r}; rad.py implements {implemented!r}")


def sample_durations(tags: list[datetime]) -> tuple[timedelta, list[timedelta]]:
    """(median spacing, per-record durations) by the config ``rad.sample_duration`` rule."""
    steps = [b - a for a, b in zip(tags, tags[1:], strict=False)]
    if not steps:
        raise ValueError("need at least 2 RAD records")
    if any(s <= timedelta(0) for s in steps):
        raise ValueError("RAD records are not in strictly increasing time order")
    med = timedelta(seconds=statistics.median(s.total_seconds() for s in steps))
    durs = [min(s, med) for s in steps]
    return med, durs + [durs[-1]]


def parse_cdas_text(text: str, component: str | None = None,
                    time_tag: str | None = None) -> RadSeries:
    """Parse a CDAS REST ``format=text`` listing (EPOCH + one column per dose component)."""
    cfg = load_conditions()["rad"]
    _check_rule(cfg["sample_duration"], SAMPLE_DURATION, "rad.sample_duration")
    comp = str(require(component if component is not None else cfg["dose_component"],
                       "rad.dose_component"))
    tag_rule = str(require(time_tag if time_tag is not None else cfg["time_tag"], "rad.time_tag"))
    if tag_rule not in TIME_TAGS:
        raise ValueError(f"time_tag must be one of {sorted(TIME_TAGS)}, got {tag_rule!r}")
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    if len(lines) < 4 or lines[0].split()[0] != "EPOCH":
        raise ValueError("not a CDAS text listing (no EPOCH header)")
    names = lines[0].split()[1:]
    units = lines[1].split()[2:]
    if comp not in names:
        raise KeyError(f"column {comp!r} not in CDAS columns {names}")
    if len(units) != len(names):
        raise ValueError("CDAS unit row does not match the column row")
    col = names.index(comp)
    factor = to_ugy_day_factor(units[col])
    tags: list[datetime] = []
    values: list[float | None] = []
    for ln in lines[2:]:
        tok = ln.split()
        if len(tok) != 2 + len(names):
            raise ValueError(f"unexpected CDAS row: {ln[:80]!r}")
        hms = tok[1].split(".")[0]
        tags.append(datetime.strptime(f"{tok[0]} {hms}", "%d-%m-%Y %H:%M:%S").replace(tzinfo=UTC))
        x = float(tok[2 + col])
        fill = not math.isfinite(x) or math.isclose(x, CDAS_FILL, rel_tol=1e-9)
        values.append(None if fill else x * factor)
    med, durs = sample_durations(tags)
    k = TIME_TAGS[tag_rule]
    return RadSeries(tag=tags, mid=[t + d * k for t, d in zip(tags, durs, strict=True)],
                     value=values, durations=durs, median_spacing=med, component=comp,
                     units_in=units[col])


def _window(s: RadSeries, a: datetime, b: datetime) -> list[int]:
    return [i for i, t in enumerate(s.mid) if a <= t < b]


def baseline_days(cfg: dict[str, Any]) -> int:
    rule = str(cfg["rad"]["baseline"]).strip()
    m = re.fullmatch(r"median of the (\d+) days before the storm window", rule)
    if not m:
        raise NotImplementedError(f"config rad.baseline = {rule!r} is not implemented")
    return int(m.group(1))


# --------------------------------------------------------------------------- storm numbers


def tripwire_halfwidth(s: RadSeries, cfg: dict[str, Any]) -> timedelta:
    """The "±" on tripwire times (config ``rad.tripwire_time_halfwidth``, D35)."""
    _check_rule(cfg["rad"]["tripwire_time_halfwidth"], HALFWIDTH, "rad.tripwire_time_halfwidth")
    return s.median_spacing / 2


def pm_label(halfwidth: timedelta, cfg: dict[str, Any]) -> str:
    """'± N min' (config ``rad.tripwire_time_halfwidth_display``)."""
    _check_rule(cfg["rad"]["tripwire_time_halfwidth_display"], HALFWIDTH_DISPLAY,
                "rad.tripwire_time_halfwidth_display")
    return f"± {math.floor(halfwidth / timedelta(minutes=1) + 0.5)} min"


def _cross(ta: datetime, va: float, tb: datetime, vb: float, level: float) -> datetime:
    return ta + (tb - ta) * ((level - va) / (vb - va))


def storm_numbers(s: RadSeries, cfg: dict[str, Any]) -> dict[str, Any]:
    """Baseline, peak, onset/end, excess, dose equivalent, tripwire and series (storm window)."""
    r = cfg["rad"]
    _check_rule(r["interpolation"], INTERPOLATION, "rad.interpolation")
    _check_rule(r["event_bounds"], EVENT_BOUNDS, "rad.event_bounds")
    _check_rule(r["tripwire"]["fires_at"], tripwire.FIRES_AT, "rad.tripwire.fires_at")
    _check_rule(r["excess_bound"], EXCESS_BOUND, "rad.excess_bound")
    _check_rule(r["end_of_window_rate"], END_OF_WINDOW_RATE, "rad.end_of_window_rate")
    q = float(r["q_sep"])
    if q != 1.0:
        raise ValueError(f"config rad.q_sep = {q}: Q must be 1 for the SEP (never 3)")
    t0, t1 = (parse_utc(x) for x in r["storm_window_utc"])
    base_idx = _window(s, t0 - timedelta(days=baseline_days(cfg)), t0)
    base_vals = [s.value[i] for i in base_idx if s.value[i] is not None]
    baseline = statistics.median(base_vals) if base_vals else None
    idx = _window(s, t0, t1)
    mid = [s.mid[i] for i in idx]
    val = [s.value[i] for i in idx]
    out: dict[str, Any] = {
        "baseline_uGy_day": baseline, "baseline_n": len(base_vals), "series_mid": mid,
        "series_val": val, "peak_uGy_day": None, "peak_utc": None, "onset_utc": None,
        "end_utc": None, "end_bound": None, "excess_mGy": None, "dose_equivalent_mSv": None,
        "q": q, "excess_is_lower_bound": None, "end_of_window_utc": None,
        "end_of_window_rate_uGy_day": None, "tripwire_halfwidth": tripwire_halfwidth(s, cfg),
        "tripwire_utc": tripwire.tripwire_time(
            mid, val, [s.durations[i] for i in idx], baseline,
            float(r["tripwire"]["factor"]), int(r["tripwire"]["consecutive_samples"])),
    }
    valid = [(t, v) for t, v in zip(mid, val, strict=True) if v is not None]
    if not valid:
        return out
    vm, vv = [t for t, _ in valid], [v for _, v in valid]
    out["end_of_window_utc"], out["end_of_window_rate_uGy_day"] = vm[-1], vv[-1]
    p = max(range(len(vv)), key=vv.__getitem__)
    out["peak_uGy_day"], out["peak_utc"] = vv[p], vm[p]
    if baseline is None or vv[p] <= baseline:
        return out
    i = p
    while i > 0 and vv[i - 1] > baseline:
        i -= 1
    j = p
    while j < len(vv) - 1 and vv[j + 1] > baseline:
        j += 1
    if i > 0:
        out["onset_utc"] = _cross(vm[i - 1], vv[i - 1], vm[i], vv[i], baseline)
    if j < len(vv) - 1:
        out["end_utc"], out["end_bound"] = (
            _cross(vm[j], vv[j], vm[j + 1], vv[j + 1], baseline), "baseline crossing")
    elif vm[j] >= t1 - 2 * s.median_spacing:
        out["end_utc"], out["end_bound"] = vm[j], "storm-window end (still above baseline)"
    if out["onset_utc"] is None or out["end_utc"] is None:
        return out  # not bounded inside the window: excess unknown
    pts = [(out["onset_utc"], 0.0)] + [(vm[k], vv[k] - baseline) for k in range(i, j + 1)]
    if out["end_bound"] == "baseline crossing":
        pts.append((out["end_utc"], 0.0))
    ugy = sum(0.5 * (ya + yb) * ((tb - ta) / timedelta(days=1))
              for (ta, ya), (tb, yb) in zip(pts, pts[1:], strict=False))
    out["excess_mGy"] = ugy / 1000.0
    out["excess_is_lower_bound"] = out["end_bound"] != "baseline crossing"
    out["dose_equivalent_mSv"] = out["excess_mGy"] * q
    return out


# --------------------------------------------------------------------------- rad.json


def _r(x: float | None, nd: int) -> float | None:
    return None if x is None else round(float(x), nd)


def _t(t: datetime | None) -> str | None:
    return None if t is None else fmt_utc(t)


def _latest(latest: RadSeries | None, build: datetime) -> dict[str, Any]:
    valid = [] if latest is None else [
        (t, v) for t, v in zip(latest.mid, latest.value, strict=True) if v is not None]
    if not valid:
        return {"utc": None, "dose_rate_uGy_day": None, "lag_days": None,
                "status": "unavailable",
                "note": "no recent RAD L2 records (brief WS4 fallback)",
                "build_utc": fmt_utc(build)}
    t, v = valid[-1]
    return {"utc": fmt_utc(t), "dose_rate_uGy_day": _r(v, 1),
            "lag_days": _r((build - t) / timedelta(days=1), 2), "status": "ok",
            "note": "utc = midpoint of the latest RAD L2 sample; lag = build time - utc. "
                    "RAD is not live.",
            "build_utc": fmt_utc(build)}


def _steps(cfg: dict[str, Any]) -> list[float]:
    lo, hi = (float(x) for x in cfg["leash"]["d_allow_range_mgy"])
    st = float(cfg["leash"]["d_allow_step_mgy"])
    n = round((hi - lo) / st)
    if not math.isclose(lo + n * st, hi):
        raise ValueError("leash.d_allow_range_mgy is not a whole number of steps")
    return [round(lo + k * st, 6) for k in range(n + 1)]


def build_rad(storm: RadSeries, latest: RadSeries | None, cfg: dict[str, Any],
              build_utc: datetime) -> dict[str, Any]:
    """rad.json: contract fields plus documented extras (units in every numeric key)."""
    _check_rule(cfg["leash"]["formula"], tripwire.LEASH_FORMULA, "leash.formula")
    n = storm_numbers(storm, cfg)
    lat = _latest(latest, build_utc)
    d_allow = float(cfg["leash"]["d_allow_mgy"])
    steps = _steps(cfg)
    if d_allow not in steps:
        raise ValueError(f"leash.d_allow_mgy {d_allow} is not a slider step {steps}")

    def tau(d: float, rate: float | None) -> float | None:
        return _r(tripwire.tau_dose_min(d, None if rate is None
                                        else tripwire.ugy_day_to_mgy_h(rate)), 1)

    peak = n["peak_uGy_day"]
    tw = cfg["rad"]["tripwire"]
    base = n["baseline_uGy_day"]
    eow = n["end_of_window_rate_uGy_day"]
    hw = n["tripwire_halfwidth"]
    lb = n["excess_is_lower_bound"]
    excess = _r(n["excess_mGy"], 3)
    if excess is None:
        excess_label = "unknown"
    elif lb:
        excess_label = (f"≥ {excess:.2f} mGy (lower bound: the fixed storm window ends while the "
                        "rate is still above baseline)")
    else:
        excess_label = f"{excess:.2f} mGy"
    out = {
        "source": {
            "dataset": cfg["rad"]["dataset"], "variable": cfg["rad"]["dose_variable"],
            "component": storm.component, "units_in": storm.units_in,
            "component_label": cfg["rad"]["dose_component_label"],
            "component_status": cfg["rad"]["dose_component_status"],
            "time_tag": cfg["rad"]["time_tag"],
            "time_tag_status": cfg["rad"]["time_tag_status"],
            "series_time": "sample midpoint (time tag + half the sample duration)",
            "sample_duration_rule": cfg["rad"]["sample_duration"],
            "median_spacing_min": _r(storm.median_spacing / timedelta(minutes=1), 2),
            "api": "CDAS REST (cdaweb.gsfc.nasa.gov/WS/cdasr), not HAPI",
        },
        "latest": lat,
        "baseline_uGy_day": _r(n["baseline_uGy_day"], 1),
        "baseline_definition": cfg["rad"]["baseline"],
        "storm_2024": {
            "window_utc": list(cfg["rad"]["storm_window_utc"]),
            "series_columns": ["utc", "uGy_day"],
            "series": [[fmt_utc(t), _r(v, 1)]
                       for t, v in zip(n["series_mid"], n["series_val"], strict=True)],
            "peak_uGy_day": _r(peak, 1),
            "peak_mGy_h": _r(None if peak is None else tripwire.ugy_day_to_mgy_h(peak), 4),
            "peak_utc": _t(n["peak_utc"]),
            "excess_mGy": excess,
            "excess_is_lower_bound": lb,
            "excess_label": excess_label,
            "excess_bound_rule": cfg["rad"]["excess_bound"],
            "end_of_window_utc": _t(n["end_of_window_utc"]),
            "end_of_window_rate_uGy_day": _r(eow, 1),
            "end_of_window_rate_minus_baseline_uGy_day": _r(
                None if eow is None or base is None else eow - base, 1),
            "end_of_window_rate_over_baseline_ratio": _r(
                None if eow is None or not base else eow / base, 3),
            "end_of_window_rule": cfg["rad"]["end_of_window_rate"],
            "dose_equivalent_mSv": _r(n["dose_equivalent_mSv"], 3),
            "q_note": "dose equivalent at <Q> = 1 for the SEP (never 3)",
            "onset_utc": _t(n["onset_utc"]),
            "end_utc": _t(n["end_utc"]),
            "end_bound": n["end_bound"],
            "tripwire_utc": _t(n["tripwire_utc"]),
            "tripwire_halfwidth_min": _r(hw / timedelta(minutes=1), 2),
            "tripwire_halfwidth_label": pm_label(hw, cfg),
            "tripwire_halfwidth_rule": (
                f"{cfg['rad']['tripwire_time_halfwidth']} "
                f"({_r(storm.median_spacing / timedelta(minutes=1), 2)} min): the shift if the "
                "time tag marked the sample centre, not its start (D35)"),
            "tripwire_threshold_uGy_day": _r(
                None if n["baseline_uGy_day"] is None
                else float(tw["factor"]) * n["baseline_uGy_day"], 1),
            "tripwire_rule": (f"> {tw['factor']} x baseline on {tw['consecutive_samples']} "
                              f"consecutive samples; fires at the {tw['fires_at']}"),
            "method": f"{cfg['rad']['interpolation']}; event bounds: "
                      f"{cfg['rad']['event_bounds']}",
        },
        "leash": {
            "D_allow_mGy": d_allow,
            "tau_min_at_peak": tau(d_allow, peak),
            "tau_min_at_latest": tau(d_allow, lat["dose_rate_uGy_day"]),
            "formula": cfg["leash"]["formula"],
            "D_allow_note": "our assumption (D9), adjustable",
            "table": [{"D_allow_mGy": d, "tau_min_at_peak": tau(d, peak),
                       "tau_min_at_latest": tau(d, lat["dose_rate_uGy_day"])} for d in steps],
        },
    }
    validate_rad(out)
    return out


def validate_rad(obj: dict[str, Any]) -> None:
    Draft202012Validator(json.loads(SCHEMA_PATH.read_text())).validate(obj)


_UNITS = {"ratio": "1", "uGy_day": "uGy/day", "mGy_h": "mGy/h", "mGy": "mGy", "mSv": "mSv",
          "min": "min", "days": "days", "n": "1"}


def units_of(key: str) -> str | None:
    """Units named in a numeric key (``peak_uGy_day`` -> uGy/day, ``tau_min_at_peak`` -> min)."""
    for tok, u in _UNITS.items():
        if re.search(rf"(^|_){tok}($|_)", key):
            return u
    return None


def iter_numeric_keys(obj: Any, path: str = "") -> Iterator[tuple[str, str]]:
    """(dotted path, key) of every numeric scalar under a dict key (lists of rows included)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            if isinstance(v, int | float) and not isinstance(v, bool):
                yield p, k
            else:
                yield from iter_numeric_keys(v, p)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, dict):
                yield from iter_numeric_keys(v, f"{path}.{i}")


def write_rad(obj: dict[str, Any], out_path: str | os.PathLike[str] | None = None, *,
              fragment_dir: str | os.PathLike[str] | None = None) -> Path:
    """Validate, write rad.json, record every displayed number in the provenance manifest."""
    from pipeline.provenance import manifest

    validate_rad(obj)
    reset_manifest_fragment(__file__, fragment_dir)
    path = Path(out_path) if out_path is not None else INTERIM / WEB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(obj, indent=1, allow_nan=False) + "\n").encode()
    path.write_bytes(data)
    for p, key in iter_numeric_keys(obj):
        if p.startswith("source."):
            continue
        v: Any = obj
        for part in p.split("."):
            v = v[int(part)] if isinstance(v, list) else v[part]
        manifest.record(f"rad.{p}", v, units_of(key), WEB_PATH, __file__,
                        fragment_dir=fragment_dir)
    for p in ("latest.utc", "storm_2024.peak_utc", "storm_2024.onset_utc", "storm_2024.end_utc",
              "storm_2024.tripwire_utc", "storm_2024.tripwire_halfwidth_label",
              "storm_2024.excess_is_lower_bound", "storm_2024.excess_label",
              "storm_2024.end_of_window_utc", "source.component_label",
              "source.component_status", "source.time_tag_status"):
        a, b = p.split(".")
        manifest.record(f"rad.{p}", obj[a][b], None, WEB_PATH, __file__,
                        fragment_dir=fragment_dir)
    # nulls are numbers too (unknown): record those the loop skipped
    for p in ("latest.dose_rate_uGy_day", "latest.lag_days", "baseline_uGy_day",
              "storm_2024.peak_uGy_day", "storm_2024.excess_mGy", "leash.tau_min_at_peak",
              "storm_2024.end_of_window_rate_uGy_day",
              "storm_2024.end_of_window_rate_over_baseline_ratio"):
        parts = p.split(".")
        v = obj
        for part in parts:
            v = v[part]
        if v is None:
            manifest.record(f"rad.{p}", None, units_of(parts[-1]), WEB_PATH, __file__,
                            fragment_dir=fragment_dir)
    manifest.record(f"file_sha256.{WEB_PATH}", hashlib.sha256(data).hexdigest(), None,
                    WEB_PATH, __file__, fragment_dir=fragment_dir)
    return path
