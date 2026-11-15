"""Every config/*.yaml parses to a mapping (copied verbatim from docs/config-values.md)."""

from pathlib import Path

import pytest
import yaml

CONFIG = Path(__file__).resolve().parents[1] / "config"
EXPECTED = {
    "site", "stations", "crew", "variants", "haul", "horizon",
    "conditions", "hud", "nav", "landmarks", "event",
}


def test_expected_files_present():
    assert EXPECTED <= {p.stem for p in CONFIG.glob("*.yaml")}


@pytest.mark.parametrize("path", sorted(CONFIG.glob("*.yaml")), ids=lambda p: p.name)
def test_parses_to_mapping(path):
    assert isinstance(yaml.safe_load(path.read_text()), dict)
