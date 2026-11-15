"""Staged scenarios/index.json and manifest.json of the plan job (H5-1, D81; E8c).

The client (web/src/live/stage.ts) finds every map file through scenarios/index.json and every
number through manifest.json, so the job writes a PARTIAL index and manifest after each stage
and the final ones at summary. Known answers, on the synthetic world:
- after "nominal" the tree holds an index that validates against the scenarios-index contract and
  lists the nominal scenario (the default) alone; its files are in the tree and in the manifest
  (file.<path> entries carrying the sha256 of the published bytes);
- after "bands" the variants (opt_104, con_104) appear, with their files;
- at every stage the whole tree validates and each file the index lists exists; at every
  stage before summary each manifest entry's file exists and every file.<path> sha256 matches the
  published bytes (the final manifest is the full merge as before: on the synthetic world, which
  has no WS3 horizon cards, it keeps the card.* keys of cards/S*.json, which is not written);
- only scenarios/index.json, manifest.json and the band file are written more than once;
- the final index and manifest are byte-identical to what the summary stage wrote before
  staging (the full call's index; manifest.merge of the full call's fragments);
- served through the API: while the job runs, index.json and manifest.json are no-store; once
  the run record exists they are immutable.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import types
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from pipeline.engine import provenance  # noqa: E402
from pipeline.provenance import manifest as manifest_mod  # noqa: E402
from server.engine import jobs, plan_job  # noqa: E402
from server.engine.hashing import canonical_inputs, official_inputs, result_hash  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests import parity_harness as H  # noqa: E402
from server.tests.test_plan_job import IDENT, PREFIX, WAIT_S, _app, custom_inputs  # noqa: E402
from tools.validate_contracts import CONTRACTS_DIR, Report, check_tree, load_schemas  # noqa: E402

GATE_ENV = "HL_TEST_PLAN_STAGE_GATE"  # the paused job waits after "nominal" until this file exists
NOMINAL_FILES = ("scenarios/nom_104/isochrones.geojson", "scenarios/nom_104/edges.geojson",
                 "scenarios/nom_104/partner.geojson", "scenarios/bands_104.geojson",
                 "route_nom_104.geojson", "timeline_nom_104.json")
VARIANT_FILES = ("scenarios/opt_104/isochrones.geojson", "scenarios/opt_104/edges.geojson",
                 "scenarios/con_104/isochrones.geojson", "scenarios/con_104/edges.geojson")
REWRITTEN = {"scenarios/index.json", "manifest.json", "scenarios/bands_104.geojson"}


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    """$HL_SERVER_DATA with the synthetic world as terrain/ (no conditions/: WS4 margins off)."""
    sd = tmp_path_factory.mktemp("plan_stages") / "server"
    off = official_inputs()
    H.synthetic_world(sd / "terrain", (off["pad"]["lon"], off["pad"]["lat"]))
    (sd / "manifest.json").write_text('{"synthetic": true}\n', encoding="utf-8")
    return sd


class SnapConn:
    """Stands in for the worker pipe; copies the public tree at every stage event."""

    def __init__(self, public: Path, snaps: Path):
        self.public, self.snaps = public, snaps
        self.events: list[tuple[str, Path, dict[str, int]]] = []

    def send(self, msg):
        if msg[0] != "stage":
            return
        dst = self.snaps / f"{len(self.events)}_{msg[2]}"
        shutil.copytree(self.public, dst)
        inodes = {p.relative_to(self.public).as_posix(): p.stat().st_ino
                  for p in self.public.rglob("*") if p.is_file() and not p.name.startswith(".")}
        self.events.append((msg[2], dst, inodes))


@pytest.fixture(scope="module")
def staged(world, tmp_path_factory):
    """run_plan_job for a custom pad in this process; the scratch dir is kept (no rmtree) so the
    test can recompute what the summary stage writes from the full call's own outputs."""
    root = tmp_path_factory.mktemp("staged")
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("HL_SERVER_DATA", str(world))
        mp.setenv(provenance.FRAGMENT_DIR_ENV, str(root / "stray_manifest"))
        mp.setattr(plan_job, "shutil", types.SimpleNamespace(rmtree=lambda *a, **k: None))
        inp = canonical_inputs(custom_inputs(world / "terrain"))
        out, pub = root / ".job-x", root / "public"
        out.mkdir()
        conn = SnapConn(pub, root / "snaps")
        ctx = jobs.JobContext(conn, "j_stages", out, pub, plan_job.STAGES)
        plan_job.run_plan_job(inp, ctx)
    return ctx, conn, out, pub


def _json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _scenario_files(index: dict) -> set[str]:
    return {f for s in index["scenarios"] for f in s["files"].values()}


# ---------------------------------------------------------------------- known answers ----
def test_after_nominal_index_lists_the_nominal_scenario(staged):
    _, conn, _, _ = staged
    name, snap, _ = conn.events[0]
    assert name == "nominal"
    report = Report()
    check_tree(snap, load_schemas(CONTRACTS_DIR, report), report, public=True)
    assert report.ok, report.errors[:10]  # index.json validates against scenarios_index
    index = _json(snap / "scenarios/index.json")
    assert index["dummy"] is False and index["default"] == "nom_104"
    assert [s["id"] for s in index["scenarios"]] == ["nom_104"]
    man = _json(snap / "manifest.json")
    manifest_mod.validate(man)
    assert man["dummy"] is False
    for f in (*NOMINAL_FILES, "scenarios/index.json"):
        assert (snap / f).is_file(), f
        assert man[f"file.{f}"]["value"] == _sha(snap / f), f
    assert _scenario_files(index) <= set(NOMINAL_FILES)
    # numbers the client shows after nominal resolve against this manifest
    assert any(k.startswith("route.nom_104.") for k in man)
    assert any(k.startswith("timeline.nom_104.") for k in man)
    # nothing listed that is not in the tree yet
    assert not (snap / "stations.json").exists() and "file.stations.json" not in man


def test_after_bands_the_variants_appear(staged):
    _, conn, _, _ = staged
    name, snap, _ = conn.events[1]
    assert name == "bands"
    index = _json(snap / "scenarios/index.json")
    assert sorted(s["id"] for s in index["scenarios"]) == ["con_104", "nom_104", "opt_104"]
    man = _json(snap / "manifest.json")
    for f in VARIANT_FILES:
        assert (snap / f).is_file() and man[f"file.{f}"]["value"] == _sha(snap / f), f
    # the nominal route stays listed (the preview's, byte-identical to the full call's)
    assert man["file.route_nom_104.geojson"]["value"] == _sha(snap / "route_nom_104.geojson")


@pytest.mark.parametrize("i", range(len(plan_job.STAGES)))
def test_every_stage_is_consistent(staged, i):
    _, conn, _, _ = staged
    name, snap, _ = conn.events[i]
    report = Report()
    check_tree(snap, load_schemas(CONTRACTS_DIR, report), report, public=True)
    assert report.ok, (name, report.errors[:10])
    index, man = _json(snap / "scenarios/index.json"), _json(snap / "manifest.json")
    assert all((snap / f).is_file() for f in _scenario_files(index)), name
    manifest_mod.validate(man)
    if name == "summary":
        return  # the final manifest: test_final_index_and_manifest_are_the_summary_ones
    for key, e in man.items():
        if key == "dummy":
            continue
        assert (snap / e["file"]).is_file(), (name, key)
        if key.startswith("file."):
            assert e["value"] == _sha(snap / e["file"]), (name, key)


def test_only_index_manifest_and_bands_are_rewritten(staged):
    _, conn, _, _ = staged
    seen: dict[str, set[int]] = {}
    for _, _, inodes in conn.events:
        for f, ino in inodes.items():
            seen.setdefault(f, set()).add(ino)
    rewritten = {f for f, inos in seen.items() if len(inos) > 1}
    assert rewritten <= REWRITTEN, rewritten
    assert {"scenarios/index.json", "manifest.json"} <= rewritten


def test_final_index_and_manifest_are_the_summary_ones(staged):
    """Byte-identical to the pre-staging summary: the full call's index file, and
    json.dumps(manifest.merge(full fragments) + the exporter entries, indent=1) + newline
    (ctx.write_json)."""
    ctx, conn, out, pub = staged
    assert conn.events[-1][0] == "summary" and ctx.done == list(plan_job.STAGES)
    work = out / plan_job.WORK
    full_index = (work / "full" / "public" / "scenarios/index.json").read_bytes()
    assert (pub / "scenarios/index.json").read_bytes() == full_index
    merged = manifest_mod.merge(work / "manifest", out_path=work / "check_manifest.json")
    # plus the exporters' entries, after the engine's (D110: only mission.json, kind sim_plan)
    final_doc = json.loads((pub / "manifest.json").read_bytes())
    extra = {k: e for k, e in final_doc.items() if k.startswith("export.")}
    assert list(extra) == ["export.mission.mission.json"]
    assert extra["export.mission.mission.json"]["kind"] == "sim_plan"
    merged = {**merged, **extra}
    expect = (json.dumps(merged, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
    assert (pub / "manifest.json").read_bytes() == expect
    final = conn.events[-1][1]
    assert (final / "manifest.json").read_bytes() == expect


# --------------------------------------------------------------- through the runner/API ----
def run_paused_after_nominal(inputs: dict, ctx) -> dict:
    """Module level (pickled into the spawned worker): the plan job, held after "nominal" until
    the gate file exists, so the test sees a running tree deterministically."""
    gate = Path(os.environ[GATE_ENV])
    report = ctx.stage

    def stage(name: str) -> None:
        report(name)
        if name == "nominal":
            t0 = time.monotonic()
            while not gate.exists() and time.monotonic() - t0 < WAIT_S:
                time.sleep(0.02)

    ctx.stage = stage
    return plan_job.run_plan_job(inputs, ctx)


def test_index_and_manifest_no_store_while_running_immutable_after(world, monkeypatch, tmp_path):
    monkeypatch.setenv("HL_SERVER_DATA", str(world))
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "stray_manifest"))
    monkeypatch.delenv(settings().deploy.kill_switch_env, raising=False)
    gate = tmp_path / "gate"
    monkeypatch.setenv(GATE_ENV, str(gate))
    doc = custom_inputs(world / "terrain", east_m=-150.0)
    h = result_hash(doc, IDENT)
    files = ("scenarios/index.json", "manifest.json")
    with TestClient(_app(jobs.JobType(run_paused_after_nominal, plan_job.STAGES))) as c:
        j = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": doc}).json()
        t0 = time.monotonic()
        while True:
            body = c.get(f"{PREFIX}/jobs/{j['id']}").json()
            if body["stages_done"]:
                break
            assert body["status"] not in ("done", "error", "timeout"), body
            assert time.monotonic() - t0 < WAIT_S, body
            time.sleep(0.05)
        assert body["status"] == "running" and body["stages_done"] == ["nominal"], body
        for f in files:
            r = c.get(f"{PREFIX}/results/{h}/{f}")
            assert r.status_code == 200, (f, r.text)
            assert r.headers["cache-control"] == "no-store", f
        index = c.get(f"{PREFIX}/results/{h}/scenarios/index.json").json()
        assert [s["id"] for s in index["scenarios"]] == ["nom_104"]
        man = c.get(f"{PREFIX}/results/{h}/manifest.json").json()
        for f in index["scenarios"][0]["files"].values():
            r = c.get(f"{PREFIX}/results/{h}/{f}")
            assert r.status_code == 200 and r.headers["cache-control"] == "no-store", f
            assert man[f"file.{f}"]["value"] == hashlib.sha256(r.content).hexdigest(), f
        assert c.get(f"{PREFIX}/results/{h}/run_record.json").status_code == 404

        gate.write_text("go\n", encoding="utf-8")
        t0 = time.monotonic()
        while body["status"] not in ("done", "error", "timeout"):
            assert time.monotonic() - t0 < WAIT_S, body
            time.sleep(0.05)
            body = c.get(f"{PREFIX}/jobs/{j['id']}").json()
        assert body["status"] == "done", body
        for f in files:
            r = c.get(f"{PREFIX}/results/{h}/{f}")
            assert r.status_code == 200 and "immutable" in r.headers["cache-control"], f
        index = c.get(f"{PREFIX}/results/{h}/scenarios/index.json").json()
        assert sorted(s["id"] for s in index["scenarios"]) == ["con_104", "nom_104", "opt_104"]
