"""RAD tripwire (the local alarm) and the dose-budget leash (F14; SPEC §3 fix 2).

Tripwire (config ``rad.tripwire``): dose rate > ``factor`` x baseline on ``consecutive_samples``
consecutive samples. It fires at the end of the last qualifying sample (``fires_at``), i.e. when
that sample's value exists. A missing sample (fill) breaks the run.

Leash (config ``leash.formula``): tau_dose_min = 60 * D_allow / Ddot_mGy_per_h. The crew turns
back when T_home >= tau_dose. Never triggered from DONKI (brief WS4 "Don't").
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta

FIRES_AT = "end of the last qualifying sample"
LEASH_FORMULA = "tau_dose_min = 60 * D_allow / Ddot_mGy_per_h"


def ugy_day_to_mgy_h(rate_ugy_day: float) -> float:
    """uGy/day -> mGy/h."""
    return rate_ugy_day / 1000.0 / 24.0


def tripwire_time(mid: Sequence[datetime], value_ugy_day: Sequence[float | None],
                  durations: Sequence[timedelta], baseline_ugy_day: float | None,
                  factor: float, consecutive_samples: int) -> datetime | None:
    """First alarm time, or None (never fires, or baseline unknown).

    ``mid``: sample midpoints in time order; ``durations``: each sample's integration time.
    """
    if baseline_ugy_day is None:
        return None
    threshold = factor * baseline_ugy_day
    run = 0
    for t, v, d in zip(mid, value_ugy_day, durations, strict=True):
        if v is not None and v > threshold:
            run += 1
            if run >= consecutive_samples:
                return t + d / 2
        else:
            run = 0
    return None


def tau_dose_min(d_allow_mgy: float, ddot_mgy_per_h: float | None) -> float | None:
    """Minutes until the dose allowance is used at a constant rate (None if rate unknown/<= 0)."""
    if d_allow_mgy < 0:
        raise ValueError(f"dose allowance must be >= 0 mGy, got {d_allow_mgy}")
    if ddot_mgy_per_h is None or ddot_mgy_per_h <= 0:
        return None
    return 60.0 * d_allow_mgy / ddot_mgy_per_h
