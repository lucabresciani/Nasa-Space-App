"""P1 / WS16: pipeline/export/labels.py -> labels.json (DESIGN §6.2, U13; D33, D42).

Checks the committed web/public/data/labels.json against its sources (pad.json, stations.json,
scenarios/pads/index.json, the IAU gazetteer CSV), the frozen contract and config/design.yaml,
and that the exporter is deterministic and types no coordinate by hand (AGENTS.md rules 2, 7).
"""

from __future__ import annotations

import ast
import csv
import json
import re
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

from pipeline.export import labels as L

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "web" / "public" / "data"
LABELS = PUBLIC / "labels.json"
SCHEMA = REPO / "contracts" / "labels.schema.json"
IAU_CSV = REPO / "data" / "raw" / "discovery" / "iau_mars.csv"
DESIGN = yaml.safe_load((REPO / "config" / "design.yaml").read_text())["labels"]
needs_iau = pytest.mark.skipif(not IAU_CSV.exists(),
                               reason="IAU gazetteer CSV not cached (git-ignored, ~/hl-data)")


def doc() -> dict:
    return json.loads(LABELS.read_text())


def by_code() -> dict[str, dict]:
    return {lb["code"]: lb for lb in doc()["labels"]}


def pub(name: str):
    return json.loads((PUBLIC / name).read_text())


# ------------------------------------------------------------------------------------ contract

def test_committed_file_is_schema_valid_and_codes_unique():
    d = doc()
    errors = list(Draft202012Validator(json.loads(SCHEMA.read_text())).iter_errors(d))
    assert errors == []
    codes = [lb["code"] for lb in d["labels"]]
    assert len(codes) == len(set(codes))
    assert "dummy" not in d or d["dummy"] is False


def test_priority_and_minzoom_from_config():
    kinds = [k for k in DESIGN["priority"] if k != "selected"]
    for lb in doc()["labels"]:
        assert lb["priority"] == kinds.index(lb["kind"]) + 1, lb["code"]
        assert lb["minzoom"] == DESIGN["minzoom"][L.MINZOOM_KEY.get(lb["kind"], lb["kind"])]
        assert lb["status"] is None or lb["kind"] == "landmark"


def test_sorted_by_priority_then_order():
    labels = doc()["labels"]
    assert [lb["priority"] for lb in labels] == sorted(lb["priority"] for lb in labels)


# ------------------------------------------------------------------------------- pad + stations

def test_pad_equals_pad_json_exactly():
    pad = pub("pad.json")["pad"]
    lb = by_code()["PAD"]
    assert (lb["lon"], lb["lat"]) == (pad["lon"], pad["lat"])
    assert lb["kind"] == "pad" and lb["ref"] == "pad.json" and lb["status"] is None


def test_parking_options_equal_pads_index():
    idx = pub("scenarios/pads/index.json")
    picker = [p for p in idx["pads"] if p.get("picker") and not p.get("official")]
    assert picker, "D21 picker pads expected in scenarios/pads/index.json"
    labels = by_code()
    for p in picker:
        lb = labels[f"P{p['rank']}"]
        assert (lb["lon"], lb["lat"]) == (p["lon"], p["lat"])
        assert lb["kind"] == "pad" and lb["ref"] == f"scenarios/pads/index.json#{p['id']}"
    assert {c for c, lb in labels.items() if lb["kind"] == "pad"} == \
        {"PAD"} | {f"P{p['rank']}" for p in picker}


def test_every_station_equals_stations_json():
    stations = pub("stations.json")
    labels = by_code()
    for s in stations:
        lb = labels[s["id"]]
        assert (lb["lon"], lb["lat"]) == (s["lon"], s["lat"]), s["id"]
        assert lb["name"] == s["name"]
        assert lb["ref"] == f"stations.json#{s['id']}"
    station_kinds = {"route_station", "station", "scored_site"}
    assert {c for c, lb in labels.items() if lb["kind"] in station_kinds} == \
        {s["id"] for s in stations}


def test_route_stations_are_the_official_plan_stops():
    idx = pub("scenarios/index.json")
    route = pub(f"route_{idx['default']}.geojson")
    stops = [f["properties"]["to"] for f in route["features"]
             if f["properties"]["to"] != "pad"]
    official = next(p for p in pub("scenarios/pads/index.json")["pads"] if p.get("official"))
    assert stops == official["route"]["stops"]
    labels = doc()["labels"]
    assert [lb["code"] for lb in labels if lb["kind"] == "route_station"] == stops
    scored = set(yaml.safe_load((REPO / "config/stations.yaml").read_text())["extras"]["ids"])
    for lb in labels:
        if lb["kind"] in ("station", "scored_site"):
            assert (lb["kind"] == "scored_site") == (lb["code"] in scored), lb["code"]


# ----------------------------------------------------------------------------------- landmarks

def test_landmarks_only_from_config_names():
    cfg = yaml.safe_load((REPO / "config" / "landmarks.yaml").read_text())
    names = {c["name"] for c in cfg["candidates"]}
    for lb in doc()["labels"]:
        if lb["kind"] == "landmark":
            assert lb["name"] in names
            assert lb["ref"] == "landmarks.yaml"
            assert lb["status"] == "official"  # only IAU-verified coordinates exist (D33)
            assert lb["code"] == L.LANDMARK_CODES[lb["name"]]


@needs_iau
def test_every_landmark_coordinate_equals_iau_csv():
    rows = {}
    with open(IAU_CSV, newline="") as fh:
        for r in csv.DictReader(fh):
            if r["approval"] == "Adopted by IAU":
                lo = float(r["center_lon"])
                rows[r["clean_name"]] = (round(lo - 360.0 if lo > 180.0 else lo, 6),
                                         round(float(r["center_lat"]), 6))
    lms = [lb for lb in doc()["labels"] if lb["kind"] == "landmark"]
    assert lms, "expected at least one verified landmark"
    for lb in lms:
        iau = L.iau_name(lb["name"])
        assert (lb["lon"], lb["lat"]) == rows[iau], lb["name"]


@needs_iau
def test_unverified_landmarks_are_skipped_and_logged():
    logs: list[str] = []
    d = L.build(PUBLIC, IAU_CSV, log=logs.append)
    present = {lb["name"] for lb in d["labels"] if lb["kind"] == "landmark"}
    cfg = yaml.safe_load((REPO / "config" / "landmarks.yaml").read_text())
    for c in cfg["candidates"]:
        if c["name"] not in present:
            assert any(c["name"] in m and "skip" in m for m in logs), c["name"]


# ------------------------------------------------------------------- determinism + no literals

@needs_iau
def test_build_matches_committed_file_and_is_deterministic(tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    L.write(L.build(PUBLIC, IAU_CSV, log=lambda m: None), a)
    L.write(L.build(PUBLIC, IAU_CSV, log=lambda m: None), b)
    assert a.read_bytes() == b.read_bytes()
    assert a.read_bytes() == LABELS.read_bytes()


def test_no_timestamps_in_output():
    d = doc()
    assert set(d) <= {"version", "labels", "dummy"}
    assert not re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", LABELS.read_text())
    allowed = set(json.loads(SCHEMA.read_text())["properties"]["labels"]["items"]["properties"])
    for lb in d["labels"]:
        assert set(lb) <= allowed


def test_no_hand_typed_coordinates_in_exporter():
    src = Path(L.__file__).read_text()
    floats = [n.value for n in ast.walk(ast.parse(src))
              if isinstance(n, ast.Constant) and isinstance(n.value, float)]
    assert floats == [], f"float literals in labels.py: {floats}"
    ints = [n.value for n in ast.walk(ast.parse(src))
            if isinstance(n, ast.Constant) and type(n.value) is int]
    assert not [v for v in ints if 90 < abs(v) <= 180], f"lon-like int literals: {ints}"
