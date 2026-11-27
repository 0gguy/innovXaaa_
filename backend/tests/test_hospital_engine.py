"""Pure hospital-routing engine and scenario tests (standard library only; no model)."""
import csv
import itertools
import random
import subprocess
import sys
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from pathlib import Path

import pytest

from app.planning import parameters as PP
from app.planning.demand import PlanningDataError, half_up
from app.planning.hospital import (HospitalInputError, Transfer, WardBeds, WardRouting, city_capacity,
                                   headline_week, route_city, summarize, ward_capacities)
from app.planning.scenario import build_hospital_routing, build_plan

CSV = Path(__file__).resolve().parents[2] / "ml" / "data" / "dengue_dataset.csv"


def beds(spec):
    """spec: list of (demand, capacity); priority = list order."""
    return [WardBeds(f"w{i}", d, c, (i, f"w{i}")) for i, (d, c) in enumerate(spec)]


def route(spec):
    res, tr = route_city(beds(spec))
    return {r.ward_id: r for r in res}, tr


def check_city(spec, res, tr):
    total_overflow = sum(max(0, d - c) for d, c in spec)
    total_spare = sum(max(0, c - d) for d, c in spec)
    for i, (d, c) in enumerate(spec):
        r = res[f"w{i}"]
        for v in (r.locally_assigned, r.transferred_out, r.transferred_in, r.unmet_after_routing,
                  r.occupied_after_routing, r.spare_after_routing):
            assert isinstance(v, int) and v >= 0
        assert r.locally_assigned == min(d, c)
        assert d == r.locally_assigned + r.transferred_out + r.unmet_after_routing
        assert r.occupied_after_routing == r.locally_assigned + r.transferred_in <= c
        assert r.transferred_out <= d - min(d, c) and r.transferred_in <= c - min(d, c)
        assert not (r.transferred_out and r.transferred_in)
    assert all(t.from_ward != t.to_ward and t.units > 0 for t in tr)
    assert len({(t.from_ward, t.to_ward) for t in tr}) == len(tr)
    s = summarize(list(res.values()), tr)
    assert s["transfer_units"] == min(total_overflow, total_spare)
    assert s["bed_planning_demand"] == s["locally_assigned"] + s["transfer_units"] + s["unmet_after_routing"]
    assert s["occupied_after_routing"] == s["locally_assigned"] + s["transfer_units"] <= s["hypothetical_capacity"]
    assert s["spare_after_routing"] == s["hypothetical_capacity"] - s["occupied_after_routing"]
    return s


# ------------------------------------------------------------------ capacity baseline and split
def test_baseline_reproduces_from_bundled_csv():
    k = PP.COEFFICIENTS["beds"]
    week = defaultdict(int)
    with open(CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            y = int(r["date"][:4])
            if PP.HOSPITAL_BASELINE_FIRST_YEAR <= y <= PP.HOSPITAL_BASELINE_LAST_YEAR:
                week[(r["city"], y, r["date"])] += half_up(k * Decimal(r["dengue_cases"]))
    peak = defaultdict(dict)
    for (c, y, _), v in week.items():
        peak[c][y] = max(peak[c].get(y, 0), v)
    got = {}
    for c, by_year in peak.items():
        assert sorted(by_year) == list(range(2016, 2024))
        mean = Fraction(sum(by_year.values()), len(by_year))
        got[c] = int((Decimal(mean.numerator) / Decimal(mean.denominator)).quantize(Decimal(1), ROUND_HALF_UP))
    assert got == PP.HOSPITAL_CITY_BASELINE_BEDS
    assert sum(got.values()) == 267


def test_city_capacity_floor_and_bounds():
    assert city_capacity(87, 100) == 87 and city_capacity(87, 75) == 65 and city_capacity(21, 25) == 5
    assert city_capacity(87, 200) == 174 and city_capacity(0, 150) == 0
    with pytest.raises(HospitalInputError):
        city_capacity(-1, 100)
    with pytest.raises(HospitalInputError):
        city_capacity(10, True)


def test_equal_split_and_remainder_order():
    caps = ward_capacities(["c", "a", "b"], 8)
    assert caps == {"a": 3, "b": 3, "c": 2} and sum(caps.values()) == 8
    assert ward_capacities(["x"], 0) == {"x": 0}
    assert ward_capacities(["b", "a"], 1) == ward_capacities(["a", "b"], 1) == {"a": 1, "b": 0}
    with pytest.raises(HospitalInputError):
        ward_capacities(["a", "a"], 3)


def test_ward_capacity_monotone_in_capacity_pct():
    ids = [f"DNCC_Ward_{i:02d}" for i in range(1, 21)]
    prev = None
    for pct in range(PP.CAPACITY_PCT_MIN, PP.CAPACITY_PCT_MAX + 1):
        caps = ward_capacities(ids, city_capacity(87, pct))
        assert sum(caps.values()) == city_capacity(87, pct)
        assert all(isinstance(v, int) and v >= 0 for v in caps.values())
        if prev:
            assert all(caps[w] >= prev[w] for w in ids)
        prev = caps


# ------------------------------------------------------------------ routing cases
@pytest.mark.parametrize("spec,moved,unmet", [
    ([(2, 3), (1, 4), (0, 2)], 0, 0),                    # no overflow / fully satisfied
    ([(5, 1), (4, 2), (3, 0)], 0, 9),                    # every ward short, no spare
    ([(0, 3), (1, 5), (0, 0)], 0, 0),                    # all surplus
    ([(7, 1), (0, 2), (1, 3), (2, 4)], 6, 0),            # one sender, many receivers
    ([(4, 1), (5, 2), (3, 2), (0, 4)], 4, 3),            # many senders, one receiver
    ([(6, 2), (5, 1), (1, 4), (0, 3), (2, 2)], 6, 2),    # many to many: overflow 8, spare 6
    ([(0, 6), (3, 0), (2, 0)], 5, 0),                    # zero-demand receiver, zero-capacity senders
    ([(9, 0), (0, 0)], 0, 9),                            # zero capacity city
    ([(0, 0), (0, 0)], 0, 0),                            # nothing at all
])
def test_routing_cases(spec, moved, unmet):
    res, tr = route(spec)
    s = check_city(spec, res, tr)
    assert s["transfer_units"] == moved and s["unmet_after_routing"] == unmet


def test_zero_capacity_summary_has_no_division():
    from app.planning.scenario import _utilization
    res, tr = route([(3, 0), (0, 0)])
    s = _utilization(summarize(list(res.values()), tr))
    assert s["utilization_pct"] is None and s["demand_to_capacity_pct"] is None
    assert s["utilization_status"] == "no_capacity" and s["unmet_after_routing"] == 3


def test_sender_fairness_ranking():
    # w0 served 3/7, w1 3/6, w2 3/6; one spare unit -> lowest served ratio (w0) sends.
    res, tr = route([(7, 3), (6, 3), (6, 3), (0, 1)])
    assert [(t.from_ward, t.to_ward, t.units) for t in tr] == [("w0", "w3", 1)]
    # Two spare units: w0 (3/7) first, then w0 is 4/7 > 3/6, so the tie w1/w2 goes to higher priority w1.
    res, tr = route([(7, 3), (6, 3), (6, 3), (0, 2)])
    assert {(t.from_ward, t.units) for t in tr} == {("w0", 1), ("w1", 1)}


def test_sender_tie_uses_priority_key():
    spec = [(4, 2), (4, 2), (0, 1)]
    keyed = [WardBeds("a", 4, 2, (1, "a")), WardBeds("b", 4, 2, (0, "b")), WardBeds("r", 0, 1, (2, "r"))]
    _, tr = route_city(keyed)
    assert tr == [Transfer("b", "r", 1)]   # equal served ratio 1/2 -> priority (0, "b") first
    assert route(spec)[1] == [Transfer("w0", "w2", 1)]


def test_receiver_load_ranking_and_ties():
    # Receivers: r1 load 1/4, r2 load 0/2, r3 load 2/4 -> first unit to r2 (lowest occupancy ratio).
    keyed = [WardBeds("s", 3, 1, (0, "s")), WardBeds("r1", 1, 4, (1, "r1")), WardBeds("r2", 0, 2, (2, "r2")),
             WardBeds("r3", 2, 4, (3, "r3"))]
    res, tr = route_city([keyed[0].__class__("s", 2, 1, (0, "s"))] + keyed[1:])
    assert tr == [Transfer("s", "r2", 1)]
    # Equal ratio 0: more spare first (r_big), then ward_id.
    tie = [WardBeds("s", 3, 0, (0, "s")), WardBeds("r_small", 0, 2, (1, "r_small")),
           WardBeds("r_big", 0, 4, (2, "r_big"))]
    _, tr = route_city([WardBeds("s", 1, 0, (0, "s"))] + tie[1:])
    assert tr == [Transfer("s", "r_big", 1)]
    _, tr = route_city([WardBeds("s", 1, 0, (0, "s")), WardBeds("b", 0, 3, (1, "b")), WardBeds("a", 0, 3, (2, "a"))])
    assert tr == [Transfer("s", "a", 1)]


def test_load_spreading_across_receivers():
    # 4 overflow units, receivers with capacity 4 each and no local load -> spread evenly, 2 + 2.
    res, tr = route([(4, 0), (0, 4), (0, 4)])
    assert {t.to_ward: t.units for t in tr} == {"w1": 2, "w2": 2}


def test_shuffled_input_is_deterministic():
    spec = [(6, 2), (5, 1), (1, 4), (0, 3), (2, 2), (8, 1), (0, 5)]
    base = route_city(beds(spec))
    rng = random.Random(5)
    for _ in range(20):
        b = beds(spec)
        rng.shuffle(b)
        assert route_city(b) == base


def test_invalid_engine_inputs():
    for bad in ([WardBeds("a", -1, 2, (0, "a"))], [WardBeds("a", 1.5, 2, (0, "a"))],
                [WardBeds("a", 1, True, (0, "a"))], [WardBeds("a", 1, 1, (0,)), WardBeds("b", 1, 1, (0,))],
                [WardBeds("a", 1, 1, (0, "a")), WardBeds("a", 1, 1, (1, "a"))]):
        with pytest.raises(HospitalInputError):
            route_city(bad)


def test_summarize_rejects_inconsistent_records():
    res = [WardRouting("a", 3, 1, 1, 1, 0), WardRouting("b", 0, 2, 0, 0, 1)]
    assert summarize(res, [Transfer("a", "b", 1)])["sending_wards"] == 1
    with pytest.raises(HospitalInputError):
        summarize(res, [Transfer("a", "b", 2)])
    with pytest.raises(HospitalInputError):
        summarize(res, [])


# ------------------------------------------------------------------ properties (seeded)
def brute_force_max(spec):
    over = [max(0, d - c) for d, c in spec]
    spare = [max(0, c - d) for d, c in spec]
    # Exhaustive over how much each sender sends (complete bipartite graph): max feasible total.
    best = 0
    for sends in itertools.product(*[range(o + 1) for o in over]):
        if sum(sends) <= sum(spare):
            best = max(best, sum(sends))
    return best


def test_randomized_conservation_and_bounds():
    rng = random.Random(20261127)
    for _ in range(700):
        n = rng.randint(1, 12)
        spec = [(rng.choice([0, 0, rng.randint(0, 15)]), rng.choice([0, rng.randint(0, 15)])) for _ in range(n)]
        res, tr = route(spec)
        check_city(spec, res, tr)


def test_small_cases_match_theoretical_maximum():
    rng = random.Random(99)
    for _ in range(250):
        spec = [(rng.randint(0, 4), rng.randint(0, 4)) for _ in range(rng.randint(1, 5))]
        res, tr = route(spec)
        s = check_city(spec, res, tr)
        assert s["transfer_units"] == brute_force_max(spec)


def test_headline_week_rule():
    s = lambda unmet, demand: {"unmet_after_routing": unmet, "bed_planning_demand": demand}
    assert headline_week([(2, s(0, 10)), (3, s(4, 8)), (4, s(4, 9))]) == 4      # most unmet, then demand
    assert headline_week([(2, s(1, 9)), (3, s(1, 9)), (4, s(0, 20))]) == 2      # tie -> earliest
    assert headline_week([(2, s(0, 0)), (3, s(0, 0)), (4, s(0, 0))]) == 2


# ------------------------------------------------------------------ full scenario (synthetic forecasts)
TIERS = ((4.5, "Low"), (14.5, "Medium"), (30.5, "High"))


def tier_of(p):
    return next((t for edge, t in TIERS if p < edge), "Critical")


def synthetic(seed=3, source="companion", issue="2025-07-28"):
    rng = random.Random(seed)
    weeks = ("2025-08-11", "2025-08-18", "2025-08-25")
    fs, dens = [], {}
    for city, n, prefix in (("Gazipur", 5, "GCC"), ("Narayanganj", 5, "NCC"), ("Chattogram", 10, "CCC")):
        for i in range(1, n + 1):
            w = [round(rng.uniform(0, 25), 4) for _ in range(3)]
            if source == "equal_split":
                w = [w[0]] * 3
            p = sum(w)
            ward = f"{prefix}_Ward_{i:02d}"
            fs.append({"ward_id": ward, "city": city, "predicted_cases_3wk": p, "risk_tier": tier_of(p),
                       "early_alert": p > 25, "forecast_weeks": list(weeks), "horizon_weeks": [2, 3, 4],
                       "issue_week": issue, "model_version": "m",
                       "weekly": {"source": source, "weeks": [{"horizon_week": h, "forecast_week": fw,
                                                               "predicted_cases": v}
                                                              for h, fw, v in zip((2, 3, 4), weeks, w)]}})
            dens[ward] = float(rng.randint(18000, 75000))
    return fs, dens


@pytest.mark.parametrize("pct", [25, 60, 100, 200])
def test_scenario_balances_isolation_and_region(pct):
    fs, dens = synthetic()
    b = build_hospital_routing(fs, dens, capacity_pct=pct)
    city_of = {f["ward_id"]: f["city"] for f in fs}
    assert [w["horizon_week"] for w in b["weeks"]] == [2, 3, 4]
    caps = {w["ward_id"]: w["hypothetical_capacity"] for w in b["wards"]}
    for c in b["capacity"]["cities"]:
        assert c["hypothetical_capacity"] == pct * PP.HOSPITAL_CITY_BASELINE_BEDS[c["city"]] // 100
        assert sum(v for k, v in caps.items() if city_of[k] == c["city"]) == c["hypothetical_capacity"]
    for wk in b["weeks"]:
        for t in wk["transfers"]:
            assert city_of[t["from_ward"]] == city_of[t["to_ward"]] == t["city"] and t["from_ward"] != t["to_ward"]
        ints = ("hypothetical_capacity", "bed_planning_demand", "locally_assigned", "transfer_units",
                "transfer_edges", "sending_wards", "receiving_wards", "occupied_after_routing",
                "unmet_after_routing", "spare_after_routing", "wards_with_unmet")
        for k in ints:
            assert wk["region"][k] == sum(c[k] for c in wk["cities"])
        r = wk["region"]
        assert r["bed_planning_demand"] == r["locally_assigned"] + r["transfer_units"] + r["unmet_after_routing"]
        assert r["utilization_pct"] == (None if r["hypothetical_capacity"] == 0 else float(
            (Decimal(100 * r["occupied_after_routing"]) / r["hypothetical_capacity"]).quantize(Decimal("0.1"),
                                                                                                ROUND_HALF_UP)))
        for c in wk["cities"]:
            ctr = [t for t in wk["transfers"] if t["city"] == c["city"]]
            assert c["transfer_units"] == sum(t["units"] for t in ctr)
            assert c["transfer_edges"] == len(ctr)
            assert c["sending_wards"] == len({t["from_ward"] for t in ctr})
            assert c["receiving_wards"] == len({t["to_ward"] for t in ctr})
    for w in b["wards"]:
        for x in w["weeks"]:
            assert x["bed_planning_demand"] == x["locally_assigned"] + x["transferred_out"] + x["unmet_after_routing"]
            assert x["occupied_after_routing"] == x["locally_assigned"] + x["transferred_in"] <= w["hypothetical_capacity"]


def test_weeks_routed_independently_with_fixed_capacity():
    fs, dens = synthetic()
    b = build_hospital_routing(fs, dens, capacity_pct=60)
    fmap = {f["ward_id"]: f for f in fs}
    for w in b["wards"]:
        assert len(w["weeks"]) == 3
        for x, src in zip(w["weeks"], fmap[w["ward_id"]]["weekly"]["weeks"]):
            assert x["bed_planning_demand"] == half_up(Decimal("0.29844") * Decimal(repr(src["predicted_cases"])))
            assert x["forecast_week"] == src["forecast_week"]
        assert max(x["bed_planning_demand"] for x in w["weeks"]) == w["max_weekly_bed_planning_demand"]
    # A week's routing is identical to routing that week alone (no carry-over between weeks).
    for k, h in enumerate((2, 3, 4)):
        for c in ("Chattogram", "Gazipur", "Narayanganj"):
            rows = [w for w in b["wards"] if w["city"] == c]
            alone = route_city([WardBeds(w["ward_id"], w["weeks"][k]["bed_planning_demand"],
                                         w["hypothetical_capacity"], (w["priority_rank_in_city"], w["ward_id"]))
                                for w in rows])
            got = {w["ward_id"]: (w["weeks"][k]["transferred_out"], w["weeks"][k]["transferred_in"]) for w in rows}
            assert {r.ward_id: (r.transferred_out, r.transferred_in) for r in alone[0]} == got


def test_max_weekly_demand_matches_task2_bed_plan():
    fs, dens = synthetic()
    plan = build_plan(fs, dens, stock_pct=100, min_coverage_pct=30, total_crews=0)
    routing = build_hospital_routing(fs, dens, capacity_pct=100)
    t2 = {w["ward_id"]: w["bed_plan"]["bed_planning_demand"] for w in plan["wards"]}
    assert {w["ward_id"]: w["max_weekly_bed_planning_demand"] for w in routing["wards"]} == t2


def test_equal_split_source_gives_identical_weeks():
    fs, dens = synthetic(source="equal_split")
    b = build_hospital_routing(fs, dens, capacity_pct=50)
    assert b["weekly_source"] == "equal_split" and any("equal split" in w for w in b["warnings"])
    strip = lambda wk: ({k: v for k, v in wk["region"].items()}, [(t["from_ward"], t["to_ward"], t["units"])
                                                                   for t in wk["transfers"]])
    assert strip(b["weeks"][0]) == strip(b["weeks"][1]) == strip(b["weeks"][2])


def test_retrospective_baseline_disclosure():
    fs, dens = synthetic(issue="2023-08-07")
    assert any("retrospective" in w for w in build_hospital_routing(fs, dens, capacity_pct=100)["warnings"])
    fs, dens = synthetic(issue="2025-07-28")
    assert not any("retrospective" in w for w in build_hospital_routing(fs, dens, capacity_pct=100)["warnings"])


def test_scenario_order_invariance_and_determinism():
    fs, dens = synthetic()
    a = build_hospital_routing(fs, dens, capacity_pct=70)
    rng = random.Random(2)
    for _ in range(5):
        sh = list(fs)
        rng.shuffle(sh)
        assert build_hospital_routing(sh, dens, capacity_pct=70) == a


def test_scenario_rejects_bad_inputs():
    fs, dens = synthetic()
    with pytest.raises(PlanningDataError):
        build_hospital_routing([], dens, capacity_pct=100)
    with pytest.raises(PlanningDataError):
        build_hospital_routing([dict(fs[0], city="Atlantis", ward_id="X_Ward_01")] + fs[1:],
                               dens | {"X_Ward_01": 30000.0}, capacity_pct=100)
    mixed = [dict(fs[0], issue_week="2025-07-21")] + fs[1:]
    with pytest.raises(PlanningDataError):
        build_hospital_routing(mixed, dens, capacity_pct=100)
    bad = [dict(fs[0], weekly={**fs[0]["weekly"], "weeks": fs[0]["weekly"]["weeks"][:2]})] + fs[1:]
    with pytest.raises(PlanningDataError):
        build_hospital_routing(bad, dens, capacity_pct=100)


def test_hospital_engine_imports_no_ml_or_web_stack():
    code = ("import sys; import app.planning.hospital, app.planning.scenario; "
            "bad=[m for m in ('pandas','numpy','scipy','xgboost','sklearn','fastapi','starlette') if m in sys.modules]; "
            "sys.exit(1 if bad else 0)")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
