"""Known-answer tests: WS4 Mars clock and sun API (brief WS4 "Tests"; SPEC §9 Clock; F14).

Sources of every expected value:
- Mars24 worked examples, Allison & McEwen (2000) as published step by step at
  https://www.giss.nasa.gov/tools/mars24/help/algorithm.html (fetched 2026-11-14 after H0):
  Example 1, 2000-01-06 00:00:00 UTC at 0 E, 0 N; Example 2, 2004-01-03 13:46:31 UTC (MER-A
  Spirit landing) at 184.702 W, 14.640 S. Values below are verbatim from that page.
- Brief WS4: Ls on 2026-08-25 = 341.6 deg +/- 0.2 deg.
- SPEC §9 Clock: Mars24 LMST vs Navcam image label <= 10 s on 3 frames. The three frames
  (imageid, date_taken, extended.lmst) are as published by the MSL raw-image API, from D0's
  fresh responses ``data/raw/discovery/rawapi_msl_sol{5041,5069,5073}_NAV_LEFT_B.json``
  (docs/discovery.md §3.3). docs/discovery.md §4.5 measured the label longitude 137.4085 E
  (max |error| 0.55 s over 2,287 frames); config clock.gale_lon_east_deg carries it.
- config/conditions.yaml event_weekend: Ls ~ 22 deg, Mars year 39 at the event.
- Light time: docs/discovery.md §4.4 (11.014 min at 2026-11-14 00:00 UTC, JPL Horizons).
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta

import pytest

from pipeline.conditions import marstime, sun
from pipeline.conditions.config import REPO, h0_utc, load_conditions, site_latlon

CFG = load_conditions()
CLOCK = CFG["clock"]
LON = CLOCK["gale_lon_east_deg"]
LAT, PAD_LON = site_latlon()


def utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ------------------------------------------------------------------ Mars24 worked example 1

EX1 = datetime(2000, 1, 6, 0, 0, 0, tzinfo=UTC)


def test_ex1_time_scales():
    mt = marstime.mars_time(EX1)
    assert mt.jd_ut == pytest.approx(2451549.5, abs=1e-9)  # A-2
    assert mt.tt_minus_utc_s == pytest.approx(64.184, abs=1e-9)  # A-4
    assert mt.jd_tt == pytest.approx(2451549.50074, abs=1e-5)  # A-5
    assert mt.dt_j2000 == pytest.approx(4.50074, abs=1e-5)  # A-6


def test_ex1_orbit_ls_eot_mst():
    mt = marstime.mars_time(EX1)
    assert mt.mean_anomaly_deg == pytest.approx(21.74558, abs=2e-5)  # B-1
    assert mt.alpha_fms_deg == pytest.approx(272.74566, abs=2e-5)  # B-2
    assert mt.pbs_deg == pytest.approx(0.00142, abs=1e-5)  # B-3
    assert mt.nu_minus_m_deg == pytest.approx(4.44193, abs=2e-5)  # B-4
    assert mt.ls_deg == pytest.approx(277.18758, abs=2e-5)  # B-5
    assert mt.eot_deg == pytest.approx(-5.18774, abs=2e-5)  # C-1
    assert mt.mtc_h == pytest.approx(23.99425, abs=1e-5)  # C-2
    assert marstime.lmst_h(EX1, 0.0) == pytest.approx(23.99425, abs=1e-5)  # C-3
    assert marstime.ltst_h(EX1, 0.0) == pytest.approx(23.64840, abs=1e-5)  # C-4
    assert mt.subsolar_lon_west_deg == pytest.approx(174.72600, abs=2e-5)  # C-5
    assert mt.declination_deg == pytest.approx(-25.22825, abs=2e-5)  # D-1
    assert mt.helio_dist_au == pytest.approx(1.39358, abs=1e-5)  # D-2


def test_ex1_sun_zenith_azimuth():
    p = sun.sun_position(EX1, 0.0, 0.0)
    assert 90.0 - p.elevation_deg == pytest.approx(154.26182, abs=1e-4)  # D-5 Z
    assert p.azimuth_deg == pytest.approx(191.03905, abs=1e-4)  # D-6 A


# ------------------------------------------------------------------ Mars24 worked example 2

EX2 = datetime(2004, 1, 3, 13, 46, 31, tzinfo=UTC)
EX2_LON_E = -184.702 % 360.0
EX2_LAT = -14.640


def test_ex2_spirit_landing():
    mt = marstime.mars_time(EX2)
    assert mt.dt_j2000 == pytest.approx(1463.07471, abs=1e-5)  # A-6
    assert mt.mean_anomaly_deg == pytest.approx(66.06858, abs=2e-5)  # B-1 (mod 360)
    assert mt.alpha_fms_deg == pytest.approx(317.09457, abs=2e-5)  # B-2 (mod 360)
    assert mt.pbs_deg == pytest.approx(0.01614, abs=1e-5)  # B-3
    assert mt.nu_minus_m_deg == pytest.approx(10.22959, abs=2e-5)  # B-4
    assert mt.ls_deg == pytest.approx(327.32416, abs=2e-5)  # B-5
    assert mt.eot_deg == pytest.approx(-12.77553, abs=2e-5)  # C-1
    assert mt.mtc_h == pytest.approx(13.16537, abs=1e-5)  # C-2
    assert marstime.lmst_h(EX2, EX2_LON_E) == pytest.approx(0.85190, abs=1e-5)  # C-3
    # C-4: the page prints 0.00025 h, but its own C-3 and C-1 (0.85190 - 0.85170) give 0.00020;
    # tolerance 1e-4 h = 0.36 s covers that rounding
    assert marstime.ltst_h(EX2, EX2_LON_E) == pytest.approx(0.00025, abs=1e-4)
    assert mt.subsolar_lon_west_deg == pytest.approx(4.70500, abs=2e-5)  # C-5
    # D-1: the page prints -13.42065, but its own D-1 formula on its own B-5 Ls (327.32416)
    # gives -13.42040 (checked by hand), so example 2's declination (and Z, which inherits it)
    # are matched to 5e-4 / 1e-3 deg; example 1 matches to 2e-5.
    assert mt.declination_deg == pytest.approx(-13.42065, abs=5e-4)
    assert mt.helio_dist_au == pytest.approx(1.47767, abs=1e-5)  # D-2
    p = sun.sun_position(EX2, EX2_LAT, EX2_LON_E)
    assert 90.0 - p.elevation_deg == pytest.approx(151.93895, abs=1e-3)  # D-5 Z
    assert p.azimuth_deg == pytest.approx(179.99383, abs=1e-4)  # D-6 A


# ------------------------------------------------------------------ brief / SPEC KATs


def test_ls_on_2026_08_25():
    # brief WS4: 341.6 +/- 0.2 deg. The brief gives a date, not a time; Ls moves ~0.53 deg/day
    # here, so the KAT is evaluated at mid-day UTC (the day's mean).
    ls = marstime.mars_time(datetime(2026, 8, 25, 12, tzinfo=UTC)).ls_deg
    assert ls == pytest.approx(341.6, abs=0.2)


def test_event_weekend_ls_and_mars_year():
    mt = marstime.mars_time(h0_utc())
    assert mt.mars_year == CFG["event_weekend"]["mars_year"]
    assert mt.ls_deg == pytest.approx(CFG["event_weekend"]["ls_deg"], abs=0.5)  # config: 1 deg


def test_mars_year_rolls_at_ls_zero():
    assert marstime.mars_time(datetime(2026, 8, 25, tzinfo=UTC)).mars_year == 38
    t, prev = datetime(2026, 8, 25, tzinfo=UTC), None
    while True:
        cur = marstime.mars_time(t)
        if prev is not None and cur.ls_deg < prev.ls_deg:
            break
        prev, t = cur, t + timedelta(hours=6)
    assert (prev.mars_year, cur.mars_year) == (38, 39)


# (imageid, date_taken UTC, extended.lmst) as published by the MSL raw-image API (D0 cache)
NAVCAM_FRAMES = (
    ("NLB_845007896EDR_T1250558TRAV01526M_", "2026-10-11T17:37:31Z", "Sol-05041M13:25:18.256"),
    ("NLB_847487372EDR_T1251326TRAV01528M_", "2026-11-09T10:22:31Z", "Sol-05069M11:44:37.007"),
    ("NLB_847853302EDR_T1252490NCAM00354M_", "2026-11-13T16:01:24Z", "Sol-05073M14:40:19.749"),
)


def _label_h(lmst: str) -> float:
    hh, mm, ss = lmst.split("M", 1)[1].split(":")
    return int(hh) + int(mm) / 60 + float(ss) / 3600


def _err_s(a_h: float, b_h: float) -> float:
    return abs((a_h - b_h + 12) % 24 - 12) * 3600


@pytest.mark.parametrize("imageid,taken,lmst", NAVCAM_FRAMES)
def test_lmst_vs_navcam_label_within_10_s(imageid, taken, lmst):
    assert _err_s(marstime.lmst_h(utc(taken), LON), _label_h(lmst)) <= 10.0  # SPEC §9
    # date_taken has 1 s resolution; discovery.md §4.5 max |error| 0.55 s at this longitude
    assert _err_s(marstime.lmst_h(utc(taken), LON), _label_h(lmst)) <= 1.5


@pytest.mark.parametrize("imageid,taken,lmst", NAVCAM_FRAMES)
def test_msl_sol_number(imageid, taken, lmst):
    assert marstime.msl_sol(utc(taken), LON) == int(lmst[4:9])


def test_navcam_frames_match_discovery_cache():
    d = REPO / "data" / "raw" / "discovery"
    files = sorted(d.glob("rawapi_msl_sol*_NAV_LEFT_B.json")) if d.is_dir() else []
    if not files:
        pytest.skip("discovery raw-image responses absent (data/ is not in CI)")
    items = {it["imageid"]: it for f in files for it in json.loads(f.read_text())["items"]}
    for imageid, taken, lmst in NAVCAM_FRAMES:
        it = items[imageid]
        assert it["date_taken"].replace(".000Z", "Z") == taken
        assert it["extended"]["lmst"] == lmst
    errs = [_err_s(marstime.lmst_h(utc(it["date_taken"]), LON), _label_h(it["extended"]["lmst"]))
            for it in items.values() if it.get("extended", {}).get("lmst")]
    assert len(errs) > 100 and max(errs) <= 10.0


def test_navcam_frames_from_ws3():
    p = REPO / "data" / "interim" / "horizon" / "navcam_frames.json"
    if not p.exists():
        pytest.skip("WS3 navcam_frames.json not produced yet")
    doc = json.loads(p.read_text())
    frames = doc["frames"] if isinstance(doc, dict) else doc
    checked = 0
    for f in frames:
        lmst, t = f.get("lmst"), f.get("date_taken") or f.get("utc")
        if not (isinstance(lmst, str) and "M" in lmst and t):
            continue
        assert _err_s(marstime.lmst_h(utc(t), LON), _label_h(lmst)) <= 10.0
        checked += 1
    if checked < 3:
        pytest.skip(f"WS3 frames carry {checked} usable (utc, lmst) pairs")


# ------------------------------------------------------------------ time-scale behaviour


def test_lmst_shifts_15_deg_per_hour():
    t = h0_utc()
    assert (marstime.lmst_h(t, 90.0) - marstime.lmst_h(t, 0.0)) % 24 == pytest.approx(6.0)


def test_one_sol_later_same_lmst():
    t = h0_utc()
    t2 = t + timedelta(days=1.0274912517)  # Mars24 C-2: Earth days per mean solar day
    assert marstime.lmst_h(t2, LON) == pytest.approx(marstime.lmst_h(t, LON), abs=1e-6)


def test_utc_at_lmst_round_trip_same_sol():
    ref = h0_utc()
    for target in (0.25, 6.0, 9.0, 12.0, 17.5, 23.9):
        u = marstime.utc_at_lmst(ref, target, LON)
        assert marstime.lmst_h(u, LON) == pytest.approx(target, abs=1e-6)
        assert marstime.msl_sol(u, LON) == marstime.msl_sol(ref, LON)


def test_format_hms():
    assert marstime.format_hms(13.5) == "13:30:00"
    assert marstime.format_hms(23.99999) == "00:00:00"


def test_out_of_table_and_naive_refused():
    with pytest.raises(ValueError):
        marstime.mars_time(datetime(1970, 1, 1, tzinfo=UTC))
    with pytest.raises(ValueError):
        marstime.mars_time(datetime(2027, 6, 1, tzinfo=UTC))  # TAI-UTC unknown after 2026
    with pytest.raises(ValueError):
        marstime.mars_time(datetime(2026, 11, 14, 8))


# ------------------------------------------------------------------ sun API


def test_noon_on_meridian():
    u = marstime.utc_at_ltst(h0_utc(), 12.0, LON)
    mt = marstime.mars_time(u)
    p = sun.sun_position(u, LAT, LON)
    assert p.elevation_deg == pytest.approx(90 - abs(LAT - mt.declination_deg), abs=1e-6)
    want = 0.0 if mt.declination_deg > LAT else 180.0
    assert min(abs(p.azimuth_deg - want), 360 - abs(p.azimuth_deg - want)) < 1e-6


def test_morning_east_afternoon_west():
    ref = h0_utc()
    am = sun.sun_position(marstime.utc_at_ltst(ref, 9.0, LON), LAT, LON)
    pm = sun.sun_position(marstime.utc_at_ltst(ref, 15.0, LON), LAT, LON)
    assert 0 < am.azimuth_deg < 180 < pm.azimuth_deg < 360
    assert am.elevation_deg == pytest.approx(pm.elevation_deg, abs=0.05)


def test_sun_at_lmst_equals_utc_route():
    ref = h0_utc()
    assert sun.sun_at_lmst(ref, 10.0, LAT, LON) == sun.sun_position(
        marstime.utc_at_lmst(ref, 10.0, LON), LAT, LON)


def test_sunrise_sunset_on_event_sol():
    h = CLOCK["sun_horizon_elevation_deg"]
    ev = sun.sunrise_sunset(h0_utc(), LAT, LON, h)
    for k in ("sunrise", "sunset"):
        assert sun.sun_position(ev[k], LAT, LON).elevation_deg == pytest.approx(h, abs=1e-3)
    rise, sset = (marstime.ltst_h(ev[k], LON) for k in ("sunrise", "sunset"))
    assert (rise + sset) / 2 == pytest.approx(12.0, abs=0.02)  # symmetric about true noon
    assert 11.0 < sset - rise < 13.0  # near the equator


def test_t_dark_flat_and_profile():
    start = marstime.utc_at_lmst(h0_utc(), 9.0, LON)
    flat = sun.t_dark_min(start, LAT, LON, horizon_deg=0.0)
    ss = sun.sunrise_sunset(start, LAT, LON, 0.0)["sunset"]
    assert flat == pytest.approx((ss - start) / timedelta(minutes=1), abs=0.01)
    wall = {"az_step_deg": 0.25, "elevation_deg": [10.0] * 1440}
    m = sun.t_dark_min(start, LAT, LON, profile=wall)
    t = start + timedelta(minutes=m)
    assert sun.sun_position(t, LAT, LON).elevation_deg == pytest.approx(10.0, abs=1e-3)
    assert m < flat
    unknown = {"az_step_deg": 0.25, "elevation_deg": [None] * 1440}
    assert sun.t_dark_min(start, LAT, LON, profile=unknown) is None


def test_sun_position_fields_named_with_units():
    p = sun.sun_position(h0_utc(), LAT, LON)
    assert p._fields == ("azimuth_deg", "elevation_deg")
    assert all(math.isfinite(v) for v in p)


# ------------------------------------------------------------------ light time and clock.json

HORIZONS_SNIPPET = """header
 Date__(UT)__HR:MN                delta      deldot  1-way_down_LT
******************************************************************
$$SOE
 2026-Nov-14 00:00     1.32436201800863 -14.7121700    11.01438304
 2026-Nov-14 06:00     1.32223717738816 -14.7218746    10.99671128
$$EOE
"""


def test_parse_horizons_and_interpolate():
    from pipeline.conditions import clockfile

    tab = clockfile.parse_horizons(HORIZONS_SNIPPET)  # rows as in discovery.md §4.4 evidence
    assert tab[0] == (datetime(2026, 11, 14, tzinfo=UTC), 11.01438304)
    mid = clockfile.light_time_at(datetime(2026, 11, 14, 3, tzinfo=UTC), tab)
    assert mid == pytest.approx((11.01438304 + 10.99671128) / 2)
    assert clockfile.light_time_at(datetime(2026, 11, 14, 7, tzinfo=UTC), tab) is None
    with pytest.raises(ValueError):
        clockfile.parse_horizons("no table")


def test_light_time_cache_matches_discovery():
    from pipeline.conditions import clockfile

    tab, _ = clockfile.load_light_time()
    if tab is None:
        pytest.skip("Horizons cache absent (python -m pipeline.conditions.fetch horizons)")
    # discovery.md §4.4: 11.014 min at 14 Nov 00:00 UTC, 10.873 min at 16 Nov 00:00 UTC
    assert clockfile.light_time_at(datetime(2026, 11, 14, tzinfo=UTC), tab) == pytest.approx(
        11.014, abs=0.001)
    assert clockfile.light_time_at(datetime(2026, 11, 16, tzinfo=UTC), tab) == pytest.approx(
        10.873, abs=0.001)


def test_clock_json(tmp_path):
    from pipeline.conditions import clockfile

    obj = clockfile.build_clock()  # validates against contracts/clock.schema.json
    h0 = obj["h0"]
    assert h0["utc"] == "2026-11-14T08:00:00Z"
    assert h0["mars_year"] == CFG["event_weekend"]["mars_year"]
    assert abs(h0["ls_deg"] - CFG["event_weekend"]["ls_deg"]) < 0.5
    eva = obj["eva"]
    start = utc(eva["start_utc"])
    assert marstime.lmst_h(start, LON) == pytest.approx(CLOCK["eva_start_lmst_h"], abs=1e-3)
    assert utc(eva["end_utc"]) - start == timedelta(minutes=eva["eva_min"])
    ss = utc(eva["sunset_flat_utc"])
    assert sun.sun_position(ss, LAT, PAD_LON).elevation_deg == pytest.approx(0.0, abs=0.01)
    assert eva["t_dark_min"] == pytest.approx((ss - start) / timedelta(minutes=1), abs=0.02)
    assert len(eva["sun_series"]) == int(eva["eva_min"] // CLOCK["sun_series_step_min"]) + 1
    sols = [s["msl_sol"] for s in obj["sols"]]
    assert sols == sorted(set(sols)) and len(sols) >= 2
    p = clockfile.write_clock(obj, tmp_path, fragment_dir=tmp_path / "m")
    assert json.loads(p.read_text())["h0"]["lmst"] == h0["lmst"]


# ------------------------------------------------------------------ D21: official pad as the site


def test_site_reads_official_pad_json(tmp_path):
    from pipeline.conditions import config

    p = tmp_path / "pad.json"
    p.write_text(json.dumps({"dummy": False, "pad": {"lon": 137.401783, "lat": -4.77748,
                                                     "id": "rank1"}}))
    s = config.pad_site(p)
    assert (s["lat"], s["lon"]) == (-4.77748, 137.401783)
    assert s["fallback"] is False and s["id"] == "rank1"
    assert "pad.json" in s["source"]


def test_site_falls_back_to_pad_default_and_says_so(tmp_path):
    from pipeline.conditions import config

    s = config.pad_site(tmp_path / "missing.json")
    pd = config.load("site")["pad_default"]
    assert (s["lat"], s["lon"]) == (float(pd["lat"]), float(pd["lon"]))
    assert s["fallback"] is True
    assert "pad_default" in s["source"] and "missing" in s["note"]


def test_site_refuses_pad_json_without_pad(tmp_path):
    from pipeline.conditions import config

    p = tmp_path / "pad.json"
    p.write_text(json.dumps({"dummy": False}))
    with pytest.raises(KeyError):
        config.pad_site(p)  # present but broken: no silent fallback


def test_clock_site_is_the_official_pad():
    from pipeline.conditions import clockfile, config

    obj = clockfile.build_clock()
    s = config.pad_site()
    site = obj["site"]
    assert (site["lat_deg"], site["sun_lon_east_deg"]) == (s["lat"], s["lon"])
    assert site["lon_east_deg"] == LON  # LMST stays on the MSL label longitude
    assert site["pad_source"] == s["source"] and site["pad_fallback"] is s["fallback"]
    if config.PAD_JSON.exists():
        pad = json.loads(config.PAD_JSON.read_text())["pad"]
        assert (site["lat_deg"], site["sun_lon_east_deg"]) == (pad["lat"], pad["lon"])
    # the flat-horizon sunset and the sun series are at the pad
    eva = obj["eva"]
    start, ss = utc(eva["start_utc"]), utc(eva["sunset_flat_utc"])
    assert sun.sun_position(ss, s["lat"], s["lon"]).elevation_deg == pytest.approx(0.0, abs=0.01)
    t, _, az, el = eva["sun_series"][10]
    p = sun.sun_position(start + timedelta(minutes=t), s["lat"], s["lon"])
    assert (az, el) == (pytest.approx(p.azimuth_deg, abs=1e-3),
                        pytest.approx(p.elevation_deg, abs=1e-3))


def test_observer_daylight_at_its_own_position():
    from pipeline.conditions import clockfile

    prof = {"observer_id": "X", "az_step_deg": 0.25, "elevation_deg": [5.0] * 1440,
            "meta": {"lon": 137.38, "lat": -4.81}}
    assert clockfile.observer_latlon(prof, (-4.0, 137.0)) == (-4.81, 137.38)
    assert clockfile.observer_latlon({"meta": {}}, (-4.0, 137.0)) == (-4.0, 137.0)
