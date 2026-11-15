"""KATs for ``scenarios --stations-only`` (D44 same-name suffix): only the station-name fields of
the published files change; geometry, times and margins stay byte-identical; a moved station is
refused (full re-run needed). Hand-made published trees, no grids needed."""

import json

import pytest

from pipeline.engine import provenance, scenarios, stations

BASE = "dense ridge network + high SINDEX2 sulfate signal"


@pytest.fixture(autouse=True)
def manifest_dir(tmp_path, monkeypatch):
    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "manifest"))
    return tmp_path / "manifest"


def _ws1(renamed: bool) -> dict:
    rows = [
        {"id": "S1", "name": "Boxwork ridge-hollow transect", "lon": 137.379249, "lat": -4.80832,
         "value": 1.18, "dwell_min": 30},
        {"id": "S6", "name": BASE, "lon": 137.383481, "lat": -4.788919, "value": 0.7128,
         "dwell_min": 30},
        {"id": "S7", "name": BASE, "lon": 137.373323, "lat": -4.789762, "value": 0.6986,
         "dwell_min": 30},
    ]  # fmt: skip
    if renamed:
        for s, rank, b, d in ((rows[1], "nearer", 237.9, 1276.0), (rows[2], "farther", 246.6,
                                                                    1831.9)):  # fmt: skip
            s["name"] = f"{BASE} (south-west, {rank})"
            s["name_base"] = BASE
            s["name_suffix"] = {"compass": "south-west", "bearing_deg": b, "distance_m": d,
                                "distance_rank": rank}  # fmt: skip
    return {"note": "WS1", "same_name_suffix": {"rule": "D44"} if renamed else None,
            "stations": rows}  # fmt: skip


def _published(ws1: dict) -> list[dict]:
    out = []
    for i, s in enumerate(ws1["stations"]):
        out.append({"id": s["id"], "name": s["name"], "lon": s["lon"], "lat": s["lat"],
                    "value": s["value"], "objective": "", "tasks": [], "dwell_min": 30,
                    "t_home_min": {"nom_104": 40.0 + i, "con_104": None},
                    "in_partner_line": False, "card": f"cards/{s['id']}.json",
                    "access_radius_m": 50.0, "access_lon": s["lon"] + 1e-5,
                    "access_lat": s["lat"], "access_dist_m": 1.5 * i, "access_reason": None,
                    "access": {"nom_104": {"lon": s["lon"], "lat": s["lat"], "dist_m": 0.0}},
                    "reachable_on_foot": True, "reachability_label": None})  # fmt: skip
    return out


def _tree(tmp_path, card_with_name: bool = False):
    terr, pub = tmp_path / "terrain", tmp_path / "engine" / "public"
    terr.mkdir()
    (terr / "stations.json").write_text(json.dumps(_ws1(renamed=True)))
    old = _ws1(renamed=False)
    pub.mkdir(parents=True)
    (pub / "stations.json").write_text(json.dumps(_published(old), separators=(",", ":")))
    (pub / "cards").mkdir()
    for s in old["stations"]:
        card = {"station": s["id"], "scenario": "nom_104", "on_route": True,
                "timeline": {"arrive": 10.25, "leave": 40.25, "turn_back": 300.5},
                "margin_binding": "dose", "margin_min": 74.95, "t_home_min": 41.23,
                "science": {"lon": s["lon"], "lat": s["lat"]}}  # fmt: skip
        if card_with_name:
            card["name"] = s["name"]
        (pub / "cards" / f"{s['id']}.timeline.json").write_text(json.dumps(card))
    pads = pub / "scenarios" / "pads" / "rank2"
    pads.mkdir(parents=True)
    (pads / "summary.json").write_text(json.dumps({"id": "rank2", "score": 38,
                                                   "headline": {"30": {"reachable_pct": 21.5}}}))
    (pub / "timeline_nom_104.json").write_text(json.dumps(
        {"rows": [{"t_min": 0.0, "event": "depart"}, {"t_min": 128.49, "station": "S6",
                                                      "margin_min": 74.95}]}))  # fmt: skip
    (pub / "route_nom_104.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "features": [{"type": "Feature", "properties":
         {"leg": 1, "from": "pad", "to": "S7"}, "geometry": {"type": "LineString",
                                                            "coordinates": [[1, 2], [3, 4]]}}]}))
    return terr, pub


def _snapshot(pub):
    return {p.relative_to(pub).as_posix(): p.read_bytes() for p in pub.rglob("*") if p.is_file()}


NAME_KEYS = {"name", "name_base", "name_suffix"}


def test_stations_only_changes_only_the_names(tmp_path, manifest_dir):
    terr, pub = _tree(tmp_path)
    before = _snapshot(pub)
    old = json.loads((pub / "stations.json").read_text())
    assert scenarios.stations_names_patch(terr, pub) == 0
    after = _snapshot(pub)
    # every other file is byte-identical (geometry, times, margins, picker summaries)
    assert set(after) == set(before)
    for rel in before:
        if rel != "stations.json":
            assert after[rel] == before[rel], rel
    new = json.loads((pub / "stations.json").read_text())
    ws1 = {s["id"]: s for s in _ws1(renamed=True)["stations"]}
    assert [r["id"] for r in new] == [r["id"] for r in old]
    for o, n in zip(old, new, strict=True):
        assert {k: v for k, v in n.items() if k not in NAME_KEYS} == \
               {k: v for k, v in o.items() if k not in NAME_KEYS}  # fmt: skip
        assert n["name"] == ws1[n["id"]]["name"]
        for k in ("name_base", "name_suffix"):
            assert n.get(k) == ws1[n["id"]].get(k)
            assert (k in n) == (k in ws1[n["id"]])
        # name fields sit where the name was; the rest keeps its order
        keys = [k for k in n if k not in NAME_KEYS]
        assert keys == [k for k in o if k not in NAME_KEYS]
        assert list(n)[1] == "name"
    assert new[1]["name"] == f"{BASE} (south-west, nearer)"
    assert new[2]["name_suffix"]["distance_rank"] == "farther"
    assert new[0]["name"] == "Boxwork ridge-hollow transect" and "name_base" not in new[0]
    # same compact serialisation as the full run (write_json)
    assert after["stations.json"] == json.dumps(new, separators=(",", ":")).encode()
    # file-level manifest key re-recorded for the rewritten file only
    frag = provenance.load_all(manifest_dir)
    assert "file.stations.json" in frag
    assert not any(k.startswith("file.cards/") for k in frag)


def test_stations_only_is_idempotent(tmp_path):
    terr, pub = _tree(tmp_path)
    assert scenarios.stations_names_patch(terr, pub) == 0
    once = _snapshot(pub)
    assert scenarios.stations_names_patch(terr, pub) == 0
    assert _snapshot(pub) == once


def test_stations_only_renames_cards_that_carry_names(tmp_path):
    terr, pub = _tree(tmp_path, card_with_name=True)
    before = json.loads((pub / "cards" / "S6.timeline.json").read_text())
    assert scenarios.stations_names_patch(terr, pub) == 0
    card = json.loads((pub / "cards" / "S6.timeline.json").read_text())
    assert card["name"] == f"{BASE} (south-west, nearer)"
    assert card["name_base"] == BASE
    assert {k: v for k, v in card.items() if k not in NAME_KEYS} == \
           {k: v for k, v in before.items() if k not in NAME_KEYS}  # fmt: skip
    s1 = json.loads((pub / "cards" / "S1.timeline.json").read_text())
    assert "name_base" not in s1


@pytest.mark.parametrize("field,delta", [("lon", 1e-5), ("lat", -2e-6)])
def test_stations_only_refuses_moved_station(tmp_path, capsys, field, delta):
    terr, pub = _tree(tmp_path)
    doc = json.loads((terr / "stations.json").read_text())
    doc["stations"][2][field] = round(doc["stations"][2][field] + delta, 6)
    (terr / "stations.json").write_text(json.dumps(doc))
    before = _snapshot(pub)
    assert scenarios.stations_names_patch(terr, pub) != 0
    assert _snapshot(pub) == before
    msg = capsys.readouterr().out
    assert "S7" in msg and "full re-run" in msg


def test_stations_only_refuses_card_coordinates_mismatch(tmp_path, capsys):
    terr, pub = _tree(tmp_path)
    p = pub / "cards" / "S6.timeline.json"
    card = json.loads(p.read_text())
    card["science"]["lon"] += 1e-4
    p.write_text(json.dumps(card))
    before = _snapshot(pub)
    assert scenarios.stations_names_patch(terr, pub) != 0
    assert _snapshot(pub) == before
    assert "full re-run" in capsys.readouterr().out


@pytest.mark.parametrize("change", ["add", "drop", "value", "dwell"])
def test_stations_only_refuses_other_route_inputs(tmp_path, capsys, change):
    terr, pub = _tree(tmp_path)
    doc = json.loads((terr / "stations.json").read_text())
    if change == "add":
        doc["stations"].append({"id": "S9", "name": "x", "lon": 137.39, "lat": -4.78,
                                "value": 0.6, "dwell_min": 30})  # fmt: skip
    elif change == "drop":
        doc["stations"].pop(0)
    elif change == "value":
        doc["stations"][0]["value"] = 1.19
    else:
        doc["stations"][0]["dwell_min"] = 45
    (terr / "stations.json").write_text(json.dumps(doc))
    before = _snapshot(pub)
    assert scenarios.stations_names_patch(terr, pub) != 0
    assert _snapshot(pub) == before
    assert "full re-run" in capsys.readouterr().out


def test_station_records_carry_name_fields():
    """Full run and the light mode agree: station_records passes name_base/name_suffix
    through after name, only where WS1 has them."""
    ws1 = _ws1(renamed=True)["stations"]
    for s in ws1:
        s["rc"] = (0, 0)
    import numpy as np

    from pipeline.engine.dijkstra import Field

    z = np.zeros((1, 1))
    f = Field(t_min=z, o2_l=z, ptr=z.astype(np.int8), seeds=np.zeros((1, 2), int), reverse=True)
    recs = stations.station_records(ws1, {"nom_104": f}, None, 60.0)
    assert list(recs[1])[:4] == ["id", "name", "name_base", "name_suffix"]
    assert recs[1]["name_suffix"] == ws1[1]["name_suffix"]
    assert "name_base" not in recs[0] and "name_suffix" not in recs[0]


def test_cli_stations_only_needs_no_grids(tmp_path):
    terr, pub = _tree(tmp_path)
    assert scenarios.main(["--terrain", str(terr), "--out", str(pub.parent),
                           "--stations-only"]) == 0  # fmt: skip
    new = json.loads((pub / "stations.json").read_text())
    assert new[2]["name"] == f"{BASE} (south-west, farther)"
