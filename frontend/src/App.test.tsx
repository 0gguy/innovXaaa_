import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { ApiError } from "./api/client";
import type { AllForecastsResponse, WardForecastResponse } from "./api/types";
import { allFor, deferred, fakeClient, makeMeta, NOTICE, oneFor } from "./test/fixtures";

const DEFAULT_DATE = "2025-07-28";

async function ready() {
  render(<App client={fakeClient()} />);
  await screen.findByRole("heading", { name: "DNCC Ward 12" });
}

describe("dashboard", () => {
  it("shows the historical replay framing and the backend notice", async () => {
    await ready();
    expect(document.querySelector(".replay-badge")).toBeNull(); // header badge removed; the disclaimers remain
    expect(screen.getByRole("note")).toHaveTextContent(/Historical replay of a trained model/);
    expect(screen.getByText(/Not a live warning system/)).toBeInTheDocument();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getAllByText(/weeks \+2 to \+4/).length).toBeGreaterThan(0);
  });

  it("loads meta and offers the five real cities and a ward filter", async () => {
    await ready();
    const city = screen.getByLabelText("City corporation") as HTMLSelectElement;
    expect(Array.from(city.options).map((o) => o.value)).toEqual([
      "Chattogram",
      "Dhaka North",
      "Dhaka South",
      "Gazipur",
      "Narayanganj",
    ]);
    const ward = screen.getByLabelText("Ward") as HTMLSelectElement;
    expect(Array.from(ward.options).map((o) => o.value)).toEqual(["DNCC_Ward_11", "DNCC_Ward_12", "DNCC_Ward_13"]);
  });

  it("changing city changes the ward options and loads that ward's forecast", async () => {
    const forecastWard = vi.fn((w: string, d: string) => Promise.resolve(oneFor(w, d)));
    render(<App client={fakeClient({ forecastWard })} />);
    await screen.findByRole("heading", { name: "DNCC Ward 12" });
    await userEvent.selectOptions(screen.getByLabelText("City corporation"), "Chattogram");
    await screen.findByRole("heading", { name: "CCC Ward 01" });
    const ward = screen.getByLabelText("Ward") as HTMLSelectElement;
    expect(Array.from(ward.options).map((o) => o.value)).toEqual(["CCC_Ward_01", "CCC_Ward_02"]);
    expect(forecastWard).toHaveBeenLastCalledWith("CCC_Ward_01", DEFAULT_DATE, true, expect.anything());
  });

  it("uses only valid Monday issue weeks from the metadata range", async () => {
    await ready();
    const week = screen.getByLabelText("Week") as HTMLSelectElement;
    expect(week.value).toBe(DEFAULT_DATE);
    const year = screen.getByLabelText("Year") as HTMLSelectElement;
    const years = Array.from(year.options).map((o) => o.value);
    expect(years[0]).toBe("2016");
    expect(years[years.length - 1]).toBe("2025");
    for (const o of Array.from(week.options)) {
      expect(new Date(`${o.value}T00:00:00Z`).getUTCDay()).toBe(1);
    }
    await userEvent.selectOptions(year, "2016");
    expect((screen.getByLabelText("Week") as HTMLSelectElement).options[0]?.value).toBe("2016-02-01");
  });

  it("changing the issue week reloads both the ward and the overview", async () => {
    const forecastWard = vi.fn((w: string, d: string) => Promise.resolve(oneFor(w, d)));
    const forecastAll = vi.fn((d: string) => Promise.resolve(allFor(d)));
    render(<App client={fakeClient({ forecastWard, forecastAll })} />);
    await screen.findByRole("heading", { name: "DNCC Ward 12" });
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(forecastAll).toHaveBeenLastCalledWith("2025-08-04", expect.anything()));
    expect(forecastWard).toHaveBeenLastCalledWith("DNCC_Ward_12", "2025-08-04", true, expect.anything());
  });

  it("renders the single-ward forecast with tier, alert rule and observed outcome", async () => {
    await ready();
    const detail = screen.getByRole("region", { name: "DNCC Ward 12" });
    expect(detail.querySelector(".result-num")).toHaveTextContent("31.2");
    expect(within(detail).getByText("Risk tier").parentElement).toHaveTextContent("Critical");
    expect(within(detail).getByText("Raised")).toBeInTheDocument();
    expect(within(detail).getByText(/above the alert line of 25 cases/)).toBeInTheDocument();
    expect(within(detail).getByText(/One combined total for weeks \+2 to \+4/)).toBeInTheDocument();
    const observed = within(detail).getByRole("heading", { name: "Observed later (historical comparison)" });
    expect(observed.parentElement).toHaveTextContent("33 cases were recorded");
    expect(observed.parentElement).toHaveTextContent("not an input to the forecast");
  });

  it("shows Not raised for a ward below the alert line", async () => {
    render(<App client={fakeClient()} />);
    await screen.findByRole("heading", { name: "DNCC Ward 12" });
    await userEvent.selectOptions(screen.getByLabelText("Ward"), "DNCC_Ward_11");
    const detail = await screen.findByRole("region", { name: "DNCC Ward 11" });
    expect(within(detail).getByText("Not raised")).toBeInTheDocument();
    expect(within(detail).getByText("Risk tier").parentElement).toHaveTextContent("High");
  });

  it("explains when no observed outcome exists for the week", async () => {
    const client = fakeClient({
      forecastWard: (w, d) => Promise.resolve(oneFor(w, d, { actual: { available: false, actual_cases_3wk: null, actual_risk_tier: null, note: "" } })),
    });
    render(<App client={client} />);
    const h = await screen.findByRole("heading", { name: "Observed later (historical comparison)" });
    expect(h.parentElement).toHaveTextContent(/No observed total is available/);
    expect(h.parentElement).toHaveTextContent("1 Dec 2025");
  });

  it("renders driver bars from the API values", async () => {
    await ready();
    const list = screen.getByRole("heading", { name: "What shaped this estimate" }).parentElement!;
    expect(within(list).getByText("Recent dengue cases")).toBeInTheDocument();
    expect(within(list).getByText(/\+12\.3/)).toBeInTheDocument();
    expect(within(list).getByText(/−3\.4/)).toBeInTheDocument();
    expect(within(list).getByText(/not causes of dengue/)).toBeInTheDocument();
  });

  it("degrades gracefully when drivers are missing", async () => {
    const client = fakeClient({
      forecastWard: (w, d) => Promise.resolve(oneFor(w, d, { drivers: null })),
    });
    render(<App client={client} />);
    expect(await screen.findByText(/did not return driver details/)).toBeInTheDocument();
    expect(document.querySelector(".result-num")).toHaveTextContent("31.2");
  });

  it("summarises all wards by tier and by city", async () => {
    await ready();
    const overview = screen.getByRole("region", { name: /All 8 wards/ });
    expect(overview.querySelector(".alert-line")).toHaveTextContent("3 of 8 wards are above the early-alert line");
    const legend = within(overview).getByRole("heading", { name: "Wards by risk tier" }).parentElement!;
    expect(within(legend).getByRole("img", { name: "Wards by risk tier: 2 Low, 2 Medium, 2 High, 2 Critical" })).toBeInTheDocument();
    const dn = within(overview).getByRole("img", { name: "Dhaka North: 0 Low, 0 Medium, 2 High, 1 Critical" });
    expect(dn).toBeInTheDocument();
  });

  it("lets the ward register and list drive the detail panel", async () => {
    await ready();
    const tile = screen.getByRole("button", { name: /NCC Ward 01, Critical tier, 40\.0 predicted cases, early alert raised/ });
    await userEvent.click(tile);
    expect(await screen.findByRole("heading", { name: "NCC Ward 01" })).toBeInTheDocument();
    expect((screen.getByLabelText("City corporation") as HTMLSelectElement).value).toBe("Narayanganj");

    await userEvent.click(screen.getByRole("button", { name: "CCC Ward 02" }));
    expect(await screen.findByRole("heading", { name: "CCC Ward 02" })).toBeInTheDocument();
  });

  it("orders the list by predicted cases and can filter by search and city", async () => {
    await ready();
    const table = screen.getByRole("table");
    const firstRows = within(table).getAllByRole("row").slice(1, 4).map((r) => r.textContent ?? "");
    expect(firstRows[0]).toContain("NCC Ward 01");
    expect(firstRows[1]).toContain("DNCC Ward 12");
    expect(screen.getByLabelText("Order by")).toHaveDisplayValue("Predicted cases, highest first");

    await userEvent.type(screen.getByLabelText("Search wards"), "dscc");
    expect(screen.getByText("Showing 1 of 1 matching ward (8 total)")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Search wards"));
    await userEvent.type(screen.getByLabelText("Search wards"), "zzz");
    expect(screen.getByText("No wards match")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Search wards"));
    await userEvent.selectOptions(screen.getByLabelText("City"), "Gazipur");
    expect(screen.getByText("Showing 1 of 1 matching ward (8 total)")).toBeInTheDocument();
  });

  it("labels the ward-detail region even when its request failed", async () => {
    const client = fakeClient({ forecastWard: () => Promise.reject(new ApiError("network", "x")) });
    render(<App client={client} />);
    const region = await screen.findByRole("region", { name: "Ward forecast" });
    expect(await within(region).findByRole("alert")).toBeInTheDocument();
  });

  it("describes the forecast as a combined total after the issue week, not weekly values", async () => {
    await ready();
    expect(screen.getByText(/in total across weeks \+2 to \+4 after the issue week/)).toBeInTheDocument();
    expect(screen.getByText(/One combined total for weeks \+2 to \+4, not three separate weekly forecasts/)).toBeInTheDocument();
  });

  it("states that the ward charts are not a map and the methodology cites its evaluation context", async () => {
    await ready();
    expect(screen.getByText(/This is not a map/)).toBeInTheDocument();
    expect(screen.getByText(/held-out test set \(4,620 ward-weeks, issue weeks 17 Jun 2024 to 1 Dec 2025\)/)).toBeInTheDocument();
  });

  it("shows tier as text plus letter, never colour alone", async () => {
    await ready();
    const table = screen.getByRole("table");
    const row = within(table).getByText("NCC Ward 01").closest("tr")!;
    expect(row).toHaveTextContent("Critical");
    expect(row).toHaveTextContent("Raised");
  });
});

describe("loading, error and empty states", () => {
  it("shows a loading state first", () => {
    const d = deferred<ReturnType<typeof makeMeta>>();
    render(<App client={fakeClient({ meta: () => d.promise })} />);
    expect(screen.getByText("Connecting to the forecast service…")).toBeInTheDocument();
  });

  it("shows a backend-unavailable state with retry", async () => {
    const meta = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("network", "Could not reach the backend."))
      .mockResolvedValue(makeMeta());
    render(<App client={fakeClient({ meta })} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Can't reach the forecast service");
    expect(alert).toHaveTextContent("http://test.invalid");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "DNCC Ward 12" })).toBeInTheDocument();
  });

  it("shows a model-unavailable state", async () => {
    const err = new ApiError("http", "The forecasting model is not available.", { status: 503, code: "model_unavailable" });
    render(<App client={fakeClient({ meta: () => Promise.reject(err) })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The forecast model isn't loaded");
    expect(screen.queryByText(/Predicted/)).not.toBeInTheDocument();
  });

  it("handles a per-request error without hiding the rest of the page", async () => {
    const forecastWard = vi
      .fn<(w: string, d: string) => Promise<WardForecastResponse>>()
      .mockRejectedValueOnce(new ApiError("timeout", "slow"))
      .mockImplementation((w, d) => Promise.resolve(oneFor(w, d)));
    render(<App client={fakeClient({ forecastWard })} />);
    const alert = await screen.findByText("The forecast service is slow to answer");
    expect(alert).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: /All 8 wards/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "DNCC Ward 12" })).toBeInTheDocument();
  });

  it("shows an empty state when a week has no ward forecasts", async () => {
    const empty: AllForecastsResponse = { ...allFor(DEFAULT_DATE), count: 0, forecasts: [] };
    render(<App client={fakeClient({ forecastAll: () => Promise.resolve(empty) })} />);
    expect(await screen.findByText("No ward forecasts for this week")).toBeInTheDocument();
  });
});

describe("stale-response protection", () => {
  it("ignores an older ward response that arrives after a newer selection", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<WardForecastResponse>>>();
    const forecastWard = (w: string, d: string) => {
      const dd = deferred<WardForecastResponse>();
      pending.set(`${w}|${d}`, dd);
      return dd.promise;
    };
    render(<App client={fakeClient({ forecastWard })} />);
    await screen.findByLabelText("Ward");
    await waitFor(() => expect(pending.has(`DNCC_Ward_12|${DEFAULT_DATE}`)).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText("Ward"), "DNCC_Ward_13");
    await waitFor(() => expect(pending.has(`DNCC_Ward_13|${DEFAULT_DATE}`)).toBe(true));

    // newest answers first, then the stale one arrives late
    pending.get(`DNCC_Ward_13|${DEFAULT_DATE}`)!.resolve(oneFor("DNCC_Ward_13", DEFAULT_DATE));
    expect(await screen.findByRole("heading", { name: "DNCC Ward 13" })).toBeInTheDocument();
    pending.get(`DNCC_Ward_12|${DEFAULT_DATE}`)!.resolve(oneFor("DNCC_Ward_12", DEFAULT_DATE));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole("heading", { name: "DNCC Ward 13" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "DNCC Ward 12" })).not.toBeInTheDocument();
  });

  it("ignores an older overview response for a previous week", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<AllForecastsResponse>>>();
    const forecastAll = (d: string) => {
      const dd = deferred<AllForecastsResponse>();
      pending.set(d, dd);
      return dd.promise;
    };
    render(<App client={fakeClient({ forecastAll })} />);
    await screen.findByLabelText("Ward");
    await waitFor(() => expect(pending.has(DEFAULT_DATE)).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(pending.has("2025-08-04")).toBe(true));

    pending.get("2025-08-04")!.resolve(allFor("2025-08-04", 10));
    expect(await screen.findByRole("region", { name: /week of 4 Aug 2025/ })).toBeInTheDocument();
    pending.get(DEFAULT_DATE)!.resolve(allFor(DEFAULT_DATE));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole("region", { name: /week of 4 Aug 2025/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /week of 28 Jul 2025/ })).not.toBeInTheDocument();
  });
});
