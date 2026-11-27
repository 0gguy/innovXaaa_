// Dispatch Brief (direct component tests; the full-app path is in PlanningSections.test.tsx).
// The brief text is a fixture that carries the backend's DRAFT / NOT SENT marker.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { DispatchDocument, DispatchDocumentFormat, DispatchQuery } from "../api/types";
import { I18nProvider } from "../i18n/I18n";
import { bn, en } from "../i18n/dict";
import { deferred, makeMeta, NOTICE } from "../test/fixtures";
import { makeBriefDocument } from "../test/planningFixtures";
import { DispatchBrief } from "./DispatchBrief";
import { closeAllInfoPopovers, openInfoPopoverKey } from "./InfoButton";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

const d = en.dispatch;
const s = en.scenario;
const DATE = "2025-07-28";
type DocFn = (q: DispatchQuery, format: DispatchDocumentFormat, signal?: AbortSignal) => Promise<DispatchDocument>;

function mount(impl?: DocFn, opts: { lang?: "en" | "bn"; ward?: string } = {}) {
  const document = vi.fn<DocFn>(impl ?? ((q, f) => Promise.resolve(makeBriefDocument(q, f))));
  const url = vi.fn((q: DispatchQuery, f: string) => `http://127.0.0.1:8000/dispatch-brief?scope=${q.scope}&format=${f}${q.download ? "&download=true" : ""}`);
  const view = render(
    <I18nProvider initial={opts.lang ?? "en"}>
      <DispatchBrief api={{ document, url }} meta={makeMeta()} selection={{ city: "Dhaka North", ward: opts.ward ?? "DNCC_Ward_12", date: DATE }} baseUrl="http://test.invalid" />
    </I18nProvider>,
  );
  return { document, url, view };
}
async function ready(impl?: DocFn, opts: { lang?: "en" | "bn"; ward?: string } = {}) {
  const m = mount(impl, opts);
  const region = await screen.findByRole("region", { name: (opts.lang === "bn" ? bn : en).dispatch.title });
  await within(region).findByTestId("brief-text");
  return { ...m, region };
}
async function setBox(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  const box = screen.getByLabelText(label);
  await user.clear(box);
  if (text) await user.type(box, text);
}

describe("dispatch brief requests", () => {
  it("generates one text draft for the selected city and week on opening", async () => {
    const { document, region } = await ready();
    expect(document).toHaveBeenCalledTimes(1);
    const [query, format, signal] = document.mock.calls[0]!;
    expect(query).toEqual({ scope: "city", city: "Dhaka North", issue_date: DATE, audience: "all", variant: "detailed" });
    expect(format).toBe("text");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(within(region).getByTestId("brief-text")).toHaveTextContent("Draft dispatch brief for city Dhaka North, issue week 2025-07-28.");
  });

  it("changes scope, sections, length and assumptions only on Generate, sending the exact query once", async () => {
    const user = userEvent.setup();
    const { document, region } = await ready();
    await user.selectOptions(within(region).getByLabelText(d.scopeLabel), "ward");
    await user.selectOptions(within(region).getByLabelText(d.audienceLabel), "hospital");
    await user.selectOptions(within(region).getByLabelText(d.variantLabel), "short");
    await setBox(user, s.capacityLabel, "80");
    await user.selectOptions(within(region).getByLabelText(s.effectLabel), "high");
    expect(document).toHaveBeenCalledTimes(1);
    expect(within(region).getAllByRole("status").map((e) => e.textContent)).toContain(d.draftChanged);
    await user.click(within(region).getByRole("button", { name: d.generate }));
    await waitFor(() => expect(document).toHaveBeenCalledTimes(2));
    expect(document.mock.calls[1]![0]).toEqual({
      scope: "ward", city: "Dhaka North", ward_id: "DNCC_Ward_12", issue_date: DATE, audience: "hospital", variant: "short", capacity_pct: 80, intervention_scenario: "high",
    });
    expect(await within(region).findByText(/Draft dispatch brief for ward DNCC_Ward_12/)).toBeInTheDocument();
  });

  it("says plainly that saline and kit overrides are not used, and never sends them", async () => {
    const user = userEvent.setup();
    const { document, region } = await ready();
    await user.click(within(region).getByText(s.overridesSummary));
    await setBox(user, s.salineLabel, "40");
    expect(within(region).getByTestId("not-carried-draft")).toHaveTextContent(d.notCarried(s.salineLabel));
    await user.click(within(region).getByRole("button", { name: d.generate }));
    await waitFor(() => expect(document).toHaveBeenCalledTimes(2));
    expect(document.mock.calls[1]![0]).not.toHaveProperty("stock_pct_saline");
    expect(await within(region).findByTestId("not-carried-applied")).toHaveTextContent(d.notCarried(s.salineLabel));
  });

  it("blocks invalid input and a ward scope without a ward, requesting nothing", async () => {
    const user = userEvent.setup();
    const a = await ready();
    await setBox(user, s.stockLabel, "10");
    await user.click(within(a.region).getByRole("button", { name: d.generate }));
    expect(within(a.region).getAllByRole("status").map((e) => e.textContent)).toContain(en.planning.blocked);
    expect(a.document).toHaveBeenCalledTimes(1);
    a.view.unmount();
    const b = await ready(undefined, { ward: "" });
    await user.selectOptions(within(b.region).getByLabelText(d.scopeLabel), "ward");
    await user.click(within(b.region).getByRole("button", { name: d.generate }));
    expect(within(b.region).getAllByRole("status").map((e) => e.textContent)).toContain(en.planning.blocked);
    expect(b.document).toHaveBeenCalledTimes(1);
  });

  it("aborts a superseded draft request and ignores its late answer", async () => {
    const user = userEvent.setup();
    const pending: { q: DispatchQuery; signal?: AbortSignal; dd: ReturnType<typeof deferred<DispatchDocument>> }[] = [];
    mount((q, _f, signal) => {
      const dd = deferred<DispatchDocument>();
      pending.push({ q, signal, dd });
      return dd.promise;
    });
    const region = await screen.findByRole("region", { name: d.title });
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.selectOptions(within(region).getByLabelText(d.variantLabel), "short");
    await user.click(within(region).getByRole("button", { name: d.generate }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.signal?.aborted).toBe(true);
    pending[1]!.dd.resolve(makeBriefDocument(pending[1]!.q));
    expect(await within(region).findByText(/variant short/)).toBeInTheDocument();
    pending[0]!.dd.resolve(makeBriefDocument(pending[0]!.q));
    await new Promise((r) => setTimeout(r, 30));
    expect(within(region).getByTestId("brief-text")).toHaveTextContent("variant short");
  });
});

describe("dispatch brief preview and downloads", () => {
  it("shows the draft as inert text, labelled as a draft that was not sent", async () => {
    const { region } = await ready();
    const pre = within(region).getByTestId("brief-text");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toContain("<script>alert('not run')</script>"); // shown as text, never parsed
    expect(pre.querySelector("script")).toBeNull();
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(within(region).getByTestId("draft-label")).toHaveTextContent(`${d.draftLabel} ${d.draftStatement}`);
    expect(region).toHaveTextContent(`${en.notLive} ${NOTICE} ${d.hypothetical}`);
    expect(region.textContent).not.toMatch(/has been sent|delivered to|notified|dispatched to/i);
  });

  it("offers the backend's own text and printable downloads for exactly the applied brief", async () => {
    const { url, region } = await ready();
    const text = within(region).getByRole("link", { name: d.downloadText });
    const html = within(region).getByRole("link", { name: d.downloadHtml });
    expect(text).toHaveAttribute("href", "http://127.0.0.1:8000/dispatch-brief?scope=city&format=text&download=true");
    expect(html).toHaveAttribute("href", "http://127.0.0.1:8000/dispatch-brief?scope=city&format=html&download=true");
    expect(url).toHaveBeenCalledWith({ scope: "city", city: "Dhaka North", issue_date: DATE, audience: "all", variant: "detailed", download: true }, "text");
    // each download has its own sibling explanation
    for (const [link, label] of [[text, d.downloadTextInfoLabel], [html, d.downloadHtmlInfoLabel]] as const) {
      const info = within(region).getByRole("button", { name: label });
      expect(info.parentElement?.parentElement).toBe(link.parentElement);
    }
  });
});

describe("dispatch brief states and translations", () => {
  it("shows a shape error (a document without its draft label) as an error with Retry", async () => {
    const user = userEvent.setup();
    let n = 0;
    mount((q, f) => (++n === 1 ? Promise.reject(new ApiError("shape", "The brief is missing its draft label.")) : Promise.resolve(makeBriefDocument(q, f))));
    const region = await screen.findByRole("region", { name: d.title });
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(en.errShape);
    expect(within(region).queryByTestId("brief-text")).toBeNull();
    await user.click(within(region).getByRole("button", { name: d.generateInfoLabel }));
    expect(openInfoPopoverKey()).not.toBeNull();
    expect(n).toBe(1);
    await user.click(within(alert).getByRole("button", { name: en.retry }));
    expect(await within(region).findByTestId("brief-text")).toBeInTheDocument();
  });

  it("says so without a planning service", () => {
    render(
      <I18nProvider initial="en">
        <DispatchBrief api={null} meta={makeMeta()} selection={{ city: "Dhaka North", ward: "DNCC_Ward_12", date: DATE }} baseUrl="x" />
      </I18nProvider>,
    );
    expect(screen.getByText(en.planning.unavailableTitle)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: d.generate })).toBeDisabled();
  });

  it("has matching Bangla keys, Bangla labels, and no nested buttons or duplicate ids", async () => {
    expect(Object.keys(bn.dispatch).sort()).toEqual(Object.keys(en.dispatch).sort());
    for (const [k, v] of Object.entries(bn.dispatch)) {
      const text = typeof v === "function" ? (v as (a: string) => string)("১") : v;
      expect(/[ঀ-৿]/.test(text), k).toBe(true);
    }
    const { region } = await ready(undefined, { lang: "bn" });
    expect(within(region).getByRole("button", { name: bn.dispatch.generate })).toBeInTheDocument();
    expect(within(region).getByLabelText(bn.dispatch.scopeLabel)).toHaveDisplayValue(bn.dispatch.scopeCity("ঢাকা উত্তর"));
    expect(document.querySelector("button button, button a, a button, label button")).toBeNull();
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
