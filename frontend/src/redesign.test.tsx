import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { ApiError } from "./api/client";
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
      if (k === "langEn" || k === "langEnLabel") continue;
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
