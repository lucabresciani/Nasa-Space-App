"""POST /pads/validate and POST /pads/screen (openapi.yaml validatePad, screenPad; F24 steps 1-2;
WS11 plan row 2.2). Rules and numbers: server.engine.pads (the D21 rule and screening from the
engine, on the precomputed station fields; no Dijkstra per request).

Responses (every body is openapi PadCheck / PadScreen or the openapi Error, all with
``Cache-Control: no-store``: the answer follows the server data, which make serverdata replaces):
- 200 PadCheck: valid, or invalid with the reason (slope, unknown_terrain, disc_off_grid,
  outside_grid) and the nearest valid block.
- 200 PadScreen: the instant preview of a valid pad with default inputs.
- 422 Error:
  - invalid_request: the body is not JSON or (validate) not an openapi LonLat;
  - invalid_inputs: (screen) not a valid plan_inputs (detail = the error list);
  - unsupported_inputs: (screen) a block other than the pad differs from the defaults;
  - invalid_pad: (screen) the pad fails the D21 rule (an invalid pad never gets a preview).
- 503 Error, as the other routes: server_data_missing (no $HL_SERVER_DATA manifest, or it lacks
  what the pad tool reads), engine_identity_unavailable (no git / HL_COMMIT).
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from server.api.compute.results import Identity
from server.engine import pads, version
from server.engine.hashing import InvalidPlanInputs

NO_STORE = {"Cache-Control": "no-store"}

router = APIRouter(tags=["compute"])


def _error(status: int, code: str, detail) -> JSONResponse:
    return JSONResponse({"error": code, "detail": detail}, status_code=status, headers=NO_STORE)


def _unavailable(e: version.Unavailable) -> JSONResponse:
    msg = str(e)
    code = "server_data_missing" if "manifest" in msg else "engine_identity_unavailable"
    return _error(503, code, msg)


async def _body(request: Request):
    try:
        return await request.json(), None
    except ValueError:
        return None, _error(422, "invalid_request", "the body is not JSON")


async def _run(identity, fn, *args) -> JSONResponse:
    try:
        identity()  # the same identity the results and jobs routes need (503 without it)
        body = await run_in_threadpool(fn, *args)
    except version.Unavailable as e:
        return _unavailable(e)
    except pads.ServerDataMissing as e:
        return _error(503, "server_data_missing", str(e))
    except InvalidPlanInputs as e:
        return _error(422, "invalid_inputs", e.errors)
    except pads.UnsupportedInputs as e:
        return _error(422, "unsupported_inputs", str(e))
    except pads.InvalidPad as e:
        return _error(422, "invalid_pad", str(e))
    return JSONResponse(body, headers=NO_STORE)


@router.post("/pads/validate", operation_id="validatePad")
async def validate_pad(request: Request, identity: Identity) -> JSONResponse:
    body, err = await _body(request)
    if err is not None:
        return err
    errs = pads.lonlat_errors(body)
    if errs:
        return _error(422, "invalid_request", errs)
    return await _run(identity, pads.check_pad, float(body["lon"]), float(body["lat"]))


@router.post("/pads/screen", operation_id="screenPad")
async def screen_pad(request: Request, identity: Identity) -> JSONResponse:
    body, err = await _body(request)
    if err is not None:
        return err
    if not isinstance(body, dict):
        return _error(422, "invalid_inputs", ["(root): the body must be a plan_inputs object"])
    return await _run(identity, pads.screen, body)
