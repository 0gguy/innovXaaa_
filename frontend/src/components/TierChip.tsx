import type { RiskTier } from "../api/types";
import { useI18n } from "../i18n/I18n";

/** Risk tier shown as colour + letter mark + word, so it never relies on colour alone. */
export function TierChip({ tier, className = "" }: { tier: RiskTier; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={`tier tier-${tier.toLowerCase()} ${className}`.trim()}>
      <span className="tier-mark" aria-hidden="true">
        {t.tierMark[tier]}
      </span>
      {t.tier[tier]}
    </span>
  );
}
