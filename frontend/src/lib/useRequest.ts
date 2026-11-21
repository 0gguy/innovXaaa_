import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export interface RequestState<T> {
  status: "idle" | "loading" | "success" | "error";
  /** Data for the CURRENT key only; null while a newer key is loading. */
  data: T | null;
  error: ApiError | null;
  reload: () => void;
}

interface Settled<T> {
  tag: string;
  data: T | null;
  error: ApiError | null;
}

/**
 * Runs `fn` whenever `key` changes (or reload() is called).
 *
 * Stale-response protection: a result is stored with the tag of the request that produced
 * it, and is only exposed while that tag is still the current one. Older requests are also
 * aborted on cleanup and their late results are ignored.
 */
export function useRequest<T>(key: string | null, fn: (signal: AbortSignal) => Promise<T>): RequestState<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  });

  const tag = key === null ? null : `${key}#${nonce}`;

  useEffect(() => {
    if (tag === null) return;
    const controller = new AbortController();
    let cancelled = false;
    fnRef
      .current(controller.signal)
      .then((data) => {
        if (!cancelled) setSettled({ tag, data, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = e instanceof ApiError ? e : new ApiError("network", "Unexpected error.");
        if (error.kind === "aborted") return;
        setSettled({ tag, data: null, error });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [tag]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  if (tag === null) return { status: "idle", data: null, error: null, reload };
  if (settled === null || settled.tag !== tag) return { status: "loading", data: null, error: null, reload };
  if (settled.error) return { status: "error", data: null, error: settled.error, reload };
  return { status: "success", data: settled.data, error: null, reload };
}
