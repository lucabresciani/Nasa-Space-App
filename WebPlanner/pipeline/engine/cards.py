"""Timeline and margin part of each station card (C decision 2026-11-14 11:42).

WS2 writes ``data/interim/engine/public/cards/{S}.timeline.json``; ``make web`` (C) merges it
with WS3's ``horizon/public/cards/{S}.json`` into ``cards/{S}.json`` (contract card). Card keys
WS2 owns: ``timeline`` {arrive, leave, turn_back} (EVA min), ``margin_binding``,
``contingency``. Extra keys (optional, for the card and the cuff card): ``station``,
``scenario``, ``on_route``, ``margin_min``, ``t_home_min``, ``o2_home_L`` (at the access cell),
``science`` {lon, lat}, ``access`` (access.py: lon, lat, dist_m, reason, walk_in, radius_m, rule),
``drag_note`` (haul.yaml, SPEC F10 / D20: dragging is a finding, not a line).

margin_binding = the binding term at the station's lowest margin among its arrive/leave rows
(margins only shrink with time). A station not on the route has null times and a null binding
(unknown stays unknown); the card contract's enum has no null (reported to C).
Contingency (SPEC F15, from F10): haul time home from the access cell on the partner-line case.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from . import provenance
from .access import RULE
from .config import load
from .geo import _validator

SCRIPT = "pipeline/engine/cards.py"


def _contingency(a, haul_t, casualty_kg, case, contour_min, radius) -> str:
    if a is None or a.rc is None:
        why = "no access cell" if a is None else a.reason
        return (f"No access cell within {radius:g} m ({why}): no walk home or partner haul "
                "computed for this station.")  # fmt: skip
    if haul_t is None:
        return "Partner haul not computed for this scenario."
    th = float(haul_t[a.rc])
    if not math.isfinite(th):
        return (f"Partner down: no {case} haul path home from the access cell "
                f"(casualty {casualty_kg:.0f} kg; haul parameters assumed).")  # fmt: skip
    side = "inside" if th <= contour_min else "outside"
    return (f"Partner down: haul home by {case} from the access cell, {th:.0f} min "
            f"(casualty {casualty_kg:.0f} kg; haul parameters assumed); {side} the "
            f"{contour_min:g}-min partner line.")  # fmt: skip


def fragments(stations: list[dict], res, sid: str, haul_t: np.ndarray | None,
              casualty_kg: float, case: str, contour_min: float, radius: float,
              ) -> dict[str, dict]:  # fmt: skip
    """{station id: card timeline fragment} for every station with a position."""
    out = {}
    for s in stations:
        a = s.get("access", {}).get(sid)
        rows = [e for e in res.timeline if e["station"] == s["id"]]
        ev = {}
        for e in rows:
            ev.setdefault(e["event"], e["t_min"])
        at = [e for e in rows if e["event"] in ("arrive", "leave")]
        tb = next((e for e in rows if e["event"] == "turn_back"), None)
        low = min(at, key=lambda e: e["margin_min"]) if at else None
        acc = {"radius_m": float(radius), "rule": RULE}
        if a is not None:
            acc = {**a.to_json(), **acc}
        out[s["id"]] = {
            "station": s["id"], "scenario": sid, "on_route": s["id"] in res.order,
            "timeline": {k: ev.get(k) for k in ("arrive", "leave", "turn_back")},
            "margin_binding": None if low is None else low["margin_binding"],
            "margin_min": None if low is None else low["margin_min"],
            # D28: the term that sets the latest turn-back (contracts v1.1.3)
            "turn_back_binding": None if tb is None else tb["margin_binding"],
            "contingency": _contingency(a, haul_t, casualty_kg, case, contour_min, radius),
            "drag_note": load("haul")["drag_note"],  # SPEC F10 Output (D20)
            "t_home_min": None if a is None or a.t_home_min is None else round(a.t_home_min, 2),
            "o2_home_L": None if a is None or a.o2_home_L is None else round(a.o2_home_L, 2),
            "science": {"lon": round(float(s["lon"]), 6), "lat": round(float(s["lat"]), 6)},
            "access": acc,
        }  # fmt: skip
    return out


def write(frags: dict[str, dict], public: Path) -> list[Path]:
    """public/cards/{S}.timeline.json; the card-owned keys are checked against the card
    contract's sub-schemas (timeline; margin_binding when not null); manifest keys."""
    schema = _validator("card.schema.json").schema["properties"]
    paths = []
    for st, fr in frags.items():
        from jsonschema import Draft202012Validator

        Draft202012Validator(schema["timeline"]).validate(fr["timeline"])
        Draft202012Validator(schema["contingency"]).validate(fr["contingency"])
        if fr["margin_binding"] is not None:
            Draft202012Validator(schema["margin_binding"]).validate(fr["margin_binding"])
        if fr.get("turn_back_binding") is not None and "turn_back_binding" in schema:
            Draft202012Validator(schema["turn_back_binding"]).validate(fr["turn_back_binding"])
        p = Path(public) / "cards" / f"{st}.timeline.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(fr, separators=(",", ":")), encoding="utf-8")
        paths.append(p)
        f = f"cards/{st}.json"
        for k in ("arrive", "leave", "turn_back"):
            if fr["timeline"][k] is not None:
                provenance.record(f"card.{st}.timeline.{k}", fr["timeline"][k], "min", f, SCRIPT)
        for k, u in (("margin_min", "min"), ("t_home_min", "min"), ("o2_home_L", "L")):
            if fr[k] is not None:
                provenance.record(f"card.{st}.{k}", fr[k], u, f, SCRIPT)
        if fr["margin_binding"] is not None:
            provenance.record(f"card.{st}.margin_binding", fr["margin_binding"], None, f, SCRIPT)
        if fr.get("turn_back_binding") is not None:
            provenance.record(f"card.{st}.turn_back_binding", fr["turn_back_binding"], None, f,
                              SCRIPT)  # fmt: skip
        a = fr["access"]
        for k, u in (("dist_m", "m"),):
            if a.get(k) is not None:
                provenance.record(f"card.{st}.access.{k}", a[k], u, f, SCRIPT)
        w = a.get("walk_in") or {}
        for k, u in (("rise_m", "m"), ("mean_slope_deg", "deg"), ("max_slope_deg", "deg"),
                     ("max_terrain_slope_deg", "deg")):  # fmt: skip
            if w.get(k) is not None:
                provenance.record(f"card.{st}.access.walk_in.{k}", w[k], u, f, SCRIPT)
    return paths
