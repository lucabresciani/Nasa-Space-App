"""D39 shared storm timing: place the 20 May 2024 storm on the EVA clock (F14, F18).

Config ``storm_replay`` (read by WS2 margins and WS7 HUD storm replay): the storm series is shifted
so that its tripwire (rad.json ``storm_2024.tripwire_utc``) fires at t*, the EVA minute where the
route's T_home is largest (first sample on a tie). Minutes are counted from the EVA start
(config ``clock.eva_start_lmst_h``, D31). The mapping is a pure time shift:

    storm_utc(eva_min) = tripwire_utc + (eva_min - t*) min

Unknown stays unknown: no route T_home or no tripwire time gives None.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

from pipeline.conditions.config import fmt_utc, load_conditions, parse_utc

TRIPWIRE_AT = "route_max_t_home"
ANCHOR_EVENT = "tripwire"
UNITS = "min"
TIE_BREAK = "first"


def check_config(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """The ``storm_replay`` block, refused unless it names the rule implemented here."""
    s = (cfg or load_conditions())["storm_replay"]
    want = {"tripwire_at": TRIPWIRE_AT, "anchor_event": ANCHOR_EVENT,
            "eva_clock_units": UNITS, "tie_break": TIE_BREAK}
    for k, v in want.items():
        if str(s.get(k)) != v:
            raise NotImplementedError(f"config storm_replay.{k} = {s.get(k)!r}; "
                                      f"storm_replay.py implements {v!r}")
    return s


def tripwire_target_min(eva_min: Sequence[float],
                        t_home_min: Sequence[float | None]) -> float | None:
    """t*: the EVA minute of the largest T_home along the route (first on a tie; None skipped)."""
    if len(eva_min) != len(t_home_min):
        raise ValueError("eva_min and t_home_min differ in length")
    best: tuple[float, float] | None = None
    for t, th in zip(eva_min, t_home_min, strict=True):
        if th is not None and (best is None or th > best[1]):
            best = (float(t), float(th))
    return None if best is None else best[0]


def storm_offset_utc(tripwire_utc: datetime, target_min: float) -> datetime:
    """Storm UTC that coincides with EVA minute 0."""
    return tripwire_utc - timedelta(minutes=target_min)


def storm_utc_at(eva_min: float, tripwire_utc: datetime, target_min: float) -> datetime:
    """Storm UTC shown at EVA minute ``eva_min``."""
    return storm_offset_utc(tripwire_utc, target_min) + timedelta(minutes=eva_min)


def eva_min_of(storm_utc: datetime, tripwire_utc: datetime, target_min: float) -> float:
    """EVA minute at which the storm instant ``storm_utc`` is replayed."""
    return (storm_utc - storm_offset_utc(tripwire_utc, target_min)) / timedelta(minutes=1)


def replay(rad_json: dict[str, Any], eva_min: Sequence[float],
           t_home_min: Sequence[float | None]) -> dict[str, Any]:
    """EVA-clock placement of the storm for one route (JSON-ready; minutes since EVA start)."""
    check_config()
    s = rad_json["storm_2024"]
    t_star = tripwire_target_min(eva_min, t_home_min)
    trip = s.get("tripwire_utc")
    out: dict[str, Any] = {"rule": TRIPWIRE_AT, "tripwire_eva_min": t_star,
                           "onset_eva_min": None, "peak_eva_min": None,
                           "storm_utc_at_eva_start": None}
    if t_star is None or not trip:
        return out
    tw = parse_utc(trip)
    out["storm_utc_at_eva_start"] = fmt_utc(storm_offset_utc(tw, t_star))
    for key, name in (("onset_utc", "onset_eva_min"), ("peak_utc", "peak_eva_min")):
        if s.get(key):
            out[name] = eva_min_of(parse_utc(s[key]), tw, t_star)
    return out
