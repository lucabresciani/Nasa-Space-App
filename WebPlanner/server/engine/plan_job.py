"""Job type ``plan`` (WS11 plan rows 2.4 and 3.2, brief tasks 8-9 and 11; F23, F24, F26, F35; D76,
D81).

A plan for one pad with the default crew is ONE call of ``pipeline.engine.plan.build_plan``
(WS11 rule 1: no engine code here). ``build`` maps canonical plan_inputs to that call; the parity
harness (server/tests/parity_harness.py ``server_build``) calls the same function, so parity
tests exactly what the server runs.

Scenario set (D81, F26): the official pad with the default crew keeps the full official set
(variants.yaml scenarios.ids); any other pad or crew computes only the three variants at the
default scenario's suit mass (104 kg) ("the three variants always run").

Supported inputs: the pad (task 8) and the crew (task 11, server.engine.crew): body_mass_kg,
tools_kg, vo2max_ml_kg_min and effort_cap_frac go to build_plan's ``crew`` (physio.params
overrides, D48 crew-as-parameter); the default crew passes ``crew=None``, so its call and tree are
exactly the ones before task 11. An ordered route of stations (D97, server.engine.route; checked
at submit) goes to build_plan's ``route`` as the station ids in visiting order, in the preview and
the full call alike; a missing or auto route makes exactly the call before D97 (no ``route``
argument). crew.suit_kg (no build_plan path, server.engine.crew) and every other plan_inputs
field must equal its default (free points in a route: R4); otherwise the job fails with
``UnsupportedInputs`` naming the fields, never silently ignoring them. Inputs outside the config
ranges (config/backend.yaml ``ranges``) are reported as run-record ``range_flags``
(anchored_flag_note); nothing is clamped and the plan runs.

Station fields (F26, D84): a custom-crew job computes no crew station fields. build_plan takes no
precomputed station fields (its route runs its own station searches with the crew), so the E10
crew cache ($HL_SERVER_DATA/cache/station_fields/) cost ~42 s and ~280 MB per new crew for
nothing; it was removed. It returns when WS2 adds a station-field input to build_plan.

Route answer (D97): build_plan's summary ``route.feasibility[route.scenario]`` (the default
scenario's block; ``route.feasibility`` is keyed by scenario id) becomes the run record's
``feasibility``, mirrored to the v1.1 ``infeasible`` when false (binding = limit,
margin_min = -shortfall_min); ``route_mode`` is on every record. An infeasible order is a result:
the job ends ``done`` with the legs planned before the failing one. A stop the engine cannot route
at all (traverse.RouteStopError, e.g. route_point_unreachable) ends the job ``error`` with its
code and the stop named (``RouteStopFailed``).

Stages (D81: the map fills in early; job.schema.json ``stages_done``):
1. ``nominal``: a preview build_plan call with the default scenario only (partner line on, so the
   route is the final one), into a hidden scratch dir. Published: that scenario's isochrones,
   edges and partner line, its band file (nominal only, replaced in stage 2), route and
   timeline.
2. ``bands``: the full call's web products (every variant's isochrones and edges, the bands).
3. ``partner``: partner lines.
4. ``route``: stations.json, route, timeline, trade table, station cards (WS2's card part merged
   with the server data's WS3 horizon part by make web's merge_card; the parts themselves are
   not published).
5. ``summary``: the final scenarios/index.json and manifest.json (exactly the full call's index
   and the merge of its manifest fragments), exporter files (server.engine.exporters, D76), then
   the runner writes run_record.json last.
Staged index and manifest (H5-1, D81; orchestrator decision E8c): the client finds every map file
through scenarios/index.json and every number through manifest.json, so after each of stages 1-4
the job writes a PARTIAL scenarios/index.json and manifest.json (``_publish_partial``) that list
only what the tree holds so far and validate against the same contracts:
- index: the engine's own index of the latest call (the preview's after stage 1, the full call's
  once its web products exist), unmodified, published only when every file of every scenario it
  lists is already in the tree; otherwise the previous index stays;
- manifest: the entries of the preview's and the full call's manifest fragments (the full call's
  win) whose ``file`` is in the tree with the bytes that call wrote (a merged card: present).
A file is copied into the job tree only when its bytes changed, so a file of stage 1 that the full
call reproduces byte for byte is published once; the files written more than once are
scenarios/index.json, manifest.json and the band file. Every write is atomic (temp file plus
rename). Files of a tree without run_record.json are served with ``Cache-Control: no-store``
(server.api.compute.results), so a partial or rewritten file is never cached; once the run record
exists the tree is immutable.

World: ``$HL_SERVER_DATA/terrain`` (make serverdata's copy of the WS1 grids and stations.json).
WS4 margin inputs are on when ``$HL_SERVER_DATA/conditions`` exists; the engine reads them from
data/interim/conditions (scenarios.conditions_inputs has no root parameter), so the job checks
those files are byte-identical to the server data copies (covered by the terrain hash) and that
both margin terms resolved; otherwise it fails.
"""

from __future__ import annotations

import filecmp
import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path

from server.engine import crew as crew_mod
from server.engine import exporters, version
from server.engine import route as route_mod
from server.engine.defaults import ranges as config_ranges
from server.engine.hashing import canonical_inputs, official_inputs
from server.engine.jobs import JobContext, JobType, register_job_type

STAGES = ("nominal", "bands", "partner", "route", "summary")
# build_plan stage (pipeline/engine/plan.py on_stage) after which a job stage is published
AT_BUILD_STAGE = {"web_products": "bands", "partner": "partner", "trade": "route"}
CARD_PART = "cards/{S}.timeline.json"  # WS2's card part (cards.write); merged, never published
INDEX = "scenarios/index.json"
HELD = (INDEX,)  # published by _publish_partial (once its files exist) and at summary
MANIFEST = "manifest.json"
WORK = ".work"  # hidden scratch dir inside the job's temp dir (never published or served)
CONDITION_FILES = ("clock.json", "rad.json")  # what scenarios.conditions_inputs/storm_timing read

# plan_inputs dotted key -> config/backend.yaml ranges key (F26, F25)
RANGE_KEYS = {
    "crew.body_mass_kg": "body_mass_kg",
    "crew.suit_kg": "suit_kg",
    "crew.tools_kg": "tools_kg",
    "crew.vo2max_ml_kg_min": "vo2max_ml_kg_min",
    "crew.effort_cap_frac": "effort_cap_frac",
    "eva.duration_h": "eva_duration_h",
    "eva.reserve_min": "reserve_min",
    "eva.start_lmst_h": "start_lmst_h",
    "eva.walkback_budgets_min": "walkback_budget_min",
    "conditions.d_allow_mgy": "d_allow_mgy",
    "stations.dwell_min": "dwell_min",
}


class UnsupportedInputs(ValueError):
    """plan_inputs fields this server cannot plan yet (not silently ignored)."""


class RouteStopFailed(ValueError):
    """D97: a stop of the ordered route the engine cannot route at all (its traverse
    .RouteStopError: ``code``, ``stop`` index); the job ends ``error`` with this message."""

    def __init__(self, code: str, stop: int, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code, self.stop = code, stop


# ------------------------------------------------------------------------ inputs ----
def _official() -> dict:
    return canonical_inputs(official_inputs())


def is_official_pad(inputs: dict) -> bool:
    pad, off = canonical_inputs(inputs)["pad"], _official()["pad"]
    return (pad["lon"], pad["lat"]) == (off["lon"], off["lat"])


def _route_planned(c: dict) -> bool:
    """An ordered route of stations (D97): planned, so not a difference from the defaults."""
    return route_mod.mode(c) == route_mod.ORDERED and not any(
        route_mod.is_free(s) for s in c["route"]["stops"])


def unsupported(inputs: dict) -> list[str]:
    """Top-level plan_inputs blocks (other than the pad, the crew and an ordered route of
    stations) that differ from the defaults, and the dotted crew fields build_plan has no
    parameter for (crew.suit_kg)."""
    c, d = canonical_inputs(inputs), _official()
    planned = {"pad", "crew", "contract_version"} | ({"route"} if _route_planned(c) else set())
    blocks = sorted(k for k in set(c) | set(d) if k not in planned and c.get(k) != d.get(k))
    return sorted(blocks + crew_mod.unsupported(inputs))


def scenario_set(inputs: dict) -> list[str]:
    """D81: the official pad with the default crew keeps the official set; any other pad or crew
    gets the default suit's three variants (F26: the three variants always run)."""
    from pipeline.engine import physio
    from pipeline.engine.config import load

    sc = load("variants")["scenarios"]
    if is_official_pad(inputs) and crew_mod.is_default(inputs):
        return list(sc["ids"])
    suit = physio.parse_scenario(sc["default"])[1]
    return [s for s in sc["ids"] if physio.parse_scenario(s)[1] == suit]


def range_flags(inputs: dict) -> list[dict]:
    """F26: every numeric input outside its config range, flagged (never clamped)."""
    r = config_ranges()
    note = r["anchored_flag_note"]
    c = canonical_inputs(inputs)
    flags = []
    for dotted, rkey in RANGE_KEYS.items():
        block, field = dotted.split(".")
        v = c.get(block, {}).get(field)
        lim = r.get(rkey)
        if v is None or not isinstance(lim, dict):
            continue
        items = (sorted(v.items()) if isinstance(v, dict)
                 else enumerate(v) if isinstance(v, list) else [(None, v)])
        for sub, x in items:
            if not isinstance(x, (int, float)):
                continue
            if ("min" in lim and x < lim["min"]) or ("max" in lim and x > lim["max"]):
                key = dotted if sub is None else f"{dotted}.{sub}"
                flags.append({"key": key, "value": float(x), "note": str(note)})
    return flags


# ------------------------------------------------------------------ build_plan call ----
def build(inputs: dict, *, terrain_dir: Path, out_dir: Path, public_dir: Path | None = None,
          manifest_dir: Path, conditions: bool, rad_json: Path, grid=None, preview: bool = False,
          on_stage=None) -> dict:
    """Canonical plan_inputs -> one build_plan call (the server path; parity calls this).

    ``preview``: only the default scenario (the job's nominal stage). An ordered route passes
    ``route=[station ids in visiting order]``; auto passes no ``route`` (the pre-D97 call).
    Returns the run summary."""
    from pipeline.engine import scenarios
    from pipeline.engine.config import load
    from pipeline.engine.graph import load_ws1_grid
    from pipeline.engine.physio import MissingInput
    from pipeline.engine.plan import build_plan

    bad = unsupported(inputs)
    if bad:
        raise UnsupportedInputs(f"plan_inputs {bad} differ from the defaults; this server plans "
                                "a custom pad and crew (body mass, tools, VO2max, effort cap) "
                                "with the default suit mass, and a route of stations (D97)")
    c = canonical_inputs(inputs)
    pad = c["pad"]
    ids_route = route_mod.station_ids(c)
    route_kw = {} if ids_route is None else {"route": ids_route}
    grid = load_ws1_grid(terrain_dir) if grid is None else grid
    ids = [load("variants")["scenarios"]["default"]] if preview else scenario_set(inputs)
    sids, skipped = scenarios.runnable(ids, None)
    # plan_inputs conditions.storm "2024-05-20" = the D39 timed storm replay (--dose storm)
    cond = scenarios.conditions_inputs(None, None, "storm", conditions)
    if conditions and (cond.get("t_dark_min") is None or cond.get("tau_dose_min") is None):
        raise MissingInput(f"WS4 margin inputs did not resolve: {cond}")
    dose_fn = scenarios.storm_timing(cond, rad_json)
    return build_plan(grid, pad_lonlat=(pad["lon"], pad["lat"]), scenario_ids=sids,
                      settings=scenarios.settings_from_config(None), out_dir=out_dir,
                      public_dir=public_dir if public_dir is not None else out_dir / "public",
                      terrain_dir=terrain_dir, cond=cond, dose_fn=dose_fn, partner=True,
                      siting=False, d21=None, crew=crew_mod.overrides(inputs),
                      skipped=skipped, rmse=None,
                      manifest_dir=manifest_dir, on_stage=on_stage, verbose=False, **route_kw)


def route_answer(inputs: dict, summary: dict | None) -> dict:
    """Run record ``route_mode``, ``feasibility`` and the v1.1 ``infeasible`` mirror (D97) from
    the full call's summary: ``route.feasibility[route.scenario]``. Auto: route_mode only (the
    engine's own choice keeps every margin; infeasible stays null as before)."""
    m = route_mod.mode(canonical_inputs(inputs))
    if m != route_mod.ORDERED:
        return {"route_mode": m}
    block = (summary or {}).get("route") or {}
    feas = (block.get("feasibility") or {}).get(block.get("scenario"))
    if not isinstance(feas, dict) or "feasible" not in feas:
        raise RuntimeError(f"build_plan summary has no route feasibility for an ordered route: "
                           f"{(summary or {}).get('route')!r}")
    out = {"route_mode": m, "feasibility": feas}
    if feas["feasible"] is False:
        out["infeasible"] = {"leg": feas["leg"], "from": feas["from"], "to": feas["to"],
                             "margin_min": -float(feas["shortfall_min"]),
                             "binding": feas["limit"]}
    return out


def _route_stop_error():
    """pipeline.engine.traverse.RouteStopError (R1), or no exception class before it exists."""
    from pipeline.engine import traverse

    return getattr(traverse, "RouteStopError", ())


def _build_job(inputs: dict, **kw) -> dict:
    """``build`` with a stop the engine cannot route turned into RouteStopFailed naming it."""
    try:
        return build(inputs, **kw)
    except _route_stop_error() as e:
        stops = canonical_inputs(inputs)["route"]["stops"]
        i = int(e.index)
        name = route_mod.stop_name(stops, i) if 0 <= i < len(stops) else "?"
        raise RouteStopFailed(e.code, i, f"stop {i} ({name}): {e.message}") from e


def nominal_files(public: Path) -> list[str]:
    """The default scenario's own files in a preview tree (stage ``nominal``)."""
    from pipeline.engine import physio
    from pipeline.engine.config import load

    default = load("variants")["scenarios"]["default"]
    suit = physio.parse_scenario(default)[1]
    keep = (f"scenarios/{default}/", f"scenarios/bands_{suit}.", f"route_{default}.",
            f"timeline_{default}.")
    return sorted(rel for rel in _files(public) if rel.startswith(keep))


def _files(root: Path) -> list[str]:
    """Every file under ``root`` except WS2's card parts (published as merged cards)."""
    part = re.compile(re.escape(CARD_PART).replace(re.escape("{S}"), "[^/]+") + "$")
    return sorted(rel for p in root.rglob("*") if p.is_file()
                  and not part.match(rel := p.relative_to(root).as_posix()))


def _cards(ctx: JobContext, public: Path, horizon_dir: Path) -> list[str]:
    """cards/{S}.json = WS2's card part (this pad's route) merged with WS3's horizon part from
    the server data (make serverdata's cards/), by make web's own merge (tools.make_web
    .merge_card: nothing computed). A station without a horizon part gets no card."""
    from tools.make_web import merge_card

    written = []
    for part in sorted(public.glob(CARD_PART.format(S="*"))):
        st = part.name.split(".")[0]
        hz = horizon_dir / f"{st}.json"
        if not hz.is_file():
            continue
        doc = merge_card(st, json.loads(hz.read_text(encoding="utf-8")),
                         json.loads(part.read_text(encoding="utf-8")))
        rel = f"cards/{st}.json"
        data = (json.dumps(doc, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
        if not (ctx.path(rel).is_file() and ctx.path(rel).read_bytes() == data):
            ctx.write_bytes(rel, data)
        written.append(rel)
    return written


def _copy(ctx: JobContext, src_root: Path, rels) -> None:
    """Copy files into the job tree, skipping any whose bytes are already there."""
    for rel in rels:
        src, dst = src_root / rel, ctx.path(rel)
        if dst.is_file() and filecmp.cmp(src, dst, shallow=False):
            continue
        ctx.write_bytes(rel, src.read_bytes())


def _index_ready(ctx: JobContext, src_pub: Path) -> bytes | None:
    """The bytes of ``src_pub``'s scenarios/index.json if every file of every scenario it lists is
    already in the job tree (so the client never follows the index to a missing file)."""
    src = src_pub / INDEX
    if not src.is_file():
        return None
    data = src.read_bytes()
    need = {f for s in json.loads(data)["scenarios"] for f in s["files"].values()}
    return data if all(ctx.path(f).is_file() for f in need) else None


def partial_manifest(ctx: JobContext, sources: list[tuple[Path, Path]]) -> dict:
    """The manifest of what the job tree holds now: the entries of each (fragment dir, public dir)
    source, later sources winning, whose ``file`` is in the tree with the bytes that source wrote
    (a file the source did not write itself, i.e. a merged card, only has to be present)."""
    from pipeline.provenance import manifest

    backed: dict[tuple[Path, str], bool] = {}

    def ok(src_pub: Path, rel: str) -> bool:
        if (src_pub, rel) not in backed:
            try:
                dst = ctx.path(rel)
            except LookupError:  # not a servable path: never in the tree
                backed[(src_pub, rel)] = False
                return False
            src = src_pub / rel
            backed[(src_pub, rel)] = dst.is_file() and (
                not src.is_file() or filecmp.cmp(src, dst, shallow=False))
        return backed[(src_pub, rel)]

    entries: dict = {}
    for frag_dir, src_pub in sources:
        for frag in manifest.load_fragments(frag_dir).values():
            entries.update({k: e for k, e in frag.items() if ok(src_pub, e.get("file", ""))})
    doc = {"dummy": False, **dict(sorted(entries.items()))}
    manifest.validate(doc)
    return doc


def _publish_partial(ctx: JobContext, index_src: Path, sources: list[tuple[Path, Path]]) -> None:
    """Stages 1-4 (H5-1): a partial scenarios/index.json and manifest.json, each written
    (atomically) only when its bytes change."""
    index = _index_ready(ctx, index_src)
    if index is not None and not (ctx.path(INDEX).is_file()
                                  and ctx.path(INDEX).read_bytes() == index):
        ctx.write_bytes(INDEX, index)
    doc = partial_manifest(ctx, sources)
    data = (json.dumps(doc, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
    if not (ctx.path(MANIFEST).is_file() and ctx.path(MANIFEST).read_bytes() == data):
        ctx.write_bytes(MANIFEST, data)


def _check_conditions(cond_dir: Path) -> Path:
    """The engine reads WS4 margins from data/interim/conditions: they must be the server data's
    copies (which the terrain hash covers). Returns the rad.json the dose timing reads."""
    from pipeline.engine.scenarios import INTERIM_DIR

    for name in CONDITION_FILES:
        a, b = INTERIM_DIR / "conditions" / name, cond_dir / name
        if not (a.is_file() and b.is_file() and filecmp.cmp(a, b, shallow=False)):
            raise RuntimeError(f"WS4 {name}: {a} and {b} must exist and be identical (the "
                               "engine reads the first, the result hash covers the second)")
    return cond_dir / "rad.json"


def _utc() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def export_context(inputs: dict, answer: dict, grid, sd: Path, full: Path) -> dict:
    """What the exporters (D76, D110 mission.json) get beside the tree: the record inputs, the
    route feasibility, the engine's DEM and the default scenario's WS2 fields (the full call's
    rasters, still in the job's scratch dir) and the routing grid size."""
    from pipeline.engine.config import load

    default = load("variants")["scenarios"]["default"]
    rasters = {"elev": sd / "terrain" / "elev_3m.tif", "t_home": full / default / "t_home.tif",
               "o2_home": full / default / "o2_home.tif"}
    return {"inputs": inputs, "feasibility": answer.get("feasibility"),
            "rasters": {k: p for k, p in rasters.items() if p.is_file()},
            "routing_grid_res_m": float(grid.res_m),
            "conditions_dir": sd / "conditions" if (sd / "conditions").is_dir() else None}


# ------------------------------------------------------------------------- the job ----
def run_plan_job(inputs: dict, ctx: JobContext) -> dict:
    """Job handler (server.engine.jobs JobType.run; runs in a worker process)."""
    from pipeline.engine.graph import load_ws1_grid
    from pipeline.provenance import manifest

    sd = version.server_data_dir()
    terrain = sd / "terrain"
    cond_dir = sd / "conditions"
    conditions = cond_dir.is_dir()
    rad = _check_conditions(cond_dir) if conditions else cond_dir / "rad.json"
    flags = range_flags(inputs)
    work = ctx.out_dir / WORK
    grid = load_ws1_grid(terrain)
    common = dict(terrain_dir=terrain, conditions=conditions, rad_json=rad, grid=grid)

    # 1. nominal: the default scenario alone (preview call), published at once with a partial
    # index and manifest (H5-1: the client finds the map files through them)
    pre, pre_pub, pre_man = work / "preview", work / "preview" / "public", work / "preview_manifest"
    _build_job(inputs, out_dir=pre, public_dir=pre_pub, manifest_dir=pre_man, preview=True,
               **common)
    _copy(ctx, pre_pub, nominal_files(pre_pub))
    _publish_partial(ctx, pre_pub, [(pre_man, pre_pub)])
    ctx.stage("nominal")

    # 2-4. the full call, published as build_plan's stages finish
    full, pub = work / "full", work / "full" / "public"

    def flush(upto: str) -> None:
        _copy(ctx, pub, [f for f in _files(pub) if f not in HELD])
        _cards(ctx, pub, sd / "cards")
        _publish_partial(ctx, pub, [(pre_man, pre_pub), (work / "manifest", pub)])
        for name in STAGES[len(ctx.done):STAGES.index(upto) + 1]:
            ctx.stage(name)

    def on_stage(name: str, _files_changed) -> None:
        if name in AT_BUILD_STAGE and AT_BUILD_STAGE[name] not in ctx.done:
            flush(AT_BUILD_STAGE[name])

    summary = _build_job(inputs, out_dir=full, public_dir=pub, manifest_dir=work / "manifest",
                         on_stage=on_stage, **common)
    if len(ctx.done) < STAGES.index("summary"):  # a build_plan stage was skipped (no stations)
        flush(STAGES[STAGES.index("summary") - 1])

    # 5. summary: the final index (the full call's), exporters (D76), the final manifest.json (the
    # merge of the full call's fragments), then the runner's run record
    _copy(ctx, pub, _files(pub))
    _cards(ctx, pub, sd / "cards")
    answer = route_answer(inputs, summary)
    extra = exporters.run_exporters(ctx.out_dir, manifest.git_commit(), _utc(),
                                    context=export_context(inputs, answer, grid, sd, full))
    merged = manifest.merge(work / "manifest", out_path=work / MANIFEST)
    if extra:
        dup = sorted(set(extra) & set(merged))
        if dup:
            raise RuntimeError(f"exporter manifest keys clash with the engine's: {dup}")
        merged = {**merged, **extra}
        manifest.validate(merged)
    ctx.write_json(MANIFEST, merged)
    ctx.stage("summary")
    shutil.rmtree(work, ignore_errors=True)
    return {"range_flags": flags, **answer}


PLAN_JOB = JobType(run=run_plan_job, stages=STAGES)
register_job_type("plan", PLAN_JOB)
