"""plan_inputs ``route`` in the plan job (D97 waypoint block, package R3).

Known answers (written before the code):
- every route 422 code answers with ``Error.stop`` = the index of the stop the detail names
  (null for route_mode_conflict, which concerns the whole route), and the detail names the stop
  ("stop 2 (S9): unknown station ...");
- the limits are config/backend.yaml's (route.max_stops, route.max_free_points,
  route.min_stop_spacing_m, limits.title_max_chars): a patched config moves the answer;
- a free point passes the route checks but is refused as unsupported_inputs with its stop index
  (not planned before R4); POST /plans/import answers exactly as POST /jobs; POST /pads/screen
  refuses an ordered route (unsupported_inputs naming route);
- a missing route and ``mode: auto`` are today's job: the same build_plan call (no ``route``
  argument), the same hash, and the official pad attaches to the precomputed tree without a run;
- the same stations in another order hash differently;
- an ordered route passes its station ids, in order, to build_plan in the preview and the full
  call;
- the run record carries route_mode (on every record) and the default scenario's feasibility,
  with the v1.1 ``infeasible`` mirror when false, and validates against run_record.schema.json;
  an infeasible answer is a job ``done``, not an error;
- a stop the engine cannot route at all ends the job ``error`` with its code and the stop named.
"""

from __future__ import annotations

import copy
import inspect
import json
import time

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from pipeline.engine import provenance  # noqa: E402
from server.engine import jobs, plan_job, results  # noqa: E402
from server.engine import route as route_mod  # noqa: E402
from server.engine.defaults import stations  # noqa: E402
from server.engine.hashing import (  # noqa: E402
    EngineIdentity,
    canonical_inputs,
    official_hash,
    official_inputs,
    result_hash,
)
from server.settings import settings  # noqa: E402
from server.tests import test_plan_job as PJ  # noqa: E402
from server.tests.test_jobs import assert_valid  # noqa: E402
from server.tests.test_limits import IP_A, app_clients  # noqa: E402
from server.tests.test_plan_job import EAST_M, IDENT, _app, custom_inputs  # noqa: E402

world = PJ.world  # the synthetic-world fixtures of the plan job tests, by name
server_data = PJ.server_data

PREFIX = settings().api.prefix
PAD = {"lon": 137.393301, "lat": -4.776468}  # demo pad rank 2 (546 m from S8, the nearest)
FEASIBLE = {"feasible": True}
INFEASIBLE = {"feasible": False, "leg": 2, "from": "S1", "to": "S2", "limit": "O2",
              "shortfall_min": 12.4, "legs_planned": 2}


def summary(default_block: dict) -> dict:
    """build_plan's summary route block (WP1): feasibility keyed by scenario, the record carries
    route.feasibility[route.scenario]; another scenario's block must not be the answer."""
    return {"route": {"mode": "ordered", "stops": ["S4", "S1", "S2"], "scenario": "nom_104",
                      "feasibility": {"opt_104": {"feasible": True}, "nom_104": default_block,
                                      "con_104": INFEASIBLE}}}


def doc(stops, pad=PAD, **extra) -> dict:
    out = {"contract_version": settings().contract_version, "pad": dict(pad), **extra}
    if stops is not None:
        out["route"] = {"mode": "ordered", "stops": stops}
    return out


def st(*ids) -> list[dict]:
    return [{"station": i} for i in ids]


def station(sid: str) -> dict:
    return next(s for s in stations() if s["id"] == sid)


def cfg_with(**route) -> object:
    cfg = settings()
    upd = {"route": cfg.route.model_copy(update={k: v for k, v in route.items()
                                                 if k != "title_max_chars"})}
    if "title_max_chars" in route:
        upd["limits"] = cfg.limits.model_copy(update={"title_max_chars": route["title_max_chars"]})
    return cfg.model_copy(update=upd)


def refused(plan_inputs, cfg=None) -> route_mod.RouteError:
    with pytest.raises(route_mod.RouteError) as e:
        route_mod.validate(plan_inputs, cfg)
    return e.value


# ---------------------------------------------------------------------- the 422 codes ----
def test_limits_are_the_config_values():
    r = settings().route
    assert (r.max_stops, r.max_free_points, r.min_stop_spacing_m) == (8, 4, 50)
    assert settings().limits.title_max_chars == 120


def test_a_good_ordered_route_passes():
    route_mod.validate(doc(st("S4", "S1", "S2")))
    route_mod.validate(doc(None))
    route_mod.validate({**doc(None), "route": {"mode": "auto"}})


def test_unknown_station_names_the_stop():
    e = refused(doc(st("S4", "S1", "S9")))
    assert (e.code, e.stop) == ("route_station_unknown", 2)
    assert e.detail.startswith("stop 2 (S9): unknown station")


def test_duplicate_station_names_the_repeat():
    e = refused(doc(st("S1", "S2", "S1")))
    assert (e.code, e.stop) == ("route_station_duplicate", 2)
    assert e.detail.startswith("stop 2 (S1):") and "already stop 0" in e.detail


def test_too_many_stops_names_the_first_one_over():
    ids = [s["id"] for s in stations()]
    stops = st(*(ids + ids)[:settings().route.max_stops + 1])
    e = refused(doc(stops))
    assert (e.code, e.stop) == ("route_too_many_stops", settings().route.max_stops)
    assert "route.max_stops" in e.detail


def test_too_many_free_points_names_the_first_one_over():
    n = settings().route.max_free_points
    free = [{"lon": PAD["lon"] + 0.002 * (k + 1), "lat": PAD["lat"]} for k in range(n + 1)]
    e = refused(doc(st("S8") + free))
    assert (e.code, e.stop) == ("route_too_many_free_points", n + 1)
    assert e.detail.startswith(f"stop {n + 1} (W{n + 1}):")


def test_a_label_over_the_title_cap_names_the_stop():
    cap = settings().limits.title_max_chars
    e = refused(doc(st("S8") + [{"lon": 137.39, "lat": -4.78, "label": "x" * (cap + 1)}]))
    assert (e.code, e.stop) == ("route_label_too_long", 1)
    assert "limits.title_max_chars" in e.detail


def test_a_stop_on_the_pad_is_too_close():
    s1 = station("S1")
    e = refused(doc(st("S4", "S1"), pad={"lon": s1["lon"], "lat": s1["lat"]}))
    assert (e.code, e.stop) == ("route_stop_spacing", 1)
    assert "the pad" in e.detail and "route.min_stop_spacing_m" in e.detail


def test_two_stops_too_close_names_the_later_one():
    s4 = station("S4")
    near = {"lon": s4["lon"] + 0.0003, "lat": s4["lat"]}  # ~18 m east of S4
    e = refused(doc(st("S1", "S4") + [near]))
    assert (e.code, e.stop) == ("route_stop_spacing", 2)
    assert e.detail.startswith("stop 2 (W1):") and "stop 1 (S4)" in e.detail


def test_route_with_stations_set_or_custom_conflicts():
    e = refused(doc(st("S4"), stations={"mode": "set", "ids": ["S4"]}))
    assert (e.code, e.stop) == ("route_mode_conflict", None)
    custom = {"mode": "best", "custom": [{"id": "U1", "lon": 137.39, "lat": -4.79}]}
    assert refused(doc(st("S4"), stations=custom)).code == "route_mode_conflict"


def test_a_free_point_is_unsupported_with_its_index():
    e = refused(doc(st("S8") + [{"lon": 137.39, "lat": -4.79, "label": "rock"}]))
    assert (e.code, e.stop) == ("unsupported_inputs", 1)
    assert e.detail.startswith("stop 1 (W1 'rock'):")


# --------------------------------------------------------------------- limits from config ----
def test_limits_follow_a_patched_config(monkeypatch):
    three = doc(st("S4", "S1", "S2"))
    route_mod.validate(three)
    assert refused(three, cfg_with(max_stops=2)).stop == 2
    # S6 and S7 are 602 m apart: a 700 m spacing refuses the second
    six_seven = doc(st("S6", "S7"))
    route_mod.validate(six_seven)
    e = refused(six_seven, cfg_with(min_stop_spacing_m=700.0))
    assert (e.code, e.stop) == ("route_stop_spacing", 1)
    label = doc(st("S8") + [{"lon": 137.39, "lat": -4.79, "label": "x" * 11}])
    assert refused(label).code == "unsupported_inputs"  # 11 chars are within the real cap
    assert refused(label, cfg_with(title_max_chars=10)).code == "route_label_too_long"
    two_free = doc([{"lon": 137.39, "lat": -4.79}, {"lon": 137.395, "lat": -4.79}])
    assert refused(two_free, cfg_with(max_free_points=1)).code == "route_too_many_free_points"
    # the routes read the live settings(): patch it there
    monkeypatch.setattr(route_mod, "settings", lambda: cfg_with(max_stops=2))
    assert refused(three).code == "route_too_many_stops"


# ------------------------------------------------------------------------ through the API ----
@pytest.fixture
def api_data(tmp_path, monkeypatch):
    sd = tmp_path / "server"
    sd.mkdir()
    monkeypatch.setenv("HL_SERVER_DATA", str(sd))
    monkeypatch.delenv(settings().deploy.kill_switch_env, raising=False)
    return sd


CASES = [
    (st("S4", "S1", "S9"), {}, "route_station_unknown", 2, "stop 2 (S9): unknown station"),
    (st("S1", "S2", "S1"), {}, "route_station_duplicate", 2, "stop 2 (S1):"),
    (st("S8", "S1") + [{"lon": 137.39, "lat": -4.79}], {}, "unsupported_inputs", 2,
     "stop 2 (W1):"),
    (st("S4"), {"stations": {"mode": "order", "ids": ["S4"]}}, "route_mode_conflict", None,
     "stations.mode 'order'"),
]


@pytest.mark.parametrize(("stops", "extra", "code", "stop", "starts"), CASES)
def test_jobs_and_import_answer_422_naming_the_stop(api_data, stops, extra, code, stop, starts):
    body = doc(stops, **extra)
    with app_clients(IP_A) as (c,):
        r = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": body})
        assert r.status_code == 422
        err = assert_valid(r, "post", "/jobs")
        assert (err["error"], err["stop"]) == (code, stop)
        assert starts in err["detail"]
        assert r.headers["cache-control"] == "no-store"
        imp = c.post(f"{PREFIX}/plans/import", content=json.dumps(body).encode(),
                     headers={"content-type": "application/json"})
        assert imp.status_code == 422
        assert assert_valid(imp, "post", "/plans/import") == err
        assert c.runner.jobs_started == 0


def test_import_of_an_ordered_route_keeps_its_hash_and_inputs(api_data):
    body = doc(st("S4", "S1", "S2"), title="Ridge loop, my order")
    with app_clients(IP_A) as (c,):
        imp = c.post(f"{PREFIX}/plans/import", content=json.dumps(body).encode(),
                     headers={"content-type": "application/json"})
        assert imp.status_code == 200, imp.text
        out = assert_valid(imp, "post", "/plans/import")
    assert out["hash"] == result_hash(body, IDENT)
    assert out["inputs"]["route"] == body["route"]
    assert out["inputs"]["title"] == body["title"]


def test_screen_refuses_an_ordered_route(api_data):
    with app_clients(IP_A) as (c,):
        r = c.post(f"{PREFIX}/pads/screen", json=doc(st("S4", "S1")))
    assert r.status_code == 422
    body = r.json()
    assert body["error"] == "unsupported_inputs" and "route" in body["detail"]


def test_record_inputs_put_labels_and_title_back():
    raw = doc(st("S8") + [{"lon": 137.39, "lat": -4.79, "label": "rock"}], title="t")
    c = canonical_inputs(raw)
    assert "label" not in c["route"]["stops"][1] and "title" not in c
    rec = route_mod.record_inputs(raw, c)
    assert rec["route"]["stops"][1]["label"] == "rock" and rec["title"] == "t"
    assert rec["route"]["stops"][1]["lon"] == c["route"]["stops"][1]["lon"]
    assert "label" not in c["route"]["stops"][1]  # canonical untouched
    plain = doc(None)
    assert route_mod.record_inputs(plain, canonical_inputs(plain)) == canonical_inputs(plain)


# ------------------------------------------------------------------------------- the hash ----
def test_order_changes_the_hash_and_auto_is_no_route():
    a = result_hash(doc(st("S4", "S1", "S2")), IDENT)
    b = result_hash(doc(st("S1", "S4", "S2")), IDENT)
    assert a != b
    none = result_hash(doc(None), IDENT)
    auto = result_hash({**doc(None), "route": {"mode": "auto"}}, IDENT)
    assert auto == none and none not in (a, b)
    off = official_inputs()
    assert result_hash({**off, "route": {"mode": "auto", "stops": []}}, IDENT) == \
        official_hash(IDENT)
    labelled = doc([{"station": "S4"}, {"lon": 137.39, "lat": -4.79, "label": "a"}])
    relabelled = copy.deepcopy(labelled)
    relabelled["route"]["stops"][1]["label"] = "b"
    assert result_hash(labelled, IDENT) == result_hash(relabelled, IDENT)


def test_auto_route_on_the_official_pad_attaches_to_the_precomputed_tree(server_data):
    ident = EngineIdentity(IDENT.engine_tree, IDENT.config_hash, IDENT.terrain_hash)
    with TestClient(_app(plan_job.PLAN_JOB)) as c:
        r = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": {
            **official_inputs(), "route": {"mode": "auto"}}})
        assert r.status_code == 202
        body = r.json()
        assert body["status"] == "done" and body["hash"] == official_hash(ident)
        assert c.app.state.jobs.jobs_started == 0


# ---------------------------------------------------------------------- the build_plan call ----
class Recorder:
    def __init__(self, summary=None):
        self.calls: list[dict] = []
        self.summary = summary or {}

    def __call__(self, grid, **kw):
        self.calls.append(kw)
        return self.summary


def _build(monkeypatch, world, tmp_path, inputs, preview):
    import pipeline.engine.plan as plan_mod

    rec = Recorder()
    monkeypatch.setattr(plan_mod, "build_plan", rec)
    plan_job.build(inputs, terrain_dir=world / "terrain", out_dir=tmp_path / "o",
                   manifest_dir=tmp_path / "m", conditions=False, rad_json=tmp_path / "r",
                   grid=object(), preview=preview)
    return rec.calls[0]


@pytest.mark.parametrize("preview", [True, False])
def test_auto_or_missing_route_is_todays_call(monkeypatch, world, tmp_path, preview):
    base = custom_inputs(world / "terrain")
    missing = _build(monkeypatch, world, tmp_path, base, preview)
    auto = _build(monkeypatch, world, tmp_path, {**base, "route": {"mode": "auto"}}, preview)
    assert "route" not in missing and auto == missing
    assert plan_job.unsupported({**base, "route": {"mode": "auto"}}) == []


@pytest.mark.parametrize("preview", [True, False])
def test_ordered_route_passes_station_ids_in_order(monkeypatch, world, tmp_path, preview):
    base = custom_inputs(world / "terrain")
    plain = _build(monkeypatch, world, tmp_path, base, preview)
    inputs = {**base, "route": {"mode": "ordered", "stops": st("S2", "S1")}}
    assert plan_job.unsupported(inputs) == []
    call = _build(monkeypatch, world, tmp_path, inputs, preview)
    assert call.pop("route") == ["S2", "S1"]
    assert call == plain  # everything else is today's call
    rev = {**base, "route": {"mode": "ordered", "stops": st("S1", "S2")}}
    assert _build(monkeypatch, world, tmp_path, rev, preview)["route"] == ["S1", "S2"]


def test_a_free_point_is_still_unsupported_in_the_job(world, tmp_path):
    inputs = {**custom_inputs(world / "terrain"),
              "route": {"mode": "ordered", "stops": [{"lon": 137.39, "lat": -4.79}]}}
    assert plan_job.unsupported(inputs) == ["route"]
    with pytest.raises(plan_job.UnsupportedInputs, match="route"):
        plan_job.build(inputs, terrain_dir=world / "terrain", out_dir=tmp_path / "o",
                       manifest_dir=tmp_path / "m", conditions=False, rad_json=tmp_path / "r")


def test_a_stop_the_engine_cannot_route_is_named(monkeypatch, world, tmp_path):
    class RouteStopError(ValueError):  # the shape of pipeline.engine.traverse.RouteStopError
        def __init__(self, index, code, message):
            super().__init__(message)
            self.index, self.code, self.message = index, code, message

    def boom(*a, **k):
        raise RouteStopError(1, "route_point_unreachable", "no access cell in nom_104")

    monkeypatch.setattr(plan_job, "_route_stop_error", lambda: RouteStopError)
    monkeypatch.setattr(plan_job, "build", boom)
    inputs = {**custom_inputs(world / "terrain"),
              "route": {"mode": "ordered", "stops": st("S2", "S1")}}
    with pytest.raises(plan_job.RouteStopFailed) as e:
        plan_job._build_job(canonical_inputs(inputs))
    assert (e.value.code, e.value.stop) == ("route_point_unreachable", 1)
    assert str(e.value) == ("route_point_unreachable: stop 1 (S1): no access cell in nom_104")


def test_the_mapped_exception_is_the_engines():
    from pipeline.engine import traverse

    want = getattr(traverse, "RouteStopError", ())  # () before WP1: nothing is caught
    assert plan_job._route_stop_error() is want


# ------------------------------------------------------------------------- the run record ----
def test_route_answer_from_the_summary():
    ordered = canonical_inputs(doc(st("S4", "S1", "S2")))
    auto = canonical_inputs(doc(None))
    assert plan_job.route_answer(auto, {}) == {"route_mode": "auto"}
    assert plan_job.route_answer(ordered, summary(FEASIBLE)) == {
        "route_mode": "ordered", "feasibility": FEASIBLE}
    assert plan_job.route_answer(ordered, summary(INFEASIBLE)) == {
        "route_mode": "ordered", "feasibility": INFEASIBLE,
        "infeasible": {"leg": 2, "from": "S1", "to": "S2", "margin_min": -12.4,
                       "binding": "O2"}}
    with pytest.raises(RuntimeError, match="feasibility"):
        plan_job.route_answer(ordered, {})
    with pytest.raises(RuntimeError, match="feasibility"):  # the pre-WP1 shape (no scenario key)
        plan_job.route_answer(ordered, {"route": {"feasibility": FEASIBLE}})


class Pipe:
    def __init__(self):
        self.sent = []

    def send(self, msg):
        self.sent.append(msg)


def _record(tmp_path, inputs, extra) -> dict:
    out, pub = tmp_path / ".job-r", tmp_path / "pub"
    out.mkdir()

    def run(_inputs, ctx):
        ctx.write_json("summary.json", {"ok": True})
        ctx.stage("summary")
        return extra

    base = {"contract_version": settings().contract_version, "hash": "0" * 16,
            "origin": "computed_live", "label": settings().labels.live, "inputs": inputs,
            "engine": {"tree": "a" * 40, "commit": "a" * 40, "config_hash": "sha256:" + "b" * 64,
                       "web_contract_version": "1.0.0", "backend_contract_version": "1.2.0"},
            "terrain_hash": "sha256:" + "c" * 64}
    pipe = Pipe()
    jobs._run_job(pipe, "j", run, inputs, str(out), str(pub), base, ("summary",))
    assert pipe.sent[-1] == ("done", "j")
    rec = json.loads((pub / results.RUN_RECORD).read_text())
    results.validate_run_record(rec)
    return rec


@pytest.mark.parametrize("feas", [FEASIBLE, INFEASIBLE])
def test_run_record_carries_route_mode_and_feasibility(tmp_path, feas):
    raw = doc(st("S4", "S1", "S2"), title="Ridge loop, my order")
    inputs = route_mod.record_inputs(raw, canonical_inputs(raw))
    extra = plan_job.route_answer(inputs, summary(feas))
    rec = _record(tmp_path, inputs, {"range_flags": [], **extra})
    assert rec["status"] == "done" and rec["route_mode"] == "ordered"
    assert rec["feasibility"] == feas
    assert rec["inputs"]["route"]["stops"] == st("S4", "S1", "S2")
    if feas["feasible"]:
        assert rec["infeasible"] is None
    else:
        assert rec["infeasible"] == {"leg": 2, "from": "S1", "to": "S2", "margin_min": -12.4,
                                     "binding": "O2"}


def test_every_record_has_a_route_mode(tmp_path):
    rec = _record(tmp_path, canonical_inputs(doc(None)), {"range_flags": []})
    assert rec["route_mode"] == "auto" and "feasibility" not in rec and rec["infeasible"] is None


def run_infeasible(inputs: dict, ctx) -> dict:
    """Module level (pickled into the spawned worker): an infeasible ordered answer."""
    for name in plan_job.STAGES:
        ctx.write_json(f"{name}.json", {"stage": name})
        ctx.stage(name)
    return plan_job.route_answer(inputs, summary(INFEASIBLE))


def test_an_infeasible_route_is_a_done_job(server_data):
    body = custom_inputs(server_data / "terrain", east_m=5 * EAST_M)
    body["route"] = {"mode": "ordered", "stops": st("S2", "S1")}
    h = result_hash(body, IDENT)
    with TestClient(_app(jobs.JobType(run_infeasible, plan_job.STAGES))) as c:
        r = c.post(f"{PREFIX}/jobs", json={"type": "plan", "inputs": body})
        assert r.status_code == 202, r.text
        j = r.json()
        t0 = time.monotonic()
        while (s := c.get(f"{PREFIX}/jobs/{j['id']}").json())["status"] not in (
                "done", "error", "timeout"):
            assert time.monotonic() - t0 < 60, s
            time.sleep(0.05)
        assert s["status"] == "done" and s["error"] is None, s
        rec = c.get(f"{PREFIX}/results/{h}/provenance").json()
    results.validate_run_record(rec)
    assert rec["route_mode"] == "ordered" and rec["feasibility"] == INFEASIBLE
    assert rec["infeasible"]["binding"] == "O2"


# ------------------------------------------------- the real engine (synthetic world, R1) ----
def _engine_has_route() -> bool:
    from pipeline.engine.plan import build_plan

    return "route" in inspect.signature(build_plan).parameters


@pytest.mark.skipif(not _engine_has_route(), reason="build_plan has no route yet (R1)")
def test_ordered_route_job_on_the_synthetic_world(world, tmp_path, monkeypatch):
    from server.tests.test_plan_job import Conn
    from tools.validate_contracts import CONTRACTS_DIR, Report, check_tree, load_schemas

    monkeypatch.setenv("HL_SERVER_DATA", str(world))
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "stray_manifest"))
    raw = {**custom_inputs(world / "terrain"),
           "route": {"mode": "ordered", "stops": st("S2", "S1")}}
    inp = route_mod.record_inputs(raw, canonical_inputs(raw))
    out, pub = tmp_path / ".job-x", tmp_path / "public"
    out.mkdir()
    conn = Conn(pub)
    ctx = jobs.JobContext(conn, "j_route", out, pub, plan_job.STAGES)
    extra = plan_job.run_plan_job(inp, ctx)
    assert [e[0] for e in conn.events] == list(plan_job.STAGES)
    assert extra["route_mode"] == "ordered" and "feasible" in extra["feasibility"]
    if extra["feasibility"]["feasible"] is False:
        assert extra["infeasible"]["margin_min"] == -extra["feasibility"]["shortfall_min"]
    report = Report()
    n = check_tree(pub, load_schemas(CONTRACTS_DIR, report), report, public=True)
    assert n > 5 and report.ok, report.errors[:10]
