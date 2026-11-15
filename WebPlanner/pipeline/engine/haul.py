"""Partner line: hauling an incapacitated crewmate home (SPEC F10, config/haul.yaml).

    F       = m_IC g (mu cos th + sin th)
    P_avail = (effort_frac VO2max - VO2_walk_self) m_b 20.1 / 60            [W]
    v_haul  = min(v_safe(th), eps P_avail / F); downhill: min(v_haul, 0.5 v_safe(th))
    infeasible if v_haul < 0.1 m/s or F > boot_mu (m_b + suit + tools) g cos th

VO2_walk_self is the rescuer's own walking cost (physio, F3) *at the haul speed*, which makes
v = eps P(v) / F linear in v:  v = eps K (E - V0) / (F + eps K c(th)),  K = m_b 20.1 / 60,
E = effort_frac VO2max, c = physio.cost_slope. F <= 0 (load pulls downhill) leaves the caps.
Ridge cells (ridge_index > site.yaml ridge.threshold_m) are masked for hauling.

D20 (user 2026-11-14 14:22, SPEC §11): the partner line and the haul fields use
``haul.yaml partner_cases`` (cart only). The drag case stays in the config and is reported as a
finding: on flat ground its force exceeds boot traction (``drag_flat``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from . import physio
from .config import load
from .graph import Grid
from .physio import GradeTable, Params


@dataclass(frozen=True)
class HaulCase:
    name: str  # cart | drag
    casualty_kg: float
    mu: float
    eps: float
    effort_frac: float
    boot_mu: float
    min_speed: float


def _min_speed() -> float:
    m = re.search(r"v_haul\s*<\s*([\d.]+)\s*m/s", load("haul")["formulas"]["infeasible"])
    if not m:
        raise ValueError("cannot parse the minimum haul speed from haul.yaml formulas.infeasible")
    return float(m.group(1))


def case(name: str, casualty_kg: float, *, mu=None, eps=None, effort_frac=None) -> HaulCase:
    """A haul case with haul.yaml nominal values unless overridden (for the band sweeps)."""
    h = load("haul")
    eff = h["rescuer_effort_frac"]["nominal"] if effort_frac is None else effort_frac
    return HaulCase(
        name=name,
        casualty_kg=float(casualty_kg),
        mu=float(h["cases"][name]["mu_nominal"] if mu is None else mu),
        eps=float(h["efficiency_eps"]["nominal"] if eps is None else eps),
        effort_frac=float(eff),
        boot_mu=float(h["boot_mu"]),
        min_speed=_min_speed(),
    )


def suited_casualty_kg(suit_kg: float) -> float:
    """Suited crewmate = body_mass + suit_mass (haul.yaml casualty_kg.suited)."""
    return load("crew")["body_mass_kg"] + suit_kg


def force(m_ic, mu, theta, g):
    """Haul force (N) along the slope."""
    th = np.asarray(theta, dtype=float)
    out = m_ic * g * (mu * np.cos(th) + np.sin(th))
    return out if out.ndim else float(out)


def speed(p: Params, c: HaulCase, theta):
    """Haul speed (m/s); 0 where infeasible. p is the rescuer (variant, suit + tools)."""
    th = np.asarray(theta, dtype=float)
    F = force(c.casualty_kg, c.mu, th, p.g)
    K = p.m_b * p.j_per_ml / physio.SEC_PER_MIN
    head = c.eps * K * max(c.effort_frac * p.vo2max - p.V0, 0.0)
    den = F + c.eps * K * physio.cost_slope(p, th)
    with np.errstate(divide="ignore", invalid="ignore"):
        v_pow = np.where((F > 0) & (den > 0), head / den, np.inf)
    vs = physio.v_safe(p, th)
    v = np.minimum(vs, v_pow)
    v = np.where(th < 0, np.minimum(v, 0.5 * vs), v)
    traction = c.boot_mu * (p.m_b + p.carried_kg) * p.g * np.cos(th)
    v = np.where((v < c.min_speed) | (F > traction), 0.0, v)
    return v if v.ndim else float(v)


def infeasible_reason(p: Params, c: HaulCase, theta: float) -> str | None:
    """Why the haul is infeasible at one grade: "traction" (F > boot_mu (m_b + suit + tools) g
    cos th, checked first), "speed" (v_haul < min speed) or None (feasible)."""
    th = float(theta)
    F = force(c.casualty_kg, c.mu, th, p.g)
    if F > c.boot_mu * (p.m_b + p.carried_kg) * p.g * np.cos(th):
        return "traction"
    return "speed" if speed(p, c, th) <= 0.0 else None


def drag_flat(suit_kg: float, variant: str = "nominal") -> dict:
    """D20 finding: dragging the suited crewmate on flat ground (theta = 0), from config.
    force_N = m_IC g mu_drag; traction_limit_N = boot_mu (m_b + suit + tools) g;
    max_mass_kg = boot_mu (m_b + suit + tools) / mu_drag (g cancels)."""
    p = physio.params(variant, suit_kg=suit_kg)
    c = case("drag", suited_casualty_kg(suit_kg))
    system = p.m_b + p.carried_kg
    reason = infeasible_reason(p, c, 0.0)
    return {
        "case": "drag",
        "theta_deg": 0.0,
        "suit_kg": float(suit_kg),
        "casualty_kg": c.casualty_kg,
        "rescuer_system_kg": float(system),
        "mu": c.mu,
        "boot_mu": c.boot_mu,
        "g_ms2": p.g,
        "force_N": float(force(c.casualty_kg, c.mu, 0.0, p.g)),
        "traction_limit_N": float(c.boot_mu * system * p.g),
        "max_mass_kg": float(c.boot_mu * system / c.mu),
        "feasible": reason is None,
        "reason": reason,
    }


def partner_cases() -> list[str]:
    """Haul cases drawn as the partner line (haul.yaml partner_cases; D20: cart only)."""
    h = load("haul")
    names = list(h["partner_cases"])
    unknown = [n for n in names if n not in h["cases"]]
    if unknown:
        raise ValueError(f"haul.yaml partner_cases not in cases: {unknown}")
    return names


def grade_table(p: Params, c: HaulCase, step_deg: float = 0.01) -> GradeTable:
    """Router table for hauling. O2 is the rescuer's at effort_frac x VO2max while hauling."""
    n = int(round(180.0 / step_deg)) + 1
    deg = np.linspace(-90.0, 90.0, n)
    v = speed(p, c, np.radians(deg))
    ok = (np.abs(deg) <= p.nogo_deg + 1e-9) & (v > 0)
    vv = np.where(ok, v, 1.0)
    pace = np.where(ok, 1.0 / vv, np.inf)
    vo2 = c.effort_frac * p.vo2max
    o2 = np.where(ok, physio.o2_litres(p, vo2, 1.0 / vv / physio.SEC_PER_MIN), np.inf)
    return GradeTable(deg, pace, o2, 180.0 / (n - 1))


def ridge_mask(ridge_index: np.ndarray) -> np.ndarray:
    return np.asarray(ridge_index) > load("site")["ridge"]["threshold_m"]


def haul_grid(grid: Grid, ridge_index: np.ndarray) -> Grid:
    """Copy of the walking grid with ridge cells masked (haul.yaml mask_ridges)."""
    g = Grid(**grid.__dict__)
    if load("haul")["mask_ridges"]:
        g.passable = grid.passable & ~ridge_mask(ridge_index)
    return g


def partner(grid: Grid, fields: dict[tuple[str, float], np.ndarray], simplify_m: float) -> dict:
    """partner.geojson: the haul.yaml contour_min contour per (case, casualty kg), dashed and off
    by default (brief WS2 "Don't")."""
    from .envelope import envelope_mask, mask_polygon
    from .geo import feature_collection

    h = load("haul")
    cmin = h["contour_min"]
    items = []
    for (name, m_ic), t in fields.items():
        props = {
            "case": name,
            "casualty_kg": m_ic,
            "contour_min": cmin,
            "style": "dashed",
            "default_visible": False,
            "label": h["partner_label"].format(case=name, contour_min=cmin),
            "caption": h["partner_caption"],
            "drag_note": h["drag_note"],
        }
        m = envelope_mask(t, cmin)
        n = int(m.sum())
        # only the seed (pad) cell: the haul is infeasible everywhere (speed or traction rule)
        props["feasible"] = n > 1
        props["area_km2"] = round(n * grid.res_m**2 / 1e6, 6)
        items.append((mask_polygon(grid, m, simplify_m), props))
    return feature_collection(items, grid.crs)
