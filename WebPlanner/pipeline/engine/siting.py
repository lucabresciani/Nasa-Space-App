"""Siting heatmap and pad rule (SPEC F8).

Rule (site.yaml ``siting``): candidates are block_m x block_m blocks whose cells are all
assessed with max slope <= max_slope_deg. Each station's forward field (``score`` names the
variant: conservative) gives the walk from the station to a block's representative cell, i.e.
the return home to a pad there. Score = sum of station values with that time <= the budget
named in ``score``. Ties go to the lower block (tired returns run downhill), compared with the
value-weighted station elevation (``tiebreak``). The top_k blocks are reported.

Products: ``siting.tif`` (score per cell, interim), ``siting.png`` + ``siting_png.json`` (grey
overlay with lon/lat corners) and ``pad.json`` (contract pad v1.1.2, C decision 14:58): the
top-level ``pad`` is the pad **in use** (config/site.yaml ``pad_default``, user 11:24) with the
F8 rule evaluated there; the F8 result goes in ``proposal`` (``adopted: false``), never as the pad.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import load
from .graph import ASSESSED, Grid


@dataclass
class Blocks:
    label: np.ndarray  # int64 per cell: block id or -1 (outside full blocks)
    rep: np.ndarray  # (nblocks, 2) representative cell (nearest the block centre)
    candidate: np.ndarray  # bool per block
    elev: np.ndarray  # mean elevation per block


def blocks(grid: Grid, block_m: float, max_slope_deg: float) -> Blocks:
    if grid.cellstate is None or grid.routing_slope is None:
        raise ValueError("siting needs cellstate and the cell slope")
    h, w = grid.shape
    x, y = grid.xy_of_rc(*np.indices(grid.shape))
    bx = np.floor((x - grid.x0) / block_m).astype(np.int64)
    by = np.floor((grid.y0 - y) / block_m).astype(np.int64)
    nbx = int(np.floor(w * grid.res_m / block_m))
    nby = int(np.floor(h * grid.res_m / block_m))
    full = (bx < nbx) & (by < nby)
    label = np.where(full, by * nbx + bx, -1)
    nb = nbx * nby
    flat = label.ravel()
    sel = flat >= 0
    good = (
        (grid.cellstate == ASSESSED)
        & (grid.routing_slope <= max_slope_deg)
        & np.isfinite(grid.elev)
    ).ravel()
    n_cells = np.bincount(flat[sel], minlength=nb)
    n_good = np.bincount(flat[sel], weights=good[sel], minlength=nb)
    candidate = (n_cells > 0) & (n_good == n_cells)
    fin = np.isfinite(grid.elev).ravel()
    z = np.where(fin, grid.elev.ravel(), 0.0)
    n_fin = np.bincount(flat[sel], weights=fin[sel], minlength=nb)
    elev = np.bincount(flat[sel], weights=z[sel], minlength=nb) / np.maximum(n_cells, 1)
    elev = np.where((n_cells > 0) & (n_fin == n_cells), elev, np.nan)  # unknown stays unknown
    # representative: cell nearest the block centre
    cx = grid.x0 + (np.arange(nb) % nbx + 0.5) * block_m
    cy = grid.y0 - (np.arange(nb) // nbx + 0.5) * block_m
    rep = np.zeros((nb, 2), dtype=np.int64)
    rep[:, 0] = np.clip(np.floor((grid.y0 - cy) / grid.res_m), 0, h - 1)
    rep[:, 1] = np.clip(np.floor((cx - grid.x0) / grid.res_m), 0, w - 1)
    return Blocks(label, rep, candidate, elev)


def score(b: Blocks, station_t_min: list[np.ndarray], values, budget_min: float) -> np.ndarray:
    """Per-block score; NaN for non-candidates."""
    s = np.zeros(len(b.candidate))
    for t, v in zip(station_t_min, values, strict=True):
        tr = t[b.rep[:, 0], b.rep[:, 1]]
        s += np.where(np.isfinite(tr) & (tr <= budget_min), v, 0.0)
    return np.where(b.candidate, s, np.nan)


def rank(b: Blocks, s: np.ndarray, values, station_elev) -> np.ndarray:
    """Candidate block ids, best first: score desc, then elevation below the value-weighted
    station elevation (lower first)."""
    values = np.asarray(values, float)
    z_ref = float(np.sum(values * np.asarray(station_elev)) / values.sum())
    ids = np.flatnonzero(b.candidate)
    order = np.lexsort((b.elev[ids] - z_ref, -s[ids]))
    return ids[order]


def heatmap(b: Blocks, s: np.ndarray) -> np.ndarray:
    """Per-cell score raster (float32, NaN outside candidates) for siting.tif."""
    out = np.full(b.label.shape, np.nan, dtype=np.float32)
    m = b.label >= 0
    out[m] = s[b.label[m]]
    return out


# ---------------------------------------------------------------- rule from config


@dataclass(frozen=True)
class Rule:
    block_m: float
    max_slope_deg: float
    require_assessed: bool
    variant: str
    budget_min: float
    top_k: int
    version: str


def rule_from_config() -> Rule:
    import re

    c = load("site")["siting"]
    m = re.fullmatch(r"sum of station values with (\w+) T_home <= (\d+(?:\.\d+)?) min",
                     c["score"].strip())  # fmt: skip
    if not m or m.group(1) not in ("optimistic", "nominal", "conservative"):
        raise ValueError(f"cannot parse site.yaml siting.score {c['score']!r}")
    if not c["tiebreak"].startswith("lower elevation"):
        raise ValueError(f"unknown siting.tiebreak {c['tiebreak']!r}")
    if not c["require_assessed"]:
        raise ValueError("siting without require_assessed is not implemented")
    return Rule(float(c["block_m"]), float(c["max_slope_deg"]), True, m.group(1),
                float(m.group(2)), int(c["top_k"]),
                f"site.yaml siting: {c['score']}; tiebreak {c['tiebreak']}")  # fmt: skip


# ---------------------------------------------------------------- pad.json


def assessed_pct(grid: Grid, rc, radius_m: float) -> float | None:
    """% of the flat disc (radius) around rc that is not unknown; None if it leaves the grid."""
    from .graph import UNKNOWN

    n = int(np.ceil(radius_m / grid.res_m))
    r0, c0 = rc
    if r0 - n < 0 or c0 - n < 0 or r0 + n >= grid.shape[0] or c0 + n >= grid.shape[1]:
        return None
    rr, cc = np.ogrid[r0 - n : r0 + n + 1, c0 - n : c0 + n + 1]
    disc = np.hypot(rr - r0, cc - c0) * grid.res_m <= radius_m
    win = grid.cellstate[r0 - n : r0 + n + 1, c0 - n : c0 + n + 1]
    return 100.0 * float((disc & (win != UNKNOWN)).sum()) / float(disc.sum())


def block_max_slope(grid: Grid, b: Blocks, i: int) -> float:
    return float(np.nanmax(grid.routing_slope[b.label == i]))


def coverage(b: Blocks, station_t_min: list[np.ndarray], budget_min: float) -> np.ndarray:
    """(nblocks, nstations) bool: station within budget of a pad at that block."""
    cols = []
    for t in station_t_min:
        tr = t[b.rep[:, 0], b.rep[:, 1]]
        cols.append(np.isfinite(tr) & (tr <= budget_min))
    return np.column_stack(cols) if cols else np.zeros((len(b.candidate), 0), bool)


def best_hop(b: Blocks, cov: np.ndarray, values, first: int) -> tuple[int, float] | None:
    """Second pad (rover hop) that adds the most station value to the first pad's set."""
    values = np.asarray(values, float)
    cand = np.flatnonzero(b.candidate)
    if len(cand) == 0:
        return None
    union = (cov[cand] | cov[first]) @ values
    k = int(np.argmax(union))
    gain = float(union[k] - cov[first] @ values)
    return (int(cand[k]), float(union[k])) if gain > 0 else None


def _round(v, nd):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)


def _disc_note(grid: Grid, rc, radius_m: float, what: str) -> str:
    """Reason a disc check is null: the disc leaves the routing grid (distance to the edge)."""
    r, c = rc
    h, w = grid.shape
    edge_m = min(r + 0.5, c + 0.5, h - r - 0.5, w - c - 0.5) * grid.res_m
    return (f"assessed_pct_30min and rule_passed are null: the {radius_m:.0f} m flat disc around "
            f"{what} leaves the {grid.res_m:g} m routing grid ({what} is {edge_m:.0f} m from the "
            f"nearest grid edge), so the disc cannot be assessed")  # fmt: skip


def pad_in_use(grid: Grid, station_t_min: list[np.ndarray], values, rule: Rule, lon: float,
               lat: float, source: str, disc_radius_m: float, min_assessed_pct: float) -> dict:
    """Contract ``pad`` for the pad in use (lon/lat kept exactly as given, e.g. pad_default):
    the F8 rule evaluated at its cell. score = station values within the rule budget of a pad
    there; max_slope_deg = steepest cell in the block_m square centred on it; rule_passed =
    that square is all assessed and <= the slope limit and the disc check passes."""
    from .geo import xy_of_lonlat
    from .graph import ASSESSED

    out = {"lon": lon, "lat": lat, "elev_m": None, "score": None,
           "checks": {"assessed_pct_30min": None, "max_slope_deg": None, "rule_passed": None},
           "source": source}  # fmt: skip
    try:
        r0, c0 = grid.rc_of_xy(*xy_of_lonlat(lon, lat, grid.crs))
    except ValueError:
        out["checks_note"] = "pad outside the routing grid: elevation, score and checks unknown"
        return out
    vals = np.asarray(values, float)
    reach = [bool(np.isfinite(t[r0, c0]) and t[r0, c0] <= rule.budget_min) for t in station_t_min]
    out["elev_m"] = _round(grid.elev[r0, c0], 1)
    out["score"] = round(float(vals[np.asarray(reach, bool)].sum()) if len(vals) else 0.0, 4)
    k = max(int(round(rule.block_m / grid.res_m / 2.0)), 0)
    win = (slice(max(r0 - k, 0), r0 + k + 1), slice(max(c0 - k, 0), c0 + k + 1))
    ms = grid.routing_slope[win]
    mslope = float(np.nanmax(ms)) if np.isfinite(ms).any() else None
    block_ok = bool((grid.cellstate[win] == ASSESSED).all() and mslope is not None
                    and np.isfinite(ms).all() and mslope <= rule.max_slope_deg)  # fmt: skip
    apct = assessed_pct(grid, (r0, c0), disc_radius_m)
    out["checks"] = {"assessed_pct_30min": _round(apct, 1), "max_slope_deg": _round(mslope, 2),
                     "rule_passed": None if apct is None
                     else bool(block_ok and apct >= min_assessed_pct)}  # fmt: skip
    if apct is None:
        out["checks_note"] = _disc_note(grid, (r0, c0), disc_radius_m, "the pad")
    return out


def proposal_block(grid: Grid, b: Blocks, s: np.ndarray, order: np.ndarray, rule: Rule,
                   disc_radius_m: float, min_assessed_pct: float, hop=None,
                   stations=None, no_access=None) -> dict:  # fmt: skip
    """Contract ``proposal`` (F8 siting result for S; never the pad in use). The proposed pad
    is the best-ranked block; alternatives list ranks 1..top_k (rank 1 = the proposal). Adds
    the tie information and, for a null disc check, its reason."""
    from .geo import lonlat_of_xy

    def ll(i):
        x, y = grid.xy_of_rc(*b.rep[i])
        lon, lat = lonlat_of_xy(float(x), float(y), grid.crs)
        return round(float(lon), 6), round(float(lat), 6)

    def z(i):
        return _round(b.elev[i], 1)

    best = int(order[0])
    lon, lat = ll(best)
    apct = assessed_pct(grid, tuple(b.rep[best]), disc_radius_m)
    mslope = block_max_slope(grid, b, best)
    passed = None if apct is None else bool(b.candidate[best] and apct >= min_assessed_pct)
    top = round(float(s[best]), 4)
    sc = np.round(s[order].astype(float), 4)
    n_top = int((sc == top).sum())
    prop = {
        "adopted": False,
        "note": "F8 siting proposal for S (WS2 pipeline/engine/siting.py); pad_default is kept; "
                "S decides. Not used by any route, band or number in the plan.",
        "pad": {"lon": lon, "lat": lat, "elev_m": z(best), "score": top,
                "checks": {"assessed_pct_30min": _round(apct, 1),
                           "max_slope_deg": round(mslope, 2), "rule_passed": passed}},
        "alternatives": [
            {"rank": k + 1, "lon": ll(int(i))[0], "lat": ll(int(i))[1], "elev_m": z(int(i)),
             "score": round(float(s[int(i)]), 4)}
            for k, i in enumerate(order[: rule.top_k])
        ],
        "hop_options": [],
        "site_rule_version": rule.version,
        "tie": {"top_score": top, "n_blocks_at_top_score": n_top,
                "n_candidate_blocks": int(len(order)),
                "tiebreak": "lower elevation than the value-weighted station centroid "
                            "(site.yaml siting.tiebreak)",
                "note": (f"{n_top} candidate blocks share the top score {top:g}: the rule cannot "
                         "tell them apart; the tiebreak alone picks rank 1") if n_top > 1
                        else "the top score is unique"},
    }  # fmt: skip
    if stations is not None:
        prop["stations"] = list(stations)
    if no_access:
        prop["no_access"] = dict(no_access)
    if apct is None:
        prop["checks_note"] = _disc_note(grid, tuple(b.rep[best]), disc_radius_m,
                                         "the proposed pad")  # fmt: skip
    if hop is not None:
        j, val = hop
        prop["hop_options"].append({
            "pads": [list(ll(best)), list(ll(j))],
            "note": f"Rover hop: a second pad here raises the station value within "
                    f"{rule.budget_min:g} min ({rule.variant}) from {float(s[best]):.2f} to "
                    f"{val:.2f}.",
        })  # fmt: skip
    return prop


def pad_file(pad: dict, proposal: dict | None, rule: Rule, d21: dict | None = None) -> dict:
    """pad.json (contract pad v1.1.2): ``pad`` = the pad in use; the F8 result sits in
    ``proposal``. Without D21 the top-level alternatives are empty. With D21 (user 16:14) the pad
    is the official pad, ``pad.score`` = its feasible-EVA count (``pad.score_kind``), the F8
    rule's own score moves to ``pad.f8_score``, and ``alternatives`` lists the other ranked
    pads, pad_default and the F8 proposal (extra properties id, kind, d21_rank, tiebreak,
    score_basis); a ``d21`` block carries the decision, order and screening statistics."""
    alts = []
    if d21 is not None:
        pad = {**pad, "f8_score": pad.get("score"), "score": d21["official_info"]["score"],
               "score_kind": d21["score_kind"], "id": d21["official_info"]["id"],
               "tiebreak": d21["official_info"]["tiebreak"]}  # fmt: skip
        alts = [dict(a) for a in d21["alternatives"]]
        if proposal is not None:
            pp = proposal["pad"]
            f8 = d21.get("f8_lookup", lambda lon, lat: None)(pp["lon"], pp["lat"])
            alts.append({"rank": len(alts) + 2, "id": "f8_proposal", "kind": "f8_proposal",
                         "lon": pp["lon"], "lat": pp["lat"], "elev_m": pp["elev_m"],
                         "score": None if f8 is None else f8["score"],
                         "score_basis": None if f8 is None else f8["score_basis"],
                         "d21_rank": None if f8 is None else f8.get("d21_rank"),
                         "f8_score": pp["score"],
                         "note": "F8 siting proposal (site.yaml siting rule)"
                                 + ("" if f8 is not None else "; not a D21 candidate (its "
                                    "30-min disc leaves the grid or it is not a block)")})
    doc = {"dummy": False, "pad": pad, "alternatives": alts, "hop_options": [],
           "site_rule_version": rule.version}  # fmt: skip
    if d21 is not None:
        doc["d21"] = d21["block"]
    if proposal is not None:
        if proposal.get("adopted") is not False:
            raise ValueError("a siting proposal is never adopted in pad.json (C 14:58)")
        doc["proposal"] = proposal
    return doc


def record_pad(doc: dict, script: str) -> None:
    """Manifest keys (file pad.json): pad.* = the pad in use, pad.proposal.* = the proposal.
    Null values stay unrecorded (unknown stays unknown)."""
    from . import provenance

    units = {"lon": "deg", "lat": "deg", "elev_m": "m", "score": "score",
             "assessed_pct_30min": "%", "max_slope_deg": "deg", "rule_passed": None,
             "n_blocks_at_top_score": "blocks", "n_candidate_blocks": "blocks",
             "top_score": "score"}  # fmt: skip

    def rec(prefix, p):
        for k in ("lon", "lat", "elev_m", "score"):
            if p.get(k) is not None:
                provenance.record(f"{prefix}.{k}", p[k], units[k], "pad.json", script)
        for k, v in p["checks"].items():
            if v is not None:
                provenance.record(f"{prefix}.checks.{k}", v, units[k], "pad.json", script)

    rec("pad", doc["pad"])
    if doc["pad"].get("f8_score") is not None:
        provenance.record("pad.f8_score", doc["pad"]["f8_score"], "score", "pad.json", script)
    for k, v in (doc["pad"].get("tiebreak") or {}).items():
        if v is not None:
            provenance.record(f"pad.tiebreak.{k}", v, "%" if "pct" in k else "m", "pad.json",
                              script)  # fmt: skip
    for a in doc.get("alternatives", []):
        for k in ("lon", "lat", "elev_m", "score"):
            if a.get(k) is not None:
                provenance.record(f"pad.alternatives.{a['id']}.{k}", a[k], units[k], "pad.json",
                                  script)  # fmt: skip
        provenance.record(f"pad.alternatives.{a['id']}.rank", a["rank"], None, "pad.json", script)
    prop = doc.get("proposal")
    if prop:
        rec("pad.proposal", prop["pad"])
        for a in prop.get("alternatives", []):
            for k in ("lon", "lat", "elev_m", "score"):
                if a.get(k) is not None:
                    provenance.record(f"pad.proposal.alternatives.{a['rank']}.{k}", a[k],
                                      units[k], "pad.json", script)  # fmt: skip
        for k, v in prop.get("tie", {}).items():
            if k in units:
                provenance.record(f"pad.proposal.tie.{k}", v, units[k], "pad.json", script)


# ---------------------------------------------------------------- run


def heatmap_png(hm: np.ndarray, path, max_score: float | None) -> None:
    """Grey RGBA overlay: grey = score / max score, alpha 0 outside candidates."""
    from PIL import Image

    ok = np.isfinite(hm)
    top = max_score if max_score else 1.0
    g = np.where(ok, np.round(255.0 * np.clip(hm / top, 0, 1)), 0).astype(np.uint8)
    rgba = np.dstack([g, g, g, np.where(ok, 255, 0).astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(path)


PAD_DEFAULT_SOURCE = "config/site.yaml pad_default (kept by the user, 14 Nov 11:24)"


def run(grid: Grid, stations: list[dict], v1_rmse_deg: float | None, out_dir, public,
        pad_lonlat: tuple[float, float] | None = None, pad_source: str | None = None,
        no_access: dict | None = None, script: str = "pipeline/engine/siting.py",
        d21: dict | None = None) -> dict:  # fmt: skip
    """Forward runs from every station (rule variant, default suit), score, rank, write
    siting.tif / siting.png / siting_png.json / pad.json. stations: id, rc, value. The pad in
    use is pad_lonlat (default: site.yaml pad_default); the F8 result is only a proposal."""
    from pathlib import Path

    from . import dijkstra, physio, provenance
    from .geo import lonlat_of_xy, write_json
    from .scenarios import write_raster

    rule = rule_from_config()
    crew, site = load("crew"), load("site")
    p = physio.params(rule.variant, suit_kg=crew["default_suit_kg"], v1_rmse_deg=v1_rmse_deg)
    g = grid.with_nogo(p.nogo_deg)
    tab = physio.grade_table(p)
    values = [float(st["value"]) for st in stations]
    t = [dijkstra.forward_field(g, tab, st["rc"]).t_min for st in stations]
    b = blocks(grid, rule.block_m, rule.max_slope_deg)
    if not b.candidate.any():
        raise ValueError("no siting candidate block (assessed, max slope within the limit)")
    s = score(b, t, values, rule.budget_min)
    order = rank(b, s, values, [grid.elev[st["rc"]] for st in stations])
    cov = coverage(b, t, rule.budget_min)
    hop = best_hop(b, cov, values, int(order[0]))
    radius = crew["anchor"]["speed_ms"] * rule.budget_min * 60.0
    min_pct = site["coverage"]["pad_disc_assessed_min_pct"]
    if pad_lonlat is None:
        pad_lonlat = (site["pad_default"]["lon"], site["pad_default"]["lat"])
        pad_source = pad_source or PAD_DEFAULT_SOURCE
    pad = pad_in_use(grid, t, values, rule, pad_lonlat[0], pad_lonlat[1],
                     pad_source or "pad override", radius, min_pct)  # fmt: skip
    prop = proposal_block(grid, b, s, order, rule, radius, min_pct, hop,
                          [st["id"] for st in stations], no_access)  # fmt: skip
    if d21 is not None:
        prop["note"] = ("F8 siting proposal (WS2 pipeline/engine/siting.py): superseded by D21 "
                        "(user 16:14, the official pad is the candidate with the most feasible "
                        "EVAs); listed in alternatives. Not used by any route, band or number.")
    doc = pad_file(pad, prop, rule, d21)
    out_dir, public = Path(out_dir), Path(public)
    hm = heatmap(b, s)
    write_raster(out_dir / "siting.tif", hm, grid, np.float32(np.nan))
    public.mkdir(parents=True, exist_ok=True)
    heatmap_png(hm, public / "siting.png", float(np.nanmax(s)))
    h, w = grid.shape
    corners = [lonlat_of_xy(grid.x0 + cx * grid.res_m, grid.y0 - cy * grid.res_m, grid.crs)
               for cx, cy in ((0, 0), (w, 0), (w, h), (0, h))]  # fmt: skip
    meta = {"image": "siting.png", "coordinates": [[round(float(x), 6), round(float(y), 6)]
                                                   for x, y in corners],
            "corner_order": "top-left, top-right, bottom-right, bottom-left (MapLibre)",
            "grey_max_score": round(float(np.nanmax(s)), 4), "rule": rule.version}  # fmt: skip
    write_json(public / "siting_png.json", meta, None)
    write_json(public / "pad.json", doc, "pad.schema.json")
    record_pad(doc, script)
    provenance.record_file("pad.json", public / "pad.json", script)
    return doc
