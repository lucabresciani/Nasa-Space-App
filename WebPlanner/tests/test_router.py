"""Router known-answer tests on synthetic grids (SPEC F4, §9; brief WS2 "Tests")."""

import math

import numpy as np
import pytest

from pipeline.engine import dijkstra, physio
from pipeline.engine.graph import BLOCKED, OFFSETS, UNIT_LENGTH, UNKNOWN
from pipeline.engine.synthetic import make_grid, plane

RES = 3.0
N = 201
C = N // 2
P_NOM = physio.params("nominal", suit_kg=104)
TAB = physio.grade_table(P_NOM)
V_LEVEL = physio.governor(P_NOM, 0.0)
# Worst-case path/Euclid ratio of a 16-neighbour lattice: half the 26.57 deg gap between the
# axis and knight directions -> 1 / cos(13.28 deg) = 1.0275 (geometry, not a model constant).
LATTICE_MAX = 1.0 / math.cos(math.atan(0.5) / 2)


def _dist(shape, rc):
    r, c = np.indices(shape)
    return np.hypot(r - rc[0], c - rc[1]) * RES


@pytest.fixture(scope="module")
def flat():
    g = make_grid(plane(N, RES, 0.0), RES)
    return g, dijkstra.return_field(g, TAB, (C, C))


# ------------------------------------------------------------------ flat plane


def test_pad_zero(flat):
    _, f = flat
    assert f.t_min[C, C] == 0.0 and f.o2_l[C, C] == 0.0 and f.ptr[C, C] == -1


@pytest.mark.parametrize("k", range(16))
def test_flat_lattice_rays_exact(flat, k):
    """T = d / v* +- 1 % along each of the 16 move directions."""
    _, f = flat
    di, dj = OFFSETS[k]
    n = 45
    r, c = C + n * di, C + n * dj
    d = n * UNIT_LENGTH[k] * RES
    assert f.t_min[r, c] * 60 == pytest.approx(d / V_LEVEL, rel=0.01)


def test_flat_everywhere_within_lattice_bound(flat):
    """Off-ray cells: 1.0 <= T / (d/v) <= 1.0275 (16-neighbour metric; reported to S)."""
    g, f = flat
    d = _dist(g.shape, (C, C))
    m = d > 30
    ratio = f.t_min[m] * 60 / (d[m] / V_LEVEL)
    assert ratio.min() >= 1 - 1e-9
    assert ratio.max() <= LATTICE_MAX + 1e-6


def test_flat_envelope_circular(flat):
    """5-min envelope radius in every direction within [r/1.0275, r] of r = v * 300 s."""
    g, f = flat
    r_flat = V_LEVEL * 300
    d = _dist(g.shape, (C, C))
    inside = f.t_min <= 5.0
    rr, cc = np.indices(g.shape)
    az = np.degrees(np.arctan2(cc - C, C - rr))
    for a0 in range(-180, 180, 5):
        sector = (az >= a0) & (az < a0 + 5) & inside
        rmax = d[sector].max()
        assert r_flat / LATTICE_MAX - RES * 1.5 <= rmax <= r_flat + RES


def test_flat_o2_matches_time(flat):
    """On flat ground v* is cap-bound, so O2 rate = cap * m_b / 1000 L/min."""
    _, f = flat
    rate = P_NOM.cap * P_NOM.m_b / 1000
    m = np.isfinite(f.t_min) & (f.t_min > 0)
    np.testing.assert_allclose(f.o2_l[m], f.t_min[m] * rate, rtol=1e-4)


# ------------------------------------------------------------------ 10 % plane


@pytest.fixture(scope="module")
def slope10():
    g = make_grid(plane(N, RES, 0.10), RES)  # rises to the north
    return g, dijkstra.return_field(g, TAB, (C, C)), dijkstra.forward_field(g, TAB, (C, C))


def test_plane10_farther_downhill(slope10):
    """Walking reaches farther downhill: forward reach is longer to the south (downhill);
    the return field reaches farther upslope (where the walk home is downhill)."""
    g, ret, fwd = slope10
    n = 60
    assert fwd.t_min[C + n, C] < fwd.t_min[C - n, C]  # south = downhill
    assert ret.t_min[C - n, C] < ret.t_min[C + n, C]
    reach_s = np.sum(fwd.t_min[C:, C] <= 5.0)
    reach_n = np.sum(fwd.t_min[: C + 1, C][::-1] <= 5.0)
    assert reach_s > reach_n


def test_plane10_uphill_speed_equals_governor(slope10):
    _, _, fwd = slope10
    th = math.atan(0.10)
    v_up = physio.governor(P_NOM, th)
    assert v_up < physio.v_safe(P_NOM, th)  # effort cap binds uphill
    for n in (10, 50, 90):
        assert fwd.t_min[C - n, C] * 60 == pytest.approx(n * RES / v_up, rel=1e-3)


def test_plane10_downhill_speed(slope10):
    _, _, fwd = slope10
    v_dn = physio.governor(P_NOM, -math.atan(0.10))
    assert fwd.t_min[C + 50, C] * 60 == pytest.approx(50 * RES / v_dn, rel=1e-3)


def test_forward_reverse_duality(slope10):
    """T_fwd(A->B) == T_rev(to B)(A) on asymmetric terrain."""
    g, _, fwd = slope10
    for b in [(C - 40, C + 17), (C + 33, C - 61), (C + 5, C + 80)]:
        rev = dijkstra.return_field(g, TAB, b)
        assert rev.t_min[C, C] == pytest.approx(fwd.t_min[b], rel=1e-9)


def test_trace_sums_to_field(slope10):
    g, ret, fwd = slope10
    for fld, cell in [(ret, (C + 70, C - 41)), (fwd, (C - 63, C + 22))]:
        path = dijkstra.trace(fld, cell)
        if fld.reverse:
            assert path[0] == cell and path[-1] == (C, C)
        else:
            assert path[0] == (C, C) and path[-1] == cell
        t = 0.0
        for (r0, c0), (r1, c1) in zip(path[:-1], path[1:], strict=True):
            L = math.hypot(r1 - r0, c1 - c0) * RES
            th = math.atan2(g.elev[r1, c1] - g.elev[r0, c0], L)
            t += L / physio.governor(P_NOM, th)
        assert t / 60 == pytest.approx(fld.t_min[cell], rel=1e-4)


# ------------------------------------------------------------------ walls


def _wall_world(deg, gap=False):
    """Flat ground with a N-S ridge (flank angle `deg`, 8 m high) across the full height."""
    n = 151
    x = (np.arange(n) - 100) * RES  # ridge at col 100
    flank = np.clip(8.0 - np.abs(x) * math.tan(math.radians(deg)), 0, None)
    z = np.tile(flank, (n, 1))
    if gap:
        z[70:80, :] = 0.0  # a 30 m gap through the ridge
    return make_grid(z, RES)


def test_wall_steeper_than_nogo_never_crossed():
    g = _wall_world(35.0)
    assert (~g.passable[:, 99]).all() and (~g.passable[:, 101]).all()
    f = dijkstra.return_field(g, TAB, (75, 20))
    assert np.isinf(f.t_min[:, 110:]).all()
    assert np.isfinite(f.t_min[:, :90]).all()


def test_wall_crossed_only_through_gap():
    g = _wall_world(35.0, gap=True)
    f = dijkstra.return_field(g, TAB, (10, 20))
    target = (10, 140)
    assert np.isfinite(f.t_min[target])
    path = dijkstra.trace(f, target)
    assert all(g.passable[r, c] for r, c in path)
    assert any(70 <= r < 80 and c == 100 for r, c in path)


def test_wall_22deg_blocked_nominal_open_optimistic():
    """A 22 deg wall: beyond the nominal 20 deg limit, inside the optimistic 25 deg one."""
    z = _wall_world(22.0).elev
    nom = make_grid(z, RES, nogo_deg=physio.params("nominal", suit_kg=104).nogo_deg)
    p_opt = physio.params("optimistic", suit_kg=104)
    opt = make_grid(z, RES, nogo_deg=p_opt.nogo_deg)
    assert np.isinf(dijkstra.return_field(nom, TAB, (75, 20)).t_min[75, 140])
    t_opt = dijkstra.return_field(opt, physio.grade_table(p_opt), (75, 20)).t_min[75, 140]
    assert np.isfinite(t_opt)


@pytest.mark.parametrize("kind", ["diagonal", "straight"])
def test_one_cell_wall_not_jumped(kind):
    """No corner cutting through a diagonal 1-cell wall; no knight jump over a 1-cell wall."""
    n = 61
    state = np.zeros((n, n), np.uint8)
    rr, cc = np.indices((n, n))
    if kind == "diagonal":
        state[rr == cc] = BLOCKED
    else:
        state[:, 30] = BLOCKED
    g = make_grid(np.zeros((n, n)), RES, cellstate=state)
    g.passable &= state != BLOCKED
    f = dijkstra.return_field(g, TAB, (n - 1, 0) if kind == "diagonal" else (30, 5))
    other = (rr < cc) if kind == "diagonal" else (cc > 30)
    assert np.isinf(f.t_min[other]).all()


# ------------------------------------------------------------------ unknown cells


def test_unknown_cells_never_entered():
    n = 151
    state = np.zeros((n, n), np.uint8)
    rr, cc = np.indices((n, n))
    hole = np.hypot(rr - 75, cc - 75) <= 20
    state[hole] = UNKNOWN
    g = make_grid(np.zeros((n, n)), RES, cellstate=state)
    f = dijkstra.return_field(g, TAB, (75, 40))
    assert np.isinf(f.t_min[hole]).all()
    target = (75, 110)  # directly behind the hole
    path = dijkstra.trace(f, target)
    assert not any(hole[r, c] for r, c in path)
    straight = (110 - 40) * RES / V_LEVEL / 60
    assert f.t_min[target] > straight * 1.02  # detoured


def test_tmax_cutoff():
    g = make_grid(plane(N, RES, 0.0), RES)
    f = dijkstra.return_field(g, TAB, (C, C), tmax_min=2.0)
    reached = np.isfinite(f.t_min)
    assert f.t_min[reached].max() <= 2.0 + 0.2
    assert not reached[0, 0]
