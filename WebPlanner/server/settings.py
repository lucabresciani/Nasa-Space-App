"""config/backend.yaml loader with validation (backend D48; owner WS12, bootstrap by C).

Every limit, range and timeout the server uses comes from here (AGENTS.md rule 2). Keys ending in
``_ref`` point into another config file ("crew.body_mass_kg") and are resolved at load time, so a
default lives in exactly one place; a reference to a missing file or key is refused. Unknown keys
are refused at every level, so a typo cannot silently fall back to a default.

backend.yaml is not an engine input: it is left out of the engine config hash (D57,
``tools/make_bundle.NON_ENGINE_CONFIG``), so changing a limit never invalidates a computed plan.
"""

from __future__ import annotations

import re
from datetime import datetime
from functools import cache
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

REPO = Path(__file__).resolve().parents[1]
CONFIG_DIR = REPO / "config"
BACKEND_FILE = "backend.yaml"

# Crockford base32: digits and capitals without I, L, O, U (D55/K4).
CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ALPHABETS = {"crockford32": CROCKFORD32}

_REF = re.compile(r"^([a-z][a-z0-9_]*)((?:\.[A-Za-z0-9_]+)+)$")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _aware_iso(v: str) -> str:
    """An ISO 8601 date-time with a UTC offset (kept as the string the config holds)."""
    if datetime.fromisoformat(v).tzinfo is None:
        raise ValueError(f"{v!r} has no UTC offset")
    return v


AwareIso = Annotated[str, AfterValidator(_aware_iso)]


class Api(_Strict):
    prefix: str = Field(pattern=r"^/[a-z0-9/]*[a-z0-9]$")
    health_timeout_s: float = Field(gt=0)
    cors_origins: list[str]
    docs_path: str = Field(pattern=r"^/")

    @field_validator("cors_origins")
    @classmethod
    def _origins(cls, v: list[str]) -> list[str]:
        for o in v:  # an origin is scheme://host[:port], no path or trailing slash
            if not re.fullmatch(r"https?://[^/\s]+", o):
                raise ValueError(f"not a CORS origin: {o!r}")
        return v


class HashCfg(_Strict):
    algo: Literal["sha256"]
    hex_chars: int = Field(ge=8, le=64)
    exclude_config: list[str]

    @field_validator("exclude_config")
    @classmethod
    def _excludes_self(cls, v: list[str]) -> list[str]:
        if BACKEND_FILE not in v:  # D57
            raise ValueError(f"{BACKEND_FILE} must be excluded from the engine config hash (D57)")
        return v


class Compute(_Strict):
    workers: int = Field(ge=1)
    queue_max_waiting: int = Field(ge=0)
    job_timeout_s: float = Field(gt=0)
    hash: HashCfg


class Cache(_Strict):
    dir: str
    max_gb: float = Field(gt=0)
    policy: Literal["lru"]
    pinned: list[str]


class Window(_Strict):
    count: int = Field(ge=1)
    window_min: float = Field(gt=0)


class Limits(_Strict):
    guest_heavy_jobs: Window
    user_heavy_jobs: Window
    telemetry_posts_per_s: float = Field(gt=0)
    upload_max_bytes: int = Field(ge=1)
    telemetry_max_samples: int = Field(ge=1)
    ip_hash_retention_days: int = Field(ge=1)
    title_max_chars: int = Field(ge=1)
    notes_max_chars: int = Field(ge=1)
    # reverse-proxy body cap (server/ops Caddy); assumed (O3); a backstop, never below the upload
    proxy_max_body_bytes: int = Field(ge=1)

    @model_validator(mode="after")
    def _proxy_cap_above_upload(self):
        if self.proxy_max_body_bytes < self.upload_max_bytes:
            raise ValueError("limits.proxy_max_body_bytes must be >= limits.upload_max_bytes")
        return self


class Range(_Strict):
    min: float
    max: float
    default: float | list[float] | None = None
    precomputed: list[float] | None = None
    assumed: bool | None = None

    @model_validator(mode="after")
    def _consistent(self):
        if self.min > self.max:
            raise ValueError(f"range min {self.min} > max {self.max}")
        defaults = self.default if isinstance(self.default, list) else [self.default]
        for v in [*defaults, *(self.precomputed or [])]:
            if v is not None and not self.contains(v):
                raise ValueError(f"{v} outside its range [{self.min}, {self.max}]")
        return self

    def contains(self, v: float) -> bool:
        return self.min <= v <= self.max


class Ranges(_Strict):
    """F26 (crew) and F25 (route) input ranges; inputs outside are refused."""

    body_mass_kg: Range
    suit_kg: Range
    tools_kg: Range
    vo2max_ml_kg_min: Range
    effort_cap_frac: Range
    walkback_budget_min: Range
    d_allow_mgy: Range
    dwell_min: Range
    eva_duration_h: Range
    start_lmst_h: Range
    reserve_min: Range  # plan_inputs eva.reserve_min (S2b, decision 10)
    user_points_max: int = Field(ge=0)
    anchored_flag_note: str

    def items(self) -> list[tuple[str, Range]]:
        return [(k, v) for k in type(self).model_fields if isinstance(v := getattr(self, k), Range)]

    def __getitem__(self, key: str) -> Range:
        v = getattr(self, key, None)
        if not isinstance(v, Range):
            raise KeyError(key)
        return v


class Route(_Strict):
    """D97 waypoint block: limits on plan_inputs route (all assumed)."""

    max_stops: int = Field(ge=1)
    max_free_points: int = Field(ge=0)
    min_stop_spacing_m: float = Field(gt=0)

    @model_validator(mode="after")
    def _free_within_stops(self):
        if self.max_free_points > self.max_stops:
            raise ValueError("route.max_free_points must be <= route.max_stops")
        return self


class Pads(_Strict):
    rule: dict[str, Any]  # resolved from site.siting (D21 rule)

    @field_validator("rule")
    @classmethod
    def _has_slope(cls, v: dict[str, Any]) -> dict[str, Any]:
        if "max_slope_deg" not in v or "block_m" not in v:
            raise ValueError("pads.rule must resolve to the siting rule (max_slope_deg, block_m)")
        return v


class ShareCode(_Strict):
    """Share code = prefix + `chars` characters of `alphabet` (D55: "HL-" + 6 Crockford base32)."""

    prefix: str = Field(pattern=r"^[A-Z0-9]+-$")
    chars: int = Field(ge=4, le=16)
    alphabet: str  # a name in ALPHABETS in the YAML; the characters after loading

    @field_validator("alphabet", mode="before")
    @classmethod
    def _named(cls, v: Any) -> str:
        if v not in ALPHABETS:
            raise ValueError(f"unknown share-code alphabet {v!r} (known: {sorted(ALPHABETS)})")
        return ALPHABETS[v]

    def pattern(self) -> str:
        """Anchored regex of a canonical share code, e.g. ``^HL-[0-9A-HJKMNP-TV-Z]{6}$``."""
        return f"^{self.prefix}[{_char_class(self.alphabet)}]{{{self.chars}}}$"

    def matches(self, code: str) -> bool:
        return re.fullmatch(self.pattern(), code) is not None


def _char_class(alphabet: str) -> str:
    """Characters as a regex class body: runs of 3 or more consecutive code points become a-z."""
    cps, out, i = sorted(set(map(ord, alphabet))), [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        run = [chr(c) for c in cps[i:j + 1]]
        out.append(f"{run[0]}-{run[-1]}" if len(run) >= 3 else "".join(run))
        i = j + 1
    return "".join(out)


class Plans(_Strict):
    versions_kept: int = Field(ge=1)
    share_code: ShareCode
    visibility: list[Literal["private", "link"]]


class Sessions(_Strict):
    telemetry_hz: float = Field(gt=0)
    commands: list[str]
    message_max_chars: int = Field(ge=1)


class Toggle(_Strict):
    enabled: bool
    every_h: float = Field(gt=0)


class Parity(_Strict):
    geojson_decimals: int = Field(ge=0)
    preview_vs_full_rel: float = Field(ge=0)
    replay_margin_tol_min: float = Field(ge=0)
    bundle_frame_roundtrip_m: float = Field(ge=0)


class Labels(_Strict):
    live: str
    precomputed: str
    offline: str
    user_station: str


class Deploy(_Strict):
    no_deploy_after: AwareIso  # resolved from event.deadline_local
    parity_blocks_deploy: bool
    kill_switch_env: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")


class Gates(_Strict):
    """Backend gates (D50, CET); `freeze` is resolved from event.gates_local.freeze."""

    P0: AwareIso
    B0: AwareIso
    B1: AwareIso
    B2: AwareIso
    B3: AwareIso
    freeze: AwareIso

    @model_validator(mode="after")
    def _ordered(self):
        times = [datetime.fromisoformat(getattr(self, k)) for k in type(self).model_fields]
        if times != sorted(times):
            raise ValueError("gates out of order (P0 < B0 < B1 < B2 < B3 < freeze)")
        return self


class BackendConfig(_Strict):
    contract_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    api: Api
    compute: Compute
    cache: Cache
    limits: Limits
    ranges: Ranges
    route: Route
    pads: Pads
    plans: Plans
    sessions: Sessions
    conditions_refresh: Toggle
    parity: Parity
    labels: Labels
    deploy: Deploy
    gates_local: Gates
    assumed: list[str]

    @model_validator(mode="after")
    def _assumed_exist(self):
        for path in self.assumed:  # every "assumed" entry names a real key
            node: Any = self
            for part in path.split("."):
                if not isinstance(node, BaseModel) or part not in type(node).model_fields:
                    raise ValueError(f"assumed: {path!r} is not a key of backend.yaml")
                node = getattr(node, part)
        return self


# ------------------------------------------------------------------------------ references ----
def _lookup(ref: str, config_dir: Path) -> Any:
    """Value of "<file>.<key>[.<key>...]" in config_dir/<file>.yaml.

    A missing file raises FileNotFoundError, a missing key KeyError, a malformed ref ValueError."""
    m = _REF.match(ref)
    if not m:
        raise ValueError(f"config reference {ref!r} is not '<file>.<key>[.<key>...]'")
    name, path = m.group(1), m.group(2)[1:]
    if f"{name}.yaml" == BACKEND_FILE:
        raise ValueError(f"config reference {ref!r} points into {BACKEND_FILE} itself")
    f = config_dir / f"{name}.yaml"
    if not f.is_file():
        raise FileNotFoundError(f"config reference {ref!r}: no file {f}")
    node: Any = yaml.safe_load(f.read_text(encoding="utf-8"))
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            raise KeyError(f"config reference {ref!r}: {part!r} not found in {f.name}")
        node = node[part]
    return node


def _resolve(node: Any, config_dir: Path) -> Any:
    """Replace every `<key>_ref: "file.path"` by `<key>: value` (recursively)."""
    if isinstance(node, list):
        return [_resolve(v, config_dir) for v in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for k, v in node.items():
        if isinstance(k, str) and k.endswith("_ref"):
            key = k[: -len("_ref")]
            if not isinstance(v, str):
                raise ValueError(f"{k}: a reference must be a string, got {v!r}")
            if key in node:
                raise ValueError(f"both {key!r} and {k!r} given; a default lives in one place")
            out[key] = _lookup(v, config_dir)
        else:
            out[k] = _resolve(v, config_dir)
    return out


def load(config_dir: Path = CONFIG_DIR) -> BackendConfig:
    """Load and validate config_dir/backend.yaml with every `*_ref` resolved."""
    raw = yaml.safe_load((config_dir / BACKEND_FILE).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{BACKEND_FILE} must be a mapping")
    return BackendConfig.model_validate(_resolve(raw, config_dir))


@cache
def settings() -> BackendConfig:
    """The repo's backend config (cached; read-only)."""
    return load()
