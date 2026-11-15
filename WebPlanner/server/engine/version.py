"""Engine and code identity for GET /engine/version (F23, F35; D57 parts of the result hash).

- ``commit``: ``git rev-parse HEAD``; ``engine_tree``: ``git rev-parse HEAD:pipeline`` (D57).
  When ``HL_COMMIT`` and ``HL_ENGINE_TREE`` are set (the Docker image has no .git; server/ops/up.sh
  bakes them at build time) they are used instead of git. Both must be set and each must be exactly
  40 lower-case hex characters; anything else is an error (Unavailable -> 503
  engine_identity_unavailable), never a silent fall-back to git.
- ``config_hash``: ``tools.make_bundle.config_hash`` over config/*.yaml except backend.yaml (D57).
- ``terrain_hash``: sha256 of the server data manifest ``$HL_SERVER_DATA/manifest.json`` written
  by tools/make_serverdata.py (contracts/backend/README.md "Result hash"); None while it is absent.
- contract versions: backend = openapi.yaml ``info.version``; bundle =
  ``tools.make_bundle.CONTRACT_VERSION``; web = the newest ``x-contract-version`` of the top-level
  contracts/*.schema.json (contracts/README.md: a schema carries the version that last changed it).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from functools import cache
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
CONTRACTS = REPO / "contracts"
SERVER_DATA_ENV = "HL_SERVER_DATA"
SERVER_DATA_DEFAULT = "data/server"  # Makefile HL_SERVER_DATA default, relative to the repo
SERVER_DATA_MANIFEST = "manifest.json"  # written by tools/make_serverdata.py (WS11 task 5)
COMMIT_ENV = "HL_COMMIT"  # git rev-parse HEAD, baked into the image (server/ops/up.sh)
ENGINE_TREE_ENV = "HL_ENGINE_TREE"  # git rev-parse HEAD:pipeline, ditto
_OBJECT_ID = re.compile(r"[0-9a-f]{40}")  # a full SHA-1 git object id


class Unavailable(RuntimeError):
    """A part of the engine identity cannot be determined (reported, never invented)."""


def server_data_dir() -> Path:
    p = Path(os.environ.get(SERVER_DATA_ENV) or SERVER_DATA_DEFAULT)
    return p if p.is_absolute() else REPO / p


def terrain_hash() -> str | None:
    """sha256 of the server data manifest, or None when the server data are not built."""
    f = server_data_dir() / SERVER_DATA_MANIFEST
    if not f.is_file():
        return None
    return "sha256:" + hashlib.sha256(f.read_bytes()).hexdigest()


def _git(*args: str) -> str:
    try:
        out = subprocess.run(["git", *args], cwd=REPO, check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise Unavailable(f"git {' '.join(args)} failed: {e}") from e
    return out.stdout.strip()


def git_identity() -> tuple[str, str]:
    """(commit, engine_tree): from HL_COMMIT / HL_ENGINE_TREE when set, else from git.

    The error messages must not mention the manifest (the routes map that word to
    server_data_missing)."""
    env = {k: os.environ.get(k) for k in (COMMIT_ENV, ENGINE_TREE_ENV)}
    if all(v is None for v in env.values()):
        return _git("rev-parse", "HEAD"), _git("rev-parse", "HEAD:pipeline")
    missing = [k for k, v in env.items() if v is None]
    if missing:
        raise Unavailable(f"{COMMIT_ENV} and {ENGINE_TREE_ENV} must be set together;"
                          f" {missing[0]} is not set")
    bad = [k for k, v in env.items() if not _OBJECT_ID.fullmatch(v)]
    if bad:
        raise Unavailable(f"{', '.join(bad)} must be a 40 lower-case hex git object id"
                          f" (got {', '.join(repr(env[k]) for k in bad)})")
    return env[COMMIT_ENV], env[ENGINE_TREE_ENV]


def _semver(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def web_contract_version() -> str:
    versions = [json.loads(p.read_text(encoding="utf-8"))["x-contract-version"]
                for p in CONTRACTS.glob("*.schema.json")]
    return max(versions, key=_semver)


def backend_contract_version() -> str:
    api = yaml.safe_load((CONTRACTS / "backend" / "openapi.yaml").read_text(encoding="utf-8"))
    return str(api["info"]["version"])


@cache
def code_identity() -> dict:
    """The parts fixed for the life of this process (taken once, at start-up)."""
    from tools.make_bundle import CONTRACT_VERSION, config_hash

    commit, engine_tree = git_identity()
    return {
        "engine_tree": engine_tree,
        "commit": commit,
        "config_hash": config_hash(),
        "web_contract_version": web_contract_version(),
        "backend_contract_version": backend_contract_version(),
        "bundle_contract_version": CONTRACT_VERSION,
    }


def engine_version() -> dict:
    """The /engine/version body (openapi.yaml EngineVersion); raises Unavailable when a required
    part (code identity, server data manifest) is missing."""
    th = terrain_hash()
    if th is None:
        raise Unavailable(f"no server data manifest at {server_data_dir() / SERVER_DATA_MANIFEST}"
                          " (run `make serverdata`)")
    return {**code_identity(), "terrain_hash": th}
