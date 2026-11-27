import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/*
 * Contextual information button ("toggletip"): a small "i" button placed BESIDE a functional control,
 * never inside it. It opens a short explanation that floats above the page in a portal, so opening or
 * closing never changes the size of the surrounding card. It never runs the main action, never submits
 * a form and never makes a request.
 *
 * Contract: click toggles; Escape closes and returns focus to the "i"; a click or focus move outside
 * closes it without taking focus; only one explanation is open at a time across the whole page.
 */

// ---------------------------------------------------------------- one open explanation at a time
let openKey: string | null = null;
const listeners = new Set<() => void>();

function setOpenKey(next: string | null): void {
  if (openKey === next) return;
  openKey = next;
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Closes any open explanation (for example when a future view or tab changes). */
export function closeAllInfoPopovers(): void {
  setOpenKey(null);
}

/** Id of the open explanation, or null. Exposed for tests. */
export function openInfoPopoverKey(): string | null {
  return openKey;
}

// ---------------------------------------------------------------- viewport placement (pure, testable)
export interface AnchorRect {
  top: number;
  left: number;
  bottom: number;
  width: number;
}
export interface Placement {
  top: number;
  left: number;
  side: "below" | "above";
}

export const INFO_VIEWPORT_MARGIN = 12; // px kept free at every screen edge (matches --info-pop-margin)
export const INFO_ANCHOR_GAP = 8; // px between the "i" and the explanation

/**
 * Places the explanation below its anchor, centred on it, and keeps it inside the viewport: clamped at
 * the left and right edges, flipped above the anchor when there is not enough room below and more above,
 * and clamped vertically as a last resort.
 */
export function placeInfoPopover(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = INFO_VIEWPORT_MARGIN,
  gap = INFO_ANCHOR_GAP,
): Placement {
  const width = Math.min(size.width, Math.max(0, viewport.width - 2 * margin));
  const centred = anchor.left + anchor.width / 2 - width / 2;
  const left = Math.max(margin, Math.min(centred, viewport.width - margin - width));
  const belowTop = anchor.bottom + gap;
  const spaceBelow = viewport.height - margin - belowTop;
  const spaceAbove = anchor.top - gap - margin;
  const side = size.height <= spaceBelow || spaceBelow >= spaceAbove ? "below" : "above";
  const wanted = side === "below" ? belowTop : anchor.top - gap - size.height;
  const top = Math.max(margin, Math.min(wanted, viewport.height - margin - size.height));
  return { top: Math.round(top), left: Math.round(left), side };
}

function viewportSize(): { width: number; height: number } {
  // clientWidth excludes a vertical scrollbar; both are CSS pixels, like getBoundingClientRect (zoom-safe)
  return { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
}

// ---------------------------------------------------------------- component
export interface InfoButtonProps {
  /** Accessible name of the "i" button, e.g. "About Retry". */
  label: string;
  /** Short heading of the explanation, usually the action's own name. */
  title: string;
  /** One or two plain-language sentences: what the action does and why it is useful. */
  description: string;
  className?: string;
}

export function InfoButton({ label, title, description, className }: InfoButtonProps) {
  const key = useId();
  const popId = `info-pop-${key}`;
  const titleId = `${popId}-title`;
  const open = useSyncExternalStore(
    subscribe,
    () => openKey === key,
    () => false,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const place = useCallback(() => {
    const button = buttonRef.current;
    const pop = popRef.current;
    if (!button || !pop) return;
    const r = pop.getBoundingClientRect();
    setPlacement(placeInfoPopover(button.getBoundingClientRect(), { width: r.width, height: r.height }, viewportSize()));
  }, []);

  // Measure before the browser paints, so the explanation never appears in the wrong place first.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, title, description]);

  // Global listeners exist only while this explanation is open, and are always removed again.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const reposition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (!!buttonRef.current?.contains(target) || !!popRef.current?.contains(target));
    const close = () => {
      if (openKey === key) setOpenKey(null);
    };
    // pointerdown (not click): closes before the outside control acts, without preventing that action
    // and without moving focus away from what the user pressed.
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      buttonRef.current?.focus();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, key, place]);

  // Never leave a stale "open" key behind when the component disappears while open.
  useEffect(
    () => () => {
      if (openKey === key) setOpenKey(null);
    },
    [key],
  );

  const toggle = () => setOpenKey(openKey === key ? null : key);

  return (
    <span className={`info${className ? ` ${className}` : ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className="info-btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={popId}
        onClick={toggle}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 7.3v3.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
        </svg>
      </button>
      {/* Announces the explanation while focus stays on the "i" (the floating copy is far away in the DOM). */}
      <span className="sr-only" aria-live="polite">
        {open ? `${title}. ${description}` : ""}
      </span>
      {createPortal(
        <div
          ref={popRef}
          id={popId}
          role="note"
          aria-labelledby={titleId}
          aria-hidden={!open}
          inert={!open}
          className="info-pop"
          data-state={open ? "open" : "closed"}
          data-side={placement?.side ?? "below"}
          style={placement ? { top: `${placement.top}px`, left: `${placement.left}px` } : undefined}
        >
          <p className="info-pop-title" id={titleId}>
            {title}
          </p>
          <p className="info-pop-body">{description}</p>
        </div>,
        document.body,
      )}
    </span>
  );
}
