"""Integer allocation engine: Minimum Coverage + Risk Priority.

Pure standard library (fractions, heapq). Deterministic, fairness-first greedy policy:

  Stage 1 (minimum coverage, skipped when min_coverage_pct == 0)
      floor_i = min(d_i, ceil(min_coverage_pct * d_i / 100))  for every ward with d_i > 0.
      Units are given ONE AT A TIME to the ward with the lowest coverage a_i / d_i among wards
      still below their floor (exact rational comparison); ties go to the higher-priority ward.
  Stage 2 (strict priority)
      Remaining units fill wards in priority order, each up to its demand.

Because the order in which units are handed out does not depend on the stock, the allocation for
stock S is exactly the first S units of one fixed sequence. Consequences (tested):
  * sum(a) == min(S, sum(d)); 0 <= a_i <= d_i; all integers;
  * more stock never reduces any ward's allocation (no Alabama paradox, unlike Hamilton apportionment);
  * with min_coverage_pct > 0 every ward with demand is at coverage 0 initially, so the first n units
    go one per ward: if S >= n (wards with demand) every such ward receives at least one unit.

This is a transparent planning rule. It is not claimed to be globally optimal for any clinical,
welfare or max-min objective.
"""
from __future__ import annotations

import heapq
import numbers
from dataclasses import dataclass
from fractions import Fraction
from typing import Hashable, Iterable, Mapping, Sequence


class AllocationInputError(ValueError):
    """Invalid input to the allocation engine (programming or data error, not a user error)."""


@dataclass(frozen=True)
class Claim:
    """One ward's demand for one resource. `priority` sorts ascending: smaller = served first.
    It must be unique per claim (include the ward_id) so the order is total."""
    ward_id: str
    demand: int
    priority: tuple


@dataclass(frozen=True)
class Allocation:
    ward_id: str
    rank: int          # 1 = highest priority among the claims given
    demand: int
    floor: int
    stage1: int        # units received in Stage 1
    allocated: int

    @property
    def deficit(self) -> int:
        return self.demand - self.allocated

    @property
    def severity(self) -> str:
        if self.deficit == 0:
            return "no_deficit"
        return "below_floor" if self.allocated < self.floor else "partial"

    @property
    def reason(self) -> str:
        if self.demand == 0:
            return "no_demand"
        if self.allocated == self.demand:
            return "fulfilled"
        if self.allocated < self.floor:
            return "below_floor"
        if self.floor > 0 and self.allocated == self.floor:
            return "floor_only"
        if self.allocated > self.floor:
            return "partial_priority"
        return "not_reached"  # floor 0 (min_coverage_pct = 0) and nothing left for this ward


def _check_int(value, name: str, lo: int = 0, hi: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, numbers.Integral):
        raise AllocationInputError(f"{name} must be an integer, got {type(value).__name__}")
    v = int(value)
    if v < lo or (hi is not None and v > hi):
        raise AllocationInputError(f"{name} must be in [{lo}, {hi if hi is not None else 'inf'}], got {v}")
    return v


def floor_target(demand: int, min_coverage_pct: int) -> int:
    """min(d, ceil(pct * d / 100)) with integer arithmetic."""
    return min(demand, -(-(min_coverage_pct * demand) // 100))


def allocate(claims: Iterable[Claim], stock: int, min_coverage_pct: int) -> tuple[list[Allocation], int]:
    """Allocate `stock` integer units over `claims`. Returns (allocations in priority order, unallocated)."""
    stock = _check_int(stock, "stock")
    pct = _check_int(min_coverage_pct, "min_coverage_pct", 0, 100)
    items = list(claims)
    ids = [c.ward_id for c in items]
    if len(set(ids)) != len(ids):
        raise AllocationInputError("duplicate ward_id in claims")
    keys = [c.priority for c in items]
    if len(set(keys)) != len(keys):
        raise AllocationInputError("priority keys must be unique (include ward_id)")
    order = sorted(items, key=lambda c: c.priority)
    demand = [_check_int(c.demand, f"demand[{c.ward_id}]") for c in order]
    n = len(order)
    floors = [floor_target(d, pct) for d in demand]
    alloc = [0] * n
    left = stock

    # Stage 1: lowest coverage first among wards below their floor; exact Fractions; tie -> rank.
    heap = [(Fraction(0), i) for i in range(n) if floors[i] > 0]
    heapq.heapify(heap)
    while left > 0 and heap:
        _, i = heapq.heappop(heap)
        alloc[i] += 1
        left -= 1
        if alloc[i] < floors[i]:
            heapq.heappush(heap, (Fraction(alloc[i], demand[i]), i))
    stage1 = list(alloc)

    # Stage 2: strict priority order.
    for i in range(n):
        if left == 0:
            break
        give = min(left, demand[i] - alloc[i])
        alloc[i] += give
        left -= give

    out = [Allocation(order[i].ward_id, i + 1, demand[i], floors[i], stage1[i], alloc[i]) for i in range(n)]
    return out, left


def split_budget(demands: Mapping[Hashable, int], budget: int,
                 tie_key: Mapping[Hashable, Sequence] | None = None) -> tuple[dict, int]:
    """Split an integer budget across groups (e.g. cities) one unit at a time to the group with the
    lowest coverage pool/demand (exact), never above its demand. Ties: `tie_key[g]` ascending, then g.

    The unit sequence does not depend on the budget, so a larger budget never reduces any group's
    pool. Returns ({group: pool}, unassigned)."""
    budget = _check_int(budget, "budget")
    d = {g: _check_int(v, f"demand[{g}]") for g, v in demands.items()}
    tk = {g: tuple(tie_key[g]) if tie_key else () for g in d}
    pool = {g: 0 for g in d}
    heap = [(Fraction(0), tk[g], g) for g in sorted(d) if d[g] > 0]
    heapq.heapify(heap)
    left = budget
    while left > 0 and heap:
        _, t, g = heapq.heappop(heap)
        pool[g] += 1
        left -= 1
        if pool[g] < d[g]:
            heapq.heappush(heap, (Fraction(pool[g], d[g]), t, g))
    return pool, left
