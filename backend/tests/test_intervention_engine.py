"""Pure intervention-simulation engine and scenario tests (standard library only; no model)."""
import itertools
import math
import random
import subprocess
import sys
from decimal import Decimal

import pytest

from app.planning import parameters as PP
from app.planning.demand import bed_planning_demand, consumable_demand, half_up
from app.planning.intervention import (CrewCandidate, InterventionInputError, coverage, first_crew_ranking,
                                       marginal_benefit, max_reduction, per_crew, projected_avoided, roi_greedy,
                                       saturation, ward_effect)
from app.planning.scenario import build_intervention_simulation, build_plan

M = PP.INTERVENTION_SCENARIOS
TOL = 1e-9


# ------------------------------------------------------------------ formula
def test_parameters_match_reviewed_handoff():
    assert M == {"low": 0.15, "base": 0.35, "high": 0.55}
    assert PP.INTERVENTION_SATURATION_K == 1.4 and PP.INTERVENTION_RAMP == {2: 0.5, 3: 0.85, 4: 1.0}
    assert PP.CREW_DENSITY_PER_CREW == 12000 and PP.CREW_MAX_PER_WARD == 6
    assert PP.INTERVENTION_POLICY["causal"] is False
    assert PP.INTERVENTION_POLICY["effect_size_basis"] == "assumed_scenario_not_learned"


@pytest.mark.parametrize("weekly,density,expected", [
    # Reviewed handoff examples/output_auto10_base.json (2025-09-01, base, 1 crew; inputs published at 4 dp).
    ((8.5731, 4.9405, 5.8239), 18314, 3.0072),    # DSCC_Ward_05
    ((6.4446, 5.2019, 4.1271), 18945, 2.4226),    # NCC_Ward_03
    ((8.356, 6.6254, 6.8473), 38726, 2.0519),     # CCC_Ward_07
])
def test_matches_handoff_reference_values(weekly, density, expected):
    assert abs(projected_avoided(weekly, 1, density, M["base"]) - expected) < 2e-4


def test_coverage_and_saturation():
    assert coverage(0, 40000) == 0
    assert coverage(3, 36000) == pytest.approx(1.0)
    assert coverage(2, 6000) == 2.0                      # max(1, density/12000) floor
    assert saturation(0) == 0.0
    assert saturation(1.0) == pytest.approx(1 - math.exp(-1.4))
    assert max_reduction(3, 36000, 0.35) == pytest.approx(0.35 * (1 - math.exp(-1.4)))


def test_weekly_ramp_and_identity():
    e = ward_effect((10.0, 10.0, 10.0), 2, 30000, 0.35)
    r = e.max_reduction
    assert e.reductions == pytest.approx((0.5 * r, 0.85 * r, r))
    for b, a, v in zip(e.baseline, e.adjusted, e.avoided):
        assert abs(b - (a + v)) < TOL and 0 <= a <= b and 0 <= v <= b
    assert e.avoided[0] < e.avoided[1] < e.avoided[2]


def test_zero_crews_and_zero_baseline():
    e = ward_effect((4.0, 5.0, 6.0), 0, 40000, 0.55)
    assert e.reductions == (0.0, 0.0, 0.0) and e.adjusted == e.baseline and e.avoided_total == 0
    e = ward_effect((0.0, 0.0, 0.0), 6, 40000, 0.55)
    assert e.adjusted == (0.0, 0.0, 0.0) and e.avoided_total == 0


@pytest.mark.parametrize("bad", [
    lambda: ward_effect((1, 1, 1), 7, 40000, 0.35), lambda: ward_effect((1, 1, 1), -1, 40000, 0.35),
    lambda: ward_effect((1, 1, 1), 1.5, 40000, 0.35), lambda: ward_effect((1, 1, 1), True, 40000, 0.35),
    lambda: ward_effect((1, 1, 1), 1, 0, 0.35), lambda: ward_effect((1, 1, 1), 1, float("inf"), 0.35),
    lambda: ward_effect((1, 1, 1), 1, float("nan"), 0.35), lambda: ward_effect((1, -1, 1), 1, 40000, 0.35),
    lambda: ward_effect((1, 1), 1, 40000, 0.35), lambda: ward_effect((1, 1, 1), 1, 40000, 1.0),
    lambda: ward_effect((1, float("nan"), 1), 1, 40000, 0.35),
])
def test_invalid_inputs_rejected(bad):
    with pytest.raises(InterventionInputError):
        bad()


def test_extreme_density_stays_bounded():
    e = ward_effect((5.0, 5.0, 5.0), 6, 1e9, 0.55)
    assert 0 <= e.max_reduction < 1e-3 and all(0 <= x <= 0.55 for x in e.reductions)


def test_randomized_bounds_ordering_and_monotonicity():
    rng = random.Random(20261127)
    for _ in range(600):
        b = tuple(rng.choice([0.0, rng.uniform(0, 60)]) for _ in range(3))
        dens = rng.uniform(15000, 80000)
        prev_by_crews = None
        for c in range(0, 7):
            vals = []
            for s in ("low", "base", "high"):
                e = ward_effect(b, c, dens, M[s])
                assert all(0 <= x <= 0.55 for x in e.reductions)
                for bh, ah, vh in zip(e.baseline, e.adjusted, e.avoided):
                    assert 0 <= ah <= bh + TOL and 0 <= vh <= bh + TOL and abs(bh - ah - vh) < TOL
                vals.append(e.avoided_total)
            assert vals[0] <= vals[1] + TOL and vals[1] <= vals[2] + TOL        # low <= base <= high
            if prev_by_crews is not None:
                assert all(v >= p - TOL for v, p in zip(vals, prev_by_crews))  # more crews never reduce benefit
            prev_by_crews = vals
        gains = [projected_avoided(b, c + 1, dens, M["base"]) - projected_avoided(b, c, dens, M["base"])
                 for c in range(6)]
        assert all(g2 <= g1 + TOL for g1, g2 in zip(gains, gains[1:]))            # diminishing returns


def test_determinism():
    args = ((7.1, 3.3, 9.9), 4, 51234, 0.35)
    assert all(ward_effect(*args) == ward_effect(*args) for _ in range(5))


def test_per_crew_zero_denominator():
    assert per_crew(5.0, 0) is None and per_crew(5.0, 2) == 2.5


# ------------------------------------------------------------------ ROI alternative and first-crew ranking
def cand(wid, cap, prio, b, dens):
    return CrewCandidate(wid, cap, (prio, wid), tuple(b), dens)


def brute_force(cands, pool, m):
    best = -1.0
    for combo in itertools.product(*[range(c.cap + 1) for c in cands]):
        if sum(combo) == pool:
            best = max(best, sum(projected_avoided(c.baseline, k, c.density, m) for c, k in zip(cands, combo)))
    return best


def test_roi_greedy_matches_brute_force_on_small_instances():
    rng = random.Random(7)
    for _ in range(120):
        cands = [cand(f"w{i}", rng.randint(0, 3), i, [rng.uniform(0, 30) for _ in range(3)], rng.uniform(18000, 75000))
                 for i in range(rng.randint(1, 4))]
        pool = rng.randint(0, sum(c.cap for c in cands))
        alloc = roi_greedy(cands, pool, M["base"])
        assert sum(alloc.values()) == pool and all(0 <= alloc[c.ward_id] <= c.cap for c in cands)
        got = sum(projected_avoided(c.baseline, alloc[c.ward_id], c.density, M["base"]) for c in cands)
        assert got >= brute_force(cands, pool, M["base"]) - 1e-9


def test_roi_greedy_ties_use_priority_and_caps():
    same = [10.0, 10.0, 10.0]
    cands = [cand("b", 2, 1, same, 30000), cand("a", 2, 0, same, 30000), cand("z", 0, 2, [50, 50, 50], 30000)]
    assert roi_greedy(cands, 1, M["base"]) == {"b": 0, "a": 1, "z": 0}      # tie -> priority 0 ("a"); z ineligible
    assert roi_greedy(cands, 4, M["base"]) == {"b": 2, "a": 2, "z": 0}
    with pytest.raises(InterventionInputError):
        roi_greedy(cands, 5, M["base"])


def test_roi_greedy_ranking_same_for_all_scenarios():
    rng = random.Random(11)
    for _ in range(40):
        cands = [cand(f"w{i}", rng.randint(0, 6), i, [rng.uniform(0, 30) for _ in range(3)], rng.uniform(18000, 75000))
                 for i in range(6)]
        pool = rng.randint(0, sum(c.cap for c in cands))
        assert roi_greedy(cands, pool, M["low"]) == roi_greedy(cands, pool, M["base"]) == roi_greedy(cands, pool, M["high"])


def test_first_crew_ranking_and_marginal():
    cands = [cand("lowdens", 2, 1, [10, 10, 10], 20000), cand("highdens", 6, 0, [10, 10, 10], 70000),
             cand("ineligible", 0, 2, [40, 40, 40], 20000)]
    rank = first_crew_ranking(cands, M["base"])
    assert [w for w, _ in rank] == ["lowdens", "highdens"]                    # density workload effect
    assert rank[0][1] == pytest.approx(projected_avoided((10, 10, 10), 1, 20000, M["base"]))
    assert marginal_benefit(cands[0], 2, M["base"]) is None                   # at cap
    assert marginal_benefit(cands[2], 0, M["base"]) is None                   # ineligible (cap 0)


# ------------------------------------------------------------------ full scenario (synthetic forecasts)
TIERS = ((4.5, "Low"), (14.5, "Medium"), (30.5, "High"))


def synthetic(seed=3, source="companion"):
    rng = random.Random(seed)
    weeks = ("2025-08-11", "2025-08-18", "2025-08-25")
    fs, dens = [], {}
    for city, n, prefix in (("Gazipur", 5, "GCC"), ("Narayanganj", 5, "NCC"), ("Chattogram", 10, "CCC")):
        for i in range(1, n + 1):
            w = [round(rng.choice([0.0, rng.uniform(0, 20)]), 4) for _ in range(3)]
            if source == "equal_split":
                w = [w[0]] * 3
            p = round(sum(w), 4)
            w[2] = max(0.0, p - w[0] - w[1])   # avoid float noise such as -3.5e-15 (real weekly values are >= 0)
            ward = f"{prefix}_Ward_{i:02d}"
            fs.append({"ward_id": ward, "city": city, "predicted_cases_3wk": p,
                       "risk_tier": next((t for e, t in TIERS if p < e), "Critical"), "early_alert": p > 25,
                       "forecast_weeks": list(weeks), "horizon_weeks": [2, 3, 4], "issue_week": "2025-07-28",
                       "model_version": "m",
                       "weekly": {"source": source, "weeks": [{"horizon_week": h, "forecast_week": fw, "predicted_cases": v}
                                                              for h, fw, v in zip((2, 3, 4), weeks, w)]}})
            dens[ward] = float(rng.randint(18000, 75000))
    return fs, dens


def sim(fs, dens, **kw):
    return build_intervention_simulation(fs, dens, **({"total_crews": 15, "min_coverage_pct": 30} | kw))


def test_uses_task2_crews_and_pools_exactly():
    fs, dens = synthetic()
    for crews in (0, 7, 15, 40, 500):
        b = sim(fs, dens, total_crews=crews)
        plan = build_plan(fs, dens, stock_pct=100, min_coverage_pct=30, total_crews=crews)
        t2 = {w["ward_id"]: w["crews"] for w in plan["wards"]}
        for w in b["wards"]:
            assert w["crews"]["assigned"] == t2[w["ward_id"]]["assigned"]
            assert w["crews"]["scenario_demand"] == t2[w["ward_id"]]["scenario_demand"]
            if w["risk_tier"] == "Low":
                assert w["crews"]["scenario_demand"] == 0 and w["crews"]["next_crew_status"] == "ineligible"
        assert b["crews"]["assigned"] + b["crews"]["unassigned"] == crews
        assert b["crews"]["city_pools"] == {c["city"]: c["crews"]["pool"] for c in plan["cities"]}


def test_baseline_resources_equal_task2_and_task3_conventions():
    fs, dens = synthetic()
    b = sim(fs, dens)
    plan = build_plan(fs, dens, stock_pct=100, min_coverage_pct=30, total_crews=15)
    t2 = {w["ward_id"]: w for w in plan["wards"]}
    for w in b["wards"]:
        base = w["baseline_planning_units"]
        assert base["saline"] == t2[w["ward_id"]]["saline"]["demand"] and base["kits"] == t2[w["ward_id"]]["kits"]["demand"]
        assert base["peak_bed_planning_units"] == t2[w["ward_id"]]["bed_plan"]["bed_planning_demand"]
    for s in M:
        assert b["scenarios"][s]["region"]["saline"]["baseline_units"] == plan["region"]["saline"]["demand"]


def test_ward_resource_rounding_and_no_negative_impact():
    fs, dens = synthetic()
    b = sim(fs, dens, total_crews=40)
    fmap = {f["ward_id"]: f for f in fs}
    for w in b["wards"]:
        p3 = Decimal(repr(fmap[w["ward_id"]]["predicted_cases_3wk"]))
        for s, m in M.items():
            x = w["scenarios"][s]
            eff = ward_effect([v["predicted_cases"] for v in fmap[w["ward_id"]]["weekly"]["weeks"]],
                              w["crews"]["assigned"], dens[w["ward_id"]], m)
            adj = consumable_demand(p3 - Decimal(repr(eff.avoided_total)), "saline")
            assert x["saline"]["scenario_adjusted_units"] == adj
            assert x["saline"]["projected_units_avoided"] == w["baseline_planning_units"]["saline"] - adj >= 0
            assert x["kits"]["projected_units_avoided"] >= 0
            wb = w["baseline_planning_units"]["weekly_bed_planning_units"]
            wa = [bed_planning_demand(Decimal(repr(a))) for a in eff.adjusted]
            assert x["weekly_bed_planning_units"]["scenario_adjusted"] == wa
            assert x["weekly_bed_planning_units"]["projected_units_avoided"] == [p - q for p, q in zip(wb, wa)]
            assert all(v >= 0 for v in x["weekly_bed_planning_units"]["projected_units_avoided"])
            assert x["peak_bed_planning_units"]["projected_reduction"] == max(wb) - max(wa) >= 0


def test_ward_city_region_reconciliation_and_roi():
    fs, dens = synthetic()
    b = sim(fs, dens, total_crews=25)
    fmap = {f["ward_id"]: f for f in fs}
    for s, m in M.items():
        sc = b["scenarios"][s]
        for c in sc["cities"]:
            ws = [w for w in b["wards"] if w["city"] == c["city"]]
            raw = sum(ward_effect([v["predicted_cases"] for v in fmap[w["ward_id"]]["weekly"]["weeks"]],
                                  w["crews"]["assigned"], dens[w["ward_id"]], m).avoided_total for w in ws)
            assert abs(c["projected_cases_avoided"] - raw) <= 5e-5
            assert c["assigned_crews"] == sum(w["crews"]["assigned"] for w in ws)
            assert c["saline"]["projected_units_avoided"] == sum(w["scenarios"][s]["saline"]["projected_units_avoided"] for w in ws)
            for k in range(3):
                assert c["weekly_bed_planning_units"][k]["projected_units_avoided"] == sum(
                    w["scenarios"][s]["weekly_bed_planning_units"]["projected_units_avoided"][k] for w in ws)
            exp = None if c["assigned_crews"] == 0 else round(raw / c["assigned_crews"], 3)
            assert (c["projected_cases_avoided_per_assigned_crew"] is None) == (exp is None)
            if exp is not None:
                assert abs(c["projected_cases_avoided_per_assigned_crew"] - raw / c["assigned_crews"]) <= 5e-4
        r = sc["region"]
        for key in ("assigned_crews", "sum_of_ward_peak_bed_planning_reductions"):
            assert r[key] == sum(c[key] for c in sc["cities"])
        assert r["saline"]["projected_units_avoided"] == sum(c["saline"]["projected_units_avoided"] for c in sc["cities"])
        assert abs(r["projected_cases_avoided"] - sum(c["projected_cases_avoided"] for c in sc["cities"])) <= 5e-4
        for k in range(3):   # weekly beds are per week, never summed across weeks
            assert r["weekly_bed_planning_units"][k]["projected_units_avoided"] == sum(
                c["weekly_bed_planning_units"][k]["projected_units_avoided"] for c in sc["cities"])
    lo, ba, hi = (b["scenarios"][s]["region"]["projected_cases_avoided"] for s in ("low", "base", "high"))
    assert lo <= ba <= hi


def test_zero_crews_gives_zero_effect_and_null_roi():
    fs, dens = synthetic()
    b = sim(fs, dens, total_crews=0)
    for s in M:
        r = b["scenarios"][s]["region"]
        assert r["projected_cases_avoided"] == 0 and r["projected_cases_avoided_per_assigned_crew"] is None
        assert r["saline"]["projected_units_avoided"] == 0 and r["sum_of_ward_peak_bed_planning_reductions"] == 0


def test_more_crews_never_reduce_projected_benefit():
    fs, dens = synthetic()
    prev = None
    for crews in range(0, 60, 3):
        cur = {w["ward_id"]: w["scenarios"]["base"]["projected_cases_avoided"] for w in sim(fs, dens, total_crews=crews)["wards"]}
        if prev:
            assert all(cur[k] >= prev[k] for k in cur)
        prev = cur


def test_roi_alternative_only_when_requested_and_conserves_pools():
    fs, dens = synthetic()
    assert sim(fs, dens)["roi_alternative"] is None
    b = sim(fs, dens, total_crews=20, include_roi_alternative=True)
    alt = b["roi_alternative"]
    assert alt["status"] == "hypothetical_assumption_dependent" and alt["city_pools"] == b["crews"]["city_pools"]
    caps = {w["ward_id"]: w["crews"]["scenario_demand"] for w in b["wards"]}
    city_of = {w["ward_id"]: w["city"] for w in b["wards"]}
    for c, pool in alt["city_pools"].items():
        assert sum(w["alternative_crews"] for w in alt["wards"] if w["city"] == c) == pool
    for w in alt["wards"]:
        assert 0 <= w["alternative_crews"] <= caps[w["ward_id"]] and caps[w["ward_id"]] > 0
    assert alt["assigned_crews"] == b["crews"]["assigned"]
    assert all(caps[w] == 0 for w in caps if w not in {x["ward_id"] for x in alt["wards"]})
    for s in M:   # same assumed objective: alternative >= primary
        comp = alt["comparison"][s]
        assert comp["region"]["alternative_projected_cases_avoided"] >= comp["region"]["primary_projected_cases_avoided"] - 1e-4
        for c in comp["cities"]:
            assert c["alternative_projected_cases_avoided"] >= c["primary_projected_cases_avoided"] - 1e-4
    assert set(city_of.values()) == {c["city"] for c in alt["comparison"]["base"]["cities"]}


def test_alternative_pct_difference_null_when_primary_zero():
    fs, dens = synthetic()
    b = sim(fs, dens, total_crews=0, include_roi_alternative=True)
    assert b["roi_alternative"]["comparison"]["base"]["region"]["difference_pct"] is None


def test_equal_split_source_and_determinism():
    fs, dens = synthetic(source="equal_split")
    b = sim(fs, dens)
    assert b["weekly_source"] == "equal_split" and any("equal split" in w for w in b["warnings"])
    assert sim(fs, dens) == b
    rng = random.Random(4)
    sh = list(fs)
    rng.shuffle(sh)
    assert sim(sh, dens) == b


def test_first_crew_ranking_in_scenario():
    fs, dens = synthetic()
    b = sim(fs, dens)
    vals = [r["first_crew_projected_cases_avoided"] for r in b["first_crew_ranking"]]
    assert vals == sorted(vals, reverse=True)
    eligible = {w["ward_id"] for w in b["wards"] if w["crews"]["scenario_demand"] > 0}
    assert {r["ward_id"] for r in b["first_crew_ranking"]} == eligible


def test_no_misleading_keys():
    fs, dens = synthetic()
    b = sim(fs, dens, include_roi_alternative=True)

    def keys(o):
        if isinstance(o, dict):
            for k, v in o.items():
                yield k
                yield from keys(v)
        elif isinstance(o, list):
            for v in o:
                yield from keys(v)
    for k in set(keys(b)):
        for word in ("actual", "proven", "saved", "lives", "prevented", "patient", "cost", "money"):
            assert word not in k.lower(), k


def test_intervention_engine_imports_no_ml_or_web_stack():
    code = ("import sys; import app.planning.intervention, app.planning.scenario; "
            "bad=[m for m in ('pandas','numpy','scipy','xgboost','sklearn','fastapi','starlette') if m in sys.modules]; "
            "sys.exit(1 if bad else 0)")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
