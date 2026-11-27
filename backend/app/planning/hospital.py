"""Hospital bed overflow routing within one city and one forecast week (pure standard library).

Quantities are BED PLANNING UNITS derived from forecasts, not patients or occupied beds, and
capacities are HYPOTHETICAL. For each ward i:

    local_i    = min(d_i, c_i)
    overflow_i = d_i - local_i          (> 0 only when local_i == c_i, so a sender has no spare)
    spare_i    = c_i - local_i

Overflow is moved ONE UNIT AT A TIME:
    sender   = lowest served ratio (local + transferred_out) / demand  (exact Fraction),
               ties -> Task 2 priority key (tier, alert, density, 3-week forecast, ward_id)
    receiver = lowest occupancy ratio (local + transferred_in) / capacity (exact Fraction),
               ties -> more remaining spare, then ward_id
The loop stops only when no sender has overflow left or no receiver has spare left. All ward pairs
of the city are connected, so units moved = min(sum overflow, sum spare): the maximum possible.
Callers pass one city at a time, so no cross-city transfer path exists.
"""
from __future__ import annotations

import heapq
import numbers
from dataclasses import dataclass
from fractions import Fraction
from typing import Iterable, Sequence


class HospitalInputError(ValueError):
    """Invalid input to the routing engine (programming or data error, not a user error)."""


@dataclass(frozen=True)
class WardBeds:
    """One ward in one forecast week. `priority` sorts ascending (smaller = served first) and must be unique."""
    ward_id: str
    demand: int
    capacity: int
    priority: tuple


@dataclass(frozen=True)
class WardRouting:
    ward_id: str
    demand: int
    capacity: int
    locally_assigned: int
    transferred_out: int
    transferred_in: int

    @property
    def unmet_after_routing(self) -> int:
        return self.demand - self.locally_assigned - self.transferred_out

    @property
    def occupied_after_routing(self) -> int:
        return self.locally_assigned + self.transferred_in

    @property
    def spare_after_routing(self) -> int:
        return self.capacity - self.occupied_after_routing


@dataclass(frozen=True)
class Transfer:
    from_ward: str
    to_ward: str
    units: int


def _int(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, numbers.Integral) or int(value) < 0:
        raise HospitalInputError(f"{name} must be a non-negative integer")
    return int(value)


def city_capacity(baseline: int, capacity_pct: int) -> int:
    """floor(capacity_pct * baseline / 100), integer arithmetic."""
    return _int(capacity_pct, "capacity_pct") * _int(baseline, "baseline") // 100


def ward_capacities(ward_ids: Iterable[str], total: int) -> dict[str, int]:
    """Equal split of `total` over wards: floor(total / n) each, remainder one unit per ward in ward_id order.
    Equivalent to dealing units round-robin over sorted ward_ids, so a larger total never lowers any ward."""
    ids = sorted(ward_ids)
    if len(set(ids)) != len(ids):
        raise HospitalInputError("duplicate ward_id")
    total = _int(total, "total capacity")
    if not ids:
        if total:
            raise HospitalInputError("capacity given to a city without wards")
        return {}
    q, r = divmod(total, len(ids))
    return {w: q + (1 if i < r else 0) for i, w in enumerate(ids)}


def route_city(wards: Sequence[WardBeds]) -> tuple[list[WardRouting], list[Transfer]]:
    """Local assignment plus maximum within-city overflow routing for ONE city and ONE week.
    Returns ward results sorted by ward_id and transfers sorted by (from_ward, to_ward)."""
    items = list(wards)
    ids = [w.ward_id for w in items]
    if len(set(ids)) != len(ids):
        raise HospitalInputError("duplicate ward_id")
    if len({w.priority for w in items}) != len(items):
        raise HospitalInputError("priority keys must be unique (include ward_id)")
    d = {w.ward_id: _int(w.demand, f"demand[{w.ward_id}]") for w in items}
    c = {w.ward_id: _int(w.capacity, f"capacity[{w.ward_id}]") for w in items}
    prio = {w.ward_id: w.priority for w in items}
    local = {i: min(d[i], c[i]) for i in d}
    out = {i: 0 for i in d}
    inn = {i: 0 for i in d}

    senders = [(Fraction(local[i], d[i]), prio[i], i) for i in d if d[i] > local[i]]
    receivers = [(Fraction(local[j], c[j]), -(c[j] - local[j]), j) for j in d if c[j] > local[j]]
    heapq.heapify(senders)
    heapq.heapify(receivers)
    edges: dict[tuple[str, str], int] = {}
    while senders and receivers:
        _, _, i = heapq.heappop(senders)
        _, _, j = heapq.heappop(receivers)
        out[i] += 1
        inn[j] += 1
        edges[(i, j)] = edges.get((i, j), 0) + 1
        if local[i] + out[i] < d[i]:
            heapq.heappush(senders, (Fraction(local[i] + out[i], d[i]), prio[i], i))
        spare = c[j] - local[j] - inn[j]
        if spare > 0:
            heapq.heappush(receivers, (Fraction(local[j] + inn[j], c[j]), -spare, j))

    results = [WardRouting(i, d[i], c[i], local[i], out[i], inn[i]) for i in sorted(d)]
    transfers = [Transfer(i, j, n) for (i, j), n in sorted(edges.items())]
    _check(results, transfers)
    return results, transfers


def _check(results: list[WardRouting], transfers: list[Transfer]) -> None:
    """Internal consistency guard: transfer records and ward totals must agree exactly."""
    by_id = {r.ward_id: r for r in results}
    sent = {i: 0 for i in by_id}
    got = {i: 0 for i in by_id}
    for t in transfers:
        if t.from_ward == t.to_ward or t.units <= 0 or t.from_ward not in by_id or t.to_ward not in by_id:
            raise HospitalInputError("invalid transfer record")
        sent[t.from_ward] += t.units
        got[t.to_ward] += t.units
    for r in results:
        if (sent[r.ward_id] != r.transferred_out or got[r.ward_id] != r.transferred_in
                or r.unmet_after_routing < 0 or r.spare_after_routing < 0
                or r.locally_assigned > min(r.demand, r.capacity)):
            raise HospitalInputError("routing balance check failed")


def summarize(results: Sequence[WardRouting], transfers: Sequence[Transfer]) -> dict:
    """Integer city-week totals. Transfer counts are derived from the transfer records and cross-checked
    against ward totals. Percentages are added by the caller."""
    demand = sum(r.demand for r in results)
    capacity = sum(r.capacity for r in results)
    local = sum(r.locally_assigned for r in results)
    units = sum(t.units for t in transfers)
    senders = {t.from_ward for t in transfers}
    receivers = {t.to_ward for t in transfers}
    if (units != sum(r.transferred_out for r in results) or units != sum(r.transferred_in for r in results)
            or senders != {r.ward_id for r in results if r.transferred_out > 0}
            or receivers != {r.ward_id for r in results if r.transferred_in > 0}):
        raise HospitalInputError("transfer summary does not match ward totals")
    occupied = local + units
    unmet = demand - occupied
    out = {
        "hypothetical_capacity": capacity,
        "bed_planning_demand": demand,
        "locally_assigned": local,
        "transfer_units": units,
        "transfer_edges": len(transfers),
        "sending_wards": len(senders),
        "receiving_wards": len(receivers),
        "occupied_after_routing": occupied,
        "unmet_after_routing": unmet,
        "spare_after_routing": capacity - occupied,
        "wards_with_unmet": sum(r.unmet_after_routing > 0 for r in results),
    }
    if unmet != sum(r.unmet_after_routing for r in results) or out["spare_after_routing"] < 0 or unmet < 0:
        raise HospitalInputError("city balance check failed")
    return out


def headline_week(weeks: Sequence[tuple[int, dict]]) -> int:
    """(horizon_week, city summary) pairs -> horizon week with the most unmet demand, then most demand,
    then the earliest week."""
    if not weeks:
        raise HospitalInputError("no weeks")
    return min(weeks, key=lambda hw: (-hw[1]["unmet_after_routing"], -hw[1]["bed_planning_demand"], hw[0]))[0]
