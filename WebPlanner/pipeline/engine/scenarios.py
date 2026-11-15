"""Scenario batch (F4-F6): return fields, isochrones, bands, edges, headline and the index.

Rasters go to data/interim/engine/{scenario}/ (t_home.tif min, o2_home.tif L, pointer.tif
int8 move index, see graph.OFFSETS; -1 = none). Web-facing files go to
data/interim/engine/public/ with the same relative paths as web/public/data/ (`make web` copies
them). Every displayed number goes through provenance.record.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import (
    access,
    dijkstra,
    edges,
    envelope,
    haul,
    margin,
    physio,
    provenance,
    stations,
    trade,
    traverse,
)
from .config import ENGINE_DIR, INTERIM_DIR, load
from .geo import write_json, xy_of_lonlat
from .graph import Grid, load_ws1_grid
from .physio import MissingInput

SCRIPT = "pipeline/engine/scenarios.py"
PUBLIC = ENGINE_DIR / "public"


@dataclass
class Settings:
    isochrone_minutes: list[int]
    isochrone_fallback_step: int
    isochrone_budget_mb_gz: float
    simplify_m: float
    budgets: list[int]
    disc_speed_ms: float
    buffer_m: float
    v1_rmse_deg: float | None = None
    min_hole_m2: float = 0.0


def settings_from_config(v1_rmse_deg: float | None = None) -> Settings:
    """Every output setting from config (variants.yaml outputs, crew.yaml, site.yaml).

    The flat disc of the headline uses the anchor speed (0.98 m/s), as site.yaml
    planning_radius_m does ("flat 60-min disc at 0.98 m/s").
    """
    out = load("variants")["outputs"]
    iso = out["isochrone_minutes"]
    return Settings(
        isochrone_minutes=isochrone_levels(iso["min"], iso["max"], iso["step"]),
        isochrone_fallback_step=int(out["isochrone_fallback_step_min"]),
        isochrone_budget_mb_gz=float(out["isochrone_size_budget_mb_gz"]),
        simplify_m=float(out["simplify_tolerance_m"]),
        budgets=[int(b) for b in out["band_budgets_min"]],
        disc_speed_ms=float(load("crew")["anchor"]["speed_ms"]),
        buffer_m=float(load("site")["coverage"]["source_edge_buffer_m"]),
        v1_rmse_deg=v1_rmse_deg,
        min_hole_m2=float(out.get("display_min_hole_m2", 0.0)),
    )


def isochrone_levels(lo: int, hi: int, step: int) -> list[int]:
    """Contour minutes: multiples of ``step`` within [lo, hi] (step 1 -> 1..60; step 2 -> 2..60,
    so the 30/60-min budgets are always contours)."""
    return [m for m in range(int(lo), int(hi) + 1) if m % int(step) == 0]


def gz_mb(obj) -> float:
    """Size of the compact JSON, gzipped, in MB (10^6 bytes)."""
    import gzip
    import json

    raw = json.dumps(obj, separators=(",", ":")).encode()
    return len(gzip.compress(raw, compresslevel=9)) / 1e6


def isochrones_within_budget(grid: Grid, t_min, settings: Settings) -> tuple[dict, int, float]:
    """F5: 1-min isochrones unless they exceed the gz size budget, then the fallback step
    (its levels are a subset of the 1-min levels, so the features are reused). Holes below
    settings.min_hole_m2 are filled (display filter, C decision 2026-11-14 11:42).
    Returns (FeatureCollection, step used, gz MB)."""
    fc, step, mb, mb1 = _isochrones_sized(grid, t_min, settings)
    isochrones_within_budget.first_gz_mb = mb1  # 1-min size (kept for callers that read it)
    return fc, step, mb


def _isochrones_sized(grid: Grid, t_min, settings: Settings) -> tuple[dict, int, float, float]:
    """isochrones_within_budget plus the 1-min set's gz MB (no function attribute: thread-safe
    for the plan server)."""
    out = load("variants")["outputs"]["isochrone_minutes"]
    fc = envelope.isochrones(grid, t_min, settings.isochrone_minutes, settings.simplify_m,
                             settings.min_hole_m2)  # fmt: skip
    mb = gz_mb(fc)
    mb1 = mb
    step = int(out["step"])
    if mb > settings.isochrone_budget_mb_gz:
        step = settings.isochrone_fallback_step
        levels = set(isochrone_levels(out["min"], out["max"], step))
        missing = sorted(levels - {int(m) for m in settings.isochrone_minutes})
        feats = [f for f in fc["features"] if f["properties"]["minutes"] in levels]
        if missing:  # fallback level not in the 1-min set (not with the config values)
            feats += envelope.isochrones(grid, t_min, missing, settings.simplify_m,
                                         settings.min_hole_m2)["features"]  # fmt: skip
            feats.sort(key=lambda f: f["properties"]["minutes"])
        fc = {**fc, "features": feats}
        mb = gz_mb(fc)
    return fc, step, mb, mb1


def pad_rc(grid: Grid, lonlat: tuple[float, float] | None = None) -> tuple[int, int]:
    """Pad cell: lonlat if given, else site.yaml pad_default."""
    if lonlat is None:
        pad = load("site")["pad_default"]
        lonlat = (pad["lon"], pad["lat"])
    return grid.rc_of_xy(*xy_of_lonlat(lonlat[0], lonlat[1], grid.crs))


def runnable(sids, v1_rmse_deg: float | None = None) -> tuple[list[str], dict[str, str]]:
    """Split scenario ids into those that can run and those skipped with the MissingInput
    reason. Since D23 (conservative no-go 17 deg) no scenario needs WS6's V1 RMSE."""
    ok, skipped = [], {}
    for sid in sids:
        try:
            physio.scenario_params(sid, v1_rmse_deg=v1_rmse_deg)
        except MissingInput as e:
            skipped[sid] = f"MissingInput: {e}"
            continue
        ok.append(sid)
    return ok, skipped


def v1_from_file(path: Path) -> dict:
    """WS6's V1 result (validation/v1.json): the slope RMSE that sets the conservative limit.
    Raises MissingInput if the file or its rmse_deg is missing."""
    import json

    path = Path(path)
    if not path.exists():
        raise MissingInput(f"V1 file {path} not found (WS6)")
    d = json.loads(path.read_text(encoding="utf-8"))
    if d.get("rmse_deg") is None:
        raise MissingInput(f"V1 file {path} has no rmse_deg")
    return {"rmse_deg": float(d["rmse_deg"]), "footprint_m": d.get("footprint_m"),
            "n": d.get("n"), "file": str(path)}  # fmt: skip


def write_raster(path: Path, arr: np.ndarray, grid: Grid, nodata) -> Path:
    import rasterio

    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.where(np.isfinite(arr), arr, nodata) if arr.dtype.kind == "f" else arr
    with rasterio.open(
        path, "w", driver="GTiff", height=arr.shape[0], width=arr.shape[1], count=1,
        dtype=data.dtype, crs=grid.crs or None, transform=grid.transform, nodata=nodata,
        compress="deflate", tiled=True,
    ) as ds:  # fmt: skip
        ds.write(data, 1)
    return path


def return_fields(grid: Grid, pad, sids, settings: Settings, out_dir: Path = ENGINE_DIR,
                  crew: dict | None = None) -> dict[str, dijkstra.Field]:  # fmt: skip
    """One reverse Dijkstra per scenario on that variant's passability; writes the 3 rasters.
    crew: physio.crew_values overrides (F26)."""
    fields = {}
    for sid in sids:
        p = physio.scenario_params(sid, v1_rmse_deg=settings.v1_rmse_deg, crew=crew)
        g = grid.with_nogo(p.nogo_deg)
        f = dijkstra.return_field(g, physio.grade_table(p), pad)
        d = out_dir / sid
        write_raster(d / "t_home.tif", f.t_min.astype(np.float32), grid, np.float32(np.nan))
        write_raster(d / "o2_home.tif", f.o2_l.astype(np.float32), grid, np.float32(np.nan))
        write_raster(d / "pointer.tif", f.ptr, grid, -1)
        fields[sid] = f
    write_pointer_offsets(out_dir)
    return fields


def write_pointer_offsets(out_dir: Path) -> Path:
    """pointer.tif legend for WS7/WS9: value k -> next cell on the way home is
    (row + drow[k], col + dcol[k]); -1 = pad or unreached. Rows grow southwards."""
    import json

    from .graph import OFFSETS

    path = Path(out_dir) / "pointer_offsets.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "offsets_drow_dcol": OFFSETS.tolist(),
        "note": "pointer.tif (int8): next cell = (row + drow[k], col + dcol[k]); -1 = pad or "
                "unreached; rows grow southwards (north-up grid)",
    }, indent=1), encoding="utf-8")  # fmt: skip
    return path


def in_data_budgets() -> set[int]:
    """D41: budgets whose headline uses the in-data share (variants.yaml outputs)."""
    return {int(b) for b in load("variants")["outputs"].get("headline_in_data_budgets_min", [])}


IN_DATA_LABEL = "{pct:.1f} % of the circle lies inside the terrain data"


def headline_entry(grid: Grid, t_own, t_con, t_opt, pad, budget: float, speed: float,
                   in_data: bool | None = None) -> dict:  # fmt: skip
    """Headline at one budget: reachable % (own field) and range [conservative, optimistic],
    plus ``basis`` ("full_disc" | "in_data" | "off_grid"), ``in_data_pct`` (% of the flat disc
    inside the terrain data) and ``label`` (D41, user 17:22: the 60-min share is over the part
    of the circle inside the data, labelled with that part's size). in_data defaults to the
    budget being in variants.yaml outputs.headline_in_data_budgets_min."""
    if in_data is None:
        in_data = int(budget) in in_data_budgets()
    inside = envelope.disc_in_grid(grid, pad, speed * budget * 60.0)

    def pct(t):
        if t is None:
            return None
        x = envelope.reachable_pct(grid, t, pad, budget, speed, in_data=in_data)
        return None if x is None else round(float(x), 1)

    cov = round(envelope.disc_in_data_pct(grid, pad, budget, speed), 1)
    basis = "full_disc" if inside else ("in_data" if in_data else "off_grid")
    return {"budget_min": int(budget), "reachable_pct": pct(t_own),
            "range_pct": [pct(t_con), pct(t_opt)], "basis": basis, "in_data_pct": cov,
            "label": IN_DATA_LABEL.format(pct=cov) if basis == "in_data" else None}  # fmt: skip


def headline_extra(grid: Grid, pad, t_by_sid: dict[str, np.ndarray], settings: Settings,
                   entries: list[dict], file: str = "scenarios/index.json") -> None:  # fmt: skip
    """D41: ``headline_{b}`` for every budget after the first (the 30-min headline stays the
    headline) on each scenarios/index.json entry, with manifest keys reachable_pct.{sid}.{b},
    reachable_pct_range.{sid}.{b}.{low,high} and headline.{sid}.disc_{b}.in_data_pct."""
    by_suit: dict[int, dict[str, np.ndarray]] = {}
    for sid, t in t_by_sid.items():
        v, suit = physio.parse_scenario(sid)
        by_suit.setdefault(suit, {})[v] = t
    for e in entries:
        sid = e["id"]
        if sid not in t_by_sid:
            continue
        _, suit = physio.parse_scenario(sid)
        for b in settings.budgets[1:]:
            h = headline_entry(grid, t_by_sid[sid], by_suit[suit].get("conservative"),
                               by_suit[suit].get("optimistic"), pad, b,
                               settings.disc_speed_ms)  # fmt: skip
            e[f"headline_{int(b)}"] = h
            if h["reachable_pct"] is not None:
                provenance.record(f"reachable_pct.{sid}.{int(b)}", h["reachable_pct"], "%", file,
                                  SCRIPT)  # fmt: skip
            for end, val in zip(("low", "high"), h["range_pct"], strict=True):
                if val is not None:
                    provenance.record(f"reachable_pct_range.{sid}.{int(b)}.{end}", val, "%",
                                      file, SCRIPT)  # fmt: skip
            provenance.record(f"headline.{sid}.disc_{int(b)}.in_data_pct", h["in_data_pct"], "%",
                              file, SCRIPT)  # fmt: skip


def web_products(grid: Grid, pad, fields: dict[str, dijkstra.Field], settings: Settings,
                 public: Path = PUBLIC, default: str | None = None,
                 iso_info: dict | None = None) -> dict:  # fmt: skip
    """Isochrones, edges, bands, headline and scenarios/index.json for the scenarios given.
    iso_info: filled with the per-scenario isochrone sizes (for the run summary); also kept as
    ``web_products.iso_info`` for older callers."""
    var = load("variants")
    default = default or var["scenarios"]["default"]
    by_suit: dict[int, dict[str, np.ndarray]] = {}
    iso_info = {} if iso_info is None else iso_info
    for sid, f in fields.items():
        variant, suit = physio.parse_scenario(sid)
        by_suit.setdefault(suit, {})[variant] = f.t_min
        iso, step, mb, mb1 = _isochrones_sized(grid, f.t_min, settings)
        _write_web(public, f"scenarios/{sid}/isochrones.geojson", iso, "isochrones.schema.json")
        provenance.record(f"isochrone_step_min.{sid}", step, "min",
                          f"scenarios/{sid}/isochrones.geojson", SCRIPT)  # fmt: skip
        iso_info[sid] = {"step_min": step, "gz_mb": round(mb, 3),
                         "gz_mb_1min": round(mb1, 3),
                         "min_hole_m2": settings.min_hole_m2}  # fmt: skip
        cg = grid.with_nogo(physio.scenario_params(sid, v1_rmse_deg=settings.v1_rmse_deg).nogo_deg)
        _write_web(public, f"scenarios/{sid}/edges.geojson",
                   edges.edges(cg, f.t_min, settings.budgets, settings.buffer_m,
                               settings.simplify_m), "edges.schema.json")  # fmt: skip
    for suit, tv in by_suit.items():
        _write_web(public, f"scenarios/bands_{suit}.geojson",
                   envelope.bands(grid, tv, settings.budgets, settings.simplify_m),
                   "bands.schema.json")  # fmt: skip
    budget = settings.budgets[0]
    entries = []
    for sid, f in fields.items():
        variant, suit = physio.parse_scenario(sid)
        own = envelope.reachable_pct(grid, f.t_min, pad, budget, settings.disc_speed_ms)
        rng = [
            envelope.reachable_pct(grid, by_suit[suit][v], pad, budget, settings.disc_speed_ms)
            if v in by_suit[suit] else None
            for v in ("conservative", "optimistic")
        ]  # fmt: skip
        own_r = None if own is None else round(own, 1)
        rng_r = [None if x is None else round(x, 1) for x in rng]
        file = "scenarios/index.json"
        if own_r is not None:
            provenance.record(f"reachable_pct.{sid}.{budget}", own_r, "%", file, SCRIPT)
        for end, val in zip(("low", "high"), rng_r, strict=True):
            if val is not None:
                provenance.record(f"reachable_pct_range.{sid}.{budget}.{end}", val, "%", file,
                                  SCRIPT)  # fmt: skip
        entries.append({
            "id": sid, "variant": variant, "suit_kg": suit,
            "files": {
                "isochrones": f"scenarios/{sid}/isochrones.geojson",
                "bands": f"scenarios/bands_{suit}.geojson",
                "edges": f"scenarios/{sid}/edges.geojson",
                "partner": f"scenarios/nom_{suit}/partner.geojson",  # haul runs nominal only
            },
            "headline": {"budget_min": budget, "reachable_pct": own_r, "range_pct": rng_r},
        })  # fmt: skip
    headline_extra(grid, pad, {sid: f.t_min for sid, f in fields.items()}, settings, entries)
    index = {"dummy": False, "default": default, "scenarios": entries}
    _write_web(public, "scenarios/index.json", index, "scenarios_index.schema.json")
    web_products.iso_info = iso_info  # sizes for the run summary
    return index


def _write_web(public: Path, rel: str, obj, schema: str) -> Path:
    """Validate, write and record the file-level manifest key file.<rel>."""
    path = write_json(public / rel, obj, schema)
    provenance.record_file(rel, path, SCRIPT)
    return path


def partner_fields(grid: Grid, pad, ridge_index, suit_kg: int, settings: Settings,
                   out_dir: Path = ENGINE_DIR, crew: dict | None = None,
                   ) -> dict[tuple[str, float], np.ndarray]:  # fmt: skip
    """Nominal-variant haul fields: (suited, bound) casualty x haul.yaml partner_cases (D20: cart
    only; no drag fields), ridges masked. crew: the rescuer's overrides (F26); the casualty
    masses stay haul.suited_casualty_kg / haul.yaml."""
    h = load("haul")
    p = physio.params("nominal", suit_kg=suit_kg, crew=crew)
    hg = haul.haul_grid(grid.with_nogo(p.nogo_deg), ridge_index)
    out = {}
    for m_ic in (haul.suited_casualty_kg(suit_kg), h["casualty_kg"]["bound"]):
        for name in haul.partner_cases():
            c = haul.case(name, m_ic)
            f = dijkstra.return_field(hg, haul.grade_table(p, c), pad)
            tag = f"nom_{suit_kg}_{name}_{int(m_ic)}"
            write_raster(out_dir / "haul" / tag / "t_haul.tif", f.t_min.astype(np.float32),
                         grid, np.float32(np.nan))  # fmt: skip
            out[(name, float(m_ic))] = f.t_min
    return out


def partner_product(grid: Grid, fields, suit_kg: int, settings: Settings,
                    public: Path = PUBLIC, rel: str | None = None, key_prefix: str = "",
                    ) -> dict:  # fmt: skip
    """partner.geojson (cart line, D20) plus the drag finding as a foreign member
    ``drag_finding`` (flat ground, haul.drag_flat). Manifest keys haul.drag.flat.nom_{suit}.*,
    and haul.drag.flat.* for the default suit (the numbers SPEC §11 D20 cites)."""
    fc = haul.partner(grid, fields, settings.simplify_m)
    d = haul.drag_flat(suit_kg)
    fc["drag_finding"] = {**{k: (round(v, 3) if isinstance(v, float) else v)
                             for k, v in d.items()},
                          "note": load("haul")["drag_note"]}  # fmt: skip
    rel = rel or f"scenarios/nom_{suit_kg}/partner.geojson"
    _write_web(public, rel, fc, "partner.schema.json")
    units = {"force_N": "N", "traction_limit_N": "N", "max_mass_kg": "kg", "casualty_kg": "kg",
             "rescuer_system_kg": "kg", "mu": "1", "boot_mu": "1"}  # fmt: skip
    if key_prefix:  # picker pads (D21): pads.{id}.haul.drag.flat.*
        prefixes = [f"{key_prefix}haul.drag.flat"]
    else:
        prefixes = [f"haul.drag.flat.nom_{suit_kg}"]
        if suit_kg == load("crew")["default_suit_kg"]:
            prefixes.append("haul.drag.flat")
    for pre in prefixes:
        for k, u in units.items():
            provenance.record(f"{pre}.{k}", fc["drag_finding"][k], u, rel, SCRIPT)
        provenance.record(f"{pre}.feasible", d["feasible"], None, rel, SCRIPT)
    return fc


def siting_scenario() -> str:
    """Scenario whose access cells start the F8 forward runs: the site.yaml siting rule's
    variant at the default suit (con_104)."""
    from . import siting

    pre = {v: k for k, v in physio.VARIANT_PREFIX.items()}[siting.rule_from_config().variant]
    return f"{pre}_{load('crew')['default_suit_kg']}"


def run_siting(grid: Grid, sst, s_none, ssid: str, rmse, out: Path, pub: Path, pad_override,
               d21: dict | None = None) -> dict:  # fmt: skip
    """F8 siting + pad.json (siting.run) and the summary.json block. The pad in use is the D21
    official pad (d21), else --pad, else pad_default; the F8 siting result is only the
    proposal."""
    from . import siting

    print(f"siting: forward runs from the {ssid} access cells of {[s['id'] for s in sst]}"
          f"; no access cell: {s_none}")  # fmt: skip
    if not sst:
        raise MissingInput(f"no station has an access cell in {ssid}")
    override = tuple(pad_override) if pad_override else None
    src = "--pad override (scenarios CLI)" if override else None
    if d21 is not None:
        from . import padpick

        src = padpick.SOURCE
    doc = siting.run(grid, sst, rmse, out, pub, override, src, s_none, d21=d21)
    return {"scenario": ssid, "stations": [s["id"] for s in sst], "no_access": s_none,
            "pad": doc["pad"], "proposal": doc["proposal"]}  # fmt: skip


def siting_only(grid: Grid, pad, a, rmse, settings: Settings, out: Path, pub: Path) -> int:
    """--siting-only: the rule scenario's return field (not written), WS1 stations and their
    access cells in that scenario, then F8 siting + pad.json. No other product is touched;
    summary.json gets the new siting block."""
    import json

    ssid = siting_scenario()
    sids, skipped = runnable([ssid], rmse)
    if not sids:
        print(f"siting skipped: {skipped.get(ssid)}")
        return 2
    p = physio.scenario_params(ssid, v1_rmse_deg=rmse)
    f = dijkstra.return_field(grid.with_nogo(p.nogo_deg), physio.grade_table(p), pad)
    st, missing = stations.load_ws1_stations(a.terrain / "stations.json")
    stations.attach_cells(grid, st)
    access.resolve(grid, {ssid: f}, st, access.radius_m())
    if not st or any(s.get("value") is None for s in st):
        print("siting skipped: no stations or a station without value")
        return 2
    sst, s_none = access.routing_stations(st, ssid)
    try:
        info = run_siting(grid, sst, s_none, ssid, rmse, out, pub, a.pad)
    except MissingInput as e:
        print(f"siting skipped: {e}")
        return 2
    summ = out / "summary.json"
    doc = json.loads(summ.read_text(encoding="utf-8")) if summ.exists() else {}
    doc["siting"] = info
    summ.parent.mkdir(parents=True, exist_ok=True)
    summ.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    print(f"siting only: pad in use {info['pad']['lon']}, {info['pad']['lat']}; proposal "
          f"{info['proposal']['pad']['lon']}, {info['proposal']['pad']['lat']}; wrote {summ}")
    return 0


def _insert_after(d: dict, after: str, key: str, value) -> dict:
    out = {}
    for k, v in d.items():
        if k != key:
            out[k] = v
        if k == after:
            out[key] = value
    if key not in out:
        out[key] = value
    return out


def headline_patch(grid: Grid, settings: Settings, pub: Path) -> int:
    """--headline-patch (D41 + user 17:28): fill the 60-min headline (in-data share, in_data_pct)
    in scenarios/index.json (headline_60), trade_table.json and the picker summaries, and add the
    per-pad ``feasible`` block (station combinations the effort-cap rule excludes) to the picker
    summaries and scenarios/pads/index.json. Return fields are recomputed in memory, bounded at
    the largest budget (exact inside it), never written; routes, timelines, cards, stations and
    the ranking are not touched. The pad is pad.json's (D44: frozen). The 30-min headline is
    recomputed as a check and must equal the published one."""
    import json

    from . import padpick

    def read(rel):
        return json.loads((pub / rel).read_text(encoding="utf-8"))

    pj = read("pad.json")
    pad = pad_rc(grid, (pj["pad"]["lon"], pj["pad"]["lat"]))
    tmax = max(settings.budgets)
    b0 = settings.budgets[0]

    def field_t(sid, rc):
        p = physio.scenario_params(sid)
        return dijkstra.return_field(grid.with_nogo(p.nogo_deg), physio.grade_table(p), rc,
                                     tmax_min=tmax).t_min  # fmt: skip

    index = read("scenarios/index.json")
    t_by = {e["id"]: field_t(e["id"], pad) for e in index["scenarios"]}
    for e in index["scenarios"]:
        own = envelope.reachable_pct(grid, t_by[e["id"]], pad, b0, settings.disc_speed_ms)
        own = None if own is None else round(own, 1)
        if own != e["headline"]["reachable_pct"]:
            raise SystemExit(f"{e['id']}: {b0}-min headline {own} != published "
                             f"{e['headline']['reachable_pct']} (pad or grid changed)")
    headline_extra(grid, pad, t_by, settings, index["scenarios"])
    _write_web(pub, "scenarios/index.json", index, "scenarios_index.schema.json")
    out = {"scenarios": {e["id"]: e.get(f"headline_{tmax}") for e in index["scenarios"]}}

    tt = read("trade_table.json")
    for i, b in enumerate(tt["rows"]):
        if int(b) not in in_data_budgets():
            continue
        for j, m in enumerate(tt["cols"]):
            pct, cov = trade_pct(grid, t_by.get(f"nom_{int(m)}"), pad, b, settings)
            cell = tt["cells"][i][j]
            cell["reachable_pct"] = pct
            if cov is not None:
                cell["in_data_pct"] = cov
            for k, u in (("reachable_pct", "%"), ("in_data_pct", "%")):
                if cell.get(k) is not None:
                    provenance.record(f"trade.{int(b)}.{int(m)}.{k}", cell[k], u,
                                      "trade_table.json", SCRIPT)  # fmt: skip
    _write_web(pub, "trade_table.json", tt, "trade_table.schema.json")
    out["trade"] = tt

    ps = padpick.settings_from_config()
    pidx = read("scenarios/pads/index.json")
    rows = []
    out["pads"] = {}
    for row in pidx["pads"]:
        fb = padpick.feasible_block(row.get("screen_score"), row.get("score"))
        row = _insert_after(row, "screen_rank", "feasible", fb)
        kp = f"pads.{row['id']}."
        if row.get("summary"):
            summ = read(row["summary"])
            rc = pad_rc(grid, (summ["pad"]["lon"], summ["pad"]["lat"]))
            head = padpick._headline(grid, rc, field_t(ps.scenario, rc), ps.scenario,
                                     settings.budgets, ps.disc_speed_ms)  # fmt: skip
            old = summ["headline"][str(int(b0))]
            new = head[str(int(b0))]
            if (old["reachable_pct"], list(old["range_pct"])) != (new["reachable_pct"],
                                                                   new["range_pct"]):
                raise SystemExit(f"{row['id']}: {b0}-min headline {new} != published {old}")
            summ["headline"] = head
            summ = _insert_after(summ, "headline", "feasible", fb)
            _write_web(pub, row["summary"], summ, None)
            padpick.record_headline(kp, head, row["summary"])
            padpick.record_feasible(kp, fb, row["summary"])
            out["pads"][row["id"]] = {"headline": head, "feasible": fb}
        else:
            padpick.record_feasible(kp, fb, "scenarios/pads/index.json")
            out["pads"][row["id"]] = {"feasible": fb}
        rows.append(row)
    pidx["pads"] = rows
    _write_web(pub, "scenarios/pads/index.json", pidx, None)
    summ_path = pub.parent / "summary.json"
    if summ_path.exists():
        doc = json.loads(summ_path.read_text(encoding="utf-8"))
        doc["headline_patch"] = {"note": "D41 + user 17:28 (scenarios --headline-patch)", **out}
        summ_path.write_text(json.dumps(doc, indent=1, default=str), encoding="utf-8")
    for sid, h in out["scenarios"].items():
        print(f"{sid} {tmax} min: {h}")
    for pid, v in out["pads"].items():
        print(f"pad {pid}: {v}")
    return 0


def _rename_walk(obj, by_id: dict[str, dict]):
    """(obj with the name fields of every station-keyed dict that carries a ``name`` replaced,
    changed?). A station-keyed dict has ``id`` or ``station`` equal to a WS1 station id."""
    if isinstance(obj, list):
        pairs = [_rename_walk(v, by_id) for v in obj]
        return [v for v, _ in pairs], any(c for _, c in pairs)
    if not isinstance(obj, dict):
        return obj, False
    changed = False
    out = {}
    for k, v in obj.items():
        out[k], c = _rename_walk(v, by_id)
        changed |= c
    sid = obj.get("id") if isinstance(obj.get("id"), str) else obj.get("station")
    if "name" in out and isinstance(sid, str) and sid in by_id:
        new = stations.with_names(out, by_id[sid])
        if new != out or list(new) != list(out):
            out, changed = new, True
    return out, changed


def stations_names_patch(terrain_dir: Path, pub: Path) -> int:
    """--stations-only (D44): copy WS1's current station names (``name``, ``name_base``,
    ``name_suffix``) into the published files that carry them: ``stations.json`` and any card
    timeline part, picker summary, timeline or route that has a station-keyed ``name``. Nothing
    is recomputed (no grid is read); every other byte stays as published.

    Refuses (returns 3, writes nothing) unless the stations are the ones the published files
    were computed from: same ids, same lon/lat (6 decimals, as published), same ``value`` and
    ``dwell_min`` (route inputs), and card ``science`` points equal to WS1's. A moved station
    needs a full re-run."""
    import json

    ws1, _missing = stations.load_ws1_stations(terrain_dir / "stations.json")
    by_id = {s["id"]: s for s in ws1}
    pub_path = pub / "stations.json"
    recs = json.loads(pub_path.read_text(encoding="utf-8"))
    dwell0 = load("stations")["dwell_min"]
    bad = []
    if set(by_id) != {r["id"] for r in recs}:
        bad.append(f"station ids: WS1 {sorted(by_id)} vs published "
                   f"{sorted(r['id'] for r in recs)}")  # fmt: skip
    for r in recs:
        s = by_id.get(r["id"])
        if s is None:
            continue
        for k, want in (("lon", round(float(s["lon"]), 6)), ("lat", round(float(s["lat"]), 6)),
                        ("value", s.get("value")), ("dwell_min", s.get("dwell_min", dwell0))):
            if r.get(k) != want:
                bad.append(f"{r['id']} {k}: WS1 {want} vs published {r.get(k)}")
    cards_dir = pub / "cards"
    for p in sorted(cards_dir.glob("*.timeline.json")) if cards_dir.is_dir() else []:
        card = json.loads(p.read_text(encoding="utf-8"))
        s, sci = by_id.get(card.get("station")), card.get("science")
        if s is None or not sci:
            continue
        for k in ("lon", "lat"):
            if sci.get(k) != round(float(s[k]), 6):
                bad.append(f"{card['station']} card science {k}: WS1 {round(float(s[k]), 6)} "
                           f"vs published {sci.get(k)}")  # fmt: skip
    if bad:
        print("stations-only refused: the published files were computed from other stations; "
              "do a full re-run (python -m pipeline.engine.scenarios ...) instead:")
        for b in bad:
            print(f"  {b}")
        return 3

    written = []
    new_recs = [stations.with_names(r, by_id[r["id"]]) for r in recs]
    if json.dumps(new_recs) != json.dumps(recs):
        _write_web(pub, "stations.json", new_recs, "stations.schema.json")
        written.append("stations.json")
    others = [p for p in sorted(pub.rglob("*.json")) if p != pub_path]
    others += sorted(pub.rglob("route_*.geojson"))
    for p in others:
        doc, changed = _rename_walk(json.loads(p.read_text(encoding="utf-8")), by_id)
        if changed:
            rel = p.relative_to(pub).as_posix()
            write_json(p, doc, None)
            provenance.record_file(rel, p, SCRIPT)
            written.append(rel)
    summ_path = pub.parent / "summary.json"
    if summ_path.exists():
        doc = json.loads(summ_path.read_text(encoding="utf-8"))
        doc["stations_names_patch"] = {
            "note": "D44 names (scenarios --stations-only); nothing recomputed",
            "written": written,
            "names": {r["id"]: r["name"] for r in new_recs}}  # fmt: skip
        summ_path.write_text(json.dumps(doc, indent=1, default=str), encoding="utf-8")
    print(f"stations-only: rewrote {written or 'nothing (names already current)'}")
    for r in new_recs:
        print(f"  {r['id']}: {r['name']}")
    return 0


def diagnostics(grid: Grid, pad, fields: dict[str, dijkstra.Field], settings: Settings) -> dict:
    """Sanity numbers per scenario (internal, not shown in the app): reachable % of the
    assessed flat disc and envelope area / flat-circle area at every budget, edge cause shares
    by length, reached cells and the largest finite T_home."""
    out = {}
    for sid, f in fields.items():
        cg = grid.with_nogo(physio.scenario_params(sid, v1_rmse_deg=settings.v1_rmse_deg).nogo_deg)
        fin = np.isfinite(f.t_min)
        d = {"reached_cells": int(fin.sum()), "passable_cells": int(cg.passable.sum()),
             "t_home_max_min": round(float(f.t_min[fin].max()), 1), "budgets": {}}  # fmt: skip
        for b in settings.budgets:
            radius = settings.disc_speed_ms * b * 60.0
            pct = envelope.reachable_pct(grid, f.t_min, pad, b, settings.disc_speed_ms)
            area = float(envelope.envelope_mask(f.t_min, b).sum()) * grid.res_m**2
            disc = envelope.flat_disc(grid, pad, radius)
            lengths = dict.fromkeys(edges.CAUSES, 0.0)
            for line, cause in edges.edge_lines(cg, f.t_min, b, settings.buffer_m):
                lengths[cause] += line.length
            tot = sum(lengths.values()) or 1.0
            d["budgets"][str(b)] = {
                "flat_disc_radius_m": round(radius, 1),
                "reachable_pct_assessed_disc": None if pct is None else round(pct, 2),
                "flat_circle_ratio": round(area / (np.pi * radius**2), 4),
                "disc_blocked_pct_variant": round(
                    100.0 * float((disc & ~cg.passable).sum()) / float(disc.sum()), 2),
                "edge_length_km": {k: round(v / 1000.0, 2) for k, v in lengths.items()},
                "edge_cause_share_pct": {k: round(100.0 * v / tot, 1) for k, v in lengths.items()},
            }  # fmt: skip
        out[sid] = d
    return out


def stations_product(grid: Grid, fields, partner_t, public: Path = PUBLIC,
                     terrain_dir: Path = INTERIM_DIR / "terrain",
                     station_list: list[dict] | None = None,
                     missing: list[str] | None = None) -> tuple:  # fmt: skip
    """stations.json = WS1's stations + T_home per scenario at the access cell (access.py,
    user decision 11:40), the access block and the partner-line flag. Stations without a
    position are left out (the contract needs lon/lat) and returned in ``missing``. The science
    lon/lat is never moved. station_list (with ``missing``): WS1 stations already loaded
    (stations.load_ws1_stations; deep-copied here), else terrain_dir/stations.json is read."""
    if station_list is None:
        st, missing = stations.load_ws1_stations(terrain_dir / "stations.json")
    else:
        import copy

        st, missing = copy.deepcopy(station_list), list(missing or [])
    stations.attach_cells(grid, st)
    access.resolve(grid, fields, st, access.radius_m())
    recs = stations.station_records(st, fields, partner_t, load("haul")["contour_min"])
    _write_web(public, "stations.json", recs, "stations.schema.json")
    f = "stations.json"
    for r in recs:
        for sid, v in r["t_home_min"].items():
            if v is not None:
                provenance.record(f"t_home_min.{r['id']}.{sid}", v, "min", f, SCRIPT)
        for sid, a in r.get("access", {}).items():
            for k, u in (("dist_m", "m"), ("lon", "deg"), ("lat", "deg"), ("o2_home_L", "L")):
                if a.get(k) is not None:
                    provenance.record(f"access.{r['id']}.{sid}.{k}", a[k], u, f, SCRIPT)
            w = a.get("walk_in") or {}
            for k, u in (("rise_m", "m"), ("mean_slope_deg", "deg"), ("max_slope_deg", "deg"),
                         ("max_terrain_slope_deg", "deg")):  # fmt: skip
                if w.get(k) is not None:
                    provenance.record(f"access.{r['id']}.{sid}.walk_in.{k}", w[k], u, f, SCRIPT)
        if r["in_partner_line"] is not None:
            provenance.record(f"in_partner_line.{r['id']}", r["in_partner_line"], None, f,
                              SCRIPT)  # fmt: skip
    return st, recs, missing


def route_budget_min() -> float:
    spec = load("variants")["route"]["budget"]
    if spec != "crew.eva_h":
        raise ValueError(f"cannot parse variants.route.budget {spec!r}")
    return float(load("crew")["eva_h"]) * 60.0


def ridge_3m(ridge_index: np.ndarray, factor: int) -> np.ndarray:
    """Max-aggregate WS1's ridge_index (1 m) onto the routing grid: a 3 m cell is ridge if any
    of its 1 m cells is (haul.yaml mask_ridges). factor = route res / ridge res."""
    r = np.asarray(ridge_index, dtype=np.float64)
    if factor == 1:
        return r
    h, w = r.shape[0] // factor, r.shape[1] // factor
    r = np.where(np.isfinite(r), r, -np.inf)[: h * factor, : w * factor]
    return r.reshape(h, factor, w, factor).max(axis=(1, 3))


def trade_product(grid: Grid, pad, fields, partner_by_suit, station_list, settings: Settings,
                  public: Path = PUBLIC) -> dict | None:  # fmt: skip
    """trade_table.json (F11): rows = walkback budgets, cols = suit masses.

    science_value: sum of station values with conservative T_home <= budget (SPEC F11);
    reachable_pct: nominal variant, % of the assessed flat disc (as the headline);
    partner_area_km2: area of the partner line (haul.yaml contour_min, cart case, suited
    casualty at that suit). A cell whose input is missing stays null."""
    rows = settings.budgets
    cols = list(load("crew")["suit_masses_kg"])
    cmin = load("haul")["contour_min"]
    values = {s["id"]: s.get("value") for s in station_list}
    cells = {}
    for b in rows:
        for m in cols:
            con, nom = fields.get(f"con_{m}"), fields.get(f"nom_{m}")
            sv = None
            if con is not None and station_list and all(v is not None for v in values.values()):
                t_at = {s["id"]: _t_access(s, f"con_{m}", con) for s in station_list}
                sv = round(trade.science_value(t_at, values, b), 4)
            pct, cov = trade_pct(grid, None if nom is None else nom.t_min, pad, b, settings)
            area = None
            pt = partner_by_suit.get(m)
            if pt is not None:
                area = round(float(envelope.envelope_mask(pt, cmin).sum()) * grid.res_m**2
                             / 1e6, 4)  # fmt: skip
            cells[(b, m)] = {"science_value": sv, "reachable_pct": pct, "partner_area_km2": area}
            if cov is not None:
                cells[(b, m)]["in_data_pct"] = cov  # D41: share of the flat disc in the data
    tt = trade.table(rows, cols, cells)
    _write_web(public, "trade_table.json", tt, "trade_table.schema.json")
    for (b, m), c in cells.items():
        for k, u in (("science_value", "score"), ("reachable_pct", "%"),
                     ("partner_area_km2", "km2"), ("in_data_pct", "%")):  # fmt: skip
            if c.get(k) is not None:
                provenance.record(f"trade.{b}.{m}.{k}", c[k], u, "trade_table.json", SCRIPT)
    return tt


def trade_pct(grid: Grid, t_nom, pad, budget: float, settings: Settings):
    """(reachable %, in_data_pct or None) of a trade cell: nominal variant; at a D41 budget
    the in-data share and the disc's in-data size, else the strict rule."""
    if t_nom is None:
        return None, None
    in_data = int(budget) in in_data_budgets()
    pct = envelope.reachable_pct(grid, t_nom, pad, budget, settings.disc_speed_ms,
                                 in_data=in_data)  # fmt: skip
    cov = (round(envelope.disc_in_data_pct(grid, pad, budget, settings.disc_speed_ms), 1)
           if in_data else None)  # fmt: skip
    return (None if pct is None else round(float(pct), 1)), cov


def _t_access(s: dict, sid: str, f: dijkstra.Field) -> float:
    """T_home at the station's access cell in scenario sid (inf if none); falls back to the
    station cell when access.resolve has not run."""
    acc = s.get("access")
    if acc is None:
        return float(f.t_min[s["rc"]])
    a = acc.get(sid)
    return np.inf if a is None or a.t_home_min is None else float(a.t_home_min)


def conditions_inputs(t_dark_min: float | None, tau_dose_min: float | None, dose: str,
                      use_ws4: bool) -> dict:  # fmt: skip
    """Daylight and dose-leash margin terms: CLI values win; otherwise WS4's
    pipeline.conditions.margins (clock.json t_dark at the pad, rad.json leash tau at the storm
    peak or the latest rate). A term WS4 cannot provide stays None (left out of the margin)."""
    out = {"t_dark_min": t_dark_min, "t_dark_source": "CLI" if t_dark_min is not None else None,
           "tau_dose_min": tau_dose_min,
           "tau_dose_source": "CLI" if tau_dose_min is not None else None,
           "dose": dose}  # fmt: skip
    if use_ws4 and (t_dark_min is None or tau_dose_min is None):
        try:
            from pipeline.conditions.margins import margin_inputs

            ws4 = margin_inputs(None, dose)
        except (ImportError, FileNotFoundError, KeyError) as e:
            print(f"WS4 margins unavailable ({e!r}); missing terms are left out")
            return out
        for k in ("t_dark_min", "tau_dose_min"):
            if out[k] is None and ws4.get(k) is not None:
                out[k] = float(ws4[k])
                out[k.replace("_min", "_source")] = "WS4: " + str(ws4.get(
                    k.replace("_min", "_source")))  # fmt: skip
        out["eva_start_utc"] = ws4.get("eva_start_utc")
    return out


def storm_timing(cond: dict, rad_path: Path = INTERIM_DIR / "conditions" / "rad.json"):
    """D39 dose timing: a callable t* -> margin.DoseTiming (conditions.yaml storm_replay +
    WS4 rad.json), or None when the dose term is static (CLI --tau-dose-min, --dose latest) or
    conditions are off. Raises MissingInput if the shared key or rad.json is missing."""
    import json

    if cond.get("dose") != "storm" or cond.get("tau_dose_source") in (None, "CLI"):
        return None
    sr = load("conditions").get("storm_replay")
    if not sr:
        raise MissingInput("conditions.yaml storm_replay (D39 shared storm-timing key) missing")
    if not Path(rad_path).exists():
        raise MissingInput(f"{rad_path} missing (WS4)")
    rad = json.loads(Path(rad_path).read_text(encoding="utf-8"))

    def fn(t_star_min: float):
        return margin.dose_timing_from_ws4(t_star_min, rad, sr)

    fn.source = f"conditions.yaml storm_replay.tripwire_at={sr.get('tripwire_at')} + {rad_path}"
    return fn


def free_point_station(grid: Grid, p: physio.Params, settings=None):
    """D97 (WP2b): traverse.resolve_route's resolver for one scenario: (wid, lon, lat) -> the
    synthetic station dict of a free point: ``rc`` = its access cell under p's slope rule
    (waypoints.point_fields = padpick.station_fields, D48; the seed of its forward field),
    ``access_dist_m`` = the walk-in distance to it (padpick.access_cells, not modelled, as
    access.py), value 0 (no science scoring), dwell = stations.yaml dwell_min (the default
    station dwell). Raises waypoints.PointError for an invalid point. grid: the WS1 grid
    (point_fields applies p's no-go itself); settings: padpick.Settings (default config)."""
    from . import padpick, waypoints

    s = settings or padpick.settings_from_config()
    dwell = float(load("stations")["dwell_min"])

    def make(wid: str, lon: float, lat: float) -> dict:
        fwd, _rev = waypoints.point_fields(grid, lon, lat, p, s)
        rc = (int(fwd.seeds[0][0]), int(fwd.seeds[0][1]))
        dist = next(d for d, r, c in padpick.access_cells(grid, lon, lat, s.access_radius_m)
                    if (r, c) == rc)  # fmt: skip
        return {"id": wid, "lon": lon, "lat": lat, "rc": rc, "value": 0.0, "dwell_min": dwell,
                "access_dist_m": round(float(dist), 1)}  # fmt: skip

    return make


def plan_route(grid: Grid, pad, sid: str, field: dijkstra.Field, st: list[dict], cond: dict,
               dose_fn, partner_t=None, rmse=None, crew: dict | None = None, route=None,
               ) -> tuple[traverse.Result, dict]:  # fmt: skip
    """F9 route for one scenario and pad: access cells from ``field``, D28 EVA term, D39 timed
    dose term (dose_fn) or the static one. Returns (Result, no_access {id: reason}).
    route (D97): ordered stops (traverse.plan); a stop without an access cell in sid raises
    traverse.RouteStopError (route_point_unreachable; a free point: its waypoints code).
    Free points are resolved per scenario (``free_point_station``: the access cell depends on
    the scenario's slope rule)."""
    p = physio.scenario_params(sid, v1_rmse_deg=rmse, crew=crew)
    tau = None if dose_fn is not None else cond.get("tau_dose_min")
    mi = margin.inputs(p, cond.get("t_dark_min"), tau, eva=True)
    rst, no_access = access.routing_stations(st, sid)
    points = None
    if route is not None:
        traverse.resolve_route(route, rst, no_access)  # the stop's error code before any work
        points = free_point_station(grid, p)
    res = traverse.plan(grid.with_nogo(p.nogo_deg), physio.grade_table(p), field, pad, rst,
                        route_budget_min(), float(load("variants")["route"]["o2_checkpoint_min"]),
                        mi, partner_t, load("haul")["contour_min"], dose_fn=dose_fn,
                        route=route, point_station=points)  # fmt: skip
    res.unreachable = res.unreachable + list(no_access)
    return res, no_access


def route_summary(res: traverse.Result, no_access: dict, rst_access: dict | None = None) -> dict:
    rows = [e for e in res.timeline if e["event"] in ("arrive", "leave", "o2_checkpoint")]
    low = min(rows, key=lambda e: e["margin_min"]) if rows else None
    tbs = {e["station"]: {"t_min": e["t_min"], "binding": e["margin_binding"]}
           for e in res.timeline if e["event"] == "turn_back"}  # fmt: skip
    return {"order": res.order, "unreachable": res.unreachable, "no_access": no_access,
            "total_min": round(res.total_min, 2), "value": round(res.value, 4),
            "n_feasible_subsets": res.n_feasible_subsets, "margin_terms": res.margin_terms,
            "lowest_margin_min": None if low is None else low["margin_min"],
            "lowest_margin_binding": None if low is None else low["margin_binding"],
            "lowest_margin_at": None if low is None else [low["event"], low["station"],
                                                          low["t_min"]],
            "track_min_margin": res.track_min_margin, "turn_back": tbs, "dose": res.dose,
            "legs": [{k: lg[k] for k in ("from", "to", "t_min", "length_m")}
                     for lg in res.legs],
            "access_dist_m": rst_access or {}}  # fmt: skip


def record_model_checks(file: str, crew: dict | None = None) -> dict:
    """D30 IST-2 pass/miss rows and the D24 reserve (manifest; shown with the scorecard).
    crew: overrides (F26) for the reserve (30 min at the crew's effort cap)."""
    rows = physio.ist2_pass_rows()
    for v, gs in rows.items():
        for g, r in gs.items():
            gk = g.replace("grade_", "").replace("pct", "")
            provenance.record(f"physio.ist2.{v}.{gk}.pass", r["pass"], None, file, SCRIPT)
            for k in ("band_lo", "band_hi", "reported"):
                provenance.record(f"physio.ist2.{v}.{gk}.{k}", r[k], "mL/kg/min", file, SCRIPT)
    p = physio.scenario_params(load("variants")["scenarios"]["default"], crew=crew)
    res_l = round(margin.reserve_l(p), 2)
    provenance.record("margin.o2_reserve_L", res_l, "L", file, SCRIPT)
    provenance.record("margin.o2_budget_L", round(margin.o2_capacity_l(), 2), "L", file, SCRIPT)
    provenance.record("margin.station_task_rate_L_min", round(margin.station_task_rate_l_min(), 4),
                      "L/min", file, SCRIPT)  # fmt: skip
    return {"ist2": rows, "o2_reserve": {"L": res_l, "label": margin.reserve_label()},
            "o2_budget_L": round(margin.o2_capacity_l(), 2),
            "o2_energy_j_per_ml": margin.j_per_ml(),
            "station_task_rate_L_min": round(margin.station_task_rate_l_min(), 4)}  # fmt: skip


def main(argv=None) -> int:
    import copy
    import time

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--terrain", type=Path, default=INTERIM_DIR / "terrain")
    ap.add_argument("--scenarios", nargs="*", default=None)
    ap.add_argument("--out", type=Path, default=ENGINE_DIR,
                    help="engine output dir; web files go to <out>/public")
    ap.add_argument("--t-dark-min", type=float, default=None,
                    help="WS4 daylight: minutes from EVA start to dark (margin term)")  # fmt: skip
    ap.add_argument("--tau-dose-min", type=float, default=None,
                    help="static dose leash tau_dose, min (overrides the D39 storm timing)")
    ap.add_argument("--dose", choices=("storm", "latest"), default="storm",
                    help="storm (default): D39 timed storm replay; latest: static latest-RAD tau")
    ap.add_argument("--rad-json", type=Path, default=INTERIM_DIR / "conditions" / "rad.json")
    ap.add_argument("--no-conditions", action="store_true",
                    help="do not read WS4 margins (only the --t-dark-min/--tau-dose-min flags)")
    ap.add_argument("--route-scenarios", nargs="*", default=None,
                    help="scenarios to plan a traverse for (default: the default scenario)")
    ap.add_argument("--no-partner", action="store_true")
    ap.add_argument("--siting", action="store_true",
                    help="also run F8 siting (needs stations with values); writes pad.json")
    ap.add_argument("--siting-only", action="store_true",
                    help="re-run only F8 siting + pad.json: the rule scenario's return field "
                         "(in memory, no rasters), access cells, siting; patches summary.json")
    ap.add_argument("--pad", nargs=2, type=float, metavar=("LON", "LAT"), default=None,
                    help="pad override; default site.yaml pad_default (or the D21 pad)")
    ap.add_argument("--headline-patch", action="store_true",
                    help="D41 + user 17:28: patch the 60-min headline (in-data share) and the "
                         "per-pad excluded-combination counts into the published files only")
    ap.add_argument("--d21", action="store_true",
                    help="D21: screen every candidate pad, full runs for the top 5, run "
                         "everything on the official pad, write the pad picker")
    ap.add_argument("--stations-only", action="store_true",
                    help="D44: copy WS1's current station names into the published files only "
                         "(no recompute; refuses if a station moved)")
    a = ap.parse_args(argv)
    out, pub = a.out, a.out / "public"
    if a.stations_only:
        return stations_names_patch(a.terrain, pub)
    need = [a.terrain / f for f in ("elev_3m.tif", "maxslope_3m.tif", "cellstate_3m.tif",
                                    "slope_3m.tif", "stepguard_3m.tif")]  # fmt: skip
    if not all(f.exists() for f in need):
        print(f"engine: WS1 routing grids missing in {a.terrain}: "
              f"{[f.name for f in need if not f.exists()]}")
        return 2
    rmse = None  # D23: V1 no longer feeds the engine
    settings = settings_from_config(rmse)
    sids, skipped = runnable(a.scenarios or load("variants")["scenarios"]["ids"], rmse)
    for sid, why in skipped.items():
        print(f"skip {sid}: {why}")
    tick = time.perf_counter()
    timing: dict[str, float] = {}

    def lap(name):
        nonlocal tick
        now = time.perf_counter()
        timing[name] = round(now - tick, 1)
        tick = now
        print(f"{name}: {timing[name]} s", flush=True)

    grid = load_ws1_grid(a.terrain)
    lap("load_grid")
    if a.headline_patch:
        return headline_patch(grid, settings, pub)
    if a.siting_only:
        return siting_only(grid, pad_rc(grid, tuple(a.pad) if a.pad else None), a, rmse,
                           settings, out, pub)  # fmt: skip
    cond = conditions_inputs(a.t_dark_min, a.tau_dose_min, a.dose, not a.no_conditions)
    dose_fn = storm_timing(cond, a.rad_json)
    print(f"margins: t_dark {cond['t_dark_min']} min ({cond['t_dark_source']}); dose "
          f"{'timed (D39): ' + dose_fn.source if dose_fn else cond['tau_dose_min']}")
    st_ws1, missing_ws1, st0 = None, None, []
    if (a.terrain / "stations.json").exists():
        st_ws1, missing_ws1 = stations.load_ws1_stations(a.terrain / "stations.json")
        st0 = stations.attach_cells(grid, copy.deepcopy(st_ws1))

    d21 = None
    if a.d21:
        from . import padpick

        if a.pad:
            raise SystemExit("--d21 picks the pad; do not pass --pad")
        d21 = padpick.run(grid, st0, cond, dose_fn, timing_cb=lap)
        off = d21["official"]
        a.pad = [off.lon, off.lat]
        print(f"D21 official pad {off.id}: {off.lon}, {off.lat} (score {off.score}, "
              f"tb1 {off.tb1}, elev {off.elev_m})")
    from .plan import build_plan

    build_plan(grid, pad_lonlat=a.pad, scenario_ids=sids, settings=settings, out_dir=out,
               public_dir=pub, terrain_dir=a.terrain, stations_list=st_ws1,
               stations_missing=missing_ws1, cond=cond, dose_fn=dose_fn,
               route_scenarios=a.route_scenarios, partner=not a.no_partner, siting=a.siting,
               d21=d21, skipped=skipped, rmse=rmse, timing=timing)  # fmt: skip
    return 0


def load_ridge(terrain: Path, grid: Grid) -> np.ndarray:
    import rasterio

    with rasterio.open(terrain / "ridge_index.tif") as ds:
        ridge = ds.read(1, masked=True).filled(np.nan).astype(np.float64)
        factor = int(round(grid.res_m / ds.res[0]))
    return ridge_3m(ridge, factor)[: grid.shape[0], : grid.shape[1]]


if __name__ == "__main__":
    raise SystemExit(main())
