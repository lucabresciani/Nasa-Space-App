"""Config access for WS3. Every constant comes from config/horizon.yaml or config/site.yaml."""

from __future__ import annotations

from functools import cache
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO / "config"


@cache
def _yaml(name: str) -> dict:
    return yaml.safe_load((CONFIG_DIR / f"{name}.yaml").read_text())


def load() -> dict:
    """config/horizon.yaml as a dict (do not mutate)."""
    return _yaml("horizon")


def site() -> dict:
    return _yaml("site")


def stations_cfg() -> dict:
    """config/stations.yaml (WS1); read only."""
    return _yaml("stations")


def landmarks_cfg() -> dict:
    return _yaml("landmarks")


def mars_radius_m() -> float:
    """Mars 2000 sphere radius (site.yaml crs.mars_radius_m); used for the curvature drop."""
    return float(site()["crs"]["mars_radius_m"])


def analysis_proj() -> str:
    return site()["crs"]["analysis_proj"]


def distance_classes_m() -> tuple[float, float]:
    lo, hi = load()["distance_classes_km"]
    return float(lo) * 1000.0, float(hi) * 1000.0


def value(entry):
    """Unwrap ``{value: x, assumed: true}`` config entries; plain values pass through."""
    return entry["value"] if isinstance(entry, dict) and "value" in entry else entry
