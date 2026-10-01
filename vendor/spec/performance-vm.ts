/**
 * PRUAction — Performance (P4) View Models
 * Contract C3: Next.js BFF → UI (CDK widgets)
 *
 * @version 1.8.0  (S-P4-07 "My Team" + dashboard viewing mode — see CHANGES below)
 * @module domains/insights/bff/performance-vm
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BFF ROUTE TABLE (Next.js route handlers)
 * ─────────────────────────────────────────────────────────────────────────────
 * | Route (app router)                                  | Returns                | Composes (domain ops)                                   |
 * |-----------------------------------------------------|------------------------|---------------------------------------------------------|
 * | GET  /api/bff/v1/performance/dashboard              | PerformanceDashboardVM | listAgentMetrics + listMilestoneProgress                |
 * |        ?period&businessLine&basis&scope&teamView    |                        | + listRecommendations + screen config (C4)              |
 * | GET  /api/bff/v1/performance/metrics/:metricCode    | MetricDetailVM         | getMetricDetail + listMetricDefinitions (capabilities)  |
 * |        ?period&businessLine&basis&scope&teamView    |                        |                                                         |
 * | GET  /api/bff/v1/performance/metrics/:metricCode/history | MetricHistoryVM   | getMetricSeries + config (history windows/tabs)         |
 * |        ?businessLine&basis&scope&teamView&anchorYear&yearsBack |             |   (yearsBack=0 ⇒ Current Year + MoM deltas, D-11)       |
 * | GET  /api/bff/v1/performance/historical-data        | HistoricalDataVM       | getAgentMonthlyHistory + historicalData config (C4)     |
 * |        ?metricCode&variant&comparison&businessLine |                        |   (S-P4-03 v2.0.0 Team Historical Data, ARVIJ-1450;     |
 * |        &teamView&basis&scope=TEAM                   |                        |   leaders only, GROUP needs P2)                         |
 * | GET  /api/bff/v1/performance/customize?scope        | CustomizeMetricsVM     | listMetricDefinitions + getMetricPreferences            |
 * | PUT  /api/bff/v1/performance/customize?scope        | CustomizeMetricsVM     | putMetricPreferences                                    |
 * | POST /api/bff/v1/performance/recommendations/:id/feedback | 204            | submitRecommendationFeedback                            |
 * | GET  /api/bff/v1/performance/team-drilldown         | TeamDrilldownVM        | listTeamMembers (+ getTeamMemberDashboard when           |
 * |        ?teamView&basis&query&sortBy&badges          |                        |   selectedAgentId) + team-drilldown config (C4)          |
 * |        &parentAgentId&period&businessLine           |                        |                                                         |
 * |        &performanceBasis&selectedAgentId            |                        |                                                         |
 * | GET  /api/bff/v1/performance/dashboard              | PerformanceDashboardVM | as above, for `subjectAgentId` after proving it is in   |
 * |        …&subjectAgentId (v1.8.0 viewing mode)       |   + `viewing`          |   the caller's downline (else 403 BFF-4033)             |
 *
 * v1.8.0 CHANGES (SPEC-2026-004 · S-P4-07 0.2.0 + S-P4-01 2.1.0):
 *  - BREAKING (DRAFT S-P4-07 surface only): `TeamDrilldownFiltersVM.basis`
 *    becomes optional — absent means all hierarchy levels. Everything else
 *    below is additive.
 *  - Team Drilldown "My Team" card data: optional `TeamMemberVM.badges`,
 *    `goalStatus`, `tpc`, `ptpc`, `directReportCount`, `photoUrl`, `nav`.
 *  - `TeamDrilldownVM.summary` (KPI tiles over the FILTERED set, D-P4-07-02),
 *    `parent` (subteam drawer header) and `filterOptions` (Sort By + badge
 *    groups from C4). Filters gain `sortBy`, `badges`, `parentAgentId`.
 *  - `PerformanceDashboardVM.viewing` — a leader viewing a downline member's
 *    dashboard ("Viewing {name}" banner + Exit View). Scope follows the
 *    member's role (D-P4-07-03); read-only.
 *  - Member card fields have no approved upstream source (OQ-79): the BFF
 *    omits them in source mode and never synthesizes them.
 *
 * v1.5.1 CHANGES (closes README `OQ-25` — SPEC-2026-003, no shape change):
 *  - `MetricCardVM.valueDisplay` was recorded in v1.5.1 documenting a field
 *    the shipped app already consumed, without approving an abbreviation
 *    policy. That policy is now decided: `w.metric.card` (S-P4-01) renders
 *    every MONEY value compact regardless of this field; the field still
 *    governs COUNT/PERCENT/DECIMAL (default FULL) and is otherwise unused.
 *    See the field's own doc comment and widget-contracts.md.
 *
 * v1.1.0 CHANGES (all additive):
 *  - `scope` (SELF|TEAM) + `teamView` (DIRECT|GROUP) filter dimensions and
 *    the header persona switcher (`ScopeSwitcherVM`).
 *  - `DecimalValue` scalar kind (PRODUCTIVITY 9.7) and `DeltaVM.abs`
 *    (+RM 20,000 / +7 / +0.4) with `DeltaVM.display` selector.
 *  - Dashboard: `focusMetrics` card row ("Other Focus Metrics (2)"),
 *    `moreActions` sheet (Set Goals / Customize / History), expanded
 *    `RecommendationsPanelVM` (AI panel).
 *  - Metric detail: `BarComparisonSectionVM` (Manpower / New Recruit bars).
 *  - History: `window` (CURRENT_YEAR|VS_LAST_YEAR|VS_LAST_2_YEARS),
 *    `momDeltas` column, `moreTabs` overflow.
 *
 * v1.2.0 CHANGES (P4 uplift, all additive):
 *  - MetricDetailVM: `dataState` (OK|PROCESSING|EMPTY full-screen states)
 *    and `notices[]` (dismissible data-gap banners).
 *  - Period selector is a bottom sheet; `filters.periodOptionsMeta` carries
 *    each option's window start ("MTD · 1 Jul 2026 – Today"). MTD in MY.
 *  - MoM column header follows the metric's `display`
 *    (PCT → "MoM % Change", else "MoM Delta").
 *
 * v1.5.0 CHANGES (upstream source onboarding — data/source-mapping.md C0):
 *  - `MetricCardVM.value` becomes OPTIONAL and `dataState`
 *    (OK|PROCESSING|EMPTY, default OK) is added — BREAKING for consumers:
 *    they MUST handle an absent `value` when `dataState !== 'OK'`.
 *    Rationale: a catalogued metric may have no approved upstream source
 *    (e.g. FYC arrives typed null). Such a card is emitted with its
 *    `metricCode`, `valueType` and `nav` intact so the metric stays visible
 *    and navigable, instead of being silently dropped from the dashboard.
 *    Mirrors the `MetricDetailVM.dataState` vocabulary added in v1.2.0.
 *  - `MetricCardVM.notices?` — same `NoticeVM` shape the detail screen uses,
 *    for per-card data-gap messaging (e.g. a missing product feed).
 *  - No layer may substitute a zero or synthesized value for a missing one
 *    (C1 §7.12).
 *
 * v1.7.0 CHANGES (S-P4-02 v1.19.0, Penders card link — additive):
 *  - `PendersSectionVM.nav?: RouteRef` (optional). A placeholder for the
 *    Activity Management Proposal-screen link. The destination is still
 *    open (`OQ-30`), so the BFF MUST omit it until that is answered. The UI
 *    renders the link face either way and navigates only when `nav` is
 *    present (`AC-P4-02-56`/`-57`).
 *
 * v1.6.0 CHANGES (S-P4-02 v1.13.0, ARVIJ-159 Team Manpower — additive):
 *  - `BarComparisonSectionVM.layout?` ('GROUPED' | 'STACKED', default
 *    GROUPED) and `BarComparisonSectionVM.totals?` (required when STACKED).
 *    MANPOWER now emits STACKED EXISTING_AGENTS + NEW_RECRUITS (superseding
 *    grouped OPENING/CLOSING); the per-year total and its delta chip come
 *    from `totals[]`, never summed client-side. NEW_RECRUIT_CONTRACTED is
 *    unaffected (layout absent ⇒ GROUPED rules, single measure).
 *  - Semantics only: MANPOWER `DeltaVM.display` is PCT (catalog flip from
 *    ABS) and its `pct` follows the shared round-away-from-zero rule
 *    (widget-contracts.md §2 `R-PCT-ROUNDUP`) — applied by the producer.
 *
 * v1.4.0 CHANGES (desktop layout, screenshot-derived — legacy-contract.md A6/A7):
 *  - `focusMetrics` becomes `{ visible, addEnabled, items }` (was a bare
 *    array) — BREAKING. `addEnabled` drives a "+" affordance when `items=[]`
 *    and `visible=true` (was: hide entirely when empty, AC-P4-01-17→26/27).
 *  - No new fields for the desktop Filter action / summary pills — the BFF
 *    contract (`filters.*`) is unchanged; only the UI's presentation of the
 *    existing period/businessLine/basis/teamView filters differs at ≥1024px
 *    (AC-P4-01-28/29).
 *
 * v1.3.0 CHANGES (rulings 2026-08 — no type changes, semantics only):
 *  - `basis` is an AGENT-SEGMENT lens: SCHEME = Prudential-employed
 *    full-time agents. Toggling re-composes priority/focus sets, ordering
 *    and goals from catalog `segmentOverrides`; card lists may differ
 *    between STANDARD and SCHEME payloads.
 *  - `basisToggleVisible` / `teamViewToggleVisible` are computed by the BFF
 *    as config flag AND caller entitlement: the Group toggle renders only
 *    for P2-level leaders (P3 = DIRECT-only; API 403s GROUP for P3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULES (mirror repo decisions D-03/D-04/D-05/D-08)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. VMs carry DATA + SEMANTICS only — never presentation strings.
 *    Labels resolve in the UI from codes via i18n (`insights.metric.TPC.title`,
 *    `insights.variant.WITHOUT_REPRICING`, `insights.delta.vsLY`, …).
 * 2. Money stays a decimal string; DLS `formatMoney(scalar, locale)` renders it.
 * 3. `sentiment` arrives from the domain; UI maps it to DLS tone tokens
 *    (POSITIVE → tone.success, NEGATIVE → tone.danger, NEUTRAL → tone.muted).
 * 4. Section/`card` composition is decided by the BFF from config (C4) +
 *    metric capabilities; the UI renders `sections[]` in order and never
 *    re-derives layout. Unknown section/card types must be skipped (forward
 *    compatibility).
 * 5. Every VM includes `meta` for cache/version/trace plumbing.
 */

/* ────────────────────────────── Primitives ─────────────────────────────── */

export type PeriodType = "MTD" | "QTD" | "YTD";
export type BusinessLine = "ALL" | "INSURANCE" | "TAKAFUL";
export type Basis = "STANDARD" | "SCHEME";
/** Whose numbers: the agent's own or their team's (Agent Leader). */
export type Scope = "SELF" | "TEAM";
/** Team roll-up breadth — the "Group" toggle (only meaningful when scope = TEAM). */
export type TeamView = "DIRECT" | "GROUP";
export type Variant = "WITHOUT_REPRICING" | "WITH_REPRICING";
export type Sentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL";
export type TrendDirection = "UP" | "DOWN" | "FLAT";

/** ISO 8601 date, e.g. "2026-07-27" */
export type IsoDate = string;

export interface MoneyValue {
  kind: "MONEY";
  /** Decimal string, ≤2 dp — format with DLS formatters, never parseFloat for display. */
  amount: string;
  /** ISO 4217, e.g. "MYR" */
  currency: string;
}
export interface CountValue {
  kind: "COUNT";
  value: number;
}
export interface PercentValue {
  kind: "PERCENT";
  /** 0–100 scale (95 ⇒ 95%). */
  value: number;
}
export interface DecimalValue {
  kind: "DECIMAL";
  /** Unitless ratio, e.g. PRODUCTIVITY 9.7 (cases / active agent). */
  value: number;
  /** Suggested display precision (default 1). */
  precision?: number;
}
/** Discriminated union used for every metric value (D-03). */
export type MetricScalar =
  | MoneyValue
  | CountValue
  | PercentValue
  | DecimalValue;

export interface DeltaVM {
  comparisonBasis: "LAST_YEAR" | "LAST_MONTH" | "LAST_2_YEARS";
  direction: TrendDirection;
  /** Drives badge tone; computed by the domain (D-05) — or by the BFF from
   *  catalog `favourability` for month-over-month deltas (D-11). */
  sentiment: Sentiment;
  /** Which field the badge renders — from catalog `changeDisplay` (D-10). */
  display: "PCT" | "PP" | "ABS";
  /** "+27% vs LY". Already rounded by the producer for metrics opted into
   *  widget-contracts.md §2 `R-PCT-ROUNDUP` (MANPOWER, v1.6.0; ACTIVITY_RATIO,
   *  S-P4-02 v1.14.0 — a relative % of the ratio, not a pp difference;
   *  PRODUCTIVITY, S-P4-02 v1.15.0 — a relative % of the decimal value, not
   *  the absolute difference; AVERAGE_CASE_SIZE, S-P4-02 v1.16.0 — a
   *  relative % of the money amount) — render as-is, never re-round. */
  pct?: number;
  /** "+2pp". */
  pp?: number;
  /** "+7" — absolute delta as a scalar. PRODUCTIVITY's "+0.4" moved to `pct`
   *  in S-P4-02 v1.15.0 and AVERAGE_CASE_SIZE's "+RM 20,000" in v1.16.0. */
  abs?: MetricScalar;
}

export interface GoalVM {
  state: "SET" | "NOT_SET";
  target?: MetricScalar;
  /** 0–100+, present only when state = SET. */
  progressPct?: number;
}

export interface VMeta {
  screenId: string; // "S-P4-01" …
  specVersion: string; // screen spec version this payload conforms to
  configVersion: string; // domains/insights/config/countries/{cc} version applied
  country: string; // "MY"
  asOfDate: IsoDate; // data watermark → "As of 27 Jul 2026"
  generatedAt: string; // ISO date-time
  traceId: string;
  /** True when a sub-source failed and the BFF degraded the payload. */
  partial: boolean;
  /** Section ids omitted due to upstream failure (UI shows section-level error slots). */
  failedSections?: string[];
}

/** Navigation is expressed as route tokens resolved by the app shell router. */
export interface RouteRef {
  route: string; // e.g. "insights/metric-detail"
  params?: Record<string, string>; // e.g. { metricCode: "TPC" }
}

/* ─────────────────────── S-P4-01 · Performance Dashboard ────────────────── */

export interface QuickLinkVM {
  id: string; // "MILESTONES" | "INTRODUCER_DRILLDOWN" | "COMP_BEN" | "LEADERBOARD" | "VIEW_MOC" …
  iconToken: string; // DLS icon token from config
  nav: RouteRef;
  order: number;
  badgeCount?: number;
}

export interface RecommendationsEntryVM {
  visible: boolean;
  count: number;
  nav: RouteRef;
  /** Expanded AI panel payload (v1.1.0). Absent ⇒ banner navigates via `nav`. */
  panel?: RecommendationsPanelVM;
}

/* Expanded "Performance Recommendations" panel (widget `w.reco.panel`). */
export interface RecoFlagVM {
  code: string; // i18n: insights.reco.flag.{code}
  severity: "INFO" | "WARNING" | "CRITICAL";
}
export interface RecoHighlightVM {
  metricCode: string;
  achieved: MetricScalar; // "152K TPC secured"
  goal?: GoalVM; // "200K Goal (76%)" + progress bar
  /** Signed % vs expected run-rate → "8% above run-rate". */
  runRateDeltaPct?: number;
}
export interface RecoInsightVM {
  code: string; // stable id (analytics/feedback)
  titleCode: string; // i18n: insights.reco.insight.{titleCode}
  metricCode?: string;
  trend?: { direction: TrendDirection; sentiment: Sentiment; text: string };
  /** Engine-generated narrative (pre-localised). */
  narrative?: string;
  nav?: RouteRef;
}
export interface RecommendationsPanelVM {
  recommendationId: string; // feedback target
  flags: RecoFlagVM[];
  highlight?: RecoHighlightVM;
  insights: RecoInsightVM[];
  cta?: { labelCode: string; nav: RouteRef }; // "View Team Drilldown"
  generatedAt: string; // "Generated on 2026-07-13 at 02:06"
  feedback?: "UP" | "DOWN"; // previously submitted rating
}

export interface DashboardFiltersVM {
  period: PeriodType;
  periodOptions: PeriodType[]; // from config, e.g. ["QTD","YTD"]
  businessLine: BusinessLine;
  businessLineOptions: BusinessLine[]; // tab order, e.g. ["ALL","INSURANCE","TAKAFUL"]
  basis: Basis;
  basisToggleVisible: boolean; // "Scheme" segment toggle = config ∧ entitlement (OQ-20)
  /**
   * Per-option period windows for the "Time Period" bottom sheet subtitles
   * ("1 Jul 2026 - Today"). BFF-supplied so clients never do fiscal math.
   */
  periodOptionsMeta?: Array<{ period: PeriodType; startDate: IsoDate }>;
  scope: Scope;
  teamView?: TeamView; // present when scope = TEAM
  teamViewToggleVisible: boolean; // "Group" toggle = config ∧ leader level P2
}

/** Header persona switcher (avatar dropdown, top-right). Absent for non-leaders. */
export interface ScopeSwitcherVM {
  current: Scope;
  /** S-P4-01 v1.5.18: P2 + TEAM config capability, supplied even in SELF
   * so the mobile View sheet can stage TEAM/GROUP before its single Apply.
   * Absent means no Direct/Group selector; never grants API authorization. */
  teamViewOptions?: TeamView[];
  options: Array<{
    scope: Scope; // i18n: insights.scope.{SELF|TEAM}
    /** Secondary lines in the dropdown item (name / unit), pre-resolved. */
    subValues?: string[];
  }>;
}

/** Props contract for widget `w.metric.card` (see widget-contracts.md). */
export interface MetricCardVM {
  metricCode: string; // i18n: insights.metric.{code}.title
  valueType: MetricScalar["kind"];
  /** Shown as subtitle when present — i18n: insights.variant.{variant}. */
  variant?: Variant;
  /**
   * OK ⇒ `value` present. PROCESSING (batch in flight) / EMPTY (no approved
   * upstream source, or batch complete with no data) ⇒ `value` absent and the
   * widget renders a compact state. Defaults to OK when omitted. C1 §7.13.
   */
  dataState?: MetricDetailVM["dataState"];
  /** Absent when `dataState !== 'OK'` — never zero-filled or synthesized. */
  value?: MetricScalar;
  /**
   * Whether the widget renders `value` in full or abbreviated form
   * ("RM 960,000" vs "960K"). Defaults to FULL when omitted.
   *
   * Resolved (v1.5.1, closes README `OQ-25`, SPEC-2026-003): for MONEY
   * values, `w.metric.card` (S-P4-01 dashboard, both `compact`/Priority and
   * `simple`/Other Focus faces) always renders compact — no currency prefix,
   * "{n}K"/"{n}M", one decimal, half-up rounding — regardless of this field.
   * This field still governs COUNT/PERCENT/DECIMAL cards. Scope of this
   * field's override is this one widget. Metric Detail (S-P4-02 v1.17.0,
   * `AC-P4-02-54`) separately applies the same rule (widget-contracts §2
   * `R-MONEY-COMPACT`) to TPC/PTPC/FYC/FYP/AVERAGE_CASE_SIZE, keyed on
   * `context.metricCode`, with no VM field. Breakdown product rows are
   * excepted and show plain values (v1.18.0, `AC-P4-02-55`). Every other MONEY consumer keeps
   * `formatMoney` (D-04).
   */
  valueDisplay?: "FULL" | "COMPACT";
  /** Per-card data-gap banners, same shape as the detail screen's. */
  notices?: NoticeVM[];
  /** Goal row + progress bar. Widget hides both when `showGoal` = false (config, e.g. PTPC in MY). */
  showGoal: boolean;
  goal?: GoalVM;
  delta?: DeltaVM;
  nav: RouteRef; // → S-P4-02 with current filter context
}

/** Props contract for widget `w.milestone.card`. */
export interface MilestoneMeasureVM {
  measureCode: string; // i18n: insights.measure.{code}
  achieved: MetricScalar;
  target: MetricScalar;
}
export interface MilestoneCardVM {
  programCode: string; // i18n: insights.milestone.program.{code}
  variant: Variant; // subtitle, i18n: insights.variant.{variant}
  cycleYear: number;
  currentTierCode: string; // i18n: insights.milestone.tier.{code}
  nextTierCode?: string;
  progressPct: number;
  measures: MilestoneMeasureVM[];
  nav: RouteRef; // ↗ milestones detail (P2/P3 surface)
}

/** ⋯ / "More Action" bottom sheet items (widget `w.sheet.more-action`). */
export interface MoreActionVM {
  id: "SET_GOALS" | "CUSTOMIZE_METRICS" | "HISTORICAL_DATA" | (string & {});
  iconToken: string;
  nav: RouteRef;
  order: number;
}

/**
 * v1.8.0 (S-P4-01 viewing mode, D-P4-07-03). Present only when the leader
 * requested `subjectAgentId`: the payload is the MEMBER's dashboard, composed
 * in `scope` (SELF for an agent, TEAM/DIRECT for a member who leads a team).
 * Read-only: the BFF omits `scopeSwitcher`, restricts `quickLinks` to config
 * `viewing.quickLinks`, `moreActions` to non-mutating actions and sets
 * `focusMetrics.addEnabled=false` / `milestones.addEnabled=false`.
 */
export interface DashboardViewingVM {
  member: TeamMemberVM;
  scope: Scope;
  readOnly: true;
  /** "Exit View" / close → back to S-P4-07. */
  exitNav: RouteRef;
}

export interface PerformanceDashboardVM {
  meta: VMeta;
  filters: DashboardFiltersVM;
  /** v1.8.0 — present only in viewing mode. */
  viewing?: DashboardViewingVM;
  /** Present only for Agent Leaders (persona switcher in the header). */
  scopeSwitcher?: ScopeSwitcherVM;
  quickLinks: QuickLinkVM[];
  recommendations: RecommendationsEntryVM;
  /** Ordered per agent preferences (fallback: country default order). */
  priorityMetrics: MetricCardVM[];
  /**
   * "Other Focus Metrics (n)" card row (v1.1.0) — selected focus metrics
   * rendered as simple cards (value + delta, never goal).
   * v1.4.0: object shape (was a bare array) — `visible=false` (config
   * `focusCards.visible`) hides the section entirely; `items=[]` with
   * `visible=true` renders the header with a "+" affordance when
   * `addEnabled=true` (AC-P4-01-26/27), never both hidden and empty-visible.
   */
  focusMetrics: {
    visible: boolean;
    addEnabled: boolean;
    items: MetricCardVM[];
  };
  milestones: {
    visible: boolean;
    addEnabled: boolean; // "+" affordance
    setGoalEnabled: boolean; // "Set Goal" header action (v1.1.0)
    items: MilestoneCardVM[];
  };
  /** ⋯ overflow sheet actions, config-composed. */
  moreActions: MoreActionVM[];
  footerLinks: QuickLinkVM[]; // e.g. VIEW_MOC
}

/* ───────────────────────── S-P4-02 · Metric Detail ──────────────────────── */
/**
 * Section-driven screen. The BFF emits an ordered `sections[]`; the UI renders
 * each via its widget and skips unknown `type`s. Section presence =
 * capabilities ∩ config ∩ data availability.
 */

export interface DetailContextVM {
  metricCode: string;
  scope: Scope;
  /** "Direct" / "Group" chip — first chip on team drilldowns (v1.1.0). */
  teamView?: TeamView;
  businessLine: BusinessLine; // chip, i18n: insights.businessLine.{code}
  period: PeriodType; // chip
  basis: Basis;
  asOfDate: IsoDate; // "As of …"
}

/** Donut gauge: collected vs penders (widget `w.metric-detail.gauge`). */
export interface GaugeSectionVM {
  type: "GAUGE";
  id: string; // stable section id, e.g. "gauge.primary"
  variant?: Variant; // heading suffix ("TPC without repricing")
  collected: MetricScalar;
  penders?: MetricScalar;
}

/** Threshold gauge for PERCENT metrics (widget `w.metric-detail.threshold-gauge`). */
export interface ThresholdGaugeSectionVM {
  type: "THRESHOLD_GAUGE";
  id: string;
  current: PercentValue;
  threshold: { value: number; comparator: "GTE" | "LTE" };
  /** POSITIVE when threshold met — tints the arc/marker per DLS. */
  sentiment: Sentiment;
}

/** YoY card (widget `w.metric-detail.comparison`). */
export interface ComparisonSectionVM {
  type: "COMPARISON";
  id: string;
  variant?: Variant; // card heading suffix when applicable
  currentYear: number;
  current: MetricScalar;
  priorYear: number;
  prior: MetricScalar;
  change: DeltaVM; // "% Growth" (pct) or "Persistency Change" (pp)
}

/** Single-value card, e.g. "TPC With Repricing" (widget `w.metric-detail.variant-value`). */
export interface VariantValueSectionVM {
  type: "VARIANT_VALUE";
  id: string;
  variant: Variant; // heading, i18n: insights.variant.{variant}
  periodLabelYear: number; // "YTD 2026"
  value: MetricScalar;
}

/**
 * Penders card for count metrics (widget `w.metric-detail.penders`).
 * v1.7.0 (ARVIJ-19/157): for TPC/PTPC this section is emitted ONLY at
 * `scope=TEAM` — `value.kind` is COUNT (sum of all agents' Penders cases in
 * the selected teamView unit). At `scope=SELF` this section is never emitted
 * for TPC/PTPC; Self's Penders is a MONEY amount inside the gauge legend
 * (`GaugeSectionVM.penders`) instead.
 * v1.19.0 (`AC-P4-02-56`/`-57`): for TPC/PTPC the COUNT value renders as
 * "{count} Cases" (`insights.detail.pendersCases`) with a trailing
 * `icon.external-link-line`, in link colour. CASE_COUNT's Team card is
 * unchanged (bare count).
 */
export interface PendersSectionVM {
  type: "PENDERS";
  id: string;
  periodLabelYear: number;
  value: MetricScalar;
  /**
   * v1.19.0, optional placeholder: Activity Management Proposal screen. The
   * route is unconfirmed (`OQ-30`), so the BFF MUST omit this until `OQ-30`
   * is answered. Absent ⇒ the value is not interactive (`AC-P4-02-57`).
   */
  nav?: RouteRef;
}

/** Product breakdown table (widget `w.metric-detail.breakdown-table`). */
export interface BreakdownRowVM {
  productCode: string; // i18n: insights.product.{code}
  /** Renders "(10%)" beside the product label when present. */
  weightPct?: number;
  cells: Array<{ businessLine: BusinessLine; value: MetricScalar }>;
}
export interface BreakdownSectionVM {
  type: "BREAKDOWN";
  id: string; // "breakdown.without-repricing" | "breakdown.with-repricing"
  variant: Variant; // table heading
  columns: BusinessLine[]; // column order; i18n per code
  rows: BreakdownRowVM[];
  totals: Array<{ businessLine: BusinessLine; value: MetricScalar }>;
}

/**
 * Year-over-year bar chart (widget `w.metric-detail.bar-comparison`, v1.1.0).
 * One measure ⇒ simple bars (NEW_RECRUIT_CONTRACTED); two with
 * `layout` absent/GROUPED ⇒ grouped bars; delta chips render per point
 * from `change`.
 * v1.6.0 (S-P4-02 v1.13.0): `layout='STACKED'` ⇒ measures stack into one
 * bar per year (MANPOWER: EXISTING_AGENTS + NEW_RECRUITS = Total Manpower);
 * the total label and the only delta chip come from `totals[]`, and
 * segment points carry no `change`.
 */
export interface BarComparisonSectionVM {
  type: "BAR_COMPARISON";
  id: string; // "bars.primary"
  years: number[]; // ascending, last = current year
  /** Axis unit label, i18n: insights.axis.{unitCode} ("No. of Agents"). */
  axisUnitCode?: string;
  measures: Array<{
    measureCode?: string; // i18n: insights.measure.{code}; absent for single-measure
    points: Array<{ year: number; value: MetricScalar; change?: DeltaVM }>;
  }>;
  /** v1.6.0 — absent ⇒ 'GROUPED' (pre-v1.6.0 behavior). */
  layout?: "GROUPED" | "STACKED";
  /** v1.6.0 — required when `layout='STACKED'`, absent otherwise. One entry
   *  per `years` entry, same order; `value` = sum of the measures' points
   *  for that year (BFF/domain-computed); `change` vs previous year's total. */
  totals?: Array<{ year: number; value: MetricScalar; change?: DeltaVM }>;
}

export type MetricDetailSectionVM =
  | GaugeSectionVM
  | ThresholdGaugeSectionVM
  | ComparisonSectionVM
  | VariantValueSectionVM
  | PendersSectionVM
  | BreakdownSectionVM
  | BarComparisonSectionVM;

/** Dismissible data-quality banner (widget `w.notice.banner`, v1.2.0). */
export interface NoticeVM {
  code: string; // i18n: insights.notice.{code}
  severity: "INFO" | "WARNING";
  params?: Record<string, string>; // i18n interpolation (e.g. productCode)
}

export interface MetricDetailVM {
  meta: VMeta;
  context: DetailContextVM;
  /**
   * OK ⇒ render `sections`. PROCESSING ⇒ w.state.processing ("Data
   * Temporarily Unavailable" + Refresh). EMPTY ⇒ w.state.empty ("No Data
   * Available"). Non-OK payloads have empty `sections` (v1.2.0).
   */
  dataState: "OK" | "PROCESSING" | "EMPTY";
  /** Data-gap banners above the first section (e.g. PRODUCT_DATA_MISSING). */
  notices?: NoticeVM[];
  sections: MetricDetailSectionVM[];
}

/* ──────────────────────── S-P4-03 · Historical Data ─────────────────────── */

export interface HistoryTabVM {
  metricCode: string; // pill label via i18n
  selected: boolean;
}

export interface HistoryRowVM {
  month: number; // 1..12 → i18n month short names
  /** Aligned with `years`; null ⇒ render "-". */
  values: Array<MetricScalar | null>;
}

/** History comparison window — drives columns + pager label (v1.1.0). */
export type HistoryWindow = "CURRENT_YEAR" | "VS_LAST_YEAR" | "VS_LAST_2_YEARS";

export interface MetricHistoryVM {
  meta: VMeta;
  tabs: HistoryTabVM[]; // visible pills, from config history.tabs
  /** Overflow metrics behind the "More Metrics" dropdown when pills exceed width. */
  moreTabs: HistoryTabVM[];
  metricCode: string;
  valueType: MetricScalar["kind"];
  context: {
    businessLine: BusinessLine;
    basis: Basis;
    scope: Scope;
    teamView?: TeamView;
  };
  comparison: {
    window: HistoryWindow; // i18n: insights.history.window.{code}
    windowOptions: HistoryWindow[]; // pager cycles these, from config
    anchorYear: number;
    yearsBack: number; // 0 for CURRENT_YEAR
    canGoOlder: boolean; // "<" enabled
    canGoNewer: boolean; // ">" enabled
  };
  /** Column order, anchor year first (e.g. [2026, 2025, 2024]). */
  years: number[];
  rows: HistoryRowVM[]; // always 12 rows, Jan..Dec
  /**
   * Month-over-month deltas for the anchor year — the "MoM Delta" column,
   * present only when window = CURRENT_YEAR. Index 0 (Jan) and months with a
   * null value are null ⇒ render "N/A". Computed by the BFF from the series
   * using catalog `favourability` (D-11).
   */
  momDeltas?: Array<DeltaVM | null>;
}

/* ───────────────── S-P4-03 v2.0.0 · Team Historical Data (ARVIJ-1450) ───────────────── */

/** Time filter of the Team Historical Data table (`GET .../performance/historical-data`). */
export type HistoricalComparison = "CURRENT_YEAR" | "VS_LAST_YEAR" | "VS_LAST_2_YEARS";

/** One radio option of the Metric filter; `variant` is set for TPC only. */
export interface HistoricalMetricOptionVM {
  metricCode: string;
  variant?: Variant;
  selected: boolean;
}

export interface HistoricalComparisonOptionVM {
  comparison: HistoricalComparison;
  selected: boolean;
}

/**
 * Desktop "Total" row (S-P4-03 §B, D-HD-16, AC-P4-03-32). Present only for
 * additive metrics (C4 `screens.historicalData.metrics[].total = true`: TPC both
 * variants, CASE_COUNT, NEW_RECRUIT_CONTRACTED). Like-for-like: every year column
 * sums ONLY the months in which the anchor year has a value, so the % change
 * compares equal periods. A year column is null when it lacks a value for any of
 * those months (never a partial sum) or when the anchor year has no value at all.
 */
export interface HistoricalDataTotalsVM {
  /** Aligned with `years`; null ⇒ render "-". */
  values: Array<MetricScalar | null>;
  /**
   * Aligned with `changeColumns`; null ⇒ "N/A". Always null for a LAST_MONTH
   * column (a month-over-month change of a total is undefined): the UI leaves
   * that cell empty. Same `display: "PCT"`, one-decimal rule as the rows.
   */
  changes: Array<DeltaVM | null>;
}

/** One calendar month: a mobile card / a desktop table row. */
export interface HistoricalDataRowVM {
  month: number; // 1..12 → i18n insights.month.{n}.short / long
  /** Aligned with `years`; null ⇒ render "-" (no row, or the source value is null). */
  values: Array<MetricScalar | null>;
  /**
   * Aligned with `changeColumns`. null ⇒ render "N/A" (AC12): the current-year
   * value is unavailable, the comparison month's value is unavailable, or it is zero.
   * Always `display: "PCT"`, one decimal, never the R-PCT-ROUNDUP integer rule.
   */
  changes: Array<DeltaVM | null>;
}

/**
 * Team Historical Data — "Historical Data" opened from the Team Performance
 * dashboard (S-P4-03 §B, ARVIJ-1450-SP01). Always 12 rows (Jan..Dec) so the
 * layout is intact even when `dataState` is EMPTY (AC-P4-03-26/-27).
 *
 * Column model by `selection.comparison` (anchor = `anchorYear` = year of the
 * newest month the chosen source holds). Per the Jira stories (AC7/AC8/AC9):
 *  - CURRENT_YEAR    years [A]            changeColumns [LAST_MONTH]
 *  - VS_LAST_YEAR    years [A, A-1]       changeColumns [LAST_YEAR]
 *  - VS_LAST_2_YEARS years [A, A-1, A-2]  changeColumns [LAST_YEAR, LAST_2_YEARS]
 * UI captions are derived: LAST_YEAR → "vs {A-1}", LAST_2_YEARS → "vs {A-2}",
 * LAST_MONTH → "vs last month".
 */
export interface HistoricalDataVM {
  meta: VMeta;
  /** EMPTY ⇔ every `rows[].values[]` cell is null. The UI shows a notice and keeps the frame. */
  dataState: "OK" | "EMPTY";
  /** `teamView` is present only when `scope` is TEAM. SELF = the agent's own (Personal) rows. */
  context: { businessLine: BusinessLine; basis: Basis; scope: Scope; teamView?: TeamView };
  selection: { metricCode: string; variant?: Variant; comparison: HistoricalComparison };
  /** Filter sheet content, in Figma order (from config `screens.historicalData`). */
  filter: { metrics: HistoricalMetricOptionVM[]; comparisons: HistoricalComparisonOptionVM[] };
  valueType: MetricScalar["kind"];
  /** Year of the newest data of the chosen source (the clock year when there is none). */
  anchorYear: number;
  /** Value columns, anchor year first. */
  years: number[];
  /** 1 or 2 change columns: [LAST_MONTH] (Current Year), [LAST_YEAR] or [LAST_YEAR, LAST_2_YEARS]. */
  changeColumns: Array<{ basis: DeltaVM["comparisonBasis"] }>;
  /** Always 12 rows, January first. */
  rows: HistoricalDataRowVM[];
  /** Desktop Total row; absent for non-additive metrics and never rendered on mobile cards. */
  totals?: HistoricalDataTotalsVM;
}

/* ─────────────────────── S-P4-04 · Customize Metrics ────────────────────── */

export interface CustomizeItemVM {
  metricCode: string; // i18n: insights.metric.{code}.title (+ variant suffix)
  variant?: Variant; // e.g. "TPC without repricing"
  selected: boolean;
  /** Locked ⇒ greyed checked box, not toggleable (MY priority set). */
  locked: boolean;
  reorderable: boolean; // drag handle visible
  order: number;
}

export interface CustomizeConstraintsVM {
  priority: { min: number; max: number; editable: boolean };
  focus: { min: number; max: number };
}

export interface CustomizeMetricsVM {
  meta: VMeta;
  /** Which preference document is being edited (leader: SELF and TEAM are separate). */
  scope: Scope;
  priority: CustomizeItemVM[];
  focus: CustomizeItemVM[];
  constraints: CustomizeConstraintsVM;
  dirty?: boolean;
}

/** PUT /api/bff/v1/performance/customize?scope=… request body. */
export interface SaveCustomizeRequest {
  priorityMetricCodes: string[]; // final order
  focusMetricCodes: string[]; // final order, selected only
}

/* ──────────────────────── S-P4-07 · Team Drilldown ──────────────────────── */

/** Hierarchy basis for S-P4-07 member listing; distinct from Performance `Basis`. */
export type DrilldownBasis = "AGENT" | "AM" | "UM";

/**
 * v1.8.0 member qualification badge (i18n: insights.teamDrilldown.badge.{code}).
 * Extensible — render unknown codes with the neutral badge tone. VIOLET is
 * display-only (D-P4-07-01, OQ-80) and never appears in `filterOptions`.
 */
export type MemberBadgeCode =
  | 'MDRT' | 'COT' | 'TOT'
  | 'WP' | 'EWP' | 'SWP' | 'PWP' | 'MWP'
  | 'PV' | 'ROOKIE' | 'VIOLET'
  | (string & {});
/** Filter group (i18n: insights.teamDrilldown.badgeGroup.{code}). */
export type MemberBadgeGroupCode = 'MDRT' | 'PRUWEALTH_PLANNER' | 'PV' | 'ROOKIE' | (string & {});
export type TeamMemberGoalStatus = 'SET' | 'NOT_SET';
export type TeamDrilldownSortBy = 'TPC' | 'PTPC';

export interface TeamMemberVM {
  agentId: string;
  displayName: string;
  hierarchyBasis: DrilldownBasis;
  roleCode: string;
  /** v1.8.0 — display order; absent ⇒ no badge row (never synthesized, OQ-79). */
  badges?: MemberBadgeCode[];
  /** v1.8.0 — "Goal set" / "Goal not set"; absent ⇒ no goal indicator. */
  goalStatus?: TeamMemberGoalStatus;
  /** v1.8.0 — card values; widget renders compact without currency (D-P4-07-05). */
  tpc?: MetricScalar;
  ptpc?: MetricScalar;
  /** v1.8.0 — > 0 only for members who lead a team; drives the subteam button. */
  directReportCount?: number;
  /** v1.8.0 — absent ⇒ initials avatar. */
  photoUrl?: string;
  /** v1.8.0 — card tap → S-P4-01 viewing mode for this member. */
  nav?: RouteRef;
}

export interface TeamDrilldownFiltersVM {
  scope: Scope;
  teamView: TeamView;
  /**
   * v1.8.0: OPTIONAL — absent when the request omitted `basis` (all levels,
   * the S-P4-07 0.2.0 "My Team" list). BREAKING for readers of this field;
   * the only reader is the S-P4-07 UI, updated in lockstep (SPEC-2026-004).
   */
  basis?: DrilldownBasis;
  search?: string;
  /** v1.8.0 — defaults to C4 `memberList.defaultSortBy` (TPC). */
  sortBy?: TeamDrilldownSortBy;
  /** v1.8.0 — selected badge filter; absent/empty = "All Agent". */
  badges?: MemberBadgeCode[];
  /** v1.8.0 — set when the list is a member's subteam (drawer). */
  parentAgentId?: string;
}

/** v1.8.0 KPI tile (widget `w.team-drilldown.summary-tile`). */
export interface TeamDrilldownSummaryTileVM {
  metricCode: string;                      // i18n: insights.metric.{code}.title
  valueType: MetricScalar['kind'];
  /** Absent ⇒ tile renders the no-value placeholder; never zero-filled. */
  value?: MetricScalar;
}

/** v1.8.0 Filters sheet options, from C4 `team-drilldown.config.json`. */
export interface TeamDrilldownFilterOptionsVM {
  sortBy: TeamDrilldownSortBy[];
  badgeGroups: Array<{ groupCode: MemberBadgeGroupCode; badges: MemberBadgeCode[] }>;
}

export interface TeamDrilldownSelectedMemberDashboardVM {
  member: TeamMemberVM;
  context: {
    period: PeriodType;
    businessLine: BusinessLine;
    basis: Basis;
    scope: Scope;
    teamView: TeamView;
    asOfDate: IsoDate;
  };
  /** Additive subset for S-P4-07 card preview composition. */
  metrics: MetricCardVM[];
}

export interface TeamDrilldownVM {
  meta: VMeta;
  filters: TeamDrilldownFiltersVM;
  members: TeamMemberVM[];
  /** Superseded for UI by S-P4-01 viewing mode (AC-P4-07-04 → AC-P4-07-14); kept for compatibility. */
  selectedMember?: TeamDrilldownSelectedMemberDashboardVM;
  /** v1.8.0 — KPI tiles over the filtered set, C4 order. Absent in the subteam drawer. */
  summary?: TeamDrilldownSummaryTileVM[];
  /** v1.8.0 — the member whose team is listed (subteam drawer title). */
  parent?: TeamMemberVM;
  /** v1.8.0 — Filters sheet options. */
  filterOptions?: TeamDrilldownFilterOptionsVM;
}

/* ───────────────────────────── Error envelope ───────────────────────────── */
/**
 * BFF error responses use the same RFC 7807 shape as the domain (`Problem`),
 * with BFF-prefixed codes (BFF-xxxx). Section-level degradation is NOT an
 * error response: the BFF returns 200 with `meta.partial = true` and lists
 * `meta.failedSections`; affected sections are omitted from the payload.
 */
export interface ProblemVM {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  traceId?: string;
}
