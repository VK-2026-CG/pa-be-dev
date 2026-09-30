import { effectiveCatalog } from './catalog.js';
import { getPreferences, putPreferences } from './preferences.js';
import { PERFORMANCE_COLLECTIONS, PERFORMANCE_DATABASES, PERFORMANCE_HIERARCHY_COLLECTION, PERFORMANCE_READ_TIMEOUT_MS, } from '../config/performance.js';
import { PERFORMANCE_METRIC_MAPPING, PERFORMANCE_SOURCE_KEYS, performanceMetricPath } from './performance-mapping.js';
import { sourceMetricScalar } from './performance-values.js';
import { changeFor } from './change.js';
import { performanceRecordMetadata, PerformanceSourceNotFound } from './performance-record.js';
const HIERARCHY_PROJECTION = { _id: 1, asOnDate: 1, 'audit.updatedAt': 1, 'hierarchy.leaderId': 1, 'subtree.scopeProfileIds': 1, 'displayRows.tier': 1 };
const HIERARCHY_ORDER = { asOnDate: -1, 'audit.updatedAt': -1, _id: -1 };
/** Marks an ID already looked up that has no hierarchy document (treated like an absent row). */
const ABSENT = Object.freeze({});
/** Upper bound on a resolved downline so a malformed tree cannot fan out without limit. */
const MAX_DOWNLINE = 20_000;
/** Hierarchy snapshots change daily; one request resolves the caller's root up to three times. */
const HIERARCHY_ROOT_TTL_MS = 60_000;
const HIERARCHY_ROOT_CACHE_MAX = 1_000;
/** Source tiers vary in case and suffix across databases ('AM', 'UM', 'UM1', 'UM2', 'Agent', 'agent'). */
const levelForTier = (tier) => {
    const t = typeof tier === 'string' ? tier.trim().toUpperCase() : '';
    return t === 'AM' ? 'P2' : /^UM\d*$/.test(t) ? 'P3' : t === 'AGENT' ? 'P4' : undefined;
};
const BASIS_FOR_LEVEL = { P2: 'AM', P3: 'UM', P4: 'AGENT' };
/** Direct reportee IDs in source order, deduplicated, without the leader's own ID (UM/agent snapshots include it). */
const reportIdsOf = (row) => {
    const refs = row?.subtree?.scopeProfileIds;
    if (!Array.isArray(refs))
        return [];
    const self = row?.hierarchy?.leaderId;
    return [...new Set(refs.filter((id) => typeof id === 'string' && id !== self))];
};
const isoDate = (value) => {
    const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
};
const at = (row, path) => path.split('.').reduce((v, key) => v && typeof v === 'object' ? v[key] : undefined, row);
const periodRank = (row) => performanceRecordMetadata(row).rank;
const zeroScalar = (kind) => kind === 'MONEY'
    ? { kind, amount: '0.00', currency: 'MYR' }
    : kind === 'COUNT' ? { kind, value: 0 }
        : kind === 'PERCENT' ? { kind, value: 0 }
            : { kind, value: 0, precision: 1 };
const isMissingMetricValue = (row, path) => {
    const value = at(row, path);
    return value === null || value === undefined;
};
const zeroChange = (code, kind) => {
    const base = { basis: 'LAST_YEAR', direction: 'FLAT', sentiment: 'NEUTRAL' };
    const display = effectiveCatalog('SELF', 'STANDARD').find(def => def.metricCode === code)?.changeDisplay;
    if (kind === 'MONEY')
        return display === 'ABS'
            ? { ...base, abs: { kind, amount: '0.00', currency: 'MYR' } }
            : { ...base, pct: 0 };
    if (kind === 'PERCENT')
        return display === 'PCT' ? { ...base, pct: 0 } : { ...base, pp: 0 };
    if (kind === 'COUNT')
        return display === 'ABS' ? { ...base, abs: { kind, value: 0 } } : { ...base, pct: 0 };
    return { ...base, pct: 0 };
};
/** SPEC-2026-002 0.5.0-draft: businessLine picks the database; `entity` is always the database's own
 * literal name ('PAMB' in PAMB, 'PBTB' in PBTB) on every row regardless of `agentType`. */
const databaseKeyFor = (businessLine) => businessLine === 'TAKAFUL' ? 'PBTB' : 'PAMB';
/**
 * INTERIM (requester, 2026-09-29): `agentType` genuinely varies per agent (PAMB-only 'PAMB' vs also-Takaful-
 * licensed 'HYBRID' in the PAMB database), but real data has only one production row per agent/period, not
 * the two (one PAMB-tagged, one HYBRID-tagged) the requester expects the eventual source to supply. Filtering
 * `INSURANCE` to `agentType: 'PAMB'` therefore 404s every Hybrid-licensed agent under `INSURANCE`, since they
 * have no such row. Until the data team confirms the real two-record shape, `INSURANCE` and `ALL` both return
 * the same `entity`-matched row regardless of `agentType` — they are not yet distinguishable per-agent.
 * `entity` always equals the database key itself (`databaseKeyFor`), so no separate value table is needed.
 */
const entityFor = (businessLine) => databaseKeyFor(businessLine);
/** Guarded development adapter; no canonical/legacy collection fallback. */
export class PerformanceSource {
    dbs;
    agents;
    log;
    kind = 'performance';
    ownIdentityOnly = true;
    constructor(dbs, agents, log = () => { }, 
    /** Kept for constructor compatibility; Mongo mode never reads from mock fallback data. */
    _deprecatedDevMockFallback = false, 
    /** Kept for constructor compatibility; `my_agent_hierarchy` is always read. */
    _deprecatedHierarchyEnabled = false) {
        this.dbs = dbs;
        this.agents = agents;
        this.log = log;
        if (dbs.PAMB.databaseName !== PERFORMANCE_DATABASES.PAMB || dbs.PBTB.databaseName !== PERFORMANCE_DATABASES.PBTB) {
            throw new Error('Invalid Performance source database');
        }
        void _deprecatedDevMockFallback;
        void _deprecatedHierarchyEnabled;
    }
    findAgent = (id) => this.agents.get(id);
    /** Newest `my_agent_hierarchy` snapshot per leader ID (asOnDate DESC, audit.updatedAt DESC, _id DESC); names and vault data are never projected. */
    async hierarchyRows(key, ids) {
        const out = new Map();
        if (!ids.length)
            return out;
        let docs;
        try {
            docs = await this.dbs[key].collection(PERFORMANCE_HIERARCHY_COLLECTION).find(ids.length === 1 ? { 'hierarchy.leaderId': ids[0] } : { 'hierarchy.leaderId': { $in: ids } }, { projection: HIERARCHY_PROJECTION, maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS }).sort(HIERARCHY_ORDER).toArray();
        }
        catch {
            throw new Error('Hierarchy source read failed');
        }
        for (const row of docs) {
            const id = row.hierarchy?.leaderId;
            if (typeof id === 'string' && !out.has(id))
                out.set(id, row);
        }
        return out;
    }
    rootCache = new Map();
    /** Root lookup, memoized briefly: identity resolution and team visibility both need it on every request. */
    hierarchyRoot(agentId) {
        const now = Date.now();
        const hit = this.rootCache.get(agentId);
        if (hit && hit.expires > now)
            return hit.value;
        if (this.rootCache.size >= HIERARCHY_ROOT_CACHE_MAX)
            this.rootCache.clear();
        const value = this.loadHierarchyRoot(agentId);
        this.rootCache.set(agentId, { expires: now + HIERARCHY_ROOT_TTL_MS, value });
        value.catch(() => this.rootCache.delete(agentId));
        return value;
    }
    /** PAMB first, PBTB only when the root is absent; descendants resolve in the same database. */
    async loadHierarchyRoot(agentId) {
        for (const key of ['PAMB', 'PBTB']) {
            const row = (await this.hierarchyRows(key, [agentId])).get(agentId);
            if (row)
                return { key, row };
        }
        return undefined;
    }
    async listedAsReportee(agentId) {
        for (const key of ['PAMB', 'PBTB']) {
            const rows = await this.dbs[key].collection(PERFORMANCE_HIERARCHY_COLLECTION).find({ 'subtree.scopeProfileIds': agentId }, { projection: { _id: 1 }, maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS }).limit(1).toArray();
            if (rows.length)
                return true;
        }
        return false;
    }
    /**
     * Loads snapshots for IDs not yet in `rows`. IDs without a document are stored as `ABSENT`,
     * so a later walk does not query them again.
     */
    async loadRows(key, ids, rows) {
        const missing = [...new Set(ids)].filter(id => !rows.has(id));
        if (!missing.length)
            return;
        const found = await this.hierarchyRows(key, missing);
        for (const id of missing)
            rows.set(id, found.get(id) ?? ABSENT);
    }
    /** Every ID reachable from `ids` (inclusive), breadth-first with dedupe so cycles terminate. */
    async downline(key, ids, rows) {
        const seen = new Set(ids);
        let frontier = [...ids];
        while (frontier.length && seen.size < MAX_DOWNLINE) {
            await this.loadRows(key, frontier, rows);
            const next = [];
            for (const id of frontier) {
                for (const reportId of reportIdsOf(rows.get(id))) {
                    if (!seen.has(reportId)) {
                        seen.add(reportId);
                        next.push(reportId);
                    }
                }
            }
            frontier = next;
        }
        return seen;
    }
    async resolveIdentity(agentId) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId))
            return undefined;
        let root;
        try {
            root = await this.hierarchyRoot(agentId);
            // A reportee without its own snapshot is still a known agent (an ID-only leaf in its leader's tree).
            if (!root)
                return await this.listedAsReportee(agentId) ? { agentId, tenant: 'MY', level: 'P4', name: agentId } : undefined;
        }
        catch {
            throw new Error('Identity hierarchy source read failed');
        }
        const level = levelForTier(root.row.displayRows?.tier);
        if (root.row.hierarchy?.leaderId !== agentId || !level)
            throw new Error('Malformed identity hierarchy');
        return { agentId, tenant: 'MY', level, name: agentId };
    }
    async getAgentOrganization(agentId) {
        try {
            const root = await this.hierarchyRoot(agentId);
            if (!root)
                return undefined;
            const { key } = root;
            const seen = new Set();
            const build = async (id, row, ancestors) => {
                if (ancestors.has(id))
                    throw new Error('Hierarchy cycle');
                seen.add(id);
                if (!row)
                    return { agentId: id, displayName: id, reports: [] };
                const refs = row.subtree?.scopeProfileIds;
                if (row.hierarchy?.leaderId !== id || !Array.isArray(refs) || refs.some((value) => typeof value !== 'string'))
                    throw new Error('Malformed hierarchy');
                const tier = levelForTier(row.displayRows?.tier);
                if (!tier)
                    throw new Error('Malformed hierarchy');
                const next = new Set(ancestors).add(id);
                const reports = [];
                // UM/agent snapshots list the leader itself first; that entry is not a reportee.
                for (const reportId of reportIdsOf(row)) {
                    if (ancestors.has(reportId))
                        throw new Error('Hierarchy cycle');
                    if (seen.has(reportId))
                        continue;
                    reports.push(await build(reportId, (await this.hierarchyRows(key, [reportId])).get(reportId), next));
                }
                return { agentId: id, displayName: id, tier, reports };
            };
            return await build(agentId, root.row, new Set());
        }
        catch (error) {
            if (error instanceof Error && ['Hierarchy cycle', 'Malformed hierarchy'].includes(error.message))
                throw error;
            throw new Error('Hierarchy source read failed');
        }
    }
    async latest(agent, businessLine, aggregation) {
        if (agent.tenant !== 'MY' || !/^[A-Za-z0-9_-]{1,40}$/.test(agent.agentId))
            throw new Error('Invalid Performance identity');
        const db = this.dbs[databaseKeyFor(businessLine)];
        const entity = entityFor(businessLine);
        const entries = await Promise.all(PERFORMANCE_COLLECTIONS.map(async (name) => {
            const keys = PERFORMANCE_SOURCE_KEYS[name];
            const query = { [keys.identity]: agent.agentId, entity };
            if (aggregation)
                query[keys.aggregation] = aggregation;
            if (name === 'my_production')
                query[keys.caseStatus] = 'Collected';
            // Only fields necessary for mapping; names, identifiers and vault data never leave Mongo.
            let docs;
            try {
                docs = await db.collection(name).find(query, {
                    projection: { _id: 0, period: 1, asOnDate: 1, ptd: 1, metrics: 1 },
                    maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
                }).sort({ 'period.year': -1, 'period.month': -1, id: -1, _id: -1 }).limit(1).toArray();
            }
            catch {
                // Driver messages can expose hosts, query arguments or credentials.
                throw new Error('Performance source read failed');
            }
            this.log(`performance read: agent=${agent.agentId} collection=${name} businessLine=${businessLine} aggregation=${aggregation ?? 'none'} found=${Boolean(docs[0])}`);
            if (docs[0])
                performanceRecordMetadata(docs[0]);
            return [name, docs[0]];
        }));
        return Object.fromEntries(entries.filter(([, row]) => row));
    }
    /**
     * `latest()` for many agents at once: one `$in` read per collection instead of three per agent.
     * Same filters and ordering; the first row seen per agent in the sorted result is its latest.
     */
    async latestMany(agentIds, businessLine, aggregation) {
        const out = new Map();
        const ids = [...new Set(agentIds)].filter(id => /^[A-Za-z0-9_-]{1,40}$/.test(id));
        if (!ids.length)
            return out;
        const db = this.dbs[databaseKeyFor(businessLine)];
        const entity = entityFor(businessLine);
        await Promise.all(PERFORMANCE_COLLECTIONS.map(async (name) => {
            const keys = PERFORMANCE_SOURCE_KEYS[name];
            const query = { [keys.identity]: { $in: ids }, entity, [keys.aggregation]: aggregation };
            if (name === 'my_production')
                query[keys.caseStatus] = 'Collected';
            let docs;
            try {
                docs = await db.collection(name).find(query, {
                    projection: { _id: 0, [keys.identity]: 1, period: 1, asOnDate: 1, ptd: 1, metrics: 1 },
                    maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
                }).sort({ 'period.year': -1, 'period.month': -1, id: -1, _id: -1 }).toArray();
            }
            catch {
                throw new Error('Performance source read failed');
            }
            for (const row of docs) {
                const id = String(row[keys.identity]);
                const rows = out.get(id) ?? {};
                if (rows[name])
                    continue;
                performanceRecordMetadata(row);
                rows[name] = row;
                out.set(id, rows);
            }
        }));
        this.log(`performance batch read: agents=${ids.length} businessLine=${businessLine} aggregation=${aggregation} found=${out.size}`);
        return out;
    }
    /**
     * Same identity/aggregation/type as `latest()`, restricted to one collection and one prior
     * reporting month. Picks the closest-not-exceeding `asOnMonthDay` (undeclared ⇒ month-end, same
     * convention `selection()` uses) so a still-partial current month is never compared against an
     * already-closed prior-year month — no row at or before that day ⇒ undefined, comparison unavailable.
     */
    async priorYearRow(agent, businessLine, aggregation, collection, year, month, notAfterDay) {
        if (agent.tenant !== 'MY' || !/^[A-Za-z0-9_-]{1,40}$/.test(agent.agentId))
            throw new Error('Invalid Performance identity');
        const db = this.dbs[databaseKeyFor(businessLine)];
        const entity = entityFor(businessLine);
        const keys = PERFORMANCE_SOURCE_KEYS[collection];
        const query = { [keys.identity]: agent.agentId, entity, 'period.year': year, 'period.month': month };
        if (aggregation)
            query[keys.aggregation] = aggregation;
        if (collection === 'my_production')
            query[keys.caseStatus] = 'Collected';
        let docs;
        try {
            docs = await db.collection(collection).find(query, {
                projection: { _id: 0, period: 1, asOnDate: 1, ptd: 1, metrics: 1 },
                maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
            }).sort({ id: -1, _id: -1 }).toArray();
        }
        catch {
            throw new Error('Performance source read failed');
        }
        const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const eligible = docs
            .map(row => ({ row, day: performanceRecordMetadata(row).day ?? monthEnd }))
            .filter(({ day }) => day <= notAfterDay)
            .sort((a, b) => b.day - a.day);
        return eligible[0]?.row;
    }
    /** Several catalog metrics share one collection (e.g. TPC/PTPC/FYP/FYC/CASE_COUNT all read my_production) — cache per request so metricList doesn't re-query the same collection once per metric. */
    priorYearRowCached(cache, agent, businessLine, aggregation, collection, year, month, notAfterDay) {
        const key = `${collection}|${year}|${month}|${notAfterDay}|${aggregation ?? ''}`;
        let promise = cache.get(key);
        if (!promise) {
            promise = this.priorYearRow(agent, businessLine, aggregation, collection, year, month, notAfterDay);
            cache.set(key, promise);
        }
        return promise;
    }
    async selection(agent, lens) {
        // v0.4.0-draft: businessLine is always routed to a real database now (see databaseKeyFor/agentTypeFor).
        // TEAM aggregates by teamView: DIRECT -> 'DirectUnit', GROUP -> 'Group' (both confirmed present in
        // Mongo agentAggregation values, camelCase across all three collections). SCHEME basis remains an unsupported placeholder
        // (OQ-20, see catalog.ts) and still gates to EMPTY.
        const basisSupported = lens.basis === 'STANDARD';
        const aggregation = lens.scope === 'SELF' ? 'Personal' : lens.teamView === 'GROUP' ? 'Group' : 'DirectUnit';
        const withAggregation = await this.latest(agent, lens.businessLine, aggregation);
        const found = Object.values(withAggregation).length > 0;
        const contexts = found ? withAggregation : await this.latest(agent, lens.businessLine);
        const all = Object.values(contexts);
        if (!all.length)
            throw new PerformanceSourceNotFound();
        const rank = Math.max(...all.map(periodRank));
        const current = all.filter(row => periodRank(row) === rank);
        const first = current[0];
        const { year, month } = performanceRecordMetadata(first);
        const declaredDay = current.map(row => performanceRecordMetadata(row).day).find(day => day !== undefined);
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const day = declaredDay ?? lastDay;
        const startMonth = lens.period === 'YTD' ? 1 : lens.period === 'QTD' ? Math.floor((month - 1) / 3) * 3 + 1 : month;
        const date = (m, d) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const rows = basisSupported ? Object.fromEntries(Object.entries(withAggregation).filter(([, row]) => periodRank(row) === rank)) : {};
        return {
            rows, year, month, day, aggregation: found ? aggregation : undefined,
            context: { period: { type: lens.period, startDate: date(startMonth, 1), endDate: date(month, day) },
                businessLine: lens.businessLine, basis: lens.basis, scope: lens.scope,
                ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
                // v0.4.0-draft (AC-PA-DIRECT-29): asOfDate is the period end date, never the asOnDate watermark.
                asOfDate: date(month, day) },
        };
    }
    value(def, rows, lens, repriced = false) {
        const mapping = PERFORMANCE_METRIC_MAPPING[def.metricCode];
        if (!mapping || mapping.valueType !== def.valueType)
            return undefined;
        const path = performanceMetricPath(mapping, lens.period, repriced);
        return path ? sourceMetricScalar(def.valueType, at(rows[mapping.collection], path), mapping.fraction) : undefined;
    }
    /** Same identity/aggregation as the current-period read, one year back, day-aligned per `priorYearRow()`. `cache` de-dupes reads across metrics sharing a collection within one request (see `priorYearRowCached`). */
    async comparisonFor(def, agent, lens, current, year, month, day, aggregation, cache) {
        const mapping = PERFORMANCE_METRIC_MAPPING[def.metricCode];
        if (!mapping)
            return undefined;
        const priorRow = await this.priorYearRowCached(cache, agent, lens.businessLine, aggregation, mapping.collection, year - 1, month, day);
        if (!priorRow)
            return undefined;
        const path = performanceMetricPath(mapping, lens.period);
        if (path && isMissingMetricValue(priorRow, path)) {
            const prior = zeroScalar(def.valueType);
            return { current, prior, priorYear: year - 1, change: zeroChange(def.metricCode, def.valueType) };
        }
        const prior = this.value(def, { [mapping.collection]: priorRow }, lens);
        if (prior)
            return { current, prior, priorYear: year - 1, change: changeFor(def.metricCode, current, prior) };
        return undefined;
    }
    async metricList(agent, lens, listScope, codes) {
        const { rows, context } = await this.selection(agent, lens);
        const items = effectiveCatalog(lens.scope, lens.basis)
            .filter(def => codes?.length ? codes.includes(def.metricCode) : listScope === 'ALL' || def.effCategory === listScope)
            .map((def) => {
            const collected = this.value(def, rows, lens);
            return { metricCode: def.metricCode, valueType: def.valueType, asOfDate: context.asOfDate,
                ...(def.capabilities.repricing ? { variant: 'WITHOUT_REPRICING' } : {}),
                dataState: collected ? 'OK' : 'EMPTY', ...(collected ? { collected, goal: { state: 'NOT_SET' } } : {}) };
        });
        return { context, items };
    }
    async metricDetail(agent, code, lens) {
        const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
        if (!def)
            return undefined;
        const { rows, context, year, month, day, aggregation } = await this.selection(agent, lens);
        const priorYear = year - 1;
        const collected = this.value(def, rows, lens);
        const detailComparison = collected && !['PERSISTENCY_CY', 'PERSISTENCY_Y1', 'PERSISTENCY_Y2'].includes(code);
        const comparison = detailComparison ? (await this.comparisonFor(def, agent, lens, collected, year, month, day, aggregation, new Map()) ?? {
            current: collected,
            prior: zeroScalar(def.valueType),
            priorYear,
            change: zeroChange(code, def.valueType),
        }) : undefined;
        const alt = collected && def.capabilities.repricing ? this.value(def, rows, lens, true) : undefined;
        const detail = { metricCode: code, valueType: def.valueType, context, dataState: collected ? 'OK' : 'EMPTY',
            ...(collected ? { primary: { variant: 'WITHOUT_REPRICING', collected } } : {}),
            ...(alt ? { altVariants: [{ variant: 'WITH_REPRICING', collected: alt }] } : {}),
            ...(comparison ? { comparison } : {}),
            ...(collected && def.threshold ? { threshold: def.threshold } : {}) };
        return detail;
    }
    async metricSeries(agent, code, lens, anchorYear, yearsBack) {
        const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
        if (!def?.capabilities.history)
            return undefined;
        const { context } = await this.selection(agent, lens);
        const seriesContext = { businessLine: context.businessLine, basis: context.basis, scope: context.scope,
            ...(context.teamView ? { teamView: context.teamView } : {}), asOfDate: context.asOfDate };
        // The source collections have no monthly history; return null points rather than synthetic values.
        return { metricCode: code, valueType: def.valueType, context: seriesContext, anchorYear,
            series: Array.from({ length: yearsBack + 1 }, (_, offset) => ({ year: anchorYear - offset,
                points: Array.from({ length: 12 }, (_, month) => ({ month: month + 1, value: null })) })) };
    }
    async milestones(agent) {
        const { context } = await this.selection(agent, { period: 'YTD', scope: 'SELF', basis: 'STANDARD', businessLine: 'INSURANCE' });
        return { asOfDate: context.asOfDate, items: [] };
    }
    async getPreferences(agent, scope, basis) { return getPreferences(agent.tenant, agent.agentId, scope, basis); }
    async putPreferences(agent, scope, basis, body) {
        return putPreferences(agent.tenant, agent.agentId, scope, basis, body);
    }
    async recommendations(agent, _scope = 'SELF') {
        void agent;
        const { asOfDate } = await this.milestones(agent);
        return { items: [], generatedAt: `${asOfDate}T00:00:00Z` };
    }
    async recordFeedback(_agent, _recommendationId, _rating) {
        return false;
    }
    /** Member card from its hierarchy snapshot (absent ⇒ ID-only AGENT leaf); names stay encrypted in Mongo, so the ID is the display name. */
    memberOf(agentId, row) {
        const level = levelForTier(row?.displayRows?.tier) ?? 'P4';
        const basis = BASIS_FOR_LEVEL[level];
        const reports = reportIdsOf(row).length;
        return {
            member: { agentId, displayName: agentId, hierarchyBasis: basis, roleCode: basis, ...(reports ? { directReportCount: reports } : {}) },
            record: { agentId, tenant: 'MY', level, name: agentId },
        };
    }
    /**
     * Personal TPC/PTPC for many members from one batched read. Values match the member's own
     * dashboard: only rows of the newest period across the collections count (as in `selection()`),
     * and a member without rows keeps the cards empty (never zero-filled).
     */
    async withProduction(members, lens) {
        if (!members.length || lens.basis !== 'STANDARD')
            return members;
        const byAgent = await this.latestMany(members.map(m => m.agentId), lens.businessLine, 'Personal');
        const selfLens = { ...lens, scope: 'SELF' };
        const defs = effectiveCatalog('SELF', lens.basis).filter(d => d.metricCode === 'TPC' || d.metricCode === 'PTPC');
        return members.map(member => {
            const all = byAgent.get(member.agentId);
            if (!all)
                return member;
            const rank = Math.max(...Object.values(all).map(row => periodRank(row)));
            const rows = Object.fromEntries(Object.entries(all).filter(([, row]) => periodRank(row) === rank));
            const out = { ...member };
            for (const def of defs) {
                const value = this.value(def, rows, selfLens);
                if (value)
                    out[def.metricCode === 'TPC' ? 'tpc' : 'ptpc'] = value;
            }
            return out;
        });
    }
    /** D-14 visibility from `my_agent_hierarchy`: P3 sees its direct team only; P2 its whole downline. */
    async visibleTeam(agent) {
        const found = await this.hierarchyRoot(agent.agentId);
        if (!found)
            return undefined;
        const rows = new Map([[agent.agentId, found.row]]);
        const direct = reportIdsOf(found.row);
        const visible = agent.level === 'P2' ? await this.downline(found.key, direct, rows) : new Set(direct);
        visible.delete(agent.agentId);
        return { key: found.key, root: found.row, direct, visible, rows };
    }
    /**
     * Direct reports from `my_agent_hierarchy` (`subtree.scopeProfileIds`), card
     * TPC/PTPC from `my_production`. Badges, goal status and photos have no
     * approved source (OQ-79) and are omitted; a badge filter therefore matches
     * nobody. MANPOWER counts the filtered members' organisations; tiles without
     * a source stay value-less.
     */
    async listTeamMembers(agent, req) {
        const team = await this.visibleTeam(agent);
        if (req.parentMemberAgentId && !team?.visible.has(req.parentMemberAgentId))
            return undefined;
        if (team && req.parentMemberAgentId) {
            await this.loadRows(team.key, [req.parentMemberAgentId], team.rows);
        }
        const ownerId = req.parentMemberAgentId ?? agent.agentId;
        const ownerRow = team?.rows.get(ownerId);
        const ids = ownerId === agent.agentId ? team?.direct ?? [] : reportIdsOf(ownerRow);
        if (team)
            await this.loadRows(team.key, ids, team.rows);
        const needle = req.query?.trim().toLowerCase() ?? '';
        const candidates = ids
            .map(id => this.memberOf(id, team?.rows.get(id)).member)
            .filter(member => !req.basis || member.hierarchyBasis === req.basis)
            .filter(member => !needle || member.agentId.toLowerCase().includes(needle))
            .filter(() => !req.badges?.length);
        const parentMember = req.parentMemberAgentId && team ? this.memberOf(ownerId, ownerRow).member : undefined;
        // Independent reads run together: one batched metric read (members + drawer parent),
        // the MANPOWER downline walk, and the caller's reporting date.
        const [enriched, org, asOfDate] = await Promise.all([
            this.withProduction(parentMember ? [...candidates, parentMember] : candidates, req.lens),
            !parentMember && team ? this.downline(team.key, candidates.map(m => m.agentId), team.rows) : Promise.resolve(new Set()),
            this.teamAsOfDate(agent, req.lens, team?.root),
        ]);
        const parent = parentMember ? enriched.pop() : undefined;
        const items = enriched;
        const amount = (m) => {
            const v = req.sortBy === 'PTPC' ? m.ptpc : m.tpc;
            return v?.kind === 'MONEY' ? Number(v.amount) : Number.NEGATIVE_INFINITY;
        };
        items.sort((a, b) => amount(b) - amount(a) || a.agentId.localeCompare(b.agentId));
        const summary = parent ? undefined : [
            { metricCode: 'MANPOWER', value: { kind: 'COUNT', value: org.size } },
            { metricCode: 'ACTIVITY_RATIO' }, { metricCode: 'PRODUCTIVITY' }, { metricCode: 'AVERAGE_CASE_SIZE' },
        ];
        return {
            asOfDate,
            ...(req.basis ? { basis: req.basis } : {}),
            items,
            ...(parent ? { parent } : { summary }),
        };
    }
    /** The caller's reporting-period end when it has metric rows, otherwise the hierarchy snapshot date. */
    async teamAsOfDate(agent, lens, root) {
        try {
            return (await this.selection(agent, { ...lens, scope: 'SELF' })).context.asOfDate;
        }
        catch (error) {
            if (!(error instanceof PerformanceSourceNotFound))
                throw error;
        }
        const date = isoDate(root?.asOnDate);
        if (!date)
            throw new PerformanceSourceNotFound();
        return date;
    }
    async findTeamMember(agent, memberAgentId, lens) {
        const team = await this.visibleTeam(agent);
        if (!team?.visible.has(memberAgentId))
            return undefined;
        await this.loadRows(team.key, [memberAgentId], team.rows);
        const row = team.rows.get(memberAgentId);
        const { member, record } = this.memberOf(memberAgentId, row);
        const [withValues] = await this.withProduction([member], lens);
        return { member: withValues, record };
    }
    async getTeamMemberDashboard(agent, memberAgentId, lens) {
        const found = memberAgentId === agent.agentId ? undefined : await this.findTeamMember(agent, memberAgentId, lens);
        if (memberAgentId !== agent.agentId && !found)
            return undefined;
        const subject = found?.record ?? agent;
        const list = await this.metricList(subject, { ...lens, scope: 'SELF' }, 'PRIORITY', ['TPC', 'PTPC']);
        return {
            member: found?.member ?? {
                agentId: agent.agentId,
                displayName: agent.name,
                hierarchyBasis: BASIS_FOR_LEVEL[agent.level],
                roleCode: BASIS_FOR_LEVEL[agent.level],
            },
            context: {
                period: list.context.period,
                businessLine: list.context.businessLine,
                basis: list.context.basis,
                scope: 'SELF',
                asOfDate: list.context.asOfDate,
            },
            metrics: list.items,
        };
    }
}
