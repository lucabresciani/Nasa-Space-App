"""Code identity from the environment (WS11 E1b; D57, D69/WS12 Docker image without .git).

Known answers: with HL_COMMIT and HL_ENGINE_TREE both set to 40 lower-case hex characters,
code_identity() reports exactly those values and never runs git; with both unset it reports
``git rev-parse HEAD`` / ``git rev-parse HEAD:pipeline`` of this repository; a malformed value or
only one of the two set is an error (version.Unavailable), never a silent fall-back to git, and
/engine/version answers 503 engine_identity_unavailable with the openapi Error shape.
"""

import hashlib
import subprocess

import pytest

pytest.importorskip("fastapi")  # server dependency group (uv sync --group server)
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from server.app import create_app  # noqa: E402
from server.engine import version  # noqa: E402
from server.tests.test_app import PREFIX, assert_valid  # noqa: E402

COMMIT = "0123456789abcdef0123456789abcdef01234567"
TREE = "fedcba9876543210fedcba9876543210fedcba98"
MANIFEST = b'{"files": []}\n'


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=version.REPO, check=True, capture_output=True,
                          text=True).stdout.strip()


@pytest.fixture(autouse=True)
def fresh_identity(monkeypatch):
    """code_identity() is cached for the life of the process: clear it around every test, and
    start each test with both variables unset."""
    monkeypatch.delenv(version.COMMIT_ENV, raising=False)
    monkeypatch.delenv(version.ENGINE_TREE_ENV, raising=False)
    version.code_identity.cache_clear()
    yield
    version.code_identity.cache_clear()


@pytest.fixture
def no_git(monkeypatch):
    """Any subprocess call fails the test (the environment path must not run git)."""
    def boom(*a, **k):
        raise AssertionError(f"subprocess called: {a!r}")
    monkeypatch.setattr(version.subprocess, "run", boom)
    monkeypatch.setattr(version.subprocess, "check_output", boom)
    monkeypatch.setattr(version.subprocess, "Popen", boom)


def set_env(monkeypatch, commit=None, tree=None):
    if commit is not None:
        monkeypatch.setenv(version.COMMIT_ENV, commit)
    if tree is not None:
        monkeypatch.setenv(version.ENGINE_TREE_ENV, tree)


def test_env_names_are_the_image_build_args():
    # server/ops/Dockerfile ARG/ENV and server/ops/up.sh use these names
    assert version.COMMIT_ENV == "HL_COMMIT"
    assert version.ENGINE_TREE_ENV == "HL_ENGINE_TREE"


# ------------------------------------------------------------------ env set and valid ----
def test_env_identity_is_used_without_git(monkeypatch, no_git):
    set_env(monkeypatch, COMMIT, TREE)
    code = version.code_identity()
    assert code["commit"] == COMMIT
    assert code["engine_tree"] == TREE
    assert version.git_identity() == (COMMIT, TREE)


def test_env_identity_leaves_the_rest_unchanged(monkeypatch):
    from tools.make_bundle import CONTRACT_VERSION, config_hash

    set_env(monkeypatch, COMMIT, TREE)
    code = version.code_identity()
    assert set(code) == {"engine_tree", "commit", "config_hash", "web_contract_version",
                         "backend_contract_version", "bundle_contract_version"}
    assert code["config_hash"] == config_hash()
    assert code["bundle_contract_version"] == CONTRACT_VERSION
    assert code["backend_contract_version"] == version.backend_contract_version()
    assert code["web_contract_version"] == version.web_contract_version()


def test_env_identity_equal_to_git_gives_the_same_result_hash(tmp_path, monkeypatch):
    """E2's engine_identity() (D57) is built on code_identity(): the image (env) and a checkout
    (git) of the same commit give the same result hash."""
    from server.engine import hashing

    (tmp_path / version.SERVER_DATA_MANIFEST).write_bytes(MANIFEST)
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(tmp_path))
    from_git = hashing.official_hash()
    version.code_identity.cache_clear()
    set_env(monkeypatch, git("rev-parse", "HEAD"), git("rev-parse", "HEAD:pipeline"))
    assert hashing.official_hash() == from_git
    # and the env value is what goes into it: another tree, another hash
    version.code_identity.cache_clear()
    set_env(monkeypatch, COMMIT, TREE)
    assert hashing.official_hash() != from_git


# ----------------------------------------------------------------------- env unset ----
def test_env_unset_uses_git():
    code = version.code_identity()
    assert code["commit"] == git("rev-parse", "HEAD")
    assert code["engine_tree"] == git("rev-parse", "HEAD:pipeline")


def test_env_unset_without_git_is_unavailable(no_git, monkeypatch):
    def no_binary(*a, **k):
        raise FileNotFoundError("git")
    monkeypatch.setattr(version.subprocess, "run", no_binary)
    with pytest.raises(version.Unavailable, match="git"):
        version.code_identity()


# --------------------------------------------------------------------- env invalid ----
BAD = [
    ("upper case", COMMIT.upper(), TREE),
    ("short", COMMIT[:39], TREE),
    ("long", COMMIT + "0", TREE),
    ("abbreviated", COMMIT[:12], TREE),
    ("not hex", "g" * 40, TREE),
    ("trailing newline", COMMIT + "\n", TREE),
    ("surrounding space", f" {COMMIT}", TREE),
    ("sha256 object id", "0" * 64, TREE),
    ("empty (up.sh HL_ALLOW_DIRTY=1)", "", ""),
    ("bad tree", COMMIT, TREE[:-1] + "Z"),
    ("dirty suffix", COMMIT + "-dirty", TREE),
]


@pytest.mark.parametrize("commit,tree", [b[1:] for b in BAD], ids=[b[0] for b in BAD])
def test_invalid_env_is_an_error_not_a_git_fallback(monkeypatch, no_git, commit, tree):
    set_env(monkeypatch, commit, tree)
    with pytest.raises(version.Unavailable, match="HL_"):
        version.code_identity()


@pytest.mark.parametrize("which", ["commit only", "tree only"])
def test_only_one_var_set_is_an_error(monkeypatch, no_git, which):
    if which == "commit only":
        set_env(monkeypatch, commit=COMMIT)
    else:
        set_env(monkeypatch, tree=TREE)
    with pytest.raises(version.Unavailable, match="HL_COMMIT and HL_ENGINE_TREE"):
        version.code_identity()


def test_error_text_does_not_name_the_manifest(monkeypatch, no_git):
    """server/app.py and server/api/compute/results.py pick server_data_missing when the message
    mentions the manifest; an identity error must stay engine_identity_unavailable."""
    for commit, tree in [("x", TREE), (COMMIT, None)]:
        monkeypatch.delenv(version.ENGINE_TREE_ENV, raising=False)
        set_env(monkeypatch, commit, tree)
        version.code_identity.cache_clear()
        with pytest.raises(version.Unavailable) as e:
            version.code_identity()
        assert "manifest" not in str(e.value)


# ------------------------------------------------------------------- /engine/version ----
@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / version.SERVER_DATA_MANIFEST).write_bytes(MANIFEST)
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(tmp_path))

    def make():
        version.code_identity.cache_clear()
        return TestClient(create_app(warmup=lambda: None))
    return make


def test_engine_version_from_env_validates(client, monkeypatch, no_git):
    set_env(monkeypatch, COMMIT, TREE)
    with client() as c:
        r = c.get(f"{PREFIX}/engine/version")
    assert r.status_code == 200, r.text
    v = r.json()
    assert_valid(v, "/engine/version")
    assert v["commit"] == COMMIT
    assert v["engine_tree"] == TREE
    assert v["terrain_hash"] == "sha256:" + hashlib.sha256(MANIFEST).hexdigest()


def test_engine_version_from_git_validates(client):
    with client() as c:
        r = c.get(f"{PREFIX}/engine/version")
    assert r.status_code == 200, r.text
    assert_valid(r.json(), "/engine/version")
    assert r.json()["commit"] == git("rev-parse", "HEAD")
    assert r.json()["engine_tree"] == git("rev-parse", "HEAD:pipeline")


@pytest.mark.parametrize("commit,tree", [
    (COMMIT[:39], TREE),            # wrong length
    (COMMIT, "z" * 40),             # not hex
    (COMMIT.upper(), TREE),         # upper case
    ("", ""),                       # up.sh HL_ALLOW_DIRTY=1
    (COMMIT, None),                 # only HL_COMMIT
    (None, TREE),                   # only HL_ENGINE_TREE
], ids=["length", "hex", "upper", "empty", "commit-only", "tree-only"])
def test_engine_version_bad_env_is_503(client, monkeypatch, no_git, commit, tree):
    set_env(monkeypatch, commit, tree)
    with client() as c:  # the start-up identity attempt must not crash the app either
        r = c.get(f"{PREFIX}/engine/version")
    assert r.status_code == 503, r.text
    body = r.json()
    assert body["error"] == "engine_identity_unavailable"
    assert_valid(body, "/jobs/{id}", "404")  # the shared Error schema
