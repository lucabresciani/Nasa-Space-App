"""POST /pads/validate and POST /pads/screen (WS11 plan row 2.2, brief task 6; F24 steps 1-2).

Known answers on the synthetic world (pipeline/engine/synthetic.py, the parity harness's WS1-shaped
copy centred on the official pad, 3.6 km square so that the 1,764 m D21 disc fits around the
centre), served from a temp $HL_SERVER_DATA built by tools/make_serverdata.py:
- a pad on the 35 deg wall gives ``slope``; a pad in the nodata hole gives ``unknown_terrain``; a
  flat pad 1 km from the centre gives ``disc_off_grid``; a pad beyond the grid ``outside_grid``;
  the centre (the official pad) is valid;
- the valid blocks are exactly padpick.candidates' D21 blocks (every block of the grid checked);
- an invalid pad's nearest valid block is the nearest D21 candidate and is itself valid;
- the screen of every D21 candidate equals the engine's own D21 screening (station_access +
  matrices + screen_counts, the batch path): feasible-EVA count, station times, reachability;
  the screening's top candidate (the D21 "official" ranking input) included;
- every response validates against contracts/backend/openapi.yaml; bad input is 422 Error;
  no server data or no engine identity is 503 Error;
- the server data are memory-mapped and loaded once per process (again only when the manifest
  changes).
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402

from pipeline.engine import padpick, physio, siting  # noqa: E402
from pipeline.engine.geo import lonlat_of_xy, xy_of_lonlat  # noqa: E402
from pipeline.engine.graph import load_ws1_grid  # noqa: E402
from pipeline.engine.stations import load_ws1_stations  # noqa: E402
from server.api.compute import identity_provider  # noqa: E402
from server.app import create_app  # noqa: E402
from server.engine import pads, version  # noqa: E402
from server.engine.hashing import official_inputs  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests import parity_harness as H  # noqa: E402
from server.tests.test_app import API_ID, OPENAPI, REGISTRY  # noqa: E402
from tools import make_serverdata as msd  # noqa: E402

PREFIX = settings().api.prefix
HALF_M = 1800.0  # world half-width: the 1,764 m disc (crew.anchor.speed_ms x 30 min) fits
# synthetic features (pipeline/engine/synthetic.dummy_world, metres from the centre, x east)
WALL = (-400.0 + 2.0, 0.0)  # on the 35 deg flank of the 8 m wall at x = -400
HOLE = (500 / math.sqrt(2), -500 / math.sqrt(2))  # nodata hole, r 80 m
NEAR_EDGE = (0.0, 1000.0)  # 5 % plane, far from the hill: flat, but the disc leaves the grid
OUTSIDE = (0.0, HALF_M + 500.0)


# ----------------------------------------------------------------------------- fixtures ----
@pytest.fixture(scope="module")
def world(tmp_path_factory):
    """$HL_SERVER_DATA from make_serverdata on the synthetic world (inputs as E5's tests)."""
    root = tmp_path_factory.mktemp("pads")
    off = official_inputs()["pad"]
    terr = H.synthetic_world(root / "in" / "terrain", (off["lon"], off["lat"]), half_m=HALF_M)
    # a third station in the nodata hole: no access cell, so never reachable (unknown stays
    # unknown: null times)
    st = json.loads((terr / "stations.json").read_text())
    crs = load_ws1_grid(terr).crs
    x, y = xy_of_lonlat(off["lon"], off["lat"], crs)
    lon, lat = lonlat_of_xy(x + HOLE[0], y + HOLE[1], crs)
    st.append({**st[0], "id": "S3", "name": "In the hole", "lon": round(float(lon), 6),
               "lat": round(float(lat), 6), "value": 0.4, "card": "cards/S3.json"})
    (terr / "stations.json").write_text(json.dumps(st), encoding="utf-8")
    cond, cards = root / "in" / "conditions", root / "in" / "cards"
    cond.mkdir()
    cards.mkdir()
    (cond / "clock.json").write_text('{"eva": {"t_dark_min": 400}}\n')
    (cards / "S1.json").write_text('{"station": "S1"}\n')
    out = root / "server"
    msd.make_serverdata(out, terr, cond, cards, say=lambda *a, **k: None)
    return out


@pytest.fixture
def server_data(world, monkeypatch):
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(world))
    return world


@pytest.fixture
def client(server_data):
    with TestClient(create_app(warmup=lambda: None)) as c:
        yield c


@pytest.fixture(scope="module")
def engine(world):
    """The engine's own D21 view of the synthetic world: candidates and the screening."""
    grid = load_ws1_grid(world / "terrain")
    s = padpick.settings_from_config()
    cands, _ = padpick.candidates(grid, s)
    cands = [c for c in cands if c.kind == "block"]
    st, _ = load_ws1_stations(world / "terrain" / "stations.json")
    p = physio.scenario_params(s.scenario)
    gv, tab = grid.with_nogo(p.nogo_deg), physio.grade_table(p)
    acc = [padpick.station_access(gv, tab, x, cands, s.access_radius_m) for x in st]
    t_from, t_to, t_leg = padpick.matrices(acc, cands)
    dwell = [float(x["dwell_min"]) for x in st]
    counts = padpick.screen_counts(t_from, t_to, t_leg, dwell, s.budget_min)
    return {"grid": grid, "s": s, "cands": cands, "st": st, "t_from": t_from, "t_to": t_to,
            "counts": counts}


def lonlat_at(grid, dx: float, dy: float) -> dict:
    """lon/lat of the point dx east, dy north of the world centre (the official pad)."""
    off = official_inputs()["pad"]
    x, y = xy_of_lonlat(off["lon"], off["lat"], grid.crs)
    lon, lat = lonlat_of_xy(x + dx, y + dy, grid.crs)
    return {"lon": round(float(lon), 6), "lat": round(float(lat), 6)}


def assert_api(body, path: str, status: int) -> None:
    """``body`` matches openapi.yaml for POST {path} -> {status}."""
    resp = OPENAPI["paths"][path]["post"]["responses"][str(status)]
    if "$ref" in resp:
        resp = OPENAPI["components"]["responses"][resp["$ref"].rsplit("/", 1)[1]]
    ref = resp["content"]["application/json"]["schema"]["$ref"]
    v = Draft202012Validator({"$ref": f"{API_ID}{ref}"}, registry=REGISTRY)
    errors = sorted(v.iter_errors(body), key=str)
    assert not errors, [e.message for e in errors]


def validate(client, pad: dict, status: int = 200) -> dict:
    r = client.post(f"{PREFIX}/pads/validate", json=pad)
    assert r.status_code == status, r.text
    assert r.headers["cache-control"] == "no-store"
    assert_api(r.json(), "/pads/validate", status)
    return r.json()


def screen(client, inputs: dict, status: int = 200) -> dict:
    r = client.post(f"{PREFIX}/pads/screen", json=inputs)
    assert r.status_code == status, r.text
    assert_api(r.json(), "/pads/screen", status)
    return r.json()


def inputs_at(pad: dict) -> dict:
    return {"contract_version": settings().contract_version, "pad": dict(pad)}


# ---------------------------------------------------------------------- known answers ----
@pytest.mark.parametrize("where, reason", [(WALL, "slope"), (HOLE, "unknown_terrain"),
                                           (NEAR_EDGE, "disc_off_grid"),
                                           (OUTSIDE, "outside_grid")])
def test_invalid_pad_reasons(client, engine, where, reason):
    body = validate(client, lonlat_at(engine["grid"], *where))
    assert body["valid"] is False and body["reason"] == reason
    assert body["detail"]
    if reason == "unknown_terrain":
        assert body["detail"].startswith("no 1 m terrain here")  # spec F24 acceptance
    near = body["nearest_valid"]
    assert near is not None
    # the nearest valid block is itself valid
    again = validate(client, {"lon": near["lon"], "lat": near["lat"]})
    assert again == {"valid": True, "reason": None, "nearest_valid": None}


def test_nearest_valid_is_the_nearest_d21_candidate(client, engine):
    grid = engine["grid"]
    for where in (WALL, HOLE, NEAR_EDGE, OUTSIDE):
        pad = lonlat_at(grid, *where)
        near = validate(client, pad)["nearest_valid"]
        x, y = xy_of_lonlat(pad["lon"], pad["lat"], grid.crs)
        d = [math.hypot(*(np.subtract(grid.xy_of_rc(*c.rc), (x, y)))) for c in engine["cands"]]
        k = int(np.argmin(d))
        assert (near["lon"], near["lat"]) == (engine["cands"][k].lon, engine["cands"][k].lat)
        assert near["distance_m"] == pytest.approx(d[k], abs=0.05)


def test_official_pad_is_valid(client, engine):
    off = official_inputs()["pad"]
    assert validate(client, {"lon": off["lon"], "lat": off["lat"]}) == {
        "valid": True, "reason": None, "nearest_valid": None}


def test_valid_blocks_are_exactly_the_d21_candidates(server_data, engine):
    """Every siting block of the grid: its representative cell validates iff it is one of
    padpick.candidates' D21 blocks (the rule, the disc filter and nothing else)."""
    grid = engine["grid"]
    rule = siting.rule_from_config()
    b = siting.blocks(grid, rule.block_m, rule.max_slope_deg)
    d21 = {c.block for c in engine["cands"]}
    assert d21, "the synthetic world must hold D21 candidates"
    reasons = set()
    for i in range(len(b.candidate)):
        lon, lat = lonlat_of_xy(*grid.xy_of_rc(*b.rep[i]), grid.crs)
        chk = pads.check_pad(round(float(lon), 6), round(float(lat), 6))
        assert chk["valid"] == (i in d21), (i, chk)
        reasons.add(chk["reason"])
    assert reasons == {None, "slope", "unknown_terrain", "disc_off_grid"}


def test_screen_equals_the_engine_d21_screening(client, engine):
    """For every D21 candidate: feasible EVAs, station times and reachability equal the batch
    screening's (padpick.station_access + matrices + screen_counts)."""
    st_ids = [x["id"] for x in engine["st"]]
    assert len(engine["cands"]) >= 2 and engine["counts"].max() > 0
    for k, c in enumerate(engine["cands"]):
        body = screen(client, inputs_at({"lon": c.lon, "lat": c.lat}))
        assert body["feasible_evas"] == int(engine["counts"][k])
        assert [r["id"] for r in body["stations"]] == st_ids
        for j, row in enumerate(body["stations"]):
            tf, tt = engine["t_from"][k, j], engine["t_to"][k, j]
            assert row["reachable"] == bool(np.isfinite(tf) and np.isfinite(tt))
            assert row["t_out_min"] == (round(float(tf), 2) if np.isfinite(tf) else None)
            assert row["t_home_min"] == (round(float(tt), 2) if np.isfinite(tt) else None)
        assert body["stations"][st_ids.index("S3")] == {
            "id": "S3", "t_out_min": None, "t_home_min": None, "reachable": False}
        assert body["label"] == settings().labels.live
        assert body["pad"] == {"lon": c.lon, "lat": c.lat}


def test_screen_of_the_screening_top_candidate(client, engine):
    """The D21 screening's rank-1 candidate: its published screen count and best route."""
    for c, n in zip(engine["cands"], engine["counts"], strict=True):
        c.screen_score = int(n)
    top = padpick.screening_rank(list(engine["cands"]))[0]
    body = screen(client, inputs_at({"lon": top.lon, "lat": top.lat}))
    assert body["feasible_evas"] == top.screen_score > 0
    best = body["best_route"]
    assert best is not None and set(best["order"]) <= {r["id"] for r in body["stations"]
                                                        if r["reachable"]}
    assert 0 < best["total_min"] <= engine["s"].budget_min


def test_screen_refuses_an_invalid_pad(client, engine):
    body = screen(client, inputs_at(lonlat_at(engine["grid"], *WALL)), 422)
    assert body["error"] == "invalid_pad" and body["detail"].startswith("slope")


def test_screen_refuses_non_default_inputs(client):
    inp = official_inputs()
    inp["crew"] = {**inp["crew"], "suit_kg": inp["crew"]["suit_kg"] + 10}
    body = screen(client, inp, 422)
    assert body["error"] == "unsupported_inputs" and "crew" in body["detail"]
    # the defaults written out in full are not "different"
    assert screen(client, official_inputs())["feasible_evas"] >= 0


@pytest.mark.parametrize("payload", [
    {"lon": 137.4}, {"lon": 137.4, "lat": -4.7, "x": 1}, {"lon": "137.4", "lat": -4.7},
    {"lon": True, "lat": -4.7}, [137.4, -4.7], None])
def test_validate_bad_body_is_422(client, payload):
    body = validate(client, payload, 422)
    assert body["error"] == "invalid_request"


def test_bad_json_and_bad_inputs_are_422(client):
    for path in ("/pads/validate", "/pads/screen"):
        r = client.post(f"{PREFIX}{path}", content=b"{not json",
                        headers={"content-type": "application/json"})
        assert r.status_code == 422
        assert_api(r.json(), path, 422)
    body = screen(client, {"pad": {"lon": 137.4, "lat": -4.7}}, 422)  # no contract_version
    assert body["error"] == "invalid_inputs" and isinstance(body["detail"], list)
    body = screen(client, ["not", "inputs"], 422)
    assert body["error"] == "invalid_inputs"


def test_no_server_data_is_503(monkeypatch, tmp_path):
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(tmp_path / "absent"))
    with TestClient(create_app(warmup=lambda: None)) as c:
        for path, body in (("/pads/validate", {"lon": 137.4, "lat": -4.7}),
                           ("/pads/screen", inputs_at({"lon": 137.4, "lat": -4.7}))):
            r = c.post(f"{PREFIX}{path}", json=body)
            assert r.status_code == 503 and r.json()["error"] == "server_data_missing"
            assert_api(r.json(), path, 422)  # the openapi Error shape


def test_no_engine_identity_is_503(server_data):
    def broken():
        raise version.Unavailable("git rev-parse HEAD failed: no git")

    app = create_app(warmup=lambda: None)
    app.dependency_overrides[identity_provider] = lambda: broken
    with TestClient(app) as c:
        r = c.post(f"{PREFIX}/pads/validate", json={"lon": 137.4, "lat": -4.7})
        assert r.status_code == 503 and r.json()["error"] == "engine_identity_unavailable"
        assert_api(r.json(), "/pads/validate", 422)


def test_server_data_memory_mapped_and_loaded_once(server_data):
    w1 = pads.world()
    assert pads.world() is w1
    assert isinstance(w1.grid.elev, np.memmap) and isinstance(w1.grid.cellstate, np.memmap)
    assert all(isinstance(f.forward, np.memmap) and isinstance(f.reverse, np.memmap)
               for f in w1.fields.values())
    assert w1.fields, "station fields of the D21 scenario"
    mf = server_data / version.SERVER_DATA_MANIFEST
    st = mf.stat()
    os.utime(mf, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))  # a rebuilt manifest
    try:
        assert pads.world() is not w1
    finally:
        os.utime(mf, ns=(st.st_atime_ns, st.st_mtime_ns))


def test_answers_are_fast_after_warm_up(client, engine):
    off = official_inputs()["pad"]
    validate(client, {"lon": off["lon"], "lat": off["lat"]})  # warm-up: loads the world
    t0 = time.perf_counter()
    validate(client, lonlat_at(engine["grid"], *WALL))
    screen(client, inputs_at({"lon": off["lon"], "lat": off["lat"]}))
    assert time.perf_counter() - t0 < 2.0


def test_manifest_fields_are_what_the_preview_reads(server_data):
    """The preview reads the D21 scenario's fields at the manifest's access cells."""
    m = json.loads((server_data / "manifest.json").read_text())
    w = pads.world()
    s = padpick.settings_from_config()
    for sid, f in w.fields.items():
        rec = m["stations"][sid]["fields"][s.scenario]
        assert list(f.access_rc) == rec["access_rc"]
        assert Path(f.forward.filename).name == Path(rec["forward"]).name
