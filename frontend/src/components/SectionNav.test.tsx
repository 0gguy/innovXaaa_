// Section navigation (hybrid tabs foundation): semantics, availability, keyboard, translations, dashboard
// preservation and the hand-off to the shared info-popover state.
// NOTE: jsdom does no layout. Horizontal scrolling and "no page overflow" are only checked here as CSS rules;
// the real geometry needs a browser check.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ApiError, DEFAULT_BASE_URL, createClient } from "../api/client";
import { I18nProvider } from "../i18n/I18n";
import { bn, en } from "../i18n/dict";
import { allFor, fakeClient, makeMeta, oneFor } from "../test/fixtures";
import { closeAllInfoPopovers } from "./InfoButton";
import { isSectionAvailable, SECTIONS, SectionNav, type SectionId } from "./SectionNav";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

const DEFAULT_DATE = "2025-07-28";
const ALL: SectionId[] = ["overview", "weekly", "resources", "hospitals", "interventions", "dispatch"];

function renderNav(onSelect: (id: SectionId) => void = () => {}, lang: "en" | "bn" = "en") {
  return render(
    <I18nProvider initial={lang}>
      <SectionNav current="overview" onSelect={onSelect} />
    </I18nProvider>,
  );
}
const nav = () => screen.getByRole("navigation", { name: en.nav.label });
const navButton = (id: SectionId) => within(nav()).getByRole("button", { name: en.nav[id] });

function counted() {
  const meta = vi.fn(() => Promise.resolve(makeMeta()));
  const forecastWard = vi.fn((w: string, d: string) => Promise.resolve(oneFor(w, d)));
  const forecastAll = vi.fn((d: string) => Promise.resolve(allFor(d)));
  return { client: fakeClient({ meta, forecastWard, forecastAll }), meta, forecastWard, forecastAll };
}
async function readyApp() {
  const c = counted();
  render(<App client={c.client} />);
  await screen.findByRole("heading", { name: "DNCC Ward 12" }, { timeout: 3000 });
  await screen.findByRole("region", { name: /All 8 wards/ });
  return c;
}
async function readStyles(): Promise<string> {
  const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { readFileSync(path: string, encoding: "utf8"): string };
  return fs.readFileSync("src/styles.css", "utf8");
}

// ---------------------------------------------------------------- structure and availability
describe("section navigation structure", () => {
  it("lists all six sections in order, all available, with Overview current", () => {
    renderNav();
    const items = within(nav()).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".section-tab, .section-tab-label")?.textContent)).toEqual(ALL.map((id) => en.nav[id]));
    expect(SECTIONS.filter((s) => s.available).map((s) => s.id)).toEqual(ALL);
    for (const id of ALL) {
      expect(isSectionAvailable(id)).toBe(true);
      const b = navButton(id);
      expect(b).toHaveAttribute("type", "button");
      if (id === "overview") expect(b).toHaveAttribute("aria-current", "page");
      else expect(b).not.toHaveAttribute("aria-current");
    }
  });

  it("leaves no section marked as not yet available", () => {
    renderNav();
    expect(document.querySelector(".section-tab-item.is-planned")).toBeNull();
    expect(within(nav()).queryAllByText(en.nav.planned)).toHaveLength(0);
  });

  it("exposes exactly six enabled buttons and no links or disabled stand-ins", () => {
    renderNav();
    expect(within(nav()).getAllByRole("button")).toHaveLength(6);
    expect(within(nav()).queryAllByRole("link")).toHaveLength(0);
    expect(nav().querySelector("[disabled], [aria-disabled]")).toBeNull();
  });

  it("does not claim tab semantics it does not implement", () => {
    renderNav();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("shows no data in the strip itself: no numbers, tables, charts or progress", () => {
    renderNav();
    const n = nav();
    expect(n.querySelector("table, svg, img, canvas, progress, [role='status'], [role='progressbar'], [aria-busy]")).toBeNull();
    expect(n.textContent).not.toMatch(/[0-9০-৯]/);
  });

  it("drops the planned-sections disclosure once every section works", () => {
    renderNav();
    expect(nav().querySelector("details")).toBeNull();
    expect(within(nav()).queryByText(en.nav.plansSummary)).toBeNull();
  });

  it("has no nested buttons and gives every control a name", () => {
    renderNav();
    expect(nav().querySelector("button button, button a, a button, summary button")).toBeNull();
    for (const b of within(nav()).getAllByRole("button")) {
      expect(b).toHaveAccessibleName();
      expect(b).toBeEnabled();
    }
  });
});

// ---------------------------------------------------------------- keyboard and activation
describe("section navigation keyboard and activation", () => {
  it("reaches every section with Tab and activates them natively with Enter and Space", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderNav(onSelect);
    await user.tab();
    expect(navButton("overview")).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith("overview");
    for (const id of ALL.slice(1)) {
      await user.tab();
      expect(navButton(id)).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(onSelect).toHaveBeenLastCalledWith(id);
    }
    await user.tab();
    expect(document.body).toHaveFocus(); // nothing traps focus inside the strip
  });

  it("never submits a surrounding form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <I18nProvider initial="en">
        <form aria-label="Wrapper" onSubmit={onSubmit}>
          <SectionNav current="overview" onSelect={() => {}} />
        </form>
      </I18nProvider>,
    );
    for (const id of ALL) await user.click(screen.getByRole("button", { name: en.nav[id] }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("styles a visible, unclipped focus ring and supports reduced motion", async () => {
    const css = await readStyles();
    const block = css.slice(css.indexOf("/* ---------- section navigation"));
    expect(block).toMatch(/\.section-tab:focus-visible \{[^}]*outline: 3px solid var\(--focus\)/);
    expect(block).toMatch(/\.section-tab:focus-visible \{[^}]*outline-offset: -3px/);
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.section-tab \{\s*transition: none/);
    expect(block).toMatch(/transition:[\s\S]*var\(--motion-fast\) var\(--ease-standard\)/);
  });

  it("scrolls only the strip sideways on narrow screens and adds no new colours", async () => {
    const css = await readStyles();
    const block = css.slice(css.indexOf("/* ---------- section navigation"));
    expect(block).toMatch(/\.section-tabs \{[^}]*overflow-x: auto;[^}]*\}/);
    expect(block).toMatch(/\.section-tabs \{[^}]*min-width: 0;/);
    // the strip is the containing block of its absolutely positioned .sr-only separators; without this they
    // escape the strip's clipping and widen the whole page on phones (found in the real-browser check)
    expect(block).toMatch(/\.section-tabs \{[^}]*position: relative;/);
    expect(block).toMatch(/\.section-nav-inner \{[^}]*min-width: 0;/);
    expect(block).toMatch(/\.section-tab-item \{[^}]*flex: none;/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(block).not.toMatch(/gradient|box-shadow|position: fixed|position: sticky/);
    // existing palette values are untouched
    for (const token of ["--paper: #eff3ee", "--surface: #fafcf9", "--ink: #12302f", "--ink-2: #3d5857", "--ink-3: #536b69", "--teal: #0e4f54", "--teal-2: #145f65", "--aqua: #78c9c2", "--aqua-soft: #d6ece8", "--focus: #0a6a75"]) {
      expect(css).toContain(token);
    }
  });
});

// ---------------------------------------------------------------- translations
describe("section navigation translations", () => {
  it("is fully translated into Bangla with matching keys", () => {
    expect(Object.keys(bn.nav).sort()).toEqual(Object.keys(en.nav).sort());
    for (const [k, v] of Object.entries(bn.nav)) expect(/[ঀ-৿]/.test(v), k).toBe(true);
    renderNav(() => {}, "bn");
    const n = screen.getByRole("navigation", { name: bn.nav.label });
    expect(within(n).getAllByRole("button").map((b) => b.textContent)).toEqual(ALL.map((id) => bn.nav[id]));
    expect(within(n).getByRole("button", { name: bn.nav.overview })).toHaveAttribute("aria-current", "page");
  });

  it("switches language with the existing language buttons without losing the current section", async () => {
    const user = userEvent.setup();
    await readyApp();
    await user.click(screen.getByRole("button", { name: en.langBnLabel }));
    const n = await screen.findByRole("navigation", { name: bn.nav.label });
    expect(within(n).getByRole("button", { name: bn.nav.overview })).toHaveAttribute("aria-current", "page");
    expect(within(n).getAllByRole("button")).toHaveLength(6);
  });
});

// ---------------------------------------------------------------- inside the real dashboard
describe("section navigation in the dashboard", () => {
  it("sits between the masthead and main, outside main, so the skip link still lands on the forecasts", async () => {
    await readyApp();
    const n = nav();
    const header = document.querySelector("header.masthead")!;
    const main = screen.getByRole("main");
    expect(header.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(n.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.contains(n)).toBe(false);
    expect(screen.getByRole("link", { name: en.skip })).toHaveAttribute("href", "#main");
  });

  it("renders the dashboard exactly once, before and after navigating, without new requests", async () => {
    const user = userEvent.setup();
    const c = await readyApp();
    const counts = () => [c.meta.mock.calls.length, c.forecastWard.mock.calls.length, c.forecastAll.mock.calls.length];
    const trees = () => [
      screen.getAllByRole("navigation").length,
      screen.getAllByRole("main").length,
      document.querySelectorAll(".controls").length,
      document.querySelectorAll(".detail").length,
      screen.getAllByRole("region", { name: /All 8 wards/ }).length,
      screen.getAllByRole("table").length,
    ];
    expect(trees()).toEqual([1, 1, 1, 1, 1, 1]);
    const before = counts();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const detailEl = document.querySelector(".detail");
    await user.click(screen.getByRole("button", { name: en.nav.overview }));
    await user.click(screen.getByRole("button", { name: en.nav.overview })); // choosing the current section again changes nothing
    expect(trees()).toEqual([1, 1, 1, 1, 1, 1]);
    expect(counts()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector(".detail")).toBe(detailEl); // same element: nothing remounted
    expect(screen.getByRole("button", { name: en.nav.overview })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the existing API defaults", () => {
    expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:8000");
    expect(createClient().baseUrl).toBe("http://127.0.0.1:8000");
  });

  it("leaves the dashboard actions working after navigation", async () => {
    const user = userEvent.setup();
    const c = await readyApp();
    await user.click(screen.getByRole("button", { name: en.nav.overview }));
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(c.forecastAll).toHaveBeenLastCalledWith("2025-08-04", expect.anything()));
    expect(c.forecastWard).toHaveBeenLastCalledWith("DNCC_Ward_12", "2025-08-04", true, expect.anything());
    await user.selectOptions(screen.getByLabelText("Ward"), "DNCC_Ward_11");
    expect(await screen.findByRole("heading", { name: "DNCC Ward 11" })).toBeInTheDocument();
  });

  it("stays consistent under rapid switching and never re-requests the Overview forecasts", async () => {
    const c = await readyApp();
    const before = c.forecastAll.mock.calls.length;
    const overview = screen.getByRole("button", { name: en.nav.overview });
    for (let i = 0; i < 25; i++) {
      fireEvent.click(overview);
      fireEvent.click(navButton(ALL[i % ALL.length]!));
    }
    expect(overview).toHaveAttribute("aria-current", "page");
    expect(nav().querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(c.forecastAll.mock.calls.length).toBe(before);
    expect(c.forecastAll).toHaveBeenLastCalledWith(DEFAULT_DATE, expect.anything());
  });
});

// ---------------------------------------------------------------- shared info-popover state
describe("section navigation and information popovers", () => {
  it("closes an open explanation when a section is chosen, and Retry and its info button keep working", async () => {
    const user = userEvent.setup();
    const meta = vi.fn().mockRejectedValueOnce(new ApiError("network", "x")).mockResolvedValue(makeMeta());
    render(<App client={fakeClient({ meta })} />);
    const alert = await screen.findByRole("alert");
    const info = within(alert).getByRole("button", { name: en.info.retryLabel });
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    // fireEvent: no pointerdown/focus first, so only the navigation's own closeAllInfoPopovers() can close it
    fireEvent.click(screen.getByRole("button", { name: en.nav.overview }));
    expect(info).toHaveAttribute("aria-expanded", "false");
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    await user.click(within(alert).getByRole("button", { name: en.retry }));
    expect(await screen.findByRole("heading", { name: "DNCC Ward 12" })).toBeInTheDocument();
    expect(meta).toHaveBeenCalledTimes(2);
  });

  it("an open explanation also closes on an outside press, with the dashboard unchanged", async () => {
    const user = userEvent.setup();
    const forecastWard = vi.fn(() => Promise.reject(new ApiError("network", "x")));
    const forecastAll = vi.fn((d: string) => Promise.resolve(allFor(d)));
    render(<App client={fakeClient({ forecastWard, forecastAll })} />);
    const region = await screen.findByRole("region", { name: "Ward forecast" });
    const info = await within(region).findByRole("button", { name: en.info.retryLabel });
    await screen.findByRole("region", { name: /All 8 wards/ });
    const calls = [forecastWard.mock.calls.length, forecastAll.mock.calls.length];
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("heading", { level: 1 })); // outside press: the F2A dismissal closes it
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: en.nav.overview })).toHaveAttribute("aria-current", "page");
    expect([forecastWard.mock.calls.length, forecastAll.mock.calls.length]).toEqual(calls);
    expect(within(region).getByRole("alert")).toBeInTheDocument(); // the dashboard state is untouched
  });
});
