# HOMELINE pipeline entry points. Stub targets print a message until the owning workstream
# adds its CLI (ownership: AGENTS.md "Folder ownership"; this file is owned by C).
.PHONY: all terrain engine horizons conditions conditions-fetch nav fields fp3d web web-plan bundle bundle-fixture bundle-check mission-official serve stack-up stack-down serverdata parity parity-synthetic server-test dummy test lint validate kats h0 clean

PY := uv run --no-sync python

# Pipeline order (SPEC §4): WS1 terrain -> WS2 engine -> WS3 horizons -> WS4 conditions
# -> WS9 nav -> copy to web/public/data (C).
all: terrain engine horizons conditions nav fields fp3d web

terrain:     ## WS1: fetch raw (cached) then build data/interim/terrain/
	$(PY) -m pipeline.terrain.fetch dem
	$(PY) -m pipeline.terrain.fetch hirise
	$(PY) -m pipeline.terrain.fetch crism
	$(PY) -m pipeline.terrain.fetch lrgb
	$(PY) -m pipeline.terrain.build all
	$(PY) -m pipeline.terrain.build farfield_v2
engine:      ## WS2: return fields, isochrones, bands, edges, partner, stations, route, trade
	$(PY) -m pipeline.engine.scenarios --siting --d21
	$(PY) -m pipeline.engine.golden
horizons:    ## WS3: band check, Navcam frames + stop horizons, V2 + manual-check sheet, pad/station horizons, ring, cards (needs WS1 bands, WS2 stations.json)
	$(PY) -m pipeline.horizon.bands
	$(PY) -m pipeline.horizon.navcam fetch
	$(PY) -m pipeline.validation.v2_skyline
	$(PY) -m pipeline.horizon.cards
conditions:  ## WS4: rad, clock, rems, donki -> data/interim/conditions/ (cache: make conditions-fetch)
	$(PY) -m pipeline.conditions
conditions-fetch:  ## WS4: download/refresh data/raw/conditions/ (needs NASA_API_KEY for DONKI)
	$(PY) -m pipeline.conditions.fetch all
nav:         ## WS9: F21 Monte Carlo + fix-interval map, F22 skyline fixes -> data/interim/navigation/
	$(PY) -m pipeline.navigation.run real $(NAV_ARGS)
fields:      ## WS7: HUD field PNGs + worst-case fields + way-home pointers (own 3 m grid) -> data/interim/export/fields/ (WS1 grid/slope, WS2 rasters; merges WS9 fields_index_nav.json)
	$(PY) -m pipeline.export.fields_png
fp3d:        ## WS8: 3D near chunks, ortho textures, far mesh, index -> data/interim/export/fp3d/ (needs WS1 terrain, WS2 route, WS3 horizons)
	$(PY) -m pipeline.export.terrain_chunks $(FP3D_ARGS)
web:         ## C: copy/transform data/interim -> web/public/data, merge manifest, validate, H0 check
	$(PY) -m pipeline.export.labels
	$(PY) -m pipeline.export.terrain_tiles && $(PY) -m pipeline.export.relief_lowzoom
	$(PY) -m pipeline.export.contours && $(PY) -m pipeline.export.overlays && $(PY) -m pipeline.export.highlights
	$(PY) tools/make_web.py
web-plan:    ## C: what make web would copy, and what is missing per owner (no writes)
	$(PY) tools/make_web.py --plan
bundle:      ## C: simulator plan bundle + world pack zips (D41, contracts/bundle/) -> data/bundles/
	$(PY) tools/make_bundle.py
bundle-fixture:  ## C: rebuild the committed official-pad fixture (contracts/bundle/fixtures/official_pad_v1/)
	$(PY) tools/make_bundle.py --fixture
bundle-check:  ## C: unzip + sha256 + schema check of the committed fixture zips
	$(PY) tools/make_bundle.py --check contracts/bundle/fixtures/official_pad_v1/*.zip
mission-official:  ## WP9c: official plan's mission.json (origin precomputed, D110) -> web/public/sim/official/ (web/public/data read-only)
	$(PY) tools/make_mission.py --official
# --- Backend (optional live layer, D48; docs/backend.md). Server data lives in $(HL_SERVER_DATA).
# server-test and parity-synthetic only name paths that exist ($(wildcard)) and treat pytest exit 5
# ("no tests collected") as success, so CI stays green before server/ and the parity tests land;
# new files under server/ and tests/test_backend_*.py are picked up automatically.
HL_SERVER_DATA ?= data/server
SERVER_TEST_PATHS = $(wildcard server tests/test_backend_*.py)
PYTEST_OK5 = rc=0; $(1) || rc=$$?; if [ $$rc -eq 5 ]; then echo "(no tests collected: ok)"; rc=0; fi; exit $$rc
serve:       ## WS11: run the API locally (http://localhost:8012/api/v1/health; 8000 belongs to another app here)
	HL_SERVER_DATA=$(HL_SERVER_DATA) uv run --no-sync uvicorn server.app:app --host 127.0.0.1 --port 8012 --reload
stack-up:    ## WS12: local Docker stack, API + Caddy (http://127.0.0.1:8012/api/v1/health); see server/ops/README.md
	flock /tmp/hl-heavy.lock server/ops/up.sh
stack-down:  ## WS12: stop the local Docker stack
	docker compose -f server/ops/compose.yaml down
serverdata:  ## WS11: station fields + grids + data manifest -> $(HL_SERVER_DATA) (after the core re-run)
	$(PY) tools/make_serverdata.py --out $(HL_SERVER_DATA)
parity:      ## WS11: official pad via the API == web/public/data (real data; before every server/engine merge, D56). Strict: no tests = fail
	HL_SERVER_DATA=$(HL_SERVER_DATA) HL_PARITY_REAL=1 uv run --no-sync pytest server/tests -k parity -q
parity-synthetic:  ## WS11: batch == server on the synthetic world (what CI runs, D56)
	@$(if $(wildcard server/tests),$(call PYTEST_OK5,uv run --no-sync pytest server/tests -k "parity and synthetic" -q),echo "parity-synthetic: no server/tests yet (ok)")
server-test: ## backend tests: server/ + tests/test_backend_*.py (no real data needed)
	@$(if $(SERVER_TEST_PATHS),$(call PYTEST_OK5,uv run --no-sync pytest $(SERVER_TEST_PATHS) -q),echo "server-test: no backend tests yet (ok)")

dummy:       ## M0: tools/make_dummy.py -> web/public/data-dummy
	$(PY) tools/make_dummy.py --quiet

test:
	uv run --no-sync pytest
lint:
	uv run --no-sync ruff check .
validate:
	$(PY) tools/validate_contracts.py

kats:        ## WS6: test run -> data/interim/validation/kats.json (never fails the build)
	$(PY) -m pipeline.provenance.kats --exit-zero

h0:          ## WS6: no provenance time before H0
	$(PY) -m pipeline.provenance.check_h0

clean:
	rm -rf data/interim/* web/dist .pytest_cache .ruff_cache
