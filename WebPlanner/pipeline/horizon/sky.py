"""Sky-boundary detector (F13 V2; F22 reuses it). Rule from horizon.yaml ``sky_detector``:
per column, top-down, the first pixel where the vertical gradient exceeds grad_ratio (3x) times
the median gradient of the top ref_top_frac (10%) rows of that column.

Assumption (horizon.yaml ``sky_detector_params.zero_median_guard``): a zero reference median
(smooth 8-bit sky) is replaced by one quantisation count, so a single-DN step does not fire.
The returned row is the boundary between the last sky pixel r and the first ground pixel r+1,
i.e. r + 0.5 in pixel-centre coordinates. With pre-smoothing
(``sky_detector_params.presmooth_sigma_px``) the edge is spread over a few rows, so the
boundary is the gradient peak of the first
above-threshold run (otherwise the first crossing would sit ~2 sigma above the edge).
Columns with no detection are NaN; detections inside the reference band are flagged (the
reference was not pure sky).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from pipeline.horizon import config as hcfg


@dataclass
class SkyResult:
    rows: np.ndarray        # boundary row per column (float, NaN = none)
    threshold: np.ndarray   # per-column gradient threshold
    ref_median: np.ndarray  # per-column median gradient of the reference band
    in_ref_band: np.ndarray  # bool: detection inside the reference rows (unreliable)

    @property
    def detected_frac(self) -> float:
        return float(np.mean(np.isfinite(self.rows)))


def to_grey(img) -> np.ndarray:
    a = np.asarray(img)
    if a.ndim == 3:
        a = a[..., :3].astype(np.float64).mean(axis=2)
    return a.astype(np.float64)


def detect_skyline(img, *, grad_ratio: float | None = None, ref_top_frac: float | None = None,
                   quantum: float | None = None, border_px: int | None = None,
                   smooth_sigma_px: float | None = None) -> SkyResult:
    """``border_px`` rows/columns at each image edge are excluded (horizon.yaml
    ``sky_detector_border_px``: artefact border of the Navcam JPEGs); rows are reported in full
    image coordinates; border columns are NaN. ``smooth_sigma_px`` (horizon.yaml
    ``sky_detector_params.presmooth_sigma_px``) is a Gaussian pre-smoothing of the (cropped)
    image before the gradient; the one-count guard still uses the raw image's quantisation."""
    p = hcfg.load()["sky_detector_params"]
    b = int(hcfg.value(p["border_px"]) if border_px is None else border_px)
    full = np.asarray(img)
    if b > 0:
        if full.shape[0] <= 4 * b or full.shape[1] <= 2 * b:
            raise ValueError("image too small for the border exclusion")
        inner = detect_skyline(full[b:-b, b:-b], grad_ratio=grad_ratio, ref_top_frac=ref_top_frac,
                               quantum=quantum, border_px=0, smooth_sigma_px=smooth_sigma_px)
        w = full.shape[1]

        def pad(a, fill):
            out = np.full(w, fill, dtype=a.dtype)
            out[b:-b] = a
            return out

        return SkyResult(rows=pad(inner.rows + b, np.nan), threshold=pad(inner.threshold, np.nan),
                         ref_median=pad(inner.ref_median, np.nan),
                         in_ref_band=pad(inner.in_ref_band, False))
    ratio = p["grad_ratio"] if grad_ratio is None else grad_ratio
    frac = p["ref_top_frac"] if ref_top_frac is None else ref_top_frac
    raw = np.asarray(img)
    if quantum is None:
        quantum = 1.0 if np.issubdtype(raw.dtype, np.integer) else 0.0
    sigma = float(hcfg.value(p["presmooth_sigma_px"]) if smooth_sigma_px is None
                  else smooth_sigma_px)
    grey = to_grey(raw)
    if sigma > 0:
        from scipy.ndimage import gaussian_filter  # noqa: PLC0415

        grey = gaussian_filter(grey, sigma, mode="nearest")
    g = np.abs(np.diff(grey, axis=0))  # (H-1, W): g[r] between rows r and r+1
    n_ref = max(1, int(round(frac * raw.shape[0])))
    ref = np.median(g[:n_ref], axis=0)
    thr = ratio * np.maximum(ref, quantum)
    hit = g > thr[None, :]
    any_hit = hit.any(axis=0) & (thr > 0)
    first = np.argmax(hit, axis=0)
    peak = first.copy()
    if sigma > 0:  # smoothing spreads the edge: take the gradient peak of the first run
        for c in np.nonzero(any_hit)[0]:
            r1 = first[c]
            stop = np.argmin(hit[r1:, c]) if not hit[r1:, c].all() else hit.shape[0] - r1
            peak[c] = r1 + int(np.argmax(g[r1:r1 + stop, c]))
    rows = np.where(any_hit, peak + 0.5, np.nan)
    return SkyResult(rows=rows, threshold=thr, ref_median=ref,
                     in_ref_band=any_hit & (first < n_ref))
