"""Canonical plan inputs and the result hash (plan row 1.2, WS11 task 2; D57).

Rule: contracts/backend/README.md "Result hash":
    hash = sha256(canonical_inputs + "\\0" + engine_tree + "\\0" + engine_config_hash + "\\0"
                  + terrain_hash)[:16]
canonical_inputs = plan_inputs with every default filled in, `title` and `pad.id` removed
(team-lead decision 11: the pad is identified by its lon/lat, which stay in the hash), every number
as a float rounded to 6 decimals (-0.0 -> 0.0), JSON with sorted keys, no spaces, UTF-8.
`contract_version` stays in the hash (the rule removes only the title; changing that is C's call).

Known answers (derived by hand, independently of server/engine/hashing.py):
- OFFICIAL_CANONICAL_TMPL is the official default inputs written out from config:
  crew.yaml (body 75 kg, suit 104 kg, tools 10 kg, VO2max 36, effort cap 0.5, eva_h 6.5,
  o2_margin.reserve_min_at_effort_cap 30), conditions.yaml (clock.eva_start_lmst_h 9,
  storm_replay.tripwire_at route_max_t_home), backend.yaml (walkback [30, 60], d_allow 0.5), the
  official pad rank1 of web/public/data/scenarios/pads/index.json (137.401783, -4.77748; its id is
  not hashed), station mode best, storm 2024-05-20, no user points, and every station of
  stations.json at its dwell (stations.yaml dwell_min 30). Its contract_version is the
  placeholder @CV@: the official inputs carry config/backend.yaml contract_version (read from
  config here, so a contract version bump does not break these tests).
- OFFICIAL_HASH_PINNED is the template with contract_version PINNED_CV ("1.0.1"), hashed with the
  fixed identity FIXED_IDENTITY, derived with coreutils, not Python:
      C=<OFFICIAL_CANONICAL_TMPL with @CV@ replaced by 1.0.1>
      printf '%s\\0%s\\0%s\\0%s' "$C" 0123456789abcdef0123456789abcdef01234567 \\
        sha256:1fef9c5747acbd487e0a3090f6e9617eba1c8627e25095db683e18ab7589099d \\
        sha256:0000000000000000000000000000000000000000000000000000000000000000 \\
        | sha256sum | cut -c1-16
  (the config hash is the repo/fixture value of tools.make_bundle.config_hash, S2 note).
  The pinned test passes contract_version PINNED_CV explicitly, so it holds across version bumps;
  OFFICIAL_HASH (at the config's contract_version) is the same formula over the template, via
  hashlib. A change to any other config value above or to the official pad changes the pins on
  purpose: re-derive them with the command above.
"""

import copy
import hashlib
import json
import math
import re

import pytest

pytest.importorskip("pydantic")  # server.settings (server dependency group)

from server.engine import hashing  # noqa: E402
from server.engine.defaults import default_inputs  # noqa: E402
from server.engine.hashing import (  # noqa: E402
    EngineIdentity,
    InvalidPlanInputs,
    canonical_inputs,
    canonical_json,
    official_hash,
    result_hash,
)
from server.engine.version import Unavailable  # noqa: E402
from server.settings import settings  # noqa: E402

OFFICIAL_CANONICAL_TMPL = (
    '{"conditions":{"d_allow_mgy":0.5,"storm":"2024-05-20","tripwire_at":"route_max_t_home"},'
    '"contract_version":"@CV@",'
    '"crew":{"body_mass_kg":75.0,"effort_cap_frac":0.5,"suit_kg":104.0,"tools_kg":10.0,'
    '"vo2max_ml_kg_min":36.0},'
    '"eva":{"duration_h":6.5,"reserve_min":30.0,"start_lmst_h":9.0,'
    '"walkback_budgets_min":[30.0,60.0]},'
    '"pad":{"lat":-4.77748,"lon":137.401783},'
    '"stations":{"custom":[],"dwell_min":{"S1":30.0,"S2":30.0,"S4":30.0,"S6":30.0,"S7":30.0,'
    '"S8":30.0},"mode":"best"}}'
)
FIXED_IDENTITY = EngineIdentity(
    engine_tree="0123456789abcdef0123456789abcdef01234567",
    config_hash="sha256:1fef9c5747acbd487e0a3090f6e9617eba1c8627e25095db683e18ab7589099d",
    terrain_hash="sha256:" + "0" * 64,
)
PINNED_CV = "1.0.1"
OFFICIAL_HASH_PINNED = "c81aafcf1a1ef64f"  # coreutils, see the module docstring
HASH_RE = re.compile(r"^[0-9a-f]{16}$")  # openapi.yaml result hash pattern


def d57(canonical: str, ident: EngineIdentity = FIXED_IDENTITY) -> str:
    """The README formula written out with hashlib (independent of hashing.py)."""
    return hashlib.sha256("\0".join([canonical, *ident]).encode("utf-8")).hexdigest()[:16]


CV = settings().contract_version  # config/backend.yaml contract_version
OFFICIAL_CANONICAL = OFFICIAL_CANONICAL_TMPL.replace("@CV@", CV)
OFFICIAL_HASH = d57(OFFICIAL_CANONICAL)  # official hash under FIXED_IDENTITY at the config version

MINIMAL = {"contract_version": CV, "pad": {"lon": 137.401783, "lat": -4.77748}}


def h(inputs, ident=FIXED_IDENTITY):
    return result_hash(inputs, ident)


# ------------------------------------------------------------------ known answers ----
def test_official_canonical_inputs_known_answer():
    assert default_inputs()["contract_version"] == CV
    assert canonical_json(default_inputs()) == OFFICIAL_CANONICAL


def test_official_hash_known_answer_pinned():
    """Literal pin, independent of the config's contract version (passed explicitly)."""
    assert h({**default_inputs(), "contract_version": PINNED_CV}) == OFFICIAL_HASH_PINNED
    assert h({**MINIMAL, "contract_version": PINNED_CV}) == OFFICIAL_HASH_PINNED
    assert d57(OFFICIAL_CANONICAL_TMPL.replace("@CV@", PINNED_CV)) == OFFICIAL_HASH_PINNED


def test_official_hash_known_answer():
    assert official_hash(FIXED_IDENTITY) == OFFICIAL_HASH
    assert h(default_inputs()) == OFFICIAL_HASH
    assert h(MINIMAL) == OFFICIAL_HASH


def test_contract_version_is_hashed():
    """contracts/backend/README.md removes only the title (plus pad.id, decision 11)."""
    assert h({**MINIMAL, "contract_version": "1.99.0"}) != OFFICIAL_HASH


def test_hash_format_from_config():
    cfg = settings().compute.hash
    assert (cfg.algo, cfg.hex_chars) == ("sha256", 16)
    assert HASH_RE.match(h(MINIMAL))


def test_canonical_json_is_compact_sorted_utf8():
    doc = {**MINIMAL, "stations": {"mode": "best", "custom": [
        {"id": "U1", "name": "Krater Süd", "lon": 137.4, "lat": -4.78}]}}
    s = canonical_json(doc)
    assert "Krater Süd" in s  # UTF-8, not \\u escapes
    assert " " not in s.replace("Krater Süd", "")
    assert s == json.dumps(json.loads(s), sort_keys=True, separators=(",", ":"),
                           ensure_ascii=False)


# ---------------------------------------------------------------- invariances ----
def test_key_order_and_whitespace_do_not_matter():
    full = default_inputs()
    text_a = json.dumps(full, indent=4)
    rev = {k: (dict(reversed(list(v.items()))) if isinstance(v, dict) else v)
           for k, v in reversed(list(full.items()))}
    text_b = json.dumps(rev, separators=(" , ", " :   "))
    assert h(json.loads(text_a)) == h(json.loads(text_b)) == OFFICIAL_HASH


@pytest.mark.parametrize("block, field", [
    ("crew", "body_mass_kg"), ("crew", "suit_kg"), ("crew", "tools_kg"),
    ("crew", "vo2max_ml_kg_min"), ("crew", "effort_cap_frac"),
    ("eva", "duration_h"), ("eva", "reserve_min"), ("eva", "start_lmst_h"),
    ("eva", "walkback_budgets_min"),
    ("conditions", "storm"), ("conditions", "tripwire_at"), ("conditions", "d_allow_mgy"),
])
def test_omitted_default_equals_explicit_default(block, field):
    explicit = {**MINIMAL, block: {field: default_inputs()[block][field]}}
    assert h(explicit) == h(MINIMAL) == OFFICIAL_HASH


def test_omitted_station_defaults_equal_explicit():
    dwell = {s: 30 for s in ("S1", "S2", "S4", "S6", "S7", "S8")}
    for st in ({"mode": "best"}, {"mode": "best", "custom": []},
               {"mode": "best", "dwell_min": {"S4": 30}},
               {"mode": "best", "dwell_min": dwell, "custom": []}):
        assert h({**MINIMAL, "stations": st}) == OFFICIAL_HASH, st


def test_user_point_dwell_default_is_filled():
    pt = {"id": "U1", "lon": 137.4, "lat": -4.78}
    a = {**MINIMAL, "stations": {"mode": "best", "custom": [pt]}}
    b = {**MINIMAL, "stations": {"mode": "best", "custom": [pt], "dwell_min": {"U1": 30}}}
    assert h(a) == h(b) != OFFICIAL_HASH
    assert canonical_inputs(a)["stations"]["dwell_min"]["U1"] == 30.0


def test_integer_and_float_spelling_are_equal():
    assert h({**MINIMAL, "crew": {"suit_kg": 104}}) == h({**MINIMAL, "crew": {"suit_kg": 104.0}})


def test_negative_zero_equals_zero():
    a = {**MINIMAL, "conditions": {"tripwire_at": 0.0}}
    b = {**MINIMAL, "conditions": {"tripwire_at": -0.0}}
    assert h(a) == h(b)
    lon0 = {**MINIMAL, "pad": {"lon": -0.0, "lat": 0.0}}
    tiny = {**MINIMAL, "pad": {"lon": -1e-9, "lat": -4e-7}}  # both round to -0.0
    assert canonical_json(lon0) == canonical_json({**MINIMAL, "pad": {"lon": 0, "lat": -0.0}})
    assert canonical_json(tiny) == canonical_json(lon0)
    assert '"pad":{"lat":0.0,"lon":0.0}' in canonical_json(tiny)
    assert h(tiny) == h(lon0)


def test_float_noise_below_the_rounding_step():
    noisy = {**MINIMAL, "pad": {"lon": 137.401783 + 3e-10, "lat": -4.77748 - 4e-8},
             "crew": {"effort_cap_frac": 0.1 + 0.2 + 0.2 - 1e-12},  # 0.5 with float noise
             "conditions": {"d_allow_mgy": 0.5000001}}
    assert h(noisy) == OFFICIAL_HASH


def test_a_step_at_the_sixth_decimal_changes_the_hash():
    assert h({**MINIMAL, "pad": {"lon": 137.401784, "lat": -4.77748}}) != OFFICIAL_HASH


def test_title_and_pad_id_are_not_hashed():
    """Decision 11: same pad lon/lat with a different id and title -> same hash."""
    a = {**MINIMAL, "title": "Official pad", "pad": {"id": "rank1", "lon": 137.401783,
                                                     "lat": -4.77748}}
    b = {**MINIMAL, "title": "My other title", "pad": {"id": "custom-x", "lon": 137.401783,
                                                       "lat": -4.77748}}
    c = {**MINIMAL, "pad": {"lon": 137.401783, "lat": -4.77748}}
    assert h(a) == h(b) == h(c) == OFFICIAL_HASH
    for doc in (a, b):
        canon = canonical_inputs(doc)
        assert "title" not in canon and "id" not in canon["pad"]


# ------------------------------------------------------------- route (v1.2.0, D97) ----
ROUTE = {"mode": "ordered", "stops": [{"station": "S4"}, {"station": "S1"}, {"station": "S2"}]}
FREE = {"lon": 137.3962, "lat": -4.7781}


def test_missing_route_and_auto_hash_as_today():
    """D97: missing route = auto; the route is removed, so v1.1 hashes stay (official pinned)."""
    for route in ({"mode": "auto"}, {"mode": "auto", "stops": []}):
        assert h({**MINIMAL, "route": route}) == h(MINIMAL) == OFFICIAL_HASH
        assert "route" not in canonical_inputs({**MINIMAL, "route": route})
        pinned = {**MINIMAL, "contract_version": PINNED_CV, "route": route}
        assert h(pinned) == OFFICIAL_HASH_PINNED


def test_ordered_route_changes_the_hash_and_order_matters():
    a = h({**MINIMAL, "route": ROUTE})
    rev = {"mode": "ordered", "stops": ROUTE["stops"][::-1]}
    one = {"mode": "ordered", "stops": ROUTE["stops"][:1]}
    free = {"mode": "ordered", "stops": [*ROUTE["stops"], dict(FREE)]}
    moved = {"mode": "ordered", "stops": [*ROUTE["stops"], {**FREE, "lon": 137.3963}]}
    hashes = [a, h({**MINIMAL, "route": rev}), h({**MINIMAL, "route": one}),
              h({**MINIMAL, "route": free}), h({**MINIMAL, "route": moved})]
    assert OFFICIAL_HASH not in hashes and len(set(hashes)) == len(hashes)
    assert canonical_inputs({**MINIMAL, "route": ROUTE})["route"] == ROUTE  # order kept


def test_route_labels_are_not_hashed():
    """D57: a free point's label is dropped like the title."""
    plain = {"mode": "ordered", "stops": [{"station": "S2"}, dict(FREE)]}
    named = {"mode": "ordered", "stops": [{"station": "S2"}, {**FREE, "label": "Dark sand"}]}
    other = {"mode": "ordered", "stops": [{"station": "S2"}, {**FREE, "label": "Other"}]}
    assert h({**MINIMAL, "route": plain}) == h({**MINIMAL, "route": named}) \
        == h({**MINIMAL, "route": other})
    doc = {**MINIMAL, "route": named}
    before = copy.deepcopy(doc)
    assert "label" not in canonical_inputs(doc)["route"]["stops"][1]
    assert doc == before  # the caller's labels stay


@pytest.mark.parametrize("route", [
    {"mode": "ordered"}, {"mode": "ordered", "stops": []},
    {"mode": "auto", "stops": [{"station": "S1"}]},
    {"mode": "ordered", "stops": [{"station": "X1"}]},
    {"mode": "ordered", "stops": [{"lon": 137.4}]},
    {"mode": "ordered", "stops": [{"station": "S1", "lon": 137.4, "lat": -4.78}]},
    {"mode": "best"}])
def test_invalid_routes_raise(route):
    with pytest.raises(InvalidPlanInputs):
        canonical_inputs({**MINIMAL, "route": route})


def test_different_pad_lon_lat_changes_the_hash():
    base = {**MINIMAL, "pad": {"id": "rank1", "lon": 137.401783, "lat": -4.77748}}
    moved_lon = {**MINIMAL, "pad": {"id": "rank1", "lon": 137.393301, "lat": -4.77748}}
    moved_lat = {**MINIMAL, "pad": {"id": "rank1", "lon": 137.401783, "lat": -4.776468}}
    assert len({h(base), h(moved_lon), h(moved_lat)}) == 3


def test_input_is_not_mutated():
    doc = {**MINIMAL, "title": "t", "pad": {"id": "rank1", "lon": 137.401783, "lat": -4.77748}}
    before = copy.deepcopy(doc)
    h(doc)
    assert doc == before


# ------------------------------------------------- every result-affecting field ----
CHANGES = {
    "pad.lon": ("pad", {"lon": 137.39, "lat": -4.77748}),
    "pad.lat": ("pad", {"lon": 137.401783, "lat": -4.78}),
    "crew.body_mass_kg": ("crew", {"body_mass_kg": 80}),
    "crew.suit_kg": ("crew", {"suit_kg": 120}),
    "crew.tools_kg": ("crew", {"tools_kg": 5}),
    "crew.vo2max_ml_kg_min": ("crew", {"vo2max_ml_kg_min": 40}),
    "crew.effort_cap_frac": ("crew", {"effort_cap_frac": 0.45}),
    "eva.duration_h": ("eva", {"duration_h": 5}),
    "eva.reserve_min": ("eva", {"reserve_min": 20}),
    "eva.start_lmst_h": ("eva", {"start_lmst_h": 10}),
    "eva.walkback_budgets_min": ("eva", {"walkback_budgets_min": [30, 45, 60]}),
    "stations.mode set": ("stations", {"mode": "set", "ids": ["S1", "S4"]}),
    "stations.mode order": ("stations", {"mode": "order", "ids": ["S1", "S4"]}),
    "stations.ids": ("stations", {"mode": "set", "ids": ["S1", "S7"]}),
    "stations.dwell_min": ("stations", {"mode": "best", "dwell_min": {"S1": 45}}),
    "stations.custom": ("stations", {"mode": "best", "custom": [
        {"id": "U1", "lon": 137.4, "lat": -4.78}]}),
    "stations.custom.name": ("stations", {"mode": "best", "custom": [
        {"id": "U1", "name": "rock", "lon": 137.4, "lat": -4.78}]}),
    "conditions.storm": ("conditions", {"storm": "none"}),
    "conditions.tripwire_at": ("conditions", {"tripwire_at": 120}),
    "conditions.d_allow_mgy": ("conditions", {"d_allow_mgy": 0.75}),
}


def test_every_result_affecting_field_changes_the_hash():
    hashes = {name: h({**MINIMAL, block: value}) for name, (block, value) in CHANGES.items()}
    assert OFFICIAL_HASH not in hashes.values()
    assert len(set(hashes.values())) == len(hashes)  # also pairwise distinct


def test_every_canonical_leaf_is_covered_by_a_change():
    """Guard: a new canonical field must get a CHANGES entry (or be dropped on purpose)."""
    def leaves(d, prefix=""):
        for k, v in d.items():
            if isinstance(v, dict) and k != "dwell_min":
                yield from leaves(v, f"{prefix}{k}.")
            else:
                yield f"{prefix}{k}"
    covered = {name.split(" ")[0] for name in CHANGES} | {"contract_version"}
    missing = set(leaves(canonical_inputs(MINIMAL))) - covered
    assert not missing, missing


@pytest.mark.parametrize("part", EngineIdentity._fields)
def test_every_identity_part_changes_the_hash(part):
    ident = FIXED_IDENTITY._replace(**{part: getattr(FIXED_IDENTITY, part)[:-1] + "f"})
    assert h(MINIMAL, ident) != OFFICIAL_HASH


@pytest.mark.parametrize("bad", ["", "a\0b"])
def test_identity_parts_must_be_plain_strings(bad):
    with pytest.raises(ValueError):
        h(MINIMAL, FIXED_IDENTITY._replace(engine_tree=bad))


# ------------------------------------------------------------------- validation ----
@pytest.mark.parametrize("doc", [
    [],
    {},
    {"pad": {"lon": 137.4, "lat": -4.78}},                                   # no contract_version
    {"contract_version": CV},                                              # no pad
    {**MINIMAL, "pad": {"lon": 137.4}},                                      # no lat
    {**MINIMAL, "pad": {"lon": 400, "lat": -4.78}},                          # lon out of range
    {**MINIMAL, "pad": {"lon": "137.4", "lat": -4.78}},                      # string number
    {**MINIMAL, "crew": {"suit_kg": True}},                                  # bool is no number
    {**MINIMAL, "crew": {"helmet_kg": 2}},                                   # unknown field
    {**MINIMAL, "unknown": 1},
    {**MINIMAL, "stations": {"mode": "set"}},                                # set needs ids
    {**MINIMAL, "stations": {"mode": "fastest"}},
    {**MINIMAL, "conditions": {"storm": "2025-01-01"}},
    {**MINIMAL, "conditions": {"tripwire_at": -5}},
    {**MINIMAL, "eva": {"walkback_budgets_min": [30, 30]}},
    {**MINIMAL, "pad": {"lon": math.nan, "lat": -4.78}},                     # not finite
    {**MINIMAL, "crew": {"suit_kg": math.inf}},
])
def test_invalid_inputs_raise(doc):
    with pytest.raises(InvalidPlanInputs) as e:
        h(doc)
    assert e.value.errors
    with pytest.raises(InvalidPlanInputs):
        canonical_inputs(doc)


def test_invalid_error_is_a_value_error_with_paths():
    with pytest.raises(ValueError, match="crew"):
        canonical_inputs({**MINIMAL, "crew": {"suit_kg": "heavy"}})


# ---------------------------------------------------------------- live identity ----
def test_live_identity_from_engine_version(tmp_path, monkeypatch):
    from server.engine import version
    (tmp_path / version.SERVER_DATA_MANIFEST).write_text('{"files": []}\n')
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(tmp_path))
    ident = hashing.engine_identity()
    code = version.code_identity()
    assert ident.engine_tree == code["engine_tree"]
    assert ident.config_hash == code["config_hash"]
    from tools.make_bundle import config_hash
    assert ident.config_hash == config_hash()  # backend.yaml excluded (D57)
    assert ident.terrain_hash == version.terrain_hash()
    assert official_hash() == result_hash(MINIMAL) == result_hash(default_inputs(), ident)
    assert HASH_RE.match(official_hash())


def test_live_identity_without_server_data_is_unavailable(tmp_path, monkeypatch):
    from server.engine import version
    monkeypatch.setenv(version.SERVER_DATA_ENV, str(tmp_path))
    with pytest.raises(Unavailable):
        official_hash()


def test_exported_from_the_package():
    import server.engine as engine
    for name in ("canonical_inputs", "canonical_json", "result_hash", "official_hash",
                 "official_inputs", "engine_identity", "EngineIdentity", "InvalidPlanInputs"):
        assert getattr(engine, name) is getattr(hashing, name)
