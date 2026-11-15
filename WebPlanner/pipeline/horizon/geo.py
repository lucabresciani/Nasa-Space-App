"""Coordinates for WS3: Mars 2000 planetocentric lon/lat <-> analysis CRS (site.yaml), bearings.

The analysis CRS is equirectangular (lat_ts -4.8, lon_0 137.39) on the Mars 2000 sphere. Grid
north is true north; within the 80 km horizon window the east-west scale differs from true by
cos(lat_ts)/cos(lat) <= 0.2 %, so ray azimuths in grid coordinates are true bearings to < 0.1 deg.
"""

from __future__ import annotations

import math
from functools import cache

from pyproj import Transformer

from pipeline.horizon import config as hcfg


def geographic_proj() -> str:
    return f"+proj=longlat +R={hcfg.mars_radius_m():.0f} +no_defs"


@cache
def _fwd() -> Transformer:
    return Transformer.from_crs(geographic_proj(), hcfg.analysis_proj(), always_xy=True)


@cache
def _inv() -> Transformer:
    return Transformer.from_crs(hcfg.analysis_proj(), geographic_proj(), always_xy=True)


def lonlat_to_xy(lon, lat):
    """Planetocentric lon (E) / lat -> analysis-CRS (x east, y north) in metres."""
    return _fwd().transform(lon, lat)


def xy_to_lonlat(x, y):
    return _inv().transform(x, y)


def bearing_dist(xy_from, xy_to) -> tuple[float, float]:
    """Grid bearing (deg clockwise from north) and horizontal distance (m) in the analysis CRS."""
    dx = float(xy_to[0]) - float(xy_from[0])
    dy = float(xy_to[1]) - float(xy_from[1])
    return math.degrees(math.atan2(dx, dy)) % 360.0, math.hypot(dx, dy)


def great_circle(lon1, lat1, lon2, lat2) -> tuple[float, float]:
    """Initial bearing (deg) and great-circle distance (m) on the Mars 2000 sphere."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    d = 2 * hcfg.mars_radius_m() * math.asin(math.sqrt(a))
    b = math.degrees(math.atan2(math.sin(dl) * math.cos(p2),
                                math.cos(p1) * math.sin(p2)
                                - math.sin(p1) * math.cos(p2) * math.cos(dl)))
    return b % 360.0, d

