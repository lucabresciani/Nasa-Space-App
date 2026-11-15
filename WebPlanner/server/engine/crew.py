"""Custom crew (WS11 brief task 11, plan row 3.2; F26): engine overrides and the crew hash.

Every number comes from pipeline/engine (WS11 rule 1); nothing here computes physiology.

- **Overrides.** The plan_inputs crew fields that ``pipeline.engine.physio.CREW_KEYS`` names
  (body_mass_kg, tools_kg, vo2max_ml_kg_min, effort_cap_frac) reach the engine through the
  committed crew-as-parameter path: ``build_plan(crew=...)`` -> ``physio.params(crew=...)``
  (WS2 PR #4). ``overrides`` returns None for the default crew, so a default-crew plan makes
  exactly the build_plan call it made before this package (byte-identical trees, same hash).
- **Not overridable yet.** ``crew.suit_kg``: build_plan takes the suit only through scenario
  ids ({variant}_{suit}, an integer) and routes, partners and cards only the variants.yaml
  default scenario, so a suit other than crew.default_suit_kg has no build_plan path
  (``unsupported``; the job fails naming it, never silently ignoring it).
- **Crew hash.** sha256 over the four engine crew values (physio.crew_values: config values for
  the ones not given) and the engine identity (engine tree, config hash, terrain hash; D57), so
  a cache entry never outlives the engine or the data it was computed with.
- **No station-field cache (D84).** build_plan / traverse.plan take no precomputed station
  fields (E8 hand-off), so the route inside build_plan runs its own station searches with the
  crew. The E10 cache ($HL_SERVER_DATA/cache/station_fields/{crew_hash}/) cost ~42 s and
  ~280 MB per new crew for nothing and was removed; ``crew_hash`` stays as the key a future
  cache (once WS2 adds a station-field input) will use.
"""

from __future__ import annotations

import hashlib
import json

from server.engine.hashing import EngineIdentity, canonical_inputs, engine_identity, official_inputs


# ------------------------------------------------------------------------ inputs ----
def _crew(inputs: dict) -> dict:
    return canonical_inputs(inputs)["crew"]


def _default_crew() -> dict:
    return canonical_inputs(official_inputs())["crew"]


def engine_keys() -> tuple[str, ...]:
    """The plan_inputs crew fields build_plan takes (physio.CREW_KEYS, same names)."""
    from pipeline.engine.physio import CREW_KEYS

    return tuple(CREW_KEYS)


def is_default(inputs: dict) -> bool:
    return _crew(inputs) == _default_crew()


def overrides(inputs: dict) -> dict | None:
    """build_plan's ``crew`` argument: None for the default crew (the call stays as it was),
    else every engine crew value of the canonical inputs."""
    c = _crew(inputs)
    if c == _default_crew():
        return None
    return {k: c[k] for k in engine_keys()}


def unsupported(inputs: dict) -> list[str]:
    """Dotted crew fields that differ from the defaults but have no build_plan path."""
    c, d = _crew(inputs), _default_crew()
    keys = set(engine_keys())
    return [f"crew.{k}" for k in sorted(set(c) | set(d)) if k not in keys and c.get(k) != d.get(k)]


def crew_hash(crew: dict | None, identity: EngineIdentity | None = None) -> str:
    """16 hex chars: the engine crew values (config values filled in) + the engine identity."""
    from pipeline.engine.physio import crew_values

    ident = EngineIdentity(*(identity or engine_identity()))
    values = {k: round(float(v), 6) + 0.0 for k, v in crew_values(crew).items()}
    doc = {"crew": values, **ident._asdict()}
    payload = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]
