"""F8 siting and F11 trade-table logic on synthetic grids.

Rule values from site.yaml ``siting`` (block 20 m, max slope 5 deg, F8).
"""

import numpy as np
import pytest

from pipeline.engine import dijkstra, physio, siting, trade
from pipeline.engine.config import load
from pipeline.engine.geo import validate
from pipeline.engine.synthetic import make_grid, plane

RES = 3.0
BLOCK = load("site")["siting"]["block_m"]
MAX_SLOPE = load("site")["siting"]["max_slope_deg"]
P_CON = physio.params("conservative", suit_kg=104, v1_rmse_deg=1.0)  # RMSE stub (WS6)
TAB = physio.grade_table(P_CON)


@pytest.fixture(scope="module")
def world():
    z = plane(201, RES, 0.02)  # gentle 2 % rise to the north
    z[:, 150:] += np.linspace(0, 60, 51)[None, :]  # steep eastern strip (> 5 deg)
    g = make_grid(z, RES)
    stations = [(60, 60), (60, 120), (150, 90)]
    values = [1.0, 0.5, 0.5]
    t = [dijkstra.forward_field(g, TAB, s).t_min for s in stations]
    return g, stations, values, t


def test_candidates_exclude_steep(world):
    g, *_ = world
    b = siting.blocks(g, BLOCK, MAX_SLOPE)
    steep_cells = g.maxslope > MAX_SLOPE
    bad_blocks = np.unique(b.label[steep_cells & (b.label >= 0)])
    assert not b.candidate[bad_blocks].any()
    assert b.candidate.sum() > 50


def test_score_matches_direct(world):
    g, stations, values, t = world
    b = siting.blocks(g, BLOCK, MAX_SLOPE)
    s = siting.score(b, t, values, 3.0)
    for i in np.flatnonzero(b.candidate)[::17]:
        r, c = b.rep[i]
        direct = sum(v for tt, v in zip(t, values, strict=True) if tt[r, c] <= 3.0)
        assert s[i] == pytest.approx(direct)
    assert np.isnan(s[~b.candidate]).all()


def test_rank_prefers_value_then_lower(world):
    g, stations, values, t = world
    b = siting.blocks(g, BLOCK, MAX_SLOPE)
    s = siting.score(b, t, values, 3.0)
    elev = [g.elev[rc] for rc in stations]
    order = siting.rank(b, s, values, elev)
    assert s[order[0]] == np.nanmax(s)
    tied = order[s[order] == s[order[0]]]
    assert np.all(np.diff(b.elev[tied]) >= -1e-9)  # lower first among equal scores
    hm = siting.heatmap(b, s)
    assert hm.shape == g.shape and np.nanmax(hm) == np.nanmax(s)


def test_trade_table_contract():
    rows, cols = [30, 60], [80, 104, 120]
    cells = {(b, m): {"science_value": 1.0 + b / 60 - m / 200, "reachable_pct": 50.0,
                      "partner_area_km2": None} for b in rows for m in cols}  # fmt: skip
    tt = trade.table(rows, cols, cells)
    validate(tt, "trade_table.schema.json")
    assert tt["cells"][1][0]["science_value"] == pytest.approx(1 + 1 - 0.4)


def test_science_within_homeline():
    t_home_at_station = {"S1": 12.0, "S2": 31.0, "S3": 59.0, "S4": float("inf")}
    values = {"S1": 0.7, "S2": 0.5, "S3": 0.9, "S4": 1.0}
    assert trade.science_value(t_home_at_station, values, 30) == pytest.approx(0.7)
    assert trade.science_value(t_home_at_station, values, 60) == pytest.approx(2.1)


def test_rule_from_config():
    r = siting.rule_from_config()
    assert r.variant == "conservative" and r.budget_min == 30 and r.top_k == 3
    assert r.block_m == BLOCK and r.max_slope_deg == MAX_SLOPE


def test_proposal_block_contract_and_hop(world):
    g, stations, values, t = world
    rule = siting.rule_from_config()
    b = siting.blocks(g, BLOCK, MAX_SLOPE)
    s = siting.score(b, t, values, 3.0)
    order = siting.rank(b, s, values, [g.elev[rc] for rc in stations])
    cov = siting.coverage(b, t, 3.0)
    hop = siting.best_hop(b, cov, values, int(order[0]))
    prop = siting.proposal_block(g, b, s, order, rule, 100.0, 90, hop)
    pad = siting.pad_in_use(g, t, values, rule, 137.382, -4.806, "test", 100.0, 90)
    doc = siting.pad_file(pad, prop, rule)
    validate(doc, "pad.schema.json")
    assert doc["dummy"] is False
    assert prop["adopted"] is False
    alts = prop["alternatives"]
    assert alts[0]["rank"] == 1 and len(alts) == rule.top_k
    assert prop["pad"]["checks"]["max_slope_deg"] <= MAX_SLOPE
    assert prop["pad"]["checks"]["assessed_pct_30min"] == 100.0
    assert prop["pad"]["checks"]["rule_passed"] is True
    if hop is not None:
        assert hop[1] > prop["pad"]["score"]
        assert len(prop["hop_options"][0]["pads"]) == 2


def test_hop_adds_value_on_split_stations():
    """Two station clusters too far apart for one pad: the hop covers the other cluster."""
    z = plane(201, RES, 0.0)
    g = make_grid(z, RES)
    stations = [(30, 30), (170, 170)]
    t = [dijkstra.forward_field(g, TAB, rc).t_min for rc in stations]
    b = siting.blocks(g, BLOCK, MAX_SLOPE)
    budget = 3.0  # ~170 m: no block reaches both stations (~590 m apart)
    s = siting.score(b, t, [1.0, 0.8], budget)
    order = siting.rank(b, s, [1.0, 0.8], [0.0, 0.0])
    assert s[order[0]] == 1.0
    hop = siting.best_hop(b, siting.coverage(b, t, budget), [1.0, 0.8], int(order[0]))
    assert hop is not None and hop[1] == pytest.approx(1.8)


# ------------------------------------------------- pad.json: pad in use vs proposal (C 14:58)
# KATs: the top-level pad is config/site.yaml pad_default (user 11:24); the F8 siting result is
# only ever a proposal (adopted: false); the file validates against contracts/pad.schema.json.

PAD_RES = 10.0  # 401 x 401 cells = 4 km: the 30-min disc (1,764 m) fits around the centre pad


@pytest.fixture(scope="module")
def pad_world():
    from pipeline.engine.synthetic import pad_xy

    n, half = 401, 401 * PAD_RES / 2
    px, py = pad_xy()
    g = make_grid(plane(n, PAD_RES, -0.02), PAD_RES, x0=px - half, y0=py + half)  # rises south
    # stations near the (lower) north edge, ~1.7 km from the pad: the proposal (ties go to the
    # lower block) lands up there and its 30-min disc leaves the grid (null check with a
    # reason); the pad's own disc fits.
    st = [{"id": "S1", "rc": (25, 180), "value": 0.6}, {"id": "S2", "rc": (30, 230), "value": 0.4}]
    return g, st


@pytest.fixture
def pad_run(pad_world, tmp_path, monkeypatch):
    from pipeline.engine import provenance

    monkeypatch.setenv(provenance.FRAGMENT_DIR_ENV, str(tmp_path / "manifest"))
    g, st = pad_world
    doc = siting.run(g, st, 1.0, tmp_path / "engine", tmp_path / "public",
                     no_access={"S3": "no access cell"})  # fmt: skip
    return g, st, doc, tmp_path


def test_pad_json_pad_is_pad_default(pad_run):
    import json

    g, st, doc, tmp = pad_run
    cfg = load("site")["pad_default"]
    assert (doc["pad"]["lon"], doc["pad"]["lat"]) == (cfg["lon"], cfg["lat"])
    assert "pad_default" in doc["pad"]["source"]
    assert json.loads((tmp / "public/pad.json").read_text()) == doc
    # the pad's score and checks are the F8 rule evaluated at pad_default
    rule = siting.rule_from_config()
    from pipeline.engine.geo import xy_of_lonlat

    rc = g.rc_of_xy(*xy_of_lonlat(cfg["lon"], cfg["lat"], g.crs))
    p = physio.params(rule.variant, suit_kg=load("crew")["default_suit_kg"], v1_rmse_deg=1.0)
    tab = physio.grade_table(p)
    gv = g.with_nogo(p.nogo_deg)
    tt = [dijkstra.forward_field(gv, tab, s["rc"]).t_min[rc] for s in st]
    direct = sum(s["value"] for s, x in zip(st, tt, strict=True) if x <= rule.budget_min)
    assert doc["pad"]["score"] == pytest.approx(direct)
    assert doc["pad"]["elev_m"] == pytest.approx(round(float(g.elev[rc]), 1))
    assert doc["pad"]["checks"]["assessed_pct_30min"] == 100.0  # disc fits, all assessed
    assert doc["pad"]["checks"]["max_slope_deg"] <= MAX_SLOPE
    assert doc["pad"]["checks"]["rule_passed"] is True
    # the pad in use carries no siting alternatives or hops of its own
    assert doc["alternatives"] == [] and doc["hop_options"] == []


def test_pad_json_proposal_never_adopted(pad_run):
    g, st, doc, _ = pad_run
    prop = doc["proposal"]
    assert prop["adopted"] is False
    assert "pad_default is kept; S decides" in prop["note"]
    assert (prop["pad"]["lon"], prop["pad"]["lat"]) != (doc["pad"]["lon"], doc["pad"]["lat"])
    assert (prop["alternatives"][0]["lon"], prop["alternatives"][0]["lat"]) == (
        prop["pad"]["lon"], prop["pad"]["lat"])  # fmt: skip
    assert prop["pad"]["score"] > doc["pad"]["score"]
    assert prop["site_rule_version"] == doc["site_rule_version"]
    # tie information: how many candidate blocks share the top score, and the tiebreak used
    tie = prop["tie"]
    top = prop["pad"]["score"]
    assert tie["top_score"] == top
    assert tie["n_blocks_at_top_score"] >= sum(a["score"] == top for a in prop["alternatives"])
    assert tie["n_candidate_blocks"] >= tie["n_blocks_at_top_score"] >= 1
    assert "lower elevation" in tie["tiebreak"]
    assert prop["stations"] == ["S1", "S2"] and prop["no_access"] == {"S3": "no access cell"}
    # null disc check comes with its reason
    assert prop["pad"]["checks"]["assessed_pct_30min"] is None
    assert prop["pad"]["checks"]["rule_passed"] is None
    assert "leaves the" in prop["checks_note"] and "routing grid" in prop["checks_note"]


def test_pad_json_validates_and_contract_refuses_adoption(pad_run):
    import copy

    import jsonschema

    _, _, doc, _ = pad_run
    validate(doc, "pad.schema.json")
    bad = copy.deepcopy(doc)
    bad["proposal"]["adopted"] = True
    with pytest.raises(jsonschema.ValidationError):
        validate(bad, "pad.schema.json")


def test_pad_json_manifest_keys(pad_run):
    from pipeline.engine import provenance

    _, _, doc, tmp = pad_run
    m = provenance.load_all(tmp / "manifest")
    pad_keys = {k: v for k, v in m.items() if k.startswith("pad.")}
    assert all(v["file"] == "pad.json" for v in pad_keys.values())
    assert m["pad.lon"]["value"] == doc["pad"]["lon"] and m["pad.lat"]["value"] == doc["pad"]["lat"]
    assert m["pad.score"]["value"] == doc["pad"]["score"]
    assert m["pad.checks.assessed_pct_30min"]["value"] == 100.0
    p = doc["proposal"]["pad"]
    assert m["pad.proposal.lon"]["value"] == p["lon"] and m["pad.proposal.lat"]["value"] == p["lat"]
    assert m["pad.proposal.score"]["value"] == p["score"]
    assert m["pad.proposal.checks.max_slope_deg"]["value"] == p["checks"]["max_slope_deg"]
    assert "pad.proposal.checks.assessed_pct_30min" not in m  # null stays unrecorded
    # the proposal's numbers never sit under a pad-in-use key
    in_use = [k for k in pad_keys if not k.startswith("pad.proposal.")]
    assert not any(m[k]["value"] in (p["lon"], p["lat"]) for k in in_use)
    assert m["file.pad.json"]["file"] == "pad.json"
