"""Pure dispatch-brief engine tests (synthetic forecasts; standard library only; no model, no network)."""
import copy
import json
import random
import re
import subprocess
import sys

import pytest

from app.planning import dispatch as D
from app.planning import parameters as PP
from app.planning.scenario import build_hospital_routing, build_intervention_simulation, build_plan

TIERS = ((4.5, "Low"), (14.5, "Medium"), (30.5, "High"))
CITY_SPEC = (("Gazipur", 5, "GCC"), ("Narayanganj", 5, "NCC"), ("Chattogram", 6, "CCC"))
WEEKS = ("2025-08-11", "2025-08-18", "2025-08-25")
SCEN = {"stock_pct": 60, "min_coverage_pct": 30, "total_crews": 12, "capacity_pct": 50, "intervention_scenario": "base"}
GSM_SAFE = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 !\"#$%&'()*+,-./:;<=>?@_\n")


def synthetic(seed=7, source="companion", rename=None, issue="2025-07-28"):
    """Forecast records shaped like Phase 1 + Task 1 output. The first ward of each city has zero demand."""
    rng = random.Random(seed)
    fs, dens = [], {}
    for city, n, prefix in CITY_SPEC:
        for i in range(1, n + 1):
            w = [0.0, 0.0, 0.0] if i == 1 else [round(rng.uniform(0, 14), 4) for _ in range(3)]
            if source == "equal_split":
                w = [w[0]] * 3
            p = round(sum(w), 4)
            w[2] = max(0.0, p - w[0] - w[1])
            ward = f"{prefix}_Ward_{i:02d}"
            if rename and ward in rename:
                ward = rename[ward]
            fs.append({"ward_id": ward, "city": city, "predicted_cases_3wk": p,
                       "risk_tier": next((t for e, t in TIERS if p < e), "Critical"), "early_alert": p > 25,
                       "forecast_weeks": list(WEEKS), "horizon_weeks": [2, 3, 4], "issue_week": issue,
                       "model_version": "test-model-1",
                       "weekly": {"source": source, "model_version": "wk-1" if source == "companion" else None,
                                  "weeks": [{"horizon_week": h, "forecast_week": fw, "predicted_cases": v}
                                            for h, fw, v in zip((2, 3, 4), WEEKS, w)]}})
            dens[ward] = float(rng.randint(18000, 75000))
    return fs, dens


def brief(fs=None, dens=None, **kw):
    if fs is None:
        fs, dens = synthetic()
    return D.build_dispatch_brief(fs, dens, **({"scope": "city", "city": "Gazipur"} | SCEN | kw))


def outputs(b):
    return {"short": D.render_short_text(b), "detailed": D.render_detailed_text(b), "html": D.render_html(b)}


def ward_refs(o):
    """Every ward identifier mentioned in a brief (ward_id / from_ward / to_ward values)."""
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("ward_id", "from_ward", "to_ward") and v is not None:
                yield v
            else:
                yield from ward_refs(v)
    elif isinstance(o, list):
        for v in o:
            yield from ward_refs(v)


def city_wards(fs, city):
    return {f["ward_id"] for f in fs if f["city"] == city}


def find_transfers(fs, dens):
    """(capacity_pct, ward_id) where a simulated transfer touches the ward; synthetic data guarantees one."""
    for cap in (25, 30, 40, 50, 75, 100):
        h = build_hospital_routing(copy.deepcopy(fs), dens, capacity_pct=cap)
        for wk in h["weeks"]:
            for t in wk["transfers"]:
                return cap, t["from_ward"], t["city"]
    raise AssertionError("synthetic data produced no transfers")


# ------------------------------------------------------------------ scope and audience
@pytest.mark.parametrize("city", [c for c, _, _ in CITY_SPEC])
def test_city_scope_contains_only_that_city(city):
    fs, dens = synthetic()
    for cap in (25, 50, 100):
        b = brief(fs, dens, city=city, capacity_pct=cap)
        assert set(ward_refs(b)) <= city_wards(fs, city)
        assert {w["ward_id"] for w in b["sections"]["resource_plan"]["wards"]} == city_wards(fs, city)
        for t in b["sections"]["hospital_overflow"]["simulated_transfers"]:
            assert t["from_ward"] in city_wards(fs, city) and t["to_ward"] in city_wards(fs, city)
        for name in ("short", "detailed", "html"):
            text = outputs(b)[name]
            for other in {f["ward_id"] for f in fs} - city_wards(fs, city):
                assert other not in text and D._display(other) not in text


def test_ward_scope_shows_only_its_own_same_city_transfers():
    fs, dens = synthetic()
    cap, wid, city = find_transfers(fs, dens)
    b = brief(fs, dens, scope="ward", ward_id=wid, city=None, capacity_pct=cap)
    moves = b["sections"]["hospital_overflow"]["simulated_transfers"]
    assert moves, "expected at least one simulated transfer for this ward"
    for t in moves:
        assert wid in (t["from_ward"], t["to_ward"])
        assert {t["from_ward"], t["to_ward"]} <= city_wards(fs, city)
        assert t["status"] == "simulated_proposal_not_executed"
    assert b["scope"] == {"type": "ward", "city": city, "ward_id": wid, "display_name": D._display(wid)}
    assert set(ward_refs(b)) <= city_wards(fs, city)


def test_audience_selects_sections_without_changing_numbers():
    fs, dens = synthetic()
    full = brief(fs, dens, audience="all")
    assert full["sections_included"] == list(D.SECTION_ORDER)
    for aud, expected in (("resource", ["forecast_estimates", "resource_plan", "crew_scenario", "intervention_scenario"]),
                          ("hospital", ["forecast_estimates", "hospital_overflow"])):
        b = brief(fs, dens, audience=aud)
        assert b["sections_included"] == expected and list(b["sections"]) == expected
        for k in expected:
            assert b["sections"][k] == full["sections"][k]
    hosp = outputs(brief(fs, dens, audience="hospital"))
    assert "Saline" not in hosp["detailed"] and "Hypothetical bed capacity" in hosp["detailed"]
    res = outputs(brief(fs, dens, audience="resource"))
    assert "simulated within-city reassignment" not in res["detailed"].lower()


def test_city_scope_with_consistent_ward_id_is_a_city_brief():
    fs, dens = synthetic()
    a = brief(fs, dens, city="Gazipur")
    b = brief(fs, dens, city="Gazipur", ward_id="GCC_Ward_02")
    assert a == b and b["scope"]["ward_id"] is None


# ------------------------------------------------------------------ figures come from the builders
def test_city_figures_equal_builder_outputs():
    fs, dens = synthetic()
    b = brief(fs, dens, city="Narayanganj", capacity_pct=40, intervention_scenario="high")
    plan = build_plan(copy.deepcopy(fs), dens, stock_pct=60, min_coverage_pct=30, total_crews=12)
    hosp = build_hospital_routing(copy.deepcopy(fs), dens, capacity_pct=40)
    sim = build_intervention_simulation(copy.deepcopy(fs), dens, total_crews=12, min_coverage_pct=30)
    pc = next(c for c in plan["cities"] if c["city"] == "Narayanganj")
    r = b["sections"]["resource_plan"]
    for res in ("saline", "kits"):
        assert r[res] == {k: pc[res][k] for k in D._RESOURCE_SUMMARY_KEYS}
    for w in r["wards"]:
        p = next(x for x in plan["wards"] if x["ward_id"] == w["ward_id"])
        assert w["saline"]["allocated"] == p["saline"]["allocated"] and w["kits"]["deficit"] == p["kits"]["deficit"]
    c = b["sections"]["crew_scenario"]
    assert c["city"]["pool"] == pc["crews"]["pool"] and c["city"]["assigned"] == pc["crews"]["assigned"]
    assert c["region"]["total_crews"] == 12
    h = b["sections"]["hospital_overflow"]
    hw = hosp["headline_week_by_city"]["Narayanganj"]["horizon_week"]
    row = next(x for wk in hosp["weeks"] if wk["horizon_week"] == hw for x in wk["cities"] if x["city"] == "Narayanganj")
    assert h["headline"]["horizon_week"] == hw
    for k in D._HOSPITAL_KEYS:
        assert h["headline"][k] == row[k]
    expected_moves = [t for wk in hosp["weeks"] for t in wk["transfers"] if t["city"] == "Narayanganj"]
    assert [(t["from_ward"], t["to_ward"], t["units"]) for t in h["simulated_transfers"]] == \
           [(t["from_ward"], t["to_ward"], t["units"]) for t in expected_moves]
    i = b["sections"]["intervention_scenario"]
    srow = next(x for x in sim["scenarios"]["high"]["cities"] if x["city"] == "Narayanganj")
    assert i["selected_scenario"] == "high" and i["max_reduction"] == PP.INTERVENTION_SCENARIOS["high"]
    assert i["selected"]["projected_cases_avoided"] == srow["projected_cases_avoided"]
    assert [x["scenario"] for x in i["comparison"]] == ["low", "base", "high"]
    assert i["causal"] is False
    assert b["sections"]["forecast_estimates"]["predicted_cases_3wk_total"] == srow["baseline_cases_3wk"]


def test_ward_figures_equal_builder_outputs():
    fs, dens = synthetic()
    wid = "CCC_Ward_03"
    b = brief(fs, dens, scope="ward", ward_id=wid, city=None, intervention_scenario="low")
    plan = build_plan(copy.deepcopy(fs), dens, stock_pct=60, min_coverage_pct=30, total_crews=12)
    hosp = build_hospital_routing(copy.deepcopy(fs), dens, capacity_pct=50)
    sim = build_intervention_simulation(copy.deepcopy(fs), dens, total_crews=12, min_coverage_pct=30)
    p = next(x for x in plan["wards"] if x["ward_id"] == wid)
    h = next(x for x in hosp["wards"] if x["ward_id"] == wid)
    s = next(x for x in sim["wards"] if x["ward_id"] == wid)
    sec = b["sections"]
    assert sec["resource_plan"]["saline"]["allocated"] == p["saline"]["allocated"]
    assert sec["resource_plan"]["kits"]["reason"] == p["kits"]["reason"]
    assert sec["crew_scenario"]["ward"]["assigned"] == p["crews"]["assigned"] == s["crews"]["assigned"]
    assert sec["hospital_overflow"]["weeks"] == h["weeks"]
    assert sec["hospital_overflow"]["ward_hypothetical_capacity"] == h["hypothetical_capacity"]
    assert sec["intervention_scenario"]["selected"]["projected_cases_avoided"] == \
        s["scenarios"]["low"]["projected_cases_avoided"]
    assert sec["forecast_estimates"]["risk_tier"] == p["priority"]["risk_tier"]


def test_every_builder_gets_exactly_the_requested_parameters(monkeypatch):
    calls = {}

    def spy(name, fn):
        def wrapped(forecasts, densities, **kw):
            calls[name] = kw
            return fn(forecasts, densities, **kw)
        return wrapped

    monkeypatch.setattr(D, "build_plan", spy("plan", build_plan))
    monkeypatch.setattr(D, "build_hospital_routing", spy("hospital", build_hospital_routing))
    monkeypatch.setattr(D, "build_intervention_simulation", spy("simulation", build_intervention_simulation))
    b = brief(stock_pct=45, min_coverage_pct=10, total_crews=9, capacity_pct=130, intervention_scenario="low")
    assert calls == {"plan": {"stock_pct": 45, "min_coverage_pct": 10, "total_crews": 9},
                     "hospital": {"capacity_pct": 130},
                     "simulation": {"total_crews": 9, "min_coverage_pct": 10}}
    assert b["scenario"]["parameters"] == {"stock_pct": 45, "min_coverage_pct": 10, "total_crews": 9,
                                           "capacity_pct": 130, "intervention_scenario": "low"}


def test_reconciliation_rejects_disagreeing_layers(monkeypatch):
    def tampered_crews(forecasts, densities, **kw):
        out = build_intervention_simulation(forecasts, densities, **kw)
        w = next(x for x in out["wards"] if x["crews"]["scenario_demand"] > 0)
        w["crews"]["assigned"] += 1
        return out

    monkeypatch.setattr(D, "build_intervention_simulation", tampered_crews)
    with pytest.raises(D.DispatchConsistencyError):
        brief()
    monkeypatch.undo()

    def tampered_beds(forecasts, densities, **kw):
        out = build_hospital_routing(forecasts, densities, **kw)
        out["wards"][3]["weeks"][0]["bed_planning_demand"] += 1
        return out

    monkeypatch.setattr(D, "build_hospital_routing", tampered_beds)
    with pytest.raises(D.DispatchConsistencyError):
        brief()


def test_mixed_issue_weeks_rejected():
    fs, dens = synthetic()
    fs[4]["issue_week"] = "2025-07-21"
    with pytest.raises((D.DispatchConsistencyError, ValueError)):
        brief(fs, dens)


# ------------------------------------------------------------------ identifiers
def test_scenario_id_encodes_every_scenario_parameter():
    fs, dens = synthetic()
    base = brief(fs, dens)
    assert base["scenario_id"] == "DO-20250728-S60-F30-C12-H50-IBASE-WC"
    variants = {"stock_pct": 61, "min_coverage_pct": 31, "total_crews": 13, "capacity_pct": 51,
                "intervention_scenario": "high"}
    seen = {base["scenario_id"]}
    for k, v in variants.items():
        b = brief(fs, dens, **{k: v})
        assert b["scenario_id"] != base["scenario_id"] and b["document_id"] != base["document_id"], k
        assert b["scenario_fingerprint"] != base["scenario_fingerprint"], k
        seen.add(b["scenario_id"])
    assert len(seen) == len(variants) + 1
    fs2, dens2 = synthetic(issue="2025-08-04")
    assert brief(fs2, dens2)["scenario_id"].startswith("DO-20250804-")
    fe, de = synthetic(source="equal_split")
    assert brief(fe, de)["scenario_id"].endswith("-WE")


def test_document_id_distinguishes_scope_audience_and_variant_only():
    fs, dens = synthetic()
    base = brief(fs, dens)
    docs = {base["document_id"]}
    for kw in ({"city": "Narayanganj"}, {"scope": "ward", "ward_id": "GCC_Ward_02", "city": None},
               {"audience": "resource"}, {"audience": "hospital"}, {"variant": "short"}):
        b = brief(fs, dens, **kw)
        assert b["scenario_id"] == base["scenario_id"], kw
        docs.add(b["document_id"])
    assert len(docs) == 6
    assert base["document_id"] == "DO-20250728-S60-F30-C12-H50-IBASE-WC.CITY-GAZIPUR.ALL.DETAILED"


def test_ids_and_file_names_are_deterministic_and_sanitized():
    fs, dens = synthetic(rename={"GCC_Ward_02": 'GCC_<b>"x"&/..\\\r\nSet-Cookie: a=b'})
    b = brief(fs, dens, scope="ward", ward_id='GCC_<b>"x"&/..\\\r\nSet-Cookie: a=b', city=None)
    assert re.fullmatch(r"[A-Z0-9.-]+", b["document_id"])
    assert b["document_id"] == brief(fs, dens, scope="ward", ward_id='GCC_<b>"x"&/..\\\r\nSet-Cookie: a=b',
                                     city=None)["document_id"]
    for fmt in D.FORMATS:
        name = D.filename(b, fmt)
        assert re.fullmatch(r"dispatch_[a-z0-9_-]+\.(json|txt|html)", name) and name.endswith(D.EXTENSIONS[fmt])
    names = {D.filename(b, f)[:-len(D.EXTENSIONS[f])] for f in D.FORMATS}
    assert len(names) == 1          # the output format does not change the identity, only the extension


# ------------------------------------------------------------------ outputs: consistency, labels, safety
def test_text_html_and_json_show_the_same_numbers():
    fs, dens = synthetic()
    b = brief(fs, dens, capacity_pct=30)
    o = outputs(b)
    r, h = b["sections"]["resource_plan"], b["sections"]["hospital_overflow"]["headline"]
    sal = f"{r['saline']['allocated']} of {r['saline']['demand']}"
    assert sal in o["short"] and sal in o["detailed"]
    assert f"<td class=\"num\">{r['saline']['allocated']}</td>" in o["html"]
    assert f"simulated within-city reassignment {h['transfer_units']}" in o["detailed"]
    assert f"reassignment {h['transfer_units']} units" in o["short"] or "More in the detailed brief." in o["short"]
    for text in o.values():
        assert b["scenario_id"] in text
    assert b["document_id"] in o["detailed"] and b["document_id"] in o["html"]
    assert json.loads(D.render(b, "json")[0]) == b


@pytest.mark.parametrize("scope", ["city", "ward"])
@pytest.mark.parametrize("audience", D.AUDIENCES)
def test_every_output_carries_the_draft_labels(scope, audience):
    fs, dens = synthetic()
    kw = {"scope": scope, "audience": audience}
    if scope == "ward":
        kw |= {"ward_id": "NCC_Ward_03", "city": None}
    b = brief(fs, dens, **kw)
    st = b["status"]
    assert st["draft"] is True and st["sent"] is False and st["authorised"] is False
    assert st["simulated"] is True and st["historical_replay"] is True and st["human_verification_required"] is True
    assert st["labels"] == list(D.LABELS) and st["dispatch_capability"] == "none"
    o = outputs(b)
    for label in D.LABELS:
        assert label in o["html"] and label in o["detailed"]
    assert o["short"].startswith("DRAFT/NOT SENT")
    for label in ("SIMULATED PLANNING SCENARIO", "HISTORICAL REPLAY", "HUMAN VERIFICATION REQUIRED"):
        assert label in o["short"]
    assert o["html"].count("DRAFT / NOT SENT") >= len(b["sections_included"]) + 2   # banner, sections, footer
    assert b["verification_checklist"] and all(x in o["detailed"] for x in b["verification_checklist"])


def test_html_escapes_dynamic_strings():
    evil = 'GCC_<script>alert("x")</script>&\'<img src=x onerror=1>'
    fs, dens = synthetic(rename={"GCC_Ward_03": evil})
    for kw in ({"scope": "city", "city": "Gazipur"}, {"scope": "ward", "ward_id": evil, "city": None}):
        b = brief(fs, dens, capacity_pct=25, **kw)
        page = D.render_html(b)
        assert "<script" not in page.lower() and "<img" not in page.lower() and "onerror=1>" not in page
        assert "&lt;script&gt;" in page and "&amp;" in page and "&quot;" in page
        for text in (D.render_short_text(b), D.render_detailed_text(b)):
            assert not re.search(r"[\x00-\x09\x0b-\x1f\x7f]", text)


def test_injected_line_breaks_and_formatting_are_neutralised():
    evil = "GCC_Ward_*X*\n~y~`z`"
    fs, dens = synthetic(rename={"GCC_Ward_03": evil})
    b = brief(fs, dens, scope="ward", ward_id=evil, city=None)
    d = D.render_detailed_text(b)
    assert "*X*" not in d and "~y~" not in d and "`" not in d
    assert all(line.strip() != "~y~`z`" for line in d.splitlines())
    s = D.render_short_text(b)
    assert set(s) <= GSM_SAFE and "`" not in s and "~" not in s
    place = [ln for ln in s.splitlines() if "issue 2025-07-28" in ln]
    assert len(place) == 1 and place[0].startswith("GCC Ward  X ")   # the injected break stayed on one line


def test_false_completion_claims_in_data_are_refused():
    fs, dens = synthetic(rename={"GCC_Ward_03": "Supplies were dispatched"})
    with pytest.raises(D.DispatchRenderError):
        brief(fs, dens)


@pytest.mark.parametrize("seed", range(6))
def test_short_text_fits_three_gsm_segments(seed):
    fs, dens = synthetic(seed=seed)
    combos = [dict(scope="city", city=c) for c, _, _ in CITY_SPEC] + \
             [dict(scope="ward", ward_id=f["ward_id"], city=None) for f in fs[::3]]
    for target in combos:
        for audience in D.AUDIENCES:
            for extra in ({}, {"stock_pct": 100, "total_crews": 10000, "capacity_pct": 200},
                          {"stock_pct": 30, "total_crews": 0, "capacity_pct": 25, "min_coverage_pct": 0}):
                b = brief(fs, dens, audience=audience, variant="short", **target, **extra)
                text = D.render(b, "text")[0]
                assert len(text) <= D.SHORT_MAX_CHARS == 459
                assert text.isascii() and set(text) <= GSM_SAFE
                assert text.startswith("DRAFT/NOT SENT")
                assert text.endswith("HUMAN VERIFICATION REQUIRED before any action.")
                assert b["scenario_id"] in text


def test_detailed_text_uses_display_names_and_no_underscores():
    fs, dens = synthetic()
    for b in (brief(fs, dens), brief(fs, dens, scope="ward", ward_id="GCC_Ward_02", city=None)):
        d = D.render_detailed_text(b)
        assert d.isascii() and "_" not in d
        assert "GCC Ward 02" in d and "GCC_Ward_02" not in d
        assert d.splitlines()[0] == "*DRAFT / NOT SENT*"
    page = D.render_html(brief(fs, dens))
    assert "GCC_Ward_02" in page          # canonical IDs stay in the printable tables


ACCEPTABLE = [
    "10 bed planning units proposed for simulated within-city reassignment.",
    "DRAFT / NOT SENT",
    "It has not been sent to anyone and authorises no action.",
    "Nothing in this brief has been sent, carried out or authorised.",
    "Real capacity has not been verified.",
    "Proposed simulated within-city reassignments (not executed)",
    "transfer_units and transferred_out are planning fields.",
    "If crews were deployed in the issue week, effects would ramp.",
    "Units are bed planning units, not patients, admissions or occupied beds.",
    "Historical replay; not a live or official plan.",
]
UNACCEPTABLE = [
    "10 patients have been transferred.",
    "The SMS was sent to the ward office.",
    "Supplies dispatched to DSCC Ward 04.",
    "Saline has been delivered.",
    "Crews were deployed on Monday.",
    "Bed capacity was verified by the hospital.",
    "This plan is approved.",
    "Official directive: move stock now.",
    "Vector control has been carried out.",
]


def test_false_claim_checker_is_context_aware():
    for s in ACCEPTABLE:
        assert D.false_claim_findings(s) == [], s
    for s in UNACCEPTABLE:
        assert D.false_claim_findings(s), s


def test_rendered_outputs_contain_no_claims_contacts_links_or_send_actions():
    fs, dens = synthetic()
    for kw in ({}, {"audience": "hospital", "capacity_pct": 25}, {"scope": "ward", "ward_id": "CCC_Ward_04", "city": None}):
        b = brief(fs, dens, **kw)
        for name, text in outputs(b).items():
            visible = re.sub(r"<[^>]+>", "\n", text)
            assert D.false_claim_findings(visible) == [], name
            assert not re.search(r"https?://|www\.|wa\.me|sms:|tel:|mailto:", text, re.I), name
            assert not re.search(r"<a\b|<form|<button|<input|onclick|<script|<iframe", text, re.I), name
            assert not re.search(r"[\w.+-]+@[\w-]+\.[a-z]{2,}", text, re.I), name
            assert not re.search(r"\+\d{6,}|\b\d{10,}\b", text), name
            assert not re.search(r"\bsend\b", text, re.I), name
        assert "no recipient or contact details" in b["intended_role"]


# ------------------------------------------------------------------ edge cases
def test_zero_crews():
    b = brief(total_crews=0)
    c = b["sections"]["crew_scenario"]
    assert c["city"]["assigned"] == 0 and c["region"]["total_crews"] == 0
    assert all(w["assigned"] == 0 for w in c["wards"])
    i = b["sections"]["intervention_scenario"]
    assert i["selected"]["projected_cases_avoided"] == 0 and i["selected"]["projected_cases_avoided_per_assigned_crew"] is None
    o = outputs(b)
    assert "n/a per crew" in o["detailed"] and "No crews suggested in this scenario." in o["detailed"]
    assert "n/a" in o["html"]


def test_minimum_stock_and_minimum_capacity():
    fs, dens = synthetic()
    unmet_seen = 0
    for city, _, _ in CITY_SPEC:
        b = brief(fs, dens, city=city, stock_pct=PP.STOCK_PCT_MIN, capacity_pct=PP.CAPACITY_PCT_MIN, min_coverage_pct=50)
        r = b["sections"]["resource_plan"]
        labels = {w[res]["status_label"] for w in r["wards"] for res in ("saline", "kits")}
        assert labels <= {"NO DEMAND", "COVERED", "SHORT", "BELOW FLOOR"} and labels & {"SHORT", "BELOW FLOOR"}
        assert r["saline"]["allocated"] == r["saline"]["stock"]
        h = b["sections"]["hospital_overflow"]
        assert h["hypothetical_capacity"] == PP.CAPACITY_PCT_MIN * PP.HOSPITAL_CITY_BASELINE_BEDS[city] // 100
        for w in h["weeks"]:     # every ward pair connected: unmet = max(0, demand - capacity) in each week
            assert w["unmet_after_routing"] == max(0, w["bed_planning_demand"] - w["hypothetical_capacity"])
        unmet_seen += h["headline"]["unmet_after_routing"]
        page = D.render_html(b)
        assert '<strong class="flag">' in page
        outputs(b)
    assert unmet_seen > 0


def test_zero_demand_ward():
    fs, dens = synthetic()
    b = brief(fs, dens, scope="ward", ward_id="GCC_Ward_01", city=None)
    s = b["sections"]
    assert s["forecast_estimates"]["predicted_cases_3wk"] == 0 and s["forecast_estimates"]["risk_tier"] == "Low"
    assert s["resource_plan"]["saline"]["status_label"] == "NO DEMAND"
    assert s["crew_scenario"]["ward"]["assigned"] == 0
    assert s["hospital_overflow"]["max_weekly_bed_planning_demand"] == 0
    o = outputs(b)
    assert "NO DEMAND" in o["short"] and "no forecast-derived demand" in o["detailed"]


def test_equal_split_fallback_is_disclosed():
    fs, dens = synthetic(source="equal_split")
    b = brief(fs, dens)
    assert b["scenario"]["weekly_source"] == "equal_split" and b["scenario"]["weekly_model_version"] is None
    assert any("equal split" in w for w in b["warnings"])
    o = outputs(b)
    assert "equal split fallback" in o["detailed"] and "equal split fallback" in o["html"]
    hosp = brief(fs, dens, audience="hospital")
    assert any("equal split" in w for w in hosp["warnings"])


def test_retrospective_capacity_disclosure():
    fs, dens = synthetic(issue="2023-08-07")
    b = brief(fs, dens, audience="hospital", variant="short")
    assert b["sections"]["hospital_overflow"]["retrospective_baseline_overlap"] is True
    assert any("retrospective" in w for w in b["warnings"])
    assert "Capacity baseline is retrospective." in D.render_short_text(b)
    assert "Retrospective capacity disclosure" in D.render_html(b)
    assert brief()["sections"]["hospital_overflow"]["retrospective_baseline_overlap"] is False


def test_deterministic_bytes():
    fs, dens = synthetic()
    for kw in ({}, {"scope": "ward", "ward_id": "NCC_Ward_04", "city": None, "variant": "short"}):
        a, b = brief(fs, dens, **kw), brief(copy.deepcopy(fs), dict(dens), **kw)
        assert a == b
        for fmt in D.FORMATS:
            assert D.render(a, fmt)[0].encode("utf-8") == D.render(b, fmt)[0].encode("utf-8")


def test_inputs_are_not_mutated():
    fs, dens = synthetic()
    before = (copy.deepcopy(fs), dict(dens))
    b = brief(fs, dens, audience="all")
    outputs(b)
    brief(fs, dens, scope="ward", ward_id="CCC_Ward_02", city=None)
    assert (fs, dens) == before


# ------------------------------------------------------------------ query validation
@pytest.mark.parametrize("kw,code", [
    ({"scope": "city", "city": None}, "missing_city"),
    ({"scope": "ward", "city": None, "ward_id": None}, "missing_ward_id"),
    ({"scope": "city", "city": "Atlantis"}, "unknown_city"),
    ({"scope": "city", "city": "Dhaka South"}, "unknown_city"),             # valid name, not in these forecasts
    ({"scope": "ward", "city": None, "ward_id": "XYZ_Ward_99"}, "unknown_ward"),
    ({"scope": "ward", "city": "Narayanganj", "ward_id": "GCC_Ward_02"}, "city_ward_mismatch"),
    ({"scope": "city", "city": "Narayanganj", "ward_id": "GCC_Ward_02"}, "city_ward_mismatch"),
    ({"scope": "region"}, "invalid_parameter"),
    ({"stock_pct": 29}, "invalid_parameter"), ({"stock_pct": 101}, "invalid_parameter"),
    ({"min_coverage_pct": 51}, "invalid_parameter"), ({"total_crews": -1}, "invalid_parameter"),
    ({"total_crews": True}, "invalid_parameter"), ({"capacity_pct": 24}, "invalid_parameter"),
    ({"capacity_pct": 201}, "invalid_parameter"), ({"intervention_scenario": "max"}, "invalid_parameter"),
    ({"audience": "press"}, "invalid_parameter"), ({"variant": "long"}, "invalid_parameter"),
])
def test_query_errors(kw, code):
    with pytest.raises(D.DispatchQueryError) as e:
        brief(**kw)
    assert e.value.code == code
    assert "XYZ_Ward_99" not in e.value.message and "Atlantis" not in e.value.message


def test_render_rejects_unknown_format():
    with pytest.raises(D.DispatchQueryError):
        D.render(brief(), "pdf")


def test_html_is_self_contained_and_printable():
    page = D.render_html(brief())
    assert page.startswith("<!DOCTYPE html>\n<html lang=\"en\">") and '<meta charset="utf-8">' in page
    assert "@page { size: A4; margin: 15mm; }" in page and "font-size: 10.5pt" in page
    assert not re.search(r"https?:|//[a-z]|<script|<link|src=|href=|@import|url\(|@font-face", page, re.I)
    assert "<caption>" in page and 'scope="col"' in page and 'scope="row"' in page
    assert "break-inside: avoid" in page and "display: table-header-group" in page


def test_dispatch_engine_imports_no_ml_or_web_stack():
    code = ("import sys; import app.planning.dispatch; "
            "bad=[m for m in ('pandas','numpy','scipy','xgboost','sklearn','fastapi','starlette') if m in sys.modules]; "
            "sys.exit(1 if bad else 0)")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
