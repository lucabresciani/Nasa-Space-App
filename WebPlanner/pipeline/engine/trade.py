"""Trade table (SPEC F11): walkback budget rows x suit mass columns.

Each cell: science value reachable (sum of station values inside the conservative homeline for
that suit), % of the assessed disc reachable, and partner-line area. Which variant feeds the
reachable % and which haul case feeds the partner area is the caller's choice (see STATUS).
"""

from __future__ import annotations

import math


def science_value(t_home_at_station: dict[str, float], values: dict[str, float], budget) -> float:
    """Sum of values of stations whose (conservative) T_home <= budget."""
    return float(
        sum(
            values[s]
            for s, t in t_home_at_station.items()
            if t is not None and math.isfinite(t) and t <= budget
        )
    )


def table(rows, cols, cells: dict[tuple, dict]) -> dict:
    """trade_table.json (contract trade_table): cells[row][col]."""
    keys = ("science_value", "reachable_pct", "partner_area_km2")

    def cell(d):
        out = {k: d.get(k) for k in keys}
        if d.get("in_data_pct") is not None:  # D41 extra: % of the flat disc inside the data
            out["in_data_pct"] = d["in_data_pct"]
        return out

    return {
        "rows": list(rows),
        "cols": list(cols),
        "cells": [[cell(cells[(r, c)]) for c in cols] for r in rows],
    }
