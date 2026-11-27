"""Generate or check the sample dispatch exports in exports/ (offline, in-process; no network).

The samples are produced through the public GET /dispatch-brief endpoint, called in-process with FastAPI's
TestClient (no socket, no hosted API), from the local model artifacts. The bytes are deterministic: no
timestamps, no machine paths, UTF-8, LF line endings.

Usage, from the repository root:
    python backend/scripts/generate_exports.py --check   # recompute in memory and compare; writes nothing
    python backend/scripts/generate_exports.py --write   # explicitly (re)write the three sample files

Only these files are ever written: exports/city_dispatch_sample.html, exports/ward_dispatch_sample.txt,
exports/hospital_overflow_sample.txt.
"""
from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path
from urllib.parse import urlencode

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
EXPORTS_DIR = REPO_DIR / "exports"

# Scenario A (city and ward) and scenario B (hospital). Parameters not named by the scenario use the
# documented endpoint defaults, written out here so the samples never depend on a default changing silently.
SCENARIO_A = {"issue_date": "2025-07-28", "stock_pct": 60, "min_coverage_pct": 30, "total_crews": 40,
              "capacity_pct": 75, "intervention_scenario": "base"}
SCENARIO_B = {"issue_date": "2023-08-07", "stock_pct": 100, "min_coverage_pct": 30, "total_crews": 60,
              "capacity_pct": 75, "intervention_scenario": "base"}
CITY = "Dhaka South"
WARD = "DSCC_Ward_04"

SAMPLES = {
    "city_dispatch_sample.html": {
        "title": None,
        "parts": [(None, {**SCENARIO_A, "scope": "city", "city": CITY, "audience": "all", "variant": "detailed",
                          "format": "html"})],
    },
    "ward_dispatch_sample.txt": {
        "title": "Ward dispatch brief, text variants (scenario A)",
        "parts": [
            ("SHORT VARIANT (SMS-style, ASCII, at most 459 characters)",
             {**SCENARIO_A, "scope": "ward", "ward_id": WARD, "audience": "all", "variant": "short", "format": "text"}),
            ("DETAILED VARIANT (WhatsApp-ready plain text)",
             {**SCENARIO_A, "scope": "ward", "ward_id": WARD, "audience": "all", "variant": "detailed",
              "format": "text"}),
        ],
    },
    "hospital_overflow_sample.txt": {
        "title": "City hospital overflow brief, text variants (scenario B)",
        "parts": [
            ("SHORT VARIANT (SMS-style, ASCII, at most 459 characters)",
             {**SCENARIO_B, "scope": "city", "city": CITY, "audience": "hospital", "variant": "short",
              "format": "text"}),
            ("DETAILED VARIANT (WhatsApp-ready plain text)",
             {**SCENARIO_B, "scope": "city", "city": CITY, "audience": "hospital", "variant": "detailed",
              "format": "text"}),
        ],
    },
}


class ExportError(RuntimeError):
    pass


def _client(model_loader=None):
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        from fastapi.testclient import TestClient
    from app.main import create_app

    app = create_app() if model_loader is None else create_app(model_loader=model_loader)
    return TestClient(app, raise_server_exceptions=False)


def _fetch(client, params: dict) -> str:
    r = client.get("/dispatch-brief", params=params)
    if r.status_code != 200:
        raise ExportError(f"GET /dispatch-brief returned HTTP {r.status_code}: {r.text[:200]}")
    return r.content.decode("utf-8")


def _text_file(title: str, parts: list[tuple[str, dict, str]]) -> str:
    out = ["DENGUE OUTLOOK - SAMPLE EXPORT - " + title,
           "Generated offline by backend/scripts/generate_exports.py from GET /dispatch-brief.",
           "Sample of a draft planning brief: nothing was sent, dispatched or authorised.", ""]
    for heading, params, body in parts:
        out += ["=" * 72, heading, "Request: GET /dispatch-brief?" + urlencode(params), "=" * 72, body.rstrip("\n"), ""]
    return "\n".join(out)


def build_samples(model_loader=None) -> dict[str, bytes]:
    """Recompute every sample in memory -> {file name: exact bytes}. Writes nothing."""
    out: dict[str, bytes] = {}
    with _client(model_loader) as client:
        for name, spec in SAMPLES.items():
            bodies = [(heading, params, _fetch(client, params)) for heading, params in spec["parts"]]
            text = bodies[0][2] if spec["title"] is None else _text_file(spec["title"], bodies)
            if "\r" in text:
                raise ExportError("sample text contains a carriage return")
            out[name] = text.encode("utf-8")
    return out


def check(samples: dict[str, bytes]) -> list[str]:
    """Names of committed samples that are missing or differ from the recomputed bytes."""
    bad = []
    for name, data in samples.items():
        path = EXPORTS_DIR / name
        if not path.is_file() or path.read_bytes() != data:
            bad.append(name)
    return bad


def write(samples: dict[str, bytes]) -> None:
    EXPORTS_DIR.mkdir(exist_ok=True)
    for name, data in samples.items():
        if name not in SAMPLES:
            raise ExportError("refusing to write an unapproved file name")
        (EXPORTS_DIR / name).write_bytes(data)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Generate or check the sample dispatch exports (offline).")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="recompute in memory and compare with exports/")
    mode.add_argument("--write", action="store_true", help="explicitly (re)write the sample files in exports/")
    args = parser.parse_args(argv)
    samples = build_samples()
    if args.check:
        bad = check(samples)
        for name in bad:
            print(f"DIFFERS OR MISSING: exports/{name}")
        if not bad:
            print(f"OK: {len(samples)} sample exports match byte for byte.")
        return 1 if bad else 0
    write(samples)
    for name, data in samples.items():
        print(f"wrote exports/{name} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
