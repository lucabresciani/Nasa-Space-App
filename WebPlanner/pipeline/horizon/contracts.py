"""Validate WS3 outputs against contracts/*.schema.json (AGENTS.md rule 4)."""

from __future__ import annotations

import json
from functools import cache

from jsonschema import Draft202012Validator

from pipeline.horizon.config import REPO

CONTRACTS = REPO / "contracts"


@cache
def _validator(schema_name: str) -> Draft202012Validator:
    return Draft202012Validator(json.loads((CONTRACTS / schema_name).read_text()))


def validate(obj, schema_name: str, properties: list[str] | None = None) -> None:
    """Raise jsonschema.ValidationError if obj violates the schema.

    With ``properties``, validate only those top-level properties of an object schema (used for
    WS3's fragment of a station card, which other workstreams complete).
    """
    v = _validator(schema_name)
    if properties is None:
        v.validate(obj)
        return
    props = v.schema["properties"]
    for key in properties:
        Draft202012Validator(props[key]).validate(obj[key])
