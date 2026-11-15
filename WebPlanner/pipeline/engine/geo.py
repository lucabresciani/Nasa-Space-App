"""Analysis-CRS -> lon/lat output helpers and contract validation for engine products."""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

import numpy as np
import shapely
from jsonschema import Draft202012Validator
from pyproj import Transformer
from shapely.geometry import mapping

from .config import REPO, load

CONTRACTS = REPO / "contracts"
DECIMALS = 6  # SPEC §6: lon/lat with 6 decimals


def geo_crs() -> str:
    """Mars 2000 planetocentric lon/lat on the sphere from site.yaml."""
    return f"+proj=longlat +R={load('site')['crs']['mars_radius_m']} +no_defs"


@cache
def _to_lonlat(src_crs: str) -> Transformer:
    return Transformer.from_crs(src_crs, geo_crs(), always_xy=True)


@cache
def _to_xy(dst_crs: str) -> Transformer:
    return Transformer.from_crs(geo_crs(), dst_crs, always_xy=True)


def lonlat_of_xy(x, y, src_crs: str):
    return _to_lonlat(src_crs).transform(x, y)


def xy_of_lonlat(lon, lat, dst_crs: str):
    return _to_xy(dst_crs).transform(lon, lat)


def _round(obj):
    if isinstance(obj, float):
        return round(obj, DECIMALS)
    if isinstance(obj, (list, tuple)):
        return [_round(v) for v in obj]
    return obj


def feature_collection(items, src_crs: str) -> dict:
    """[(shapely geometry in analysis CRS, properties)] -> lon/lat GeoJSON FeatureCollection."""
    tr = _to_lonlat(src_crs)
    feats = []
    for geom, props in items:
        if geom is None or geom.is_empty:
            continue
        g = mapping(shapely.transform(geom, lambda c: np.column_stack(tr.transform(*c.T))))
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": g["type"], "coordinates": _round(g["coordinates"])},
                "properties": props,
            }
        )
    return {"type": "FeatureCollection", "features": feats}


@cache
def _validator(schema: str) -> Draft202012Validator:
    return Draft202012Validator(json.loads((CONTRACTS / schema).read_text(encoding="utf-8")))


def validate(obj, schema: str) -> None:
    """Raise jsonschema.ValidationError if obj does not satisfy contracts/{schema}."""
    _validator(schema).validate(obj)


def write_json(path: Path, obj, schema: str | None) -> Path:
    """Validate against the contract (if any) and write compact JSON."""
    if schema is not None:
        validate(obj, schema)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    return path
