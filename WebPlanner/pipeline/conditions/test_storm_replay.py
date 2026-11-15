"""Known-answer tests: D39 shared storm timing (config ``storm_replay``; F14, F18).

The replayed 20 May 2024 storm is placed on the EVA clock so that its tripwire fires at t*, the
EVA minute where the route's T_home is largest (first sample on a tie). All inputs are invented
test values (route profile, UTC instants), never shipped.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from pipeline.conditions import storm_replay as sr
from pipeline.conditions.config import load_conditions

CFG = load_conditions()
TRIP = datetime(2024, 5, 20, 5, 57, 7, tzinfo=UTC)
ONSET = datetime(2024, 5, 20, 5, 15, 52, tzinfo=UTC)
PEAK = datetime(2024, 5, 20, 6, 19, 52, tzinfo=UTC)


def test_config_key_is_the_d39_rule():
    s = CFG["storm_replay"]
    assert s["tripwire_at"] == sr.TRIPWIRE_AT == "route_max_t_home"
    assert s["anchor_event"] == "tripwire" and s["eva_clock_units"] == "min"


def test_target_is_argmax_t_home():
    # out-and-back: T_home rises to 120 min at the far point (EVA minute 150), then falls
    t = [0, 30, 60, 90, 120, 150, 180, 210, 240]
    th = [0, 20, 45, 70, 95, 120, 100, 60, 0]
    assert sr.tripwire_target_min(t, th) == 150.0


def test_target_tie_takes_first_and_skips_unknown():
    assert sr.tripwire_target_min([0, 10, 20, 30], [5, 9, 9, 1]) == 10.0
    assert sr.tripwire_target_min([0, 10, 20], [None, 3, None]) == 10.0
    assert sr.tripwire_target_min([0, 10], [None, None]) is None
    with pytest.raises(ValueError):
        sr.tripwire_target_min([0, 10], [1])


def test_offset_and_mapping_round_trip():
    t_star = 150.0
    z = sr.storm_offset_utc(TRIP, t_star)  # storm UTC at EVA minute 0
    assert z == TRIP - timedelta(minutes=150)
    assert sr.storm_utc_at(t_star, TRIP, t_star) == TRIP  # tripwire fires at t*
    assert sr.storm_utc_at(0.0, TRIP, t_star) == z
    assert sr.eva_min_of(TRIP, TRIP, t_star) == pytest.approx(t_star)
    # onset 41.25 min before the tripwire -> EVA minute 108.75
    assert sr.eva_min_of(ONSET, TRIP, t_star) == pytest.approx(150 - 41.25)
    assert sr.eva_min_of(PEAK, TRIP, t_star) == pytest.approx(150 + 22.75)


def test_replay_from_rad_dict():
    radj = {"storm_2024": {"tripwire_utc": "2024-05-20T05:57:07Z",
                           "onset_utc": "2024-05-20T05:15:52Z",
                           "peak_utc": "2024-05-20T06:19:52Z"}}
    r = sr.replay(radj, [0, 60, 120, 180], [0, 50, 80, 10])
    assert r["tripwire_eva_min"] == 120.0
    assert r["onset_eva_min"] == pytest.approx(120 - 41.25)
    assert r["peak_eva_min"] == pytest.approx(120 + 22.75)
    assert r["storm_utc_at_eva_start"] == "2024-05-20T03:57:07Z"
    assert r["rule"] == "route_max_t_home"
    json.dumps(r)  # JSON-ready


def test_replay_unknown_stays_unknown():
    r = sr.replay({"storm_2024": {"tripwire_utc": None, "onset_utc": None, "peak_utc": None}},
                  [0, 60], [0, 50])
    assert r["tripwire_eva_min"] == 60.0
    assert r["onset_eva_min"] is None and r["storm_utc_at_eva_start"] is None
    r = sr.replay({"storm_2024": {"tripwire_utc": "2024-05-20T05:57:07Z", "onset_utc": None,
                                  "peak_utc": None}}, [0], [None])
    assert r["tripwire_eva_min"] is None and r["storm_utc_at_eva_start"] is None


def test_other_rules_refused():
    bad = json.loads(json.dumps(CFG))
    bad["storm_replay"]["tripwire_at"] = "eva_start"
    with pytest.raises(NotImplementedError):
        sr.check_config(bad)
