"""Sun API (F14; brief WS4 "Produces": for WS2 daylight margin, WS7 HUD, WS8 lighting).

    from pipeline.conditions import sun
    sun.sun_position(utc, lat, lon_e)               -> SunPosition(azimuth_deg, elevation_deg)
    sun.sun_at_lmst(ref_utc, lmst_h, lat, lon_e)    -> SunPosition on the local sol of ref_utc
    sun.sunrise_sunset(ref_utc, lat, lon_e, horizon_deg) -> {"sunrise": utc, "sunset": utc}
    sun.t_dark_min(eva_start, lat, lon_e, horizon_deg=0.0 | profile=<F12 horizon>) -> min | None
    sun.eva_start_utc()                             -> simulated EVA start (config clock)

Mars24 D-5 / D-6: zenith angle Z and azimuth A of the sun's centre from the subsolar point
(declination D-1, subsolar longitude C-5). Elevation = 90 - Z (no refraction); azimuth clockwise
from north (0 = N, 90 = E). Latitude/longitude are planetocentric (project CRS).

Daylight at a station: pass that observer's F12 horizon profile (WS3
``data/interim/horizon/horizons/{id}.json``: ``az_step_deg``, ``elevation_deg[i]`` at azimuth
``i * az_step_deg``); dark = the sun's centre below the horizon at the sun's azimuth.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, NamedTuple

from pipeline.conditions import marstime
from pipeline.conditions.config import load_conditions, parse_utc

_SOL = timedelta(days=marstime.SOL_IN_DAYS)


class SunPosition(NamedTuple):
    azimuth_deg: float
    elevation_deg: float


def sun_position(utc: datetime, lat_deg: float, lon_east_deg: float) -> SunPosition:
    mt = marstime.mars_time(utc)
    d_lam = math.radians((-lon_east_deg) - mt.subsolar_lon_west_deg)  # Lambda - Lambda_s (west)
    phi = math.radians(lat_deg)
    dec = math.radians(mt.declination_deg)
    cos_z = math.sin(dec) * math.sin(phi) + math.cos(dec) * math.cos(phi) * math.cos(d_lam)
    z = math.degrees(math.acos(max(-1.0, min(1.0, cos_z))))  # D-5
    a = math.degrees(math.atan2(math.sin(d_lam),
                                math.cos(phi) * math.tan(dec) - math.sin(phi) * math.cos(d_lam)))
    return SunPosition(a % 360.0, 90.0 - z)  # D-6


def sun_at_lmst(ref_utc: datetime, lmst_hours: float, lat_deg: float,
                lon_east_deg: float) -> SunPosition:
    """Sun at local mean solar time ``lmst_hours`` on the local sol containing ``ref_utc``."""
    return sun_position(marstime.utc_at_lmst(ref_utc, lmst_hours, lon_east_deg), lat_deg,
                        lon_east_deg)


def _bisect(f, a: datetime, b: datetime) -> datetime:
    fa = f(a)
    while (b - a) > timedelta(milliseconds=1):
        m = a + (b - a) / 2
        fm = f(m)
        if (fm > 0) == (fa > 0):
            a, fa = m, fm
        else:
            b = m
    return a + (b - a) / 2


def sunrise_sunset(ref_utc: datetime, lat_deg: float, lon_east_deg: float,
                   horizon_deg: float) -> dict[str, datetime] | None:
    """UTC of sunrise and sunset (sun centre crosses ``horizon_deg``) on the local sol of ref."""
    start = marstime.utc_at_lmst(ref_utc, 0.0, lon_east_deg)

    def f(t: datetime) -> float:
        return sun_position(t, lat_deg, lon_east_deg).elevation_deg - horizon_deg

    n = 96  # 15-LMST-minute scan, then bisection to 1 ms
    ts = [start + _SOL * (i / n) for i in range(n + 1)]
    vs = [f(t) for t in ts]
    rise = sset = None
    for i in range(n):
        if vs[i] <= 0 < vs[i + 1] and rise is None:
            rise = _bisect(f, ts[i], ts[i + 1])
        elif vs[i] > 0 >= vs[i + 1] and sset is None:
            sset = _bisect(f, ts[i], ts[i + 1])
    if rise is None or sset is None:
        return None
    return {"sunrise": rise, "sunset": sset}


def _profile_elev(profile: dict[str, Any], az_deg: float) -> float | None:
    el = profile["elevation_deg"]
    i = int(round(az_deg / float(profile["az_step_deg"]))) % len(el)
    return el[i]


def t_dark_min(eva_start: datetime, lat_deg: float, lon_east_deg: float, *,
               horizon_deg: float | None = None, profile: dict[str, Any] | None = None,
               max_min: float = 24 * 60.0) -> float | None:
    """Minutes from ``eva_start`` until the sun's centre goes below the horizon.

    Flat horizon at ``horizon_deg``, or an F12 point-horizon ``profile`` (nearest azimuth ray).
    1-min scan, then bisection to 1 ms. None if the sun is already down at ``eva_start``, if it
    does not set within ``max_min``, or if the sun reaches an unknown horizon ray while lower than
    the highest known horizon point (unknown stays unknown).
    """
    if (horizon_deg is None) == (profile is None):
        raise ValueError("pass exactly one of horizon_deg or profile")
    unknown = False
    known = [] if profile is None else [x for x in profile["elevation_deg"] if x is not None]
    top = max(known) if known else None

    def f(t: datetime) -> float:
        nonlocal unknown
        p = sun_position(t, lat_deg, lon_east_deg)
        h = horizon_deg if profile is None else _profile_elev(profile, p.azimuth_deg)
        if h is None:  # unknown ray: lit only if the sun is above every known horizon point
            if top is not None and p.elevation_deg > top:
                return p.elevation_deg - top
            unknown = True
            return 1.0
        return p.elevation_deg - h

    if f(eva_start) <= 0 or unknown:
        return None
    m = 0
    while m < max_min:
        a = eva_start + timedelta(minutes=m)
        b = a + timedelta(minutes=1)
        if f(b) <= 0:
            if unknown:
                return None
            t = _bisect(f, a, b)
            return (t - eva_start) / timedelta(minutes=1)
        if unknown:
            return None
        m += 1
    return None


def eva_start_utc() -> datetime:
    """Simulated EVA start: config clock.eva_start_lmst_h at Gale on the sol of eva_sol_ref_utc."""
    ck = load_conditions()["clock"]
    return marstime.utc_at_lmst(parse_utc(str(ck["eva_sol_ref_utc"])),
                                float(ck["eva_start_lmst_h"]), float(ck["gale_lon_east_deg"]))


__all__ = ["SunPosition", "sun_position", "sun_at_lmst", "sunrise_sunset", "t_dark_min",
           "eva_start_utc"]
