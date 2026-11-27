"""Pure planning-engine tests (standard library only; no model, no FastAPI)."""
import itertools
import random
import subprocess
import sys
from decimal import Decimal

import pytest

from app.planning import parameters as PP
from app.planning.allocate import AllocationInputError, Claim, allocate, floor_target, split_budget
from app.planning.demand import (PlanningDataError, bed_planning_demand, consumable_demand, crew_demand,
                                 half_up, ward_demand)
from app.planning.scenario import build_plan


def claims(demands, keys=None):
    """Claims w0, w1, ... ; priority = list order unless keys given."""
    return [Claim(f"w{i}", d, (keys[i] if keys else i, f"w{i}")) for i, d in enumerate(demands)]


def run(demands, stock, pct=30, keys=None):
    out, left = allocate(claims(demands, keys), stock, pct)
    return {a.ward_id: a for a in out}, left


def check_invariants(demands, stock, pct, res, left):
    alloc = [res[f"w{i}"].allocated for i in range(len(demands))]
    assert all(isinstance(a, int) and 0 <= a <= d for a, d in zip(alloc, demands))
    assert sum(alloc) == min(stock, sum(demands))
    assert left == stock - sum(alloc) and left >= 0
    for i, d in enumerate(demands):
        a = res[f"w{i}"]
        assert a.deficit == d - a.allocated >= 0
        assert a.floor == floor_target(d, pct)


# ------------------------------------------------------------------ basic invariants and edge cases
def test_conservation_bounds_and_deficits():
    demands = [73, 64, 46, 40, 40]
    for stock in (0, 1, 5, 78, 80, 157, 263, 400):
        res, left = run(demands, stock)
        check_invariants(demands, stock, 30, res, left)


def test_all_demand_zero_and_no_stock():
    res, left = run([0, 0, 0], 10)
    assert all(a.allocated == 0 and a.reason == "no_demand" and a.severity == "no_deficit" for a in res.values())
    assert left == 10
    res, left = run([5, 3], 0)
    assert all(a.allocated == 0 for a in res.values()) and left == 0
    assert {a.severity for a in res.values()} == {"below_floor"}


def test_one_ward():
    res, left = run([10], 4)
    assert res["w0"].allocated == 4 and res["w0"].floor == 3 and left == 0
    res, left = run([10], 25)
    assert res["w0"].allocated == 10 and left == 15 and res["w0"].reason == "fulfilled"


def test_stock_below_total_floor_equalises_coverage():
    demands = [73, 64, 46, 40, 40]          # floors 22, 20, 14, 12, 12 = 80
    res, _ = run(demands, 78)
    assert [res[f"w{i}"].allocated for i in range(5)] == [21, 19, 14, 12, 12]
    assert all(res[f"w{i}"].stage1 == res[f"w{i}"].allocated for i in range(5))
    assert {res["w0"].severity, res["w1"].severity} == {"below_floor"}


def test_stock_equals_total_floor_and_total_demand():
    demands = [73, 64, 46, 40, 40]
    res, _ = run(demands, 80)
    assert [res[f"w{i}"].allocated for i in range(5)] == [22, 20, 14, 12, 12]
    assert all(a.reason == "floor_only" and a.severity == "partial" for a in res.values())
    res, left = run(demands, 263)
    assert all(a.allocated == a.demand and a.reason == "fulfilled" for a in res.values()) and left == 0


def test_stage2_strict_priority_after_floors():
    res, _ = run([73, 64, 46, 40, 40], 157)
    assert [res[f"w{i}"].allocated for i in range(5)] == [73, 46, 14, 12, 12]
    assert res["w1"].reason == "partial_priority" and res["w2"].reason == "floor_only"


def test_one_unit_per_ward_when_feasible_then_priority_when_not():
    demands = [50, 3, 1, 7, 2, 9]
    res, _ = run(demands, len(demands))
    assert all(a.allocated >= 1 for a in res.values())
    res, _ = run(demands, 4)                       # fewer units than wards: top-priority wards first
    assert [res[f"w{i}"].allocated for i in range(6)] == [1, 1, 1, 1, 0, 0]


def test_pure_priority_when_min_coverage_zero():
    res, _ = run([5, 5, 5], 7, pct=0)
    assert [res[f"w{i}"].allocated for i in range(3)] == [5, 2, 0]
    assert all(a.floor == 0 and a.stage1 == 0 for a in res.values())
    assert res["w2"].reason == "not_reached" and res["w2"].severity == "partial"


def test_exact_ratio_comparison_no_float_ambiguity():
    # 1/3 vs 333333/1000000: a float-rounding comparison could tie these; exact Fractions must not.
    res, _ = run([3, 1_000_000], 1 + 333_333 + 1, pct=50)
    # After w0 has 1/3 and w1 has 333333/1e6 (< 1/3), the next unit must go to w1.
    assert res["w1"].allocated == 333_334 and res["w0"].allocated == 1


def test_ratio_tie_goes_to_higher_priority():
    res, _ = run([4, 4], 1)
    assert res["w0"].allocated == 1 and res["w1"].allocated == 0
    res, _ = run([4, 4], 1, keys=[1, 0])          # reversed priority
    assert res["w1"].allocated == 1 and res["w0"].allocated == 0


def test_input_order_invariance():
    demands = [17, 0, 9, 33, 5, 12, 1]
    base = {a.ward_id: a for a in allocate(claims(demands), 40, 30)[0]}
    rng = random.Random(7)
    for _ in range(20):
        cl = claims(demands)
        rng.shuffle(cl)
        assert {a.ward_id: a for a in allocate(cl, 40, 30)[0]} == base


def test_input_validation():
    with pytest.raises(AllocationInputError):
        allocate(claims([1, 2]), -1, 30)
    with pytest.raises(AllocationInputError):
        allocate(claims([1, 2]), 3, 101)
    with pytest.raises(AllocationInputError):
        allocate([Claim("a", 1.5, (0, "a"))], 3, 30)
    with pytest.raises(AllocationInputError):
        allocate([Claim("a", True, (0, "a"))], 3, 30)
    with pytest.raises(AllocationInputError):
        allocate([Claim("a", 1, (0,)), Claim("b", 1, (0,))], 3, 30)      # non-unique priority
    with pytest.raises(AllocationInputError):
        allocate([Claim("a", 1, (0, "a")), Claim("a", 1, (1, "a"))], 3, 30)


# ------------------------------------------------------------------ randomized properties (seeded)
def test_randomized_invariants():
    rng = random.Random(20261127)
    for _ in range(600):
        n = rng.randint(1, 12)
        demands = [rng.choice([0, 0, 1, 2, 3, rng.randint(0, 200)]) for _ in range(n)]
        stock = rng.randint(0, sum(demands) + 5)
        pct = rng.choice([0, 1, 10, 30, 50, rng.randint(0, 50)])
        keys = rng.sample(range(100), n)
        res, left = run(demands, stock, pct, keys)
        check_invariants(demands, stock, pct, res, left)
        positive = [i for i, d in enumerate(demands) if d > 0]
        floors_total = sum(floor_target(d, pct) for d in demands)
        if stock >= floors_total:
            assert all(res[f"w{i}"].allocated >= res[f"w{i}"].floor for i in range(n))
        if pct > 0 and stock >= len(positive):
            assert all(res[f"w{i}"].allocated >= 1 for i in positive)


@pytest.mark.parametrize("demands,pct", [
    ([73, 64, 46, 40, 40], 30), ([5, 5, 5], 0), ([1, 1, 1, 1], 50), ([9, 0, 2, 17, 3], 30),
    ([3, 1, 2], 50), ([100, 1], 1), ([6, 4, 2, 5, 2], 30),
])
def test_monotone_in_stock_exhaustive(demands, pct):
    prev = None
    for stock in range(sum(demands) + 3):
        res, _ = run(demands, stock, pct)
        cur = [res[f"w{i}"].allocated for i in range(len(demands))]
        if prev is not None:
            assert all(c >= p for c, p in zip(cur, prev)), (stock, prev, cur)
            assert sum(cur) - sum(prev) == (1 if stock <= sum(demands) else 0)
        prev = cur


def test_monotone_randomized():
    rng = random.Random(42)
    for _ in range(80):
        demands = [rng.randint(0, 15) for _ in range(rng.randint(1, 7))]
        pct = rng.randint(0, 50)
        keys = rng.sample(range(50), len(demands))
        prev = None
        for stock in range(sum(demands) + 1):
            res, _ = run(demands, stock, pct, keys)
            cur = [res[f"w{i}"].allocated for i in range(len(demands))]
            assert prev is None or all(c >= p for c, p in zip(cur, prev))
            prev = cur


# ------------------------------------------------------------------ budget split (city crew pools)
def test_split_budget_conservation_caps_and_monotonicity():
    d = {"A": 19, "B": 80, "C": 0, "D": 7}
    prev = None
    for budget in range(0, 120):
        pool, left = split_budget(d, budget, tie_key={g: (-v,) for g, v in d.items()})
        assert sum(pool.values()) + left == budget
        assert all(0 <= pool[g] <= d[g] for g in d) and pool["C"] == 0
        assert sum(pool.values()) == min(budget, sum(d.values()))
        if prev:
            assert all(pool[g] >= prev[g] for g in d)
        prev = pool


def test_split_budget_proportional_and_tie_break():
    pool, _ = split_budget({"A": 10, "B": 10}, 1, tie_key={"A": (1,), "B": (0,)})
    assert pool == {"A": 0, "B": 1}
    pool, _ = split_budget({"A": 30, "B": 10}, 20)
    assert pool == {"A": 15, "B": 5}


# ------------------------------------------------------------------ demand conversion
def test_half_up_rounding():
    assert [half_up(Decimal(x)) for x in ("0", "0.4999", "0.5", "1.5", "2.5", "2.4999999")] == [0, 0, 1, 2, 3, 2]


def test_conversion_reproduces_dataset_rule_on_integer_cases():
    # Dataset tables (cases -> saline / kits / beds), from the onsite CSV.
    table = {1: (2, 1, 0), 2: (5, 2, 1), 5: (12, 6, 1), 10: (24, 12, 3), 20: (48, 23, 6), 33: (79, 38, 10),
             41: (98, 48, 12)}
    for c, (s, k, b) in table.items():
        assert consumable_demand(Decimal(c), "saline") == s
        assert consumable_demand(Decimal(c), "kits") == k
        assert bed_planning_demand(Decimal(c)) == b


def test_coefficients_inside_identified_intervals():
    from fractions import Fraction
    for item, (lo, hi) in PP.COEFFICIENT_INTERVALS.items():
        assert Fraction(lo) <= Fraction(str(PP.COEFFICIENTS[item])) < Fraction(hi)


def test_crew_demand_rule():
    assert crew_demand("Low", Decimal(74252)) == 0
    assert crew_demand("Medium", Decimal(12000)) == 1
    assert crew_demand("High", Decimal(12001)) == 2
    assert crew_demand("Critical", Decimal(65612)) == 6
    assert crew_demand("Critical", Decimal(74252)) == 6    # ceil -> 7, capped at 6


def forecast(ward="NCC_Ward_01", city="Narayanganj", p=26.7124, tier="High", alert=True,
             weekly=(7.535, 9.449), source="companion", weeks=("2025-08-11", "2025-08-18", "2025-08-25")):
    w = list(weekly) + [p - sum(weekly)]
    return {"ward_id": ward, "city": city, "predicted_cases_3wk": p, "risk_tier": tier, "early_alert": alert,
            "forecast_weeks": list(weeks), "horizon_weeks": [2, 3, 4], "issue_week": "2025-07-28",
            "model_version": "m",
            "weekly": {"source": source, "weeks": [{"horizon_week": h, "forecast_week": fw, "predicted_cases": v}
                                                   for h, fw, v in zip((2, 3, 4), weeks, w)]}}


def test_ward_demand_uses_weekly_peak_and_reports_source():
    wd = ward_demand(forecast(), 65612.0)
    assert (wd.saline, wd.kits, wd.crews) == (64, 31, 6)
    assert wd.peak_horizon_week == 4 and wd.peak_forecast_week == "2025-08-25"
    assert wd.bed_demand == half_up(Decimal("0.29844") * wd.peak_week_cases) == 3
    eq = ward_demand(forecast(weekly=(26.7124 / 3, 26.7124 / 3), source="equal_split"), 65612.0)
    assert eq.weekly_source == "equal_split" and eq.peak_horizon_week == 2   # equal values: earliest week
    assert eq.bed_demand == half_up(Decimal("0.29844") * Decimal(repr(26.7124 / 3)))


def test_zero_and_tiny_forecasts():
    wd = ward_demand(forecast(p=0.0, tier="Low", alert=False, weekly=(0.0, 0.0)), 30000.0)
    assert (wd.saline, wd.kits, wd.bed_demand, wd.crews) == (0, 0, 0, 0)
    wd = ward_demand(forecast(p=0.2, tier="Low", alert=False, weekly=(0.05, 0.07)), 30000.0)
    assert (wd.saline, wd.kits, wd.bed_demand) == (0, 0, 0)


def test_large_forecast_is_flagged_not_capped():
    wd = ward_demand(forecast(p=150.0, tier="Critical", weekly=(50.0, 50.0)), 40000.0)
    assert wd.exceeds_observed_range and wd.saline == half_up(Decimal("2.38485") * 150)


@pytest.mark.parametrize("mutate", [
    lambda f: f.update(predicted_cases_3wk=float("nan")),
    lambda f: f.update(predicted_cases_3wk=-1.0),
    lambda f: f.update(predicted_cases_3wk=float("inf")),
    lambda f: f.update(predicted_cases_3wk=True),
    lambda f: f.update(predicted_cases_3wk="26.7"),
    lambda f: f.update(predicted_cases_3wk=1e12),
    lambda f: f.update(risk_tier="Severe"),
    lambda f: f.update(early_alert="yes"),
    lambda f: f.pop("weekly"),
    lambda f: f["weekly"].update(source="guess"),
    lambda f: f["weekly"]["weeks"].pop(),
    lambda f: f["weekly"]["weeks"][0].update(predicted_cases=-0.1),
    lambda f: f["weekly"]["weeks"][1].update(predicted_cases=float("nan")),
    lambda f: f["weekly"]["weeks"][2].update(predicted_cases=99.0),          # no longer sums to total
    lambda f: f["weekly"]["weeks"][0].update(forecast_week="2025-01-01"),
])
def test_invalid_forecast_data_rejected(mutate):
    f = forecast()
    mutate(f)
    with pytest.raises(PlanningDataError):
        ward_demand(f, 65612.0)


@pytest.mark.parametrize("density", [0.0, -5.0, float("nan"), None])
def test_invalid_density_rejected(density):
    with pytest.raises(PlanningDataError):
        ward_demand(forecast(), density)


# ------------------------------------------------------------------ scenario: cities and regions
def scenario_inputs():
    rng = random.Random(3)
    fs, dens = [], {}
    for city, n, prefix in (("Gazipur", 5, "GCC"), ("Narayanganj", 5, "NCC"), ("Chattogram", 4, "CCC")):
        for i in range(1, n + 1):
            p = round(rng.uniform(0, 40), 4)
            tier = "Low" if p < 4.5 else "Medium" if p < 14.5 else "High" if p < 30.5 else "Critical"
            a = round(p * 0.3, 4)
            ward = f"{prefix}_Ward_{i:02d}"
            fs.append(forecast(ward=ward, city=city, p=p, tier=tier, alert=p > 25, weekly=(a, a)))
            dens[ward] = float(rng.randint(18000, 75000))
    return fs, dens


def plan(fs, dens, **kw):
    args = dict(stock_pct=60, min_coverage_pct=30, total_crews=20) | kw
    return build_plan(fs, dens, **args)


def test_city_pools_region_sums_and_isolation():
    fs, dens = scenario_inputs()
    p = plan(fs, dens)
    for r in ("saline", "kits"):
        for c in p["cities"]:
            assert c[r]["stock"] == 60 * c[r]["demand"] // 100
            assert c[r]["allocated"] == min(c[r]["stock"], c[r]["demand"])
        for k in ("demand", "stock", "allocated", "deficit", "unallocated", "wards_with_deficit"):
            assert p["region"][r][k] == sum(c[r][k] for c in p["cities"])
        assert sum(w[r]["allocated"] for w in p["wards"]) == p["region"][r]["allocated"]
    # Changing one city's forecasts leaves every other city's consumable allocations unchanged.
    fs2 = [dict(f, predicted_cases_3wk=f["predicted_cases_3wk"]) for f in fs]
    for f in fs2:
        if f["city"] == "Gazipur":
            f["predicted_cases_3wk"] = round(f["predicted_cases_3wk"] * 2 + 1, 4)
            f["weekly"] = {**f["weekly"], "weeks": [dict(w) for w in f["weekly"]["weeks"]]}
            f["weekly"]["weeks"][2]["predicted_cases"] = f["predicted_cases_3wk"] - sum(
                w["predicted_cases"] for w in f["weekly"]["weeks"][:2])
    q = plan(fs2, dens)
    for wp, wq in zip(p["wards"], q["wards"]):
        if wp["city"] != "Gazipur":
            assert wp["saline"] == wq["saline"] and wp["kits"] == wq["kits"]


def test_independent_stock_overrides():
    fs, dens = scenario_inputs()
    p = plan(fs, dens, stock_pct=100, stock_pct_saline=30)
    assert p["parameters"]["stock_pct"] == {"saline": 30, "kits": 100}
    assert p["region"]["kits"]["deficit"] == 0 and p["region"]["saline"]["deficit"] > 0


def test_stock_pct_monotone_for_every_ward():
    fs, dens = scenario_inputs()
    prev = None
    for pct in range(30, 101):
        p = plan(fs, dens, stock_pct=pct)
        cur = {w["ward_id"]: (w["saline"]["allocated"], w["kits"]["allocated"]) for w in p["wards"]}
        if prev:
            assert all(cur[w][0] >= prev[w][0] and cur[w][1] >= prev[w][1] for w in cur)
        prev = cur
    assert all(w["saline"]["deficit"] == 0 for w in plan(fs, dens, stock_pct=100)["wards"])


def test_crew_balance_caps_and_monotonicity():
    fs, dens = scenario_inputs()
    total_demand = sum(w["crews"]["scenario_demand"] for w in plan(fs, dens)["wards"])
    prev_c = prev_w = None
    for crews in range(0, total_demand + 6):
        p = plan(fs, dens, total_crews=crews)
        rc = p["region"]["crews"]
        assert rc["assigned"] + rc["unassigned"] == crews
        assert rc["assigned"] == min(crews, total_demand)
        for c in p["cities"]:
            assert c["crews"]["assigned"] == c["crews"]["pool"] <= c["crews"]["scenario_demand"]
        for w in p["wards"]:
            assert 0 <= w["crews"]["assigned"] <= w["crews"]["scenario_demand"] <= PP.CREW_MAX_PER_WARD
            if w["priority"]["risk_tier"] == "Low":
                assert w["crews"]["scenario_demand"] == 0
        cur_c = {c["city"]: c["crews"]["pool"] for c in p["cities"]}
        cur_w = {w["ward_id"]: w["crews"]["assigned"] for w in p["wards"]}
        if prev_c:
            assert all(cur_c[k] >= prev_c[k] for k in cur_c) and all(cur_w[k] >= prev_w[k] for k in cur_w)
        prev_c, prev_w = cur_c, cur_w


def test_beds_are_planning_demand_only():
    fs, dens = scenario_inputs()
    p = plan(fs, dens)
    assert p["region"]["beds"]["planning_demand"] == sum(w["bed_plan"]["bed_planning_demand"] for w in p["wards"])
    assert p["region"]["beds"]["capacity_and_routing"] == "not_computed"
    for w in p["wards"]:
        assert set(w["bed_plan"]) == {"peak_forecast_week", "peak_horizon_week", "peak_week_expected_cases",
                                      "bed_planning_demand", "weekly_source"}


def test_scenario_deterministic_and_order_invariant():
    fs, dens = scenario_inputs()
    a = plan(fs, dens)
    rng = random.Random(1)
    for _ in range(5):
        shuffled = list(fs)
        rng.shuffle(shuffled)
        assert plan(shuffled, dens) == a


def test_scenario_rejects_inconsistent_inputs():
    fs, dens = scenario_inputs()
    with pytest.raises(PlanningDataError):
        plan([], dens)
    with pytest.raises(PlanningDataError):
        plan(fs, {k: v for k, v in dens.items() if k != fs[0]["ward_id"]})
    mixed = [dict(fs[0], weekly={**fs[0]["weekly"], "source": "equal_split"})] + fs[1:]
    with pytest.raises(PlanningDataError):
        plan(mixed, dens)
    with pytest.raises(PlanningDataError):
        plan(fs + [fs[0]], dens)


def test_planning_package_imports_no_ml_or_web_stack():
    code = ("import sys; import app.planning.scenario, app.planning.allocate, app.planning.demand; "
            "bad=[m for m in ('pandas','numpy','scipy','xgboost','sklearn','fastapi','starlette') if m in sys.modules]; "
            "sys.exit(1 if bad else 0)")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
