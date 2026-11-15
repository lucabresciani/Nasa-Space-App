"""Container healthcheck: GET /api/v1/health answers 200 with ok and engine_warm true.

Usage: python healthcheck.py <url>. Exit 0 = healthy. Standard library only (the image has no curl).
"""

import json
import sys
import urllib.request

try:
    with urllib.request.urlopen(sys.argv[1], timeout=5) as r:
        body = json.load(r)
except Exception as e:  # any failure is "unhealthy"
    print(f"unhealthy: {e}", file=sys.stderr)
    sys.exit(1)
if not (body.get("ok") and body.get("engine_warm")):
    print(f"not ready: {body}", file=sys.stderr)
    sys.exit(1)
