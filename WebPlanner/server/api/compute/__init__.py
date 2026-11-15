"""WS11 compute routes (backend spec §4.2): GET /results/{hash}/... (plan row 1.3), POST /jobs and
GET /jobs/{id} (plan row 2.3), POST /pads/validate and POST /pads/screen (plan row 2.2)."""

from server.api.compute.jobs import router as jobs_router
from server.api.compute.pads import router as pads_router
from server.api.compute.results import identity_provider
from server.api.compute.results import router as results_router

# server/app.py includes jobs_router and results_router; the pad routes ride on jobs_router (same
# compute tag and prefix) so app.py needs no change. If app.py ever includes pads_router itself,
# drop this line (the routes would be registered twice).
jobs_router.include_router(pads_router)

__all__ = ["identity_provider", "jobs_router", "pads_router", "results_router"]
