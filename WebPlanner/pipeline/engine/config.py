"""Config access for the engine. Every constant comes from config/*.yaml (AGENTS.md rule 2)."""

from __future__ import annotations

from functools import cache
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO / "config"
INTERIM_DIR = REPO / "data" / "interim"
ENGINE_DIR = INTERIM_DIR / "engine"


@cache
def load(name: str) -> dict:
    """Return the parsed config/{name}.yaml (cached; treat as read-only)."""
    with open(CONFIG_DIR / f"{name}.yaml", encoding="utf-8") as fh:
        return yaml.safe_load(fh)
