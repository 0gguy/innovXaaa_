import type {
  AllForecastsResponse,
  AllocationQuery,
  AllocationResponse,
  DispatchBriefResponse,
  DispatchDocument,
  DispatchDocumentFormat,
  DispatchQuery,
  HospitalRoutingQuery,
  HospitalRoutingResponse,
  InterventionQuery,
  InterventionResponse,
  Meta,
  WardForecastResponse,
} from "./types";
import {
  parseAllForecasts,
  parseAllocation,
  parseDispatchBrief,
  parseHospitalRouting,
  parseInterventionSimulation,
  parseMeta,
  parseWardForecast,
  ShapeError,
} from "./validate";

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

/** Optional extras for the Phase 1 forecast calls. Omitted = the original request, unchanged. */
export interface ForecastOptions {
  /** Ask for the Task 1 weekly split (t+2, t+3, t+4). Default false. */
  includeWeekly?: boolean;
}

export interface ApiClient {
  baseUrl: string;
  meta(signal?: AbortSignal): Promise<Meta>;
  forecastWard(
    wardId: string,
    issueDate: string,
    includeDrivers: boolean,
    signal?: AbortSignal,
    options?: ForecastOptions,
  ): Promise<WardForecastResponse>;
  forecastAll(issueDate: string, signal?: AbortSignal, options?: ForecastOptions): Promise<AllForecastsResponse>;
}

/**
 * Phase 2 planning endpoints. All are read-only GET requests. Every figure they return is a derived
 * planning value under hypothetical inputs or assumed effects; nothing here sends or dispatches anything.
 */
export interface PlanningApiClient {
  allocation(query?: AllocationQuery, signal?: AbortSignal): Promise<AllocationResponse>;
  hospitalRouting(query?: HospitalRoutingQuery, signal?: AbortSignal): Promise<HospitalRoutingResponse>;
  interventionSimulation(query?: InterventionQuery, signal?: AbortSignal): Promise<InterventionResponse>;
  /** Structured draft brief (format=json), validated, with its draft / not-sent status. */
  dispatchBrief(query: DispatchQuery, signal?: AbortSignal): Promise<DispatchBriefResponse>;
  /** Draft brief as an inert string: plain text (format=text) or standalone printable HTML (format=html). */
  dispatchDocument(query: DispatchQuery, format: DispatchDocumentFormat, signal?: AbortSignal): Promise<DispatchDocument>;
  /** Absolute URL of a dispatch brief, e.g. for opening the server's standalone printable page. No request is made. */
  dispatchBriefUrl(query: DispatchQuery, format: "json" | DispatchDocumentFormat): string;
}

export type FullApiClient = ApiClient & PlanningApiClient;

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
export const DEFAULT_TIMEOUT_MS = 15000;

export function resolveBaseUrl(): string {
  const raw: unknown = import.meta.env?.VITE_API_BASE_URL;
  return (typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * The one request path for every endpoint: GET only, timeout, caller abort, typed errors.
 * Error responses are always the backend's JSON envelope, whatever format was asked for.
 */
async function request<T>(
  url: string,
  timeoutMs: number,
  external: AbortSignal | undefined,
  accept: string,
  read: (res: Response) => Promise<T>,
): Promise<T> {
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
      headers: { Accept: accept },
      signal: controller.signal,
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof err?.code === "string" ? err.code : undefined;
      const message = typeof err?.message === "string" ? err.message : `The backend returned HTTP ${res.status}.`;
      throw new ApiError("http", message, { status: res.status, code });
    }
    return await read(res);
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

function getJson(url: string, timeoutMs: number, external?: AbortSignal): Promise<unknown> {
  return request(url, timeoutMs, external, "application/json", async (res) => {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body === null) throw new ApiError("shape", "The backend response was not valid JSON.");
    return body;
  });
}

const DOCUMENT_TYPES: Record<DispatchDocumentFormat, string> = { text: "text/plain", html: "text/html" };
// Both document formats always carry the draft label; a document without it is not shown.
const DRAFT_MARKERS: Record<DispatchDocumentFormat, RegExp> = { text: /DRAFT ?\/ ?NOT SENT/, html: /DRAFT \/ NOT SENT/ };

/** "attachment; filename="x.html"" -> "x.html", only for the backend's safe [A-Za-z0-9._-] names. */
export function dispositionFilename(header: string | null): string | null {
  const m = header ? /filename="([A-Za-z0-9._-]{1,200})"/.exec(header) : null;
  return m?.[1] ?? null;
}

/** Text or HTML read as an inert string. It is never parsed as JSON and never inserted into the page. */
function getDocument(url: string, format: DispatchDocumentFormat, timeoutMs: number, external?: AbortSignal): Promise<DispatchDocument> {
  const expected = DOCUMENT_TYPES[format];
  return request(url, timeoutMs, external, expected, async (res) => {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.split(";")[0]?.trim().toLowerCase() !== expected) {
      throw new ApiError("shape", "The backend sent the brief in an unexpected format.");
    }
    const body = await res.text();
    if (!DRAFT_MARKERS[format].test(body)) throw new ApiError("shape", "The brief is missing its draft label.");
    return { format, body, contentType, filename: dispositionFilename(res.headers.get("content-disposition")) };
  });
}

type QueryValue = string | number | boolean | undefined | null;

/** Only parameters that were explicitly given are sent, so backend defaults stay in charge. */
function queryString(params: Record<string, QueryValue>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError(`Query parameter ${k} must be a finite number.`);
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

function dispatchParams(query: DispatchQuery, format: "json" | DispatchDocumentFormat): Record<string, QueryValue> {
  // `format` is always set here, after the caller's fields, so it cannot be overridden.
  return { ...(query as unknown as Record<string, QueryValue>), format };
}

function checked<T>(parse: (v: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch (e) {
    if (e instanceof ShapeError) throw new ApiError("shape", "The backend sent data in an unexpected format.");
    throw e;
  }
}

export function createClient(baseUrl: string = resolveBaseUrl(), timeoutMs: number = DEFAULT_TIMEOUT_MS): FullApiClient {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    baseUrl: base,
    async meta(signal) {
      return checked(parseMeta, await getJson(`${base}/meta`, timeoutMs, signal));
    },
    async forecastWard(wardId, issueDate, includeDrivers, signal, options) {
      const q = new URLSearchParams({ issue_date: issueDate, include_drivers: String(includeDrivers) });
      if (options?.includeWeekly) q.set("include_weekly", "true");
      const url = `${base}/forecast/${encodeURIComponent(wardId)}?${q.toString()}`;
      return checked(parseWardForecast, await getJson(url, timeoutMs, signal));
    },
    async forecastAll(issueDate, signal, options) {
      const q = new URLSearchParams({ issue_date: issueDate, include_drivers: "false" });
      if (options?.includeWeekly) q.set("include_weekly", "true");
      return checked(parseAllForecasts, await getJson(`${base}/forecast?${q.toString()}`, timeoutMs, signal));
    },
    async allocation(query = {}, signal) {
      const url = `${base}/allocation${queryString({ ...query })}`;
      return checked(parseAllocation, await getJson(url, timeoutMs, signal));
    },
    async hospitalRouting(query = {}, signal) {
      const url = `${base}/hospital-routing${queryString({ ...query })}`;
      return checked(parseHospitalRouting, await getJson(url, timeoutMs, signal));
    },
    async interventionSimulation(query = {}, signal) {
      const url = `${base}/intervention-simulation${queryString({ ...query })}`;
      return checked(parseInterventionSimulation, await getJson(url, timeoutMs, signal));
    },
    async dispatchBrief(query, signal) {
      const url = `${base}/dispatch-brief${queryString(dispatchParams(query, "json"))}`;
      return checked(parseDispatchBrief, await getJson(url, timeoutMs, signal));
    },
    async dispatchDocument(query, format, signal) {
      if (format !== "text" && format !== "html") throw new TypeError("format must be text or html.");
      const url = `${base}/dispatch-brief${queryString(dispatchParams(query, format))}`;
      return getDocument(url, format, timeoutMs, signal);
    },
    dispatchBriefUrl(query, format) {
      return `${base}/dispatch-brief${queryString(dispatchParams(query, format))}`;
    },
  };
}
