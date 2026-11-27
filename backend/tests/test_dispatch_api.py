"""GET /dispatch-brief against the real Phase 1 model and planning layers, plus offline and sample-export checks."""
import importlib.util
import re
import socket
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import create_app
from app.model_service import load_portable_forecaster
from app.planning import dispatch as D
from app.planning.demand import PlanningDataError

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "backend" / "scripts" / "generate_exports.py"
EXPORTS = REPO / "exports"
A = {"issue_date": "2025-07-28", "stock_pct": 60, "min_coverage_pct": 30, "total_crews": 40, "capacity_pct": 75,
     "intervention_scenario": "base"}
CITY = {"scope": "city", "city": "Dhaka South"}
WARD = {"scope": "ward", "ward_id": "DSCC_Ward_04"}
SAMPLE_FILES = ("city_dispatch_sample.html", "ward_dispatch_sample.txt", "hospital_overflow_sample.txt")


@pytest.fixture(scope="module")
def direct():
    return load_portable_forecaster()


@pytest.fixture(scope="module")
def live(direct):
    with TestClient(create_app(model_loader=lambda: direct), raise_server_exceptions=False) as c:
        yield c


def get(c, **params):
    return c.get("/dispatch-brief", params=params)


# ------------------------------------------------------------------ network guard (outbound only)
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@pytest.fixture()
def no_network(monkeypatch):
    """Block every non-loopback connection and name lookup. Loopback stays allowed because the Windows asyncio
    event loop uses a local socket pair internally; the TestClient itself makes no socket connection."""
    attempts = []
    real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex
    real_getaddrinfo, real_create = socket.getaddrinfo, socket.create_connection

    def host_of(address):
        return address[0] if isinstance(address, tuple) and address else address

    def guarded(fn):
        def inner(self, address, *a, **k):
            if host_of(address) not in LOOPBACK:
                attempts.append(host_of(address))
                raise OSError("outbound network blocked in test")
            return fn(self, address, *a, **k)
        return inner

    def getaddrinfo(host, *a, **k):
        if host not in LOOPBACK and host is not None:
            attempts.append(host)
            raise OSError("name lookup blocked in test")
        return real_getaddrinfo(host, *a, **k)

    def create_connection(address, *a, **k):
        if host_of(address) not in LOOPBACK:
            attempts.append(host_of(address))
            raise OSError("outbound network blocked in test")
        return real_create(address, *a, **k)

    monkeypatch.setattr(socket.socket, "connect", guarded(real_connect))
    monkeypatch.setattr(socket.socket, "connect_ex", guarded(real_connect_ex))
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    monkeypatch.setattr(socket, "create_connection", create_connection)
    yield attempts


def test_network_guard_blocks_outbound(no_network):
    with pytest.raises(OSError):
        socket.create_connection(("example.org", 80), timeout=1)
    with pytest.raises(OSError):
        socket.getaddrinfo("example.org", 443)
    assert no_network == ["example.org", "example.org"]


# ------------------------------------------------------------------ formats and headers
def test_json_brief(live, direct):
    r = get(live, **A, **CITY)
    assert r.status_code == 200 and r.headers["content-type"] == "application/json"
    assert r.headers["x-content-type-options"] == "nosniff" and "content-disposition" not in r.headers
    b = r.json()
    assert b["mode"] == "historical_replay" and b["notice"]
    assert b["status"]["draft"] is True and b["status"]["sent"] is False and b["status"]["authorised"] is False
    assert b["scenario_id"] == "DO-20250728-S60-F30-C40-H75-IBASE-WC"
    assert b["document_id"] == "DO-20250728-S60-F30-C40-H75-IBASE-WC.CITY-DHAKA-SOUTH.ALL.DETAILED"
    assert b["scenario"]["model_version"] == direct.model_version and b["scenario"]["weekly_source"] == "companion"
    assert b["scenario"]["forecast_weeks"] == ["2025-08-11", "2025-08-18", "2025-08-25"]
    assert b["scope"] == {"type": "city", "city": "Dhaka South", "ward_id": None, "display_name": "Dhaka South",
                          "ward_count": 20}


def test_default_issue_week_and_parameters(live, direct):
    b = get(live, **CITY).json()
    assert b["scenario"]["issue_week"] == direct.valid_issue_weeks()["last"]
    assert b["scenario"]["parameters"] == {"stock_pct": 100, "min_coverage_pct": 30, "total_crews": 60,
                                           "capacity_pct": 100, "intervention_scenario": "base"}
    assert b["audience"] == "all" and b["variant"] == "detailed"


@pytest.mark.parametrize("variant", ["short", "detailed"])
def test_text_output(live, variant):
    r = get(live, **A, **WARD, variant=variant, format="text")
    assert r.status_code == 200 and r.headers["content-type"] == "text/plain; charset=utf-8"
    assert r.headers["x-content-type-options"] == "nosniff" and "content-security-policy" not in r.headers
    text = r.content.decode("utf-8")
    assert text.isascii()
    if variant == "short":
        assert text.startswith("DRAFT/NOT SENT") and len(text) <= 459
        assert "DSCC Ward 04 (Dhaka South)" in text
    else:
        assert text.startswith("*DRAFT / NOT SENT*") and "_" not in text and "DSCC Ward 04" in text


def test_html_output_and_security_headers(live):
    r = get(live, **A, **CITY, format="html")
    assert r.status_code == 200 and r.headers["content-type"] == "text/html; charset=utf-8"
    assert r.headers["content-security-policy"] == "default-src 'none'; style-src 'unsafe-inline'"
    assert r.headers["x-content-type-options"] == "nosniff"
    page = r.content.decode("utf-8")
    assert page.startswith("<!DOCTYPE html>") and "DSCC_Ward_04" in page
    assert not re.search(r"https?:|<script|<link|src=|href=|@import|url\(", page, re.I)


@pytest.mark.parametrize("fmt,ext", [("json", "json"), ("text", "txt"), ("html", "html")])
def test_download_header(live, fmt, ext):
    r = get(live, **A, **CITY, format=fmt, download="true")
    assert r.status_code == 200
    cd = r.headers["content-disposition"]
    m = re.fullmatch(r'attachment; filename="(dispatch_[a-z0-9_-]+\.' + ext + r')"', cd)
    assert m, cd
    assert m.group(1) == f"dispatch_do-20250728-s60-f30-c40-h75-ibase-wc_city-dhaka-south_all_detailed.{ext}"


def test_responses_are_deterministic(live):
    for fmt in ("json", "text", "html"):
        assert get(live, **A, **CITY, format=fmt).content == get(live, **A, **CITY, format=fmt).content


# ------------------------------------------------------------------ errors
@pytest.mark.parametrize("params,status,code", [
    ({}, 422, "validation_error"),
    ({"scope": "city"}, 400, "missing_city"),
    ({"scope": "ward"}, 400, "missing_ward_id"),
    ({"scope": "city", "city": "Atlantis"}, 404, "unknown_city"),
    ({"scope": "ward", "ward_id": "XYZ_Ward_99"}, 404, "unknown_ward"),
    ({"scope": "ward", "ward_id": "DSCC_Ward_04", "city": "Gazipur"}, 400, "city_ward_mismatch"),
    ({"scope": "city", "city": "Gazipur", "ward_id": "DSCC_Ward_04"}, 400, "city_ward_mismatch"),
    ({"scope": "ward", "ward_id": "<script>"}, 422, "validation_error"),
    ({"scope": "city", "city": "x" * 41}, 422, "validation_error"),
    ({"scope": "region", "city": "Gazipur"}, 422, "validation_error"),
    ({**CITY, "issue_date": "2025-07-29"}, 400, "invalid_date"),
    ({**CITY, "issue_date": "not-a-date"}, 400, "invalid_date"),
    ({**CITY, "issue_date": "1999-01-04"}, 404, "issue_week_out_of_range"),
    ({**CITY, "stock_pct": 29}, 422, "validation_error"),
    ({**CITY, "stock_pct": 101}, 422, "validation_error"),
    ({**CITY, "min_coverage_pct": 51}, 422, "validation_error"),
    ({**CITY, "total_crews": -1}, 422, "validation_error"),
    ({**CITY, "total_crews": 10001}, 422, "validation_error"),
    ({**CITY, "capacity_pct": 24}, 422, "validation_error"),
    ({**CITY, "capacity_pct": 201}, 422, "validation_error"),
    ({**CITY, "intervention_scenario": "extreme"}, 422, "validation_error"),
    ({**CITY, "audience": "press"}, 422, "validation_error"),
    ({**CITY, "variant": "long"}, 422, "validation_error"),
    ({**CITY, "format": "pdf"}, 422, "validation_error"),
])
@pytest.mark.parametrize("fmt", ["json", "html"])
def test_errors_are_safe_json(live, params, status, code, fmt):
    params = dict(params)
    if fmt == "html" and params.get("format") != "pdf":
        params["format"] = "html"
    r = get(live, **params)
    assert r.status_code == status, r.text
    assert r.headers["content-type"] == "application/json"
    assert r.json()["error"]["code"] == code
    assert "content-disposition" not in r.headers
    for leaked in ("Atlantis", "XYZ_Ward_99", "<script>", "Traceback", "\\", "D:", "File \""):
        assert leaked not in r.text


def test_model_unavailable_returns_503():
    def boom():
        raise RuntimeError("C:\\secret\\model path")

    with TestClient(create_app(model_loader=boom), raise_server_exceptions=False) as c:
        for fmt in ("json", "text", "html"):
            r = get(c, **CITY, format=fmt)
            assert r.status_code == 503 and r.json()["error"]["code"] == "model_unavailable"
            assert "secret" not in r.text
        r = get(c, scope="city")        # structural errors are still reported first and safely
        assert r.status_code == 400 and r.json()["error"]["code"] == "missing_city"


@pytest.mark.parametrize("exc", [PlanningDataError("C:\\secret\\file.csv row 7"),
                                 D.DispatchConsistencyError("crew assignment differs"),
                                 D.DispatchRenderError("output contains a completion claim")])
def test_internal_failures_return_controlled_500(live, monkeypatch, exc):
    def fail(*a, **k):
        raise exc

    monkeypatch.setattr(main_module.D, "build_dispatch_brief", fail)
    r = get(live, **A, **CITY, format="html")
    assert r.status_code == 500 and r.headers["content-type"] == "application/json"
    assert r.json() == {"error": {"code": "planning_data_invalid",
                                  "message": "The forecast data could not be converted into a dispatch brief."}}
    assert "secret" not in r.text and "crew" not in r.text and "claim" not in r.text


# ------------------------------------------------------------------ consistency with the public endpoints
def test_figures_match_the_existing_endpoints(live):
    b = get(live, **A, **CITY).json()
    alloc = live.get("/allocation", params={k: A[k] for k in ("issue_date", "stock_pct", "min_coverage_pct",
                                                               "total_crews")}).json()
    hosp = live.get("/hospital-routing", params={"issue_date": A["issue_date"], "capacity_pct": 75}).json()
    sim = live.get("/intervention-simulation", params={"issue_date": A["issue_date"], "total_crews": 40,
                                                       "min_coverage_pct": 30}).json()
    ac = next(c for c in alloc["cities"] if c["city"] == "Dhaka South")
    r = b["sections"]["resource_plan"]
    assert (r["saline"]["allocated"], r["saline"]["demand"]) == (ac["saline"]["allocated"], ac["saline"]["demand"]) == (639, 1065)
    assert (r["kits"]["allocated"], r["kits"]["demand"]) == (ac["kits"]["allocated"], ac["kits"]["demand"]) == (312, 521)
    assert r["saline"]["wards_with_deficit"] == ac["saline"]["wards_with_deficit"] == 14
    aw = {w["ward_id"]: w for w in alloc["wards"]}
    for w in r["wards"]:
        assert w["saline"]["allocated"] == aw[w["ward_id"]]["saline"]["allocated"]
    c = b["sections"]["crew_scenario"]
    assert c["city"]["pool"] == ac["crews"]["pool"] == 12 and c["city"]["scenario_demand"] == 76
    for w in c["wards"]:
        assert w["assigned"] == aw[w["ward_id"]]["crews"]["assigned"]
    h = b["sections"]["hospital_overflow"]
    hw = hosp["headline_week_by_city"]["Dhaka South"]
    row = next(x for wk in hosp["weeks"] if wk["horizon_week"] == hw["horizon_week"]
               for x in wk["cities"] if x["city"] == "Dhaka South")
    assert h["headline"]["forecast_week"] == hw["forecast_week"]
    assert h["headline"]["bed_planning_demand"] == row["bed_planning_demand"]
    assert h["headline"]["transfer_units"] == row["transfer_units"]
    assert h["hypothetical_capacity"] == 64
    i = b["sections"]["intervention_scenario"]
    srow = next(x for x in sim["scenarios"]["base"]["cities"] if x["city"] == "Dhaka South")
    assert i["selected"] == {k: srow[k] for k in i["selected"]}
    assert i["causal"] is False


def test_hospital_scenario_b_figures(live):
    b = get(live, issue_date="2023-08-07", capacity_pct=75, audience="hospital", **CITY).json()
    h = b["sections"]["hospital_overflow"]
    hd = h["headline"]
    assert (hd["forecast_week"], hd["horizon_week"]) == ("2023-09-04", 4)
    assert (hd["bed_planning_demand"], hd["hypothetical_capacity"], hd["transfer_units"], hd["unmet_after_routing"],
            hd["wards_with_unmet"]) == (76, 64, 5, 12, 11)
    assert h["retrospective_baseline_overlap"] is True and any("before 2024" in w for w in b["warnings"])
    assert b["scenario_id"] == "DO-20230807-S100-F30-C60-H75-IBASE-WC"
    assert all(t["from_ward"].startswith("DSCC_") and t["to_ward"].startswith("DSCC_") for t in h["simulated_transfers"])


def test_city_and_ward_isolation_live(live):
    low = {**A, "capacity_pct": 25}
    r = get(live, **low, **CITY)
    city = r.json()
    refs = re.findall(r'"(?:ward_id|from_ward|to_ward)":"([^"]+)"', r.text)
    assert refs and all(x.startswith("DSCC_") for x in refs)
    assert city["sections"]["hospital_overflow"]["simulated_transfers"] or \
        city["sections"]["hospital_overflow"]["headline"]["unmet_after_routing"] > 0
    for fmt in ("text", "html"):
        body = get(live, **low, **CITY, format=fmt).text
        assert not re.search(r"\b(?:DNCC|NCC|CCC|GCC)[_ ]Ward", body)
    ward = get(live, **low, scope="ward", ward_id="DSCC_Ward_04").json()
    for t in ward["sections"]["hospital_overflow"]["simulated_transfers"]:
        assert "DSCC_Ward_04" in (t["from_ward"], t["to_ward"]) and t["to_ward"].startswith("DSCC_")


def test_existing_endpoints_unchanged(live):
    calls = [("/forecast", {"issue_date": "2025-07-28"}),
             ("/allocation", {"issue_date": "2025-07-28", "stock_pct": 60, "total_crews": 40}),
             ("/hospital-routing", {"issue_date": "2025-07-28", "capacity_pct": 75}),
             ("/intervention-simulation", {"issue_date": "2025-07-28", "total_crews": 40})]
    before = [live.get(u, params=p).content for u, p in calls]
    for fmt in ("json", "text", "html"):
        assert get(live, **A, **CITY, format=fmt).status_code == 200
        assert get(live, **A, **WARD, format=fmt, variant="short").status_code == 200
    assert [live.get(u, params=p).content for u, p in calls] == before
    assert live.get("/health").json()["model_ready"] is True


def test_cors_methods_not_expanded(live):
    r = live.options("/dispatch-brief", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
    assert "POST" not in r.headers.get("access-control-allow-methods", "")


def test_import_is_lazy():
    code = ("import sys; sys.path.insert(0, '.'); import app.main; "
            "bad=[m for m in ('pandas','numpy','xgboost','sklearn','predict_portable','phase2') if m in sys.modules]; "
            "sys.exit(1 if bad else 0)")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(REPO / "backend"))
    assert r.returncode == 0, r.stderr


# ------------------------------------------------------------------ offline
def test_backend_generates_every_format_with_outbound_network_blocked(no_network):
    with TestClient(create_app(), raise_server_exceptions=False) as c:      # real loader, inside the guard
        for target in (CITY, WARD):
            for fmt in ("json", "text", "html"):
                for variant in ("short", "detailed"):
                    r = get(c, **A, **target, format=fmt, variant=variant)
                    assert r.status_code == 200, (target, fmt, variant)
    assert no_network == []


# ------------------------------------------------------------------ sample exports
def _generator():
    spec = importlib.util.spec_from_file_location("generate_exports_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_sample_files_exist_and_regenerate_byte_for_byte_offline(direct, no_network):
    gen = _generator()
    assert set(gen.SAMPLES) == set(SAMPLE_FILES)
    samples = gen.build_samples(model_loader=lambda: direct)
    assert no_network == []
    for name in SAMPLE_FILES:
        assert (EXPORTS / name).is_file(), name
        assert (EXPORTS / name).read_bytes() == samples[name], name
    assert gen.check(samples) == []
    assert gen.check({name: b"different" for name in SAMPLE_FILES}) == list(SAMPLE_FILES)


def test_sample_contents():
    html_page = (EXPORTS / "city_dispatch_sample.html").read_bytes().decode("utf-8")
    ward = (EXPORTS / "ward_dispatch_sample.txt").read_bytes().decode("utf-8")
    hosp = (EXPORTS / "hospital_overflow_sample.txt").read_bytes().decode("utf-8")
    assert "DO-20250728-S60-F30-C40-H75-IBASE-WC.CITY-DHAKA-SOUTH.ALL.DETAILED" in html_page
    assert "DO-20250728-S60-F30-C40-H75-IBASE-WC.WARD-DSCC-WARD-04.ALL.DETAILED" in ward
    assert "DO-20230807-S100-F30-C60-H75-IBASE-WC.CITY-DHAKA-SOUTH.HOSPITAL.DETAILED" in hosp
    assert "Capacity baseline is retrospective" in hosp and "before 2024" in hosp
    assert "demand 76, local 59, simulated within-city reassignment 5, unmet 12 in 11 wards" in hosp
    assert "<td class=\"num\">639</td>" in html_page and "<td class=\"num\">1065</td>" in html_page
    for text in (html_page, ward, hosp):
        for label in D.LABELS:
            assert label in text
        assert "\r" not in text
        assert not re.search(r"[A-Za-z]:\\|\\\\|/home/|/Users/|Users\\|Lenovo|AppData|denguehackathon", text)
        assert not re.search(r"[\w.+-]+@[\w-]+\.[a-z]{2,}", text, re.I)
        assert not re.search(r"https?://|www\.|wa\.me|sms:|tel:|mailto:|<a\b|<form|<button|<script|<link|src=", text, re.I)
        assert not re.search(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", text)        # no generation timestamps
    for txt in (ward, hosp):
        short = txt.split("=" * 72)[2].strip("\n")
        assert short.startswith("DRAFT/NOT SENT") and len(short) <= 459 and short.isascii()


def test_generator_check_mode_and_no_silent_overwrite():
    before = {n: (EXPORTS / n).read_bytes() for n in SAMPLE_FILES}
    r = subprocess.run([sys.executable, "-B", str(SCRIPT)], capture_output=True, text=True, cwd=str(REPO))
    assert r.returncode == 2 and "--check" in r.stderr
    r = subprocess.run([sys.executable, "-B", str(SCRIPT), "--check"], capture_output=True, text=True, cwd=str(REPO))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "OK: 3 sample exports match byte for byte." in r.stdout
    assert {n: (EXPORTS / n).read_bytes() for n in SAMPLE_FILES} == before
    assert sorted(p.name for p in EXPORTS.iterdir()) == sorted([".gitattributes", "README.md", *SAMPLE_FILES])
