"""Design contracts v1 (DESIGN §6): labels, storyboard, terrain tile metadata, highlights.

Each schema is valid draft 2020-12 with the repo's header conventions, accepts the DESIGN §6.2 /
§6.3 examples (placeholder zeros replaced by in-range coordinates) and rejects obvious violations.
"""

import copy
import json
import re
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

REPO = Path(__file__).resolve().parents[1]
CONTRACTS = REPO / "contracts"
DESIGN_SCHEMAS = ["labels.schema.json", "storyboard.schema.json", "terrain_tiles.schema.json",
                  "highlights.schema.json"]
# exact pin per schema: v1 frozen at merge, an additive change is a minor bump (contracts/README.md)
DESIGN_VERSIONS = {"labels.schema.json": "1.0.0", "storyboard.schema.json": "1.0.0",
                   "terrain_tiles.schema.json": "1.1.0",  # P2c: optional vertical_offset_m
                   "highlights.schema.json": "1.0.0"}


def load(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def ok(name: str, doc) -> bool:
    return Draft202012Validator(load(name)).is_valid(doc)


def errs(name: str, doc) -> list[str]:
    return [e.message for e in Draft202012Validator(load(name)).iter_errors(doc)]


# ------------------------------------------------------------------------------------- headers


def test_design_versions_cover_every_schema():
    assert set(DESIGN_VERSIONS) == set(DESIGN_SCHEMAS)


@pytest.mark.parametrize("name", DESIGN_SCHEMAS)
def test_schema_valid_with_repo_header(name):
    schema = load(name)
    Draft202012Validator.check_schema(schema)
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$id"] == f"homeline/contracts/{name}"
    assert schema["x-contract-version"] == DESIGN_VERSIONS[name]
    assert "Design contracts v1" in schema["description"]
    for key in ("title", "description", "x-source"):
        assert schema.get(key)


def test_field_shader_doc_exists_and_names_every_uniform():
    text = (CONTRACTS / "field_shader.md").read_text(encoding="utf-8")
    for u in ("u_tHome", "u_o2Home", "u_state", "u_t", "u_tDark", "u_tauDose", "u_tEva", "u_o2Left",
              "u_reserve", "u_o2Rate", "u_budget", "u_mode", "u_variant", "u_k", "u_pad", "u_cell",
              "u_flatSpeed", "u_amber"):
        assert re.search(rf"`{u}\b", text), u
    assert "R·256 + G" in text and "fieldAt(lon, lat)" in text


# ------------------------------------------------------------------------------------- labels

LABELS = {"version": "1", "labels": [
    {"code": "PAD", "name": "Rover pad", "kind": "pad", "status": None,
     "lon": 137.4018, "lat": -4.7775, "priority": 1, "minzoom": 10, "ref": "pad.json"},
    {"code": "S7", "name": "Scored site …", "kind": "station", "status": None,
     "lon": 137.402443, "lat": -4.769028, "priority": 3, "minzoom": 13, "ref": "stations.json#S7"},
    {"code": "MSH", "name": "Aeolis Mons (Mount Sharp)", "kind": "landmark", "status": "official",
     "lon": 137.85, "lat": -5.08, "priority": 6, "minzoom": 6, "ref": "landmarks.yaml"},
]}


def test_labels_design_example_validates():
    assert errs("labels.schema.json", LABELS) == []
    doc = copy.deepcopy(LABELS)
    doc["labels"][2] |= {"bearing_deg": 118.2, "dist_m": 52300.0, "maxzoom": 14}
    doc["labels"].append({"code": "BOX", "name": "Boxwork unit", "kind": "landmark",
                          "status": "informal", "lon": 137.39, "lat": -4.79, "priority": 6,
                          "minzoom": 6, "ref": "landmarks.yaml"})
    assert errs("labels.schema.json", doc) == []


@pytest.mark.parametrize("mutate", [
    lambda d: d.pop("version"),
    lambda d: d.update(version=1),
    lambda d: d.update(version="2"),
    lambda d: d["labels"][0].update(kind="rover"),
    lambda d: d["labels"][0].update(kind="selected"),  # a runtime state, not a kind
    lambda d: d["labels"][0].update(lon=200.0),
    lambda d: d["labels"][0].update(lat=-95.0),
    lambda d: d["labels"][0].update(lat="-4.7"),
    lambda d: d["labels"][0].update(code="pad"),
    lambda d: d["labels"][0].update(priority=1.5),
    lambda d: d["labels"][0].update(priority=0),
    lambda d: d["labels"][0].update(minzoom=30),
    lambda d: d["labels"][0].update(status="maybe"),
    lambda d: d["labels"][0].pop("status"),  # nullable, not optional
    lambda d: d["labels"][0].pop("ref"),
], ids=lambda f: "")
def test_labels_rejects(mutate):
    doc = copy.deepcopy(LABELS)
    mutate(doc)
    assert not ok("labels.schema.json", doc)


def test_label_kinds_follow_config_priority():
    """config/design.yaml labels.priority minus the runtime-only 'selected'."""
    item = load("labels.schema.json")["properties"]["labels"]["items"]
    kinds = item["properties"]["kind"]["enum"]
    assert kinds == ["pad", "route_station", "station", "scored_site", "user_point", "landmark",
                     "overlay"]


# ------------------------------------------------------------------------------------- storyboard

INTRO = {"id": "intro", "version": "1", "size": [1920, 1080], "fps": 60, "steps": [
    {"t": 0.0, "camera": {"lon": 137.4, "lat": -5.4, "alt_m": 180000, "bearing": 0, "pitch": 0},
     "caption": "Gale crater · Mars"},
    {"t": 6.0, "camera": {"target": "PAD", "alt_m": 4000, "pitch": 55},
     "layers": {"homeline": False}},
    {"t": 12.0, "field": {"mode": "bands", "collapse": 0},
     "caption": "NASA is considering a 30-minute walkback"},
    {"t": 14.0, "field": {"collapse": 1, "duration_s": 3}, "caption": "Mars isn't flat"},
    {"t": 19.0, "ui": "reveal"},
]}


def test_storyboard_design_example_validates():
    assert errs("storyboard.schema.json", INTRO) == []
    doc = copy.deepcopy(INTRO)
    doc["steps"].append({"t": 20.0, "clock": {"t_min": 48.4, "playing": True, "speed": 2},
                         "selection": "S4", "field": {"mode": "margin", "variant": "con"}})
    doc["steps"].append({"t": 22.0, "selection": None, "caption": None, "ui": "hide"})
    assert errs("storyboard.schema.json", doc) == []


@pytest.mark.parametrize("mutate", [
    lambda d: d.pop("fps"),
    lambda d: d.update(version="2"),
    lambda d: d.update(size=[1920]),
    lambda d: d.update(steps=[]),
    lambda d: d.update(id="Intro Story"),
    lambda d: d["steps"][0].pop("t"),
    lambda d: d["steps"][0].update(t=-1),
    lambda d: d["steps"][0].update(zoom=3),  # unknown step key (hand-authored: catch typos)
    lambda d: d["steps"][0]["camera"].pop("lat"),  # absolute needs lon and lat
    lambda d: d["steps"][0]["camera"].update(lat=-120),
    lambda d: d["steps"][0]["camera"].update(pitch=90),
    lambda d: d["steps"][1]["camera"].update(lon=137.4, lat=-4.8),  # absolute and target at once
    lambda d: d["steps"][1]["camera"].update(target="pad"),
    lambda d: d["steps"][1]["camera"].pop("target"),  # neither absolute nor target
    lambda d: d["steps"][1].update(layers={"homeline": "off"}),
    lambda d: d["steps"][2]["field"].update(mode="heatmap"),
    lambda d: d["steps"][3]["field"].update(collapse=1.5),
    lambda d: d["steps"][3]["field"].update(variant="nominal"),
    lambda d: d["steps"][4].update(ui="show-all"),
    lambda d: d["steps"][4].update(clock={"t_min": -5}),
], ids=lambda f: "")
def test_storyboard_rejects(mutate):
    doc = copy.deepcopy(INTRO)
    mutate(doc)
    assert not ok("storyboard.schema.json", doc)


@pytest.mark.parametrize("path", sorted((REPO / "web/public/story").glob("*.json")),
                         ids=lambda p: p.name)
def test_every_published_storyboard_validates(path):
    """web/public/story/ is outside the data root (no SCHEMA_MAP row), so it is checked here."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert errs("storyboard.schema.json", doc) == []
    assert doc["id"] == path.stem
    ts = [s["t"] for s in doc["steps"]]
    assert ts == sorted(ts)


# ------------------------------------------------------------------------------------- terrain

TERRAIN = {"name": "terrain", "encoding": "terrarium", "format": "png", "scheme": "xyz",
           "tile_px": 256, "factor": 1.878, "tiles": ["terrain/{z}/{x}/{y}.png"],
           "minzoom": 10, "maxzoom": 16, "bounds": [137.319359, -4.868421, 137.444641, -4.743579],
           "focus": {"minzoom": 16, "maxzoom": 16, "bounds": [137.37, -4.82, 137.42, -4.76]},
           "source": ["data/interim/terrain/dem_1m.tif", "CTX 20 m DTM"],
           "source_hash": "3f2a9c0d1b4e5f6a", "total_bytes": 21_500_000,
           "budget_bytes": 25 * 2**20, "tile_count": {"10": 1, "16": 120},
           "attribution": "HiRISE DTM (NASA/JPL/UArizona); CTX DTM"}
TERRAIN_LOW = {"name": "terrain_low", "encoding": "terrarium", "tile_px": 256, "factor": 1.878,
               "tiles": ["terrain_low/{z}/{x}/{y}.png"], "minzoom": 6, "maxzoom": 10,
               "bounds": [136.0, -6.5, 139.0, -4.0], "focus": None,
               "source": ["CTX 20 m DTM", "MOLA-HRSC 200 m blend"],
               "source_hash": "a" * 64, "total_bytes": 4_200_000}


def test_terrain_tiles_both_sets_validate():
    assert errs("terrain_tiles.schema.json", TERRAIN) == []
    assert errs("terrain_tiles.schema.json", TERRAIN_LOW) == []


@pytest.mark.parametrize("mutate", [
    lambda d: d.update(encoding="mapbox"),
    lambda d: d.pop("factor"),
    lambda d: d.update(factor=0),
    lambda d: d.update(name="terrain_hi"),
    lambda d: d.update(tiles=["terrain/{x}.png"]),
    lambda d: d.update(tiles="terrain/{z}/{x}/{y}.png"),
    lambda d: d.update(bounds=[137.3, -4.8, 137.4]),
    lambda d: d.update(maxzoom=25),
    lambda d: d.pop("focus"),  # nullable, not optional
    lambda d: d["focus"].pop("bounds"),
    lambda d: d.update(source=[]),
    lambda d: d.update(source_hash="not-a-hash"),
    lambda d: d.update(total_bytes=-1),
    lambda d: d.update(total_bytes=1.5),
], ids=lambda f: "")
def test_terrain_tiles_rejects(mutate):
    doc = copy.deepcopy(TERRAIN)
    mutate(doc)
    assert not ok("terrain_tiles.schema.json", doc)


# ------------------------------------------------------------------------------------- highlights

SQUARE = {"type": "Polygon", "coordinates": [[[137.38, -4.80], [137.381, -4.80],
                                              [137.381, -4.799], [137.38, -4.80]]]}


def fc(kind, props, preliminary=True, **extra):
    return {"type": "FeatureCollection", "kind": kind, "preliminary": preliminary, **extra,
            "features": [{"type": "Feature", "geometry": SQUARE, "properties": props}]}


RIDGES = fc("ridges", {"id": "r1", "relief_m": 1.2, "length_m": 340.0},
            threshold={"name": "overlays.ridge_index_threshold_m", "value": 0.75, "units": "m",
                       "source": "assumed (WS1 ridge rule), R9 pending"})
MINERAL = fc("mineral", {"type": "sulfate", "strength": 0.021, "strength_max": 0.034},
             threshold={"name": "overlays.mineral_threshold", "value": None})
BLOCKED = fc("blocked", {"reason": "slope_class", "area_m2": 1890.0}, preliminary=False,
             threshold=None, variant="nominal")


def test_highlights_three_kinds_validate():
    for doc in (RIDGES, MINERAL, BLOCKED):
        assert errs("highlights.schema.json", doc) == []
    multi = copy.deepcopy(BLOCKED)
    multi["features"][0]["geometry"] = {"type": "MultiPolygon",
                                        "coordinates": [SQUARE["coordinates"]]}
    multi["features"][0]["properties"]["reason"] = "step_guard"
    assert errs("highlights.schema.json", multi) == []
    assert errs("highlights.schema.json", fc("ridges", {"relief_m": 1, "length_m": 2}) |
                {"features": []}) == []


@pytest.mark.parametrize("doc", [
    {k: v for k, v in RIDGES.items() if k != "preliminary"},  # the R9 flag is required
    RIDGES | {"preliminary": "yes"},
    RIDGES | {"kind": "craters"},
    RIDGES | {"type": "Feature"},
    fc("ridges", {"relief_m": 1.2}),  # no length
    fc("ridges", {"relief_m": -1, "length_m": 3}),
    fc("mineral", {"type": "olivine", "strength": 0.02}),
    fc("mineral", {"type": "clay"}),  # no strength
    fc("blocked", {"reason": "weather", "area_m2": 10}),
    fc("blocked", {"reason": "step_guard"}),  # no area
    fc("blocked", {"reason": "step_guard", "area_m2": 10}, variant="pessimistic"),
    {**BLOCKED, "features": [{"type": "Feature", "properties": {"reason": "mixed", "area_m2": 1},
                              "geometry": {"type": "LineString", "coordinates": []}}]},
], ids=lambda d: "")
def test_highlights_rejects(doc):
    assert not ok("highlights.schema.json", doc)
