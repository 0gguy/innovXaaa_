import type { Forecast, RiskTier } from "../api/types";
import { TIER_ORDER } from "../api/types";

export function countByTier(rows: Forecast[]): Record<RiskTier, number> {
  const out: Record<RiskTier, number> = { Low: 0, Medium: 0, High: 0, Critical: 0 };
  for (const r of rows) out[r.risk_tier] += 1;
  return out;
}

export function tierRank(t: RiskTier): number {
  return TIER_ORDER.indexOf(t);
}
