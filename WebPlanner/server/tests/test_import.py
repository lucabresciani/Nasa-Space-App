"""POST /plans/import and GET /results/{hash}/provenance (WS12 plan row 2.5, brief tasks 5 and 6;
F28, F35; spec §8).

Known answers (written before the route):
- a body over limits.upload_max_bytes is refused with 413 (by Content-Length, and by the bytes
  actually sent when the header is absent);
- a body that is not JSON, not a plan_inputs object, has unknown fields, or a title over
  limits.title_max_chars is refused with 422;
- a valid import answers 200 ImportResult: the D57 hash (the same as POST /jobs takes), the
  canonical inputs (title kept, as the run record does), and computed = whether a complete result
  exists (the official inputs: true; new inputs: false, then true once the job is done);
- an import never starts a job;
- the provenance of an imported hash matches openapi RunRecord, an unknown hash is 404 Error;
- every response validates against contracts/backend/openapi.yaml.
"""

from __future__ import annotations

import json

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from jsonschema import Draft202012Validator  # noqa: E402

from server.api.compute import identity_provider  # noqa: E402
from server.engine.hashing import canonical_inputs, official_inputs, result_hash  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_app import API_ID, REGISTRY  # noqa: E402
from server.tests.test_jobs import IDENT, assert_valid, finished, inputs, submit, wait_job  # noqa: E402
from server.tests.test_limits import IP_A, app_clients  # noqa: E402

PREFIX = settings().api.prefix
IMPORT = f"{PREFIX}/plans/import"
MAX = settings().limits.upload_max_bytes
TITLE_MAX = settings().limits.title_max_chars


@pytest.fixture
def server_data(tmp_path, monkeypatch):
    sd = tmp_path / "server"
    sd.mkdir()
    monkeypatch.setenv("HL_SERVER_DATA", str(sd))
    monkeypatch.delenv(settings().deploy.kill_switch_env, raising=False)
    return sd


def post(c, body: bytes, **headers):
    return c.post(IMPORT, content=body, headers={"content-type": "application/json", **headers})


def test_limits_are_the_config_values():
    assert MAX == 1024 * 1024 and TITLE_MAX == 120


# --------------------------------------------------------------------------------- 200 ----
def test_the_official_inputs_import_as_computed(server_data):
    with app_clients(IP_A) as (c,):
        doc = {**official_inputs(), "title": "my copy of the official plan"}
        r = c.post(IMPORT, json=doc)
        assert r.status_code == 200
        b = assert_valid(r, "post", "/plans/import")
        assert b["hash"] == result_hash(official_inputs(), IDENT)
        assert b["computed"] is True
        assert b["inputs"] == {**canonical_inputs(doc), "title": doc["title"]}
        assert r.headers["Cache-Control"] == "no-store"
        # its provenance is served and matches openapi RunRecord
        p = c.get(f"{PREFIX}/results/{b['hash']}/provenance")
        rec = assert_valid(p, "get", "/results/{hash}/provenance")
        assert rec["hash"] == b["hash"] and rec["origin"] == "precomputed"
        assert c.runner.jobs_started == 0


def test_new_inputs_import_as_not_computed_until_the_job_is_done(server_data):
    with app_clients(IP_A) as (c,):
        doc = inputs(127.0, "an imported plan")
        b = assert_valid(c.post(IMPORT, json=doc), "post", "/plans/import")
        assert b["computed"] is False and b["hash"] == result_hash(doc, IDENT)
        assert b["inputs"]["title"] == "an imported plan"
        assert c.runner.jobs_started == 0 and c.runner.queue_length == 0  # no job started
        p = c.get(f"{PREFIX}/results/{b['hash']}/provenance")
        assert p.status_code == 404
        assert assert_valid(p, "get", "/results/{hash}/provenance")["error"] == "unknown_result"
        j = submit(c, doc).json()
        assert j["hash"] == b["hash"]  # the import hash is the job hash
        assert wait_job(c, j["id"], finished)["status"] == "done"
        again = assert_valid(c.post(IMPORT, json=doc), "post", "/plans/import")
        assert again["computed"] is True and again["hash"] == b["hash"]
        rec = assert_valid(c.get(f"{PREFIX}/results/{b['hash']}/provenance"), "get",
                           "/results/{hash}/provenance")
        assert rec["origin"] == "computed_live" and rec["label"] == settings().labels.live


def test_a_title_at_the_cap_is_accepted(server_data):
    with app_clients(IP_A) as (c,):
        r = c.post(IMPORT, json=inputs(127.1, "x" * TITLE_MAX))
        assert r.status_code == 200


def test_a_file_just_under_the_size_cap_is_accepted(server_data):
    doc = inputs(127.2, "pad")
    raw = json.dumps(doc).encode()
    body = raw[:-1] + b" " * (MAX - len(raw)) + b"}"  # whitespace padding: still JSON
    assert len(body) == MAX
    with app_clients(IP_A) as (c,):
        assert post(c, body).status_code == 200


# --------------------------------------------------------------------------------- 413 ----
def test_an_oversized_upload_is_413(server_data):
    doc = inputs(127.3)
    raw = json.dumps(doc).encode()
    body = raw[:-1] + b" " * (MAX + 1 - len(raw)) + b"}"
    assert len(body) == MAX + 1
    with app_clients(IP_A) as (c,):
        r = post(c, body)
        assert r.status_code == 413
        assert assert_valid(r, "post", "/plans/import")["error"] == "too_large"


def test_an_oversized_upload_without_content_length_is_413(server_data):
    def chunks():
        for _ in range(MAX // 65536 + 2):
            yield b" " * 65536

    with app_clients(IP_A) as (c,):
        r = c.post(IMPORT, content=chunks(), headers={"content-type": "application/json"})
        assert r.status_code == 413
        assert assert_valid(r, "post", "/plans/import")["error"] == "too_large"


def test_a_lying_content_length_header_is_413(server_data):
    with app_clients(IP_A) as (c,):
        r = post(c, b"{}", **{"content-length": str(MAX + 1)})
        assert r.status_code == 413


# --------------------------------------------------------------------------------- 422 ----
@pytest.mark.parametrize("body,code", [
    (b"", "invalid_json"),
    (b"{not json", "invalid_json"),
    (b"\xff\xfe\x00", "invalid_json"),
    (b"[]", "invalid_inputs"),
    (b"\"plan\"", "invalid_inputs"),
    (b"{}", "invalid_inputs"),
    (b'{"contract_version": "1.0.1"}', "invalid_inputs"),
    (b'{"contract_version": "1.0.1", "pad": {"lon": 999, "lat": 1}}', "invalid_inputs"),
    (b'{"contract_version": "1.0.1", "pad": {"lon": NaN, "lat": 1}}', "invalid_json"),  # RFC 8259
    (b'{"contract_version": "9.0.0", "pad": {"lon": 1, "lat": 1}}', "invalid_inputs"),
    # unknown fields, at the top and nested
    (b'{"contract_version": "1.0.1", "pad": {"lon": 1, "lat": 1}, "owner": "x"}', "invalid_inputs"),
    (b'{"contract_version": "1.0.1", "pad": {"lon": 1, "lat": 1, "alt": 3}}', "invalid_inputs"),
    (b'{"contract_version": "1.0.1", "pad": {"lon": 1, "lat": 1}, "crew": {"hat_kg": 1}}',
     "invalid_inputs"),
])
def test_malformed_imports_are_422(server_data, body, code):
    with app_clients(IP_A) as (c,):
        r = post(c, body)
        assert r.status_code == 422, r.text
        b = assert_valid(r, "post", "/plans/import")
        assert b["error"] == code
        assert c.runner.jobs_started == 0


def test_unknown_fields_are_named_in_the_detail(server_data):
    with app_clients(IP_A) as (c,):
        r = c.post(IMPORT, json={**inputs(127.4), "owner": "x"})
        assert r.status_code == 422
        assert "owner" in json.dumps(r.json()["detail"])


def test_a_title_over_the_cap_is_422(server_data):
    with app_clients(IP_A) as (c,):
        r = c.post(IMPORT, json=inputs(127.5, "x" * (TITLE_MAX + 1)))
        assert r.status_code == 422
        assert assert_valid(r, "post", "/plans/import")["error"] == "title_too_long"


# --------------------------------------------------------------------------------- 503 ----
def test_without_server_data_the_hash_cannot_be_taken(server_data):
    with app_clients(IP_A) as (c,):
        c.app.dependency_overrides.pop(identity_provider)  # live identity: no manifest.json
        r = c.post(IMPORT, json=inputs(127.6))
        assert r.status_code == 503  # not listed for importPlan: the openapi Error shape anyway
        v = Draft202012Validator({"$ref": f"{API_ID}#/components/schemas/Error"},
                                 registry=REGISTRY)
        assert not list(v.iter_errors(r.json()))
        assert r.json()["error"] == "server_data_missing"
