"""Validation figures (F13, F16 scorecard) as dependency-free SVG.

``v1_scatter_svg(v1, out_path)`` draws DEM tilt (y) against IMU tilt (x) from a ``v1.json``
document: one dot per drive end, the 1:1 line, the confusion thresholds as dashed lines, and the
headline numbers in the caption. Every number in the caption comes from ``v1`` (recorded in the
manifest by ``v1_tilt.write_result``); nothing is computed here. Styling is presentation only.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

SVG_NS = "http://www.w3.org/2000/svg"


def _fmt(v: Any, nd: int = 2) -> str:
    return "n/a" if v is None else f"{v:.{nd}f}"


def _write(parts: list[str], out_path: str | os.PathLike[str]) -> Path:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(parts) + "\n", encoding="utf-8")
    return out


def v1_scatter_svg(v1: dict[str, Any], out_path: str | os.PathLike[str]) -> Path:
    """Write the V1 scatter plot to ``out_path`` (SVG) and return the path."""
    pts = v1.get("points", [])
    thresholds = v1.get("thresholds_deg", [])
    top = max([*(max(p) for p in pts), *thresholds, 1.0])
    top = 5.0 * math.ceil(top * 1.1 / 5.0)  # axis max, rounded up to a 5 deg tick

    w, h, pad = 420, 440, 50
    side = w - 2 * pad

    def sx(v: float) -> float:  # IMU tilt -> px
        return pad + side * v / top

    def sy(v: float) -> float:  # DEM tilt -> px
        return pad + side * (1 - v / top)

    parts = [
        f'<svg xmlns="{SVG_NS}" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
        'font-family="sans-serif" font-size="11">',
        f'<rect width="{w}" height="{h}" fill="#fff"/>',
        f'<rect x="{pad}" y="{pad}" width="{side}" height="{side}" fill="none" stroke="#888"/>',
        f'<line x1="{sx(0)}" y1="{sy(0)}" x2="{sx(top)}" y2="{sy(top)}" stroke="#888"/>',
    ]
    for t in thresholds:
        parts.append(
            f'<line x1="{sx(t)}" y1="{sy(0)}" x2="{sx(t)}" y2="{sy(top)}" stroke="#c60" '
            'stroke-dasharray="4 3"/>'
            f'<line x1="{sx(0)}" y1="{sy(t)}" x2="{sx(top)}" y2="{sy(t)}" stroke="#c60" '
            'stroke-dasharray="4 3"/>'
        )
    for tick in range(0, int(top) + 1, 5):
        parts.append(
            f'<text x="{sx(tick)}" y="{pad + side + 14}" text-anchor="middle">{tick}</text>'
        )
        parts.append(f'<text x="{pad - 6}" y="{sy(tick) + 4}" text-anchor="end">{tick}</text>')
    for dem_t, imu_t in pts:
        parts.append(f'<circle cx="{sx(imu_t):.1f}" cy="{sy(dem_t):.1f}" r="2.5" fill="#1f5fa8"/>')
    caption = (
        f"V1: n = {v1.get('n')}, bias = {_fmt(v1.get('bias_deg'))}°, "
        f"RMSE = {_fmt(v1.get('rmse_deg'))}°, r = {_fmt(v1.get('r'))}"
    )
    if v1.get("footprint_m") is not None:
        caption += f", footprint {v1['footprint_m']:g} m"
    parts += [
        f'<text x="{w / 2}" y="{pad + side + 32}" text-anchor="middle">IMU tilt (deg)</text>',
        f'<text x="14" y="{pad + side / 2}" text-anchor="middle" '
        f'transform="rotate(-90 14 {pad + side / 2})">DEM tilt over footprint (deg)</text>',
        f'<text x="{w / 2}" y="{pad - 18}" text-anchor="middle">{escape(caption)}</text>',
        f'<text x="{w / 2}" y="{h - 8}" text-anchor="middle" fill="#666">'
        f"{escape(str(v1.get('caveat', '')))}</text>",
        "</svg>",
    ]
    return _write(parts, out_path)
