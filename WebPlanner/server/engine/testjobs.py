"""The shipped test job type (WS11 plan row 2.3): exercises the job runner without the engine.

Registered only by tests (``JobRunner(job_types={"plan": TEST_JOB})``) or, for a manual run, by the
test flag ``HL_TEST_JOBS=1`` (server.engine.jobs.default_job_types) as long as no real ``plan`` type
is registered (E8). It never computes anything: it echoes its inputs.

Behaviour from the plan ``title`` (removed before hashing, so give each test job its own pad):
- ``sleep:<s>``: sleep ``s`` seconds in the "work" stage;
- ``hang``: never finish the "work" stage (the job timeout must end it);
- ``fail:<message>``: raise RuntimeError(message) in the "work" stage;
- anything else (or no title): echo.

Stages, in order: ``inputs`` (inputs.json), ``work`` (work.json), ``summary`` (summary.json).
"""

from __future__ import annotations

import time

from server.engine.jobs import JobContext, JobType

STAGES = ("inputs", "work", "summary")


def run_test_job(inputs: dict, ctx: JobContext) -> None:
    title = str(inputs.get("title") or "")
    ctx.write_json("inputs.json", inputs)
    ctx.stage("inputs")
    slept = 0.0
    if title.startswith("fail:"):
        raise RuntimeError(title.removeprefix("fail:"))
    if title == "hang":
        while True:
            time.sleep(3600)
    if title.startswith("sleep:"):
        slept = float(title.removeprefix("sleep:"))
        time.sleep(slept)
    ctx.write_json("work.json", {"slept_s": slept})
    ctx.stage("work")
    ctx.write_json("summary.json", {"job": ctx.job_id, "stages": list(ctx.done)})
    ctx.stage("summary")


TEST_JOB = JobType(run=run_test_job, stages=STAGES)
