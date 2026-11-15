"""WS11 engine service internals: warm-up, version identity, defaults, result hash, result trees,
job runner, the plan job type and the exporter registry (D76).

Every number comes from pipeline/engine; nothing here re-implements the engine (WS11 rule 1).
"""

from server.engine.exporters import register_exporter, run_exporters
from server.engine.hashing import (
    EngineIdentity,
    InvalidPlanInputs,
    canonical_inputs,
    canonical_json,
    engine_identity,
    official_hash,
    official_inputs,
    result_hash,
)
from server.engine.jobs import (
    JobContext,
    JobRunner,
    JobType,
    heavy_jobs_off,
    register_job_type,
    set_heavy_jobs_off,
)

# Registers the "plan" job type at import, before server.app's create_app() builds the runner
# (JobRunner.from_config copies the registry at construction).
from server.engine.plan_job import PLAN_JOB  # noqa: E402
from server.engine.results import (
    ResultNotFound,
    ResultTree,
    precomputed_run_record,
    resolve_file,
    resolve_tree,
)

__all__ = [
    "PLAN_JOB",
    "EngineIdentity",
    "InvalidPlanInputs",
    "JobContext",
    "JobRunner",
    "JobType",
    "ResultNotFound",
    "ResultTree",
    "canonical_inputs",
    "canonical_json",
    "engine_identity",
    "heavy_jobs_off",
    "official_hash",
    "official_inputs",
    "precomputed_run_record",
    "register_exporter",
    "register_job_type",
    "resolve_file",
    "resolve_tree",
    "result_hash",
    "run_exporters",
    "set_heavy_jobs_off",
]
