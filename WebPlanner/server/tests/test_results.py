"""GET /results/{hash}/{path} and /results/{hash}/provenance (plan row 1.3, F23, F35).

Known answers: the official pad's hash (server.engine.hashing.official_hash with the identity in
force) serves web/public/data/ byte for byte, nested paths included; a computed result is served
from $HL_SERVER_DATA/results/{hash}/; traversal, hidden, directory and symlink-out paths, unknown
hashes and missing files are 404 with the openapi Error body; result files carry immutable caching
headers and a content ETag; the official tree's run_record.json is synthesised (origin
precomputed), validates against run_record.schema.json, and is never written into
web/public/data/; without the live identity the official hash cannot be taken, so an uncached hash
is 503 (as /engine/version). No real server data is needed: HL_SERVER_DATA is a temp folder and
the identity is injected (or, in the live-identity tests, read from a fake manifest).
"""

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

pytest.importorskip("fastapi")  # server dependency group (uv sync --group server)
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402

from server.api.compute import identity_provider  # noqa: E402
from server.app import create_app  # noqa: E402
from server.engine import results  # noqa: E402
from server.engine.hashing import EngineIdentity, official_hash  # noqa: E402
from server.settings import settings  # noqa: E402
from server.tests.test_app import API_ID, OPENAPI, REGISTRY, assert_valid  # noqa: E402
from tools.validate_contracts import match_schema  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "web" / "public" / "data"
PREFIX = settings().api.prefix
FILE_ROUTE = "/results/{hash}/{path}"
PROV_ROUTE = "/results/{hash}/provenance"
IDENT = EngineIdentity("1" * 40, "sha256:" + "2" * 64, "sha256:" + "3" * 64)
OFFICIAL = official_hash(IDENT)
OTHER = "0123456789abcdef"  # a computed result in the temp cache
UNKNOWN = "fedcba9876543210"
SECRET = b"outside the result tree"


def assert_error(r, status: int, code: str) -> None:
    assert r.status_code == status, r.text
    assert r.headers["content-type"].startswith("application/json")
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["error"] == code
    if status == 404:
        assert_valid(body, FILE_ROUTE, "404")
    else:  # 503 is not listed for this route; the body is still the shared Error schema
        assert_valid(body, "/jobs/{id}", "404")


def tracked_data_files() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z", "web/public/data"], cwd=REPO, check=True,
                         capture_output=True).stdout.decode().split("\0")
    return sorted(p.removeprefix("web/public/data/") for p in out
                  if p and not Path(p).name.startswith("."))


@pytest.fixture
def server_data(tmp_path, monkeypatch):
    """$HL_SERVER_DATA with one computed result tree, a symlink out of it and a file outside."""
    sd = tmp_path / "server"
    tree = sd / settings().cache.dir / OTHER
    (tree / "scenarios").mkdir(parents=True)
    (tree / "pad.json").write_bytes(b'{"computed": true}\n')
    (tree / "scenarios" / "index.json").write_bytes(b'{"scenarios": []}\n')
    record = json.loads((REPO / "contracts/backend/examples/run_record.live.json").read_text())
    (tree / "run_record.json").write_text(json.dumps({**record, "hash": OTHER}))
    (tree / ".partial.json").write_bytes(b"{}")
    (tmp_path / "secret.json").write_bytes(SECRET)
    (tree / "escape.json").symlink_to(tmp_path / "secret.json")
    (tree / "escape_dir").symlink_to(tmp_path)
    (tree / "inner.json").symlink_to(tree / "pad.json")  # a symlink inside the tree is fine
    monkeypatch.setenv("HL_SERVER_DATA", str(sd))
    return sd


@pytest.fixture
def client(server_data):
    app = create_app(warmup=lambda: None)
    app.dependency_overrides[identity_provider] = lambda: (lambda: IDENT)
    with TestClient(app) as c:
        yield c


def get(c, h: str, path: str, **kw):
    return c.get(f"{PREFIX}/results/{h}/{path}", **kw)


# ------------------------------------------------------------------- official = precomputed ----
def test_official_hash_serves_pad_json_byte_identical(client):
    r = get(client, OFFICIAL, "pad.json")
    assert r.status_code == 200
    assert r.content == (DATA / "pad.json").read_bytes()
    assert r.headers["content-type"].startswith("application/json")


def test_nested_paths(client):
    for path in ("scenarios/index.json", "scenarios/pads/index.json", "fields/index.json",
                 "tiles/basemap/tilejson.json"):
        r = get(client, OFFICIAL, path)
        assert r.status_code == 200, path
        assert r.content == (DATA / path).read_bytes(), path


def test_every_file_the_static_loader_can_fetch_is_served_under_the_base(client):
    """<base>/<path> works for the whole committed tree (S6 dataUrl with base). The large files
    are compared by size and content hash in the ETag, the rest byte for byte."""
    files = tracked_data_files()
    assert len(files) > 3000 and "pad.json" in files
    for path in files:
        r = get(client, OFFICIAL, path)
        assert r.status_code == 200, path
        f = DATA / path
        if f.stat().st_size < 1 << 20:
            assert r.content == f.read_bytes(), path
        else:
            assert len(r.content) == f.stat().st_size, path
            assert r.headers["etag"] == f'"{hashlib.sha256(r.content).hexdigest()[:32]}"', path


@pytest.mark.parametrize(("path", "media"), [
    ("pad.json", "application/json"),
    ("route_nom_104.geojson", "application/geo+json"),
    ("siting.png", "image/png"),
    ("validation/v1.svg", "image/svg+xml"),
    ("fp3d/far.f32.gz", "application/gzip"),
])
def test_content_types(client, path, media):
    r = get(client, OFFICIAL, path)
    assert r.status_code == 200
    assert r.headers["content-type"].split(";")[0] == media
    assert "content-encoding" not in r.headers  # .gz bytes as stored; fp3d gunzips itself
    assert r.headers["x-content-type-options"] == "nosniff"


def test_jpg_and_webp_content_types(client):
    files = tracked_data_files()
    for suffix, media in ((".jpg", "image/jpeg"), (".webp", "image/webp")):
        path = next(p for p in files if p.endswith(suffix))
        assert get(client, OFFICIAL, path).headers["content-type"] == media


def test_caching_headers_and_etag(client):
    r = get(client, OFFICIAL, "pad.json")
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    tag = r.headers["etag"]
    assert tag == f'"{hashlib.sha256((DATA / "pad.json").read_bytes()).hexdigest()[:32]}"'
    again = get(client, OFFICIAL, "pad.json", headers={"If-None-Match": tag})
    assert again.status_code == 304 and again.content == b""
    assert again.headers["etag"] == tag
    assert again.headers["cache-control"] == "public, max-age=31536000, immutable"
    other = get(client, OFFICIAL, "pad.json", headers={"If-None-Match": '"nope"'})
    assert other.status_code == 200


def test_web_public_data_is_never_written(client):
    before = sorted(p for p in DATA.rglob("*"))
    assert get(client, OFFICIAL, "run_record.json").status_code == 200
    assert get(client, OFFICIAL, "provenance").status_code == 200
    assert not (DATA / "run_record.json").exists()
    assert sorted(p for p in DATA.rglob("*")) == before


# --------------------------------------------------------------- precomputed run record ----
def test_official_run_record_is_synthesised_and_valid(client):
    r = get(client, OFFICIAL, "run_record.json")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    rec = r.json()
    assert_valid(rec, PROV_ROUTE)  # openapi RunRecord = run_record.schema.json
    assert rec["hash"] == OFFICIAL and rec["origin"] == "precomputed" and rec["status"] == "done"
    assert rec["engine"]["tree"] == IDENT.engine_tree
    assert rec["engine"]["config_hash"] == IDENT.config_hash
    assert rec["terrain_hash"] == IDENT.terrain_hash
    assert rec["contract_version"] == settings().contract_version
    assert rec["dummy"] is False and rec["infeasible"] is None
    assert rec["label"] == settings().labels.precomputed == "Precomputed · official plan"
    assert "title" not in rec["inputs"] and "id" not in rec["inputs"]["pad"]  # what was hashed
    manifest = json.loads((DATA / "manifest.json").read_text())
    times = sorted(v["utc"] for v in manifest.values() if isinstance(v, dict) and "utc" in v)
    assert (rec["started_utc"], rec["finished_utc"]) == (times[0], times[-1])
    files = {f["path"]: f for f in rec["files"]}
    assert sorted(files) == tracked_data_files()  # every file, no run_record.json, no .gitkeep
    pad = (DATA / "pad.json").read_bytes()
    assert files["pad.json"] == {"path": "pad.json", "sha256": hashlib.sha256(pad).hexdigest(),
                                 "bytes": len(pad), "contract": "pad.schema.json"}
    assert files["siting.png"]["contract"] is None
    for f in rec["files"]:
        if f["path"].endswith((".json", ".geojson")):
            assert f["contract"] == match_schema(f["path"]), f["path"]


def test_provenance_equals_run_record_json(client):
    a = get(client, OFFICIAL, "run_record.json")
    b = client.get(f"{PREFIX}/results/{OFFICIAL}/provenance")
    assert b.status_code == 200 and b.content == a.content
    assert b.headers["etag"] == a.headers["etag"]
    assert get(client, OFFICIAL, "run_record.json",
               headers={"If-None-Match": a.headers["etag"]}).status_code == 304


def test_run_record_validator_rejects_a_bad_record():
    tree = results.ResultTree(OFFICIAL, DATA, True, IDENT)
    good = json.loads(results.precomputed_run_record(tree))
    with pytest.raises(ValueError, match="run_record"):
        results.validate_run_record({**good, "origin": "made_up"})
    errs = list(Draft202012Validator({"$ref": f"{API_ID}#/components/schemas/RunRecord"},
                                     registry=REGISTRY).iter_errors({**good, "hash": "XYZ"}))
    assert errs  # the openapi schema the tests validate against is not vacuous
    assert OPENAPI["paths"][PROV_ROUTE]["get"]["operationId"] == "getProvenance"


# ---------------------------------------------------------------------- computed trees ----
def test_computed_tree_is_served_from_the_cache(client, server_data):
    tree = server_data / "results" / OTHER
    for path in ("pad.json", "scenarios/index.json", "run_record.json", "inner.json"):
        r = get(client, OTHER, path)
        assert r.status_code == 200, path
        assert r.content == (tree / path).read_bytes()
        assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    prov = client.get(f"{PREFIX}/results/{OTHER}/provenance")
    assert prov.status_code == 200
    assert prov.content == (tree / "run_record.json").read_bytes()
    assert_valid(prov.json(), PROV_ROUTE)


def test_computed_tree_without_run_record_is_404(client, server_data):
    (server_data / "results" / OTHER / "run_record.json").unlink()
    assert_error(client.get(f"{PREFIX}/results/{OTHER}/provenance"), 404, "file_not_found")


def test_official_hash_wins_over_a_cache_folder_of_the_same_name(client, server_data):
    d = server_data / "results" / OFFICIAL
    d.mkdir()
    (d / "pad.json").write_bytes(b"{}")
    assert get(client, OFFICIAL, "pad.json").content == (DATA / "pad.json").read_bytes()


# --------------------------------------------------------------------------- not found ----
@pytest.mark.parametrize("h", [UNKNOWN, "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0",
                               "zzzzzzzzzzzzzzzz", "%2e%2e"])
def test_unknown_or_malformed_hash_is_404(client, h):
    assert_error(get(client, h, "pad.json"), 404, "unknown_result")


def test_unknown_hash_provenance_is_404(client):
    r = client.get(f"{PREFIX}/results/{UNKNOWN}/provenance")
    assert_error(r, 404, "unknown_result")
    assert_valid(r.json(), PROV_ROUTE, "404")


@pytest.mark.parametrize("h", [OFFICIAL, OTHER])
@pytest.mark.parametrize("path", ["nope.json", "scenarios/nope.json", "cards/S1/nope.png"])
def test_missing_file_in_a_known_tree_is_404(client, h, path):
    assert_error(get(client, h, path), 404, "file_not_found")


@pytest.mark.parametrize("path", ["scenarios", "scenarios/", "fields"])
def test_a_directory_is_not_a_file(client, path):
    r = get(client, OFFICIAL, path)
    assert r.status_code == 404 and r.json()["error"] in ("file_not_found", "invalid_path")


TRAVERSALS = [
    "%2e%2e/%2e%2e/%2e%2e/pyproject.toml",
    "..%2f..%2f..%2fpyproject.toml",
    "%2e%2e%2f%2e%2e%2f%2e%2e%2fpyproject.toml",
    "scenarios/%2e%2e/%2e%2e/%2e%2e/%2e%2e/pyproject.toml",
    "scenarios/%2e%2e/pad.json",  # stays inside, but ".." is refused outright
    "%2fetc%2fpasswd",
    "%2F%2Fetc/passwd",
    "..%5c..%5c..%5cpyproject.toml",
    "pad.json%00.png",
    "%252e%252e/%252e%252e/pyproject.toml",  # double-encoded: a literal "%2e%2e" name
    "%2e/pad.json",  # "./" itself is normalised away by the client
    "scenarios//index.json",
    ".gitkeep",
    "%2egitkeep",
]


@pytest.mark.parametrize("h", [OFFICIAL, OTHER])
@pytest.mark.parametrize("path", TRAVERSALS)
def test_traversal_is_refused(client, h, path):
    r = get(client, h, path)
    assert r.status_code in (400, 404), r.status_code
    assert b"[project]" not in r.content and b"root:" not in r.content
    if r.status_code == 404:
        assert r.json()["error"] in ("invalid_path", "file_not_found")


@pytest.mark.parametrize("path", ["escape.json", "escape_dir/secret.json", ".partial.json"])
def test_symlinks_out_of_the_tree_and_hidden_files_are_404(client, path):
    r = get(client, OTHER, path)
    assert r.status_code == 404
    assert SECRET not in r.content


def test_safe_parts_unit():
    assert results.safe_parts("scenarios/index.json") == ["scenarios", "index.json"]
    for bad in ("", "/pad.json", "a/../b", "a/./b", "a//b", "a\\b", "a\0b", ".x", "a/.x/b",
                "a/", "x" * (results.MAX_PATH_CHARS + 1)):
        with pytest.raises(results.ResultNotFound):
            results.safe_parts(bad)


# ------------------------------------------------------------------------ live identity ----
@pytest.fixture
def live_client(server_data):
    """No injected identity: the live one (git + $HL_SERVER_DATA/manifest.json)."""
    with TestClient(create_app(warmup=lambda: None)) as c:
        yield c


def test_live_identity_with_a_manifest_resolves_the_official_hash(live_client, server_data):
    (server_data / "manifest.json").write_bytes(b'{"fake": "server data manifest"}\n')
    h = official_hash()  # live identity
    r = get(live_client, h, "pad.json")
    assert r.status_code == 200 and r.content == (DATA / "pad.json").read_bytes()
    rec = live_client.get(f"{PREFIX}/results/{h}/provenance").json()
    assert_valid(rec, PROV_ROUTE)
    assert rec["terrain_hash"] == "sha256:" + hashlib.sha256(
        (server_data / "manifest.json").read_bytes()).hexdigest()
    assert_error(get(live_client, UNKNOWN, "pad.json"), 404, "unknown_result")


def test_without_the_manifest_an_uncached_hash_is_503_not_a_guess(live_client, server_data):
    assert not (server_data / "manifest.json").exists()
    for h in (OFFICIAL, UNKNOWN):
        assert_error(get(live_client, h, "pad.json"), 503, "server_data_missing")
        assert_error(live_client.get(f"{PREFIX}/results/{h}/provenance"), 503,
                     "server_data_missing")
    # a computed tree is self-contained: it is still served
    r = get(live_client, OTHER, "pad.json")
    assert r.status_code == 200 and r.content == b'{"computed": true}\n'
    # a malformed hash is never a result, identity or not
    assert_error(get(live_client, "nothex", "pad.json"), 404, "unknown_result")


def test_without_git_the_official_hash_is_503(server_data):
    def no_git():
        raise results.version.Unavailable("git rev-parse HEAD:pipeline failed")

    app = create_app(warmup=lambda: None)
    app.dependency_overrides[identity_provider] = lambda: no_git
    with TestClient(app) as c:
        assert_error(get(c, OFFICIAL, "pad.json"), 503, "engine_identity_unavailable")
