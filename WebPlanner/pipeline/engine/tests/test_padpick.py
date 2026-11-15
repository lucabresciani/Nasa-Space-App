"""D21 KATs: tiebreak order, official pad = top-ranked candidate, picker selection, screening
counts on a synthetic grid against per-candidate runs, the 30-min disc grid filter."""

import numpy as np
import pytest

from pipeline.engine import dijkstra, orienteering, padpick, physio
from pipeline.engine.padpick import PAD_DEFAULT, Candidate
from pipeline.engine.synthetic import make_grid


def _c(cid, score, tb1, elev, kind="block", srank=None):
    return Candidate(cid, kind, (0, 0), 0.0, 0.0, elev, score=score, tb1=tb1,
                     screen_score=score, screen_rank=srank)


def test_tiebreak_order():
    cs = [
        _c("a", 3, 10.0, -3800.0),
        _c("b", 4, 5.0, -3700.0),  # most feasible EVAs wins whatever the tiebreaks
        _c("c", 3, 12.0, -3700.0),  # tie on score -> higher reachable % wins
        _c("d", 3, 12.0, -3750.0),  # tie on score and % -> lower elevation wins
        _c("e", 3, None, -3900.0),  # unknown tiebreak 1 goes after known ones
    ]
    assert [c.id for c in padpick.order(cs)] == ["b", "d", "c", "a", "e"]


def test_official_is_top_ranked_and_ranks_follow_full_scores():
    # screening order a, b, c, d, e (top 5) + pad_default at screening rank 9
    cs = [_c(x, 7, 10.0 + k, -3800.0, srank=k + 1) for k, x in enumerate("abcde")]
    pd = _c(PAD_DEFAULT, 5, 9.0, -3600.0, kind=PAD_DEFAULT, srank=9)
    # full runs: the margin check drops subsets for a and b
    cs[0].score, cs[1].score = 5, 6
    ranked = padpick.final_ranking(cs + [pd], top_n=5)
    assert [c.id for c in ranked] == ["e", "d", "c", "b", "a", PAD_DEFAULT]
    assert [c.rank for c in ranked] == [1, 2, 3, 4, 5, 6]
    assert ranked[0].rank == 1 and ranked[0].key() == min(c.key() for c in ranked[:5])
    # pad_default outside the top 5 can never be official even with a higher full score
    pd.score = 99
    assert padpick.final_ranking(cs + [pd], top_n=5)[0].id == "e"


def test_picker_excludes_official_and_adds_pad_default():
    cs = [_c(x, 7, 10.0 - k, -3800.0, srank=k + 1) for k, x in enumerate("abcde")]
    pd = _c(PAD_DEFAULT, 5, 9.0, -3600.0, kind=PAD_DEFAULT, srank=40)
    ranked = padpick.final_ranking(cs + [pd], top_n=5)
    pick = padpick.picker(ranked, 3)
    assert [c.id for c in pick] == ["b", "c", "d", PAD_DEFAULT]
    assert ranked[0] not in pick
    assert [padpick.pad_id(c) for c in pick] == ["rank2", "rank3", "rank4", PAD_DEFAULT]


def test_picker_pad_default_inside_next3_not_duplicated():
    cs = [_c(x, 7, 10.0 - k, -3800.0, srank=k + 1) for k, x in enumerate("abde")]
    pd = _c(PAD_DEFAULT, 7, 8.5, -3600.0, kind=PAD_DEFAULT, srank=3)
    ranked = padpick.final_ranking(cs + [pd], top_n=5)
    pick = padpick.picker(ranked, 3)
    assert [c.id for c in pick].count(PAD_DEFAULT) == 1
    assert len(pick) == 3


def test_picker_pad_default_official_is_excluded():
    pd = _c(PAD_DEFAULT, 9, 50.0, -3600.0, kind=PAD_DEFAULT, srank=1)
    cs = [_c(x, 7, 10.0 - k, -3800.0, srank=k + 2) for k, x in enumerate("abcd")]
    ranked = padpick.final_ranking([pd] + cs, top_n=5)
    assert ranked[0].id == PAD_DEFAULT
    pick = padpick.picker(ranked, 3)
    assert PAD_DEFAULT not in [c.id for c in pick] and len(pick) == 3


def test_disc_in_grid():
    assert padpick.disc_in_grid((1200, 1200), (600, 600), 1764.0, 3.0)
    assert not padpick.disc_in_grid((1200, 1200), (580, 600), 1764.0, 3.0)  # 588 cells needed
    assert padpick.disc_in_grid((1177, 1177), (588, 588), 1764.0, 3.0)
    assert not padpick.disc_in_grid((1176, 1177), (588, 588), 1764.0, 3.0)


def _world():
    """A 3 m bowl with a sealed pocket (a ring wall) around station P's nearest cells."""
    n = 161
    yy, xx = np.mgrid[0:n, 0:n]
    elev = 0.002 * ((xx - 80.0) ** 2 + (yy - 80.0) ** 2)  # gentle bowl
    cs = np.zeros((n, n), np.uint8)
    ring = (np.hypot(yy - 40, xx - 120) >= 3) & (np.hypot(yy - 40, xx - 120) < 4.5)
    cs[ring] = 1  # blocked ring: cells inside are assessed but sealed off
    ms = np.zeros((n, n))
    ms[ring] = 60.0
    return make_grid(elev, 3.0, cellstate=cs, maxslope=ms)


def test_screening_matches_per_candidate_runs():
    g = _world()
    p = physio.scenario_params("nom_104")
    gv = g.with_nogo(p.nogo_deg)
    tab = physio.grade_table(p)
    st = []
    for sid, (r, c) in (("A", (40, 120)), ("B", (120, 40)), ("C", (80, 140))):
        x, y = g.xy_of_rc(r, c)
        from pipeline.engine.geo import lonlat_of_xy

        lon, lat = lonlat_of_xy(float(x), float(y), g.crs)
        st.append({"id": sid, "lon": lon, "lat": lat, "dwell_min": 30, "rc": (r, c)})
    cands = [Candidate(f"p{k}", "block", rc, 0, 0, float(g.elev[rc]))
             for k, rc in enumerate([(80, 80), (60, 60), (100, 90), (40, 125), (150, 150)])]
    acc = [padpick.station_access(gv, tab, s, cands, 30.0) for s in st]
    # A's science cell is inside the sealed ring: its access cell is outside, and the pad at
    # (40, 125) (inside the ring? no: distance 5 -> outside the ring) is reached normally
    assert acc[0].runs and acc[0].runs[0].cell != (40, 120)
    assert acc[0].n_runs >= 2  # the sealed pocket cost a run that reached no pad
    t_from, t_to, t_leg = padpick.matrices(acc, cands)
    counts = padpick.screen_counts(t_from, t_to, t_leg, 30.0, 390.0)
    # reference: per-candidate return/forward fields with access.find semantics
    from pipeline.engine import access

    for k, cand in enumerate(cands):
        home = dijkstra.return_field(gv, tab, cand.rc)
        fpad = dijkstra.forward_field(gv, tab, cand.rc)
        cells = []
        for i, s in enumerate(st):
            a = access.find(gv, home, s["lon"], s["lat"], 30.0)
            j = acc[i].assign[k]
            if a.rc is None:
                assert j < 0 and not np.isfinite(t_to[k, i])
                cells.append(None)
                continue
            run = acc[i].runs[j]
            # same access distance (equal-distance ties may pick a different cell: access.find
            # breaks them by T_home, the screening by row/col)
            assert run.dist_m == pytest.approx(a.dist_m, abs=1e-6)
            cells.append(run.cell)
            assert t_to[k, i] == pytest.approx(home.t_min[run.cell], rel=1e-5)
            assert t_from[k, i] == pytest.approx(fpad.t_min[run.cell], rel=1e-5)
        ref_leg = np.full((3, 3), np.inf)
        for i, ci in enumerate(cells):
            if ci is None:
                continue
            fi = dijkstra.forward_field(gv, tab, ci)
            for j, cj in enumerate(cells):
                if j != i and cj is not None:
                    ref_leg[i, j] = fi.t_min[cj]
        np.testing.assert_allclose(t_leg[k], ref_leg, rtol=1e-5)
        ref = orienteering.feasible_subsets(30.0, t_from[k], t_to[k], ref_leg, 390.0)
        assert counts[k] == len(ref)
    assert counts.max() == 7  # all 3 stations fit in 6.5 h on this small world


def test_tb1_bounded_equals_full_field():
    g = _world()
    p = physio.scenario_params("nom_104")
    gv, tab = g.with_nogo(p.nogo_deg), physio.grade_table(p)
    s = padpick.Settings("nom_104", 390.0, 5, 3, 30.0, 30.0, 0.98, 50.0)
    s_small = padpick.Settings("nom_104", 390.0, 5, 3, 2.0, 2.0, 0.98, 50.0)
    rc = (80, 80)
    full = dijkstra.return_field(gv, tab, rc)
    from pipeline.engine import envelope

    assert padpick.tb1_bounded(gv, g, tab, rc, s_small) == pytest.approx(
        envelope.reachable_pct(g, full.t_min, rc, 2.0, 0.98))
    assert padpick.tb1_bounded(gv, g, tab, rc, s) is None  # 1,764 m disc leaves this grid


def test_d22_passability_uses_plane_slope_and_step_guard():
    """D22: passable iff not unknown, plane-fit slope <= no-go, step guard off; the max 1 m
    slope (rough footing) no longer blocks."""
    from pipeline.engine.graph import passable_mask

    cs = np.array([[0, 0, 0, 2]], np.uint8)
    slope = np.array([[10.0, 19.0, 10.0, 5.0]])
    maxslope = np.array([[28.0, 19.0, 10.0, 5.0]])  # rough footing only
    step = np.array([[False, False, True, False]])
    ok = passable_mask(cs, slope, 20.0, None, step)
    assert ok.tolist() == [[True, True, False, False]]
    g = make_grid(np.zeros((1, 4)), cellstate=cs, maxslope=maxslope)
    g.slope, g.stepguard = slope, step
    assert g.with_nogo(20.0).passable.tolist() == [[True, True, False, False]]
    assert g.with_nogo(17.0).passable.tolist() == [[True, False, False, False]]  # D23
