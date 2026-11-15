"""Scaffold smoke test: the pipeline packages from SPEC §4.3 import."""

import importlib

import pytest

PACKAGES = [
    "pipeline",
    "pipeline.terrain",
    "pipeline.engine",
    "pipeline.horizon",
    "pipeline.conditions",
    "pipeline.validation",
    "pipeline.provenance",
    "pipeline.export",
    "pipeline.navigation",
]


@pytest.mark.parametrize("name", PACKAGES)
def test_package_imports(name):
    importlib.import_module(name)
