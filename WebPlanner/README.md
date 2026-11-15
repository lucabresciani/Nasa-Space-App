# HOMELINE

NASA Space Apps 2026, challenge *Interplanetary Survival Guide: Martian Map*.

HOMELINE draws where a suited crew on Mars can really go and still get home, and checks it against Curiosity's own photos. See `SPEC.md` for the specification and `AGENTS.md` for how the build is organised.

## Quick start

```sh
uv sync            # Python 3.11 pipeline environment
make test          # known-answer tests
cd web && npm ci && npm run dev
```

Raw and intermediate data live in `data/` (a symlink to shared storage, git-ignored).

License: Apache-2.0.
