#!/usr/bin/env python3
"""mission.json of the official, precomputed plan (D110, WP9c): simulator export without a live job.

``--official`` reads the published official tree ``web/public/data`` (read-only; nothing in it is
ever written) and writes ``web/public/sim/official/mission.json`` (contracts/bundle
mission.schema.json, origin ``precomputed``, origin_label = config/backend.yaml
``labels.precomputed``). The numbers are the official plan's own (the engine's route of the
default scenario, F9), copied by WP9b's builder ``server.engine.mission.build_mission``, never
recomputed here.

Fields: z, T_home and O2_home along the path and in the timeline come from the official run's
rasters in ``data/interim`` (``terrain/elev_3m.tif``, ``engine/{scenario}/t_home.tif`` and
``o2_home.tif``: the same rasters web/public/data was exported from; their station values equal
stations.json). Without them the timeline would be null, so the tool refuses to write; their
paths and sha256s are recorded in ``planner.files`` / ``planner.source_sha256``, and ``--check``
can only rebuild where they are present and unchanged (exit 2 otherwise).

Deterministic: ``created_utc`` is the official data's build time (the latest ``utc`` in
``web/public/data/manifest.json``, the same instant the server's synthesised run record gives as
``finished_utc``), not "now"; so the same tree always gives the same bytes. ``--check`` rebuilds
in memory and compares with the committed file (exit 1 when stale).

The server serves the written file for the official hash as
``GET /api/v1/results/{official_hash}/mission.json`` (server/engine/results.py).

Usage: ``make mission-official`` (= ``tools/make_mission.py --official``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:  # run as a script: make `server` and `tools` importable
    sys.path.insert(0, str(REPO))

DATA = REPO / "web" / "public" / "data"
INTERIM = REPO / "data" / "interim"
OFFICIAL_OUT = REPO / "web" / "public" / "sim" / "official" / "mission.json"
CONFIG = REPO / "config"
ORIGIN = "precomputed"


def _json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def _manifest_entries(data: Path) -> list[dict]:
    m = _json(data / "manifest.json")
    return [v for v in m.values() if isinstance(v, dict)]


def build_time(data: Path = DATA) -> str:
    """The official tree's build time: the latest ``utc`` of its provenance manifest."""
    times = sorted(v["utc"] for v in _manifest_entries(data) if v.get("utc"))
    if not times:
        raise ValueError(f"{data / 'manifest.json'} carries no utc times")
    return times[-1]


def default_scenario(data: Path = DATA) -> str:
    """scenarios/index.json ``default`` (the scenario the official plan's route belongs to)."""
    return _json(data / "scenarios" / "index.json")["default"]


def route_provenance(data: Path, route_file: str) -> tuple[str | None, str | None]:
    """(commit, script) of the route file in the manifest (plan.json engine.commit rule)."""
    rows = {(v.get("commit"), v.get("script")) for v in _manifest_entries(data)
            if v.get("file") == route_file}
    return next(iter(rows)) if len(rows) == 1 else (None, None)


def rasters(scenario: str, interim: Path = INTERIM) -> dict[str, Path]:
    """The official run's DEM (3 m) and the scenario's WS2 fields (as plan_job.export_context)."""
    return {"elev": interim / "terrain" / "elev_3m.tif",
            "t_home": interim / "engine" / scenario / "t_home.tif",
            "o2_home": interim / "engine" / scenario / "o2_home.tif"}


class RastersMissing(FileNotFoundError):
    """The official run's rasters are not here (e.g. CI without data/): cannot build."""


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def official_kwargs(data: Path = DATA, interim: Path = INTERIM) -> dict:
    """The keyword arguments of ``build_mission`` / ``write_mission`` for the official plan."""
    from server.engine.hashing import official_inputs
    from server.settings import settings

    scenario = default_scenario(data)
    files = {"route": f"route_{scenario}.geojson", "timeline": f"timeline_{scenario}.json",
             "stations": "stations.json", "pad": "pad.json"}
    missing = [f for f in files.values() if not (data / f).is_file()]
    if missing:
        raise FileNotFoundError(f"official tree {data} lacks {missing}")
    ras = rasters(scenario, interim)
    absent = [str(p) for p in ras.values() if not p.is_file()]
    if absent:
        raise RastersMissing(f"the official run's rasters are missing: {absent}")
    grids = yaml.safe_load((CONFIG / "site.yaml").read_text(encoding="utf-8"))["grids_m"]
    commit, script = route_provenance(data, files["route"])
    rel = {k: f"data/interim/{p.relative_to(interim).as_posix()}" for k, p in ras.items()}
    planner = {
        "engine": script,  # the script that wrote the official route (manifest)
        "engine_commit": commit,
        "app_commit": None,  # the published tree does not record a web build commit
        "config_hash": None,  # web/public/data does not carry the config hash it was built with
        "routing_grid_res_m": grids["route"],  # the engine's routing grid (3 m)
        "elevation_res_m": None,  # the builder takes it from the elev raster (3 m)
        "files": files | rel,
        "source_sha256": {k: sha256(p) for k, p in ras.items()},
    }
    return {"inputs": official_inputs(), "scenario": scenario, "origin": ORIGIN,
            "origin_label": settings().labels.precomputed, "planner": planner,
            "created_utc": build_time(data), "rasters": ras}


def _guard(out: Path, data: Path) -> None:
    if out.resolve().is_relative_to(data.resolve()):
        raise ValueError(f"refusing to write {out} inside the official tree {data}")


def build_official(data: Path = DATA, interim: Path = INTERIM) -> dict:
    """The official plan's mission document (validated by the builder's writer on write)."""
    from server.engine.mission import build_mission

    return build_mission(data, **official_kwargs(data, interim))


def write_official(data: Path = DATA, out: Path = OFFICIAL_OUT, interim: Path = INTERIM) -> Path:
    from server.engine.mission import write_mission

    _guard(out, data)
    kw = official_kwargs(data, interim)
    out.parent.mkdir(parents=True, exist_ok=True)
    return write_mission(data, out, **kw)


def official_bytes(data: Path = DATA, interim: Path = INTERIM) -> bytes:
    """What ``write_official`` would write, built in a temp folder (for --check and tests)."""
    with tempfile.TemporaryDirectory() as tmp:
        return write_official(data, Path(tmp) / "mission.json", interim).read_bytes()


def can_rebuild(committed: Path = OFFICIAL_OUT, interim: Path = INTERIM) -> str | None:
    """None when the rasters ``committed`` was built from are here unchanged, else why not."""
    doc = _json(committed)
    ras = rasters(doc["scenario"]["id"], interim)
    absent = [str(p) for p in ras.values() if not p.is_file()]
    if absent:
        return f"the official run's rasters are not here: {absent}"
    changed = [k for k, want in doc["planner"].get("source_sha256", {}).items()
               if k not in ras or sha256(ras[k]) != want]
    return f"rasters changed since {committed} was built: {changed}" if changed else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--official", action="store_true", required=True,
                    help="write the official plan's mission.json (origin precomputed)")
    ap.add_argument("--data", type=Path, default=DATA, help="official tree (read-only)")
    ap.add_argument("--interim", type=Path, default=INTERIM,
                    help="the official run's data/interim (DEM and WS2 field rasters)")
    ap.add_argument("--out", type=Path, default=OFFICIAL_OUT)
    ap.add_argument("--check", action="store_true",
                    help="do not write; exit 1 when --out differs from a fresh build, 2 when the "
                         "rasters it needs are missing")
    a = ap.parse_args(argv)
    try:
        if a.check:
            fresh = official_bytes(a.data, a.interim)
            if not a.out.is_file() or a.out.read_bytes() != fresh:
                print(f"{a.out} is stale: run make mission-official", file=sys.stderr)
                return 1
            print(f"{a.out} is up to date")
            return 0
        out = write_official(a.data, a.out, a.interim)
    except RastersMissing as e:
        print(f"make_mission: {e}", file=sys.stderr)
        return 2
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
