// Planning-scenario controls: interaction, accessibility, info buttons, translations and isolation from the
// current dashboard. jsdom does no layout: responsive behaviour is checked as CSS rules only.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { I18nProvider } from "../i18n/I18n";
import { bn, en } from "../i18n/dict";
import { buildAllocationQuery, buildHospitalRoutingQuery } from "../scenario/queries";
import { useScenario } from "../scenario/scenario";
import { fakeClient } from "../test/fixtures";
import { closeAllInfoPopovers } from "./InfoButton";
import { ScenarioControls, type ScenarioGroup } from "./ScenarioControls";

afterEach(() => {
  act(() => closeAllInfoPopovers());
  vi.restoreAllMocks();
});

const WEEKS = { first: "2016-02-01", last: "2025-12-01" };
const s = en.scenario;

/** Test-only harness: the hook, the controls, and the query a planning section WOULD build (never sent). */
function Harness({ groups, issueDate = null }: { groups?: readonly ScenarioGroup[]; issueDate?: string | null }) {
  const scenario = useScenario({ issueDate });
  const q = buildAllocationQuery(scenario.state, WEEKS);
  const h = buildHospitalRoutingQuery(scenario.state, WEEKS);
  return (
    <>
      <ScenarioControls scenario={scenario} groups={groups} />
      <output data-testid="allocation">{JSON.stringify(q)}</output>
      <output data-testid="hospital">{JSON.stringify(h)}</output>
    </>
  );
}
function renderControls(lang: "en" | "bn" = "en", props: { groups?: readonly ScenarioGroup[]; issueDate?: string | null } = {}) {
  return render(
    <I18nProvider initial={lang}>
      <Harness {...props} />
    </I18nProvider>,
  );
}
const allocation = () => JSON.parse(screen.getByTestId("allocation").textContent ?? "null");
const hospital = () => JSON.parse(screen.getByTestId("hospital").textContent ?? "null");
const popoverOf = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-controls") ?? "") as HTMLElement;

// ---------------------------------------------------------------- structure and wording
describe("scenario controls structure", () => {
  it("shows every group with labelled controls, units and the hypothetical-scenario warning", () => {
    renderControls();
    const region = screen.getByRole("region", { name: s.title });
    expect(region).toHaveTextContent(s.lead);
    expect(region).toHaveTextContent(`${s.issueLabel}: ${s.issueLatest}`);
    for (const g of [s.suppliesTitle, s.crewsTitle, s.hospitalTitle, s.interventionTitle]) {
      expect(within(region).getByRole("group", { name: g })).toBeInTheDocument();
    }
    expect(screen.getByLabelText(s.stockLabel)).toHaveValue("100");
    expect(screen.getByLabelText(s.minCoverageLabel)).toHaveValue("30");
    expect(screen.getByLabelText(s.totalCrewsLabel)).toHaveValue("60");
    expect(screen.getByLabelText(s.capacityLabel)).toHaveValue("100");
    expect(screen.getByLabelText(s.salineLabel)).toHaveValue("");
    expect(screen.getByLabelText(s.kitsLabel)).toHaveValue("");
    expect(screen.getByLabelText(s.effectLabel)).toHaveValue("base");
    expect(screen.getByLabelText(s.roiLabel)).not.toBeChecked();
    // units and ranges are in each box's description, not only in the visual "%"
    expect(screen.getByLabelText(s.stockLabel)).toHaveAccessibleDescription(s.stockHint("30", "100"));
    expect(screen.getByLabelText(s.capacityLabel)).toHaveAccessibleDescription(s.capacityHint("25", "200"));
    expect(screen.getByLabelText(s.totalCrewsLabel)).toHaveAccessibleDescription(s.totalCrewsHint("0", "10,000"));
  });

  it("shows the chosen planning week when one is set", () => {
    renderControls("en", { issueDate: "2025-07-28" });
    expect(screen.getByRole("region", { name: s.title })).toHaveTextContent(s.issueChosen("28 Jul 2025"));
  });

  it("renders only the groups a section asks for", () => {
    renderControls("en", { groups: ["hospital"] });
    expect(screen.getByRole("group", { name: s.hospitalTitle })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: s.suppliesTitle })).toBeNull();
    expect(screen.queryByLabelText(s.stockLabel)).toBeNull();
    expect(screen.getByRole("button", { name: s.resetAll })).toBeInTheDocument();
  });

  it("has no nested interactive elements and no duplicate ids, even with two copies on one page", () => {
    render(
      <I18nProvider initial="en">
        <Harness />
        <Harness />
      </I18nProvider>,
    );
    expect(document.querySelector("button button, button a, a button, label button, select button, summary button")).toBeNull();
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const el of Array.from(document.querySelectorAll("[aria-describedby], [aria-labelledby], [aria-controls]"))) {
      for (const attr of ["aria-describedby", "aria-labelledby", "aria-controls"]) {
        for (const ref of (el.getAttribute(attr) ?? "").split(" ").filter(Boolean)) {
          expect(document.getElementById(ref), `${attr}=${ref}`).not.toBeNull();
        }
      }
    }
  });
});

// ---------------------------------------------------------------- editing, validation and the built query
describe("scenario controls editing", () => {
  it("updates the query a section would build, keeping explicit zeros", async () => {
    const user = userEvent.setup();
    renderControls();
    expect(allocation()).toEqual({ ok: true, query: {} });
    await user.clear(screen.getByLabelText(s.stockLabel));
    await user.type(screen.getByLabelText(s.stockLabel), "65");
    await user.clear(screen.getByLabelText(s.totalCrewsLabel));
    await user.type(screen.getByLabelText(s.totalCrewsLabel), "0");
    expect(allocation()).toEqual({ ok: true, query: { stock_pct: 65, total_crews: 0 } });
    await user.clear(screen.getByLabelText(s.capacityLabel));
    await user.type(screen.getByLabelText(s.capacityLabel), "140");
    expect(hospital()).toEqual({ ok: true, query: { capacity_pct: 140 } });
  });

  it("keeps a half-typed value as a draft, shows the error only after leaving the box, and never clamps it", async () => {
    const user = userEvent.setup();
    renderControls();
    const stock = screen.getByLabelText(s.stockLabel);
    await user.clear(stock);
    await user.type(stock, "150");
    expect(stock).toHaveValue("150");
    expect(stock).not.toHaveAttribute("aria-invalid"); // still typing
    expect(allocation()).toEqual({ ok: false, errors: { stockPct: "outOfRange" } }); // but never usable
    await user.tab();
    expect(stock).toHaveValue("150"); // not clamped to 100
    expect(stock).toHaveAttribute("aria-invalid", "true");
    expect(stock).toHaveAccessibleDescription(`${s.stockHint("30", "100")} ${s.errOutOfRange("30", "100")}`);
    expect(within(screen.getByRole("region", { name: s.title })).getByRole("status")).toHaveTextContent(s.invalidNote);
    await user.clear(stock);
    await user.type(stock, "12.5");
    await user.tab();
    expect(stock).toHaveAccessibleDescription(`${s.stockHint("30", "100")} ${s.errNotWhole}`);
    await user.clear(stock);
    await user.tab();
    expect(stock).toHaveAccessibleDescription(`${s.stockHint("30", "100")} ${s.errRequired}`);
    await user.type(stock, "8O");
    await user.tab();
    expect(stock).toHaveAccessibleDescription(`${s.stockHint("30", "100")} ${s.errNotNumber}`);
  });

  it("tidies a valid entry when leaving the box", async () => {
    const user = userEvent.setup();
    renderControls();
    const crews = screen.getByLabelText(s.totalCrewsLabel);
    await user.clear(crews);
    await user.type(crews, " 045 ");
    await user.tab();
    expect(crews).toHaveValue("45");
    expect(crews).not.toHaveAttribute("aria-invalid");
  });

  it("treats an empty override as 'same as the general stock' and an entered one as explicit", async () => {
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByText(s.overridesSummary));
    const kits = screen.getByLabelText(s.kitsLabel);
    await user.type(kits, "40");
    expect(allocation()).toEqual({ ok: true, query: { stock_pct_kits: 40 } });
    await user.clear(kits);
    await user.tab();
    expect(kits).not.toHaveAttribute("aria-invalid");
    expect(allocation()).toEqual({ ok: true, query: {} });
  });

  it("changes the assumed effect and the ROI option", async () => {
    const user = userEvent.setup();
    renderControls();
    await user.selectOptions(screen.getByLabelText(s.effectLabel), "high");
    expect(screen.getByLabelText(s.effectLabel)).toHaveValue("high");
    await user.click(screen.getByLabelText(s.roiLabel));
    expect(screen.getByLabelText(s.roiLabel)).toBeChecked();
  });

  it("resets every assumption (and clears shown errors) without changing the planning week", async () => {
    const user = userEvent.setup();
    renderControls("en", { issueDate: "2025-07-28" });
    await user.clear(screen.getByLabelText(s.stockLabel));
    await user.type(screen.getByLabelText(s.stockLabel), "999");
    await user.tab();
    await user.click(screen.getByLabelText(s.roiLabel));
    await user.click(screen.getByRole("button", { name: s.resetAll }));
    expect(screen.getByLabelText(s.stockLabel)).toHaveValue("100");
    expect(screen.getByLabelText(s.stockLabel)).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText(s.roiLabel)).not.toBeChecked();
    expect(within(screen.getByRole("region", { name: s.title })).getByRole("status")).toBeEmptyDOMElement();
    expect(allocation()).toEqual({ ok: true, query: { issue_date: "2025-07-28" } });
  });

  it("makes no network request, whatever is changed or reset", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderControls();
    await user.clear(screen.getByLabelText(s.stockLabel));
    await user.type(screen.getByLabelText(s.stockLabel), "70");
    await user.click(screen.getByText(s.overridesSummary));
    await user.type(screen.getByLabelText(s.salineLabel), "50");
    await user.selectOptions(screen.getByLabelText(s.effectLabel), "low");
    await user.click(screen.getByLabelText(s.roiLabel));
    await user.click(screen.getByRole("button", { name: s.resetAll }));
    await user.click(screen.getByRole("button", { name: s.resetInfoLabel }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- info buttons and keyboard
describe("scenario controls information and keyboard", () => {
  it("keeps the reset action and its info button independent", async () => {
    const user = userEvent.setup();
    renderControls();
    await user.clear(screen.getByLabelText(s.totalCrewsLabel));
    await user.type(screen.getByLabelText(s.totalCrewsLabel), "5");
    const info = screen.getByRole("button", { name: s.resetInfoLabel });
    const reset = screen.getByRole("button", { name: s.resetAll });
    expect(info.parentElement?.parentElement).toBe(reset.parentElement); // siblings in .action-with-info
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(popoverOf(info)).toHaveTextContent(s.resetInfoBody);
    expect(screen.getByLabelText(s.totalCrewsLabel)).toHaveValue("5"); // explaining did not reset
    await user.click(reset);
    expect(screen.getByLabelText(s.totalCrewsLabel)).toHaveValue("60");
    expect(info).toHaveAttribute("aria-expanded", "false"); // pressing the action closed the explanation
    expect(reset).toHaveAttribute("type", "button");
  });

  it("explains each group's assumptions with its own info button, one open at a time", async () => {
    const user = userEvent.setup();
    renderControls();
    const supplies = screen.getByRole("button", { name: s.suppliesInfoLabel });
    const hospitalInfo = screen.getByRole("button", { name: s.hospitalInfoLabel });
    const intervention = screen.getByRole("button", { name: s.interventionInfoLabel });
    await user.click(supplies);
    expect(popoverOf(supplies)).toHaveTextContent(s.suppliesInfoBody);
    await user.click(hospitalInfo);
    expect(supplies).toHaveAttribute("aria-expanded", "false");
    expect(popoverOf(hospitalInfo)).toHaveTextContent(s.hospitalInfoBody);
    await user.keyboard("{Escape}");
    expect(hospitalInfo).toHaveAttribute("aria-expanded", "false");
    expect(hospitalInfo).toHaveFocus();
    await user.click(intervention);
    expect(popoverOf(intervention)).toHaveTextContent(s.interventionInfoBody);
    // info buttons sit beside group headings, never inside a label
    for (const b of screen.getAllByRole("button", { name: /^About / })) expect(b.closest("label, legend, select")).toBeNull();
  });

  it("reaches the advanced overrides with the keyboard through a native disclosure", async () => {
    const user = userEvent.setup();
    renderControls("en", { groups: ["supplies"] });
    // order: the group's info button (in its heading row), the stock box, then the disclosure
    await user.tab();
    expect(screen.getByRole("button", { name: s.suppliesInfoLabel })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(s.stockLabel)).toHaveFocus();
    await user.tab();
    const summary = screen.getByText(s.overridesSummary);
    expect(summary).toHaveFocus();
    expect(summary.tagName).toBe("SUMMARY"); // Enter/Space toggling is the browser's own; jsdom does not emulate it
    await user.click(summary);
    expect(summary.closest("details")!.open).toBe(true);
    await user.tab();
    expect(screen.getByLabelText(s.salineLabel)).toHaveFocus();
  });
});

// ---------------------------------------------------------------- Bangla
describe("scenario controls in Bangla", () => {
  it("has identical keys in both languages and real Bangla text", () => {
    expect(Object.keys(bn.scenario).sort()).toEqual(Object.keys(en.scenario).sort());
    for (const [k, v] of Object.entries(bn.scenario)) {
      const text = typeof v === "function" ? (v as (a: string, b: string) => string)("১", "২") : v;
      expect(/[ঀ-৿]/.test(text), k).toBe(true);
    }
  });

  it("renders Bangla labels, hints and errors with Bangla digits, and accepts Bangla digits", async () => {
    const user = userEvent.setup();
    renderControls("bn");
    const b = bn.scenario;
    expect(screen.getByRole("region", { name: b.title })).toHaveTextContent(b.lead);
    const stock = screen.getByLabelText(b.stockLabel);
    expect(stock).toHaveAccessibleDescription(b.stockHint("৩০", "১০০"));
    await user.clear(stock);
    await user.type(stock, "২০");
    await user.tab();
    expect(stock).toHaveAccessibleDescription(`${b.stockHint("৩০", "১০০")} ${b.errOutOfRange("৩০", "১০০")}`);
    await user.clear(stock);
    await user.type(stock, "৮০");
    await user.tab();
    expect(stock).toHaveValue("80");
    expect(allocation()).toEqual({ ok: true, query: { stock_pct: 80 } });
    expect(screen.getByRole("button", { name: b.resetAll })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: b.effectBase })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- styles and isolation
async function readStyles(): Promise<string> {
  const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { readFileSync(path: string, encoding: "utf8"): string };
  return fs.readFileSync("src/styles.css", "utf8");
}

describe("scenario controls styles and isolation", () => {
  it("uses existing tokens only, flows into one column on narrow screens, and respects reduced motion", async () => {
    const css = await readStyles();
    const block = css.slice(css.indexOf("/* ---------- planning scenario controls"));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|gradient|box-shadow/);
    expect(block).toMatch(/\.scenario-groups \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 17rem\), 1fr\)\)/);
    expect(block).toMatch(/\.scenario \{[^}]*min-width: 0;/);
    expect(block).toMatch(/\.scenario-input input \{[^}]*max-width: 100%;/);
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.scenario-input input \{\s*transition: none/);
    for (const token of ["--paper: #eff3ee", "--surface: #fafcf9", "--ink: #12302f", "--teal: #0e4f54", "--aqua-soft: #d6ece8", "--focus: #0a6a75", "--crit-bg: #a63429"]) {
      expect(css).toContain(token);
    }
  });

  it("is not mounted in the current dashboard", async () => {
    render(<App client={fakeClient()} />);
    await screen.findByRole("heading", { name: "DNCC Ward 12" });
    expect(screen.queryByRole("region", { name: s.title })).toBeNull();
    expect(document.querySelector(".scenario")).toBeNull();
    expect(screen.queryByText(s.lead)).toBeNull();
  });
});
