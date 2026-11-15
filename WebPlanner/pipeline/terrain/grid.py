"""Analysis-CRS grids for the terrain stack (F1, F2; SPEC §4.2).

All WS1 rasters share one lattice anchored on ``site.yaml pad_default``: pixel *edges* sit at
``pad_xy + k * res`` (k integer) for every resolution, so the 1 m, 3 m, 5 m and 20 m grids nest
in the 1 m grid and WS8's pad-centred 256 m chunk grid reads ``dem_1m`` by index without
resampling. The pad itself lies on a pixel corner.

Extents (half-widths around the pad, rounded *up* to a whole number of cells):

* ``dem``      planning_radius_m + dem_window_buffer_m  (1 m: 7,800 px for 3,700 + 200)
* ``route``    planning_radius_m                         (3 m: 2,468 px)
* ``fields``   planning_radius_m                         (5 m: 1,480 px; contracts/README)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import yaml
from pyproj import Transformer

REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "config"
RAW = REPO / "data" / "raw" / "terrain"
OUT = REPO / "data" / "interim" / "terrain"


@cache
def site() -> dict:
    return yaml.safe_load((CONFIG / "site.yaml").read_text())


@cache
def stations_cfg() -> dict:
    return yaml.safe_load((CONFIG / "stations.yaml").read_text())


def analysis_crs() -> str:
    return site()["crs"]["analysis_proj"]


def geo_crs() -> str:
    return f"+proj=longlat +R={site()['crs']['mars_radius_m']} +no_defs"


#: CRS of every D0 source (merged DEM, HiRISE, CTX, CRISM, MMGIS easting/northing):
#: equirectangular, clon 0, standard parallel 0, sphere R (docs/discovery.md 2.1-2.7).
def source_crs() -> str:
    r = site()["crs"]["mars_radius_m"]
    return f"+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R={r} +units=m +no_defs"


@cache
def _tr(src: str, dst: str) -> Transformer:
    return Transformer.from_crs(src, dst, always_xy=True)


def xy_of_lonlat(lon, lat):
    return _tr(geo_crs(), analysis_crs()).transform(lon, lat)


def lonlat_of_xy(x, y):
    return _tr(analysis_crs(), geo_crs()).transform(x, y)


def pad_xy() -> tuple[float, float]:
    p = site()["pad_default"]
    x, y = xy_of_lonlat(p["lon"], p["lat"])
    return float(x), float(y)


@dataclass(frozen=True)
class Grid:
    """North-up grid: ``x0, y0`` = top-left corner (analysis CRS, m)."""

    x0: float
    y0: float
    res: float
    width: int
    height: int

    @property
    def transform(self):
        from rasterio.transform import Affine

        return Affine(self.res, 0.0, self.x0, 0.0, -self.res, self.y0)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """(west, south, east, north) in the analysis CRS."""
        return (self.x0, self.y0 - self.height * self.res, self.x0 + self.width * self.res,
                self.y0)

    @property
    def shape(self) -> tuple[int, int]:
        return (self.height, self.width)

    def rc_of_xy(self, x, y):
        import numpy as np

        c = np.floor((np.asarray(x) - self.x0) / self.res).astype(int)
        r = np.floor((self.y0 - np.asarray(y)) / self.res).astype(int)
        return r, c

    def xy_of_rc(self, r, c):
        """Cell-centre coordinates."""
        import numpy as np

        return (self.x0 + (np.asarray(c) + 0.5) * self.res,
                self.y0 - (np.asarray(r) + 0.5) * self.res)


def pad_grid(half_width_m: float, res: float, centre: tuple[float, float] | None = None) -> Grid:
    """Square grid of cells ``res`` with edges at centre + k*res covering centre +/- half_width."""
    cx, cy = centre if centre is not None else pad_xy()
    k = math.ceil(half_width_m / res - 1e-9)
    n = 2 * k
    return Grid(x0=cx - k * res, y0=cy + k * res, res=float(res), width=n, height=n)


def dem_grid() -> Grid:
    s = site()
    return pad_grid(s["planning_radius_m"] + s["dem_window_buffer_m"], s["grids_m"]["dem"])


def route_grid() -> Grid:
    s = site()
    return pad_grid(s["planning_radius_m"], s["grids_m"]["route"])


def fields_grid() -> Grid:
    s = site()
    return pad_grid(s["planning_radius_m"], s["grids_m"]["fields"])
