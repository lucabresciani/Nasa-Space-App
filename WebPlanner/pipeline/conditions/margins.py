"""Margin inputs for WS2 (SPEC F4 route margin: t_dark and tau_dose terms), from WS4 outputs.

    uv run --no-sync python -m pipeline.conditions.margins            # JSON
    uv run --no-sync python -m pipeline.conditions.margins --flags    # WS2 CLI flags
    uv run --no-sync python -m pipeline.conditions.margins --flags --observer S1 --dose storm

* ``t_dark_min``: minutes from the simulated EVA start to dark, ``clock.json`` ``eva.t_dark_min``
  (flat horizon at the pad) or ``eva.t_dark_min_by_observer[<id>]`` (WS3 F12 horizon).
* ``tau_dose_min``: ``rad.json`` leash at D_allow (config leash.d_allow_mgy): ``storm`` = at the
  20 May 2024 peak (``leash.tau_min_at_peak``, the storm-replay case), ``latest`` = at the latest
  RAD rate (``leash.tau_min_at_latest``, quiet conditions). Null = unknown (omit the flag).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from pipeline.conditions.config import INTERIM


def margin_inputs(observer: str | None = None, dose: str = "storm",
                  root: Path = INTERIM) -> dict[str, Any]:
    clock = json.loads((root / "conditions" / "clock.json").read_text())
    radj = json.loads((root / "conditions" / "rad.json").read_text())
    eva = clock["eva"]
    if observer is None:
        t_dark, t_src = eva["t_dark_min"], "clock.json eva.t_dark_min (flat horizon, pad)"
    else:
        t_dark = eva["t_dark_min_by_observer"].get(observer)
        t_src = f"clock.json eva.t_dark_min_by_observer.{observer} (F12 horizon)"
    key = {"storm": "tau_min_at_peak", "latest": "tau_min_at_latest"}[dose]
    return {"t_dark_min": t_dark, "t_dark_source": t_src,
            "tau_dose_min": radj["leash"][key],
            "tau_dose_source": (f"rad.json leash.{key} at D_allow "
                                f"{radj['leash']['D_allow_mGy']} mGy"),
            "eva_start_utc": eva["start_utc"], "eva_start_lmst": eva["start_lmst"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--observer", default=None)
    ap.add_argument("--dose", choices=["storm", "latest"], default="storm")
    ap.add_argument("--flags", action="store_true", help="print WS2 CLI flags")
    a = ap.parse_args(argv)
    m = margin_inputs(a.observer, a.dose)
    if a.flags:
        out = []
        if m["t_dark_min"] is not None:
            out.append(f"--t-dark-min {m['t_dark_min']}")
        if m["tau_dose_min"] is not None:
            out.append(f"--tau-dose-min {m['tau_dose_min']}")
        print(" ".join(out))
    else:
        print(json.dumps(m, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
