import type { Forecast, RiskTier } from "../api/types";
import { TIER_ORDER } from "../api/types";

/** "DNCC_Ward_12" -> "DNCC Ward 12" */
export function wardLabel(wardId: string): string {
  return wardId.replace(/_/g, " ");
}

/** "DNCC_Ward_12" -> "12" (falls back to the full label) */
export function wardNumber(wardId: string): string {
  const m = /_(\d+)$/.exec(wardId);
  return m?.[1] ?? wardLabel(wardId);
}

export function cases(n: number, digits = 1): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signed(n: number, digits = 1): string {
  const s = cases(Math.abs(n), digits);
  return n < 0 ? `−${s}` : `+${s}`;
}

/** One-letter mark so tier never depends on colour alone. */
export const TIER_MARK: Record<RiskTier, string> = { Low: "L", Medium: "M", High: "H", Critical: "C" };

export function countByTier(rows: Forecast[]): Record<RiskTier, number> {
  const out: Record<RiskTier, number> = { Low: 0, Medium: 0, High: 0, Critical: 0 };
  for (const r of rows) out[r.risk_tier] += 1;
  return out;
}

export function tierRank(t: RiskTier): number {
  return TIER_ORDER.indexOf(t);
}
