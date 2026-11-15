"""WS12 plan routes (backend spec §4.2 server/api/plans): POST /plans/import, result pinning, and
the API docs page (F28, F35). The plan library, versions and share codes are cut (D69)."""

from server.api.plans.apidocs import build_router as build_docs_router
from server.api.plans.importer import router as import_router

__all__ = ["build_docs_router", "import_router"]
