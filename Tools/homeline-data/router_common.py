"""Loaders for make_router_grid.py: the planner's world pack and plan bundle (read-only) and the planner's
physiology module (physio_core.py of a home-line checkout, read-only). Paths come from the environment:
HOMELINE_BUNDLE_DIR (folder with plan_bundle.zip and world_pack.zip), HOMELINE_PLANNER (home-line checkout).
"""
import sys, os, json, zipfile, math

sys.dont_write_bytecode = True  # never write __pycache__ into the read-only planner checkout
HERE = os.path.dirname(os.path.abspath(__file__))

if os.environ.get("HOMELINE_PYDEPS"):  # optional folder with numpy (pip install --target)
    sys.path.insert(0, os.environ["HOMELINE_PYDEPS"])
import numpy as np  # noqa: E402

BUNDLE_DIR = os.path.abspath(os.environ.get("HOMELINE_BUNDLE_DIR", os.path.join(HERE, "..", "..", "HomelineData", "bundle"))) + "/"
PLANNER = os.environ.get("HOMELINE_PLANNER", os.path.join(HERE, "..", "..", "..", "home-line"))
NODATA = -9999.0

# the planner's stencil (graph.py OFFSETS == pointer.f32 "stencil")
OFFSETS = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1),
           (-2, -1), (-2, 1), (2, -1), (2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2)]


def crossings():
    """graph.py _crossings(): cells (relative to the move's ORIGIN) the segment passes through."""
    out = []
    for di, dj in OFFSETS:
        if abs(di) == 1 and abs(dj) == 1:
            cells = [(di, 0), (0, dj)]
        elif abs(di) == 2:
            cells = [(di // 2, 0), (di // 2, dj)]
        elif abs(dj) == 2:
            cells = [(0, dj // 2), (di, dj // 2)]
        else:
            cells = []
        out.append(cells)
    return out


CROSS = crossings()
UNIT_LEN = [math.hypot(a, b) for a, b in OFFSETS]


class Zip:
    def __init__(self, name):
        self.z = zipfile.ZipFile(BUNDLE_DIR + name)
        self.index = json.loads(self.z.read("index.json"))
        self.files = {f["path"]: f for f in self.index["files"]}

    def grid(self, path):
        g = self.files[path]["grid"]
        a = np.frombuffer(self.z.read(path), dtype="<f4").reshape(g["shape"])
        return a, g

    def json(self, path):
        return json.loads(self.z.read(path))


def load_world():
    w = Zip("world_pack.zip")
    cs, gcs = w.grid("terrain/cellstate_nominal.f32")
    far, gfar = w.grid("terrain/far.f32")
    slope5, gs5 = w.grid("terrain/slope.f32")
    return w, cs, gcs, far, gfar, slope5, gs5


def build_elev3(w, gcs, far, gfar, use_near=True):
    """3 m routing-grid elevation (areoid m, float64) from the world pack.

    exact[r, c] = True where all nine 1 m heights of the cell come from near chunks (block mean, the engine's
    own definition of elev_3m.tif: pipeline/terrain/routing.py cell_grids, elev = mean of the nine 1 m cells).
    Elsewhere: bilinear interpolation of the 8 m far grid (area means) at the 3 m cell centre.
    """
    H, W = gcs["shape"]
    res = gcs["cell_m"]
    gx0, gy0 = gcs["origin_m"]
    # far bilinear at cell centres
    fx0, fy0 = gfar["origin_m"]
    fres = gfar["cell_m"]
    FH, FW = gfar["shape"]
    xc = gx0 + (np.arange(W) + 0.5) * res
    yc = gy0 - (np.arange(H) + 0.5) * res
    u = (xc - fx0) / fres - 0.5
    v = (fy0 - yc) / fres - 0.5
    c0 = np.clip(np.floor(u).astype(np.int64), 0, FW - 2)
    r0 = np.clip(np.floor(v).astype(np.int64), 0, FH - 2)
    wu = np.clip(u - c0, 0.0, 1.0)
    wv = np.clip(v - r0, 0.0, 1.0)
    f = far.astype(np.float64)
    top = f[r0][:, c0] * (1 - wu)[None, :] + f[r0][:, c0 + 1] * wu[None, :]
    bot = f[r0 + 1][:, c0] * (1 - wu)[None, :] + f[r0 + 1][:, c0 + 1] * wu[None, :]
    elev = top * (1 - wv)[:, None] + bot * wv[:, None]
    exact = np.zeros((H, W), dtype=bool)
    if not use_near:
        return elev, exact
    ssum = np.zeros((H, W), dtype=np.float64)
    cnt = np.zeros((H, W), dtype=np.int32)
    k = int(round(res))
    for path, fmeta in w.files.items():
        if not path.startswith("terrain/near/"):
            continue
        a, g = w.grid(path)
        ox, oy = g["origin_m"]
        gc0 = int(round(ox - gx0))
        gr0 = int(round(gy0 - oy))
        rr = (gr0 + np.arange(a.shape[0]))
        cc = (gc0 + np.arange(a.shape[1]))
        okr = (rr >= 0) & (rr < H * k)
        okc = (cc >= 0) & (cc < W * k)
        sub = a[okr][:, okc].astype(np.float64)
        R3 = (rr[okr] // k)[:, None] + np.zeros((1, okc.sum()), dtype=np.int64)
        C3 = (cc[okc] // k)[None, :] + np.zeros((okr.sum(), 1), dtype=np.int64)
        np.add.at(ssum, (R3, C3), sub)
        np.add.at(cnt, (R3, C3), 1)
    exact = cnt == k * k
    elev[exact] = ssum[exact] / (k * k)
    return elev, exact


def planner_params(cfg, variant="nominal", suit_kg=104.0):
    """physio.params() of the planner, fed from the bundle's config_snapshot.json (not the checkout's yaml)."""
    sys.path.insert(0, os.path.join(PLANNER, "pipeline", "engine"))
    import physio_core as core  # stdlib + numpy only (D48)
    crew, var = cfg["files"]["crew.yaml"], cfg["files"]["variants.yaml"]
    v = var["variants"][variant]
    ist2 = var["ist2"]
    ws = ist2["weight_span"]
    span = (ws["g_frac"][1] - ws["g_frac"][0]) * ist2["g_earth_ms2"] * (ws["system_kg"] + ws["subject_kg"]) / crew["g_mars"]
    alpha = ist2["level_increment_ml_kg_min"] / (span * crew["anchor"]["speed_ms"])
    table = sorted(crew["v_safe_ms"], key=lambda r: r["max_deg"])
    p = core.Params(
        variant=variant, eta=float(v["eta"]), V0=float(v["V0"]), a_mult=float(v["a_mult"]),
        nogo_deg=float(v["nogo_deg"]), m_b=float(crew["body_mass_kg"]),
        carried_kg=float(suit_kg) + float(crew["tools_kg"]), g=float(crew["g_mars"]),
        vo2max=float(crew["vo2max_ml_kg_min"]), effort_cap=float(crew["effort_cap_frac"]),
        anchor_vo2=float(crew["anchor"]["vo2_ml_kg_min"]), anchor_speed=float(crew["anchor"]["speed_ms"]),
        anchor_carried_kg=float(crew["anchor"]["carried_kg"]), alpha=alpha,
        j_per_ml=float(crew["o2_energy_j_per_ml"]),
        vsafe_max_deg=tuple(float(r["max_deg"]) for r in table), vsafe_v=tuple(float(r["v"]) for r in table),
        minetti_coef=(280.5, -58.7, -76.8, 51.9, 19.6, 2.5), downhill_clamp=(0.4, 3.0))
    step = float(var["numerics"]["grade_table_step_deg"])
    return core, p, core.grade_table(p, step)


def field_cells(g5, g3):
    """For each 5 m field pixel, the 3 m routing cell under its centre (fields_png.sample_centres)."""
    H5, W5 = g5["shape"]
    x = g5["origin_m"][0] + (np.arange(W5) + 0.5) * g5["cell_m"]
    y = g5["origin_m"][1] - (np.arange(H5) + 0.5) * g5["cell_m"]
    c3 = np.floor((x - g3["origin_m"][0]) / g3["cell_m"]).astype(np.int64)
    r3 = np.floor((g3["origin_m"][1] - y) / g3["cell_m"]).astype(np.int64)
    return r3, c3


def rc_of_xy(g, x, y):
    return (int(math.floor((g["origin_m"][1] - y) / g["cell_m"])), int(math.floor((x - g["origin_m"][0]) / g["cell_m"])))


def xy_of_rc(g, r, c):
    return (g["origin_m"][0] + (c + 0.5) * g["cell_m"], g["origin_m"][1] - (r + 0.5) * g["cell_m"])
