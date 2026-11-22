import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { ApiError } from "./api/client";
import { niceAxis, parseValidation } from "./components/ValidationDashboard";
import { bn, en } from "./i18n/dict";
import { bnDigits, makeFormatters } from "./i18n/I18n";
import { allFor, fakeClient, makeMeta, oneFor } from "./test/fixtures";

const DATE = "2025-07-28";

async function ready() {
  const client = fakeClient();
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "DNCC Ward 12" });
  return client;
}

async function toBangla() {
  await userEvent.click(screen.getByRole("button", { name: /বাংলায় দেখুন/ }));
}

/** drivers whose groups really add up to the model output (baseline 9.5 + 22.9 - 1.2 = 31.2) */
const CONSISTENT = {
  baseline: 9.5,
  groups: [
    { group: "Recent dengue cases", contribution: 20 },
    { group: "Humidity", contribution: 2.9 },
    { group: "Rainfall (previous 1-4 weeks)", contribution: -1.2 },
  ],
  note: "Additive model attributions (XGBoost TreeSHAP) of the raw model output; they describe how the model reached its number, not causes of dengue.",
};

describe("ward forecast card (English)", () => {
  it("leads with ward, period, estimate, tier and alert", async () => {
    await ready();
    const detail = screen.getByRole("region", { name: "DNCC Ward 12" });
    expect(detail.querySelector(".result-num")).toHaveTextContent("31.2");
    expect(detail.querySelector(".result-weeks")).toHaveTextContent("Weeks beginning 11 Aug, 18 Aug and 25 Aug");
    expect(detail.querySelector(".detail-where")).toHaveTextContent("Dhaka North, issue week of 28 Jul 2025");
    expect(detail.querySelector(".result-sub")).toHaveTextContent("one combined total for weeks +2 to +4");
    const ruler = within(detail).getByRole("list", { name: "Risk tier" });
    const current = ruler.querySelector('[aria-current="true"]');
    expect(current).toHaveTextContent("Critical");
    expect(current).toHaveTextContent("30.5 or more");
    expect(within(detail).getByText("Raised")).toBeInTheDocument();
  });

  it("keeps the tier boundaries visible: Low <4.5, Medium 4.5-14.5, High 14.5-30.5, Critical >=30.5", async () => {
    await ready();
    const ruler = within(screen.getByRole("region", { name: "DNCC Ward 12" })).getByRole("list", { name: "Risk tier" });
    expect(ruler).toHaveTextContent("under 4.5");
    expect(ruler).toHaveTextContent("4.5 to under 14.5");
    expect(ruler).toHaveTextContent("14.5 to under 30.5");
    expect(ruler).toHaveTextContent("30.5 or more");
  });

  it("shows the recorded outcome as a separate, historical comparison with the difference", async () => {
    await ready();
    const obs = screen.getByRole("heading", { name: "Observed later (historical comparison)" }).parentElement!;
    const cols = obs.querySelectorAll(".compare-col");
    expect(cols).toHaveLength(2);
    expect(cols[0]).toHaveTextContent("Model estimate");
    expect(cols[0]).toHaveTextContent("31.2");
    expect(cols[1]).toHaveTextContent("Recorded later");
    expect(cols[1]).toHaveTextContent("33");
    expect(cols[1]).toHaveTextContent("historical comparison only");
    expect(obs).toHaveTextContent("The estimate was 1.8 cases below what was later recorded.");
    expect(obs).toHaveTextContent("not an input to the forecast");
  });

  it("describes an over-estimate the other way round", async () => {
    const client = fakeClient({
      forecastWard: (w, d) =>
        Promise.resolve(oneFor(w, d, { actual: { available: true, actual_cases_3wk: 29, actual_risk_tier: "High", note: "n" } })),
    });
    render(<App client={client} />);
    const h = await screen.findByRole("heading", { name: "Observed later (historical comparison)" });
    expect(h.parentElement).toHaveTextContent("The estimate was 2.2 cases above what was later recorded.");
  });

  it("splits model contributions into raised and lowered, keeping signs and values", async () => {
    await ready();
    const up = screen.getByRole("region", { name: "Pushed the estimate up" });
    const down = screen.getByRole("region", { name: "Pulled the estimate down" });
    expect(within(up).getByText("Recent dengue cases")).toBeInTheDocument();
    expect(up).toHaveTextContent("+12.3");
    expect(up).toHaveTextContent("+1.1");
    expect(within(down).getByText("Rainfall, previous 1 to 4 weeks")).toBeInTheDocument();
    expect(down).toHaveTextContent("−3.4");
    expect(up).not.toHaveTextContent("−");
    expect(down).not.toHaveTextContent("+");
    // largest first
    const names = Array.from(up.querySelectorAll(".driver-name")).map((n) => n.textContent);
    expect(names).toEqual(["Recent dengue cases", "Humidity"]);
  });

  it("shows the arithmetic only when the contributions really add up to the estimate", async () => {
    const consistent = fakeClient({ forecastWard: (w, d) => Promise.resolve(oneFor(w, d, { drivers: CONSISTENT })) });
    const { unmount } = render(<App client={consistent} />);
    expect(await screen.findByText(/Starting level 9\.5 \+ raised 22\.9 − lowered 1\.2 = estimate 31\.2/)).toBeInTheDocument();
    unmount();
    await ready(); // default fixture does not add up, so no equation is invented
    expect(screen.queryByText(/Starting level/)).not.toBeInTheDocument();
  });

  it("never presents attributions as proven causes and explains them in plain words", async () => {
    await ready();
    const drivers = screen.getByRole("heading", { name: "What shaped this estimate" }).parentElement!;
    expect(drivers).toHaveTextContent("They are not proof that rain, heat or any other factor causes dengue");
    expect(drivers).toHaveTextContent("TreeSHAP");
    expect(drivers).toHaveTextContent("Cases recorded in this ward in the 1 to 4 weeks before the issue week.");
    expect(drivers.textContent).not.toMatch(/\bcauses? (?:a |the )?(?:rise|increase|outbreak)/i);
    // technical detail is available but collapsed by default
    const tech = drivers.querySelector("details")!;
    expect(tech.open).toBe(false);
    await userEvent.click(within(drivers).getByText("Technical detail"));
    expect(tech.open).toBe(true);
    expect(tech).toHaveTextContent("TreeSHAP contributions of eight input groups");
  });

  it("keeps the forecast a single combined total", async () => {
    await ready();
    expect(screen.getAllByText(/One combined total for weeks \+2 to \+4, not three separate weekly forecasts/)).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Forecast window" }).querySelectorAll(".in-window")).toHaveLength(3);
  });
});

describe("ward register: five city bar charts", () => {
  const groups: Record<string, string[]> = {
    Chattogram: ["CCC Ward 01", "CCC Ward 02"],
    "Dhaka North": ["DNCC Ward 11", "DNCC Ward 12", "DNCC Ward 13"],
    "Dhaka South": ["DSCC Ward 01"],
    Gazipur: ["GCC Ward 01"],
    Narayanganj: ["NCC Ward 01"],
  };
  const bar = (id: string) => document.querySelector(`.bar-btn[aria-label^="${id},"] .bar-col`) as HTMLElement;

  it("draws one chart per city with exactly one bar per ward, none omitted", async () => {
    await ready();
    expect(document.querySelectorAll(".register-group")).toHaveLength(5);
    let total = 0;
    for (const [city, wards] of Object.entries(groups)) {
      const chart = screen.getByRole("group", {
        name: new RegExp(`^${city}: predicted dengue cases for ${wards.length} wards, issue week of 28 Jul 2025`),
      });
      const bars = chart.querySelectorAll(".bar-btn");
      expect(bars).toHaveLength(wards.length);
      expect(Array.from(bars).map((b) => b.getAttribute("aria-label")?.split(",")[0])).toEqual(wards);
      total += bars.length;
    }
    expect(total).toBe(8);
  });

  it("uses the same Y scale in every chart and the unrounded forecast for bar height", async () => {
    await ready();
    const ticks = Array.from(document.querySelectorAll(".chart-y")).map((c) => c.textContent);
    expect(ticks).toHaveLength(5);
    expect(new Set(ticks).size).toBe(1);
    expect(ticks[0]).toBe("01020304025"); // axis 0..40 plus the bold 25 alert-line marker
    expect(bar("NCC Ward 01").style.height).toBe("100%");
    expect(bar("DNCC Ward 12").style.height).toBe(`${(31.2 / 40) * 100}%`);
    expect(bar("CCC Ward 01").style.height).toBe(`${(2.2 / 40) * 100}%`);
  });

  it("colours each bar by its API risk tier and flags early alerts with a bell", async () => {
    await ready();
    expect(bar("CCC Ward 01").dataset.tier).toBe("Low");
    expect(bar("CCC Ward 02").dataset.tier).toBe("Medium");
    expect(bar("DNCC Ward 11").dataset.tier).toBe("High");
    expect(bar("DNCC Ward 12").dataset.tier).toBe("Critical");
    expect(bar("DNCC Ward 13").dataset.tier).toBe("High"); // alert raised but still High
    const flagged = Array.from(document.querySelectorAll(".bar-btn.has-alert")).map((b) => b.getAttribute("aria-label")?.split(",")[0]);
    expect(flagged).toEqual(["DNCC Ward 12", "DNCC Ward 13", "NCC Ward 01"]);
    expect(document.querySelectorAll(".bar-flag svg")).toHaveLength(3);
  });

  it("keeps the exact value for height and the backend tier, rounding only the printed label", async () => {
    const edge = fakeClient({
      forecastAll: (d) => {
        const r = allFor(d);
        const forecasts = r.forecasts.map((f) =>
          f.ward_id === "CCC_Ward_01" ? { ...f, predicted_cases_3wk: 30.46, risk_tier: "High" as const, early_alert: true } : f,
        );
        return Promise.resolve({ ...r, forecasts });
      },
    });
    render(<App client={edge} />);
    await screen.findByRole("heading", { name: "DNCC Ward 12" });
    await waitFor(() => expect(bar("CCC Ward 01")?.dataset.tier).toBe("High"));
    expect(bar("CCC Ward 01").style.height).toBe(`${(30.46 / 40) * 100}%`);
    expect(bar("CCC Ward 01")).toHaveTextContent("30.5");
  });

  it("shows tooltip content (ward, cases, tier, alert) and a full accessible name per bar", async () => {
    await ready();
    const btn = document.querySelector('.bar-btn[aria-label^="NCC Ward 01,"]')!;
    const tip = btn.querySelector(".tip")!;
    expect(tip).toHaveTextContent("NCC Ward 01");
    expect(tip).toHaveTextContent("40.0 predicted dengue cases");
    expect(tip).toHaveTextContent("Risk tier: Critical");
    expect(tip).toHaveTextContent("Early alert: raised");
    expect(btn.getAttribute("aria-label")).toBe(
      "NCC Ward 01, Critical tier, 40.0 predicted cases, early alert raised. Select to open this ward's forecast.",
    );
    expect(document.querySelector('.bar-btn[aria-label^="GCC Ward 01,"] .tip')).toHaveTextContent("Early alert: not raised");
  });

  it("labels axes, shows the issue week and legend, and says it is not a map", async () => {
    await ready();
    expect(screen.getByText("Ward forecasts by city")).toBeInTheDocument();
    expect(document.querySelectorAll(".y-caption")).toHaveLength(5);
    expect(screen.getAllByText("Ward", { selector: ".x-title" })).toHaveLength(5);
    expect(screen.getByText(/issue week of 28 Jul 2025, weeks \+2 to \+4 combined/)).toBeInTheDocument();
    expect(screen.getByText(/This is not a map/)).toBeInTheDocument();
    const legend = screen.getByRole("group", { name: "Risk tier colours" });
    for (const tier of ["Low", "Medium", "High", "Critical"]) expect(legend).toHaveTextContent(tier);
    expect(legend).toHaveTextContent("30.5 or more");
    expect(legend).toHaveTextContent("Dashed line: early-alert line at 25 cases");
  });

  it("clicking a bar selects the ward and marks it without relying on colour", async () => {
    await ready();
    const chart = screen.getByRole("group", { name: /^Chattogram:/ });
    await userEvent.click(within(chart).getAllByRole("button")[1]!);
    expect(await screen.findByRole("heading", { name: "CCC Ward 02" })).toBeInTheDocument();
    expect((screen.getByLabelText("City corporation") as HTMLSelectElement).value).toBe("Chattogram");
    expect((screen.getByLabelText("Ward") as HTMLSelectElement).value).toBe("CCC_Ward_02");
    const sel = document.querySelectorAll(".bar-btn.is-selected");
    expect(sel).toHaveLength(1);
    expect(sel[0]).toHaveAttribute("aria-pressed", "true");
    expect(sel[0]!.querySelector(".bar-label")).toHaveTextContent("02");
  });

  it("is operable by keyboard", async () => {
    await ready();
    (document.querySelector('.bar-btn[aria-label^="CCC Ward 02,"]') as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "CCC Ward 02" })).toBeInTheDocument();
  });

  it("keeps the searchable, sortable ward list below the charts", async () => {
    await ready();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByLabelText("Search wards")).toBeInTheDocument();
    expect(screen.getByLabelText("Order by")).toBeInTheDocument();
  });

  it("translates the charts and keeps the selection when the language changes", async () => {
    await ready();
    await toBangla();
    expect(screen.getByRole("group", { name: /^নারায়ণগঞ্জ: ১টি ওয়ার্ডের অনুমিত ডেঙ্গু রোগী/ })).toBeInTheDocument();
    expect(screen.getByText("শহরভিত্তিক ওয়ার্ড পূর্বাভাস")).toBeInTheDocument();
    expect(screen.getAllByText("অনুমিত ডেঙ্গু রোগী", { selector: ".y-caption strong" })).toHaveLength(5);
    expect(screen.getAllByText("ওয়ার্ড", { selector: ".x-title" })).toHaveLength(5);
    const btn = document.querySelector(".bar-btn.is-selected")!;
    expect(btn.getAttribute("aria-label")).toContain("ডিএনসিসি ওয়ার্ড ১২");
    expect(btn.querySelector(".tip")).toHaveTextContent("অনুমিত ডেঙ্গু রোগী ৩১.২");
    expect(btn.querySelector(".tip")).toHaveTextContent("ঝুঁকির স্তর: সংকটপূর্ণ (Critical)");
    expect(btn.querySelector(".tip")).toHaveTextContent("আগাম সতর্কতা: জারি হয়েছে");
    expect(btn.querySelector(".bar-label")).toHaveTextContent("১২");
    expect(screen.getByRole("group", { name: "ঝুঁকির স্তরের রং" })).toBeInTheDocument();
    expect((screen.getByLabelText("ওয়ার্ড") as HTMLSelectElement).value).toBe("DNCC_Ward_12");
  });
});

describe("methodology", () => {
  it("is split into four labelled blocks and keeps the science and the limits visible", async () => {
    await ready();
    const m = screen.getByRole("region", { name: "How this forecast works, and what it can't tell you" });
    for (const name of ["How the model works", "Understanding the forecast", "Risk tiers and the early alert", "Accuracy and limits"]) {
      expect(within(m).getByRole("heading", { name })).toBeInTheDocument();
    }
    const limits = within(m).getByRole("heading", { name: "Accuracy and limits" }).parentElement!;
    expect(limits).toHaveTextContent("649");
    expect(limits).toHaveTextContent("417");
    expect(limits).toHaveTextContent("false alerts");
    expect(limits).toHaveTextContent("36 of 268");
    expect(limits).toHaveTextContent("without prediction intervals");
    expect(limits).toHaveTextContent("provenance is uncertain and appears simulated");
    expect(limits).toHaveTextContent("They are not causes of dengue");
    expect(limits).toHaveTextContent("historical replay");
    expect(m).toHaveTextContent("XGBoost");
    expect(m).toHaveTextContent("TreeSHAP");
    expect(m).toHaveTextContent("weather lags");
    const tiers = within(m).getByRole("heading", { name: "Risk tiers and the early alert" }).parentElement!;
    expect(tiers).toHaveTextContent("above 25 cases");
    expect(tiers).toHaveTextContent("30.5 or more");
  });

  it("hides deep technical detail behind expandable boxes", async () => {
    await ready();
    const how = screen.getByRole("heading", { name: "How the model works" }).parentElement!;
    const details = how.querySelector("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(within(how).getByText("Technical detail: the model and its data"));
    expect(details.open).toBe(true);
    expect(details).toHaveTextContent("4 Jan 2016 to 29 Dec 2025");
    expect(details).toHaveTextContent("Nothing after 2025 is predicted");
  });
});

describe("English | বাংলা", () => {
  it("offers a labelled, keyboard-operable switch with the current language pressed", async () => {
    await ready();
    const group = screen.getByRole("group", { name: "Language / ভাষা" });
    const enBtn = within(group).getByRole("button", { name: /Show the site in English/ });
    const bnBtn = within(group).getByRole("button", { name: /বাংলায় দেখুন/ });
    expect(enBtn).toHaveAttribute("aria-pressed", "true");
    expect(bnBtn).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.lang).toBe("en");
    bnBtn.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.documentElement.lang).toBe("bn");
    expect(screen.getByRole("group", { name: "ভাষা / Language" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /বাংলায় দেখুন/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("translates the page, uses Bangla digits and keeps the replay warning prominent", async () => {
    await ready();
    await toBangla();
    expect(document.title).toBe(bn.htmlTitle);
    expect(screen.getByRole("heading", { name: "ডিএনসিসি ওয়ার্ড ১২" })).toBeInTheDocument();
    const detail = screen.getByRole("region", { name: "ডিএনসিসি ওয়ার্ড ১২" });
    expect(detail.querySelector(".result-num")).toHaveTextContent("৩১.২");
    expect(detail).toHaveTextContent("সংকটপূর্ণ (Critical)");
    expect(detail).toHaveTextContent("জারি হয়েছে");
    expect(detail.querySelector(".detail-where")).toHaveTextContent("ঢাকা উত্তর, ইস্যু সপ্তাহ: ২৮ জুলাই ২০২৫");
    expect(screen.getByText(bn.notLive)).toBeInTheDocument();
    expect(screen.getByText(bn.notice)).toBeInTheDocument();
    expect(document.querySelector(".replay-badge")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("ঐতিহাসিক তথ্যের");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("ঐতিহাসিক তথ্য থেকে পুনরায় চালানো");
    // the observed value stays marked as a historical comparison, in Bangla
    const obs = screen.getByRole("heading", { name: bn.observedHeading }).parentElement!;
    expect(obs).toHaveTextContent("৩৩");
    expect(obs).toHaveTextContent("শুধু ঐতিহাসিক তুলনার জন্য");
    expect(obs).toHaveTextContent("পূর্বাভাসের ইনপুট নয়");
    // drivers: signs and magnitudes unchanged, groups translated, no causation claim
    const up = screen.getByRole("region", { name: bn.driversUp });
    expect(up).toHaveTextContent("+১২.৩");
    expect(up).toHaveTextContent("সাম্প্রতিক ডেঙ্গু রোগী");
    expect(screen.getByRole("region", { name: bn.driversDown })).toHaveTextContent("−৩.৪");
    expect(screen.getByText(/প্রমাণ হয় না/)).toBeInTheDocument();
    // register + list + controls
    expect(screen.getByRole("region", { name: "নারায়ণগঞ্জ" })).toBeInTheDocument();
    expect(screen.getByLabelText("ওয়ার্ড খুঁজুন")).toBeInTheDocument();
    expect(screen.getByLabelText("সিটি করপোরেশন")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "পরের সপ্তাহ" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: bn.mTitle })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("changes only the words: API identifiers and option values stay English", async () => {
    await ready();
    await toBangla();
    const city = screen.getByLabelText("সিটি করপোরেশন") as HTMLSelectElement;
    expect(Array.from(city.options).map((o) => o.value)).toEqual(["Chattogram", "Dhaka North", "Dhaka South", "Gazipur", "Narayanganj"]);
    const ward = screen.getByLabelText("ওয়ার্ড") as HTMLSelectElement;
    expect(Array.from(ward.options).map((o) => o.value)).toEqual(["DNCC_Ward_11", "DNCC_Ward_12", "DNCC_Ward_13"]);
    expect((screen.getByLabelText("সপ্তাহ") as HTMLSelectElement).value).toBe(DATE);
  });

  it("keeps city, ward and week selection, and makes no new API requests, when the language changes", async () => {
    const forecastWard = vi.fn((w: string, d: string) => Promise.resolve(oneFor(w, d)));
    const forecastAll = vi.fn((d: string) => Promise.resolve(allFor(d)));
    const meta = vi.fn(() => Promise.resolve(makeMeta()));
    render(<App client={fakeClient({ forecastWard, forecastAll, meta })} />);
    await screen.findByRole("heading", { name: "DNCC Ward 12" });
    await userEvent.selectOptions(screen.getByLabelText("City corporation"), "Chattogram");
    await screen.findByRole("heading", { name: "CCC Ward 01" });
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByRole("region", { name: /week of 4 Aug 2025/ });
    await waitFor(() => expect(forecastWard).toHaveBeenLastCalledWith("CCC_Ward_01", "2025-08-04", true, expect.anything()));
    await userEvent.type(screen.getByLabelText("Search wards"), "ccc");
    const calls = [meta.mock.calls.length, forecastWard.mock.calls.length, forecastAll.mock.calls.length];

    await toBangla();
    expect(screen.getByRole("heading", { name: "সিসিসি ওয়ার্ড ০১" })).toBeInTheDocument();
    expect((screen.getByLabelText("সিটি করপোরেশন") as HTMLSelectElement).value).toBe("Chattogram");
    expect((screen.getByLabelText("ওয়ার্ড") as HTMLSelectElement).value).toBe("CCC_Ward_01");
    expect((screen.getByLabelText("সপ্তাহ") as HTMLSelectElement).value).toBe("2025-08-04");
    expect((screen.getByLabelText("ওয়ার্ড খুঁজুন") as HTMLInputElement).value).toBe("ccc");
    expect([meta.mock.calls.length, forecastWard.mock.calls.length, forecastAll.mock.calls.length]).toEqual(calls);

    await userEvent.click(screen.getByRole("button", { name: /Show the site in English/ }));
    expect(screen.getByRole("heading", { name: "CCC Ward 01" })).toBeInTheDocument();
    expect((screen.getByLabelText("Week") as HTMLSelectElement).value).toBe("2025-08-04");
    expect([meta.mock.calls.length, forecastWard.mock.calls.length, forecastAll.mock.calls.length]).toEqual(calls);
  });

  it("searches by Bangla ward and city names too", async () => {
    await ready();
    await toBangla();
    await userEvent.type(screen.getByLabelText("ওয়ার্ড খুঁজুন"), "গাজীপুর");
    expect(screen.getByText("মিলে যাওয়া ১টির মধ্যে ১টি দেখানো হচ্ছে (মোট ৮টি)")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("ওয়ার্ড খুঁজুন"));
    await userEvent.type(screen.getByLabelText("ওয়ার্ড খুঁজুন"), "zzz");
    expect(screen.getByText(bn.noMatchTitle)).toBeInTheDocument();
  });

  it("remembers the language choice", async () => {
    const first = render(<App client={fakeClient()} />);
    await screen.findByRole("heading", { name: "DNCC Ward 12" });
    await toBangla();
    first.unmount();
    render(<App client={fakeClient()} />);
    expect(await screen.findByRole("heading", { name: "ডিএনসিসি ওয়ার্ড ১২" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("bn");
  });

  it("shows loading, error, retry and empty states in Bangla", async () => {
    window.localStorage.setItem("dengue-outlook-lang", "bn");
    const never = new Promise<never>(() => {});
    const loading = render(<App client={fakeClient({ meta: () => never })} />);
    expect(screen.getByText(bn.connecting)).toBeInTheDocument();
    loading.unmount();

    const failing = render(<App client={fakeClient({ meta: () => Promise.reject(new ApiError("network", "x")) })} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(bn.errNetwork);
    expect(within(alert).getByRole("button", { name: bn.retry })).toBeInTheDocument();
    failing.unmount();

    const model = new ApiError("http", "The forecasting model is not available.", { status: 503, code: "model_unavailable" });
    const m = render(<App client={fakeClient({ meta: () => Promise.reject(model) })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(bn.errModel);
    m.unmount();

    const empty = { ...allFor(DATE), count: 0, forecasts: [] };
    render(<App client={fakeClient({ forecastAll: () => Promise.resolve(empty) })} />);
    expect(await screen.findByText(bn.emptyAllTitle)).toBeInTheDocument();
  });

  it("shows the no-observation message and the missing-drivers message in Bangla", async () => {
    window.localStorage.setItem("dengue-outlook-lang", "bn");
    const client = fakeClient({
      forecastWard: (w, d) =>
        Promise.resolve(oneFor(w, d, { drivers: null, actual: { available: false, actual_cases_3wk: null, actual_risk_tier: null, note: "" } })),
    });
    render(<App client={client} />);
    expect(await screen.findByText(bn.driversEmpty)).toBeInTheDocument();
    expect(screen.getByText(/প্রকৃত মোট সংখ্যা নেই/)).toBeInTheDocument();
  });
});

describe("translations", () => {
  const BENGALI = /[ঀ-৿]/;
  const sample = (v: unknown): string[] => {
    if (typeof v === "string") return [v];
    if (typeof v === "function") {
      const out = (v as (...a: string[]) => unknown)("১২", "৩৪", "৫৬", "৭৮");
      return sample(out);
    }
    if (Array.isArray(v)) return v.flatMap(sample);
    if (v && typeof v === "object") return Object.values(v).flatMap(sample);
    return [];
  };
  const shape = (v: unknown): unknown => {
    if (typeof v === "function") return "fn";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return v.map(shape);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
    return typeof v;
  };

  it("has the same keys, nesting and list lengths in English and Bangla", () => {
    expect(shape(bn)).toEqual(shape(en));
  });

  it("has a real Bangla string for every user-facing key (only the English-language button label may be Latin)", () => {
    for (const [k, v] of Object.entries(bn)) {
      // technical term labels that stay in Latin script on purpose
      if (["langEn", "langEnLabel", "vMae", "vRmse", "vThMae", "vThRmse"].includes(k)) continue;
      const texts = (k === "tierRange"
        ? (["Low", "Medium", "High", "Critical"] as const).map((t) => (v as (t: string, e: string[]) => string)(t, ["१", "२", "३"]))
        : sample(v)
      ).filter((s) => s !== "");
      expect(texts.length, k).toBeGreaterThan(0);
      for (const s of texts) expect(BENGALI.test(s), `${k}: ${s}`).toBe(true);
    }
  });

  it("covers every driver group the backend sends", () => {
    const groups = ["Ward vulnerability", "Rainfall (this week)", "Humidity", "Temperature", "Recent dengue cases", "Season (month)", "Rainfall (previous 1-4 weeks)", "Ward / city identity"];
    for (const g of groups) {
      expect(bn.group[g], g).toBeTruthy();
      expect(bn.groupHelp[g], g).toBeTruthy();
      expect(en.group[g], g).toBeTruthy();
    }
  });

  it("formats digits, dates and names without changing values", () => {
    expect(bnDigits("34.3")).toBe("৩৪.৩");
    const b = makeFormatters("bn");
    const e = makeFormatters("en");
    expect(b.num(1234.56)).toBe("১,২৩৪.৬");
    expect(e.num(1234.56)).toBe("1,234.6");
    expect(b.signed(-3.44)).toBe("−৩.৪");
    expect(b.date("2025-07-28")).toBe("২৮ জুলাই ২০২৫");
    expect(e.date("2025-07-28")).toBe("28 Jul 2025");
    expect(b.ward("DNCC_Ward_12")).toBe("ডিএনসিসি ওয়ার্ড ১২");
    expect(e.ward("DNCC_Ward_12")).toBe("DNCC Ward 12");
    expect(b.city("Dhaka North")).toBe("ঢাকা উত্তর");
  });
});

describe("hero", () => {
  it("never lets the decorative photo layer catch pointer events, and keeps the solid teal base", async () => {
    // Vitest runs with css:false, so read the stylesheet source directly (test-only; node typings are not installed).
    // @ts-expect-error node:fs has no type declarations in this project
    const fs = (await import("node:fs")) as { readFileSync: (u: string, enc: string) => string };
    const styles = fs.readFileSync("src/styles.css", "utf-8");
    const layer = /\.masthead::before\s*\{[^}]*\}/.exec(styles)?.[0] ?? "";
    expect(layer).toContain("pointer-events: none");
    expect(layer).toContain("z-index: -1");
    expect(/\.masthead\s*\{[^}]*background:\s*var\(--teal\)/.test(styles)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Validation error dashboard. FIXTURE numbers only: they exercise the UI and are not the real metrics.
// The last test reads the real exported file and checks it against the documented references.
// ---------------------------------------------------------------------------------------------
const wk = (issue_week: string, mae: number, rmse: number) => ({ issue_week, mae, rmse, n: 60 });
const VAL_FIXTURE = {
  schema_version: 1,
  model_version: "dengue-xgb-2to4w-1.1.0",
  error_unit: "Combined dengue cases over forecast weeks t+2, t+3 and t+4 (one total per ward and issue week). Not a percentage and not a single week.",
  prediction_basis: "Clipped (as served) predictions saved to four decimals in ml/eval. Not raw model output.",
  pooled_metric_basis: "Pooled across every ward prediction in the split. Not an average of weekly values.",
  data_provenance_note: "appears simulated",
  target_window_offset_days: [14, 21, 28],
  splits: {
    test: {
      evaluation_scheme: "test scheme",
      first_issue_week: "2025-07-14",
      last_issue_week: "2025-08-11",
      issue_weeks: 5,
      predictions: 300,
      wards_per_week: 60,
      pooled: { mae: 4.5, rmse: 6.25 },
      weekly: [wk("2025-07-14", 3.1, 4), wk("2025-07-21", 4.2, 5.5), wk("2025-07-28", 5, 6.1), wk("2025-08-04", 6.3, 8), wk("2025-08-11", 2.2, 3)],
    },
    validation: {
      evaluation_scheme: "validation scheme",
      first_issue_week: "2023-07-03",
      last_issue_week: "2023-07-24",
      issue_weeks: 4,
      predictions: 240,
      wards_per_week: 60,
      pooled: { mae: 2.137121, rmse: 4.372975 },
      weekly: [wk("2023-07-03", 1.5, 2.5), wk("2023-07-10", 2.5, 4), wk("2023-07-17", 3, 5), wk("2023-07-24", 1.2, 2)],
    },
  },
  rolling_origin: {
    evaluation_scheme: "rolling scheme",
    years: [
      { year: 2024, rows: 3180, mae: 1.893907, rmse: 3.52842 },
      { year: 2025, rows: 2880, mae: 2.831773, rmse: 5.104812 },
    ],
  },
};

async function validationReady(loader: () => Promise<unknown> = () => Promise.resolve(VAL_FIXTURE)) {
  render(<App client={fakeClient()} validationLoader={loader} />);
  await screen.findByRole("heading", { name: "DNCC Ward 12" });
  return screen.findByRole("region", { name: /held-out weeks|সংরক্ষিত পরীক্ষার/ });
}

describe("validation error dashboard", () => {
  it("sits after the ward charts and before the methodology, and defaults to the held-out test split", async () => {
    const section = await validationReady();
    const order = Array.from(document.querySelectorAll("main > section")).map((s) => s.getAttribute("aria-labelledby"));
    expect(order.indexOf("valid-title")).toBeGreaterThan(order.indexOf("overview-title"));
    expect(order.indexOf("valid-title")).toBeLessThan(order.indexOf("method-title"));
    expect(within(section).getByRole("heading", { name: "How the model performed on held-out weeks" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Test (held out)" })).toHaveAttribute("aria-pressed", "true");
    expect(within(section).getByTestId("pooled-mae")).toHaveTextContent("4.500");
    expect(within(section).getByTestId("pooled-rmse")).toHaveTextContent("6.250");
    expect(section).toHaveTextContent("14 Jul 2025 – 11 Aug 2025");
    expect(section).toHaveTextContent("300"); // ward predictions
    expect(section).toHaveTextContent("60 wards each week");
    expect(section).toHaveTextContent("combined dengue cases for forecast weeks +2 to +4");
    expect(section).toHaveTextContent("not raw model output");
    expect(section).toHaveTextContent("not percentages");
  });

  it("switches the split and updates every label, range and headline metric", async () => {
    const section = await validationReady();
    await userEvent.click(within(section).getByRole("button", { name: "Validation" }));
    expect(within(section).getByRole("button", { name: "Validation" })).toHaveAttribute("aria-pressed", "true");
    expect(within(section).getByRole("button", { name: "Test (held out)" })).toHaveAttribute("aria-pressed", "false");
    expect(within(section).getByTestId("pooled-mae")).toHaveTextContent("2.137");
    expect(within(section).getByTestId("pooled-rmse")).toHaveTextContent("4.373");
    expect(section).toHaveTextContent("3 Jul 2023 – 24 Jul 2023");
    expect(section).toHaveTextContent("240");
    expect(section).toHaveTextContent("trained on the training period only");
    expect(section.querySelectorAll(".vbar")).toHaveLength(4);
    expect(within(section).getByRole("group", { name: /^Validation: weekly MAE by issue week, 4 weeks from 3 Jul 2023 to 24 Jul 2023/ })).toBeInTheDocument();
  });

  it("switches MAE and RMSE and moves the dashed pooled reference line with it", async () => {
    const section = await validationReady();
    const ref = () => section.querySelector(".vref") as HTMLElement;
    const key = () => within(section).getByTestId("reference-key");
    // the label lives above the chart, never inside the plotting area
    expect(ref().textContent).toBe("");
    expect(section.querySelector(".vchart-body")).not.toContainElement(key());
    // fixture axis: max(6.3, 4.5) -> 0..8 in steps of 2
    expect(key()).toHaveTextContent("Dashed reference line — Pooled MAE: 4.500");
    expect(ref().style.bottom).toBe(`${(4.5 / 8) * 100}%`);
    const col = (d: string) => section.querySelector(`.vbar[data-week="${d}"] .vbar-col`) as HTMLElement;
    expect(col("2025-08-04").style.height).toBe(`${(6.3 / 8) * 100}%`);
    await userEvent.click(within(section).getByRole("button", { name: "RMSE" }));
    // RMSE axis: max(8, 6.25) -> 0..8
    expect(key()).toHaveTextContent("Dashed reference line — Pooled RMSE: 6.250");
    expect(ref().textContent).toBe("");
    expect(ref().style.bottom).toBe(`${(6.25 / 8) * 100}%`);
    expect(col("2025-08-04").style.height).toBe("100%");
    expect(section.querySelector(".vy-title")).toHaveTextContent("RMSE (combined dengue cases)");
  });

  it("keeps the reference indicator and line correct for all four split and metric combinations", async () => {
    const section = await validationReady();
    const key = () => within(section).getByTestId("reference-key");
    const line = () => section.querySelector(".vref") as HTMLElement;
    const cases: [string, string, string, number, number][] = [
      ["Test (held out)", "MAE", "4.500", 4.5, 8],
      ["Test (held out)", "RMSE", "6.250", 6.25, 8],
      ["Validation", "MAE", "2.137", 2.137121, 3],
      ["Validation", "RMSE", "4.373", 4.372975, 5],
    ];
    for (const [split, metric, shown, exact, top] of cases) {
      await userEvent.click(within(section).getByRole("button", { name: split }));
      await userEvent.click(within(section).getByRole("button", { name: metric }));
      expect(key()).toHaveTextContent(`Dashed reference line — Pooled ${metric}: ${shown}`);
      expect(line().style.bottom).toBe(`${(exact / top) * 100}%`);
      expect(line().textContent).toBe("");
    }
  });

  it("marks the selected historical issue week, and says changing it does not change the split", async () => {
    const section = await validationReady();
    expect(section.querySelectorAll(".vbar.is-selected")).toHaveLength(1);
    expect(section.querySelector(".vbar.is-selected")).toHaveAttribute("data-week", "2025-07-28");
    expect(section).toHaveTextContent("Outlined bar with a triangle");
    expect(section).toHaveTextContent("does not change the evaluation split");
    await userEvent.click(within(section).getByRole("button", { name: "Validation" }));
    expect(section.querySelectorAll(".vbar.is-selected")).toHaveLength(0);
    expect(section).toHaveTextContent("not part of this evaluation split");
    // picking another historical week above leaves the evaluation split alone
    await userEvent.selectOptions(screen.getByLabelText("Week"), "2025-08-04");
    expect(within(section).getByRole("button", { name: "Validation" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a tooltip with the issue week, error, split, ward count and the +14/+21/+28 day target window", async () => {
    const section = await validationReady();
    expect(screen.queryByTestId("validation-tooltip")).not.toBeInTheDocument();
    await userEvent.hover(section.querySelector('.vbar[data-week="2025-07-28"]')!);
    const tip = screen.getByTestId("validation-tooltip");
    expect(tip).toHaveTextContent("Issue week of 28 Jul 2025");
    expect(tip).toHaveTextContent("Test (held out): MAE 5.00 cases");
    expect(tip).toHaveTextContent("60 ward predictions");
    expect(tip).toHaveTextContent("Target: combined cases for weeks beginning 11 Aug, 18 Aug and 25 Aug 2025");
    await userEvent.click(within(section).getByRole("button", { name: "RMSE" }));
    await userEvent.hover(section.querySelector('.vbar[data-week="2025-08-11"]')!);
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("Test (held out): RMSE 3.00 cases");
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("25 Aug, 1 Sep and 8 Sep 2025");
  });

  it("is keyboard operable: the chart is a labelled slider that moves between weeks", async () => {
    const section = await validationReady();
    const slider = within(section).getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuemin", "1");
    expect(slider).toHaveAttribute("aria-valuemax", "5");
    expect(slider.getAttribute("aria-label")).toContain("arrow keys");
    await act(async () => {
      slider.focus();
    });
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("Issue week of 28 Jul 2025"); // starts on the selected week
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("Issue week of 4 Aug 2025");
    expect(slider.getAttribute("aria-valuetext")).toContain("issue week of 4 Aug 2025: MAE 6.30 cases");
    await userEvent.keyboard("{Home}");
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("Issue week of 14 Jul 2025");
    await userEvent.keyboard("{End}");
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("Issue week of 11 Aug 2025");
    expect(section.querySelector("#vchart-desc")).toHaveTextContent("The highest week is the issue week of 4 Aug 2025");
  });

  it("offers the weekly values as a table", async () => {
    const section = await validationReady();
    const details = section.querySelector("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(within(section).getByText("Show the weekly values as a table"));
    const rows = within(details).getAllByRole("row");
    expect(rows).toHaveLength(6); // header + 5 weeks
    expect(rows[3]).toHaveTextContent("28 Jul 2025");
    expect(rows[3]).toHaveTextContent("5.00");
    expect(rows[3]).toHaveTextContent("6.10");
  });

  it("keeps rolling-origin results in a separate, clearly labelled panel", async () => {
    const section = await validationReady();
    const roll = within(section).getByRole("heading", { name: "Rolling-origin evaluation by year" }).parentElement!;
    expect(roll).toHaveTextContent("retrained for each year");
    expect(roll).toHaveTextContent("not comparable week by week");
    expect(roll).toHaveTextContent("2024");
    expect(roll).toHaveTextContent("1.89");
    expect(roll).toHaveTextContent("3.53");
    expect(section.querySelector(".vchart")).not.toContainElement(roll);
    expect(screen.queryByTestId("validation-tooltip")).not.toBeInTheDocument();
  });

  it("states the limits: simulated data, no intervals, combined target, not a guarantee", async () => {
    const section = await validationReady();
    expect(section).toHaveTextContent("appears simulated");
    expect(section).toHaveTextContent("No confidence or prediction intervals");
    expect(section).toHaveTextContent("combined +2, +3 and +4 week total");
    expect(section).toHaveTextContent("does not guarantee accuracy on future outbreaks");
    expect(section).toHaveTextContent("not a promise of future accuracy");
  });

  it("works in Bangla with Bangla digits, keeping the split, metric and forecast selection", async () => {
    const section = await validationReady();
    await userEvent.click(within(section).getByRole("button", { name: "Validation" }));
    await userEvent.click(within(section).getByRole("button", { name: "RMSE" }));
    await toBangla();
    const bnSection = screen.getByRole("region", { name: bn.vTitle });
    expect(within(bnSection).getByRole("button", { name: bn.vSplitValidation })).toHaveAttribute("aria-pressed", "true");
    expect(within(bnSection).getByRole("button", { name: "RMSE" })).toHaveAttribute("aria-pressed", "true");
    expect(within(bnSection).getByTestId("pooled-rmse")).toHaveTextContent("৪.৩৭৩");
    expect(within(bnSection).getByTestId("reference-key")).toHaveTextContent("ড্যাশ রেখা — সম্মিলিত RMSE: ৪.৩৭৩");
    expect(bnSection).toHaveTextContent("৩ জুলাই ২০২৩ – ২৪ জুলাই ২০২৩");
    expect(bnSection).toHaveTextContent(bn.vNotes[0]!);
    expect(bnSection).toHaveTextContent(bn.vRollTitle);
    expect(screen.getByRole("heading", { name: "ডিএনসিসি ওয়ার্ড ১২" })).toBeInTheDocument();
    expect((screen.getByLabelText("সপ্তাহ") as HTMLSelectElement).value).toBe(DATE);
    await userEvent.hover(bnSection.querySelector('.vbar[data-week="2023-07-10"]')!);
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("১০ জুলাই ২০২৩ তারিখের ইস্যু সপ্তাহ");
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("২৪ জুলাই, ৩১ জুলাই ও ৭ আগস্ট ২০২৩");
  });

  it("shows a safe message and no numbers when the data is missing, unreadable or malformed", async () => {
    for (const loader of [
      () => Promise.reject(new ApiError("network", "x")),
      () => Promise.resolve({ not: "the expected shape" }),
      () => Promise.resolve({ ...VAL_FIXTURE, splits: { ...VAL_FIXTURE.splits, test: { ...VAL_FIXTURE.splits.test, pooled: { mae: Number.NaN, rmse: 1 } } } }),
    ]) {
      const { unmount } = render(<App client={fakeClient()} validationLoader={loader} />);
      const section = await screen.findByRole("region", { name: "How the model performed on held-out weeks" });
      await within(section).findByText("The saved evaluation data is not available");
      expect(section.querySelector(".valid-num")).toBeNull();
      expect(within(section).queryByRole("slider")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("shows a loading state first", async () => {
    render(<App client={fakeClient()} validationLoader={() => new Promise<never>(() => {})} />);
    expect(await screen.findByText("Loading the saved evaluation…")).toBeInTheDocument();
  });

  it("validates the exported shape strictly", () => {
    expect(parseValidation(VAL_FIXTURE).splits.test.weekly).toHaveLength(5);
    const clone = () => JSON.parse(JSON.stringify(VAL_FIXTURE));
    const unordered = clone();
    unordered.splits.test.weekly.reverse();
    expect(() => parseValidation(unordered)).toThrow();
    const negative = clone();
    negative.splits.validation.weekly[0].mae = -1;
    expect(() => parseValidation(negative)).toThrow();
    const wrongCount = clone();
    wrongCount.splits.test.issue_weeks = 9;
    expect(() => parseValidation(wrongCount)).toThrow();
    const badDate = clone();
    badDate.splits.test.weekly[0].issue_week = "14/07/2025";
    expect(() => parseValidation(badDate)).toThrow();
    expect(() => parseValidation(null)).toThrow();
  });

  it("builds tidy axes", () => {
    expect(niceAxis(6.3)).toEqual({ top: 8, step: 2, ticks: [0, 2, 4, 6, 8] });
    expect(niceAxis(14.72)).toMatchObject({ top: 15, step: 5 });
    expect(niceAxis(0.02).top).toBeGreaterThan(0.02);
  });

  it("the exported JSON file is valid and reproduces the documented reference metrics", async () => {
    // test-only: Vitest cannot import from public/, and node typings are not installed
    // @ts-expect-error node:fs has no type declarations in this project
    const fs = (await import("node:fs")) as { readFileSync: (u: string, enc: string) => string };
    const data = parseValidation(JSON.parse(fs.readFileSync("public/validation/weekly_errors.json", "utf-8")));
    const { validation, test } = data.splits;
    expect([test.predictions, test.issue_weeks, test.first_issue_week, test.last_issue_week]).toEqual([4620, 77, "2024-06-17", "2025-12-01"]);
    expect([validation.predictions, validation.issue_weeks, validation.first_issue_week, validation.last_issue_week]).toEqual([4380, 73, "2022-12-26", "2024-05-13"]);
    expect(validation.last_issue_week < test.first_issue_week).toBe(true);
    expect(test.pooled.mae).toBeCloseTo(2.7762, 3);
    expect(test.pooled.rmse).toBeCloseTo(4.9225, 3);
    expect(validation.pooled.mae).toBeCloseTo(2.1371, 3);
    expect(validation.pooled.rmse).toBeCloseTo(4.373, 3);
    for (const s of [validation, test]) for (const w of s.weekly) expect(w.n).toBe(60);
    expect(data.rolling_origin.years.map((y) => y.year)).toEqual([2020, 2021, 2022, 2023, 2024, 2025]);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 31D corrections. FIXTURE numbers (VAL_FIXTURE above) exercise the UI; they are not real metrics.
// ---------------------------------------------------------------------------------------------
describe("validation dashboard corrections", () => {
  const clone = () => JSON.parse(JSON.stringify(VAL_FIXTURE));

  it("discloses that validation helped choose the model and alert threshold, and keeps test primary and default", async () => {
    const section = await validationReady();
    expect(within(section).getByRole("button", { name: "Test (held out)" })).toHaveAttribute("aria-pressed", "true");
    expect(section).toHaveTextContent("This is the primary evaluation.");
    expect(section).not.toHaveTextContent(/scored once/i);
    expect(screen.queryByTestId("validation-caution")).not.toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Validation" }));
    const caution = screen.getByTestId("validation-caution");
    expect(caution).toHaveTextContent("also helped choose the model and the alert threshold");
    expect(caution).toHaveTextContent("may be optimistic");
    expect(caution).toHaveTextContent("held-out test split is the separate evaluation");
    expect(section).not.toHaveTextContent(/scored once/i);
    await userEvent.click(within(section).getByRole("button", { name: "Test (held out)" }));
    expect(screen.queryByTestId("validation-caution")).not.toBeInTheDocument();
  });

  it("states the same limitation in Bangla", async () => {
    const section = await validationReady();
    await userEvent.click(within(section).getByRole("button", { name: "Validation" }));
    await toBangla();
    expect(screen.getByTestId("validation-caution")).toHaveTextContent(bn.vValidationCaution);
    expect(bn.vValidationCaution).toContain("ভালো দেখাতে পারে");
    expect(bn.vSplitNoteTest).toContain("প্রধান মূল্যায়ন");
  });

  it("keeps the selected-week marker visually but hides its triangle from assistive technology", async () => {
    const section = await validationReady();
    const marks = section.querySelectorAll(".vbar-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute("aria-hidden", "true");
    expect(marks[0]!.closest(".vbar")).toHaveAttribute("data-week", "2025-07-28");
    expect(marks[0]!.closest(".vbar")).toHaveClass("is-selected");
    // the slider keeps its meaningful name, with no glyph in it
    const slider = within(section).getByRole("slider");
    expect(slider.getAttribute("aria-label")).not.toContain("▼");
    // and the stylesheet no longer injects the glyph as generated content
    // @ts-expect-error node:fs has no type declarations in this project
    const fs = (await import("node:fs")) as { readFileSync: (u: string, enc: string) => string };
    const css = fs.readFileSync("src/styles.css", "utf-8");
    expect(css).not.toContain('content: "\\25BC"');
    expect(css).toMatch(/\.vbar-mark\s*\{/);
  });

  it("gives the slider a useful value text: split, week, error, wards and target window, and handles no selection", async () => {
    const section = await validationReady();
    const slider = within(section).getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuetext", "No week selected yet. 5 issue weeks; use the arrow keys.");
    await act(async () => {
      slider.focus();
    });
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Test (held out), issue week of 28 Jul 2025: MAE 5.00 cases, 60 wards, target weeks beginning 11 Aug, 18 Aug and 25 Aug 2025. This is also the issue week selected in the forecast controls.",
    );
    await userEvent.keyboard("{ArrowRight}");
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Test (held out), issue week of 4 Aug 2025: MAE 6.30 cases, 60 wards, target weeks beginning 18 Aug, 25 Aug and 1 Sep 2025.",
    );
    await userEvent.click(within(section).getByRole("button", { name: "RMSE" }));
    await act(async () => {
      slider.focus();
    });
    await userEvent.keyboard("{Home}");
    expect(slider.getAttribute("aria-valuetext")).toContain("issue week of 14 Jul 2025: RMSE 4.00 cases");
    // the chart selection is not the forecast control
    expect(section.querySelector("#vchart-desc")).toHaveTextContent("does not change the issue week selected in the forecast controls");
    expect(slider.getAttribute("aria-valuetext")).not.toContain("NaN");
  });

  it("gives the slider a Bangla value text from the same data point", async () => {
    await validationReady();
    await toBangla();
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuetext")).toContain("এখনো কোনো সপ্তাহ বাছা হয়নি");
    await act(async () => {
      slider.focus();
    });
    const text = slider.getAttribute("aria-valuetext") ?? "";
    expect(text).toContain("টেস্ট (আলাদা রাখা), ২৮ জুলাই ২০২৫ তারিখের ইস্যু সপ্তাহ: MAE ৫.০০ রোগী");
    expect(text).toContain("৬০টি ওয়ার্ড");
    expect(text).toContain("লক্ষ্য সপ্তাহ শুরু ১১ আগস্ট, ১৮ আগস্ট ও ২৫ আগস্ট ২০২৫");
    expect(text).toContain(bn.vSliderSameWeek);
  });

  it("uses safer seasonal wording about when errors occurred, without a causal claim", async () => {
    const section = await validationReady();
    expect(section).toHaveTextContent("some monsoon-season months (mostly June through September)");
    expect(section).toHaveTextContent("when errors occurred, not why");
    expect(section).not.toHaveTextContent(/high-case months/i);
    expect(section).toHaveTextContent("appears simulated");
    expect(en.vNotes.join(" ")).not.toMatch(/because|due to|caused/i);
    expect(bn.vNotes[3]).toContain("বর্ষা মৌসুমের কিছু মাসে");
    expect(bn.vNotes[3]).toContain("কেন হয়েছে তা নয়");
  });

  it("no longer repeats the dashed-line explanation below the chart, but keeps the pill, line and selected-week note", async () => {
    const section = await validationReady();
    expect(within(section).queryByText(/Dashed line: pooled value/)).not.toBeInTheDocument();
    expect(within(section).getByTestId("reference-key")).toHaveTextContent("Dashed reference line — Pooled MAE: 4.500");
    expect(section.querySelector(".vref")).not.toBeNull();
    const legend = section.querySelector(".vlegend")!;
    expect(legend.querySelectorAll("li")).toHaveLength(1);
    expect(legend).toHaveTextContent("Outlined bar with a triangle");
    await userEvent.click(within(section).getByRole("button", { name: "Validation" }));
    expect(section.querySelector(".vlegend")).toBeNull(); // no selected week in this split, so nothing to explain
    expect(section.querySelector(".vref")).not.toBeNull();
  });

  const mutations: [string, (d: ReturnType<typeof clone>) => void][] = [
    ["unsupported schema version", (d) => (d.schema_version = 2)],
    ["wrong target offsets (+29)", (d) => (d.target_window_offset_days = [14, 21, 29])],
    ["too few target offsets", (d) => (d.target_window_offset_days = [14, 21])],
    ["first issue week differs from the series", (d) => (d.splits.test.first_issue_week = "2025-07-21")],
    ["last issue week differs from the series", (d) => (d.splits.validation.last_issue_week = "2023-07-31")],
    ["prediction count differs from the weekly counts", (d) => (d.splits.test.predictions = 299)],
    ["weekly ward count differs from wards_per_week", (d) => {
      d.splits.test.weekly[0].n = 59;
      d.splits.test.predictions = 299;
    }],
    ["non-Monday issue week", (d) => (d.splits.test.weekly[1].issue_week = "2025-07-22")],
    ["duplicate issue week", (d) => (d.splits.test.weekly[1] = { ...d.splits.test.weekly[0] })],
    ["skipped week", (d) => {
      d.splits.test.weekly.splice(2, 1);
      d.splits.test.issue_weeks = 4;
      d.splits.test.predictions = 240;
      d.splits.test.last_issue_week = "2025-08-11";
    }],
    ["out-of-order weeks", (d) => d.splits.validation.weekly.reverse()],
    ["impossible calendar date", (d) => {
      d.splits.test.weekly[0].issue_week = "2025-02-30";
      d.splits.test.first_issue_week = "2025-02-30";
    }],
    ["NaN weekly metric", (d) => (d.splits.test.weekly[0].mae = Number.NaN)],
    ["infinite weekly metric", (d) => (d.splits.test.weekly[0].rmse = Number.POSITIVE_INFINITY)],
    ["negative pooled metric", (d) => (d.splits.validation.pooled.mae = -0.1)],
    ["weekly RMSE below MAE", (d) => (d.splits.test.weekly[0].rmse = 1)],
    ["pooled RMSE below MAE", (d) => (d.splits.test.pooled.rmse = 1)],
    ["validation overlaps test", (d) => (d.splits.validation = { ...d.splits.test, evaluation_scheme: "x" })],
    ["rolling years not ascending", (d) => d.rolling_origin.years.reverse()],
    ["rolling RMSE below MAE", (d) => (d.rolling_origin.years[0].rmse = 0.1)],
    ["missing rolling years", (d) => (d.rolling_origin.years = [])],
  ];

  it.each(mutations)("rejects malformed data: %s", (_label, mutate) => {
    const d = clone();
    mutate(d);
    expect(() => parseValidation(d)).toThrow(ApiError);
    try {
      parseValidation(d);
    } catch (e) {
      expect((e as ApiError).kind).toBe("shape");
    }
  });

  it("still accepts the valid fixture and shows the safe unavailable state for a rejected file", async () => {
    expect(parseValidation(clone()).schema_version).toBe(1);
    const bad = clone();
    bad.schema_version = 2;
    render(<App client={fakeClient()} validationLoader={() => Promise.resolve(bad)} />);
    const section = await screen.findByRole("region", { name: "How the model performed on held-out weeks" });
    await within(section).findByText("The saved evaluation data is not available");
    expect(section.querySelector(".valid-num")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Final UI polish (Step 36): search placeholder, mobile timeline label size, chart date labels.
// ---------------------------------------------------------------------------------------------
describe("final UI polish", () => {
  const mondays = (start: string, count: number) => {
    const out: string[] = [];
    const d = new Date(`${start}T00:00:00Z`);
    for (let i = 0; i < count; i++) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 7);
    }
    return out;
  };
  /** FIXTURE with the real week counts (77 test, 73 validation) and made-up errors, so the axis can be exercised. */
  const longData = () => {
    const d = JSON.parse(JSON.stringify(VAL_FIXTURE));
    const fill = (key: "test" | "validation", start: string, count: number) => {
      const weeks = mondays(start, count);
      d.splits[key] = {
        ...d.splits[key],
        first_issue_week: weeks[0],
        last_issue_week: weeks[count - 1],
        issue_weeks: count,
        predictions: count * 60,
        weekly: weeks.map((w, i) => wk(w, 1 + (i % 7) * 0.5, 2 + (i % 7) * 0.5)),
        pooled: { mae: 2.5, rmse: 3.5 },
      };
    };
    fill("test", "2024-06-17", 77);
    fill("validation", "2022-12-26", 73);
    return d;
  };
  const labels = (section: HTMLElement) => Array.from(section.querySelectorAll<HTMLElement>(".vx-label"));

  it("suggests a ward-search example that really matches, in English", async () => {
    await ready();
    const box = screen.getByLabelText("Search wards") as HTMLInputElement;
    expect(box.placeholder).toBe("e.g. DNCC Ward 12");
    expect(box.placeholder).not.toMatch(/DNCC 12/);
    await userEvent.type(box, box.placeholder.replace(/^e\.g\. /, ""));
    const table = document.querySelector(".ward-table") as HTMLElement;
    expect(within(table).getByRole("button", { name: "DNCC Ward 12" })).toBeInTheDocument();
    expect(within(table).getByRole("status")).toHaveTextContent(/Showing 1 of 1 matching ward/);
  });

  it("suggests a ward-search example that really matches, in Bangla", async () => {
    await ready();
    await toBangla();
    const box = screen.getByLabelText("ওয়ার্ড খুঁজুন") as HTMLInputElement;
    expect(box.placeholder).toBe(bn.searchPh);
    expect(box.placeholder).toBe("যেমন: ডিএনসিসি ওয়ার্ড ১২");
    await userEvent.type(box, box.placeholder.replace(/^যেমন: /, ""));
    const table = document.querySelector(".ward-table") as HTMLElement;
    expect(within(table).getByRole("button", { name: "ডিএনসিসি ওয়ার্ড ১২" })).toBeInTheDocument();
    expect(within(table).queryByRole("heading", { name: /No wards match/ })).toBeNull();
  });

  it("leaves the search behaviour as it was (the old, unsupported wording still matches nothing)", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("Search wards"), "DNCC 12");
    const table = document.querySelector(".ward-table") as HTMLElement;
    expect(within(table).getByRole("heading", { name: "No wards match" })).toBeInTheDocument();
  });

  it("keeps the hero timeline labels at 12px or larger, including on phones (stylesheet source check)", async () => {
    // @ts-expect-error node:fs has no type declarations in this project
    const fs = (await import("node:fs")) as { readFileSync: (u: string, enc: string) => string };
    const css = fs.readFileSync("src/styles.css", "utf-8");
    const sizes = [...css.matchAll(/\.h-label\s*\{[^}]*?font-size:\s*([\d.]+)rem/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThanOrEqual(2); // base rule and the phone override
    for (const rem of sizes) expect(rem * 16).toBeGreaterThanOrEqual(12);
    expect(css).not.toMatch(/\.h-label\s*\{[^}]*font-size:\s*0\.6875rem/);
  });

  it("never prints a chart date label that would run past the end of the plot, and keeps every week", async () => {
    const section = await validationReady(() => Promise.resolve(longData()));
    const open = section.querySelector("details.tech summary") as HTMLElement;
    for (const [split, bars, first] of [
      ["Test (held out)", 77, "17 Jun 2024"],
      ["Validation", 73, "26 Dec 2022"],
    ] as const) {
      await userEvent.click(within(section).getByRole("button", { name: split }));
      for (const metric of ["MAE", "RMSE"]) {
        await userEvent.click(within(section).getByRole("button", { name: metric }));
        expect(section.querySelectorAll(".vbar")).toHaveLength(bars);
        const l = labels(section);
        expect(l.map((e) => e.style.left)).toEqual([0, 9, 18, 27, 36, 45, 54, 63].map((i) => `${(i / bars) * 100}%`));
        expect(l[0]).toHaveTextContent(first);
        for (const el of l) expect(el.textContent).toMatch(/^\d{1,2} \w{3} \d{4}$/); // full date, year included
        // the labels sit at least 6 columns before the end, so none is cut by the plot edge
        for (const el of l) expect(bars - (parseFloat(el.style.left) / 100) * bars).toBeGreaterThanOrEqual(6 - 1e-9);
      }
    }
    // the accessible weekly table still has every week
    await userEvent.click(open);
    expect(section.querySelectorAll("details.tech table tbody tr")).toHaveLength(73);
  });

  it("shows the Bangla date labels in full too", async () => {
    const section = await validationReady(() => Promise.resolve(longData()));
    await toBangla();
    const l = labels(section);
    expect(l).toHaveLength(8);
    expect(l[0]).toHaveTextContent("১৭ জুন ২০২৪");
    for (const el of l) expect(el.textContent).toMatch(/\d{4}$|[০-৯]{4}$/);
  });

  it("hides only the date labels that are partly outside the scrolled window, and shows them again when they are fully in view", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const sw = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth");
    const cw = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
    let shift = 0;
    try {
      Object.defineProperty(Element.prototype, "scrollWidth", { configurable: true, get(this: HTMLElement) { return this.classList.contains("vchart-scroll") ? 847 : 0; } });
      Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.classList.contains("vchart-scroll") ? 270 : 0; } });
      rect.mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("vchart-scroll")) return { left: 0, right: 270, top: 0, bottom: 10, width: 270, height: 10, x: 0, y: 0, toJSON() {} } as DOMRect;
        if (this.classList.contains("vx-label")) {
          const idx = Array.from(document.querySelectorAll(".vx-label")).indexOf(this);
          const left = idx * 99 - shift;
          return { left, right: left + 62, top: 0, bottom: 10, width: 62, height: 10, x: left, y: 0, toJSON() {} } as DOMRect;
        }
        return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
      });
      const section = await validationReady(() => Promise.resolve(longData()));
      const scroller = section.querySelector(".vchart-scroll") as HTMLElement;
      const hidden = () => labels(section).map((e) => e.classList.contains("is-clipped"));
      fireEvent.scroll(scroller);
      expect(hidden()).toEqual([false, false, false, true, true, true, true, true]); // 4th label starts at 297, outside a 270px window
      shift = 99; // scrolled one label along: the first is cut off on the left, the 4th now fits
      fireEvent.scroll(scroller);
      expect(hidden()).toEqual([true, false, false, false, true, true, true, true]);
      shift = 0;
      fireEvent.scroll(scroller);
      expect(hidden()[0]).toBe(false);
    } finally {
      rect.mockRestore();
      if (sw) Object.defineProperty(Element.prototype, "scrollWidth", sw);
      if (cw) Object.defineProperty(Element.prototype, "clientWidth", cw);
    }
  });

  it("hides no label when the chart is not scrolling (wide screens)", async () => {
    const section = await validationReady(() => Promise.resolve(longData()));
    fireEvent.scroll(section.querySelector(".vchart-scroll") as HTMLElement);
    expect(labels(section).some((e) => e.classList.contains("is-clipped"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 36B: the hover tooltip is anchored on its own bar (same % geometry as the bars and date labels).
// Real pixel layout is verified in a real browser; these tests check the anchor, the text and the clamping logic.
// ---------------------------------------------------------------------------------------------
describe("validation tooltip placement", () => {
  const mondays = (start: string, count: number) => {
    const out: string[] = [];
    const d = new Date(`${start}T00:00:00Z`);
    for (let i = 0; i < count; i++) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 7);
    }
    return out;
  };
  const TEST_WEEKS = mondays("2024-06-17", 77);
  const VAL_WEEKS = mondays("2022-12-26", 73);
  /** FIXTURE with the real week counts and made-up errors. MAE of week i is 1 + (i % 7) * 0.5, RMSE is MAE + 1. */
  const longData = () => {
    const d = JSON.parse(JSON.stringify(VAL_FIXTURE));
    const fill = (key: "test" | "validation", weeks: string[]) => {
      d.splits[key] = {
        ...d.splits[key],
        first_issue_week: weeks[0],
        last_issue_week: weeks[weeks.length - 1],
        issue_weeks: weeks.length,
        predictions: weeks.length * 60,
        weekly: weeks.map((w, i) => wk(w, 1 + (i % 7) * 0.5, 2 + (i % 7) * 0.5)),
        pooled: { mae: 2.5, rmse: 3.5 },
      };
    };
    fill("test", TEST_WEEKS);
    fill("validation", VAL_WEEKS);
    return d;
  };
  const bars = (section: HTMLElement) => Array.from(section.querySelectorAll<HTMLElement>(".vbar"));
  const tip = () => screen.getByTestId("validation-tooltip");
  const hover = (el: HTMLElement) => act(() => void fireEvent.mouseMove(el));

  it("anchors the tooltip on the hovered bar as a share of the plot width, whatever the screen width", async () => {
    const section = await validationReady(() => Promise.resolve(longData()));
    const b = bars(section);
    expect(b).toHaveLength(77);
    for (const i of [0, 1, 2, 3, 38, 73, 74, 75, 76]) {
      hover(b[i]!);
      expect(tip().style.left).toBe(`${((i + 0.5) / 77) * 100}%`);
      expect(tip().className).toBe("vtip"); // one rule for every bar, no special start/end placement by pixel
    }
  });

  it("shows the hovered week and its error, and not a neighbour's", async () => {
    const section = await validationReady(() => Promise.resolve(longData()));
    const b = bars(section);
    const { date } = makeFormatters("en");
    for (const i of [0, 40, 76]) {
      hover(b[i]!);
      expect(tip()).toHaveTextContent(`Issue week of ${date(TEST_WEEKS[i]!)}`);
      expect(tip()).toHaveTextContent(`MAE ${(1 + (i % 7) * 0.5).toFixed(2)} cases`);
    }
    await userEvent.click(within(section).getByRole("button", { name: "RMSE" }));
    hover(bars(section)[40]!);
    expect(tip()).toHaveTextContent(`RMSE ${(2 + (40 % 7) * 0.5).toFixed(2)} cases`);
  });

  it("uses the same anchor for the Validation split (73 weeks) and keeps its text", async () => {
    const section = await validationReady(() => Promise.resolve(longData()));
    await userEvent.click(within(section).getByRole("button", { name: "Validation" }));
    const b = bars(section);
    expect(b).toHaveLength(73);
    const { date } = makeFormatters("en");
    for (const i of [0, 36, 72]) {
      hover(b[i]!);
      expect(tip().style.left).toBe(`${((i + 0.5) / 73) * 100}%`);
      expect(tip()).toHaveTextContent(`Issue week of ${date(VAL_WEEKS[i]!)}`);
    }
  });

  describe("keeping the tooltip inside the visible chart window (layout mocked: jsdom has no layout)", () => {
    let nominalLeft = 0;
    let tipWidth = 240;
    const mockLayout = () => {
      const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
      rect.mockImplementation(function (this: HTMLElement) {
        const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 10, width, height: 10, x: left, y: 0, toJSON() {} }) as DOMRect;
        if (this.classList.contains("vchart-scroll")) return box(0, 270);
        if (this.classList.contains("vtip")) return box(nominalLeft + (parseFloat(this.style.getPropertyValue("--tip-shift")) || 0), tipWidth);
        return box(0, 0);
      });
      return rect;
    };
    const shift = () => tip().style.getPropertyValue("--tip-shift");

    it("slides it right when it would stick out on the left, left when on the right, and not at all when it fits", async () => {
      const rect = mockLayout();
      try {
        const section = await validationReady(() => Promise.resolve(longData()));
        const b = bars(section);
        nominalLeft = -60;
        tipWidth = 240;
        hover(b[0]!);
        expect(shift()).toBe("64px"); // 4px inside the left edge
        nominalLeft = 100;
        hover(b[76]!);
        expect(shift()).toBe("-74px"); // right edge 340 -> 266
        nominalLeft = 10;
        hover(b[38]!);
        expect(shift()).toBe("0px");
        nominalLeft = 0;
        tipWidth = 300; // wider than the 270px window: the left edge wins so the start of the text stays readable
        hover(b[1]!);
        expect(shift()).toBe("4px");
      } finally {
        rect.mockRestore();
      }
    });

    it("re-checks the position when the chart is scrolled while a tooltip is showing", async () => {
      const rect = mockLayout();
      try {
        const section = await validationReady(() => Promise.resolve(longData()));
        nominalLeft = 10;
        tipWidth = 240;
        hover(bars(section)[20]!);
        expect(shift()).toBe("0px");
        nominalLeft = 100; // the tooltip is now partly out of the window
        fireEvent.scroll(section.querySelector(".vchart-scroll") as HTMLElement);
        expect(shift()).toBe("-74px");
      } finally {
        rect.mockRestore();
      }
    });

    it("keyboard: the active bar is scrolled into view, so its tooltip stays beside it", async () => {
      const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
      let sl = 0;
      try {
        const section = await validationReady(() => Promise.resolve(longData()));
        const scroller = section.querySelector(".vchart-scroll") as HTMLElement;
        Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => sl, set: (v: number) => void (sl = Math.max(0, v)) });
        rect.mockImplementation(function (this: HTMLElement) {
          const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 10, width, height: 10, x: left, y: 0, toJSON() {} }) as DOMRect;
          if (this === scroller) return box(0, 270);
          if (this.classList.contains("vbar")) return box(bars(section).indexOf(this) * 11 - sl, 11);
          return box(0, 0);
        });
        const slider = within(section).getByRole("slider");
        await act(async () => {
          slider.focus();
        });
        // the forecast issue week (28 Jul 2025) is bar 58, at x = 638: well to the right of a 270px window
        expect(sl).toBe(638 + 11 - 270 + 8);
        await userEvent.keyboard("{Home}");
        expect(sl).toBe(0);
        expect(slider.getAttribute("aria-valuetext")).toContain(`issue week of ${makeFormatters("en").date(TEST_WEEKS[0]!)}`);
        await userEvent.keyboard("{End}");
        expect(sl).toBe(76 * 11 + 11 - 270 + 8);
        expect(tip()).toHaveTextContent(`Issue week of ${makeFormatters("en").date(TEST_WEEKS[76]!)}`);
      } finally {
        rect.mockRestore();
      }
    });
  });
});

describe("validation chart hover vs keyboard", () => {
  it("only real pointer movement changes the active week, so a bar scrolled under a parked pointer cannot override the keyboard", async () => {
    const section = await validationReady();
    const bars = Array.from(section.querySelectorAll<HTMLElement>(".vbar"));
    const slider = within(section).getByRole("slider");
    await act(async () => {
      slider.focus();
    });
    await userEvent.keyboard("{End}");
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("Issue week of 11 Aug 2025");
    act(() => void fireEvent.mouseEnter(bars[1]!)); // the bar moved under a still pointer: enter without movement
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("Issue week of 11 Aug 2025");
    act(() => void fireEvent.mouseMove(bars[1]!)); // the user really moved the pointer
    expect(screen.getByTestId("validation-tooltip")).toHaveTextContent("Issue week of 21 Jul 2025");
  });
});