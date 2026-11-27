// The three newer planning sections inside the real dashboard (one full-app test each, kept few on purpose):
// navigation, the shared issue week / city / ward reaching each request, and no unrelated planning calls.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { ApiClient, PlanningApiClient } from "../api/client";
import type { DispatchDocumentFormat, DispatchQuery, HospitalRoutingQuery, InterventionQuery } from "../api/types";
import { en } from "../i18n/dict";
import { allFor, fakeClient, oneFor } from "../test/fixtures";
import { makeBriefDocument, makeHospital, makeIntervention } from "../test/planningFixtures";
import { closeAllInfoPopovers, openInfoPopoverKey } from "./InfoButton";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

function client() {
  const hospitalRouting = vi.fn((q?: HospitalRoutingQuery) => Promise.resolve(makeHospital(q)));
  const interventionSimulation = vi.fn((q?: InterventionQuery) => Promise.resolve(makeIntervention(q)));
  const dispatchDocument = vi.fn((q: DispatchQuery, f: DispatchDocumentFormat) => Promise.resolve(makeBriefDocument(q, f)));
  const dispatchBriefUrl = vi.fn((q: DispatchQuery, f: string) => `http://127.0.0.1:8000/dispatch-brief?scope=${q.scope}&format=${f}`);
  const allocation = vi.fn();
  const dispatchBrief = vi.fn();
  const c = {
    ...fakeClient({ forecastWard: (w, d) => Promise.resolve(oneFor(w, d)), forecastAll: (d) => Promise.resolve(allFor(d)) }),
    hospitalRouting, interventionSimulation, dispatchDocument, dispatchBriefUrl, allocation, dispatchBrief,
  } as ApiClient & PlanningApiClient;
  return { client: c, hospitalRouting, interventionSimulation, dispatchDocument, allocation, dispatchBrief };
}
async function readyApp(c = client()) {
  render(<App client={c.client} />);
  await screen.findByRole("heading", { name: "DNCC Ward 12" }, { timeout: 3000 });
  await screen.findByRole("region", { name: /All 8 wards/ });
  return c;
}
const navButton = (name: string) => within(screen.getByRole("navigation", { name: en.nav.label })).getByRole("button", { name });

describe("planning sections in the dashboard", () => {
  it("opens Hospital Planning and Intervention Explorer with the shared week, each calling only its own endpoint", async () => {
    const user = userEvent.setup();
    const c = await readyApp();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByRole("region", { name: /week of 4 Aug 2025/ });
    await user.click(navButton(en.nav.hospitals));
    const hospital = await screen.findByRole("region", { name: en.hospital.title });
    expect(navButton(en.nav.hospitals)).toHaveAttribute("aria-current", "page");
    await within(hospital).findByTestId("applied-parameters");
    expect(c.hospitalRouting.mock.calls.at(-1)?.[0]).toEqual({ issue_date: "2025-08-04" });
    await user.click(navButton(en.nav.interventions));
    const intervention = await screen.findByRole("region", { name: en.intervention.title });
    await within(intervention).findByTestId("applied-parameters");
    expect(c.interventionSimulation.mock.calls.at(-1)?.[0]).toEqual({ issue_date: "2025-08-04" });
    expect(screen.queryByRole("region", { name: en.hospital.title })).toBeNull(); // one section at a time
    for (const fn of [c.allocation, c.dispatchBrief, c.dispatchDocument]) expect(fn).not.toHaveBeenCalled();
  });

  it("opens Dispatch Brief for the dashboard's city and ward, and closes an open explanation on leaving", async () => {
    const user = userEvent.setup();
    const c = await readyApp();
    await user.click(navButton(en.nav.dispatch));
    const region = await screen.findByRole("region", { name: en.dispatch.title });
    await within(region).findByTestId("brief-text");
    expect(c.dispatchDocument.mock.calls[0]![0]).toMatchObject({ scope: "city", city: "Dhaka North", issue_date: "2025-07-28" });
    expect(within(region).getByLabelText(en.dispatch.scopeLabel)).toHaveDisplayValue(en.dispatch.scopeCity("Dhaka North"));
    await user.click(within(region).getByRole("button", { name: en.dispatch.previewInfoLabel }));
    expect(openInfoPopoverKey()).not.toBeNull();
    fireEvent.click(navButton(en.nav.overview));
    expect(openInfoPopoverKey()).toBeNull();
    await waitFor(() => expect(screen.getByRole("region", { name: /All 8 wards/ })).toBeInTheDocument());
    for (const fn of [c.allocation, c.hospitalRouting, c.interventionSimulation, c.dispatchBrief]) expect(fn).not.toHaveBeenCalled();
  });
});
