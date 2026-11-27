// Weekly Outlook: activation, shared selection, the include_weekly request, companion vs equal-split
// transparency, states, translations and isolation from the Overview. FIXTURE values only.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ApiError, type ApiClient, type ForecastOptions } from "../api/client";
import type { WardForecastResponse, WeeklyForecast } from "../api/types";
import { I18nProvider } from "../i18n/I18n";
import { bn, en } from "../i18n/dict";
import { allFor, deferred, fakeClient, makeMeta, NOTICE, oneFor } from "../test/fixtures";
import { closeAllInfoPopovers, openInfoPopoverKey } from "./InfoButton";
import { WeeklyOutlook } from "./WeeklyOutlook";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

const w = en.weekly;
const DATE = "2025-07-28";
const FW = ["2025-08-11", "2025-08-18", "2025-08-25"]; // fixture forecast weeks

function weekly(values: [number, number, number], source: "companion" | "equal_split" = "companion", reason: string | null = null): WeeklyForecast {
  return {
    source,
    model_version: source === "companion" ? "weekly-test" : null,
    fallback_reason: source === "companion" ? null : reason,
    reconciled_to: "predicted_cases_3wk",
    weeks: values.map((v, i) => ({ horizon_week: i + 2, forecast_week: FW[i]!, predicted_cases: v })),
    note: "Split of predicted_cases_3wk into weeks t+2, t+3 and t+4.",
  };
}
type WardFn = (ward: string, date: string, drivers: boolean, signal?: AbortSignal, options?: ForecastOptions) => Promise<WardForecastResponse>;

/** forecastWard that answers weekly requests with `block` (or no block) and everything else like the fixtures. */
function client(block: (ward: string) => WeeklyForecast | undefined = () => weekly([9.4, 10.6, 11.2])) {
  const forecastWard = vi.fn<WardFn>((ward, date, _d, _s, options) => {
    const r = oneFor(ward, date);
    return Promise.resolve(options?.includeWeekly ? { ...r, forecast: { ...r.forecast, weekly: block(ward) } } : r);
  });
  const forecastAll = vi.fn((d: string) => Promise.resolve(allFor(d)));
  const planning = { allocation: vi.fn(), hospitalRouting: vi.fn(), interventionSimulation: vi.fn(), dispatchBrief: vi.fn(), dispatchDocument: vi.fn() };
  const c = { ...fakeClient({ forecastWard, forecastAll }), ...planning } as ApiClient;
  return { client: c, forecastWard, forecastAll, planning };
}
const weeklyCalls = (fn: ReturnType<typeof client>["forecastWard"]) => fn.mock.calls.filter((c) => c[4]?.includeWeekly === true);
const plainCalls = (fn: ReturnType<typeof client>["forecastWard"]) => fn.mock.calls.filter((c) => c[4]?.includeWeekly !== true);

async function readyApp(c = client()) {
  render(<App client={c.client} />);
  await screen.findByRole("heading", { name: "DNCC Ward 12" }, { timeout: 3000 });
  await screen.findByRole("region", { name: /All 8 wards/ });
  return c;
}
const navButton = (name: string) => within(screen.getByRole("navigation", { name: en.nav.label })).getByRole("button", { name });
async function openWeekly(user = userEvent.setup()) {
  await user.click(navButton(en.nav.weekly));
  return screen.findByRole("region", { name: w.title("DNCC Ward 12") });
}

// ---------------------------------------------------------------- navigation and the shared selection
describe("weekly outlook navigation", () => {
  it("starts on Overview; Weekly Outlook is selectable; the four other sections stay unavailable", async () => {
    await readyApp();
    expect(navButton(en.nav.overview)).toHaveAttribute("aria-current", "page");
    expect(navButton(en.nav.weekly)).not.toHaveAttribute("aria-current");
    for (const id of ["resources", "hospitals", "interventions", "dispatch"] as const) {
      const item = document.querySelector(`.section-tab-item.is-planned[data-section="${id}"]`);
      expect(item, id).toHaveTextContent(en.nav.planned);
      expect(item?.querySelector("button")).toBeNull();
    }
    await openWeekly();
    expect(navButton(en.nav.weekly)).toHaveAttribute("aria-current", "page");
    expect(navButton(en.nav.overview)).not.toHaveAttribute("aria-current");
  });

  it("shows one section at a time and never duplicates the dashboard", async () => {
    const user = userEvent.setup();
    await readyApp();
    await openWeekly(user);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: /All 8 wards/ })).toBeNull();
    expect(document.querySelector(".detail")).toBeNull();
    expect(screen.getAllByRole("form", { name: en.controlsLabel })).toHaveLength(1); // the one shared selector
    await user.click(navButton(en.nav.overview));
    expect(await screen.findByRole("region", { name: /All 8 wards/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: w.title("DNCC Ward 12") })).toBeNull();
    expect(document.querySelectorAll(".detail")).toHaveLength(1);
  });

  it("keeps city, ward, week and language across switches, and follows selection changes", async () => {
    const user = userEvent.setup();
    const c = await readyApp();
    await user.selectOptions(screen.getByLabelText("Ward"), "DNCC_Ward_13");
    await screen.findByRole("heading", { name: "DNCC Ward 13" });
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await user.click(navButton(en.nav.weekly));
    const region = await screen.findByRole("region", { name: w.title("DNCC Ward 13") });
    expect(region).toHaveTextContent(w.where("Dhaka North", "4 Aug 2025"));
    expect(weeklyCalls(c.forecastWard).at(-1)?.slice(0, 3)).toEqual(["DNCC_Ward_13", "2025-08-04", false]);
    // a change made inside Weekly Outlook updates it and is kept for Overview
    await user.selectOptions(screen.getByLabelText("Ward"), "DNCC_Ward_11");
    await screen.findByRole("region", { name: w.title("DNCC Ward 11") });
    await user.click(screen.getByRole("button", { name: en.langBnLabel }));
    expect(await screen.findByRole("region", { name: bn.weekly.title("ডিএনসিসি ওয়ার্ড ১১") })).toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation", { name: bn.nav.label })).getByRole("button", { name: bn.nav.overview }));
    expect(await screen.findByRole("heading", { name: "ডিএনসিসি ওয়ার্ড ১১" })).toBeInTheDocument();
    expect((screen.getByLabelText(bn.ward) as HTMLSelectElement).value).toBe("DNCC_Ward_11");
    expect((screen.getByLabelText(bn.week) as HTMLSelectElement).value).toBe("2025-08-04");
    expect(document.documentElement.lang).toBe("bn");
  });

  it("closes an open explanation when the section changes", async () => {
    const user = userEvent.setup();
    await readyApp();
    const region = await openWeekly(user);
    const info = within(region).getByRole("button", { name: w.sourceInfoLabel });
    await user.click(info);
    expect(openInfoPopoverKey()).not.toBeNull();
    fireEvent.click(navButton(en.nav.overview)); // no pointerdown/focus first: only the navigation can close it
    expect(openInfoPopoverKey()).toBeNull();
  });

  it("switches sections from the keyboard", async () => {
    const user = userEvent.setup();
    await readyApp();
    navButton(en.nav.weekly).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("region", { name: w.title("DNCC Ward 12") })).toBeInTheDocument();
    navButton(en.nav.overview).focus();
    await user.keyboard(" ");
    expect(await screen.findByRole("region", { name: /All 8 wards/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- requests
describe("weekly outlook requests", () => {
  it("asks for include_weekly only in Weekly Outlook and leaves the Overview requests unchanged", async () => {
    const user = userEvent.setup();
    const c = await readyApp();
    expect(weeklyCalls(c.forecastWard)).toHaveLength(0);
    const plain = plainCalls(c.forecastWard).length;
    const all = c.forecastAll.mock.calls.length;
    for (const call of c.forecastWard.mock.calls) expect(call.slice(0, 3)).toEqual(["DNCC_Ward_12", DATE, true]);
    for (const call of c.forecastAll.mock.calls) expect(call).toHaveLength(2); // (date, signal): no options
    await openWeekly(user);
    expect(weeklyCalls(c.forecastWard)).toHaveLength(1);
    const [ward, date, drivers, signal, options] = weeklyCalls(c.forecastWard)[0]!;
    expect([ward, date, drivers, options]).toEqual(["DNCC_Ward_12", DATE, false, { includeWeekly: true }]);
    expect(signal).toBeInstanceOf(AbortSignal);
    await user.click(navButton(en.nav.overview));
    await screen.findByRole("region", { name: /All 8 wards/ });
    expect(plainCalls(c.forecastWard)).toHaveLength(plain); // Overview data reused, not fetched again
    expect(c.forecastAll.mock.calls).toHaveLength(all);
  });

  it("calls no planning endpoint and makes no direct network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const c = await readyApp();
    const before = fetchSpy.mock.calls.length; // the validation panel may load its static file on the Overview
    await openWeekly();
    for (const fn of Object.values(c.planning)) expect(fn).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it("ignores a stale weekly answer and aborts the old request when the ward changes", async () => {
    const user = userEvent.setup();
    const pending = new Map<string, { d: ReturnType<typeof deferred<WardForecastResponse>>; signal?: AbortSignal }>();
    const base = client();
    base.forecastWard.mockImplementation((ward, date, _x, signal, options) => {
      if (!options?.includeWeekly) return Promise.resolve(oneFor(ward, date));
      const d = deferred<WardForecastResponse>();
      pending.set(ward, { d, signal });
      return d.promise;
    });
    await readyApp(base);
    await user.click(navButton(en.nav.weekly));
    await waitFor(() => expect(pending.has("DNCC_Ward_12")).toBe(true));
    await user.selectOptions(screen.getByLabelText("Ward"), "DNCC_Ward_13");
    await waitFor(() => expect(pending.has("DNCC_Ward_13")).toBe(true));
    expect(pending.get("DNCC_Ward_12")!.signal?.aborted).toBe(true);
    const r13 = oneFor("DNCC_Ward_13", DATE);
    pending.get("DNCC_Ward_13")!.d.resolve({ ...r13, forecast: { ...r13.forecast, weekly: weekly([3, 4, 5]) } });
    const region = await screen.findByRole("region", { name: w.title("DNCC Ward 13") });
    expect(await within(region).findByText(w.sourceCompanion)).toBeInTheDocument();
    const r12 = oneFor("DNCC_Ward_12", DATE);
    pending.get("DNCC_Ward_12")!.d.resolve({ ...r12, forecast: { ...r12.forecast, weekly: weekly([9.4, 10.6, 11.2]) } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole("region", { name: w.title("DNCC Ward 13") })).not.toHaveTextContent("10.6");
  });

  it("aborts a pending weekly request when leaving the section", async () => {
    const user = userEvent.setup();
    let seen: AbortSignal | undefined;
    const base = client();
    base.forecastWard.mockImplementation((ward, date, _x, signal, options) => {
      if (!options?.includeWeekly) return Promise.resolve(oneFor(ward, date));
      seen = signal;
      return new Promise<WardForecastResponse>(() => {});
    });
    await readyApp(base);
    await user.click(navButton(en.nav.weekly));
    await waitFor(() => expect(seen).toBeDefined());
    expect(screen.getByText(w.loading)).toBeInTheDocument();
    await user.click(navButton(en.nav.overview));
    expect(seen?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------- data, transparency and states
describe("weekly outlook content", () => {
  it("shows exactly the three backend weeks, their values and the combined total", async () => {
    await readyApp();
    const region = await openWeekly();
    const list = await within(region).findByRole("list", { name: w.listLabel });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.querySelector(".weekly-week-label")?.textContent)).toEqual(["Week +2", "Week +3", "Week +4"]);
    expect(items.map((li) => li.querySelector(".weekly-week-date")?.textContent)).toEqual(["Week of 11 Aug 2025", "Week of 18 Aug 2025", "Week of 25 Aug 2025"]);
    expect(items.map((li) => li.querySelector(".weekly-week-num")?.textContent)).toEqual([
      "9.4 predicted cases",
      "10.6 predicted cases",
      "11.2 predicted cases",
    ]);
    expect(region.querySelector(".weekly-total")).toHaveTextContent(`${w.totalLabel}31.2 predicted cases`);
    expect(region.querySelector(".weekly-note")).toBeNull(); // 9.4 + 10.6 + 11.2 = 31.2 exactly
    // bars are decoration only, sized from the real values
    const fills = Array.from(region.querySelectorAll<HTMLElement>(".weekly-bar-fill")).map((e) => e.style.width);
    expect(fills[2]).toBe("100%");
    expect(parseFloat(fills[0]!)).toBeCloseTo((9.4 / 11.2) * 100, 5);
    for (const bar of Array.from(region.querySelectorAll(".weekly-bar"))) expect(bar).toHaveAttribute("aria-hidden", "true");
  });

  it("labels the companion model output", async () => {
    await readyApp();
    const region = await openWeekly();
    const source = await within(region).findByRole("heading", { name: w.sourceTitle });
    const box = source.closest(".weekly-source")!;
    expect(box).toHaveTextContent(w.sourceCompanion);
    expect(box).toHaveTextContent(w.companionBody);
    expect(box).not.toHaveTextContent(w.sourceEqual);
    expect(box).not.toHaveTextContent(w.reasonLabel);
  });

  it("labels the equal-split fallback with a plain-language reason and never calls it a weekly model", async () => {
    await readyApp(client(() => weekly([10.4, 10.4, 10.4], "equal_split", "companion_inference_failed")));
    const region = await openWeekly();
    const box = (await within(region).findByRole("heading", { name: w.sourceTitle })).closest(".weekly-source")!;
    expect(box).toHaveTextContent(w.sourceEqual);
    expect(box).toHaveTextContent(w.equalBody);
    expect(box).toHaveTextContent(`${w.reasonLabel} ${w.reasonFailed}`);
    expect(box).not.toHaveTextContent(w.sourceCompanion);
    expect(box).not.toHaveTextContent("companion_inference_failed"); // raw codes are never shown
  });

  it("maps every known fallback reason, and an unknown one to a neutral sentence", async () => {
    for (const [code, text] of [
      ["companion_not_loaded", w.reasonNotLoaded],
      ["companion_unavailable", w.reasonUnavailable],
      ["something_new", w.reasonOther],
    ] as const) {
      const { unmount } = render(
        <I18nProvider initial="en">
          <WeeklyOutlook client={client(() => weekly([10.4, 10.4, 10.4], "equal_split", code)).client} meta={makeMeta()} selection={{ city: "Dhaka North", ward: "DNCC_Ward_12", date: DATE }} />
        </I18nProvider>,
      );
      expect(await screen.findByText(`${w.reasonLabel} ${text}`)).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(code))).toBeNull();
      unmount();
    }
  });

  it("explains a visible rounding difference instead of hiding it", async () => {
    await readyApp(client(() => weekly([10.44, 10.44, 10.32])));
    const region = await openWeekly();
    expect(await within(region).findByText(w.roundingNote)).toBeInTheDocument();
  });

  it("says so when the weekly block is missing, with no invented numbers", async () => {
    await readyApp(client(() => undefined));
    const region = await openWeekly();
    expect(await within(region).findByText(w.missingTitle)).toBeInTheDocument();
    expect(within(region).queryByRole("list", { name: w.listLabel })).toBeNull();
    expect(region.querySelector(".weekly-total")).toBeNull();
  });

  it("shows loading, then an error with an independent Retry that repeats only the weekly request", async () => {
    const user = userEvent.setup();
    const base = client();
    const d = deferred<WardForecastResponse>();
    let attempt = 0;
    base.forecastWard.mockImplementation((ward, date, _x, _s, options) => {
      if (!options?.includeWeekly) return Promise.resolve(oneFor(ward, date));
      attempt += 1;
      if (attempt === 1) return d.promise;
      const r = oneFor(ward, date);
      return Promise.resolve({ ...r, forecast: { ...r.forecast, weekly: weekly([9.4, 10.6, 11.2]) } });
    });
    await readyApp(base);
    await user.click(navButton(en.nav.weekly));
    const region = await screen.findByRole("region", { name: w.title("DNCC Ward 12") });
    expect(within(region).getByText(w.loading)).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-busy", "true");
    d.reject(new ApiError("timeout", "slow"));
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(en.errTimeout);
    const plain = plainCalls(base.forecastWard).length;
    const all = base.forecastAll.mock.calls.length;
    const info = within(alert).getByRole("button", { name: en.info.retryLabel });
    await user.click(info);
    expect(attempt).toBe(1); // explaining does not retry
    await user.click(within(alert).getByRole("button", { name: en.retry }));
    expect(await within(region).findByRole("list", { name: w.listLabel })).toBeInTheDocument();
    expect(attempt).toBe(2);
    expect(plainCalls(base.forecastWard)).toHaveLength(plain);
    expect(base.forecastAll.mock.calls).toHaveLength(all);
  });

  it("shows a shape error from the typed client as an error, not as data", async () => {
    const base = client();
    base.forecastWard.mockImplementation((ward, date, _x, _s, options) =>
      options?.includeWeekly ? Promise.reject(new ApiError("shape", "x")) : Promise.resolve(oneFor(ward, date)),
    );
    await readyApp(base);
    const region = await openWeekly();
    expect(await within(region).findByRole("alert")).toHaveTextContent(en.errShape);
    expect(within(region).queryByRole("list", { name: w.listLabel })).toBeNull();
  });

  it("shows an empty state without a ward or issue week, and makes no request", () => {
    const c = client();
    const { unmount } = render(
      <I18nProvider initial="en">
        <WeeklyOutlook client={c.client} meta={makeMeta()} selection={{ city: "Dhaka North", ward: "", date: DATE }} />
      </I18nProvider>,
    );
    expect(screen.getByText(w.noWardTitle)).toBeInTheDocument();
    unmount();
    render(
      <I18nProvider initial="en">
        <WeeklyOutlook client={c.client} meta={makeMeta()} selection={{ city: "Dhaka North", ward: "DNCC_Ward_12", date: "" }} />
      </I18nProvider>,
    );
    expect(screen.getByText(w.noWeekTitle)).toBeInTheDocument();
    expect(c.forecastWard).not.toHaveBeenCalled();
  });

  it("keeps the historical-replay framing and makes no live or official claims", async () => {
    await readyApp();
    const region = await openWeekly();
    await within(region).findByRole("list", { name: w.listLabel });
    expect(region.querySelector(".weekly-replay")).toHaveTextContent(`${en.notLive} ${NOTICE} ${w.replay}`);
    expect(region.textContent).not.toMatch(/real-time|confirmed case|official alert|live surveillance|verified outbreak/i);
  });

  it("has no nested buttons and no duplicate ids", async () => {
    await readyApp();
    const region = await openWeekly();
    await within(region).findByRole("list", { name: w.listLabel });
    expect(document.querySelector("button button, button a, a button, label button")).toBeNull();
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------- Bangla, styles
describe("weekly outlook translations and styles", () => {
  it("has identical keys in English and Bangla, with real Bangla text", () => {
    expect(Object.keys(bn.weekly).sort()).toEqual(Object.keys(en.weekly).sort());
    for (const [k, v] of Object.entries(bn.weekly)) {
      const text = typeof v === "function" ? (v as (a: string, b: string) => string)("১", "২") : v;
      expect(/[ঀ-৿]/.test(text), k).toBe(true);
    }
  });

  it("renders in Bangla with Bangla digits and dates", async () => {
    const user = userEvent.setup();
    await readyApp(client(() => weekly([10.4, 10.4, 10.4], "equal_split", "companion_not_loaded")));
    await user.click(screen.getByRole("button", { name: en.langBnLabel }));
    await user.click(within(screen.getByRole("navigation", { name: bn.nav.label })).getByRole("button", { name: bn.nav.weekly }));
    const region = await screen.findByRole("region", { name: bn.weekly.title("ডিএনসিসি ওয়ার্ড ১২") });
    await within(region).findByRole("list", { name: bn.weekly.listLabel });
    expect(region.querySelector(".weekly-total")).toHaveTextContent("৩১.২");
    expect(region).toHaveTextContent(bn.weekly.weekLabel("২"));
    expect(region).toHaveTextContent(bn.weekly.weekOf("১১ আগস্ট ২০২৫"));
    expect(region).toHaveTextContent(bn.weekly.sourceEqual);
    expect(region).toHaveTextContent(`${bn.weekly.reasonLabel} ${bn.weekly.reasonNotLoaded}`);
    expect(region.querySelector(".weekly-replay")).toHaveTextContent(bn.notice);
  });

  it("uses existing tokens only, wraps the weeks on narrow screens and adds no motion", async () => {
    const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { readFileSync(path: string, encoding: "utf8"): string };
    const css = fs.readFileSync("src/styles.css", "utf8");
    const block = css.slice(css.indexOf("/* ---------- weekly outlook"));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|gradient|box-shadow/);
    expect(block).not.toMatch(/transition|animation/); // nothing moves, so reduced motion needs no override
    expect(block).toMatch(/\.weekly-weeks \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 13rem\), 1fr\)\)/);
    expect(block).toMatch(/\.weekly \{[^}]*min-width: 0;/);
    for (const token of ["--paper: #eff3ee", "--surface: #fafcf9", "--teal: #0e4f54", "--aqua: #78c9c2", "--aqua-soft: #d6ece8", "--focus: #0a6a75"]) {
      expect(css).toContain(token);
    }
  });
});
