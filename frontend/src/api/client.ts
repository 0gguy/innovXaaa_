import type { AllForecastsResponse, Meta, WardForecastResponse } from "./types";
import { parseAllForecasts, parseMeta, parseWardForecast, ShapeError } from "./validate";

export type ApiErrorKind = "network" | "timeout" | "http" | "shape" | "aborted";

export class ApiError extends Error {
  kind: ApiErrorKind;
  status?: number;
  code?: string;
  constructor(kind: ApiErrorKind, message: string, opts: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
  }
}

export interface ApiClient {
  baseUrl: string;
  meta(signal?: AbortSignal): Promise<Meta>;
  forecastWard(
    wardId: string,
    issueDate: string,
    includeDrivers: boolean,
    signal?: AbortSignal,
  ): Promise<WardForecastResponse>;
  forecastAll(issueDate: string, signal?: AbortSignal): Promise<AllForecastsResponse>;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
export const DEFAULT_TIMEOUT_MS = 15000;

export function resolveBaseUrl(): string {
  const raw: unknown = import.meta.env?.VITE_API_BASE_URL;
  return (typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function getJson(url: string, timeoutMs: number, external?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof err?.code === "string" ? err.code : undefined;
      const message = typeof err?.message === "string" ? err.message : `The backend returned HTTP ${res.status}.`;
      throw new ApiError("http", message, { status: res.status, code });
    }
    if (body === null) throw new ApiError("shape", "The backend response was not valid JSON.");
    return body;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (timedOut) throw new ApiError("timeout", "The backend took too long to respond.");
    if (controller.signal.aborted) throw new ApiError("aborted", "Request cancelled.");
    throw new ApiError("network", "Could not reach the backend.");
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

function checked<T>(parse: (v: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch (e) {
    if (e instanceof ShapeError) throw new ApiError("shape", "The backend sent data in an unexpected format.");
    throw e;
  }
}

export function createClient(baseUrl: string = resolveBaseUrl(), timeoutMs: number = DEFAULT_TIMEOUT_MS): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    baseUrl: base,
    async meta(signal) {
      return checked(parseMeta, await getJson(`${base}/meta`, timeoutMs, signal));
    },
    async forecastWard(wardId, issueDate, includeDrivers, signal) {
      const q = new URLSearchParams({ issue_date: issueDate, include_drivers: String(includeDrivers) });
      const url = `${base}/forecast/${encodeURIComponent(wardId)}?${q.toString()}`;
      return checked(parseWardForecast, await getJson(url, timeoutMs, signal));
    },
    async forecastAll(issueDate, signal) {
      const q = new URLSearchParams({ issue_date: issueDate, include_drivers: "false" });
      return checked(parseAllForecasts, await getJson(`${base}/forecast?${q.toString()}`, timeoutMs, signal));
    },
  };
}
