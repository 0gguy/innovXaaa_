import { useId, useState, type ReactNode } from "react";
import type { InterventionScenario } from "../api/types";
import { INTERVENTION_SCENARIOS } from "../api/types";
import { useI18n } from "../i18n/I18n";
import { NUMERIC_SPECS, parseField, type FieldErrorCode, type NumericField, type ScenarioApi } from "../scenario/scenario";
import { InfoButton } from "./InfoButton";

/*
 * Reusable planning-scenario controls for the future Phase 2 sections. NOT mounted in the current dashboard: a
 * planning section will render it with the groups it needs, e.g. <ScenarioControls scenario={s} groups={["hospital"]} />.
 *
 * It only edits scenario state (see scenario/scenario.ts). It never requests or computes planning results.
 * Numeric boxes are text inputs with a numeric keypad, so a half-typed value stays visible as typed; errors are
 * shown after the user leaves the box and are tied to it with aria-describedby / aria-invalid.
 */

export type ScenarioGroup = "supplies" | "crews" | "hospital" | "intervention";
export const SCENARIO_GROUPS: readonly ScenarioGroup[] = ["supplies", "crews", "hospital", "intervention"];

interface Props {
  scenario: ScenarioApi;
  /** Which groups this section needs, in this order. Default: all four. */
  groups?: readonly ScenarioGroup[];
}

export function ScenarioControls({ scenario, groups = SCENARIO_GROUPS }: Props) {
  const { t, date } = useI18n();
  const s = t.scenario;
  const titleId = useId();
  const [touched, setTouched] = useState<ReadonlySet<NumericField>>(() => new Set());
  const { state } = scenario;

  const errorOf = (field: NumericField): FieldErrorCode | null => {
    const p = parseField(field, state.text[field]);
    return !p.ok && touched.has(field) ? p.error : null;
  };
  const leave = (field: NumericField) => {
    setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
    scenario.normalize(field);
  };
  const fields = (g: ScenarioGroup): NumericField[] =>
    g === "supplies" ? ["stockPct", "stockPctSaline", "stockPctKits"] : g === "crews" ? ["minCoveragePct", "totalCrews"] : g === "hospital" ? ["capacityPct"] : [];
  const anyShownError = groups.some((g) => fields(g).some((f) => errorOf(f) !== null));

  const num = (field: NumericField, label: string, hint: (min: string, max: string) => string, unit: "%" | null) => (
    <NumberField
      key={field}
      field={field}
      label={label}
      hint={hint}
      unit={unit}
      text={state.text[field]}
      error={errorOf(field)}
      onChange={(v) => scenario.setText(field, v)}
      onLeave={() => leave(field)}
    />
  );

  return (
    <section className="scenario" aria-labelledby={titleId}>
      <div className="scenario-head">
        <h3 id={titleId}>{s.title}</h3>
        <p className="scenario-lead">{s.lead}</p>
        <p className="scenario-week">
          <span className="scenario-week-label">{s.issueLabel}: </span>
          {state.issueDate ? s.issueChosen(date(state.issueDate)) : s.issueLatest}
        </p>
      </div>

      <p className="scenario-invalid" role="status" aria-live="polite">
        {anyShownError ? s.invalidNote : ""}
      </p>

      <div className="scenario-groups">
        {groups.map((g) => {
          if (g === "supplies")
            return (
              <Group key={g} title={s.suppliesTitle} infoLabel={s.suppliesInfoLabel} infoBody={s.suppliesInfoBody}>
                {num("stockPct", s.stockLabel, s.stockHint, "%")}
                <details className="scenario-more">
                  <summary>{s.overridesSummary}</summary>
                  <div className="scenario-more-body">
                    <p className="scenario-hint">{s.overridesLead}</p>
                    {num("stockPctSaline", s.salineLabel, s.overrideHint, "%")}
                    {num("stockPctKits", s.kitsLabel, s.overrideHint, "%")}
                  </div>
                </details>
              </Group>
            );
          if (g === "crews")
            return (
              <Group key={g} title={s.crewsTitle} infoLabel={s.crewsInfoLabel} infoBody={s.crewsInfoBody}>
                {num("minCoveragePct", s.minCoverageLabel, s.minCoverageHint, "%")}
                {num("totalCrews", s.totalCrewsLabel, s.totalCrewsHint, null)}
              </Group>
            );
          if (g === "hospital")
            return (
              <Group key={g} title={s.hospitalTitle} infoLabel={s.hospitalInfoLabel} infoBody={s.hospitalInfoBody}>
                {num("capacityPct", s.capacityLabel, s.capacityHint, "%")}
              </Group>
            );
          return (
            <Group key={g} title={s.interventionTitle} infoLabel={s.interventionInfoLabel} infoBody={s.interventionInfoBody}>
              <EffectSelect value={state.interventionScenario} onChange={scenario.setInterventionScenario} />
              <RoiCheckbox value={state.includeRoiAlternative} onChange={scenario.setIncludeRoiAlternative} />
            </Group>
          );
        })}
      </div>

      <div className="action-with-info scenario-actions">
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            scenario.resetAssumptions();
            setTouched(new Set());
          }}
        >
          {s.resetAll}
        </button>
        <InfoButton label={s.resetInfoLabel} title={s.resetAll} description={s.resetInfoBody} />
      </div>
    </section>
  );
}

function Group({ title, infoLabel, infoBody, children }: { title: string; infoLabel: string; infoBody: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="scenario-group" role="group" aria-labelledby={id}>
      <div className="scenario-group-head">
        <h4 id={id}>{title}</h4>
        <InfoButton label={infoLabel} title={title} description={infoBody} />
      </div>
      {children}
    </div>
  );
}

function NumberField(props: {
  field: NumericField;
  label: string;
  hint: (min: string, max: string) => string;
  unit: "%" | null;
  text: string;
  error: FieldErrorCode | null;
  onChange: (text: string) => void;
  onLeave: () => void;
}) {
  const { t, int } = useI18n();
  const id = useId();
  const spec = NUMERIC_SPECS[props.field];
  const [min, max] = [int(spec.min), int(spec.max)];
  const message =
    props.error === "required"
      ? t.scenario.errRequired
      : props.error === "notNumber"
        ? t.scenario.errNotNumber
        : props.error === "notWhole"
          ? t.scenario.errNotWhole
          : props.error === "outOfRange"
            ? t.scenario.errOutOfRange(min, max)
            : null;
  return (
    <div className="field scenario-field">
      <label htmlFor={id}>{props.label}</label>
      <div className="scenario-input">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={props.text}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${id}-hint ${id}-error` : `${id}-hint`}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onLeave}
        />
        {props.unit && (
          <span className="scenario-unit" aria-hidden="true">
            {props.unit}
          </span>
        )}
      </div>
      <p id={`${id}-hint`} className="scenario-hint">
        {props.hint(min, max)}
      </p>
      {message && (
        <p id={`${id}-error`} className="scenario-error">
          {message}
        </p>
      )}
    </div>
  );
}

function EffectSelect({ value, onChange }: { value: InterventionScenario; onChange: (v: InterventionScenario) => void }) {
  const { t } = useI18n();
  const id = useId();
  const label: Record<InterventionScenario, string> = { low: t.scenario.effectLow, base: t.scenario.effectBase, high: t.scenario.effectHigh };
  return (
    <div className="field scenario-field">
      <label htmlFor={id}>{t.scenario.effectLabel}</label>
      <select
        id={id}
        value={value}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          const v = e.target.value as InterventionScenario;
          if (INTERVENTION_SCENARIOS.includes(v)) onChange(v);
        }}
      >
        {INTERVENTION_SCENARIOS.map((x) => (
          <option key={x} value={x}>
            {label[x]}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="scenario-hint">
        {t.scenario.effectHint}
      </p>
    </div>
  );
}

function RoiCheckbox({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="scenario-check">
      <input id={id} type="checkbox" checked={value} aria-describedby={`${id}-hint`} onChange={(e) => onChange(e.target.checked)} />
      <div>
        <label htmlFor={id}>{t.scenario.roiLabel}</label>
        <p id={`${id}-hint`} className="scenario-hint">
          {t.scenario.roiHint}
        </p>
      </div>
    </div>
  );
}
