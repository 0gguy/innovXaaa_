"""Hypothetical vector-control scenario arithmetic on the ML baseline (pure standard library).

Formula (reviewed handoff, ml_handoff_reviewed/inference/simulator.py):

    coverage   = crews / max(1, density / 12000)
    saturation = 1 - exp(-1.4 * coverage)              (computed as -expm1(-1.4 * coverage))
    R          = M * saturation                         M = 0.15 / 0.35 / 0.55 (ASSUMED)
    e_h        = R * ramp[h]                            ramp = 0.5 / 0.85 / 1.0 for t+2, t+3, t+4
    adjusted_h = baseline_h * (1 - e_h);  avoided_h = baseline_h * e_h

Guaranteed by the formula (for baseline >= 0, 0 <= M < 1, 0 <= ramp <= 1): 0 <= e_h <= M; 0 <= adjusted <= baseline;
avoided = baseline - adjusted; avoided is non-decreasing in M and in crews, with non-increasing marginal gains
(saturation is increasing and concave). These are scenario numbers: nothing here is causal or observed.
"""
from __future__ import annotations

import math
import numbers
from dataclasses import dataclass
from typing import Mapping, Sequence

from .parameters import (CREW_DENSITY_PER_CREW, CREW_MAX_PER_WARD, INTERVENTION_RAMP, INTERVENTION_SATURATION_K)

HORIZONS = (2, 3, 4)


class InterventionInputError(ValueError):
    """Invalid input to the scenario engine (programming or data error, not a user error)."""


def _crews(c) -> int:
    if isinstance(c, bool) or not isinstance(c, numbers.Integral) or not 0 <= int(c) <= CREW_MAX_PER_WARD:
        raise InterventionInputError(f"crews must be an integer in [0, {CREW_MAX_PER_WARD}]")
    return int(c)


def _positive(x, name: str) -> float:
    if isinstance(x, bool) or not isinstance(x, numbers.Real) or not math.isfinite(float(x)) or float(x) <= 0:
        raise InterventionInputError(f"{name} must be a finite number > 0")
    return float(x)


def _nonneg(x, name: str) -> float:
    if isinstance(x, bool) or not isinstance(x, numbers.Real) or not math.isfinite(float(x)) or float(x) < 0:
        raise InterventionInputError(f"{name} must be a finite number >= 0")
    return float(x)


def _effect(m) -> float:
    m = _nonneg(m, "max_reduction")
    if m >= 1:
        raise InterventionInputError("max_reduction must be < 1")
    return m


def coverage(crews: int, density: float) -> float:
    return _crews(crews) / max(1.0, _positive(density, "density") / CREW_DENSITY_PER_CREW)


def saturation(cov: float) -> float:
    """1 - exp(-k * cov), via expm1 for accuracy at small coverage."""
    return -math.expm1(-INTERVENTION_SATURATION_K * _nonneg(cov, "coverage"))


def max_reduction(crews: int, density: float, m: float) -> float:
    """R = M * saturation(coverage)."""
    return _effect(m) * saturation(coverage(crews, density))


@dataclass(frozen=True)
class WardEffect:
    crews: int
    coverage: float
    max_reduction: float
    reductions: tuple[float, float, float]     # e_h for t+2, t+3, t+4
    baseline: tuple[float, float, float]
    adjusted: tuple[float, float, float]
    avoided: tuple[float, float, float]

    @property
    def avoided_total(self) -> float:
        return sum(self.avoided)


def ward_effect(baseline: Sequence[float], crews: int, density: float, m: float) -> WardEffect:
    if len(baseline) != len(HORIZONS):
        raise InterventionInputError("baseline must have 3 weekly values (t+2, t+3, t+4)")
    b = tuple(_nonneg(x, "baseline weekly cases") for x in baseline)
    cov = coverage(crews, density)
    r = _effect(m) * saturation(cov)
    e = tuple(r * INTERVENTION_RAMP[h] for h in HORIZONS)
    avoided = tuple(bh * eh for bh, eh in zip(b, e))
    adjusted = tuple(bh - vh for bh, vh in zip(b, avoided))
    return WardEffect(int(crews), cov, r, e, b, adjusted, avoided)


def projected_avoided(baseline: Sequence[float], crews: int, density: float, m: float) -> float:
    return ward_effect(baseline, crews, density, m).avoided_total


@dataclass(frozen=True)
class CrewCandidate:
    """One ward for crew allocation. `priority` sorts ascending (Task 2 key, unique incl. ward_id)."""
    ward_id: str
    cap: int
    priority: tuple
    baseline: tuple
    density: float


def marginal_benefit(c: CrewCandidate, current: int, m: float) -> float | None:
    """Projected avoided cases gained by crew number current+1; None if the ward is at its cap."""
    if current >= c.cap:
        return None
    return projected_avoided(c.baseline, current + 1, c.density, m) - projected_avoided(c.baseline, current, c.density, m)


def roi_greedy(candidates: Sequence[CrewCandidate], pool: int, m: float) -> dict[str, int]:
    """HYPOTHETICAL alternative for one city: hand out `pool` crews one at a time to the ward with the largest
    marginal projected benefit (ties: Task 2 priority, which ends with ward_id), never above a ward's cap.
    For this separable objective with concave per-ward gains and caps, marginal-gain greedy maximises total
    projected avoided cases for the given pool (checked against brute force in tests). It is a surrogate
    objective under assumed effects, not a proven best real-world deployment."""
    if isinstance(pool, bool) or not isinstance(pool, numbers.Integral) or pool < 0:
        raise InterventionInputError("pool must be a non-negative integer")
    ids = [c.ward_id for c in candidates]
    if len(set(ids)) != len(ids) or len({c.priority for c in candidates}) != len(ids):
        raise InterventionInputError("ward ids and priority keys must be unique")
    cur = {c.ward_id: 0 for c in candidates}
    for c in candidates:
        _crews(c.cap)
    if pool > sum(c.cap for c in candidates):
        raise InterventionInputError("pool exceeds the total ward caps")
    for _ in range(int(pool)):
        best = None
        for c in candidates:
            g = marginal_benefit(c, cur[c.ward_id], m)
            if g is None:
                continue
            key = (-g, c.priority)
            if best is None or key < best[0]:
                best = (key, c.ward_id)
        cur[best[1]] += 1
    return cur


def first_crew_ranking(candidates: Sequence[CrewCandidate], m: float) -> list[tuple[str, float]]:
    """(ward_id, projected avoided cases from a ward's first crew) for eligible wards (cap > 0), best first;
    ties by Task 2 priority then ward_id."""
    rows = [(c, projected_avoided(c.baseline, 1, c.density, m)) for c in candidates if c.cap > 0]
    rows.sort(key=lambda r: (-r[1], r[0].priority))
    return [(c.ward_id, v) for c, v in rows]


def per_crew(avoided: float, crews: int) -> float | None:
    """Projected cases avoided per assigned crew; None when no crews are assigned."""
    return None if crews == 0 else avoided / crews
