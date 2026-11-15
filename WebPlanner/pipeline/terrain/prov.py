"""Provenance for WS1 (AGENTS.md rule 6): a thin wrapper over WS6's ``manifest.record``.

Entries go to WS6's per-script fragment (``data/interim/manifest/pipeline__terrain__build.json``
for build.py). The only WS1 addition: a non-finite value (NaN/inf, which ``record`` refuses) is
recorded as None, i.e. unknown (rule 7), never dropped. The old bridge file
``data/interim/terrain/manifest_pending.json`` is retired.
"""

from __future__ import annotations

import math
from pathlib import Path

from pipeline.provenance.manifest import record as _ws6_record

REPO = Path(__file__).resolve().parents[2]


def _clean(v):
    if hasattr(v, "item") and getattr(v, "ndim", 0) == 0:
        v = v.item()
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def record(key: str, value, units, file, script) -> dict:
    return _ws6_record(key, _clean(value), units, str(file), str(script))
