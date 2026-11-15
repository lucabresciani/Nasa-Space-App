"""config/backend.yaml loads, references resolve to the one source, unknown keys are refused."""

import json
import shutil

import pytest
import yaml

pytest.importorskip("pydantic")  # server dependency group (uv sync --group server)
from pydantic import ValidationError  # noqa: E402

from server import settings as st  # noqa: E402


@pytest.fixture
def cfg_copy(tmp_path):
    for p in st.CONFIG_DIR.glob("*.yaml"):
        shutil.copy(p, tmp_path / p.name)
    return tmp_path


def edit_backend(cfg_dir, fn):
    p = cfg_dir / "backend.yaml"
    doc = yaml.safe_load(p.read_text())
    fn(doc)
    p.write_text(yaml.safe_dump(doc))


# ------------------------------------------------------------------------- known answers ----
def test_repo_config_loads():
    c = st.load()
    assert c.api.prefix == "/api/v1" and c.api.health_timeout_s == 2
    assert c.compute.workers == 2 and c.compute.queue_max_waiting == 20
    assert c.compute.job_timeout_s == 600 and c.cache.max_gb == 20
    assert c.compute.hash.algo == "sha256" and c.compute.hash.hex_chars == 16
    assert c.limits.guest_heavy_jobs.count == 6 and c.limits.guest_heavy_jobs.window_min == 10
    assert c.limits.user_heavy_jobs.count == 30 and c.limits.telemetry_posts_per_s == 2
    assert c.limits.upload_max_bytes == 1024 * 1024 and c.limits.ip_hash_retention_days == 7
    assert c.ranges.user_points_max == 3 and c.plans.versions_kept == 20
    sc = c.plans.share_code
    assert sc.prefix == "HL-" and sc.chars == 6
    assert sc.alphabet == "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32 (no I, L, O, U)
    assert "backend.yaml" in c.compute.hash.exclude_config
    assert st.settings() is st.settings()


def test_ranges_known_answers():
    r = st.load().ranges
    assert (r["body_mass_kg"].min, r["body_mass_kg"].max) == (50, 100)
    assert (r["suit_kg"].min, r["suit_kg"].max) == (60, 180)
    assert r["suit_kg"].precomputed == [80, 104, 120]
    assert (r["effort_cap_frac"].min, r["effort_cap_frac"].max) == (0.40, 0.70)
    assert r["walkback_budget_min"].default == [30, 60]
    assert r["d_allow_mgy"].default == 0.5
    assert {k for k, _ in r.items()} == {
        "body_mass_kg", "suit_kg", "tools_kg", "vo2max_ml_kg_min", "effort_cap_frac",
        "walkback_budget_min", "d_allow_mgy", "dwell_min", "eva_duration_h", "start_lmst_h",
        "reserve_min"}
    with pytest.raises(KeyError):
        r["user_points_max"]  # not a range


def test_cors_origins_known_answer():
    """Decision 6 + hosting (2026-11-14): exactly these origins, in backend.yaml only."""
    c = st.load()
    assert c.api.cors_origins == ["https://luxkaiwalker.github.io", "https://homeline.vxliu.com",
                                  "http://localhost:5173"]
    assert "api.cors_origins" not in c.assumed  # confirmed, no longer assumed


def test_reserve_min_range_known_answer():
    """Decision 10: eva.reserve_min gets an assumed range around the D24 default (decision 12)."""
    c = st.load()
    crew = yaml.safe_load((st.CONFIG_DIR / "crew.yaml").read_text())
    r = c.ranges["reserve_min"]
    assert (r.min, r.max, r.assumed) == (15, 60, True)
    assert r.default == crew["o2_margin"]["reserve_min_at_effort_cap"] == 30
    assert r.contains(r.default)
    assert "ranges.reserve_min" in c.assumed
    # the range key is the plan_inputs eva field name (contracts/backend/plan_inputs.schema.json)
    schema = json.loads((st.REPO / "contracts" / "backend" / "plan_inputs.schema.json").read_text())
    assert "reserve_min" in schema["properties"]["eva"]["properties"]


def test_assumed_list_known_answer():
    """Decision 10: assumed values stay marked; every entry resolves to a key of the config."""
    c = st.load()
    assert c.assumed == ["limits.title_max_chars", "limits.notes_max_chars",
                         "ranges.start_lmst_h", "ranges.reserve_min", "sessions.message_max_chars",
                         "limits.proxy_max_body_bytes", "compute.job_timeout_s",
                         "route.max_stops", "route.max_free_points", "route.min_stop_spacing_m"]
    for path in c.assumed:
        node = c
        for part in path.split("."):
            node = getattr(node, part)  # raises if the entry no longer resolves
        if isinstance(node, st.Range):
            assert node.assumed is True, path


def test_route_limits_known_answer():
    """D97: route limits 8 stops, 4 free points, 50 m spacing (= the D27 access radius), assumed."""
    c = st.load()
    assert (c.route.max_stops, c.route.max_free_points, c.route.min_stop_spacing_m) == (8, 4, 50)
    variants = yaml.safe_load((st.CONFIG_DIR / "variants.yaml").read_text())
    # = the D27 access radius
    assert c.route.min_stop_spacing_m == variants["route"]["access_radius_m"]
    route_keys = {"route.max_stops", "route.max_free_points", "route.min_stop_spacing_m"}
    assert route_keys <= set(c.assumed)


def test_route_free_points_above_stops_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["route"].update(max_free_points=9))
    with pytest.raises(ValueError):
        st.load(cfg_copy)


def test_refs_resolve_to_other_config_files():
    c = st.load()
    crew = yaml.safe_load((st.CONFIG_DIR / "crew.yaml").read_text())
    event = yaml.safe_load((st.CONFIG_DIR / "event.yaml").read_text())
    site = yaml.safe_load((st.CONFIG_DIR / "site.yaml").read_text())
    assert c.ranges["body_mass_kg"].default == crew["body_mass_kg"]
    assert c.ranges["suit_kg"].default == crew["default_suit_kg"]
    assert c.ranges["tools_kg"].default == crew["tools_kg"]
    assert c.ranges["vo2max_ml_kg_min"].default == crew["vo2max_ml_kg_min"]
    assert c.ranges["effort_cap_frac"].default == crew["effort_cap_frac"]
    assert c.deploy.no_deploy_after == event["deadline_local"]
    assert c.gates_local.freeze == event["gates_local"]["freeze"]
    assert c.pads.rule == site["siting"] and c.pads.rule["max_slope_deg"] == 5


def test_no_default_copied_into_backend_yaml():
    """Defaults that live in crew.yaml are referenced, never copied (kit rule 8)."""
    raw = yaml.safe_load((st.CONFIG_DIR / "backend.yaml").read_text())
    for key in ("body_mass_kg", "suit_kg", "tools_kg", "vo2max_ml_kg_min", "effort_cap_frac"):
        assert "default" not in raw["ranges"][key] and "default_ref" in raw["ranges"][key], key


def test_defaults_inside_their_ranges():
    for key, r in st.load().ranges.items():
        vals = r.default if isinstance(r.default, list) else [r.default]
        for v in [*vals, *(r.precomputed or [])]:
            if v is not None:
                assert r.contains(float(v)), key


def test_share_code_pattern_known_answer():
    sc = st.load().plans.share_code
    assert sc.pattern() == "^HL-[0-9A-HJKMNP-TV-Z]{6}$"
    assert sc.matches("HL-7K3QZ9") and len("HL-7K3QZ9") == 9
    assert sc.matches("HL-000000") and sc.matches("HL-ZZZZZZ")
    for bad in ("HL-7K3QZ", "HL-7K3QZ9X", "HL-7K3QZI", "HL-7K3QZL", "HL-7K3QZO", "HL-7K3QZU",
                "hl-7K3QZ9", "XX-7K3QZ9", "HL-7k3qz9", "HL7K3QZ9", " HL-7K3QZ9", "HL-7K3QZ9\n"):
        assert not sc.matches(bad), bad


def test_char_class_known_answer():
    assert st._char_class(st.CROCKFORD32) == "0-9A-HJKMNP-TV-Z"
    assert st._char_class("ABDE") == "ABDE" and st._char_class("CBA") == "A-C"


# ---------------------------------------------------------------------------- refusals ----
def test_unknown_key_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["compute"].update(wrokers=3))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_unknown_top_level_key_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d.update(extra_section={"a": 1}))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_unknown_range_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["ranges"].update(tool_kg={"min": 0, "max": 30}))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_missing_key_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["limits"].pop("upload_max_bytes"))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_broken_reference_refused(cfg_copy):
    edit_backend(cfg_copy,
                 lambda d: d["ranges"]["tools_kg"].update(default_ref="crew.no_such_key"))
    with pytest.raises(KeyError):
        st.load(cfg_copy)


def test_reference_to_missing_file_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["pads"].update(rule_ref="nosuchfile.siting"))
    with pytest.raises(FileNotFoundError):
        st.load(cfg_copy)


@pytest.mark.parametrize("ref", ["crew", "../crew.body_mass_kg", "crew..x", "backend.limits", 5])
def test_malformed_or_self_reference_refused(cfg_copy, ref):
    edit_backend(cfg_copy, lambda d: d["ranges"]["tools_kg"].update(default_ref=ref))
    with pytest.raises(ValueError):
        st.load(cfg_copy)


def test_value_and_reference_together_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["ranges"]["tools_kg"].update(default=10))
    with pytest.raises(ValueError, match="one place"):
        st.load(cfg_copy)


def test_unknown_alphabet_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["plans"]["share_code"].update(alphabet="base64"))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_default_outside_range_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["ranges"]["d_allow_mgy"].update(default=2.0))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_inverted_range_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["ranges"]["dwell_min"].update(min=200))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_assumed_entry_must_name_a_key(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["assumed"].append("limits.no_such_limit"))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_gates_out_of_order_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["gates_local"].update(B3="2026-11-15T13:00:00+01:00"))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_bad_cors_origin_refused(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["api"]["cors_origins"].append("https://example.org/"))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


def test_hash_must_exclude_backend_yaml(cfg_copy):
    edit_backend(cfg_copy, lambda d: d["compute"]["hash"].update(exclude_config=[]))
    with pytest.raises(ValidationError):
        st.load(cfg_copy)


# ------------------------------------------------------------------ D57 config-hash rule ----
def test_backend_yaml_not_in_engine_config_hash(cfg_copy):
    """D57: a server-only setting (rate limit, CORS) must not change the engine config hash."""
    from tools import make_bundle as mb

    before = mb.config_hash(cfg_copy)
    edit_backend(cfg_copy, lambda d: d["limits"]["guest_heavy_jobs"].update(count=7))
    assert mb.config_hash(cfg_copy) == before
    assert "backend.yaml" not in [f.name for f in mb.config_files(cfg_copy)]
    assert "backend.yaml" not in mb.config_snapshot(cfg_copy)[0]["files"]


def test_adding_backend_yaml_keeps_the_engine_config_hash(cfg_copy):
    """The repo's engine config hash with backend.yaml equals the hash without it."""
    from tools import make_bundle as mb

    with_backend = mb.config_hash(cfg_copy)
    (cfg_copy / "backend.yaml").unlink()
    assert mb.config_hash(cfg_copy) == with_backend == mb.config_hash()


def test_exclusion_lists_agree():
    from tools import make_bundle as mb

    assert set(st.load().compute.hash.exclude_config) == set(mb.NON_ENGINE_CONFIG)


def test_precomputed_label_known_answer():
    """Team lead, Sat 22:40: the label of the official precomputed tree."""
    labels = st.load().labels
    assert labels.precomputed == "Precomputed · official plan"
    assert "scorecard" not in labels.precomputed


def test_design_yaml_not_in_engine_config_hash(cfg_copy):
    """A UI-only config/design.yaml (design block) must not change the engine config hash (D57)."""
    from tools import make_bundle as mb
    before = mb.config_hash(cfg_copy)
    (cfg_copy / "design.yaml").write_text("tokens: {accent: '#ff6a00'}\n")
    assert mb.config_hash(cfg_copy) == before
    assert "design.yaml" not in [f.name for f in mb.config_files(cfg_copy)]
