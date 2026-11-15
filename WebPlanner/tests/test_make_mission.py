"""tools/make_mission.py --official: the official plan's mission.json (D110, WP9c).

Known answers: the committed web/public/sim/official/mission.json validates against
contracts/bundle/mission.schema.json; origin precomputed with config labels.precomputed; scenario
= scenarios/index.json default; its waypoints are the official route's stations in visit order
(route legs, timeline arrive events); created_utc is the official data's build time (latest
manifest utc), not "now", so two builds give identical bytes and the committed file is up to
date (while the official run's rasters in data/interim are present and unchanged, as for the
bundle fixture); the official numbers (timeline lowest margin, EVA length, station T_home and
O2_home) are carried unchanged; nothing in web/public/data is created, changed or removed (every
file hashed before and after; git sees no change against HEAD); the writer refuses an output inside
web/public/data and writes nothing without the rasters.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

from tools import make_mission as mm

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "web" / "public" / "data"
OUT = REPO / "web" / "public" / "sim" / "official" / "mission.json"
SCHEMA = json.loads((REPO / "contracts/bundle/mission.schema.json").read_text(encoding="utf-8"))
LABELS = yaml.safe_load((REPO / "config/backend.yaml").read_text(encoding="utf-8"))["labels"]


def tree_digest(root: Path) -> dict[str, str]:
    """sha256 of every file under root (hidden ones too), by relative path."""
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file() or p.is_symlink():
            out[p.relative_to(root).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def _json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def official() -> dict:
    return _json(OUT)


@pytest.fixture(scope="module")
def scenario() -> str:
    return _json(DATA / "scenarios" / "index.json")["default"]


@pytest.fixture(scope="module")
def route_legs(scenario) -> list[dict]:
    route = _json(DATA / f"route_{scenario}.geojson")
    return sorted((f["properties"] | {"coords": f["geometry"]["coordinates"]}
                   for f in route["features"]), key=lambda p: p["leg"])


# --- the committed file -------------------------------------------------------------------------

def test_official_mission_validates(official):
    v = Draft202012Validator(SCHEMA)
    errs = [f"{e.json_path}: {e.message}" for e in v.iter_errors(official)]
    assert errs == []
    assert official["schema_version"] == "1.1.0" and official["kind"] == "homeline_mission"
    assert official["dummy"] is False


def test_origin_precomputed_with_the_config_label(official):
    assert official["origin"] == "precomputed"
    assert official["origin_label"] == LABELS["precomputed"] == "Precomputed · official plan"
    assert official["planner"]["routing_grid_res_m"] == 3
    assert official["planner"]["files"]["route"] == "route_nom_104.geojson"


def test_scenario_is_the_default(official, scenario):
    assert official["scenario"]["id"] == scenario == "nom_104"
    assert official["scenario"]["variant"] == "nominal" and official["scenario"]["suit_kg"] == 104


def test_waypoints_are_the_official_route_stations_in_order(official, scenario, route_legs):
    stations = [leg["to"] for leg in route_legs if leg["to"] != "pad"]
    assert stations == ["S7", "S6", "S1", "S4"]  # plan bundle fixture plan.json stations
    wps = official["waypoints"]
    assert [w["index"] for w in wps] == list(range(1, len(stations) + 1))
    # each waypoint is the station (stations.json); its route leg ends at the station's access
    # cell (stations.json access, within one 3 m cell; S6's is 15.5 m from the station)
    by_id = {s["id"]: s for s in _json(DATA / "stations.json")}
    for w, leg in zip(wps, route_legs, strict=False):
        st = by_id[leg["to"]]
        acc = st["access"][scenario]
        assert w["station"] == leg["to"]
        assert w["lonlat"] == pytest.approx([st["lon"], st["lat"]], abs=1e-6), leg["to"]
        assert w["access_dist_m"] == pytest.approx(acc["dist_m"], abs=0.1), leg["to"]
        assert leg["coords"][-1] == pytest.approx([acc["lon"], acc["lat"]], abs=6e-5), leg["to"]
    timeline = _json(DATA / f"timeline_{scenario}.json")
    arrive = [e for e in timeline if e["event"] == "arrive"]
    assert [e["station"] for e in arrive] == stations
    assert [w["arrive_t_min"] for w in wps] == pytest.approx([e["t_min"] for e in arrive], abs=0.01)


def test_frame_is_the_official_pad(official):
    pad = _json(DATA / "pad.json")["pad"]
    f = official["frame"]
    assert f["kind"] == "pad-local" and f["axes"] == {"x": "east", "y": "north", "z": "up"}
    assert (f["pad"]["lon"], f["pad"]["lat"]) == (pad["lon"], pad["lat"])
    assert f["pad"]["kind"] == "official"


def test_created_utc_is_the_official_build_time(official):
    manifest = _json(DATA / "manifest.json")
    times = sorted(v["utc"] for v in manifest.values() if isinstance(v, dict) and v.get("utc"))
    assert official["created_utc"] == mm.build_time() == times[-1]


def test_sim_folder_is_outside_the_data_tree():
    assert OUT.is_file() and not OUT.resolve().is_relative_to(DATA.resolve())
    assert not (DATA / "mission.json").exists() and not (DATA / "sim").exists()


def test_the_official_numbers_are_carried_unchanged(official, scenario):
    timeline = _json(DATA / f"timeline_{scenario}.json")
    planned = [e for e in timeline if e["event"] != "turn_back"]
    low = min(planned, key=lambda e: e["margin_min"])
    assert official["timeline"]["lowest"] == {"margin_min": low["margin_min"],
                                              "binding": low["margin_binding"],
                                              "t_min": low["t_min"]}
    ret = next(e for e in timeline if e["event"] == "return")
    assert official["summary"]["eva_min"] == ret["t_min"]
    assert official["summary"]["feasible"] is True
    stations = {s["id"]: s for s in _json(DATA / "stations.json")}
    for w in official["waypoints"]:
        acc = stations[w["station"]]["access"][scenario]
        assert w["t_home_min"] == acc["t_home_min"], w["station"]
        assert w["o2_home_l"] == pytest.approx(acc["o2_home_L"], abs=0.01), w["station"]
        assert w["z_m"] is not None


def test_raster_sources_are_recorded(official):
    files, sha = official["planner"]["files"], official["planner"]["source_sha256"]
    assert files["elev"] == "data/interim/terrain/elev_3m.tif"
    assert files["t_home"] == "data/interim/engine/nom_104/t_home.tif"
    assert sorted(sha) == ["elev", "o2_home", "t_home"]
    assert all(len(v) == 64 for v in sha.values())


# --- generation: deterministic, up to date, data tree untouched ----------------------------------
# A rebuild needs the official run's rasters (data/interim, not in CI); like the bundle fixture,
# the committed file is compared byte for byte while the recorded source sha256s still match.
WHY_NOT = mm.can_rebuild() if OUT.is_file() else "no committed file"
rebuild = pytest.mark.skipif(WHY_NOT is not None, reason=f"cannot rebuild: {WHY_NOT}")


@rebuild
def test_generating_twice_gives_identical_bytes_and_matches_the_committed_file():
    a = mm.official_bytes()
    b = mm.official_bytes()
    assert a == b
    assert a == OUT.read_bytes(), f"{OUT} is stale: run make mission-official"
    assert mm.main(["--official", "--check"]) == 0


@rebuild
def test_web_public_data_is_byte_identical_before_and_after(tmp_path):
    before = tree_digest(DATA)
    assert len(before) > 3000 and "manifest.json" in before and "scenarios/index.json" in before
    out = mm.write_official(DATA, tmp_path / "sim" / "official" / "mission.json")
    assert out.is_file()
    assert mm.main(["--official", "--out", str(tmp_path / "again.json")]) == 0
    assert (tmp_path / "again.json").read_bytes() == out.read_bytes()
    assert mm.main(["--official", "--check"]) == 0
    assert tree_digest(DATA) == before


@rebuild
def test_check_reports_a_stale_file(tmp_path):
    stale = tmp_path / "mission.json"
    assert mm.main(["--official", "--check", "--out", str(stale)]) == 1  # missing
    stale.write_bytes(OUT.read_bytes().replace(b'"precomputed"', b'"computed_live"'))
    assert mm.main(["--official", "--check", "--out", str(stale)]) == 1


def test_without_rasters_nothing_is_written(tmp_path):
    before = tree_digest(DATA / "scenarios")
    out = tmp_path / "mission.json"
    assert mm.main(["--official", "--interim", str(tmp_path / "none"), "--out", str(out)]) == 2
    assert mm.main(["--official", "--check", "--interim", str(tmp_path / "none")]) == 2
    assert not out.exists()
    assert "not here" in mm.can_rebuild(OUT, tmp_path / "none")
    assert tree_digest(DATA / "scenarios") == before


def test_git_sees_no_change_in_web_public_data():
    diff = subprocess.run(["git", "status", "--porcelain", "--", "web/public/data"], cwd=REPO,
                          check=True, capture_output=True, text=True).stdout
    assert diff == ""


def test_writer_refuses_the_data_tree():
    before = tree_digest(DATA / "scenarios")
    with pytest.raises(ValueError, match="official tree"):
        mm.write_official(DATA, DATA / "mission.json")
    with pytest.raises(ValueError, match="official tree"):
        mm.write_official(DATA, DATA / "scenarios" / "mission.json")
    assert not (DATA / "mission.json").exists()
    assert tree_digest(DATA / "scenarios") == before

