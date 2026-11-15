"""Custom crew (WS11 brief task 11, plan row 3.2; F26): known answers on the synthetic world.

- the default crew makes the build_plan call it made before task 11 (crew=None, same scenario
  set), so its tree and hash are unchanged; a crew given explicitly at its defaults is the
  default crew;
- a heavier carried mass (tools_kg +20 kg, then out of range) never shortens T_home anywhere and
  never grows the reachable area, in every variant (plan level; W3 has the physio-level KAT);
- an out-of-range crew value gives a range flag (anchored_flag_note), is not clamped, and the
  plan runs; the run record validates and lists the flag;
- a value outside the plan_inputs schema gives 422 (no job);
- a suit mass other than the default has no build_plan path: refused (job error), never ignored;
- a custom-crew job computes and caches no crew station fields (D84: build_plan cannot use them).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
import rasterio  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from pipeline.engine import provenance  # noqa: E402
from pipeline.engine.config import load  # noqa: E402
from server.engine import crew as crew_mod  # noqa: E402
from server.engine import jobs, plan_job, results  # noqa: E402
from server.engine.hashing import (  # noqa: E402
    EngineIdentity,
    canonical_inputs,
    official_inputs,
    result_hash,
)
from server.settings import settings  # noqa: E402
from server.tests import parity_harness as H  # noqa: E402
from server.tests.test_plan_job import IDENT, PREFIX, Conn, _app, _wait, custom_inputs  # noqa: E402

DEFAULT_TOOLS = official_inputs()["crew"]["tools_kg"]
HEAVY = {"tools_kg": DEFAULT_TOOLS + 20.0}  # +20 kg carried mass (inside ranges.tools_kg)


def _ranges() -> dict:
    return settings().ranges.model_dump()


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    """$HL_SERVER_DATA with the synthetic world as terrain/ (no conditions/: WS4 margins off)."""
    sd = tmp_path_factory.mktemp("crew") / "server"
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


def with_crew(doc: dict, crew: dict) -> dict:
    return {**doc, "crew": dict(crew)}


def _build(world: Path, doc: dict, out: Path) -> dict:
    return plan_job.build(doc, terrain_dir=world / "terrain", out_dir=out,
                          manifest_dir=out / "manifest", conditions=False,
                          rad_json=out / "none.json")


def _t_home(out: Path, sid: str) -> np.ndarray:
    with rasterio.open(out / sid / "t_home.tif") as ds:
        t = ds.read(1).astype(float)
    return np.where(np.isfinite(t), t, np.inf)


def _job(world: Path, doc: dict, root: Path) -> tuple[dict, Path]:
    """run_plan_job in this process (as test_plan_job's ``inprocess``)."""
    out, pub = root / ".job-x", root / "public"
    out.mkdir(parents=True)
    ctx = jobs.JobContext(Conn(pub), "j_crew", out, pub, plan_job.STAGES)
    extra = plan_job.run_plan_job(canonical_inputs(doc), ctx)
    assert ctx.done == list(plan_job.STAGES)
    return extra, pub


# ------------------------------------------------------------------- inputs mapping ----
def test_default_crew_is_none_and_explicit_defaults_are_default(world):
    doc = custom_inputs(world / "terrain")
    assert crew_mod.overrides(doc) is None and crew_mod.is_default(doc)
    explicit = with_crew(doc, official_inputs()["crew"])
    assert crew_mod.overrides(explicit) is None
    assert result_hash(explicit, IDENT) == result_hash(doc, IDENT)
    assert plan_job.unsupported(explicit) == []


def test_custom_crew_overrides_and_scenario_set(world):
    doc = with_crew(custom_inputs(world / "terrain"), {"body_mass_kg": 80, "effort_cap_frac": 0.6})
    ov = crew_mod.overrides(doc)
    from pipeline.engine.physio import CREW_KEYS

    assert set(ov) == set(CREW_KEYS)  # every engine crew value, canonical (floats)
    assert ov["body_mass_kg"] == 80.0 and ov["effort_cap_frac"] == 0.6
    assert ov["tools_kg"] == DEFAULT_TOOLS
    assert plan_job.unsupported(doc) == []
    assert plan_job.scenario_set(doc) == ["opt_104", "nom_104", "con_104"]
    # the official pad with a custom crew is not the official plan: three variants (F26)
    off = with_crew(official_inputs(), HEAVY)
    assert plan_job.scenario_set(off) == ["opt_104", "nom_104", "con_104"]
    assert plan_job.scenario_set(official_inputs()) == H.scenario_ids()
    assert result_hash(off, IDENT) != result_hash(official_inputs(), IDENT)


def test_build_plan_call_default_unchanged_custom_gets_crew(world, tmp_path, monkeypatch):
    """The default crew passes crew=None (the call E8 made); a custom crew passes the four
    engine values. Nothing else in the call changes."""
    import pipeline.engine.plan as plan_mod

    calls = []
    monkeypatch.setattr(plan_mod, "build_plan", lambda grid, **kw: calls.append(kw) or {})
    doc = custom_inputs(world / "terrain")
    _build(world, doc, tmp_path / "a")
    _build(world, with_crew(doc, official_inputs()["crew"]), tmp_path / "b")
    _build(world, with_crew(doc, HEAVY), tmp_path / "c")
    a, b, c = calls
    assert a["crew"] is None and b["crew"] is None
    from pipeline.engine.physio import crew_values

    assert c["crew"] == {**crew_values(None), **HEAVY}
    for kw in (b, c):
        assert {k: v for k, v in kw.items() if k not in ("out_dir", "public_dir", "manifest_dir",
                                                         "crew")} == \
               {k: v for k, v in a.items() if k not in ("out_dir", "public_dir", "manifest_dir",
                                                        "crew")}


def test_suit_mass_refused_not_ignored(world, tmp_path):
    doc = with_crew(custom_inputs(world / "terrain"), {"suit_kg": 120})
    assert crew_mod.unsupported(doc) == ["crew.suit_kg"]
    assert plan_job.unsupported(doc) == ["crew.suit_kg"]
    with pytest.raises(plan_job.UnsupportedInputs, match="crew.suit_kg"):
        _build(world, doc, tmp_path / "o")


def test_crew_hash_covers_crew_and_engine():
    h0 = crew_mod.crew_hash(None, IDENT)
    assert h0 == crew_mod.crew_hash({"tools_kg": DEFAULT_TOOLS}, IDENT)  # config values filled in
    assert crew_mod.crew_hash(HEAVY, IDENT) != h0
    other = EngineIdentity(IDENT.engine_tree, IDENT.config_hash, "sha256:" + "d" * 64)
    assert crew_mod.crew_hash(HEAVY, other) != crew_mod.crew_hash(HEAVY, IDENT)
    assert len(h0) == 16 and int(h0, 16) >= 0


# ----------------------------------------------------------------- monotonic (plan) ----
def test_heavier_carried_mass_never_increases_reach(server_data, tmp_path):
    """F26 / brief KAT at the plan level: default, +20 kg carried, +30 kg carried (outside the
    anchored range: flagged, still planned). In every variant T_home never decreases anywhere,
    the cells within each band budget never grow, nor does the headline reachable share."""
    doc = custom_inputs(server_data / "terrain")
    tools_max = _ranges()["tools_kg"]["max"]
    crews = [None, HEAVY, {"tools_kg": tools_max + 10.0}]
    sids = plan_job.scenario_set(doc)
    budgets = [int(b) for b in load("variants")["outputs"]["band_budgets_min"]]
    prev = None
    for k, crew in enumerate(crews):
        d = doc if crew is None else with_crew(doc, crew)
        out = tmp_path / f"c{k}"
        _build(server_data, d, out)
        idx = json.loads((out / "public" / "scenarios" / "index.json").read_text())
        reach = {e["id"]: e["headline"]["reachable_pct"] for e in idx["scenarios"]}
        t = {sid: _t_home(out, sid) for sid in sids}
        if prev is not None:
            pt, preach = prev
            for sid in sids:
                assert np.all(t[sid] >= pt[sid] - 1e-6), sid
                for b in budgets + [5, 10, 15]:
                    assert (t[sid] <= b).sum() <= (pt[sid] <= b).sum(), (sid, b)
                if reach[sid] is not None and preach[sid] is not None:
                    assert reach[sid] <= preach[sid], sid
                fin = np.isfinite(t[sid]) & np.isfinite(pt[sid])
                assert t[sid][fin].sum() > pt[sid][fin].sum(), sid  # heavier costs something
        prev = (t, reach)
    assert plan_job.range_flags(with_crew(doc, crews[-1]))[0]["key"] == "crew.tools_kg"


# ---------------------------------------------------------- no station-field cache (D84) ----
def test_custom_crew_job_runs_without_station_field_cache(server_data, tmp_path):
    """D84: build_plan takes no precomputed station fields, so a custom-crew job neither
    computes nor caches crew station fields ($HL_SERVER_DATA/cache/station_fields/)."""
    crew = {"body_mass_kg": 85.0, "vo2max_ml_kg_min": 40.0}
    doc = with_crew(custom_inputs(server_data / "terrain", east_m=-30.0), crew)
    _, pub = _job(server_data, doc, tmp_path / "j1")
    index = json.loads((pub / "scenarios" / "index.json").read_text())
    assert sorted(e["id"] for e in index["scenarios"]) == ["con_104", "nom_104", "opt_104"]
    assert not (server_data / "cache" / "station_fields").exists()
    assert not hasattr(crew_mod, "ensure_station_fields")


# ----------------------------------------------------------------- through the API ----
def test_out_of_range_crew_flagged_runs_and_run_record_lists_flags(server_data):
    tools_max = _ranges()["tools_kg"]["max"]
    crew = {"tools_kg": tools_max + 10.0, "body_mass_kg": 80.0}
    doc = with_crew(custom_inputs(server_data / "terrain", east_m=45.0), crew)
    h = result_hash(doc, IDENT)
    with TestClient(_app(plan_job.PLAN_JOB)) as c:
        r = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": doc})
        assert r.status_code == 202, r.text
        body = _wait(c, r.json()["id"])
        assert body["status"] == "done", body
        rec = c.get(f"{PREFIX}/results/{h}/provenance").json()
        idx = c.get(f"{PREFIX}/results/{h}/scenarios/index.json")
    results.validate_run_record(rec)
    assert rec["status"] == "done" and rec["error"] is None
    assert rec["label"] == settings().labels.live  # the label still applies
    note = _ranges()["anchored_flag_note"]
    assert rec["range_flags"] == [{"key": "crew.tools_kg", "value": tools_max + 10.0,
                                   "note": note}]
    assert rec["inputs"]["crew"]["tools_kg"] == tools_max + 10.0  # not clamped
    assert idx.status_code == 200
    assert sorted(e["id"] for e in idx.json()["scenarios"]) == ["con_104", "nom_104", "opt_104"]


@pytest.mark.parametrize("crew", [{"suit_kg": "heavy"}, {"helmet_kg": 2.0},
                                  {"tools_kg": None}, {"effort_cap_frac": [0.5]}])
def test_schema_invalid_crew_is_422(server_data, crew):
    doc = with_crew(custom_inputs(server_data / "terrain"), crew)
    with TestClient(_app(plan_job.PLAN_JOB)) as c:
        r = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": doc})
        assert r.status_code == 422, r.text
        assert r.json()["error"] == "invalid_inputs"
        assert c.app.state.jobs.jobs_started == 0


def test_suit_mass_job_ends_as_error_naming_it(server_data):
    doc = with_crew(custom_inputs(server_data / "terrain", east_m=75.0), {"suit_kg": 120.0})
    with TestClient(_app(plan_job.PLAN_JOB)) as c:
        j = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": doc}).json()
        body = _wait(c, j["id"])
    assert body["status"] == "error" and "crew.suit_kg" in body["error"]
