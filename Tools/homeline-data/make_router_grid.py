"""Writes HomelineData/router: what the simulator needs to re-route a plan after a station is moved by hand.

  elev3.f32    3 m routing-grid elevation, float32, row 0 = north; -9999 = impassable in the planner's
               cellstate_nominal grid. Elevation = mean of the nine 1 m heights where the world pack has near
               chunks (the engine's own definition), elsewhere bilinear from the 8 m far grid (about 2 % error
               on leg times there).
  grade.f64    the planner's grade table: pace (s/m) then O2 (L/m), float64, inf beyond the slope limit.
  router.json  grid geometry, table geometry, provenance.

Derived from the planner's simulator bundle (world_pack.zip, plan_bundle.zip) and the planner's physio_core.py,
both read-only. Run:  python -I Tools/homeline-data/make_router_grid.py
Environment: HOMELINE_BUNDLE_DIR, HOMELINE_PLANNER, HOMELINE_PYDEPS (see router_common.py). Needs numpy.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import router_common as rc  # noqa: E402  (adds HOMELINE_PYDEPS to the path)
import numpy as np  # noqa: E402

out = os.path.join(os.path.dirname(rc.BUNDLE_DIR.rstrip("/")), "router")
os.makedirs(out, exist_ok=True)

w, cs, gcs, far, gfar, _, _ = rc.load_world()
elev, exact = rc.build_elev3(w, gcs, far, gfar)
pb = rc.Zip("plan_bundle.zip")
core, p, tab = rc.planner_params(pb.json("config_snapshot.json"))

e = elev.astype("<f4")
e[cs != 0] = rc.NODATA
e.tofile(os.path.join(out, "elev3.f32"))
np.concatenate([np.asarray(tab.pace_s_per_m, dtype="<f8"), np.asarray(tab.o2_l_per_m, dtype="<f8")]).tofile(
    os.path.join(out, "grade.f64"))
finite = np.isfinite(tab.pace_s_per_m)
meta = {
    "rows": int(gcs["shape"][0]), "cols": int(gcs["shape"][1]), "cell_m": float(gcs["cell_m"]),
    "origin_m": [float(gcs["origin_m"][0]), float(gcs["origin_m"][1])], "nodata": rc.NODATA,
    "grade_th0_deg": float(tab.theta_deg[0]), "grade_step_deg": float(tab.step_deg),
    "grade_n": int(len(tab.pace_s_per_m)), "min_pace_s_per_m": float(np.min(tab.pace_s_per_m[finite])),
    "scenario": "nom_104", "variant": p.variant, "carried_kg": p.carried_kg,
    "exact_elevation_share": float(exact.mean()),
    "source": "planner world_pack.zip (cellstate_nominal, near chunks, far grid) + plan_bundle.zip config_snapshot.json"
              " + planner physio_core.grade_table; written by Tools/homeline-data/make_router_grid.py",
}
with open(os.path.join(out, "router.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=1)
print("wrote", out, "grid", meta["rows"], "x", meta["cols"], "passable", int((cs == 0).sum()),
      "grade table", meta["grade_n"])
