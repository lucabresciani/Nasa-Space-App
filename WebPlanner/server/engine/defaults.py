"""GET /defaults (F24-F26): default plan inputs, ranges, stations, official and picker pads.

Every value comes from config or the published data tree; nothing is typed here:
- ranges and the crew/walkback/dose defaults: config/backend.yaml ``ranges`` via server.settings
  (its ``default_ref``s resolve to crew.yaml);
- the remaining per-plan defaults: the config keys the engine itself reads (``DEFAULT_REFS``);
- pad, stations and pads: web/public/data (``scenarios/pads/index.json`` row with official: true,
  ``stations.json``).
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

from pipeline.engine.config import load as load_config
from server.settings import BackendConfig, settings

REPO = Path(__file__).resolve().parents[2]
STATIC_DATA = REPO / "web" / "public" / "data"
PADS_INDEX = "scenarios/pads/index.json"
STATIONS = "stations.json"

# plan_inputs crew field <- config/backend.yaml ranges key (same names; default_ref -> crew.yaml)
CREW_FIELDS = ("body_mass_kg", "suit_kg", "tools_kg", "vo2max_ml_kg_min", "effort_cap_frac")

# plan_inputs field <- "<config file>.<key path>", the value the engine uses when it is omitted
DEFAULT_REFS = {
    ("eva", "duration_h"): "crew.eva_h",  # D28 EVA budget (pipeline/engine/margin.py)
    ("eva", "reserve_min"): "crew.o2_margin.reserve_min_at_effort_cap",  # D24 (margin.py)
    ("eva", "start_lmst_h"): "conditions.clock.eva_start_lmst_h",  # D31
    ("conditions", "tripwire_at"): "conditions.storm_replay.tripwire_at",  # D39
}
# The default dose timing is the timed storm replay (D39; pipeline/engine/scenarios.py --dose
# storm): the plan_inputs enum value of the 20 May 2024 storm.
DEFAULT_STORM = "2024-05-20"
DEFAULT_STATION_MODE = "best"  # F25: exact DP over all stations, as F9 and the precomputed plan


def _ref(ref: str):
    name, *path = ref.split(".")
    node = load_config(name)
    for part in path:
        node = node[part]
    return node


def _json(rel: str):
    return json.loads((STATIC_DATA / rel).read_text(encoding="utf-8"))


@cache
def pads() -> list[dict]:
    """Official and picker pads, as scenarios/pads/index.json pads."""
    return [p for p in _json(PADS_INDEX)["pads"] if p.get("official") or p.get("picker")]


@cache
def stations() -> list[dict]:
    return _json(STATIONS)


def official_pad() -> dict:
    rows = [p for p in pads() if p.get("official")]
    if len(rows) != 1:
        raise ValueError(f"{PADS_INDEX} must have exactly one official pad, found {len(rows)}")
    return {"id": rows[0]["id"], "lon": rows[0]["lon"], "lat": rows[0]["lat"]}


def default_inputs(cfg: BackendConfig | None = None) -> dict:
    """plan_inputs with every default filled in (contracts/backend/plan_inputs.schema.json)."""
    cfg = cfg or settings()
    r = cfg.ranges
    inputs: dict = {
        "contract_version": cfg.contract_version,
        "pad": official_pad(),
        "crew": {k: r[k].default for k in CREW_FIELDS},
        "eva": {"walkback_budgets_min": list(r["walkback_budget_min"].default)},
        "stations": {"mode": DEFAULT_STATION_MODE},
        "conditions": {"storm": DEFAULT_STORM, "d_allow_mgy": r["d_allow_mgy"].default},
    }
    for (block, field), ref in DEFAULT_REFS.items():
        inputs[block][field] = _ref(ref)
    return inputs


def ranges(cfg: BackendConfig | None = None) -> dict:
    """config/backend.yaml ranges with the defaults resolved."""
    return (cfg or settings()).ranges.model_dump(exclude_none=True)


def defaults() -> dict:
    """The /defaults body (openapi.yaml Defaults)."""
    return {"inputs": default_inputs(), "ranges": ranges(), "stations": stations(),
            "pads": pads()}
