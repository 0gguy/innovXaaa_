import type { ReactNode } from "react";
import { ApiError } from "../api/client";

export function describeError(error: ApiError, baseUrl: string): { title: string; body: string } {
  if (error.kind === "network")
    return {
      title: "Can't reach the forecast service",
      body: `Nothing answered at ${baseUrl}. Start the backend (see frontend/README.md), then retry.`,
    };
  if (error.kind === "timeout")
    return { title: "The forecast service is slow to answer", body: "The request timed out. Retry in a moment." };
  if (error.kind === "http" && error.code === "model_unavailable")
    return {
      title: "The forecast model isn't loaded",
      body: "The backend is running, but its model failed to load, so no forecasts can be shown. Check the backend log, then retry.",
    };
  if (error.kind === "http" && error.code === "issue_week_out_of_range")
    return { title: "No data for that week", body: error.message };
  if (error.kind === "http") return { title: "The request was rejected", body: error.message };
  return {
    title: "Unexpected response from the backend",
    body: "The data did not match what this dashboard expects. Retry, or check that the backend version matches.",
  };
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
  const { title, body } = describeError(error, baseUrl);
  return (
    <div className={`status status-error${compact ? " status-compact" : ""}`} role="alert">
      <h3>{title}</h3>
      <p>{body}</p>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
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
