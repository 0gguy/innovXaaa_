import type { ReactNode } from "react";
import { ApiError } from "../api/client";
import type { I18n } from "../i18n/I18n";
import { useI18n } from "../i18n/I18n";
import { InfoButton } from "./InfoButton";

export function describeError(error: ApiError, baseUrl: string, i: I18n): { title: string; body: string } {
  const { t, lang } = i;
  if (error.kind === "network") return { title: t.errNetwork, body: t.errNetworkBody(baseUrl) };
  if (error.kind === "timeout") return { title: t.errTimeout, body: t.errTimeoutBody };
  if (error.kind === "http" && error.code === "model_unavailable") return { title: t.errModel, body: t.errModelBody };
  if (error.kind === "http" && error.code === "issue_week_out_of_range")
    return { title: t.errWeek, body: lang === "bn" ? t.errWeekBody : error.message };
  // Backend-authored messages are English only; in Bangla we keep them as a quoted detail.
  if (error.kind === "http") return { title: t.errRejected, body: error.message };
  return { title: t.errShape, body: t.errShapeBody };
}

export function ErrorPanel({
  error,
  baseUrl,
  onRetry,
  compact = false,
}: {
  error: ApiError;
  baseUrl: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  const i = useI18n();
  const { title, body } = describeError(error, baseUrl, i);
  const rawEnglish = i.lang === "bn" && error.kind === "http" && error.code !== "issue_week_out_of_range" && error.code !== "model_unavailable";
  return (
    <div className={`status status-error${compact ? " status-compact" : ""}`} role="alert">
      <h3>{title}</h3>
      <p lang={rawEnglish ? "en" : undefined}>{body}</p>
      <div className="action-with-info">
        <button type="button" className="btn" onClick={onRetry}>
          {i.t.retry}
        </button>
        <InfoButton label={i.t.info.retryLabel} title={i.t.info.retryTitle} description={i.t.info.retryBody} />
      </div>
    </div>
  );
}

export function LoadingPanel({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="status status-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
      {children}
    </div>
  );
}

export function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="status status-empty">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
