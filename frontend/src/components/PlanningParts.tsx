import type { ReactNode } from "react";
import type { Meta } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { InfoButton } from "./InfoButton";

/** Section heading, the selected week, the lead and the replay + hypothetical framing. */
export function PlanningHead(props: { id: string; title: string; date: string; lead: string; hypothetical: string; meta: Meta }) {
  const { t, lang, date } = useI18n();
  return (
    <>
      <div className="section-head">
        <h2 id={props.id}>{props.title}</h2>
        <p>{props.date ? t.planning.where(date(props.date)) : t.planning.noWeekBody}</p>
        <p>{props.lead}</p>
      </div>
      <p className="weekly-replay">
        <strong>{t.notLive}</strong> {lang === "bn" ? t.notice : props.meta.notice} {props.hypothetical}
      </p>
    </>
  );
}

/** The main action with its independent sibling explanation, and the draft / blocked status line. */
export function ApplyRow(props: {
  label: string;
  infoLabel: string;
  infoBody: string;
  onApply: () => void;
  disabled: boolean;
  draftChanged: boolean;
  blocked: boolean;
  draftText?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="planning-apply">
      <div className="action-with-info">
        <button type="button" className="btn" onClick={props.onApply} disabled={props.disabled}>
          {props.label}
        </button>
        <InfoButton label={props.infoLabel} title={props.label} description={props.infoBody} />
      </div>
      <p className="planning-draft" role="status" aria-live="polite">
        {props.blocked ? t.planning.blocked : props.draftChanged ? (props.draftText ?? t.planning.draftChanged) : ""}
      </p>
    </div>
  );
}

/** The backend's own policy, assumptions, limitations and warnings, marked as English. */
export function BackendNotes(props: { policy?: string; assumptions: string[]; limitations: string[]; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <details className="tech planning-details">
      <summary>{t.planning.detailsSummary}</summary>
      <div lang="en">
        {props.policy && <p>{props.policy}</p>}
        {props.children}
        <h4>{t.planning.assumptionsTitle}</h4>
        <ul className="planning-list">
          {props.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <h4>{t.planning.limitationsTitle}</h4>
        <ul className="planning-list">
          {props.limitations.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>
      <p className="weekly-note">{t.planning.detailsLanguage}</p>
    </details>
  );
}

/** Backend warnings, shown as given (English), never reworded. */
export function BackendWarnings({ warnings }: { warnings: string[] }) {
  const { t } = useI18n();
  if (warnings.length === 0) return null;
  return (
    <div className="warnings">
      <p>
        <strong>{t.planning.warningsTitle}</strong>
      </p>
      <ul className="planning-list" lang="en">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}
