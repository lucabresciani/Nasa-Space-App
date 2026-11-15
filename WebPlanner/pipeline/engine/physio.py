"""Suited mobility model and speed governor (SPEC F3), exactly per config/variants.yaml.

Formulas (variants.yaml ``formulas``; angles in radians, i = tan(theta)):

    a_anchor = (anchor.vo2 - V0) / anchor.speed                       # mL/kg/min per m/s
    span_kg  = (g_frac[1] - g_frac[0]) g_earth (system_kg + subject_kg) / g_mars   # IST-2 span
    alpha    = ist2.level_increment / (span_kg * anchor.speed)            # decision 14 Nov 15:40
    a(M)     = a_anchor * a_mult + alpha * (M - anchor.carried_kg)
    k        = (m_b + M) g sin(theta) / (eta m_b) * 60 / 20.1          # theta > 0, else 0
    VO2      = V0 + a(M) v + k v                                       # theta >= 0
    VO2      = V0 + a(M) v clamp(f(i) / f(0), lo, hi)                  # theta < 0
    v*       = min(v_safe(theta), (effort_cap VO2max - V0) / (a(M) + k))   # downhill: a(M) f/f0
    O2 [L]   = integral(VO2 m_b dt) / 1000                             # dt in minutes

M is the carried mass (suit + tools, SPEC F3). The Minetti polynomial coefficients and the
downhill clamp are parsed from the formula text in variants.yaml so the config stays the single
source. The only literals here are unit conversions (60 s/min, 1000 mL/L).
"""

from __future__ import annotations

import math
import re
from dataclasses import replace

import numpy as np

from . import physio_core as core
from .config import load
from .physio_core import (  # noqa: F401  (re-exported: the engine's physio API)
    ML_PER_L,
    SEC_PER_MIN,
    GradeTable,
    Params,
    a_of_m,
    cost_slope,
    governor,
    heat_w,
    k_uphill,
    o2_litres,
    step,
    v_safe,
    vo2,
)

VARIANT_PREFIX = {"opt": "optimistic", "nom": "nominal", "con": "conservative"}


class MissingInput(RuntimeError):
    """A required upstream number is not available yet (e.g. V1 slope RMSE from WS6)."""


# ------------------------------------------------------------------ formula text parsing


def _parse_minetti(text: str) -> tuple[float, ...]:
    """Coefficients c5..c0 of f(i) from 'f(i) = 280.5 i^5 - 58.7 i^4 ... + 2.5 # ...'."""
    rhs = text.split("=", 1)[1].split("#", 1)[0].replace(" ", "")
    coef = dict.fromkeys(range(6), 0.0)
    for sign, num, var, power in re.findall(r"([+-]?)([\d.]+)(i)?(?:\^(\d))?", rhs):
        deg = (int(power) if power else 1) if var else 0
        coef[deg] = float(num) * (-1.0 if sign == "-" else 1.0)
    return tuple(coef[d] for d in range(5, -1, -1))


def _parse_clamp(text: str) -> tuple[float, float]:
    m = re.search(r"clamp\(\s*f\(i\)\s*/\s*f\(0\)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)", text)
    if not m:
        raise ValueError(f"cannot parse downhill clamp from {text!r}")
    return float(m.group(1)), float(m.group(2))


_F = load("variants")["formulas"]
MINETTI_COEF = _parse_minetti(_F["minetti_f"])
DOWNHILL_CLAMP = _parse_clamp(_F["vo2_downhill"])


def minetti_f(i):
    """Minetti 2002 cost-of-transport shape f(i) (J/kg/m on Earth; shape only here)."""
    return core.minetti_f(i, MINETTI_COEF)


def downhill_mult(i):
    """clamp(f(i) / f(0), lo, hi) for i = tan(theta) < 0."""
    return core.downhill_mult(i, MINETTI_COEF, DOWNHILL_CLAMP)


# ------------------------------------------------------------------ parameters


def parse_scenario(sid: str) -> tuple[str, int]:
    """'nom_104' -> ('nominal', 104)."""
    pre, suit = sid.split("_")
    return VARIANT_PREFIX[pre], int(suit)


def resolve_nogo(spec, v1_rmse_deg: float | None) -> float:
    """Variant slope limit. The conservative one is the text '20 - v1_rmse_deg'."""
    if isinstance(spec, (int, float)):
        return float(spec)
    m = re.fullmatch(r"\s*([\d.]+)\s*-\s*v1_rmse_deg\s*", str(spec))
    if not m:
        raise ValueError(f"cannot parse nogo_deg {spec!r}")
    if v1_rmse_deg is None:
        raise MissingInput("conservative nogo_deg needs v1_rmse_deg (V1 slope RMSE, WS6)")
    return float(m.group(1)) - float(v1_rmse_deg)


def _check_formula(key: str, expected: str) -> None:
    text = load("variants")["formulas"][key].split("#", 1)[0].replace(" ", "")
    if text != expected.replace(" ", ""):
        raise ValueError(f"variants.formulas.{key} changed: {text!r}; update physio.py")


def ist2_span_mars_kg() -> float:
    """IST-2 weight span as carried mass at Mars g (variants.yaml formulas.ist2_span_kg):
    (g_frac[1] - g_frac[0]) * g_earth * (system_kg + subject_kg) / g_mars = 106.6 kg.
    IST-2 changed gravity (0.12 -> 0.32 g) on a fixed 121 + 80.7 kg system, not the mass."""
    _check_formula("ist2_span_kg", "span_kg = (g_frac[1] - g_frac[0]) * g_earth_ms2 * "
                   "(system_kg + subject_kg) / crew.g_mars")  # fmt: skip
    ist2 = load("variants")["ist2"]
    if ist2["level_span"] != "weight_span":
        raise ValueError("variants.ist2.level_span must be 'weight_span'")
    w = ist2["weight_span"]
    dg = (float(w["g_frac"][1]) - float(w["g_frac"][0])) * float(ist2["g_earth_ms2"])
    return dg * (float(w["system_kg"]) + float(w["subject_kg"])) / float(load("crew")["g_mars"])


def alpha_level() -> float:
    """alpha = ist2.level_increment / (span_kg * anchor.speed), mL/kg/min per m/s per kg."""
    _check_formula("alpha", "alpha = ist2.level_increment / (span_kg * anchor.speed)")
    ist2, a = load("variants")["ist2"], load("crew")["anchor"]
    return float(ist2["level_increment_ml_kg_min"]) / (ist2_span_mars_kg() * float(a["speed_ms"]))


# F26 (D48): the crew values a plan may override; everything else stays config-only.
CREW_KEYS = ("body_mass_kg", "tools_kg", "vo2max_ml_kg_min", "effort_cap_frac")


def crew_values(crew: dict | None = None) -> dict:
    """crew.yaml body_mass_kg, tools_kg, vo2max_ml_kg_min, effort_cap_frac with ``crew``'s
    overrides (F26). Unknown keys raise ValueError; None or {} gives the config values."""
    base = load("crew")
    out = {k: base[k] for k in CREW_KEYS}
    if crew:
        bad = sorted(set(crew) - set(CREW_KEYS))
        if bad:
            raise ValueError(f"unknown crew override(s) {bad}; allowed: {list(CREW_KEYS)}")
        for k, v in crew.items():
            if v is not None:
                out[k] = float(v)
    return out


def params(
    variant: str,
    suit_kg: float | None = None,
    *,
    carried_kg: float | None = None,
    v1_rmse_deg: float | None = None,
    crew: dict | None = None,
) -> Params:
    """Build Params for a variant and either a suit mass (M = suit + tools) or carried mass M.
    crew: optional overrides of CREW_KEYS (F26), config values otherwise."""
    var = load("variants")
    cv = crew_values(crew)
    crew = load("crew")
    v = var["variants"][variant]
    if carried_kg is None:
        if suit_kg is None:
            suit_kg = crew["default_suit_kg"]
        carried_kg = float(suit_kg) + cv["tools_kg"]
    a = crew["anchor"]
    table = sorted(crew["v_safe_ms"], key=lambda r: r["max_deg"])
    return Params(
        variant=variant,
        eta=float(v["eta"]),
        V0=float(v["V0"]),
        a_mult=float(v["a_mult"]),
        nogo_deg=resolve_nogo(v["nogo_deg"], v1_rmse_deg),
        m_b=float(cv["body_mass_kg"]),
        carried_kg=float(carried_kg),
        g=float(crew["g_mars"]),
        vo2max=float(cv["vo2max_ml_kg_min"]),
        effort_cap=float(cv["effort_cap_frac"]),
        anchor_vo2=float(a["vo2_ml_kg_min"]),
        anchor_speed=float(a["speed_ms"]),
        anchor_carried_kg=float(a["carried_kg"]),
        alpha=alpha_level(),
        j_per_ml=float(crew["o2_energy_j_per_ml"]),
        vsafe_max_deg=tuple(float(r["max_deg"]) for r in table),
        vsafe_v=tuple(float(r["v"]) for r in table),
        minetti_coef=MINETTI_COEF,
        downhill_clamp=DOWNHILL_CLAMP,
    )


def scenario_params(sid: str, *, v1_rmse_deg: float | None = None,
                    crew: dict | None = None) -> Params:  # fmt: skip
    variant, suit = parse_scenario(sid)
    return params(variant, suit_kg=suit, v1_rmse_deg=v1_rmse_deg, crew=crew)


# ------------------------------------------------------------------ model (physio_core.py, D48)


# ------------------------------------------------------------------ router lookup table


def table_step_deg() -> float:
    """Lookup-table resolution (variants.yaml numerics.grade_table_step_deg)."""
    return float(load("variants")["numerics"]["grade_table_step_deg"])


def grade_table(p: Params, step_deg: float | None = None) -> GradeTable:
    """Router lookup table (physio_core.grade_table) at the config step by default."""
    return core.grade_table(p, table_step_deg() if step_deg is None else step_deg)


def level_to_grade_increment(p: Params, v: float) -> dict:
    """Level -> 20 % / 30 % increment k*v (mL/kg/min) at speed v. NOT validated: IST-2's
    8.7 / 17.0 are weight-span differences, not this quantity (S review 2026-11-14), and no
    measured level -> grade reference is in hand (variants.yaml ist2.level_to_grade_validated)."""
    out: dict = {f"grade_{g}pct": float(k_uphill(p, math.atan(g / 100)) * v) for g in (20, 30)}
    out["validated"] = bool(load("variants")["ist2"]["level_to_grade_validated"])
    return out


def ist2_weight_span(variant: str = "nominal") -> dict:
    """IST-2 weight-span check (S review 2026-11-14, variants.yaml ist2.weight_span).

    The model is run at the same grade at the lightest and heaviest IST-2 weight (g fractions
    of Earth g) with the IST-2 system (carried = system_kg, body = subject_kg, so VO2 is per kg
    of subject mass) over the IST-2 speed range. The band is min..max of the difference over
    the speed sweep; ``inside`` says whether IST-2's reported difference falls in it.

    Two terms change with the weight (alpha encoding, decision 14 Nov 15:40): the uphill term k
    (g enters directly) and the level term, since alpha is now defined per kg of carried mass
    at Mars g and the IST-2 span equals ``ist2_span_mars_kg()`` of it: + alpha * span_kg * v
    (= 1.9 * v / 0.98). ``band`` is the sum (the model's prediction, pass rule);
    ``band_vertical_only`` is the k term alone (the session-2 check, independent of alpha).
    V0 cancels; a_mult only scales a_anchor, so the level term is the same in every variant.
    """
    ist2 = load("variants")["ist2"]
    w = ist2["weight_span"]
    eta = float(load("variants")["variants"][variant]["eta"])
    base = params("nominal", carried_kg=float(w["system_kg"]))
    base = replace(base, variant=variant, eta=eta, m_b=float(w["subject_kg"]))
    g_lo, g_hi = (float(f) * float(ist2["g_earth_ms2"]) for f in w["g_frac"])
    v = np.linspace(float(w["speed_ms"][0]), float(w["speed_ms"][1]), int(w["speed_sweep_n"]))
    level = base.alpha * ist2_span_mars_kg() * v
    out: dict = {"variant": variant, "eta": eta, "speed_ms": [float(v[0]), float(v[-1])],
                 "alpha": base.alpha, "level_term_band": [float(level[0]), float(level[-1])]}
    for key, reported in ist2["uphill_check_ml_kg_min"].items():
        th = math.atan(float(key.split("_")[1].rstrip("pct")) / 100)
        dk = vo2(replace(base, g=g_hi), v, th) - vo2(replace(base, g=g_lo), v, th)
        d = dk + level
        lo, hi = float(np.min(d)), float(np.max(d))
        klo, khi = float(np.min(dk)), float(np.max(dk))
        out[key] = {"band": [lo, hi], "reported": float(reported),
                    "inside": bool(lo <= reported <= hi),
                    "band_vertical_only": [klo, khi],
                    "inside_vertical_only": bool(klo <= reported <= khi)}  # fmt: skip
    return out


def ist2_pass_rows() -> dict:
    """D30 (user 16:20, no tuning): IST-2 weight-span pass/miss per variant and grade, for the
    manifest (physio.ist2.{variant}.{grade}.*): pass = IST-2's reported value inside the model
    band (with the level term), band_lo/hi in mL/kg/min."""
    out = {}
    for variant in load("variants")["variants"]:
        s = ist2_weight_span(variant)
        out[variant] = {g: {"pass": bool(s[g]["inside"]), "band_lo": round(s[g]["band"][0], 3),
                            "band_hi": round(s[g]["band"][1], 3),
                            "reported": float(s[g]["reported"])}
                        for g in load("variants")["ist2"]["uphill_check_ml_kg_min"]}  # fmt: skip
    return out
