"""DONKI context records (F14; contracts/donki.schema.json).

Cached CME, WSA-ENLIL, notification, SEP and IPS records for config ``donki.window_utc``, labelled
"context only, not a trigger": nothing in HOMELINE is triggered by DONKI (brief WS4 "Don't").
``mars_impact`` is taken from what DONKI publishes: an ENLIL ``impactList`` entry with location
"Mars" (CMEs: any of their ENLIL runs), or a notification whose "Message Type" line names Mars;
null where DONKI publishes no such field (SEP) or no model run exists.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from pipeline.conditions import config
from pipeline.conditions.config import INTERIM, RAW, REPO, fmt_utc, load_conditions, parse_utc

WEB_PATH = "conditions/donki.json"
DEFAULT_OUT = INTERIM / WEB_PATH
SCHEMA_PATH = REPO / "contracts" / "donki.schema.json"
LABEL = "context only, not a trigger"


def _t(s: Any) -> str | None:
    if not s:
        return None
    try:
        return fmt_utc(parse_utc(str(s)))
    except ValueError:
        return None


def _mars_in(impacts: Any) -> bool | None:
    if impacts is None:
        return None
    return any(str(i.get("location", "")).lower() == "mars" for i in impacts or [])


def _mars_arrival(impacts: Any) -> str | None:
    for i in impacts or []:
        if str(i.get("location", "")).lower() == "mars":
            return _t(i.get("arrivalTime"))
    return None


def _cme(r: dict) -> dict:
    an = next((a for a in r.get("cmeAnalyses") or [] if a.get("isMostAccurate")), None)
    runs = [e for a in r.get("cmeAnalyses") or [] for e in a.get("enlilList") or []]
    mars = None if not runs else any(_mars_in(e.get("impactList")) for e in runs)
    if an:
        summ = (f"CME, {an.get('speed')} km/s, half-angle {an.get('halfAngle')} deg, type "
                f"{an.get('type')} (most accurate analysis)")
    else:
        summ = "CME (no analysis published)"
    src = r.get("sourceLocation") or None
    if src:
        summ += f"; source {src}"
    return {"type": "CME", "id": str(r["activityID"]), "time_utc": _t(r.get("startTime")),
            "summary": summ, "link": r.get("link"), "mars_impact": mars}


def _enlil(r: dict) -> dict:
    imp = r.get("impactList")
    arr = _mars_arrival(imp)
    summ = "WSA-ENLIL run; " + (f"Mars arrival {arr}" if arr else "no Mars arrival listed")
    return {"type": "WSAEnlilSimulations", "id": str(r["simulationID"]),
            "time_utc": _t(r.get("modelCompletionTime")), "summary": summ,
            "link": r.get("link"), "mars_impact": _mars_in(imp)}


_MSG_TYPE = re.compile(r"^##\s*Message Type:\s*(.+)$", re.M)


def _notification(r: dict) -> dict:
    m = _MSG_TYPE.search(r.get("messageBody") or "")
    line = m.group(1).strip() if m else str(r.get("messageType"))
    targets = re.search(r"\(([^)]*)\)\s*$", line)
    mars = None if not targets else bool(re.search(r"\bMars\b", targets.group(1)))
    return {"type": "notifications", "id": str(r["messageID"]),
            "time_utc": _t(r.get("messageIssueTime")), "summary": line[:200],
            "link": r.get("messageURL"), "mars_impact": mars}


def _sep(r: dict) -> dict:
    inst = ", ".join(i.get("displayName", "") for i in r.get("instruments") or [])
    return {"type": "SEP", "id": str(r["sepID"]), "time_utc": _t(r.get("eventTime")),
            "summary": f"SEP event ({inst})" if inst else "SEP event", "link": r.get("link"),
            "mars_impact": None}


def _ips(r: dict) -> dict:
    loc = r.get("location") or "?"
    return {"type": "IPS", "id": str(r["activityID"]), "time_utc": _t(r.get("eventTime")),
            "summary": f"interplanetary shock at {loc}", "link": r.get("link"),
            "mars_impact": None if loc == "?" else str(loc).lower() == "mars"}


_PARSERS = {"CME": _cme, "WSAEnlilSimulations": _enlil, "notifications": _notification,
            "SEP": _sep, "IPS": _ips}


def build_donki(cfg: dict[str, Any]) -> dict[str, Any]:
    d = cfg["donki"]
    idx = json.loads((RAW / "index.json").read_text())
    recs, fetched, counts = [], [], {}
    for typ in d["endpoints"]:
        name = f"donki/{typ}.json"
        if name not in idx:
            raise FileNotFoundError(
                f"{name} not cached (python -m pipeline.conditions.fetch donki)")
        fetched.append(idx[name]["fetched_utc"])
        rows = json.loads((RAW / name).read_text() or "[]") or []
        counts[typ] = len(rows)
        recs += [_PARSERS[typ](r) for r in rows]
    recs.sort(key=lambda r: (r["time_utc"] or "", r["type"], r["id"]))
    out = {
        "label": d["label"],
        "fetched_utc": min(fetched) if fetched else None,
        "window_utc": [fmt_utc(parse_utc(s)) for s in d["window_utc"]],
        "records": recs,
        "counts": counts,
        "note": ("DONKI is context for the 2024 storm replay; no alarm, leash or decision in "
                 "HOMELINE uses it"),
    }
    if out["label"] != LABEL:
        raise ValueError(f"config donki.label must be {LABEL!r}")
    validate(out)
    return out


def validate(obj: dict[str, Any]) -> None:
    from jsonschema import Draft202012Validator, FormatChecker  # noqa: PLC0415

    schema = json.loads(SCHEMA_PATH.read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(obj)


def write_donki(obj: dict[str, Any], out_path: Path | None = None, *,
                fragment_dir: Path | None = None) -> Path:
    from pipeline.provenance import manifest  # noqa: PLC0415

    validate(obj)
    config.reset_manifest_fragment(__file__, fragment_dir)
    path = out_path or DEFAULT_OUT
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(obj, indent=1, allow_nan=False) + "\n").encode()
    path.write_bytes(data)
    for typ, n in obj["counts"].items():
        manifest.record(f"donki.counts.{typ}", n, "1", WEB_PATH, __file__,
                        fragment_dir=fragment_dir)
    manifest.record(f"file_sha256.{WEB_PATH}", hashlib.sha256(data).hexdigest(), None,
                    WEB_PATH, __file__, fragment_dir=fragment_dir)
    return path


if __name__ == "__main__":  # pragma: no cover
    print(json.dumps(build_donki(load_conditions())["counts"]))
