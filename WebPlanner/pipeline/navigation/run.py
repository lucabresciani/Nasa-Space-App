"""WS9 navigation driver (F21, F22 exports).

``python -m pipeline.navigation.run skyline [--limit N]`` runs F22 on every WS3 Navcam frame
(standalone prior; every frame reported in ``skyline_report.json``).

``python -m pipeline.navigation.run real [--dry-run] [--scenario SC] [--no-skyline]`` runs the
real route (WS2 route + timeline + T_home, WS1 slope; skyline fixes from ``skyline_report.json``,
computed first if absent) into data/interim/navigation/, the tree ``make web`` copies; see
``pipeline/navigation/real.py``.

``python -m pipeline.navigation.run synthetic --out data/interim/nav_synthetic [--runs N]``
writes ``nav/montecarlo_{set}.json``, ``nav/tracks_{set}.geojson`` and ``nav/fixes.json`` for a
synthetic loop (pad -> 600 m N -> 900 m E -> 1,400 m S -> pad, the docs/dummy.md station
geometry; dwell from stations.yaml; walking speed from crew.yaml; fixes at the pad and every
station with nav.yaml fix_sigma_m). Synthetic outputs carry ``"synthetic": true`` (``make web``
refuses them) and must never be written to ``web/public/data/``; no manifest entries are recorded
for them.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.navigation import deadreckon as dr
from pipeline.navigation import montecarlo as mc

PUBLIC = (dr.REPO / "web" / "public" / "data").resolve()

# docs/dummy.md station geometry (synthetic): 600 m N, 900 m E, 1,400 m S of the pad
SYNTH_STATIONS = [("SYN1", (0.0, 600.0)), ("SYN2", (900.0, 0.0)), ("SYN3", (0.0, -1400.0))]


def _check_out(out: Path) -> Path:
    out = Path(out).resolve()
    if out == PUBLIC or PUBLIC in out.parents:
        raise ValueError("synthetic outputs must not go to web/public/data/ (use data/interim/)")
    return out


def synthetic_loop():
    """Synthetic loop route and its fix events (rover at t = 0, each station on arrival)."""
    cfg = dr.load_config()
    speed = dr.walking_speed_ms()
    dwell_s = float(dr._yaml("stations")["dwell_min"]) * 60.0
    pts = [(0.0, 0.0)] + [p for _, p in SYNTH_STATIONS] + [(0.0, 0.0)]
    dwell = {i + 1: dwell_s for i in range(len(SYNTH_STATIONS))}
    traj = dr.piecewise_route(pts, speed, dwell_s=dwell, label="synthetic_loop")
    fixes = [dr.FixEvent(0.0, "rover", float(cfg["fix_sigma_m"]["rover"]))]
    t = 0.0
    prev = pts[0]
    for i, (sid, p) in enumerate(SYNTH_STATIONS):
        t += ((p[0] - prev[0]) ** 2 + (p[1] - prev[1]) ** 2) ** 0.5 / speed
        fixes.append(dr.FixEvent(round(t / 60.0, 6), "station",
                                 float(cfg["fix_sigma_m"]["station"]), station=sid))
        t += dwell[i + 1]
        prev = p
    return traj, fixes


def synthetic(out, *, runs: int | None = None, sets=None, seed: int | None = None) -> list[Path]:
    out = _check_out(out)
    cfg = dr.load_config()
    sets = list(cfg["sets"]) if sets is None else list(sets)
    traj, fixes = synthetic_loop()
    written = []
    for name in sets:
        p = dr.NavParams.from_config(name)
        res = dr.simulate(traj, p, runs=runs, seed=seed, fixes=fixes)
        summ = {**mc.summarise(res, p), "synthetic": True}
        written.append(mc.write_json(summ, out / "nav" / f"montecarlo_{name}.json"))
        written.append(mc.write_json({**mc.tracks_geojson(res, p), "synthetic": True},
                                     out / "nav" / f"tracks_{name}.geojson"))
    written.append(mc.write_json(mc.fixes_json(fixes), out / "nav" / "fixes.json"))
    return written


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("synthetic", help="synthetic loop route -> nav/ contract files")
    s.add_argument("--out", default=str(dr.REPO / "data" / "interim" / "nav_synthetic"))
    s.add_argument("--runs", type=int, default=None, help="default: nav.yaml monte_carlo.runs")
    s.add_argument("--sets", nargs="*", default=None)
    k = sub.add_parser("skyline", help="F22 on every WS3 Navcam frame -> data/interim/navigation/"
                                       "localisation/ + skyline_report.json")
    k.add_argument("--limit", type=int, default=None, help="first N frames only (testing)")
    k.add_argument("--out", default=None, help="default data/interim/navigation (manifest "
                                               "recorded only there)")
    r = sub.add_parser("real", help="real route -> data/interim/navigation/ (make web copies it)")
    r.add_argument("--dry-run", action="store_true",
                   help="list inputs and problems, compute nothing")
    r.add_argument("--scenario", default=None, help="default: variants.yaml scenarios.default")
    r.add_argument("--no-skyline", action="store_true",
                   help="skip F22 (station fixes only; G2 fallback)")
    r.add_argument("--out", default=None, help="default data/interim/navigation (manifest recorded "
                                               "only there)")
    r.add_argument("--runs", type=int, default=None, help="default: nav.yaml monte_carlo.runs")
    r.add_argument("--sets", nargs="*", default=None)
    a = ap.parse_args(argv)
    if a.cmd == "skyline":
        from pipeline.navigation import real  # noqa: PLC0415

        rep = real.skyline_run(out=a.out or real.REAL_OUT, limit=a.limit)
        return 0 if rep["n_frames"] else 1
    if a.cmd == "real":
        from pipeline.navigation import real  # noqa: PLC0415

        if a.dry_run:
            return 1 if real.dry_run(a.scenario, skyline=not a.no_skyline)["problems"] else 0
        rep = real.run(a.scenario, out=a.out or real.REAL_OUT, sets=a.sets, runs=a.runs,
                       skyline=not a.no_skyline)
        for p in rep["written"]:
            print(p)
        return 0
    for p in synthetic(a.out, runs=a.runs, sets=a.sets):
        print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
