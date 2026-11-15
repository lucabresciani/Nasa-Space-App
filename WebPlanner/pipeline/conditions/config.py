"""Config access for WS4 (AGENTS.md rule 2: every constant comes from config/)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any

import yaml

REPO = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO / "config"
RAW = REPO / "data" / "raw" / "conditions"
INTERIM = REPO / "data" / "interim"

PENDING = "verify_at_h0"


class ConfigPending(RuntimeError):
    """A config value is still the ``verify_at_h0`` placeholder."""


@cache
def load(name: str) -> dict[str, Any]:
    return yaml.safe_load((CONFIG_DIR / f"{name}.yaml").read_text())


def load_conditions() -> dict[str, Any]:
    return load("conditions")


def h0_utc() -> datetime:
    return parse_utc(str(load("event")["h0_utc"]))


PAD_JSON = INTERIM / "engine" / "public" / "pad.json"


def pad_site(pad_json: Path | None = None) -> dict[str, Any]:
    """The pad the sun is computed at (D21): ``pad.json`` top-level ``pad`` (WS2's official pad).

    Falls back to ``config/site.yaml pad_default`` only if ``pad.json`` is missing, and says so
    (``fallback`` true, ``note``). A ``pad.json`` without a ``pad`` lat/lon raises (no silent
    fallback). Returns {lat, lon, id, source, fallback, note}.
    """
    ck = load_conditions()["clock"]
    if ck["site"] != "data/interim/engine/public/pad.json pad":
        raise NotImplementedError("clock.site must be 'data/interim/engine/public/pad.json pad'")
    path = PAD_JSON if pad_json is None else Path(pad_json)
    if path.exists():
        pad = json.loads(path.read_text())["pad"]
        return {"lat": float(pad["lat"]), "lon": float(pad["lon"]), "id": pad.get("id"),
                "source": "data/interim/engine/public/pad.json pad (D21 official pad)",
                "fallback": False, "note": None}
    if ck["site_fallback"] != "config/site.yaml pad_default":
        raise NotImplementedError("clock.site_fallback must be 'config/site.yaml pad_default'")
    pd = load("site")["pad_default"]
    return {"lat": float(pd["lat"]), "lon": float(pd["lon"]), "id": "pad_default",
            "source": "config/site.yaml pad_default (fallback)", "fallback": True,
            "note": (f"{path.name} missing ({path}): fell back to site.yaml pad_default; "
                     "not the D21 official pad")}


def site_latlon() -> tuple[float, float]:
    """(lat, lon_east) of the pad for the sun (``pad_site()``)."""
    s = pad_site()
    return s["lat"], s["lon"]


def eva_min() -> float:
    """Simulated EVA length in minutes (config/crew.yaml eva_h)."""
    return 60.0 * float(load("crew")["eva_h"])


def require(value: Any, what: str) -> Any:
    if value == PENDING:
        raise ConfigPending(f"config {what} is '{PENDING}'; fill it from docs/discovery.md")
    return value


def parse_utc(text: str) -> datetime:
    """ISO 8601 with Z or offset -> aware UTC datetime; naive input is refused."""
    t = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    if t.tzinfo is None:
        raise ValueError(f"timestamp without timezone: {text!r}")
    return t.astimezone(UTC)


def fmt_utc(t: datetime) -> str:
    """Aware datetime -> ``YYYY-MM-DDTHH:MM:SSZ`` (rounded to the second)."""
    t = t.astimezone(UTC)
    if t.microsecond >= 500_000:
        t = t + timedelta(microseconds=1_000_000 - t.microsecond)
    return t.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def reset_manifest_fragment(script_file: str, fragment_dir: Any = None) -> None:
    """Delete ``script_file``'s manifest fragment before it re-records all of its keys, so keys
    dropped from an output (e.g. the D37 REMS row) do not linger with an old commit."""
    from pipeline.provenance import manifest  # noqa: PLC0415

    d = manifest._fragment_dir(fragment_dir)
    (d / manifest._fragment_name(manifest._rel(script_file))).unlink(missing_ok=True)
