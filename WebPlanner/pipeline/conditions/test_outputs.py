"""Tests for the WS4 REMS, DONKI and margin outputs (F14; brief WS4 "Don't").

REMS multipart parsing uses a hand-built two-row MODRDR body (format per LABEL/MODRDR6.FMT,
docs/discovery.md §4.2; values invented). Real-output checks run on data/interim/conditions/ when
``make conditions`` has been run (skipped in CI).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from pipeline.conditions import donki, margins, rems
from pipeline.conditions.config import INTERIM, load_conditions

CFG = load_conditions()
OUT = INTERIM / "conditions"


def _row(lmst: str, amb_k: float, p_pa: float, row_bytes: int) -> bytes:
    f = ["0"] * rems.N_COLUMNS
    f[rems.LMST_COL] = lmst
    f[15], f[7], f[37], f[20] = f"{amb_k:.2f}", "-999.00", f"{p_pa:.2f}", "0.50"
    line = ",".join(f)
    return (line + " " * (row_bytes - 2 - len(line)) + "\r\n").encode()


def test_multipart_rows_and_extremes():
    rb = int(CFG["rems"]["pds_rmd_record_bytes"])
    rows = [_row(f"04400M{h:02d}:00:00.000", 200.0 + h, 800.0 + h, rb) for h in range(24)]
    body = b""
    for i, r in enumerate(rows):
        body += (b"--SEP\r\nContent-type: text/plain\r\nContent-range: bytes "
                 + f"{i * rb}-{(i + 1) * rb - 1}/{24 * rb}".encode() + b"\r\n\r\n" + r)
    body += b"--SEP--\r\n"
    parsed = rems.parse_multipart_rows(body, rb)
    assert len(parsed) == 24
    ext = rems.sol_extremes(parsed, int(CFG["rems"]["pds_min_lmst_coverage_h"]))
    lo, hi = ext[15]
    assert lo == pytest.approx(200.0 - rems.KELVIN_0C) and hi == pytest.approx(223.0 - 273.15)
    assert 7 not in ext  # ground temperature dropped (D37)
    gts = rems.sol_extremes(parsed, 18, {7: ("test column", "degC", True)})
    assert gts[7] is None  # all missing (-999): unknown, not zero
    assert ext[37] == (800.0, 823.0)
    thin = rems.sol_extremes(parsed[:5], int(CFG["rems"]["pds_min_lmst_coverage_h"]))
    assert thin[15] is None  # too few LMST hours covered


def test_feed_marked_stale():
    feed = {"soles": [{"sol": "4995", "terrestrial_date": "2026-08-25", "ls": "341",
                       "min_temp": "-70", "max_temp": "-5", "pressure": "850"},
                      {"sol": "4990", "terrestrial_date": "2026-08-20", "ls": "338"}]}
    lf = rems.latest_feed(feed, CFG, datetime(2026, 11, 14, 12, tzinfo=UTC))
    assert lf["sol"] == 4995 and lf["stale"] is True
    assert lf["stale_since"] == CFG["rems"]["feed_stale_since"]
    assert lf["label"].startswith("stale since")
    assert lf["values"]["min_temp_degC"] == -70.0


def test_donki_label_and_never_a_trigger():
    assert CFG["donki"]["label"] == donki.LABEL == "context only, not a trigger"
    src = (__import__("pathlib").Path(__file__).parent / "tripwire.py").read_text()
    assert "donki" not in src.replace("DONKI", "").lower()  # tripwire/leash never read DONKI


@pytest.mark.skipif(not (OUT / "rad.json").exists(), reason="make conditions not run")
def test_real_outputs_and_margins():
    radj = json.loads((OUT / "rad.json").read_text())
    remsj = json.loads((OUT / "rems.json").read_text())
    dj = json.loads((OUT / "donki.json").read_text())
    assert dj["label"] == "context only, not a trigger"
    assert remsj["latest_feed"]["stale"] is True
    m = margins.margin_inputs()
    assert m["tau_dose_min"] == radj["leash"]["tau_min_at_peak"]
    assert m["t_dark_min"] is None or m["t_dark_min"] > 0


def test_ground_temperature_dropped_d37():
    # D37: air temperature and pressure only; no GTS or UV column, no gts/uv feed field
    assert CFG["rems"]["variables"] == ["air_temperature", "pressure"]
    assert {"ground_temperature", "uv"} <= set(CFG["rems"]["dropped"])
    cols = rems.columns(CFG)
    assert 7 not in cols and 20 not in cols and set(cols) == {15, 37}
    assert all("ground" not in name.lower() for name, _, _ in cols.values())
    feed = {"soles": [{"sol": "4995", "terrestrial_date": "2026-08-25", "ls": "341",
                       "min_temp": "-70", "max_gts_temp": "4", "min_gts_temp": "-84"}]}
    lf = rems.latest_feed(feed, CFG, datetime(2026, 11, 14, 12, tzinfo=UTC))
    assert not any("gts" in k or "uv" in k for k in lf["values"])
    assert all("gts" not in fk for fk in rems.crosscheck_fields(CFG).values())


@pytest.mark.skipif(not (OUT / "rems.json").exists(), reason="make conditions not run")
def test_real_rems_has_no_ground_temperature():
    remsj = json.loads((OUT / "rems.json").read_text())
    rems.validate(remsj)
    text = json.dumps(remsj).lower()
    assert "gts" not in text and "ground" not in text and "uv" not in text
    assert [v["units"] for v in remsj["variables"]] == ["degC", "Pa"]


def test_rewrite_drops_stale_manifest_keys(tmp_path):
    # keys removed from an output (D37: the old 4th REMS row) must not linger in the fragment
    from pipeline.provenance import manifest

    m = tmp_path / "m"
    manifest.record("rems.variables.3.daily_min.median", 1.0, "W/m2", rems.WEB_PATH,
                    rems.__file__, fragment_dir=m)
    obj = {"variables": [{"units": "degC", "daily_min": {"median": -70.0, "p10": -72.0,
                                                         "p90": -68.0},
                          "daily_max": {"median": -20.0, "p10": -25.0, "p90": -15.0}}],
           "sols_used": 1, "latest_feed": {"sol": 1, "stale_since": "2026-08-25"}}
    rems.write_rems(obj, tmp_path / "rems.json", fragment_dir=m)
    frag = json.loads(next(m.glob("*rems.json")).read_text())
    assert "rems.variables.3.daily_min.median" not in frag
    assert frag["rems.variables.0.daily_min.median"]["value"] == -70.0
