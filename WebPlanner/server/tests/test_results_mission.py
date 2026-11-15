"""GET /results/{official_hash}/mission.json (D110, WP9c): the official plan's simulator export.

Known answers: for the official (precomputed) hash the route serves
web/public/sim/official/mission.json byte for byte (application/json, immutable, content ETag,
304), the one file of the official result served from outside web/public/data/; any other path
under that hash still resolves inside web/public/data/ only (sim/official/mission.json, traversal
to it: 404); unknown hashes are 404; a computed tree serves its own mission.json and a computed
tree without one is 404; a missing official file is 404 file_not_found; the official run record
does not list it and web/public/data/ is not written.
"""

import hashlib

import pytest

pytest.importorskip("fastapi")  # server dependency group (uv sync --group server)
pytest.importorskip("httpx")

from server.engine import results  # noqa: E402
from server.tests import test_results as tr  # noqa: E402
from server.tests.test_results import DATA, OFFICIAL, OTHER, UNKNOWN, assert_error, get  # noqa: E402

server_data = tr.server_data  # the same fixtures as test_results.py (temp server data, IDENT)
client = tr.client

MISSION = results.REPO / "web" / "public" / "sim" / "official" / "mission.json"
IMMUTABLE = "public, max-age=31536000, immutable"


def test_official_hash_serves_the_official_mission(client):
    assert results.OFFICIAL_MISSION == MISSION and MISSION.is_file()
    r = get(client, OFFICIAL, "mission.json")
    assert r.status_code == 200, r.text
    assert r.content == MISSION.read_bytes()
    assert r.headers["content-type"].startswith("application/json")
    assert r.headers["cache-control"] == IMMUTABLE
    tag = r.headers["etag"]
    assert tag == f'"{hashlib.sha256(MISSION.read_bytes()).hexdigest()[:32]}"'
    again = get(client, OFFICIAL, "mission.json", headers={"If-None-Match": tag})
    assert again.status_code == 304
    doc = r.json()
    assert doc["origin"] == "precomputed" and doc["origin_label"] == "Precomputed · official plan"


@pytest.mark.parametrize("path", [
    "sim/official/mission.json", "official/mission.json", "scenarios/mission.json",
    "mission.json/", "%2e%2e/sim/official/mission.json", "..%2fsim%2fofficial%2fmission.json",
    "Mission.json", "mission.geojson",
])
def test_other_paths_stay_inside_the_data_tree(client, path):
    r = get(client, OFFICIAL, path)
    assert r.status_code in (400, 404), (path, r.status_code)
    if r.status_code == 404:
        assert r.json()["error"] in ("invalid_path", "file_not_found")


def test_unknown_hash_is_404(client):
    assert_error(get(client, UNKNOWN, "mission.json"), 404, "unknown_result")


def test_computed_tree_serves_its_own_mission_or_404(client, server_data):
    assert_error(get(client, OTHER, "mission.json"), 404, "file_not_found")
    own = server_data / "results" / OTHER / "mission.json"
    own.write_bytes(b'{"origin": "computed_live"}\n')
    r = get(client, OTHER, "mission.json")
    assert r.status_code == 200 and r.content == own.read_bytes()


def test_missing_official_file_is_404(client, monkeypatch, tmp_path):
    monkeypatch.setattr(results, "OFFICIAL_MISSION", tmp_path / "official" / "mission.json")
    assert_error(get(client, OFFICIAL, "mission.json"), 404, "file_not_found")


def test_run_record_does_not_list_it_and_data_is_not_written(client):
    before = sorted(DATA.rglob("*"))
    rec = get(client, OFFICIAL, "run_record.json").json()
    assert "mission.json" not in {f["path"] for f in rec["files"]}
    assert get(client, OFFICIAL, "mission.json").status_code == 200
    assert not (DATA / "mission.json").exists()
    assert sorted(DATA.rglob("*")) == before
