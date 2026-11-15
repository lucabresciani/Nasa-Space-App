"""Mars clock: the Mars24 algorithm (F14 "Clock"; config clock.algorithm).

Allison, M. & McEwen, M. (2000), Planet. Space Sci. 48, 215-235, as published step by step
(A-1 .. D-6) at https://www.giss.nasa.gov/tools/mars24/help/algorithm.html. The numeric
coefficients below ARE that published algorithm (config names it: ``clock.algorithm``); step labels
in the comments follow the GISS page. Site values come from config/.

Longitudes are planetocentric EAST (project CRS); Mars24's west form LMST = MST - Lambda_W/15 is
applied as LMST = MST + lon_E/15. Latitude is used as given (Mars24 uses planetographic latitude;
at Gale the difference is < 0.06 deg).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache

from pipeline.conditions.config import load_conditions, parse_utc

# TAI - UTC (s) from each date: IERS Bulletin C. No leap second before 2027-01-01 (Bulletin C 72).
_TAI_MINUS_UTC: tuple[tuple[datetime, int], ...] = tuple(
    (datetime(y, m, 1, tzinfo=UTC), s)
    for y, m, s in (
        (1972, 1, 10), (1972, 7, 11), (1973, 1, 12), (1974, 1, 13), (1975, 1, 14),
        (1976, 1, 15), (1977, 1, 16), (1978, 1, 17), (1979, 1, 18), (1980, 1, 19),
        (1981, 7, 20), (1982, 7, 21), (1983, 7, 22), (1985, 7, 23), (1988, 1, 24),
        (1990, 1, 25), (1991, 1, 26), (1992, 7, 27), (1993, 7, 28), (1994, 7, 29),
        (1996, 1, 30), (1997, 7, 31), (1999, 1, 32), (2006, 1, 33), (2009, 1, 34),
        (2012, 7, 35), (2015, 7, 36), (2017, 1, 37),
    )
)
_LEAP_VALID_UNTIL = datetime(2027, 1, 1, tzinfo=UTC)
_TT_MINUS_TAI_S = 32.184
SOL_IN_DAYS = 1.0274912517  # C-2: Earth days per Mars mean solar day
_UNIX_JD = 2440587.5  # A-2: JD of 1970-01-01T00:00Z
_J2000 = 2451545.0

# B-3 perturbers: (A_i deg, tau_i Julian years, phi_i deg)
_PBS = (
    (0.0071, 2.2353, 49.409), (0.0057, 2.7543, 168.173), (0.0039, 1.1177, 191.837),
    (0.0037, 15.7866, 21.736), (0.0021, 2.1354, 15.704), (0.0020, 2.4694, 95.528),
    (0.0018, 32.8493, 49.095),
)


def _aware(t: datetime) -> datetime:
    if t.tzinfo is None:
        raise ValueError("naive datetime: pass an aware UTC datetime")
    return t.astimezone(UTC)


def tt_minus_utc_s(t: datetime) -> float:
    """A-4: TT - UTC in seconds; refuses dates outside the leap-second table."""
    t = _aware(t)
    if t < _TAI_MINUS_UTC[0][0] or t >= _LEAP_VALID_UNTIL:
        raise ValueError(f"{t.isoformat()} is outside the leap-second table (1972-2026)")
    return next(s for start, s in reversed(_TAI_MINUS_UTC) if t >= start) + _TT_MINUS_TAI_S


def _sin(x: float) -> float:
    return math.sin(math.radians(x))


def _cos(x: float) -> float:
    return math.cos(math.radians(x))


def _orbit(dt: float) -> tuple[float, float, float, float]:
    """B-1..B-4 for dt days since J2000 (TT): (M, alpha_FMS, PBS, nu - M), degrees."""
    m = 19.3871 + 0.52402073 * dt  # B-1
    alpha = 270.3871 + 0.524038496 * dt  # B-2
    pbs = sum(a * _cos(0.985626 * dt / tau + phi) for a, tau, phi in _PBS)  # B-3
    nu_m = ((10.691 + 3.0e-7 * dt) * _sin(m) + 0.623 * _sin(2 * m) + 0.050 * _sin(3 * m)
            + 0.005 * _sin(4 * m) + 0.0005 * _sin(5 * m) + pbs)  # B-4
    return m, alpha, pbs, nu_m


def _dt_j2000(utc: datetime) -> tuple[float, float, float]:
    """(JD_UT, TT-UTC s, dt days since J2000 TT); dt computed without large-JD round-off."""
    tt_utc = tt_minus_utc_s(utc)
    unix_d = utc.timestamp() / 86400.0
    return _UNIX_JD + unix_d, tt_utc, unix_d + tt_utc / 86400.0 + (_UNIX_JD - _J2000)


@lru_cache(maxsize=1)
def _mars_year_offset() -> int:
    """MY = floor(unwrapped Ls / 360) + offset, anchored on config clock.mars_year_epoch_utc."""
    epoch = parse_utc(str(load_conditions()["clock"]["mars_year_epoch_utc"]))
    dt = epoch.timestamp() / 86400.0 + (_UNIX_JD - _J2000)  # TT-UTC (< 1 min) cannot matter
    _, alpha, _, nu_m = _orbit(dt)
    return 1 - round((alpha + nu_m) / 360.0)


@dataclass(frozen=True)
class MarsTime:
    """Mars24 quantities at one UTC instant (units in field names)."""

    utc: datetime
    jd_ut: float
    tt_minus_utc_s: float
    jd_tt: float
    dt_j2000: float
    mean_anomaly_deg: float
    alpha_fms_deg: float
    pbs_deg: float
    nu_minus_m_deg: float
    ls_deg: float
    mars_year: int
    eot_deg: float
    msd: float
    mtc_h: float  # MST at the prime meridian (Coordinated Mars Time)
    subsolar_lon_west_deg: float
    declination_deg: float
    helio_dist_au: float


def mars_time(utc: datetime) -> MarsTime:
    utc = _aware(utc)
    jd_ut, tt_utc, dt = _dt_j2000(utc)  # A-1..A-6
    m, alpha, pbs, nu_m = _orbit(dt)
    ls_unwrapped = alpha + nu_m  # B-5
    ls = ls_unwrapped % 360.0
    eot = 2.861 * _sin(2 * ls) - 0.071 * _sin(4 * ls) + 0.002 * _sin(6 * ls) - nu_m  # C-1
    msd = (dt - 4.5) / SOL_IN_DAYS + 44796.0 - 0.0009626  # C-2 ((JD_TT - 2451549.5)/...)
    mtc = (24.0 * msd) % 24.0
    subsolar_w = (mtc * 15.0 + eot + 180.0) % 360.0  # C-5
    dec = math.degrees(math.asin(0.42565 * _sin(ls))) + 0.25 * _sin(ls)  # D-1
    r = 1.52367934 * (1.00436 - 0.09309 * _cos(m) - 0.004336 * _cos(2 * m)
                      - 0.00031 * _cos(3 * m) - 0.00003 * _cos(4 * m))  # D-2
    return MarsTime(
        utc=utc, jd_ut=jd_ut, tt_minus_utc_s=tt_utc, jd_tt=_J2000 + dt, dt_j2000=dt,
        mean_anomaly_deg=m % 360.0, alpha_fms_deg=alpha % 360.0, pbs_deg=pbs,
        nu_minus_m_deg=nu_m, ls_deg=ls,
        mars_year=math.floor(ls_unwrapped / 360.0) + _mars_year_offset(),
        eot_deg=eot, msd=msd, mtc_h=mtc, subsolar_lon_west_deg=subsolar_w,
        declination_deg=dec, helio_dist_au=r,
    )


def lmst_h(utc: datetime, lon_east_deg: float) -> float:
    """C-3: local mean solar time, hours in [0, 24)."""
    return (mars_time(utc).mtc_h + lon_east_deg / 15.0) % 24.0


def ltst_h(utc: datetime, lon_east_deg: float) -> float:
    """C-4: local true solar time = LMST + EOT/15, hours in [0, 24)."""
    mt = mars_time(utc)
    return (mt.mtc_h + lon_east_deg / 15.0 + mt.eot_deg / 15.0) % 24.0


def local_msd(utc: datetime, lon_east_deg: float) -> float:
    """Mars Sol Date shifted to local mean time (its integer part numbers the local sol)."""
    return mars_time(utc).msd + lon_east_deg / 360.0


def msl_sol(utc: datetime, lon_east_deg: float) -> int:
    """Curiosity mission sol at ``lon_east_deg``: landing sol (config clock.msl_landing_utc) = 0."""
    landing = parse_utc(str(load_conditions()["clock"]["msl_landing_utc"]))
    return math.floor(local_msd(utc, lon_east_deg)) - math.floor(local_msd(landing, lon_east_deg))


def utc_at_lmst(ref_utc: datetime, lmst_hours: float, lon_east_deg: float) -> datetime:
    """UTC at which the local sol containing ``ref_utc`` reaches ``lmst_hours`` (exact inverse)."""
    ref = mars_time(ref_utc)
    target = (math.floor(ref.msd + lon_east_deg / 360.0) + lmst_hours / 24.0
              - lon_east_deg / 360.0)
    dt = (target - 44796.0 + 0.0009626) * SOL_IN_DAYS + 4.5
    unix_s = (dt - (_UNIX_JD - _J2000)) * 86400.0 - ref.tt_minus_utc_s
    return datetime.fromtimestamp(unix_s, tz=UTC)


def utc_at_ltst(ref_utc: datetime, ltst_hours: float, lon_east_deg: float) -> datetime:
    """UTC at which the local sol containing ``ref_utc`` reaches true solar time ``ltst_hours``."""
    u = utc_at_lmst(ref_utc, ltst_hours, lon_east_deg)
    for _ in range(4):  # EOT changes < 0.1 deg per sol: converges in 2-3 steps
        u = utc_at_lmst(ref_utc, (ltst_hours - mars_time(u).eot_deg / 15.0) % 24.0, lon_east_deg)
    return u


def format_hms(hours: float) -> str:
    """Hours -> ``HH:MM:SS`` (rounded to the second, wraps at 24 h)."""
    s = round(hours * 3600.0) % 86400
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


__all__ = [
    "MarsTime", "mars_time", "lmst_h", "ltst_h", "local_msd", "msl_sol", "utc_at_lmst",
    "utc_at_ltst", "format_hms", "tt_minus_utc_s", "SOL_IN_DAYS",
]
