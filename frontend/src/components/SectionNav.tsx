import { useI18n } from "../i18n/I18n";

/*
 * Feature-level section navigation (approved "hybrid tabs": one horizontal strip on desktop, the same strip
 * scrolling sideways on narrow screens, no sidebar).
 *
 * Semantics: a <nav> landmark with a list. Available sections are plain buttons and the current one carries
 * aria-current="page". This is deliberately NOT an ARIA tablist: each section replaces the page's main content like
 * a page of its own (shared week/ward controls stay above it), which is navigation, so Tab/Enter/Space on native
 * buttons is the whole keyboard model and there are no half-implemented tab roles. Planned sections are plain
 * text with a visible "Not yet available" tag, never buttons (enabled or disabled), so nothing can be focused,
 * pressed or selected as if it worked. What each planned section will hold is explained in a native
 * <details> below the strip, readable without hover and without focusing a disabled control.
 */

export type SectionId = "overview" | "weekly" | "resources" | "hospitals" | "interventions" | "dispatch";

type BodyKey = "weeklyBody" | "resourcesBody" | "hospitalsBody" | "interventionsBody" | "dispatchBody";

export interface SectionDef {
  id: SectionId;
  available: boolean;
  /** Dictionary key of the planned-section explanation (planned sections only). */
  body?: BodyKey;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: "overview", available: true },
  { id: "weekly", available: true },
  { id: "resources", available: false, body: "resourcesBody" },
  { id: "hospitals", available: false, body: "hospitalsBody" },
  { id: "interventions", available: false, body: "interventionsBody" },
  { id: "dispatch", available: false, body: "dispatchBody" },
];

export function isSectionAvailable(id: SectionId): boolean {
  return SECTIONS.some((s) => s.id === id && s.available);
}

export function SectionNav({ current, onSelect }: { current: SectionId; onSelect: (id: SectionId) => void }) {
  const { t } = useI18n();
  const planned = SECTIONS.filter((s) => !s.available);
  return (
    <nav className="section-nav" aria-labelledby="section-nav-title">
      <div className="section-nav-inner">
        <h2 id="section-nav-title" className="sr-only">
          {t.nav.label}
        </h2>
        <ul className="section-tabs">
          {SECTIONS.map((s) =>
            s.available ? (
              <li key={s.id} className="section-tab-item">
                <button
                  type="button"
                  className="section-tab"
                  data-section={s.id}
                  aria-current={s.id === current ? "page" : undefined}
                  onClick={() => onSelect(s.id)}
                >
                  {t.nav[s.id]}
                </button>
              </li>
            ) : (
              <li key={s.id} className="section-tab-item is-planned" data-section={s.id}>
                <span className="section-tab-label">{t.nav[s.id]}</span>
                <span className="sr-only">, </span>
                <span className="section-tab-status">{t.nav.planned}</span>
              </li>
            ),
          )}
        </ul>
        <details className="section-plans">
          <summary>{t.nav.plansSummary}</summary>
          <div className="section-plans-body">
            <p>{t.nav.plansLead}</p>
            <dl>
              {planned.map((s) => (
                <div key={s.id} className="section-plan">
                  <dt>{t.nav[s.id]}</dt>
                  <dd>{s.body ? t.nav[s.body] : ""}</dd>
                </div>
              ))}
            </dl>
          </div>
        </details>
      </div>
    </nav>
  );
}
