"""Job type ``plan`` (WS11 plan row 2.4, brief tasks 8-9; F24 stages, F35 run record; D76, D81).

Known answers, on the synthetic world (pipeline/engine/synthetic.py via parity_harness):
- a custom pad computes the three variants at the default suit mass; the official pad keeps the
  official set (D81);
- the job runs through its stages in order (nominal, bands, partner, route, summary);
- the stage files appear in the public tree before the job is done: after "nominal" the default
  scenario's isochrones, edges, partner line and route are readable, with a partial
  manifest.json and scenarios/index.json at every stage (H5-1; their contents:
  test_plan_stages.py);
- a file of the nominal stage that the full call reproduces is published once (same inode);
- the result tree validates against the web contracts; the run record validates against
  run_record.schema.json (origin computed_live, label labels.live, canonical inputs, stages with
  timings) and lists every file;
- a re-submit of the same inputs attaches to the running job;
- an empty exporter registry adds nothing (the registry holds "mission", D110); a registered
  test exporter's file is listed in
  manifest.json with its kind and served by GET /results/{hash}/<file>;
- inputs other than the pad are refused as unsupported (job error), never ignored; inputs out
  of the config ranges give range flags, never clamping;
- create_app() sees the registered plan type; the official hash never runs a job.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from pipeline.engine import provenance  # noqa: E402
from server.api.compute import identity_provider  # noqa: E402
from server.app import create_app  # noqa: E402
from server.engine import exporters, jobs, plan_job, results  # noqa: E402
from server.engine.hashing import (  # noqa: E402
    EngineIdentity,
    canonical_inputs,
    official_hash,
    official_inputs,
    result_hash,
)
from server.settings import settings  # noqa: E402
from server.tests import parity_harness as H  # noqa: E402
from tools.validate_contracts import CONTRACTS_DIR, Report, check_tree, load_schemas  # noqa: E402

PREFIX = settings().api.prefix
IDENT = EngineIdentity("a" * 40, "sha256:" + "b" * 64, "sha256:" + "c" * 64)
WAIT_S = 240.0
EAST_M = 30.0  # the custom pad: the official pad moved 10 cells east (inside the synthetic world)
TEST_KIND = "test_export"


def custom_inputs(terrain: Path, east_m: float = EAST_M) -> dict:
    from pipeline.engine.geo import lonlat_of_xy, xy_of_lonlat
    from pipeline.engine.graph import load_ws1_grid

    off = official_inputs()
    crs = load_ws1_grid(terrain).crs
    x, y = xy_of_lonlat(off["pad"]["lon"], off["pad"]["lat"], crs)
    lon, lat = lonlat_of_xy(x + east_m, y, crs)
    return {"contract_version": settings().contract_version,
            "pad": {"lon": round(float(lon), 6), "lat": round(float(lat), 6)}}


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    """$HL_SERVER_DATA with the synthetic world as terrain/ (no conditions/: WS4 margins off)."""
    sd = tmp_path_factory.mktemp("plan_job") / "server"
    off = official_inputs()
    H.synthetic_world(sd / "terrain", (off["pad"]["lon"], off["pad"]["lat"]))
    (sd / "manifest.json").write_text('{"synthetic": true}\n', encoding="utf-8")
    return sd


@pytest.fixture
def server_data(world, monkeypatch, tmp_path):
    monkeypatch.setenv("HL_SERVER_DATA", str(world))
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "stray_manifest"))
    monkeypatch.delenv(settings().deploy.kill_switch_env, raising=False)
    return world


class Conn:
    """Stands in for the worker pipe; snapshots the public tree at every stage event."""

    def __init__(self, public: Path):
        self.public = public
        self.events: list[tuple[str, set[str], dict[str, int]]] = []

    def send(self, msg):
        if msg[0] == "stage":
            files = {p.relative_to(self.public).as_posix(): p.stat().st_ino
                     for p in self.public.rglob("*") if p.is_file() and not p.name.startswith(".")}
            self.events.append((msg[2], set(files), files))


@pytest.fixture(scope="module")
def inprocess(world, tmp_path_factory):
    """run_plan_job for a custom pad, in this process, with a recording stage reporter."""
    root = tmp_path_factory.mktemp("inprocess")
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("HL_SERVER_DATA", str(world))
        mp.setenv(provenance.FRAGMENT_DIR_ENV, str(root / "stray_manifest"))
        inp = canonical_inputs(custom_inputs(world / "terrain"))
        out, pub = root / ".job-x", root / "public"
        out.mkdir()
        conn = Conn(pub)
        ctx = jobs.JobContext(conn, "j_test", out, pub, plan_job.STAGES)
        extra = plan_job.run_plan_job(inp, ctx)
    return inp, ctx, conn, out, pub, extra


# ---------------------------------------------------------------------- known answers ----
def test_scenario_set_d81(world):
    ids = H.scenario_ids()
    assert plan_job.scenario_set(official_inputs()) == ids
    custom = plan_job.scenario_set(custom_inputs(world / "terrain"))
    assert custom == ["opt_104", "nom_104", "con_104"]  # variants.yaml order, default suit


def test_create_app_sees_the_plan_type():
    app = create_app(warmup=lambda: None)
    assert app.state.jobs.job_types["plan"] is plan_job.PLAN_JOB
    assert plan_job.STAGES == ("nominal", "bands", "partner", "route", "summary")


def test_stages_in_order_and_files_before_done(inprocess):
    _, ctx, conn, _, _, _ = inprocess
    assert [e[0] for e in conn.events] == list(plan_job.STAGES)
    assert ctx.done == list(plan_job.STAGES)
    nominal = conn.events[0][1]
    for f in ("scenarios/nom_104/isochrones.geojson", "scenarios/nom_104/edges.geojson",
              "scenarios/nom_104/partner.geojson", "scenarios/bands_104.geojson",
              "route_nom_104.geojson", "timeline_nom_104.json"):
        assert f in nominal, f
    assert not any(f.startswith(("scenarios/con_", "scenarios/opt_")) for f in nominal)
    assert "stations.json" not in nominal
    bands = conn.events[1][1]
    assert {"scenarios/con_104/isochrones.geojson", "scenarios/opt_104/edges.geojson"} <= bands
    for name, files, _ in conn.events:  # H5-1: a partial index and manifest at every stage
        assert "manifest.json" in files and "scenarios/index.json" in files, name
    final = conn.events[-1][1]
    assert {"manifest.json", "scenarios/index.json", "stations.json",
            "trade_table.json"} <= final
    assert not any(f.startswith(".") or "/." in f for f in final)


def test_nominal_files_published_once(inprocess):
    _, _, conn, _, _, _ = inprocess
    first, last = conn.events[0][2], conn.events[-1][2]
    for f in ("scenarios/nom_104/isochrones.geojson", "route_nom_104.geojson",
              "timeline_nom_104.json", "scenarios/nom_104/partner.geojson"):
        assert first[f] == last[f], f"{f} was published twice"


def test_result_tree_validates(inprocess):
    _, _, _, _, pub, _ = inprocess
    report = Report()
    schemas = load_schemas(CONTRACTS_DIR, report)
    n = check_tree(pub, schemas, report, public=True)
    assert n > 10 and report.ok, report.errors[:10]
    index = json.loads((pub / "scenarios/index.json").read_text())
    assert sorted(e["id"] for e in index["scenarios"]) == ["con_104", "nom_104", "opt_104"]
    manifest = json.loads((pub / "manifest.json").read_text())
    assert manifest["dummy"] is False
    # the registry holds only "mission" (D110, server/tests/test_mission_export.py)
    assert [k for k in manifest if k.startswith("export.")] == ["export.mission.mission.json"]


def test_empty_registry_adds_nothing(tmp_path):
    assert sorted(exporters.EXPORTERS) == ["mission"]  # D110: mission.json only
    assert exporters.run_exporters(tmp_path, "c" * 40, "2026-11-15T00:00:00Z", {}) == {}
    # the registered exporters write nothing into a tree that is not a plan job's
    assert exporters.run_exporters(tmp_path, "c" * 40, "2026-11-15T00:00:00Z") == {}
    assert list(tmp_path.iterdir()) == []


def test_range_flags_not_clamped():
    doc = {**official_inputs(), "crew": {"body_mass_kg": 120.0, "suit_kg": 104.0}}
    flags = plan_job.range_flags(doc)
    note = settings().ranges.model_dump()["anchored_flag_note"]
    assert flags == [{"key": "crew.body_mass_kg", "value": 120.0, "note": note}]
    assert canonical_inputs(doc)["crew"]["body_mass_kg"] == 120.0
    assert plan_job.range_flags(official_inputs()) == []


def test_unsupported_inputs_refused(world, tmp_path):
    doc = {**custom_inputs(world / "terrain"), "eva": {"duration_h": 5.0}}
    assert plan_job.unsupported(doc) == ["eva"]
    with pytest.raises(plan_job.UnsupportedInputs, match="eva"):
        plan_job.build(doc, terrain_dir=world / "terrain", out_dir=tmp_path / "o",
                       manifest_dir=tmp_path / "m", conditions=False, rad_json=tmp_path / "r")


# --------------------------------------------------------------- through the runner/API ----
def _export_test(result_dir: Path) -> list[dict]:
    (result_dir / "extra").mkdir(exist_ok=True)
    (result_dir / "extra" / "probe.txt").write_text("probe\n", encoding="utf-8")
    return [{"path": "extra/probe.txt", "kind": TEST_KIND}]


def run_with_test_exporter(inputs: dict, ctx) -> dict:
    """Module level (pickled into the spawned worker): the plan job with one test exporter."""
    exporters.register_exporter("probe", _export_test)
    try:
        return plan_job.run_plan_job(inputs, ctx)
    finally:
        exporters.unregister_exporter("probe")


def _app(job_type):
    cfg = settings()
    cfg = cfg.model_copy(update={"compute": cfg.compute.model_copy(
        update={"workers": 1, "job_timeout_s": WAIT_S})})
    runner = jobs.JobRunner.from_config(cfg, job_types={"plan": job_type})
    app = create_app(warmup=lambda: None, jobs=runner)
    app.dependency_overrides[identity_provider] = lambda: (lambda: IDENT)
    return app


def _wait(c, jid: str) -> dict:
    t0 = time.monotonic()
    while True:
        body = c.get(f"{PREFIX}/jobs/{jid}").json()
        if body["status"] in ("done", "error", "timeout"):
            return body
        assert time.monotonic() - t0 < WAIT_S, body
        time.sleep(0.05)


def test_job_end_to_end_with_test_exporter(server_data):
    doc = custom_inputs(server_data / "terrain", east_m=2 * EAST_M)
    h = result_hash(doc, IDENT)
    with TestClient(_app(jobs.JobType(run_with_test_exporter, plan_job.STAGES))) as c:
        r1 = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": doc})
        r2 = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": {**doc, "title": "again"}})
        assert r1.status_code == r2.status_code == 202
        j1, j2 = r1.json(), r2.json()
        assert j2["id"] == j1["id"] and j2["attached"] is True and j1["hash"] == h
        early = None
        t0 = time.monotonic()
        while True:  # a stage file is served (no-store) before the job is done
            body = c.get(f"{PREFIX}/jobs/{j1['id']}").json()
            if body["stages_done"] and body["status"] == "running" and early is None:
                early = c.get(f"{PREFIX}/results/{h}/route_nom_104.geojson")
            if body["status"] in ("done", "error", "timeout"):
                break
            assert time.monotonic() - t0 < WAIT_S, body
            time.sleep(0.02)
        assert body["status"] == "done", body
        assert body["stages_done"] == list(plan_job.STAGES)
        if early is not None:  # the job may finish between two polls on a fast machine
            assert early.status_code == 200
            assert early.headers["cache-control"] == "no-store"

        rec = c.get(f"{PREFIX}/results/{h}/provenance")
        assert rec.status_code == 200
        doc_rec = rec.json()
        results.validate_run_record(doc_rec)
        assert doc_rec["origin"] == "computed_live" and doc_rec["status"] == "done"
        assert doc_rec["label"] == settings().labels.live
        assert doc_rec["inputs"] == canonical_inputs(doc) | {}  # what was hashed (no title)
        assert [s["name"] for s in doc_rec["stages"]] == list(plan_job.STAGES)
        assert all(s["seconds"] >= 0 for s in doc_rec["stages"])
        assert doc_rec["range_flags"] == [] and doc_rec["error"] is None
        paths = {f["path"] for f in doc_rec["files"]}
        assert {"manifest.json", "scenarios/index.json", "route_nom_104.geojson",
                "extra/probe.txt"} <= paths

        manifest = c.get(f"{PREFIX}/results/{h}/manifest.json").json()
        entry = manifest[exporters.MANIFEST_KEY.format(name="probe", path="extra/probe.txt")]
        assert entry["kind"] == TEST_KIND and entry["file"] == "extra/probe.txt"
        served = c.get(f"{PREFIX}/results/{h}/{entry['file']}")
        assert served.status_code == 200 and served.content == b"probe\n"
        assert "immutable" in served.headers["cache-control"]  # complete now
        # D110: the registered mission exporter ran in the worker too, and is served
        m = manifest["export.mission.mission.json"]
        assert (m["kind"], m["file"]) == ("sim_plan", "mission.json") and "mission.json" in paths
        sim = c.get(f"{PREFIX}/results/{h}/mission.json")
        assert sim.status_code == 200 and sim.json()["origin"] == "computed_live"

        again = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": doc}).json()
        assert again["status"] == "done" and again["attached"] is True
    assert not [p for p in (server_data / settings().cache.dir).iterdir()
                if p.name.startswith(".job-")]
    # the test exporter lived only in the worker; "mission" is registered (D110)
    assert sorted(exporters.EXPORTERS) == ["mission"]


def test_official_hash_never_runs_a_job(server_data):
    ident = EngineIdentity(IDENT.engine_tree, IDENT.config_hash, IDENT.terrain_hash)
    with TestClient(_app(plan_job.PLAN_JOB)) as c:
        r = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": official_inputs()})
        assert r.status_code == 202
        body = r.json()
        assert body["status"] == "done" and body["hash"] == official_hash(ident)
        assert c.app.state.jobs.jobs_started == 0
    assert not (server_data / settings().cache.dir / body["hash"]).exists()


def test_unsupported_inputs_end_as_job_error(server_data):
    doc = {**custom_inputs(server_data / "terrain", east_m=3 * EAST_M),
           "stations": {"mode": "set", "ids": ["S1"]}}
    with TestClient(_app(plan_job.PLAN_JOB)) as c:
        j = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": doc}).json()
        body = _wait(c, j["id"])
    assert body["status"] == "error" and "UnsupportedInputs" in body["error"]
    assert "stations" in body["error"]
    assert not (server_data / settings().cache.dir / j["hash"]).exists()


def test_env_is_clean():
    assert not os.environ.get("HL_TEST_JOBS")
