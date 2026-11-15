"""Contracts: every schema is valid draft 2020-12, and the validator enforces the repo rules."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from tools import validate_contracts as vc

CONTRACTS = Path(__file__).resolve().parents[1] / "contracts"
SCHEMA_FILES = sorted(CONTRACTS.glob("*.schema.json"))
INDEX_SCHEMAS = {
    "scenarios_index.schema.json",
    "fields_index.schema.json",
    "fp3d_index.schema.json",
    "pad.schema.json",
    "pads_index.schema.json",
}


def load(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def test_there_are_schemas():
    assert len(SCHEMA_FILES) >= 23  # SPEC §6, §6.1, §6.2


@pytest.mark.parametrize("path", SCHEMA_FILES, ids=lambda p: p.name)
def test_schema_is_valid_draft_2020_12(path):
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$id"] == f"homeline/contracts/{path.name}"
    # 1.1.x is additive
    assert schema["x-contract-version"] in ("1.0.0", "1.1.0", "1.1.1", "1.1.2", "1.1.3", "1.1.4",
                                            "1.1.5")
    for key in ("title", "description", "x-source"):
        assert schema.get(key)


def test_every_mapped_schema_exists():
    names = {p.name for p in SCHEMA_FILES}
    for _, name in vc.SCHEMA_MAP + vc.INTERIM_SCHEMA_MAP:
        assert name in names


def test_every_schema_is_mapped():
    mapped = {name for _, name in vc.SCHEMA_MAP + vc.INTERIM_SCHEMA_MAP} | set(vc.NON_DATA_SCHEMAS)
    assert {p.name for p in SCHEMA_FILES} == mapped


@pytest.mark.parametrize("name", sorted(INDEX_SCHEMAS))
def test_index_schemas_require_boolean_dummy(name):
    schema = load(name)
    assert "dummy" in schema["required"]
    assert schema["properties"]["dummy"]["type"] == "boolean"


def test_spec_example_scenarios_index_validates():
    # SPEC §6 example, plus the required dummy flag.
    doc = {
        "dummy": False,
        "default": "nom_104",
        "scenarios": [{
            "id": "nom_104", "variant": "nominal", "suit_kg": 104,
            "files": {"isochrones": "scenarios/nom_104/isochrones.geojson",
                      "bands": "scenarios/bands_104.geojson",
                      "edges": "scenarios/nom_104/edges.geojson",
                      "partner": "scenarios/nom_104/partner.geojson"},
            "headline": {"budget_min": 30, "reachable_pct": None, "range_pct": [None, None]},
        }],
    }
    Draft202012Validator(load("scenarios_index.schema.json")).validate(doc)
    del doc["dummy"]
    assert not Draft202012Validator(load("scenarios_index.schema.json")).is_valid(doc)


def test_spec_example_stations_validates():
    doc = [{"id": "S1", "name": "Boxwork ridge–hollow transect", "lon": 137.38, "lat": -4.80,
            "value": None, "objective": "…", "tasks": ["…"], "dwell_min": 30,
            "t_home_min": {"nom_104": None}, "in_partner_line": None, "card": "cards/S1.json"}]
    Draft202012Validator(load("stations.schema.json")).validate(doc)


def test_fixes_skyline_needs_error_and_image():
    v = Draft202012Validator(load("fixes.schema.json"))
    base = {"t_eva_min": 10, "station": None, "sigma_m": 5}
    assert v.is_valid([{**base, "type": "rover"}])
    assert not v.is_valid([{**base, "type": "skyline"}])
    assert v.is_valid([{**base, "type": "skyline", "error_m": 12.0, "image_id": "NLB_x"}])


def test_edges_cause_enum():
    v = Draft202012Validator(load("edges.schema.json"))
    feat = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            "properties": {"budget": 30, "cause": "slope"}}
    assert v.is_valid({"type": "FeatureCollection", "features": [feat]})
    feat["properties"]["cause"] = "weather"
    assert not v.is_valid({"type": "FeatureCollection", "features": [feat]})


def _write(root: Path, rel: str, doc) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(doc), encoding="utf-8")


def test_empty_trees_pass(tmp_path):
    assert vc.run(tmp_path / "data", tmp_path / "data-dummy").ok


def test_dummy_true_in_public_fails(tmp_path):
    _write(tmp_path / "data", "vo/probe.json", {"dummy": True, "drives": [], "decision": "go"})
    report = vc.run(tmp_path / "data", tmp_path / "data-dummy")
    assert any('"dummy": true' in e for e in report.errors)


def test_index_in_dummy_tree_needs_dummy_true(tmp_path):
    doc = {"dummy": False, "bounds": [0, 0, 1, 1], "width": 1, "height": 1, "res_m": 5,
           "fields": {}}
    _write(tmp_path / "data-dummy", "fields/index.json", doc)
    assert not vc.run(tmp_path / "data", tmp_path / "data-dummy").ok
    doc["dummy"] = True
    _write(tmp_path / "data-dummy", "fields/index.json", doc)
    assert vc.run(tmp_path / "data", tmp_path / "data-dummy").ok


def test_invalid_file_fails_and_unmatched_warns(tmp_path):
    _write(tmp_path / "data", "vo/probe.json", {"drives": [], "decision": "maybe"})
    _write(tmp_path / "data", "unknown/thing.json", {})
    report = vc.run(tmp_path / "data", tmp_path / "data-dummy")
    assert any("vo_probe.schema.json" in e for e in report.errors)
    assert any("unknown/thing.json" in w for w in report.warnings)


def test_oversize_file_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(vc, "MAX_BYTES", 10)
    _write(tmp_path / "data", "big.bin", "x" * 100)
    assert not vc.run(tmp_path / "data", tmp_path / "data-dummy").ok


def test_interim_tree_validates(tmp_path):
    _write(tmp_path, "horizon/navcam_frames.json", {"frames": [{"image_id": "x"}]})
    report = vc.run(tmp_path / "d", tmp_path / "dd", interim_dir=tmp_path)
    assert any("navcam_frames.schema.json" in e for e in report.errors)


# --------------------------------------------------------------------------- v1.1.1


def errs(name: str, doc) -> list[str]:
    return [e.message for e in Draft202012Validator(load(name)).iter_errors(doc)]


def test_card_margin_binding_may_be_null():
    """v1.1.1: a station with no route or no access cell (S1) has a null binding."""
    doc = {"navcam": {"sol": None, "image_id": None, "url_local": None, "overlay_png": None},
           "skyline_error_deg": {"near": None, "mid": None, "far": None}, "panorama_png": None,
           "landmarks": [], "timeline": {"arrive": None, "leave": None, "turn_back": None},
           "margin_binding": None, "contingency": "No access cell within 50 m."}
    assert errs("card.schema.json", doc) == []
    assert errs("card.schema.json", doc | {"margin_binding": "none"})
    doc["access"] = {"lon": None, "lat": None, "dist_m": None, "reason": "sealed",
                     "walk_in": None, "radius_m": 50.0, "rule": "nearest walkable"}
    assert errs("card.schema.json", doc) == []
    doc["access"]["walk_in"] = {"dist_m": 2.1, "modelled": True}
    assert errs("card.schema.json", doc)  # the walk-in is never modelled


def test_stations_access_extras_validate():
    walk = {"dist_m": 2.1, "modelled": False, "rise_m": 0.59, "mean_slope_deg": 15.9,
            "max_slope_deg": 15.9, "max_terrain_slope_deg": 23.65}
    st = {"id": "S4", "name": "x", "lon": 137.408864, "lat": -4.785707, "value": 0.5,
          "objective": "", "tasks": [], "dwell_min": 30, "t_home_min": {"nom_104": 59.93},
          "in_partner_line": False, "card": "cards/S4.json", "access_radius_m": 50.0,
          "access_lon": 137.408842, "access_lat": -4.785679, "access_dist_m": 2.1,
          "access_reason": None,
          "access": {"nom_104": {"lon": 137.408842, "lat": -4.785679, "dist_m": 2.1,
                                 "t_home_min": 59.93, "o2_home_L": 77.72, "reason": None,
                                 "walk_in": walk}}}
    assert errs("stations.schema.json", [st]) == []
    st["access"]["nom_104"]["dist_m"] = "far"
    assert errs("stations.schema.json", [st])


def test_timeline_and_route_access_dist():
    row = {"t_min": 48.44, "event": "arrive", "station": "S4", "o2_left_L": 445.9,
           "t_home_min": 59.93, "margin_min": 25.97, "access_dist_m": 2.1}
    assert errs("timeline.schema.json", [row]) == []
    route = {"type": "FeatureCollection", "features": [{
        "type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        "properties": {"leg": 1, "from": "pad", "to": "S4", "to_access_dist_m": 2.1}}]}
    assert errs("route.schema.json", route) == []


def test_horizon_ring_ws3_layout_and_dummy():
    n = 4
    ws3 = {"observer": {"id": "pad", "lon": 137.382, "lat": -4.806, "x": -472.5, "y": -284874.2,
                        "eye_height_m": 1.7, "z_ground_m": -3627.7, "z_eye_m": -3626.0,
                        "source": "WS1 grid.json pad"},
           "az_step_deg": 90.0, "min_range_m": 3700.0, "max_range_m": 80000.0, "crs": "+proj=eqc",
           "azimuth_convention": "deg clockwise from grid north", "radius_m": 3396190.0,
           "notes": "null = unknown", "az_deg": [0.0, 90.0, 180.0, 270.0],
           "elev_deg": [1.09, None, 0.5, 2.0], "dist_m": [53200.0, None, 9000.0, 41000.0],
           "z_m": [-2194.1, None, -3500.0, -2200.0], "east_m": [0.0, None, 0.0, -41000.0],
           "north_m": [53200.0, None, -9000.0, 0.0],
           "source": ["mola_hrsc_200m", None, "ctx_20m", "mola_hrsc_200m"]}
    assert errs("horizon_ring.schema.json", ws3) == []
    assert all(len(ws3[k]) == n for k in ("elev_deg", "dist_m", "z_m", "east_m", "north_m"))
    dummy = Path(__file__).resolve().parents[1] / "web/public/data-dummy/fp3d/horizon_ring.json"
    assert errs("horizon_ring.schema.json", json.loads(dummy.read_text())) == []
    assert errs("horizon_ring.schema.json", [ws3])  # an array is no longer a ring
    assert errs("horizon_ring.schema.json", {k: v for k, v in ws3.items() if k != "elev_deg"})


def test_fields_index_pointer_entry_on_its_own_grid():
    """v1.1.1 (WS7 proposal): pointer.png on WS2's 3 m grid with its stencil; the 5 m entries
    keep using the top-level grid."""
    idx = {"dummy": False, "bounds": [137.319359, -4.868421, 137.444641, -4.743579],
           "width": 1480, "height": 1480, "res_m": 5.0, "fields": {
               "nom_104/t_home": {"file": "fields/nom_104/t_home.png", "scale": 0.1,
                                  "units": "min", "scenario": "nom_104"},
               "nom_104/pointer": {"file": "fields/nom_104/pointer.png", "scale": 1,
                                   "units": "move", "scenario": "nom_104",
                                   "bounds": [137.32, -4.86, 137.44, -4.75], "width": 2468,
                                   "height": 2468, "res_m": 3.0,
                                   "stencil": [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 1]]}}}
    assert errs("fields_index.schema.json", idx) == []
    idx["fields"]["nom_104/pointer"]["stencil"] = [[-1, 0, 1]]
    assert errs("fields_index.schema.json", idx)


# --------------------------------------------------------------------------- v1.1.2


def test_partner_d20_cart_only_properties():
    """v1.1.2 (D20, user 14:22): cart-only partner line with label/caption/drag_note per feature
    and the drag finding as a top-level member (WS2 haul.py)."""
    note = "One astronaut cannot drag a suited crewmate on Mars without a cart or sled."
    doc = {"type": "FeatureCollection",
           "drag_finding": {"case": "drag", "theta_deg": 0.0, "suit_kg": 104.0,
                            "casualty_kg": 179.0, "rescuer_system_kg": 189.0, "mu": 0.6,
                            "boot_mu": 0.5, "g_ms2": 3.71, "force_N": 398.454,
                            "traction_limit_N": 350.595, "max_mass_kg": 157.5,
                            "feasible": False, "reason": "traction", "note": note},
           "features": [{"type": "Feature",
                         "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [0, 1],
                                                                          [0, 0]]]},
                         "properties": {"case": "cart", "casualty_kg": 179.0, "contour_min": 60,
                                        "style": "dashed", "default_visible": False,
                                        "label": "Partner line (cart haul, 60 min)",
                                        "caption": "Design question.", "drag_note": note,
                                        "feasible": True, "area_km2": 1.233072}}]}
    assert errs("partner.schema.json", doc) == []
    bad = json.loads(json.dumps(doc))
    bad["drag_finding"]["force_N"] = "a lot"
    assert errs("partner.schema.json", bad)
    bad = json.loads(json.dumps(doc))
    bad["features"][0]["properties"]["label"] = 3
    assert errs("partner.schema.json", bad)


def test_card_drag_note_optional():
    doc = {"navcam": {"sol": None, "image_id": None, "url_local": None, "overlay_png": None},
           "skyline_error_deg": {"near": None, "mid": None, "far": None}, "panorama_png": None,
           "landmarks": [], "timeline": {"arrive": None, "leave": None, "turn_back": None},
           "margin_binding": None, "contingency": "x", "drag_note": "no drag on Mars"}
    assert errs("card.schema.json", doc) == []
    assert errs("card.schema.json", doc | {"drag_note": 1})


def test_conservative_cellstate_path_mapped():
    assert vc.match_schema("terrain/cellstate_conservative.json") == "cellstate.schema.json"


def test_pad_proposal_block_optional():
    """v1.1.2 (C 14:58): pad.json = the pad in use (pad_default); the F8 siting result goes in an
    optional `proposal` block, never in `pad`."""
    checks = {"assessed_pct_30min": 100.0, "max_slope_deg": 2.1, "rule_passed": True}
    doc = {"dummy": False,
           "pad": {"lon": 137.382, "lat": -4.806, "elev_m": -3627.7, "score": None,
                   "checks": checks, "source": "config/site.yaml pad_default"},
           "alternatives": [], "hop_options": [], "site_rule_version": "x"}
    assert errs("pad.schema.json", doc) == []
    doc["proposal"] = {
        "adopted": False, "note": "F8 proposal for S; not the pad in use",
        "pad": {"lon": 137.402443, "lat": -4.769028, "elev_m": -3811.3, "score": 0.475,
                "checks": {"assessed_pct_30min": None, "max_slope_deg": 3.95,
                           "rule_passed": None}},
        "alternatives": [{"rank": 2, "lon": 137.405846, "lat": -4.764625, "elev_m": -3810.1,
                          "score": 0.475}],
        "hop_options": [], "site_rule_version": "site.yaml siting"}
    assert errs("pad.schema.json", doc) == []
    doc["proposal"]["adopted"] = True
    assert errs("pad.schema.json", doc)  # a proposal is never the pad in use
    doc["proposal"]["adopted"] = False
    doc["proposal"]["pad"]["lon"] = "east"
    assert errs("pad.schema.json", doc)


# --------------------------------------------------------------------------- v1.1.4 (D21)


def _globs_intersect(a: str, b: str) -> bool:
    """True if some string matches both fnmatch segment globs (only `*` wildcards used)."""
    assert not set("?[]") & set(a + b)
    seen, todo = set(), [(0, 0)]
    while todo:
        i, j = todo.pop()
        if (i, j) in seen:
            continue
        seen.add((i, j))
        if i == len(a) and j == len(b):
            return True
        ca = a[i] if i < len(a) else None
        cb = b[j] if j < len(b) else None
        if ca == "*":
            todo.append((i + 1, j))           # star matches nothing more
            if cb is not None and cb != "*":
                todo.append((i, j + 1))       # star eats a literal of b
        if cb == "*":
            todo.append((i, j + 1))
            if ca is not None and ca != "*":
                todo.append((i + 1, j))
        if ca is not None and ca == cb and ca != "*":
            todo.append((i + 1, j + 1))
    return False


def test_globs_intersect_known_answers():
    assert _globs_intersect("*", "pads")
    assert _globs_intersect("bands_*.geojson", "*.geojson")
    assert not _globs_intersect("edges.geojson", "partner.geojson")
    assert not _globs_intersect("route_*.geojson", "timeline_*.json")


@pytest.mark.parametrize("table", ["SCHEMA_MAP", "INTERIM_SCHEMA_MAP"])
def test_schema_map_patterns_do_not_overlap(table):
    """"First match wins; patterns must not overlap": no path can match two rows."""
    rows = [p for p, _ in getattr(vc, table)]
    for k, a in enumerate(rows):
        for b in rows[k + 1:]:
            pa, pb = a.split("/"), b.split("/")
            if len(pa) == len(pb) and all(
                    _globs_intersect(x, y) for x, y in zip(pa, pb, strict=True)):
                pytest.fail(f"{a!r} and {b!r} overlap")


@pytest.mark.parametrize("path, schema", [
    ("scenarios/pads/index.json", "pads_index.schema.json"),
    ("scenarios/pads/rank2/summary.json", "pad_summary.schema.json"),
    ("scenarios/pads/rank2/bands_104.geojson", "bands.schema.json"),
    ("scenarios/pads/rank2/edges.geojson", "edges.schema.json"),
    ("scenarios/pads/pad_default/partner.geojson", "partner.schema.json"),
    ("scenarios/pads/rank3/route_nom_104.geojson", "route.schema.json"),
    ("scenarios/pads/rank4/timeline_nom_104.json", "timeline.schema.json"),
    ("scenarios/nom_104/edges.geojson", "edges.schema.json"),  # unchanged
    ("scenarios/pads/rank2/isochrones.geojson", None),  # no isochrones for picker pads
])
def test_pads_paths_mapped(path, schema):
    assert vc.match_schema(path) == schema


def pads_index_doc() -> dict:
    """Shaped like WS2's engine/public/scenarios/pads/index.json (padpick.py, 17:01 CET)."""
    def row(pid, rank, score, official, lon, lat, elev, pct):
        r = {"id": pid, "kind": "pad_default" if pid == "pad_default" else "block",
             "lon": lon, "lat": lat, "elev_m": elev, "rank": rank, "score": score,
             "official": official, "picker": not official,
             "tiebreak": {"reachable_pct_30": pct, "elev_m": elev},
             "screen_score": 52 - rank, "screen_rank": rank,
             "summary": None if official else f"scenarios/pads/{pid}/summary.json"}
        if official:
            r["files"] = "official pad: the main scenario files (scenarios/index.json)"
            r["route"] = {"stops": ["S7", "S6", "S1", "S4"], "total_min": 325.94}
        return r
    return {"dummy": False, "scenario": "nom_104", "score_kind": "d21_feasible_eva_count",
            "order": "feasible-EVA count desc; tiebreaks", "official": "rank1",
            "decision": "D21", "ids": "rank{n}",
            "pads": [row("rank1", 1, 38, True, 137.401783, -4.77748, -3742.4, 22.98),
                     row("rank2", 2, 38, False, 137.393301, -4.776468, -3779.5, 21.46),
                     row("pad_default", 5, 31, False, 137.382, -4.806, -3627.8, 16.7)],
            "screening": {"n_screened": 196, "count_histogram": {"52": 1}}}


def pad_summary_doc(pid: str = "rank2") -> dict:
    """Shaped like WS2's engine/public/scenarios/pads/{id}/summary.json."""
    return {"id": pid, "kind": "block", "scenario": "nom_104",
            "pad": {"lon": 137.393301, "lat": -4.776468, "elev_m": -3779.5}, "rank": 2,
            "official": False, "score": 38, "score_kind": "d21_feasible_eva_count",
            "tiebreak": {"reachable_pct_30": 21.46, "elev_m": -3779.5},
            "headline": {"30": {"budget_min": 30, "reachable_pct": 21.5,
                                "range_pct": [16.4, 30.3]},
                         "60": {"budget_min": 60, "reachable_pct": None,
                                "range_pct": [None, None]}},
            "route": {"stops": ["S7", "S6", "S1", "S4"], "total_min": 326.03,
                      "n_feasible_subsets": 38, "unreachable": [], "no_access": {},
                      "lowest_margin_min": 47.64, "lowest_margin_binding": "dose",
                      "turn_back": {"S1": {"t_min": 351.01, "binding": "EVA duration"}},
                      "dose": {"violation": False}},
            "files": {"bands": f"scenarios/pads/{pid}/bands_104.geojson",
                      "route": f"scenarios/pads/{pid}/route_nom_104.geojson"},
            "note": "Rover parking option (D21 pad picker)"}


def _run_one(tmp_path, rel: str, doc):
    _write(tmp_path / "data", rel, doc)
    return vc.run(tmp_path / "data", tmp_path / "data-dummy")


def test_pads_index_ws2_shape_validates(tmp_path):
    doc = pads_index_doc()
    assert errs("pads_index.schema.json", doc) == []
    assert _run_one(tmp_path, "scenarios/pads/index.json", doc).ok


@pytest.mark.parametrize("change", ["none_official", "two_official", "top_mismatch",
                                    "dup_id"])
def test_pads_index_exactly_one_official(tmp_path, change):
    doc = pads_index_doc()
    if change == "none_official":
        doc["pads"][0]["official"] = False
        doc["pads"][0]["summary"] = "scenarios/pads/rank1/summary.json"
    elif change == "two_official":
        doc["pads"][1].update(official=True, picker=False, summary=None)
    elif change == "top_mismatch":
        doc["official"] = "rank2"
    else:
        doc["pads"][2]["id"] = "rank2"
    assert errs("pads_index.schema.json", doc) == []  # the schema alone cannot count
    report = _run_one(tmp_path, "scenarios/pads/index.json", doc)
    assert not report.ok and "pads_index.schema.json" in report.errors[0]


@pytest.mark.parametrize("change, ok", [
    (lambda d: d.pop("dummy"), False),                      # index file
    (lambda d: d.pop("official"), True),                     # top-level id optional
    (lambda d: d["pads"][1].pop("summary"), False),          # picker row needs its summary
    (lambda d: d["pads"][1].update(summary="../x.json"), False),
    (lambda d: d["pads"][1].update(official=True), False),   # a picker row is not official
    (lambda d: d["pads"][1].update(id="../rank2"), False),   # ids are plain file names
    (lambda d: d["pads"][1].update(id=".."), False),
    (lambda d: d["pads"][1]["tiebreak"].update(reachable_pct_30="high"), False),
    (lambda d: d["pads"][1].pop("picker"), True),            # extra keys optional
    (lambda d: d["pads"][1].update(label="#2", note="x"), True),
    (lambda d: d["pads"][2].update(elev_m=None, score=None), True),
])
def test_pads_index_rows(change, ok):
    doc = pads_index_doc()
    change(doc)
    assert (errs("pads_index.schema.json", doc) == []) is ok


def test_pad_summary_ws2_shape_validates(tmp_path):
    doc = pad_summary_doc()
    assert errs("pad_summary.schema.json", doc) == []
    assert _run_one(tmp_path, "scenarios/pads/rank2/summary.json", doc).ok


@pytest.mark.parametrize("change, ok", [
    (lambda d: d["headline"]["30"].update(range_pct=[16.4]), False),     # [con, opt]
    (lambda d: d["headline"]["30"].update(range_pct=[1, 2, 3]), False),
    (lambda d: d["headline"]["30"].pop("budget_min"), True),  # the key gives the budget
    (lambda d: d["headline"]["30"].pop("range_pct"), False),
    (lambda d: d["headline"].pop("60"), False),
    (lambda d: d["headline"]["30"].update(reachable_pct=101), False),
    (lambda d: d["pad"].pop("lat"), False),
    (lambda d: d.pop("route"), False),
    (lambda d: d.update(route=None), True),                              # no route
    (lambda d: d["headline"]["30"].update(reachable_pct=None), True),
    (lambda d: d.update(extra={"x": 1}), True),
])
def test_pad_summary_fields(change, ok):
    doc = pad_summary_doc()
    change(doc)
    assert (errs("pad_summary.schema.json", doc) == []) is ok


@pytest.mark.parametrize("rel, change", [
    ("scenarios/pads/rank3/summary.json", None),                         # id != folder
    ("scenarios/pads/rank2/summary.json", lambda d: d["headline"]["60"].update(budget_min=45)),
])
def test_pad_summary_semantic_checks(tmp_path, rel, change):
    doc = pad_summary_doc()
    if change:
        change(doc)
    assert errs("pad_summary.schema.json", doc) == []
    assert not _run_one(tmp_path, rel, doc).ok


def test_pad_json_d21_extras():
    """v1.1.4 (WS2 session 7): pad = the D21 official pad; d21 block; alternatives carry id,
    kind, score_basis, d21_rank, tiebreak, picker; the F8 result is a row with null rank data."""
    tb = {"reachable_pct_30": 22.98, "elev_m": -3742.4}
    doc = {"dummy": False,
           "pad": {"lon": 137.401783, "lat": -4.77748, "elev_m": -3742.4, "score": 38,
                   "checks": {"assessed_pct_30min": 100.0, "max_slope_deg": 4.86,
                              "rule_passed": True},
                   "source": "D21 (user 2026-11-14 16:14)", "f8_score": 0.4744,
                   "score_kind": "d21_feasible_eva_count", "id": "rank1", "tiebreak": tb},
           "alternatives": [
               {"rank": 2, "id": "rank2", "kind": "block", "lon": 137.393301, "lat": -4.776468,
                "elev_m": -3779.5, "score": 38, "score_basis": "full_run", "d21_rank": 2,
                "tiebreak": tb, "picker": True},
               {"rank": 6, "id": "f8_proposal", "kind": "f8_proposal", "lon": 137.378775,
                "lat": -4.769028, "elev_m": -3914.2, "score": None, "score_basis": None,
                "d21_rank": None, "f8_score": 1.4352, "note": "not a D21 candidate"}],
           "hop_options": [], "site_rule_version": "site.yaml siting",
           "d21": {"decision": "D21", "official_id": "rank1", "top_full_runs": 5,
                   "screening": {}, "screening_top": [{"id": "b37243"}],
                   "assumptions": ["tiebreak 2 = pad-cell elevation"]}}
    assert errs("pad.schema.json", doc) == []
    doc["alternatives"][0]["d21_rank"] = 2.5
    assert errs("pad.schema.json", doc)
    doc["alternatives"][0]["d21_rank"] = 2
    doc["alternatives"][0]["picker"] = "yes"
    assert errs("pad.schema.json", doc)


def test_card_landmark_display_d33():
    """v1.1.4 (WS3 D33): landmarks below the skyline are bearing-only ticks."""
    schema = load("card.schema.json")
    item = schema["properties"]["landmarks"]["items"]
    lm = {"name": "Gediz Vallis", "bearing_deg": 128.65, "dist_km": 4.31, "kind": "official",
          "above_skyline": False, "display": "bearing_tick"}
    v = Draft202012Validator(item)
    assert list(v.iter_errors(lm)) == []
    assert list(v.iter_errors({**lm, "display": "label", "above_skyline": True})) == []
    assert list(v.iter_errors({k: x for k, x in lm.items() if k != "display"})) == []
    assert list(v.iter_errors({**lm, "display": "hidden"}))


# --------------------------------------------------------------------------- v1.1.5 (WS2 s8)
INTERIM_PUBLIC = Path(__file__).resolve().parents[1] / "data" / "interim" / "engine" / "public"

HEADLINE_60 = {"budget_min": 60, "reachable_pct": 31.5, "range_pct": [16.2, 43.8],
               "basis": "in_data", "in_data_pct": 75.8,
               "label": "75.8 % of the circle lies inside the terrain data"}
FEASIBLE = {"screen_count": 52, "full_run_count": 38, "excluded_by_effort_cap_rule": 14,
            "note": "screening count minus the full-run count"}


def scenarios_index_doc(**extra) -> dict:
    sc = {"id": "nom_104", "variant": "nominal", "suit_kg": 104,
          "files": {"isochrones": "scenarios/nom_104/isochrones.geojson",
                    "bands": "scenarios/bands_104.geojson",
                    "edges": "scenarios/nom_104/edges.geojson",
                    "partner": "scenarios/nom_104/partner.geojson"},
          "headline": {"budget_min": 30, "reachable_pct": 23.0, "range_pct": [15.2, 28.7]}}
    sc.update(extra)
    return {"dummy": False, "default": "nom_104", "scenarios": [sc]}


def test_v115_scenarios_headline_60_optional_and_checked():
    assert errs("scenarios_index.schema.json", scenarios_index_doc()) == []
    assert errs("scenarios_index.schema.json", scenarios_index_doc(headline_60=HEADLINE_60)) == []
    bad = dict(HEADLINE_60, in_data_pct=175.8)
    assert errs("scenarios_index.schema.json", scenarios_index_doc(headline_60=bad))
    bad = {k: v for k, v in HEADLINE_60.items() if k != "range_pct"}
    assert errs("scenarios_index.schema.json", scenarios_index_doc(headline_60=bad))


def test_v115_pads_feasible_block():
    doc = pads_index_doc()
    doc["pads"][0]["feasible"] = FEASIBLE
    assert errs("pads_index.schema.json", doc) == []
    s = dict(pad_summary_doc(), feasible=FEASIBLE)
    assert errs("pad_summary.schema.json", s) == []
    s = dict(pad_summary_doc(), feasible={"screen_count": 51})
    assert errs("pad_summary.schema.json", s)  # all three counts required when the block exists


def test_v115_trade_table_in_data_pct():
    cell = {"science_value": 2.0281, "reachable_pct": 31.5, "partner_area_km2": 2.6658}
    doc = {"rows": [30, 60], "cols": [104], "cells": [[cell], [dict(cell, in_data_pct=75.8)]]}
    assert errs("trade_table.schema.json", doc) == []
    doc["cells"][1][0]["in_data_pct"] = "75.8"
    assert errs("trade_table.schema.json", doc)


def golden_doc() -> dict:
    return {"version": "1.0.0", "kind": "homeline_physio_golden",
            "coords": {"frame": "pad-local metres", "x": "east", "y": "north", "z": "up"},
            "units": {"t": "min"}, "tolerances": {"physio": {"rel": 1e-6, "abs": 1e-9}},
            "cases": {"physio": [{"id": "physio.nominal.104.0deg",
                                  "inputs": {"grade_deg": 0.0}, "expected": {"v_star_ms": 0.98}}]}}


def test_v115_golden_schema_and_mapping():
    assert vc.match_schema("physio/golden.json") == "golden.schema.json"
    assert errs("golden.schema.json", golden_doc()) == []
    bad = golden_doc()
    bad["tolerances"]["physio"] = {"rel": -1, "abs": 0}
    assert errs("golden.schema.json", bad)
    bad = golden_doc()
    bad["cases"]["physio"][0].pop("id")
    assert errs("golden.schema.json", bad)
    assert errs("golden.schema.json", dict(golden_doc(), kind="other"))


@pytest.mark.parametrize("rel, schema", [
    ("physio/golden.json", "golden.schema.json"),
    ("scenarios/index.json", "scenarios_index.schema.json"),
    ("scenarios/pads/index.json", "pads_index.schema.json"),
    ("scenarios/pads/rank2/summary.json", "pad_summary.schema.json"),
    ("trade_table.json", "trade_table.schema.json"),
])
def test_v115_ws2_real_files_validate(rel, schema):
    """WS2 session 8's real interim files (skipped where data/interim is absent, e.g. CI)."""
    p = INTERIM_PUBLIC / rel
    if not p.is_file():
        pytest.skip(f"{p} not present")
    assert errs(schema, json.loads(p.read_text(encoding="utf-8"))) == []
