"""D21 (user 2026-11-14 16:14, + 16:16 grid filter): the official pad is the candidate with the
most feasible EVAs, plus the pad picker ("Rover parking options").

1. **Candidates**: every F8 candidate block (site.yaml ``siting``: block_m blocks, all cells
   assessed, cell slope <= max_slope_deg) plus ``pad_default``; a candidate whose flat 30-min
   disc (crew.anchor.speed_ms x 30 min = 1,764 m) is not fully inside the routing grid is dropped
   (16:16). A block's pad is its representative cell (nearest the block centre).
2. **Screening** (nominal 104 kg): station <-> pad time matrices from one forward and one reverse
   Dijkstra per station access cell (not per candidate). Access-cell rule (access.py, 50 m): for
   a pad P the station's access cell is the nearest assessed cell within the radius that has a
   walk home to P. The cells are tried nearest first; a cell in the same strongly connected
   component as a cell already run reaches the same pads and is skipped, so a station needs one
   pair of runs unless its nearest cells sit in sealed pockets (each pocket costs a small run).
   Equal distances are broken by row, col (access.find breaks them by T_home first; the full
   runs use access.find). Score = number of station subsets with a feasible route (pad -> each
   station once -> pad, walk + dwell <= crew.eva_h), ``orienteering.feasible_subsets``.
3. **Order**: score desc, then tiebreak 1 = reachable % of the assessed flat 30-min disc (D25
   denominator, ``envelope.reachable_pct``), desc, then tiebreak 2 = pad-cell elevation, asc.
   Tiebreak 1 needs the pad's return field: in the screening it is computed (30-min bounded
   field, exact for the 30-min envelope) for every candidate whose count reaches the count of
   the top_full_runs-th candidate, and for pad_default.
4. **Full runs** for the top 5 (and pad_default if it is not among them): the nominal return
   field, access.find per station, traverse.plan (exact DP, margin >= 0 on every leg: O2,
   daylight, EVA duration; the timed dose term of D39 depends on the route and is evaluated on
   the planned route, not in the DP). Score = feasible subsets under the margin check. The
   official pad is rank 1 of the top 5 re-ordered by (score, tiebreak 1, tiebreak 2).
5. **Picker**: the next ``picker_n`` of the top 5 (ranks 2..4) plus pad_default when it is not
   the official pad and not already among them. Ids: ``rank{n}`` (D21 rank) and
   ``pad_default``; the official pad is ``rank1``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import dijkstra, envelope, orienteering
from .config import load
from .geo import lonlat_of_xy, xy_of_lonlat
from .graph import ASSESSED, Grid

SCRIPT = "pipeline/engine/padpick.py"
PAD_DEFAULT = "pad_default"


@dataclass
class Settings:
    scenario: str
    budget_min: float
    top_full_runs: int
    picker_n: int
    tiebreak_budget_min: float
    disc_min: float
    disc_speed_ms: float
    access_radius_m: float

    @property
    def disc_radius_m(self) -> float:
        return self.disc_speed_ms * self.disc_min * 60.0


def settings_from_config() -> Settings:
    d = load("variants")["d21"]
    if d["candidates"] != "site.siting" or d["subset_budget"] != "crew.eva_h":
        raise ValueError("variants.d21: candidates must be site.siting, subset_budget crew.eva_h")
    return Settings(scenario=str(d["scenario"]), budget_min=float(load("crew")["eva_h"]) * 60.0,
                    top_full_runs=int(d["top_full_runs"]), picker_n=int(d["picker_n"]),
                    tiebreak_budget_min=float(d["tiebreak_budget_min"]),
                    disc_min=float(d["require_disc_in_grid_min"]),
                    disc_speed_ms=float(load("crew")["anchor"]["speed_ms"]),
                    access_radius_m=float(load("variants")["route"]["access_radius_m"]),
                    )  # fmt: skip


@dataclass
class Candidate:
    id: str  # "b{block id}" or "pad_default"
    kind: str  # "block" | "pad_default"
    rc: tuple[int, int]
    lon: float
    lat: float
    elev_m: float | None
    block: int | None = None
    block_max_slope_deg: float | None = None
    score: int | None = None  # screening count, then the full-run count
    screen_score: int | None = None
    tb1: float | None = None  # reachable % of the 30-min disc (nominal)
    screen_rank: int | None = None
    rank: int | None = None  # D21 rank (1 = official) for the full-run set
    full: dict = field(default_factory=dict)

    def key(self):
        """Sort key: score desc, tiebreak 1 desc (unknown last), elevation asc (unknown last)."""
        return rank_key(self.score, self.tb1, self.elev_m)


def rank_key(score, tb1, elev):
    return (-(score if score is not None else -1),
            -(tb1 if tb1 is not None else -math.inf),
            elev if elev is not None else math.inf)  # fmt: skip


def order(cands: list[Candidate]) -> list[Candidate]:
    """D21 order (stable for full ties: the input order decides)."""
    return sorted(cands, key=lambda c: c.key())


def disc_in_grid(shape, rc, radius_m: float, res_m: float) -> bool:
    """The flat disc around rc lies inside the grid (same test as envelope.reachable_pct)."""
    n = int(np.ceil(radius_m / res_m))
    r, c = rc
    return r - n >= 0 and c - n >= 0 and r + n < shape[0] and c + n < shape[1]


def candidates(grid: Grid, s: Settings) -> tuple[list[Candidate], dict]:
    """F8 candidate blocks + pad_default, minus those whose 30-min disc leaves the grid."""
    from . import siting

    rule = siting.rule_from_config()
    b = siting.blocks(grid, rule.block_m, rule.max_slope_deg)
    ids = np.flatnonzero(b.candidate)
    out, dropped = [], 0
    for i in ids:
        rc = (int(b.rep[i, 0]), int(b.rep[i, 1]))
        if not disc_in_grid(grid.shape, rc, s.disc_radius_m, grid.res_m):
            dropped += 1
            continue
        x, y = grid.xy_of_rc(*rc)
        lon, lat = lonlat_of_xy(float(x), float(y), grid.crs)
        z = grid.elev[rc]
        out.append(Candidate(f"b{int(i)}", "block", rc, round(float(lon), 6), round(float(lat), 6),
                             None if not np.isfinite(z) else round(float(z), 1), int(i),
                             round(siting.block_max_slope(grid, b, int(i)), 2)))  # fmt: skip
    pd = load("site")["pad_default"]
    rc = grid.rc_of_xy(*xy_of_lonlat(pd["lon"], pd["lat"], grid.crs))
    pd_in = disc_in_grid(grid.shape, rc, s.disc_radius_m, grid.res_m)
    if pd_in:
        z = grid.elev[rc]
        out.append(Candidate(PAD_DEFAULT, PAD_DEFAULT, rc, float(pd["lon"]), float(pd["lat"]),
                             None if not np.isfinite(z) else round(float(z), 1)))  # fmt: skip
    stats = {"n_candidate_blocks": int(len(ids)), "n_dropped_disc_off_grid": dropped,
             "n_blocks_screened": int(len(ids)) - dropped, "pad_default_in_grid": bool(pd_in),
             "disc_radius_m": round(s.disc_radius_m, 1), "block_m": rule.block_m,
             "max_slope_deg": rule.max_slope_deg}  # fmt: skip
    return out, stats


# ---------------------------------------------------------------- screening


@dataclass
class AccessRun:
    cell: tuple[int, int]
    dist_m: float
    fwd: np.ndarray | None  # float32 minutes, station access cell -> x (None if unused)
    rev: np.ndarray | None  # x -> station access cell


@dataclass
class StationAccess:
    id: str
    runs: list[AccessRun]
    assign: np.ndarray  # (ncand,) index into runs, -1 = no access cell for that pad
    n_cells: int  # assessed cells within the radius
    n_runs: int  # Dijkstra pairs run (incl. sealed pockets)


def access_cells(grid: Grid, lon: float, lat: float, radius: float) -> list[tuple]:
    """Assessed cells within radius of the science point, nearest first: [(dist, r, c)]."""
    x, y = xy_of_lonlat(lon, lat, grid.crs)
    r0, c0 = grid.rc_of_xy(x, y)
    n = int(math.ceil(radius / grid.res_m)) + 1
    ra, rb = max(r0 - n, 0), min(r0 + n + 1, grid.shape[0])
    ca, cb = max(c0 - n, 0), min(c0 + n + 1, grid.shape[1])
    rr, cc = np.mgrid[ra:rb, ca:cb]
    cx, cy = grid.xy_of_rc(rr, cc)
    d = np.hypot(cx - x, cy - y)
    ok = (d <= radius + 1e-9) & (grid.cellstate[ra:rb, ca:cb] == ASSESSED)
    if grid.cellstate[r0, c0] == ASSESSED:  # the science cell itself is distance 0 (access.find)
        d = np.where((rr == r0) & (cc == c0), 0.0, d)
    cells = sorted(zip(np.round(d[ok], 6).tolist(), rr[ok].tolist(), cc[ok].tolist(),
                       strict=True))
    return [(float(a), int(r), int(c)) for a, r, c in cells]


def station_access(grid_v: Grid, table, st: dict, cands: list[Candidate], radius: float,
                   ) -> StationAccess:  # fmt: skip
    """Access runs for one station (see module doc). grid_v: the scenario's passability."""
    cells = access_cells(grid_v, st["lon"], st["lat"], radius)
    prc = np.array([c.rc for c in cands], dtype=np.int64).reshape(-1, 2)
    assign = np.full(len(cands), -1, dtype=np.int64)
    runs: list[AccessRun] = []
    n_runs = 0
    it = access_runs(grid_v, table, cells)
    while not (assign >= 0).all():
        nxt = next(it, None)
        if nxt is None:
            break
        dist, (r, c), fwd_f, rev_f = nxt
        fwd, rev = fwd_f.t_min, rev_f.t_min
        n_runs += 1
        reach = np.isfinite(fwd[prc[:, 0], prc[:, 1]]) & (assign < 0)  # walk home to P exists
        if reach.any():
            assign[reach] = len(runs)
            runs.append(AccessRun((r, c), dist, fwd.astype(np.float32), rev.astype(np.float32)))
    return StationAccess(st["id"], runs, assign, len(cells), n_runs)


def access_runs(grid_v: Grid, table, cells: list[tuple]):
    """The screening's access-run loop (module doc, step 2), shared with ``station_cell``:
    the access cells (``access_cells``) nearest first; impassable cells and cells in the
    strongly connected component of an earlier run (same reach) are skipped; for every other
    cell the station Dijkstra pair is run and (dist_m, (row, col), forward, reverse) yielded.
    Lazy: a caller that stops iterating runs no further pair."""
    covered = np.zeros(len(cells), bool)  # cell in the SCC of an earlier run
    crc = np.array([(r, c) for _, r, c in cells], dtype=np.int64).reshape(-1, 2)
    for k, (dist, r, c) in enumerate(cells):
        if covered[k] or not grid_v.passable[r, c]:
            continue
        fwd_f, rev_f = access_fields(grid_v, table, (r, c))
        fwd, rev = fwd_f.t_min, rev_f.t_min
        covered |= np.isfinite(fwd[crc[:, 0], crc[:, 1]]) & np.isfinite(rev[crc[:, 0], crc[:, 1]])
        yield dist, (r, c), fwd_f, rev_f


def access_fields(grid_v: Grid, table, cell, tmax_min: float | None = None):
    """(forward, reverse) dijkstra.Field from one station access cell: station -> x and
    x -> station. The one place the station Dijkstra pair is run (D21 screening and
    station_fields, D48)."""
    return (dijkstra.forward_field(grid_v, table, cell, tmax_min=tmax_min),
            dijkstra.return_field(grid_v, table, cell, tmax_min=tmax_min))  # fmt: skip


def _station_run(grid_v: Grid, table, station: dict, radius_m: float):
    """The station's access run for its own fields: (dist_m, (row, col), forward, reverse), or
    None. Rule (W4, E5): the screening's run loop (``access_runs``) with the main terrain as
    the target. The D21 screening and access.find take the nearest assessed cell within the
    radius that has a walk home to the pad; station fields have no pad, so the target is the
    terrain any pad on it reaches: the accepted cell is the first one whose forward field
    reaches more than half of the passable cells of grid_v. If one strongly connected component
    holds more than half of the passable cells (the main terrain; 83-94 % on the real grid),
    that is exactly "a walk to the main terrain exists", so a sealed pocket (a few cells cut
    off from the rest) is skipped and the cell equals access.find's for any pad on the main
    terrain (equal distances: row/col here, T_home in access.find)."""
    n_pass = int(np.count_nonzero(grid_v.passable))
    cells = access_cells(grid_v, station["lon"], station["lat"], radius_m)
    for dist, rc, fwd_f, rev_f in access_runs(grid_v, table, cells):
        if 2 * int(np.count_nonzero(np.isfinite(fwd_f.t_min))) > n_pass:
            return dist, rc, fwd_f, rev_f
    return None


def station_cell(grid_v: Grid, station: dict, radius_m: float, table=None,
                 ) -> tuple[float, int, int] | None:  # fmt: skip
    """The station's access cell for its own fields, as (dist_m, row, col); None if no
    assessed cell within radius_m has a walk to the main terrain (``_station_run``). grid_v:
    the scenario's passability; table: its physio.GradeTable (default: the D21 scenario's,
    variants.yaml d21.scenario)."""
    if table is None:
        from . import physio

        table = physio.grade_table(physio.scenario_params(settings_from_config().scenario))
    run = _station_run(grid_v, table, station, radius_m)
    return None if run is None else (run[0], run[1][0], run[1][1])


def station_fields(grid: Grid, station: dict, scenario="nom_104", settings: Settings | None = None,
                   *, crew: dict | None = None, tmax_min: float | None = None):  # fmt: skip
    """D48: (forward, reverse) dijkstra.Field for one station: forward = from the station's
    access cell to every cell, reverse = from every cell to the access cell (T_home-style field
    towards the station). station: lon, lat (WS1 record). scenario: a scenario id (with crew
    overrides, F26) or physio.Params. settings: padpick.Settings (access_radius_m; default from
    config). The access cell is ``station_cell`` (the screening's run loop; sealed pockets
    skipped, W4). The cell is chosen on unbounded fields; tmax_min bounds the returned pair.
    Raises physio.MissingInput if the station has no such cell within the radius."""
    from . import physio

    s = settings or settings_from_config()
    p = scenario if isinstance(scenario, physio.Params) else physio.scenario_params(
        scenario, crew=crew)  # fmt: skip
    gv = grid.with_nogo(p.nogo_deg)
    tab = physio.grade_table(p)
    run = _station_run(gv, tab, station, s.access_radius_m)
    if run is None:
        raise physio.MissingInput(f"station {station.get('id')}: no passable assessed cell "
                                  f"within {s.access_radius_m} m with a walk to the main "
                                  "terrain")  # fmt: skip
    _, cell, fwd, rev = run
    if tmax_min is None:
        return fwd, rev
    return access_fields(gv, tab, cell, tmax_min)


def matrices(acc: list[StationAccess], cands: list[Candidate]):
    """(t_from (ncand, n), t_to (ncand, n), t_leg (ncand, n, n)) in minutes; inf = no access."""
    nc, n = len(cands), len(acc)
    prc = np.array([c.rc for c in cands], dtype=np.int64).reshape(-1, 2)
    t_from = np.full((nc, n), np.inf)
    t_to = np.full((nc, n), np.inf)
    t_leg = np.full((nc, n, n), np.inf)
    for i, a in enumerate(acc):
        for k, run in enumerate(a.runs):
            m = a.assign == k
            t_from[m, i] = run.rev[prc[m, 0], prc[m, 1]]  # pad -> station
            t_to[m, i] = run.fwd[prc[m, 0], prc[m, 1]]  # station -> pad
    for i, a in enumerate(acc):
        for j, b in enumerate(acc):
            if i == j:
                continue
            for k, run in enumerate(a.runs):
                for q, rb in enumerate(b.runs):
                    m = (a.assign == k) & (b.assign == q)
                    if m.any():
                        t_leg[m, i, j] = float(run.fwd[rb.cell])
    return t_from, t_to, t_leg


def screen_counts(t_from, t_to, t_leg, dwell, budget_min) -> np.ndarray:
    """Feasible-subset count per candidate (no margin check: walk + dwell <= budget)."""
    out = np.zeros(len(t_from), dtype=np.int64)
    for c in range(len(t_from)):
        if not np.isfinite(t_from[c]).any():
            continue
        out[c] = len(orienteering.feasible_subsets(dwell, t_from[c], t_to[c], t_leg[c],
                                                   budget_min))  # fmt: skip
    return out


def tb1_bounded(grid_v: Grid, grid: Grid, table, rc, s: Settings) -> float | None:
    """Tiebreak 1 from a return field bounded at the tiebreak budget (exact for that envelope).
    grid: the full grid (its cell states give the D25 denominator)."""
    f = dijkstra.return_field(grid_v, table, rc, tmax_min=s.tiebreak_budget_min)
    return envelope.reachable_pct(grid, f.t_min, rc, s.tiebreak_budget_min, s.disc_speed_ms)


def tb1_pool(cands: list[Candidate], top_n: int) -> list[int]:
    """Indices that need tiebreak 1 in the screening: every candidate whose count reaches the
    count of the top_n-th best, plus pad_default."""
    if not cands:
        return []
    counts = sorted((c.screen_score or 0 for c in cands), reverse=True)
    thr = counts[min(top_n, len(counts)) - 1]
    return [i for i, c in enumerate(cands)
            if (c.screen_score or 0) >= thr or c.kind == PAD_DEFAULT]  # fmt: skip


def screening_rank(cands: list[Candidate]) -> list[Candidate]:
    """Assign screen_rank (1-based) by the D21 order on the screening values."""
    for c in cands:
        c.score = c.screen_score
    ranked = order(cands)
    for k, c in enumerate(ranked):
        c.screen_rank = k + 1
    return ranked


def final_ranking(full_set: list[Candidate], top_n: int) -> list[Candidate]:
    """D21 ranks for the full-run set: the screening top_n re-ordered by the full-run score
    (rank 1 = official pad); other full-run candidates (pad_default outside the top_n) follow
    with rank = top_n + their screening order."""
    top = [c for c in full_set if c.screen_rank is not None and c.screen_rank <= top_n]
    rest = sorted([c for c in full_set if c not in top], key=lambda c: c.screen_rank or 10**9)
    ranked = order(top)
    for k, c in enumerate(ranked):
        c.rank = k + 1
    for k, c in enumerate(rest):
        c.rank = len(ranked) + k + 1
    return ranked + rest


def picker(ranked: list[Candidate], n: int) -> list[Candidate]:
    """Next n after the official pad (rank 1) plus pad_default when it is not chosen."""
    official = ranked[0]
    out = list(ranked[1 : 1 + n])
    pd = next((c for c in ranked if c.kind == PAD_DEFAULT), None)
    if pd is not None and pd is not official and pd not in out:
        out.append(pd)
    return [c for c in out if c is not official]


def pad_id(c: Candidate) -> str:
    """Stable picker id: pad_default keeps its name, others are rank{n} (D21 rank)."""
    return PAD_DEFAULT if c.kind == PAD_DEFAULT else f"rank{c.rank}"


# ---------------------------------------------------------------- run (scenarios --d21)

SOURCE = ("D21 (user 2026-11-14 16:14): the candidate pad with the most feasible EVAs "
          "(nominal 104 kg; tiebreaks: reachable % of the assessed flat 30-min disc, then lower "
          "elevation); pipeline/engine/padpick.py")  # fmt: skip
SCORE_KIND = "d21_feasible_eva_count"
ORDER_TEXT = ("feasible-EVA count (station subsets with a feasible route, margin >= 0 on every "
              "leg) desc; tiebreak 1 reachable % of the assessed flat 30-min disc desc; "
              "tiebreak 2 pad-cell elevation asc")  # fmt: skip

_POOL_STATE: dict = {}


def _tb1_worker(i: int):
    st = _POOL_STATE
    return i, tb1_bounded(st["gv"], st["grid"], st["tab"], st["rcs"][i], st["s"])


def tb1_many(grid: Grid, gv: Grid, tab, cands: list[Candidate], idx: list[int], s: Settings,
             workers: int | None = None) -> None:
    """Tiebreak 1 for cands[idx] (fork pool for many; results are identical either way)."""
    import multiprocessing as mp
    import os

    _POOL_STATE.update(gv=gv, grid=grid, tab=tab, rcs=[c.rc for c in cands], s=s)
    workers = workers or min(8, os.cpu_count() or 1)
    if len(idx) < 32 or workers <= 1:
        res = [_tb1_worker(i) for i in idx]
    else:
        with mp.get_context("fork").Pool(workers) as pool:
            res = pool.map(_tb1_worker, idx, chunksize=8)
    for i, v in res:
        cands[i].tb1 = None if v is None else round(float(v), 4)
    _POOL_STATE.clear()


def full_run(grid: Grid, c: Candidate, st: list[dict], cond: dict, dose_fn, s: Settings) -> None:
    """Full D21 run at one candidate: nominal return field, access.find per station, exact DP
    with the margin check; score = feasible subsets under the margin, tiebreak 1 from the field."""
    from . import access, physio
    from .scenarios import plan_route

    p = physio.scenario_params(s.scenario)
    home = dijkstra.return_field(grid.with_nogo(p.nogo_deg), physio.grade_table(p), c.rc)
    stc = [dict(x) for x in st]
    access.resolve(grid, {s.scenario: home}, stc, s.access_radius_m)
    res, no_access = plan_route(grid, c.rc, s.scenario, home, stc, cond, dose_fn)
    c.score = int(res.n_feasible_subsets)
    tb = envelope.reachable_pct(grid, home.t_min, c.rc, s.tiebreak_budget_min, s.disc_speed_ms)
    c.tb1 = None if tb is None else round(float(tb), 4)
    c.full = {"home": home, "stations": stc, "res": res, "no_access": no_access}


def tiebreak(c: Candidate, s: Settings) -> dict:
    return {f"reachable_pct_{int(s.tiebreak_budget_min)}": None if c.tb1 is None
            else round(c.tb1, 2), "elev_m": c.elev_m}  # fmt: skip


def run(grid: Grid, st: list[dict], cond: dict, dose_fn, timing_cb=None) -> dict:
    """Screening, full runs, ranking and picker choice (see module doc). st: WS1 stations with
    a position (lon, lat, value, dwell_min); stations without one are left out by the caller."""
    import time

    from . import physio

    s = settings_from_config()
    lap = timing_cb or (lambda name: None)
    p = physio.scenario_params(s.scenario)
    gv, tab = grid.with_nogo(p.nogo_deg), physio.grade_table(p)
    t0 = time.perf_counter()
    cands, stats = candidates(grid, s)
    lap("d21_candidates")
    acc = [station_access(gv, tab, x, cands, s.access_radius_m) for x in st]
    lap("d21_station_dijkstra")
    t_from, t_to, t_leg = matrices(acc, cands)
    dwell = [float(x.get("dwell_min", load("stations")["dwell_min"])) for x in st]
    counts = screen_counts(t_from, t_to, t_leg, dwell, s.budget_min)
    for c, n in zip(cands, counts, strict=True):
        c.screen_score = int(n)
    lap("d21_subset_counts")
    pool = tb1_pool(cands, s.top_full_runs)
    tb1_many(grid, gv, tab, cands, pool, s)
    lap("d21_tiebreak1")
    ranked = screening_rank(cands)
    top = ranked[: s.top_full_runs]
    full_set = list(top)
    pdc = next((c for c in cands if c.kind == PAD_DEFAULT), None)
    if pdc is not None and pdc not in full_set:
        full_set.append(pdc)
    for c in full_set:
        full_run(grid, c, st, cond, dose_fn, s)
    lap("d21_full_runs")
    final = final_ranking(full_set, s.top_full_runs)
    official = final[0]
    picks = picker(final, s.picker_n)
    access_info = [{"station": a.id, "assessed_cells_within_radius": a.n_cells,
                    "dijkstra_pairs": a.n_runs,
                    "access_cells": [{"rc": list(r.cell), "dist_m": round(r.dist_m, 1),
                                      "n_candidates": int((a.assign == k).sum())}
                                     for k, r in enumerate(a.runs)],
                    "n_candidates_without_access": int((a.assign < 0).sum())}
                   for a in acc]  # fmt: skip
    del acc
    hist = {str(k): int(v) for k, v in zip(*np.unique(counts, return_counts=True), strict=True)}
    stats.update({"stations": [x["id"] for x in st], "n_screened": len(cands),
                  "count_histogram": hist, "n_tiebreak1_screening": len(pool),
                  "max_count": int(counts.max()) if len(counts) else None,
                  "access": access_info, "screening_s": round(time.perf_counter() - t0, 1)})
    by_rc = {(c.lon, c.lat): c for c in cands}

    def f8_lookup(lon, lat):
        c = by_rc.get((round(float(lon), 6), round(float(lat), 6)))
        if c is None:
            return None
        if c in full_set:
            return {"score": c.score, "score_basis": "full_run", "d21_rank": c.rank}
        return {"score": c.screen_score, "score_basis": "screening (no margin check)",
                "d21_rank": c.screen_rank}

    alts = []
    for k, c in enumerate(final[1:]):
        alts.append({"rank": k + 2, "id": pad_id(c), "kind": c.kind, "lon": c.lon, "lat": c.lat,
                     "elev_m": c.elev_m, "score": c.score, "score_basis": "full_run",
                     "d21_rank": c.rank, "tiebreak": tiebreak(c, s),
                     "picker": c in picks})  # fmt: skip
    block = {"decision": "D21 (user 2026-11-14 16:14; candidates whose flat 30-min disc leaves "
                         "the grid dropped, 16:16)",
             "scenario": s.scenario, "score_kind": SCORE_KIND, "order": ORDER_TEXT,
             "official_id": pad_id(official), "top_full_runs": s.top_full_runs,
             # published (pad.json, scenarios/pads/index.json): no wall-clock screening_s, so
             # reruns are byte-identical (team lead 20:59); summary.json keeps it via d21 stats
             "screening": {k: v for k, v in stats.items() if k not in ("access", "screening_s")},
             "screening_top": [{"id": c.id, "lon": c.lon, "lat": c.lat, "elev_m": c.elev_m,
                                "screen_score": c.screen_score, "tb1": c.tb1,
                                "screen_rank": c.screen_rank} for c in ranked[:10]],
             "assumptions": ["screening tiebreak 1 computed for every candidate at or above the "
                             "5th-best count (variants.yaml d21.screening_order)",
                             "tiebreak 2 = pad-cell elevation (variants.yaml d21.elevation)",
                             "screening access cells: equal distances broken by row/col",
                             "DP margin check: O2, daylight, EVA duration; the D39 timed dose "
                             "term is evaluated on the planned route only"]}  # fmt: skip
    return {"settings": s, "official": official, "final": final, "picks": picks,
            "ranked_screening": ranked, "stats": stats, "score_kind": SCORE_KIND,
            "alternatives": alts, "block": block, "f8_lookup": f8_lookup,
            "official_info": {"id": pad_id(official), "score": official.score,
                              "tiebreak": tiebreak(official, s)}}  # fmt: skip


def _headline(grid: Grid, rc, home_t: np.ndarray, sid: str, budgets, speed: float) -> dict:
    """Headline at 30/60 min: nominal reachable % (picker files are nominal only) and the range
    [conservative, optimistic] from the same pad's con/opt return fields (in memory only), via
    scenarios.headline_entry (D41: in-data share + in_data_pct at the 60-min budget)."""
    from . import physio
    from .scenarios import headline_entry

    _, suit = physio.parse_scenario(sid)
    rng_t = {}
    for v in ("con", "opt"):
        p = physio.scenario_params(f"{v}_{suit}")
        rng_t[v] = dijkstra.return_field(grid.with_nogo(p.nogo_deg), physio.grade_table(p), rc,
                                         tmax_min=max(budgets)).t_min  # fmt: skip
    return {str(int(b)): headline_entry(grid, home_t, rng_t["con"], rng_t["opt"], rc, b, speed)
            for b in budgets}  # fmt: skip


EXCLUDED_NOTE = ("station combinations the planning rule excludes: screening count (walk + dwell "
                 "<= the EVA budget, no margin check) minus the full-run count (exact DP with "
                 "the margin >= 0 on every leg; O2 used before each leg bounded at the 1.35 L/min "
                 "effort cap). The screening breaks equal access-cell distances by row/col, the "
                 "full run by T_home (access.py).")  # fmt: skip


def feasible_block(screen_score: int | None, score: int | None) -> dict:
    """User 17:28 (supersedes D43's switch): the planning rule stays the effort-cap bound; per
    pad report how many station combinations it excludes (screening - full run)."""
    exc = None if screen_score is None or score is None else int(screen_score) - int(score)
    return {"screen_count": screen_score, "full_run_count": score,
            "excluded_by_effort_cap_rule": exc, "note": EXCLUDED_NOTE}  # fmt: skip


def record_feasible(kp: str, block: dict, file: str) -> None:
    from . import provenance

    for k in ("excluded_by_effort_cap_rule", "screen_count"):
        if block.get(k) is not None:
            provenance.record(f"{kp}feasible.{k}", block[k], "EVAs", file, SCRIPT)


def record_headline(kp: str, head: dict, file: str) -> None:
    from . import provenance

    for b, h in head.items():
        if h["reachable_pct"] is not None:
            provenance.record(f"{kp}headline.{b}.reachable_pct", h["reachable_pct"], "%", file,
                              SCRIPT)  # fmt: skip
        for end, v in zip(("low", "high"), h["range_pct"], strict=True):
            if v is not None:
                provenance.record(f"{kp}headline.{b}.range_pct.{end}", v, "%", file, SCRIPT)
        if h.get("basis") == "in_data":
            provenance.record(f"{kp}headline.{b}.in_data_pct", h["in_data_pct"], "%", file,
                              SCRIPT)  # fmt: skip


def write_products(grid: Grid, d21: dict, st: list[dict], cond: dict, dose_fn, settings, ridge,
                   out_dir, public, official_route: dict | None = None) -> dict:  # fmt: skip
    """Picker files under scenarios/pads/{id}/ (C layout 16:17) + scenarios/pads/index.json.
    Return-field rasters go to <out>/pads/{id}/{scenario}/ (interim only). Manifest keys
    pads.{id}.* with the web paths as files."""
    from pathlib import Path

    from . import edges, haul, physio, provenance, traverse
    from .scenarios import (
        _write_web,
        partner_fields,
        partner_product,
        plan_route,
        write_raster,
    )

    s: Settings = d21["settings"]
    sid = s.scenario
    _, suit = physio.parse_scenario(sid)
    out_dir, public = Path(out_dir), Path(public)
    p = physio.scenario_params(sid)
    gv = grid.with_nogo(p.nogo_deg)
    picks = d21["picks"]
    rows, info = [], {}
    for c in picks:
        pid = pad_id(c)
        rel = f"scenarios/pads/{pid}/"
        kp = f"pads.{pid}."
        home = c.full["home"]
        d = out_dir / "pads" / pid / sid
        write_raster(d / "t_home.tif", home.t_min.astype(np.float32), grid, np.float32(np.nan))
        write_raster(d / "o2_home.tif", home.o2_l.astype(np.float32), grid, np.float32(np.nan))
        write_raster(d / "pointer.tif", home.ptr, grid, -1)
        _write_web(public, rel + f"bands_{suit}.geojson",
                   envelope.bands(grid, {"nominal": home.t_min}, settings.budgets,
                                  settings.simplify_m), "bands.schema.json")  # fmt: skip
        _write_web(public, rel + "edges.geojson",
                   edges.edges(gv, home.t_min, settings.budgets, settings.buffer_m,
                               settings.simplify_m), "edges.schema.json")  # fmt: skip
        partner_t = None
        if ridge is not None:
            pf = partner_fields(grid, c.rc, ridge, suit, settings, out_dir=out_dir / "pads" / pid)
            partner_product(grid, pf, suit, settings, public, rel=rel + "partner.geojson",
                            key_prefix=kp)  # fmt: skip
            partner_t = pf.get(("cart", float(haul.suited_casualty_kg(suit))))
        res, no_access = plan_route(grid, c.rc, sid, home, c.full["stations"], cond, dose_fn,
                                    partner_t)  # fmt: skip
        traverse.write(res, sid, public, rel_dir=rel, key_prefix=kp,
                       route_name=f"route_{sid}.geojson", timeline_name=f"timeline_{sid}.json")
        head = _headline(grid, c.rc, home.t_min, sid, settings.budgets, s.disc_speed_ms)
        low = [e for e in res.timeline if e["event"] in ("arrive", "leave", "o2_checkpoint")]
        lowest = min(low, key=lambda e: e["margin_min"]) if low else None
        summ = {
            "id": pid, "kind": c.kind, "scenario": sid,
            "pad": {"lon": c.lon, "lat": c.lat, "elev_m": c.elev_m},
            "rank": c.rank, "official": False, "score": c.score, "score_kind": SCORE_KIND,
            "tiebreak": tiebreak(c, s), "headline": head,
            "feasible": feasible_block(c.screen_score, c.score),
            "route": {"stops": res.order, "total_min": round(res.total_min, 2),
                      "n_feasible_subsets": res.n_feasible_subsets,
                      "unreachable": res.unreachable, "no_access": no_access,
                      "margin_terms": res.margin_terms,
                      "lowest_margin_min": None if lowest is None else lowest["margin_min"],
                      "lowest_margin_binding": None if lowest is None
                      else lowest["margin_binding"],
                      "turn_back": {e["station"]: {"t_min": e["t_min"],
                                                   "binding": e["margin_binding"]}
                                    for e in res.timeline if e["event"] == "turn_back"},
                      "dose": res.dose},
            "files": {"bands": rel + f"bands_{suit}.geojson", "edges": rel + "edges.geojson",
                      "partner": rel + "partner.geojson" if ridge is not None else None,
                      "route": rel + f"route_{sid}.geojson",
                      "timeline": rel + f"timeline_{sid}.json"},
            "note": "Rover parking option (D21 pad picker): nominal 104 kg only; no isochrones "
                    "or field rasters on the web; HUD, 3D and cards stay on the official pad.",
        }  # fmt: skip
        sf = rel + "summary.json"
        _write_web(public, sf, summ, None)
        _record_pad(kp, c, s, sf)
        record_headline(kp, head, sf)
        record_feasible(kp, summ["feasible"], sf)
        if lowest is not None:
            provenance.record(f"{kp}route.lowest_margin_min", lowest["margin_min"], "min", sf,
                              SCRIPT)  # fmt: skip
        info[pid] = {k: summ[k] for k in ("pad", "rank", "score", "tiebreak", "headline", "route",
                                          "feasible")}  # fmt: skip
    # index (ranking table incl. the official pad)
    for c in d21["final"]:
        pid = pad_id(c)
        is_pick = c in picks
        row = {"id": pid, "kind": c.kind, "lon": c.lon, "lat": c.lat, "elev_m": c.elev_m,
               "rank": c.rank, "score": c.score, "official": c is d21["official"],
               "picker": is_pick, "tiebreak": tiebreak(c, s),
               "screen_score": c.screen_score, "screen_rank": c.screen_rank,
               "feasible": feasible_block(c.screen_score, c.score),
               "summary": f"scenarios/pads/{pid}/summary.json" if is_pick else None}  # fmt: skip
        if c is d21["official"]:
            row["files"] = "official pad: the main scenario files (scenarios/index.json)"
            if official_route:
                row["route"] = {"stops": official_route["order"],
                                "total_min": official_route["total_min"]}
        rows.append(row)
        if not is_pick:
            _record_pad(f"pads.{pid}.", c, s, "scenarios/pads/index.json")
            record_feasible(f"pads.{pid}.", row["feasible"], "scenarios/pads/index.json")
    index = {"dummy": False, "scenario": sid, "score_kind": SCORE_KIND, "order": ORDER_TEXT,
             "official": pad_id(d21["official"]), "decision": d21["block"]["decision"],
             "ids": "official pad and picker pads: rank{n} = D21 rank n; pad_default keeps its "
                    "name; ids follow the ranking of this run",
             "pads": rows, "screening": d21["block"]["screening"]}  # fmt: skip
    _write_web(public, "scenarios/pads/index.json", index, None)
    return {"official": pad_id(d21["official"]), "picks": [pad_id(c) for c in picks],
            "pads": info, "ranking": rows, "screening": d21["stats"]}


def _record_pad(kp: str, c: Candidate, s: Settings, file: str) -> None:
    from . import provenance

    for k, v, u in (("lon", c.lon, "deg"), ("lat", c.lat, "deg"), ("elev_m", c.elev_m, "m"),
                    ("rank", c.rank, None), ("score", c.score, "EVAs")):  # fmt: skip
        if v is not None:
            provenance.record(f"{kp}{k}", v, u, file, SCRIPT)
    for k, v in tiebreak(c, s).items():
        if v is not None:
            provenance.record(f"{kp}tiebreak.{k}", v, "%" if "pct" in k else "m", file, SCRIPT)
