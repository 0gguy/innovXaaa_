import type { RiskTier } from "../api/types";
import { TIER_MARK } from "../lib/format";

/** Risk tier shown as colour + letter mark + word, so it never relies on colour alone. */
export function TierChip({ tier, className = "" }: { tier: RiskTier; className?: string }) {
  return (
    <span className={`tier tier-${tier.toLowerCase()} ${className}`.trim()}>
      <span className="tier-mark" aria-hidden="true">
        {TIER_MARK[tier]}
      </span>
      {tier}
    </span>
  );
}
