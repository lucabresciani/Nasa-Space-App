# Load test: 10 parallel guests (H1, kit "Hardening: load test (10 parallel guests), limits")

## Run 2 (current result, main 5efe912): PASS. Nothing broke

Run 2 used the same scenario as run 1, on main with both fixes:
- **H1-1:** E7b, PR #81 (8f2df5b). A job temp dir carries an owner file (`.owner.json`). A starting server
  removes only the dirs whose owner is gone or that are older than 2× the timeout.
- **H1-2:** O3b, PR #83 (5efe912). Attaches and cached results pass the per-IP limit; new jobs are still
  counted.

| Item | Value |
|---|---|
| Date / commit | 2026-11-15, 05:44–05:54 CET. HEAD bcaa390 = this doc's commit on origin/main 5efe912; `/engine/version` commit == HEAD, engine tree 6135328 as in run 1 |
| Pre-checks, inside the lock | `ss -ltnp`: no uvicorn or python on the HOMELINE ports (only unrelated apps on 8000/8001/8099/8732/8743). No process with `HL_SERVER_DATA=/home/vincent/hl-data/server`. No `results/.job-*` dir. 8012 free |
| Server | `make serve` on 127.0.0.1:8012, as in run 1. The whole run (pre-checks, server, load, stop) was in one `flock /tmp/hl-heavy.lock` |
| Job pads | `load.py` now uses only pads with no result tree yet. The import hash is checked against `/results/{hash}/run_record.json`. So P1 here is run 1's failed P3 pad (137.370953, −4.8122) |
| Evidence | `/tmp/hl-orch/h1/run2/`, `/tmp/hl-orch/h1/run2.log`, `/tmp/hl-orch/h1/api2.log` (0 tracebacks) |

A first attempt at 05:38 was aborted in `load.py`'s set-up before any job: the valid-pad search asked for more
distinct pads than the nearest-valid search yields and never ended. The loop is now bounded. That attempt
did no job and no write; its log is `/tmp/hl-orch/h1/run2-aborted-setup.log`.

### Run 2: per endpoint (600 s, 10 guests, 12,755 requests)

| Endpoint | n | Statuses | p50 ms | p95 ms | max ms |
|---|---:|---|---:|---:|---:|
| GET /health | 2001 | 200 ×2001 | 1.9 | 4.8 | 618.4 |
| GET /defaults | 246 | 200 ×246 | 2.1 | 9.6 | 39.3 |
| GET /engine/version | 237 | 200 ×237 | 2.0 | 8.9 | 690.4 |
| GET /results/{official}/* (23 files) | 8258 | 200 ×8258 | 25.1 | 141.3 | 1347.0 |
| POST /pads/validate | 818 | 200 ×818 | 2.5 | 7.3 | 440.0 |
| POST /pads/screen | 715 | 200 ×420, 422 invalid_pad ×295 (intended) | 6.1 | 12.2 | 721.3 |
| POST /jobs | 15 | 202 ×13, 429 rate_limited ×1, 503 heavy_jobs_off ×1 (both intended) | 4.2 | 25.3 | 25.3 |
| GET /jobs/{id} | 463 | 200 ×463 | 1.3 | 4.2 | 15.1 |
| POST /admin/heavy-jobs | 2 | 200 ×2 | 13.0 | 16.8 | 16.8 |

- 0 unexpected 5xx and 0 transport errors.
- `/health` while 2 jobs ran: 1951 samples, **p95 4.5 ms, max 618 ms**, none over 2 s.

### Run 2: jobs and limits

| t | Who | What | Answer | Run 1 → run 2 |
|---:|---|---|---|---|
| 5.1 | guests 0 + 1 | same new pad P1 | one job `j_8e8c…`: one `attached:false`, one `attached:true` | same |
| 10.1 | guest 2 | official inputs | 202 done (not counted) | same |
| 10.1 | guest 2 | P2, P3 | 202 queued (count 2, 3) | same |
| 12.1 | guest 2 | P1 again | 202 attached | same |
| 300.0 | admin | kill switch on | 200, `/health heavy_jobs:"off"` | same |
| 300.0 | guest 2 / 1 / 2 / admin | new pad / attach P1 / official / run_record | **503 heavy_jobs_off** / 202 attached / 202 done / 200 | same |
| 320.0 | admin | kill switch off | 200, `heavy_jobs:"on"` | same |
| 320.0 | guest 2 | P4, P5, P6 | 202 queued (count 4, 5, 6) | same |
| 320.1 | guest 2 | 7th new pad | **429 rate_limited, `Retry-After: 286`** | same |
| 320.1 | guest 0 | P1 (running) | **202 attached** | **429 → 202 (H1-2 fixed)** |
| 320.1 | guest 2 | official inputs | **202 done** | **429 → 202 (H1-2 fixed)** |

Submit outcomes: 6 new, 4 attached, 3 cached done, 1 × 503, 1 × 429.

Job outcomes:

| Job | Result |
|---|---|
| P1 `1d6d36512b32163a` (run 1's failed pad) | **done** in 423 s (nominal 140, bands 234, partner 21, route 29) |
| P2 `2e846a6411346170` | **done** in 461 s (nominal 167, bands 253, partner 16, route 24) |
| P3, P4 | running at the end of the window |
| P5, P6 | queued at the end of the window |

**No job lost and none in error.** The running jobs' dirs held their `.owner.json` until the stop. The
shutdown of `make serve` at the end took P3–P6 with it (intended) and removed their temp dirs: no
`results/.job-*` was left.

These custom pads, with 2 jobs at once under the guest load, took 70–77 % of `compute.job_timeout_s` (600 s).
That matches H5-7. It is not a failure, but there is not much headroom if the machine is loaded during the demo.

### Run 2: memory and processes

- **Peak RSS of the API tree: 3.76 GiB** at t = 142 s, while P1 and P2 ran. The peak breakdown:

  | Process | RSS |
  |---|---|
  | job workers | 1817 + 1532 MiB |
  | API process | 426 MiB |
  | make + uv + reloader + resource_tracker | 73 MiB |

  The run minimum was 0.89 GiB. It is higher than run 1's 3.17 GiB because both jobs were in their
  heavy stages at once. **Size for at least 4 GiB with `compute.workers: 2`** (H1-3).
- Processes before the stop: the reloader, the resource_tracker, the API process and **exactly 2 pool workers**.
  No leak.
- After the stop: no hl-h1 python process, 8012 free, and the lock was released.

## Run 1 (history, main 09548a8): PARTIAL. The API held under load, but 1 of 6 jobs was lost (H1-1)

- **Held:**
  - 0 unexpected 5xx and 0 transport errors in 12,623 requests.
  - `/health` p95 was 4.1 ms (max 338 ms) while 2 jobs ran. The 2 s limit is `api.health_timeout_s`.
  - One job for two guests on the same pad.
  - The 7th new heavy job got 429 with Retry-After.
  - Kill switch: 503 for new jobs, while reads, attaches and cached results kept working.
  - Exactly 2 pool workers at the end, and nothing was left after the stop.
- **Broke:**
  - **H1-1:** a running job's temp dir was deleted under it by another server process started on the same
    `$HL_SERVER_DATA` (`FileNotFoundError`, job `error`).
  - **H1-2:** once the per-IP limit is reached, attaches and cached results are refused with 429 too. They
    are not *counted*, but they are *blocked*.
- **Memory:** the peak RSS of the API process tree was **3.17 GiB**, above the expected ~2.4 GiB (see "Run 1: memory and processes").

| Item | Value |
|---|---|
| Date / commit | 2026-11-15, 02:54–03:05 CET, origin/main 09548a8 (`/engine/version` commit == HEAD) |
| Server | `make serve` (uvicorn `--reload`) on 127.0.0.1:8012. `HL_SERVER_DATA=/home/vincent/hl-data/server`, `HL_TEAM_TOKEN=loadtest` (this server only). The whole run was under `flock /tmp/hl-heavy.lock` |
| Guests | 10, all from 127.0.0.1 (one rate-limit key). Each has its own httpx connection pool. Duration 600 s |
| Machine | 16 cores, shared. Load average 1–4 before the run |
| Evidence | `/tmp/hl-orch/h1/run1/` (requests.jsonl, mem.tsv, summary.json, jobs.json), `/tmp/hl-orch/h1/run1.log`, `/tmp/hl-orch/h1/api.log` |

### Run 1: per endpoint (600 s, 10 guests)

| Endpoint | n | Statuses | p50 ms | p95 ms | max ms |
|---|---:|---|---:|---:|---:|
| GET /health (every 3 s per guest) | 2000 | 200 ×2000 | 1.8 | 4.6 | 337.5 |
| GET /defaults | 246 | 200 ×246 | 2.0 | 12.1 | 100.5 |
| GET /engine/version | 237 | 200 ×237 | 1.9 | 7.3 | 20.3 |
| GET /results/{official}/* (23 files: run_record.json, provenance, manifest, index, pad, labels, stations, every 104 kg + nominal scenario file) | 8281 | 200 ×8281 | 24.4 | 124.9 | 1241.5 |
| POST /pads/validate (random valid + invalid) | 819 | 200 ×819 | 2.3 | 7.0 | 20.9 |
| POST /pads/screen (random valid + invalid) | 716 | 200 ×421, 422 invalid_pad ×295 (intended) | 5.9 | 13.4 | 287.5 |
| POST /jobs | 15 | 202 ×11, 429 rate_limited ×3, 503 heavy_jobs_off ×1 (intended) | 5.1 | 18.5 | 18.5 |
| GET /jobs/{id} (poll every 5 s) | 307 | 200 ×307 | 1.4 | 4.0 | 15.7 |
| POST /admin/heavy-jobs | 2 | 200 ×2 | 15.1 | 20.1 | 20.1 |

`/health` while 2 jobs ran: 1664 samples, **p95 4.1 ms, max 337.5 ms**. No sample took over 2 s.
The slowest reads are the 8.7 MB `isochrones.geojson` files, read 6 at a time by each guest (as a
browser does).

### Run 1: jobs and limits (timeline, t = seconds from start)

| t | Who | What | Answer | Expected? |
|---:|---|---|---|---|
| 5.1 | guests 0 + 1, same moment | same new pad P1 | one 202 `attached:false` + one 202 `attached:true`, same job id `j_93e7…` | yes |
| 10.1 | guest 2 | official inputs | 202 `done`, `attached:true` (cached, not counted) | yes |
| 10.1 | guest 2 | new pads P2, P3 | 202 queued ×2 (count 2, 3) | yes |
| 12.2 | guest 2 | P1 again | 202 attached (not counted) | yes |
| 300.0 | admin | `POST /admin/heavy-jobs {"heavy_jobs":"off"}` with `X-HL-Team` | 200; `/health heavy_jobs:"off"` | yes |
| 300.0 | guest 2 | new pad P4 | **503 heavy_jobs_off** | yes |
| 300.0 | guest 1 | P1 (running) | 202 attached | yes |
| 300.0 | guest 2 | official inputs | 202 done | yes |
| 300.0 | admin | GET official run_record.json | 200 | yes |
| 320.1 | admin | heavy jobs back on | 200; `/health heavy_jobs:"on"` | yes |
| 320.1 | guest 2 | P4, P5, P6 | 202 queued ×3 (count 4, 5, 6: the attaches and the cached result did not use any of the budget) | yes |
| 320.1 | guest 2 | 7th new pad | **429 rate_limited, `Retry-After: 286`, `retry_after_s: 286`** | yes |
| 320.1 | guest 0 | P1 (done by then) | **429 rate_limited** | **no (H1-2)** |
| 320.1 | guest 2 | official inputs | **429 rate_limited** | **no (H1-2)** |

Submit outcomes: 6 new, 3 attached, 2 cached done, 1 × 503, 3 × 429.

Job outcomes:

| Job | Pad | Result |
|---|---|---|
| P1 `d78fb9db1d0d666f` | 137.409249, −4.81797 | done in 313 s (nominal 104, bands 167, partner 18, route 25) |
| P2 `d3dba099c4d12ea5` | 137.414328, −4.779505 | done in 155 s |
| P3 `1d6d36512b32163a` | 137.370953, −4.8122 | **error after 70 s (H1-1)** |
| P4, P5 | — | running at the stop |
| P6 | — | queued at the stop |

The stop was intended: `make serve` was stopped at the end of the window, and the runner's shutdown
took P4–P6 with it.

The queue cap (`compute.queue_max_waiting` 20, 429 `queue_full`) **cannot be reached from one
address**: 6 new jobs per 10 min < 2 running + 20 waiting. With every guest on 127.0.0.1 (and in
the Docker stack, every local client on the bridge gateway, O1 note 3), the per-IP limit fires
first. Reaching it needs at least 4 client addresses. This run did not test it; the E7 unit tests
cover it.

### Run 1: memory and processes

- The peak RSS of the whole tree was **3.17 GiB**, at t = 133 s while P1 and P3 ran. The peak breakdown:

  | Process | RSS |
  |---|---|
  | job worker 1 | 1775 MiB |
  | job worker 2 | 935 MiB |
  | API process (preloaded server data) | 461 MiB |
  | uv + make + reloader + resource_tracker | 76 MiB |

  The minimum during the run was 0.95 GiB. H5 measured ~2.4 GiB with one job. With **two jobs at once**
  the tree reaches about 3.2 GiB, so size for about 3.5 GiB.
- Processes at the end of the run (before the stop), from `/proc`:
  - make, uv, the uvicorn reloader and the resource_tracker;
  - the API process;
  - **exactly 2 pool workers** (`spawn_main` children of the API process).

  No worker leak, including after P3's error.
- After the stop, the uvicorn log ends with "Application shutdown complete" and "Stopping reloader process".
  `ps` showed no hl-h1 python process left, and 8012 was free.

### Run 1: findings (H1-1 and H1-2 fixed on main, see run 2; H1-3 is sizing)

#### H1-1: a job lost because another process cleaned the shared results dir (owner: WS11/E7 jobs.py)
P3 failed with:

    FileNotFoundError: .../results/.job-j_10cf51493390a4b8/.work/preview/public/scenarios/nom_104/edges.geojson

The job's own temp dir disappeared while it was writing. Nothing in this server removes a running job's dir.
`JobRunner._clean_stale()` removes **every** `results/.job-*` dir at start-up, including the dirs of jobs
that another live server is running on the same `$HL_SERVER_DATA`.

During the run, another agent's server (worktree hl-e8c, port 8063, `HL_SERVER_DATA=/home/vincent/hl-data/server`)
started at 02:59:55. `results/` was modified at 02:59:57. At 03:00:10, `results/` held **no** `.job-*` dir,
although P4 and P5 had been running for 27 s. So their temp dirs were also gone, and they would have
failed in the same way if the server had stayed up. The same agent was running pytest around P3's failure
(02:58:18; `/tmp/pytest-of-vincent/pytest-1059`/`-1060` were written at 02:57–02:59). This is the probable
trigger for P3, but it is not proven.

Demo impact: none if exactly one server uses the data dir. That is the D60/port rule, but it is not
enforced. Any second `uvicorn server.app`, `make parity`, or test run with the real `HL_SERVER_DATA` kills
live jobs.

Fix options, for E7, not done here:
- (a) Clean only `.job-*` dirs older than `job_timeout_s`.
- (b) Hold an exclusive lock file in `results/` for the life of a runner, and refuse a second runner.
- (c) Put the temp dirs under a per-process subdir.

Re-run this test after the fix, with no other server on the same data dir.

#### H1-2: at the per-IP limit, attaches and cached results are refused with 429 (owner: WS12/O3 limits.py)
`HeavyJobLimiter` reserves a slot before the route runs, and refuses when there is none. At that point it
cannot know whether the submit would only attach or return `done`. So a guest who has used up the 6 new
jobs gets 429 for:
- a pad another guest is already computing;
- the official / any cached plan through `POST /jobs`.

The docstring says these "cost nothing". That is true for *counting*: the budget filled at exactly 6 new
jobs. But they are *blocked* until the window frees. In the demo, all local clients share one key (O1
note 3, O1b), so one busy judge can block cached plans for everyone for up to 10 min.

Fix options, for O3/C:
- (a) When the window is full, let the request through with no slot, and turn a would-be new job into 429
  after the route answers. This needs a "dry" submit, or the route raising before it queues.
- (b) Check `result_done(hash)` and running hashes in the middleware before refusing.

The web client opens permalinks through `/results`, which is not affected.

#### H1-3: memory with two jobs is about 3.2 GiB, not about 2.4 GiB (sizing, no fix)
See "Run 1: memory and processes". Run 2 measured 3.76 GiB. Both pool workers can hold a job at once (`compute.workers: 2`).

## How to re-run

```
cd <worktree>; ln -s ~/hl-data data       # gitignored; plan jobs read data/interim/conditions
uv sync --group server                    # the worktree needs its venv
ss -ltn | grep 8012                       # must be empty (else use a port in 8020-8099 and --base)
# Make sure no other server or test uses the same HL_SERVER_DATA (ss -ltnp; ls results/.job-*).
flock /tmp/hl-heavy.lock bash -c '
  export HL_TEAM_TOKEN=loadtest HL_SERVER_DATA=$HOME/hl-data/server
  setsid make serve > /tmp/h1-api.log 2>&1 & S=$!
  until curl -s 127.0.0.1:8012/api/v1/health | grep -q "engine_warm\":true"; do sleep 1; done
  uv run --no-sync python docs/hardening/load.py --root-pid $S --out /tmp/h1-run --duration 600
  pkill -INT -s $S'
```

- `--dry` runs the reads only, with no jobs and no budget used (a smoke run). `load.py --help` lists the
  options.
- The script prints one line per job event, then the table above. `RESULT: PASS` (exit 0) needs all of
  these:
  - no unexpected 5xx and no transport errors;
  - `/health` p95 under 2 s while 2 jobs run;
  - no job in error or lost;
  - exactly 2 pool workers;
  - every scenario check true.
- The rate-limit window lives in the API process. Restart the server before a re-run, or the budget is
  already used.
- Do not edit `*.py` files in the worktree while it runs: `make serve` uses `--reload`.
- Job pads come from `/pads/validate`'s `nearest_valid` of random points (seed 71). They are new unless a
  result tree for them exists in `results/`. The script then moves to the next pad, and a pad that
  answers `attached` or `done` does not count.
