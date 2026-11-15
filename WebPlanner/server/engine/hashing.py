"""Canonical plan inputs and the result hash (D57; plan row 1.2, WS11 task 2).

Rule (contracts/backend/README.md "Result hash"; config/backend.yaml ``compute.hash``)::

    hash = sha256(canonical_inputs + "\\0" + engine_tree + "\\0" + engine_config_hash
                  + "\\0" + terrain_hash)[:16]

``canonical_inputs`` is ``plan_inputs`` (contracts/backend/plan_inputs.schema.json), validated,
then:

- every default filled in: ``server.engine.defaults.default_inputs()`` (config/backend.yaml ranges,
  crew.yaml, conditions.yaml, the official pad), plus the station defaults it leaves implicit: the
  dwell of every station of stations.json (its ``dwell_min``, else ``stations.yaml dwell_min``, as
  ``pipeline.engine.stations`` writes it), the same default dwell for each user point, and no user
  points (``custom: []``). An omitted field and its explicit default therefore hash the same;
- ``title`` removed (D57) and ``pad.id`` removed (team-lead decision 11: the pad's lon/lat, which
  stay in, are what changes a result; a picked pad and the same point typed in hash the same);
- ``route`` (v1.2.0, D97): a missing route and ``mode: auto`` are the same plan and the route is
  removed, so every v1.1 hash (official, picker, cached results) is unchanged; an ``ordered`` route
  stays in with its stops in the given order (order changes the result) and each free point's
  ``label`` removed (D57, like ``title``);
- every number as a float rounded to 6 decimals, ``-0.0`` written as ``0.0`` (75 == 75.0);
- JSON with sorted keys, no spaces (``separators=(",", ":")``), UTF-8 (``ensure_ascii=False``).
  Floats are written by ``json.dumps`` (Python's shortest round-trip repr of the rounded value).

The engine identity is ``engine_tree`` (``git rev-parse HEAD:pipeline``) and ``config_hash``
(``tools.make_bundle.config_hash``, which leaves out backend.yaml, D57), both from
``server.engine.version.code_identity()``, and ``terrain_hash`` (sha256 of the server data
manifest, ``version.terrain_hash()``). Each part is used as the string /engine/version reports.

``result_hash(inputs, identity)`` is a pure function of its arguments and the config;
without ``identity`` it takes the live one. ``official_hash()`` is the hash of the official pad with
default inputs (plan row 1.3 maps it to the precomputed tree).
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from functools import cache
from pathlib import Path
from typing import NamedTuple

from jsonschema import Draft202012Validator

from pipeline.engine.config import load as load_config
from server.engine import version
from server.engine.defaults import default_inputs, stations
from server.settings import BackendConfig, settings

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "contracts" / "backend" / "plan_inputs.schema.json"
DECIMALS = 6  # contracts/backend/README.md "Result hash": floats rounded to 6 decimals
NOT_HASHED = (("title",), ("pad", "id"))  # D57 (title); team-lead decision 11 (pad.id)
SEP = "\0"


class InvalidPlanInputs(ValueError):
    """plan_inputs that do not validate against plan_inputs.schema.json (or hold NaN/inf)."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("invalid plan_inputs: " + "; ".join(errors))


class EngineIdentity(NamedTuple):
    engine_tree: str
    config_hash: str
    terrain_hash: str


@cache
def _validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def validate(plan_inputs) -> None:
    """Raise InvalidPlanInputs unless ``plan_inputs`` matches the contract (structure only; the
    config ranges are enforced where inputs are accepted, not here)."""
    errors = [f"{'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}"
              for e in sorted(_validator().iter_errors(plan_inputs), key=lambda e: e.json_path)]
    if errors:
        raise InvalidPlanInputs(errors)


def _merge(default: dict, given: dict) -> dict:
    """``given`` over ``default``; objects merge key by key, anything else is replaced."""
    out = dict(default)
    for k, v in given.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def _default_dwell(custom: list[dict]) -> dict:
    fallback = load_config("stations")["dwell_min"]
    dwell = {s["id"]: s.get("dwell_min", fallback) for s in stations()}
    dwell.update({p["id"]: fallback for p in custom})
    return dwell


def _normalise(node, path: str = ""):
    if isinstance(node, dict):
        return {k: _normalise(v, f"{path}/{k}" if path else k) for k, v in node.items()}
    if isinstance(node, list):
        return [_normalise(v, f"{path}/{i}") for i, v in enumerate(node)]
    if isinstance(node, bool) or node is None or isinstance(node, str):
        return node
    if isinstance(node, (int, float)):
        x = float(node)
        if not math.isfinite(x):
            raise InvalidPlanInputs([f"{path}: {node!r} is not a finite number"])
        return round(x, DECIMALS) + 0.0  # + 0.0 turns -0.0 into 0.0
    raise InvalidPlanInputs([f"{path}: unsupported value {node!r}"])


def canonical_inputs(plan_inputs: dict, cfg: BackendConfig | None = None) -> dict:
    """Validated plan_inputs with every default filled in, title and pad.id removed, numbers
    normalised (see the module docstring). The input is not changed."""
    validate(plan_inputs)
    given = copy.deepcopy(plan_inputs)
    defaults = default_inputs(cfg)
    defaults.pop("pad")  # pad is required: the given pad replaces it whole (never inherits an id)
    doc = _merge(defaults, given)
    st = doc["stations"]
    st.setdefault("custom", [])
    st["dwell_min"] = {**_default_dwell(st["custom"]), **st.get("dwell_min", {})}
    route = doc.get("route")
    if route is not None:
        if route.get("mode", "auto") == "auto":
            doc.pop("route")  # D97: missing route = auto; v1.1 hashes unchanged
        else:
            for stop in route.get("stops", []):
                stop.pop("label", None)  # D57: a label never changes a result
    for path in NOT_HASHED:
        parent = doc
        for key in path[:-1]:
            parent = parent.get(key, {})
        parent.pop(path[-1], None)
    doc = _normalise(doc)
    validate(doc)  # the filled document still meets the contract (catches a bad default)
    return doc


def canonical_json(plan_inputs: dict, cfg: BackendConfig | None = None) -> str:
    return json.dumps(canonical_inputs(plan_inputs, cfg), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)


def engine_identity() -> EngineIdentity:
    """The live identity; raises version.Unavailable without git or the server data manifest."""
    code = version.code_identity()
    terrain = version.terrain_hash()
    if terrain is None:
        raise version.Unavailable(
            f"no server data manifest at {version.server_data_dir() / version.SERVER_DATA_MANIFEST}"
            " (run `make serverdata`)")
    return EngineIdentity(code["engine_tree"], code["config_hash"], terrain)


def result_hash(plan_inputs: dict, identity: EngineIdentity | None = None,
                cfg: BackendConfig | None = None) -> str:
    """D57 result hash: lower-case hex, ``compute.hash.hex_chars`` long."""
    cfg = cfg or settings()
    ident = EngineIdentity(*(identity or engine_identity()))
    for name, part in ident._asdict().items():
        if not isinstance(part, str) or not part or SEP in part:
            raise ValueError(f"engine identity {name} must be a non-empty string without NUL")
    payload = SEP.join([canonical_json(plan_inputs, cfg), *ident]).encode("utf-8")
    return hashlib.new(cfg.compute.hash.algo, payload).hexdigest()[:cfg.compute.hash.hex_chars]


def official_inputs(cfg: BackendConfig | None = None) -> dict:
    """The official pad with default inputs (= GET /defaults ``inputs``)."""
    return default_inputs(cfg)


def official_hash(identity: EngineIdentity | None = None, cfg: BackendConfig | None = None) -> str:
    return result_hash(official_inputs(cfg), identity, cfg)
