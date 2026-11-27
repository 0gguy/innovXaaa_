// Contextual information button: behaviour, accessibility, placement maths and the two representative
// integrations (Retry in the error panel, show-all/top in the ward list).
// NOTE: jsdom does no real layout. Geometry is tested through the pure placement function and mocked
// element rectangles; real on-screen fit and zero visual shift still need a browser check.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { I18nProvider } from "../i18n/I18n";
import { bn, en } from "../i18n/dict";
import { makeForecast, makeMeta } from "../test/fixtures";
import {
  closeAllInfoPopovers,
  InfoButton,
  INFO_ANCHOR_GAP,
  INFO_VIEWPORT_MARGIN,
  openInfoPopoverKey,
  placeInfoPopover,
} from "./InfoButton";
import { Overview } from "./Overview";
import { ErrorPanel } from "./StatusPanel";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

const popoverOf = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-controls") ?? "") as HTMLElement;
const isOpen = (button: HTMLElement) => button.getAttribute("aria-expanded") === "true" && popoverOf(button).dataset.state === "open";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}
function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

/** A main action and its info button as siblings, inside a form (like real controls). */
function Harness({ onMain = () => {}, onSubmit = () => {} }: { onMain?: () => void; onSubmit?: () => void }) {
  return (
    <form
      aria-label="Harness"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="card" data-testid="card">
        <div className="action-with-info">
          <button type="button" onClick={onMain}>
            Recalculate
          </button>
          <InfoButton label="About Recalculate" title="Recalculate" description="Runs the plan again with the current inputs." />
        </div>
      </div>
      <button type="button">Outside</button>
    </form>
  );
}

// ---------------------------------------------------------------- open, close, independence
describe("info button behaviour", () => {
  it("opens and closes its own explanation and reports it with aria-expanded / aria-controls", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    expect(info).toHaveAttribute("type", "button");
    expect(info).toHaveAttribute("aria-expanded", "false");
    const pop = popoverOf(info);
    expect(pop).toBeInTheDocument();
    expect(pop).toHaveAttribute("role", "note");
    expect(pop).toHaveAttribute("aria-hidden", "true");
    expect(document.getElementById(pop.getAttribute("aria-labelledby")!)).toHaveTextContent("Recalculate");
    expect(pop).toHaveTextContent("Runs the plan again with the current inputs.");

    await user.click(info);
    expect(isOpen(info)).toBe(true);
    expect(pop).toHaveAttribute("aria-hidden", "false");
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(pop.dataset.state).toBe("closed");
    expect(pop).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the main action and the info button independent, and never submits the form", async () => {
    const user = userEvent.setup();
    const onMain = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onMain={onMain} onSubmit={onSubmit} />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    await user.click(screen.getByRole("button", { name: "Recalculate" }));
    expect(onMain).toHaveBeenCalledTimes(1);
    expect(info).toHaveAttribute("aria-expanded", "false");
    await user.click(info);
    await user.click(info);
    await user.click(info);
    expect(onMain).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("closes on an outside click without stealing focus or blocking the clicked control", async () => {
    const user = userEvent.setup();
    const onMain = vi.fn();
    render(<Harness onMain={onMain} />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    await user.click(info);
    expect(isOpen(info)).toBe(true);
    const outside = screen.getByRole("button", { name: "Outside" });
    await user.click(outside);
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(outside);
    await user.click(info);
    await user.click(screen.getByRole("button", { name: "Recalculate" }));
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(onMain).toHaveBeenCalledTimes(1); // the outside control still did its normal job, once
    await user.click(info);
    await user.click(document.body);
    expect(info).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open when the explanation itself is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    await user.click(info);
    await user.click(within(popoverOf(info)).getByText("Runs the plan again with the current inputs."));
    expect(isOpen(info)).toBe(true);
  });

  it("closes on Escape and returns focus to the info button", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    await user.click(info);
    await user.keyboard("{Escape}");
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(info);
  });

  it("works from the keyboard: focus stays on the button, Enter/Space toggle, Tab away closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const main = screen.getByRole("button", { name: "Recalculate" });
    const info = screen.getByRole("button", { name: "About Recalculate" });
    main.focus();
    await user.tab();
    expect(document.activeElement).toBe(info);
    await user.keyboard("{Enter}");
    expect(isOpen(info)).toBe(true);
    expect(document.activeElement).toBe(info);
    await user.keyboard(" ");
    expect(info).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outside" }));
    expect(info).toHaveAttribute("aria-expanded", "false");
  });

  it("announces the explanation politely while focus stays on the button", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    const live = info.parentElement!.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");
    await user.click(info);
    expect(live.textContent).toBe("Recalculate. Runs the plan again with the current inputs.");
    await user.click(info);
    expect(live.textContent).toBe("");
  });

  it("keeps only one explanation open at a time", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoButton label="About A" title="A" description="First." />
        <InfoButton label="About B" title="B" description="Second." />
      </div>,
    );
    const a = screen.getByRole("button", { name: "About A" });
    const b = screen.getByRole("button", { name: "About B" });
    await user.click(a);
    await user.click(b);
    expect(a).toHaveAttribute("aria-expanded", "false");
    expect(isOpen(b)).toBe(true);
    expect(document.querySelectorAll('.info-pop[data-state="open"]')).toHaveLength(1);
    await user.click(a);
    expect(isOpen(a)).toBe(true);
    expect(b).toHaveAttribute("aria-expanded", "false");
  });

  it("stays consistent under rapid toggling", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    for (let i = 0; i < 7; i += 1) await user.click(info);
    expect(isOpen(info)).toBe(true);
    expect(document.querySelectorAll('.info-pop[data-state="open"]')).toHaveLength(1);
    await user.click(info);
    expect(document.querySelectorAll('.info-pop[data-state="open"]')).toHaveLength(0);
  });

  it("can be closed from outside (for a future view or tab change)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    await user.click(info);
    act(() => closeAllInfoPopovers());
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(openInfoPopoverKey()).toBeNull();
  });
});

// ---------------------------------------------------------------- structure: no nesting, no layout flow
describe("info button structure", () => {
  it("is a sibling of the main action, never nested, with unique ids", () => {
    render(
      <>
        <Harness />
        <InfoButton label="About other" title="Other" description="Another explanation." />
      </>,
    );
    expect(document.querySelectorAll("button button, button [role='note'], summary button")).toHaveLength(0);
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    expect(info.closest("button")).toBe(info);
    expect(info.parentElement!.parentElement).toContainElement(screen.getByRole("button", { name: "Recalculate" }));
  });

  it("renders the explanation in a portal outside the card, so opening adds nothing to the card", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const card = screen.getByTestId("card");
    const info = screen.getByRole("button", { name: "About Recalculate" });
    const pop = popoverOf(info);
    expect(pop.parentElement).toBe(document.body);
    expect(card).not.toContainElement(pop);
    const before = [...card.querySelectorAll("*")].map((e) => e.tagName);
    await user.click(info);
    expect([...card.querySelectorAll("*")].map((e) => e.tagName)).toEqual(before);
    expect(card).not.toContainElement(pop);
  });

  it("removes a still-open explanation state when unmounted", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole("button", { name: "About Recalculate" }));
    expect(openInfoPopoverKey()).not.toBeNull();
    unmount();
    expect(openInfoPopoverKey()).toBeNull();
    expect(document.querySelector(".info-pop")).toBeNull();
  });

  it("adds global listeners only while open and removes every one of them", async () => {
    const user = userEvent.setup();
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Harness />);
    const ours = (calls: unknown[][]) => calls.filter(([type]) => ["pointerdown", "keydown", "focusin", "resize", "scroll"].includes(type as string));
    const addedBefore = ours(docAdd.mock.calls).length + ours(winAdd.mock.calls).length;
    const info = screen.getByRole("button", { name: "About Recalculate" });
    await user.click(info);
    const added = [...ours(docAdd.mock.calls), ...ours(winAdd.mock.calls)].slice(0);
    expect(added.length - addedBefore).toBeGreaterThanOrEqual(5);
    await user.click(info); // close
    const removed = [...ours(docRemove.mock.calls), ...ours(winRemove.mock.calls)];
    for (const [type, fn] of [...ours(docAdd.mock.calls), ...ours(winAdd.mock.calls)].filter((c) => typeof c[1] === "function" && (c[1] as { name?: string }).name !== "")) {
      if (["onPointerDown", "onKeyDown", "onFocusIn", "reposition"].includes((fn as { name: string }).name)) {
        expect(removed.some(([t, f]) => t === type && f === fn), `${String(type)} listener removed`).toBe(true);
      }
    }
    await user.click(info); // open again, then unmount while open
    unmount();
    const ownAdds = [...ours(docAdd.mock.calls), ...ours(winAdd.mock.calls)].filter(([, fn]) =>
      ["onPointerDown", "onKeyDown", "onFocusIn", "reposition"].includes((fn as { name?: string }).name ?? ""),
    );
    const allRemoved = [...ours(docRemove.mock.calls), ...ours(winRemove.mock.calls)];
    for (const [type, fn] of ownAdds) expect(allRemoved.some(([t, f]) => t === type && f === fn)).toBe(true);
    expect(ownAdds).toHaveLength(10); // 5 listeners x 2 openings
  });

  it("makes no network request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(<Harness />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    await user.click(info);
    await user.keyboard("{Escape}");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------- placement
describe("info explanation placement", () => {
  const M = INFO_VIEWPORT_MARGIN;
  const G = INFO_ANCHOR_GAP;
  const anchor = (left: number, top: number, size = 28) => ({ left, top, width: size, bottom: top + size });

  it("sits just below the anchor, centred on it", () => {
    expect(placeInfoPopover(anchor(500, 100), { width: 200, height: 80 }, { width: 1280, height: 800 })).toEqual({
      top: 128 + G,
      left: 514 - 100,
      side: "below",
    });
  });

  it("is clamped at the left and right screen edges", () => {
    expect(placeInfoPopover(anchor(2, 100), { width: 300, height: 80 }, { width: 1280, height: 800 }).left).toBe(M);
    expect(placeInfoPopover(anchor(1250, 100), { width: 300, height: 80 }, { width: 1280, height: 800 }).left).toBe(1280 - M - 300);
  });

  it("flips above near the bottom edge when there is more room above", () => {
    const p = placeInfoPopover(anchor(500, 740), { width: 200, height: 120 }, { width: 1280, height: 800 });
    expect(p.side).toBe("above");
    expect(p.top).toBe(740 - G - 120);
  });

  it("stays below near the top edge", () => {
    const p = placeInfoPopover(anchor(500, 4), { width: 200, height: 120 }, { width: 1280, height: 800 });
    expect(p.side).toBe("below");
    expect(p.top).toBe(32 + G);
  });

  it("fits a narrow mobile viewport", () => {
    // a 400px explanation on a 360px phone: the width is capped at 360 - 2 x 12 = 336 and stays on screen
    const p = placeInfoPopover(anchor(300, 200), { width: 400, height: 140 }, { width: 360, height: 640 });
    expect(p.left).toBe(M);
    expect(p.left + (360 - 2 * M)).toBe(360 - M);
    // a narrower one near the right edge is pushed left to stay inside
    expect(placeInfoPopover(anchor(300, 200), { width: 320, height: 140 }, { width: 360, height: 640 }).left).toBe(360 - M - 320);
  });

  it("is kept inside a very short viewport", () => {
    const p = placeInfoPopover(anchor(100, 150), { width: 200, height: 400 }, { width: 800, height: 300 });
    expect(p.top).toBe(M);
  });

  it("applies the computed position to the floating element and follows resize and scroll", async () => {
    setViewport(1024, 768);
    const user = userEvent.setup();
    render(<Harness />);
    const info = screen.getByRole("button", { name: "About Recalculate" });
    const pop = popoverOf(info);
    const anchorRect = vi.spyOn(info, "getBoundingClientRect").mockReturnValue(rect(400, 200, 28, 28));
    vi.spyOn(pop, "getBoundingClientRect").mockReturnValue(rect(0, 0, 240, 90));
    await user.click(info);
    expect(pop.style.top).toBe(`${228 + G}px`);
    expect(pop.style.left).toBe(`${414 - 120}px`);

    anchorRect.mockReturnValue(rect(900, 700, 28, 28)); // near the bottom-right corner after scrolling
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(pop.style.left).toBe(`${1024 - M - 240}px`));
    expect(pop.style.top).toBe(`${700 - G - 90}px`);
    expect(pop.dataset.side).toBe("above");

    setViewport(375, 667); // rotate to a phone
    anchorRect.mockReturnValue(rect(330, 100, 28, 28));
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(pop.style.left).toBe(`${375 - M - 240}px`));
  });
});

// ---------------------------------------------------------------- styles
/** The stylesheet text from disk (the test config sets css: false, so CSS imports are empty in tests).
 *  Vitest runs from frontend/, so the path is relative to that folder. */
async function readStyles(): Promise<string> {
  const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { readFileSync(path: string, encoding: "utf8"): string };
  return fs.readFileSync("src/styles.css", "utf8");
}

describe("info button styles", () => {
  it("reuses the existing palette and timing and supports reduced motion", async () => {
    const css = await readStyles();
    for (const token of ["--paper: #eff3ee", "--surface: #fafcf9", "--ink: #12302f", "--teal: #0e4f54", "--aqua-soft: #d6ece8", "--focus: #0a6a75", "--crit-bg: #a63429"]) {
      expect(css).toContain(token);
    }
    expect(css).toContain("--motion-fast: 150ms");
    const block = css.slice(css.indexOf("/* ---------- contextual information buttons"));
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.info-pop[\s\S]*transition: none/);
    expect(block).toMatch(/\.info-pop \{[\s\S]*position: fixed/);
    expect(block).toMatch(/\.info-pop\[data-state="closed"\] \{[\s\S]*visibility: hidden;[\s\S]*pointer-events: none/);
    // no new colour literals in the new block: everything comes from existing tokens
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

// ---------------------------------------------------------------- representative integrations
describe("representative integrations", () => {
  it("Retry still retries, and its info button only explains (English)", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <I18nProvider initial="en">
        <ErrorPanel error={new ApiError("network", "x")} baseUrl="http://test.invalid" onRetry={onRetry} />
      </I18nProvider>,
    );
    const alert = screen.getByRole("alert");
    const info = within(alert).getByRole("button", { name: en.info.retryLabel });
    await user.click(info);
    expect(onRetry).not.toHaveBeenCalled();
    expect(popoverOf(info)).toHaveTextContent(en.info.retryBody);
    await user.click(within(alert).getByRole("button", { name: en.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(info).toHaveAttribute("aria-expanded", "false");
  });

  it("is fully localised in Bangla", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider initial="bn">
        <ErrorPanel error={new ApiError("network", "x")} baseUrl="http://test.invalid" onRetry={() => {}} />
      </I18nProvider>,
    );
    const info = screen.getByRole("button", { name: bn.info.retryLabel });
    await user.click(info);
    expect(popoverOf(info)).toHaveTextContent(bn.info.retryTitle);
    expect(popoverOf(info)).toHaveTextContent(bn.info.retryBody);
  });

  it("show all / show top still expands and collapses the list; the info button changes nothing", async () => {
    const user = userEvent.setup();
    const forecasts = Array.from({ length: 15 }, (_, i) =>
      makeForecast(`DNCC_Ward_${String(i + 1).padStart(2, "0")}`, "Dhaka North", "2025-07-28", 30 - i),
    );
    render(
      <I18nProvider initial="en">
        <Overview
          request={{ status: "success", data: { mode: "historical_replay", notice: "n", issue_date: "2025-07-28", count: 15, forecasts }, error: null, reload: () => {} }}
          meta={makeMeta()}
          issueDate="2025-07-28"
          selectedWard="DNCC_Ward_12"
          onSelectWard={() => {}}
          baseUrl="http://test.invalid"
        />
      </I18nProvider>,
    );
    const table = screen.getByRole("table");
    const rows = () => within(table).getAllByRole("row").length - 1;
    expect(rows()).toBe(12);
    const info = screen.getByRole("button", { name: en.info.listLabel });
    await user.click(info);
    expect(rows()).toBe(12);
    expect(popoverOf(info)).toHaveTextContent(en.info.listBody("12"));
    const toggle = screen.getByRole("button", { name: en.showAll("15") });
    await user.click(toggle);
    expect(rows()).toBe(15);
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: en.showTop("12") }));
    expect(rows()).toBe(12);
  });
});
