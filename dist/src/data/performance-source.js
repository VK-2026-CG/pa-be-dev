import { effectiveCatalog } from './catalog.js';
import { getPreferences, putPreferences } from './preferences.js';
import { PERFORMANCE_COLLECTIONS, PERFORMANCE_DB, PERFORMANCE_READ_TIMEOUT_MS } from '../config/performance.js';
import { PERFORMANCE_METRIC_MAPPING, PERFORMANCE_SOURCE_KEYS, performanceMetricPath } from './performance-mapping.js';
import { sourceMetricScalar } from './performance-values.js';
import { performanceRecordMetadata, PerformanceSourceNotFound } from './performance-record.js';
import { contextFor, metricList as stubMetricList, metricSeries as stubMetricSeries, milestones as stubMilestones, mockFillDetail, } from './values.js';
import { recommendations as stubRecommendations, recordFeedback as stubRecordFeedback } from './recommendations.js';
import { mockTeamMemberDashboard, mockTeamMembers } from './mocks/team-members.js';
import { mockTeamPendersCaseCount } from './mocks/team-penders.js';
const at = (row, path) => path.split('.').reduce((v, key) => v && typeof v === 'object' ? v[key] : undefined, row);
const periodRank = (row) => performanceRecordMetadata(row).rank;
/** Guarded development adapter; no canonical/legacy collection fallback. */
export class PerformanceSource {
    db;
    agents;
    log;
    devMockFallback;
    kind = 'performance';
    ownIdentityOnly = true;
    constructor(db, agents, log = () => { }, 
    /**
     * DEV-ONLY opt-in (`INSIGHTS_DEV_MOCK_FALLBACK=true` + `NODE_ENV=development`):
     * Mongo first; anything it cannot supply is filled from the stub engine. Real values are never replaced.
     */
    devMockFallback = false) {
        this.db = db;
        this.agents = agents;
        this.log = log;
        this.devMockFallback = devMockFallback;
        if (db.databaseName !== PERFORMANCE_DB)
            throw new Error('Invalid Performance source database');
    }
    findAgent = (id) => this.agents.get(id);
    async latest(agent, aggregation) {
        if (agent.tenant !== 'MY' || !this.agents.has(agent.agentId))
            throw new Error('Identity not allowed in Performance profile');
        const entries = await Promise.all(PERFORMANCE_COLLECTIONS.map(async (name) => {
            const keys = PERFORMANCE_SOURCE_KEYS[name];
            const query = { [keys.identity]: agent.agentId, entity: 'PAMB' };
            if (aggregation)
                query[keys.aggregation] = aggregation;
            if (name === 'my_production')
                query.case_status = 'Collected';
            // Only fields necessary for mapping; names, identifiers and vault data never leave Mongo.
            let docs;
            try {
                docs = await this.db.collection(name).find(query, {
                    projection: { _id: 0, period: 1, asOnDate: 1, ptd: 1, metrics: 1 },
                    maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
                }).sort({ 'period.year': -1, 'period.month': -1, asOnDate: -1, 'audit.updatedAt': -1, id: 1, _id: 1 }).limit(1).toArray();
            }
            catch {
                // Driver messages can expose hosts, query arguments or credentials.
                throw new Error('Performance source read failed');
            }
            this.log(`performance read: agent=${agent.agentId} collection=${name} aggregation=${aggregation ?? 'none'} found=${Boolean(docs[0])}`);
            if (docs[0])
                performanceRecordMetadata(docs[0]);
            return [name, docs[0]];
        }));
        return Object.fromEntries(entries.filter(([, row]) => row));
    }
    async selection(agent, lens) {
        const supported = lens.businessLine === 'INSURANCE' && lens.basis === 'STANDARD'
            && (lens.scope === 'SELF' || lens.teamView === 'GROUP');
        const available = await this.latest(agent, lens.scope === 'SELF' ? 'Personal' : 'Group');
        const contexts = Object.values(available).length ? available : await this.latest(agent);
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
        const rows = supported ? Object.fromEntries(Object.entries(available).filter(([, row]) => periodRank(row) === rank)) : {};
        return {
            rows,
            context: { period: { type: lens.period, startDate: date(startMonth, 1), endDate: date(month, day) },
                businessLine: lens.businessLine, basis: lens.basis, scope: lens.scope,
                ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
                asOfDate: current.map(row => performanceRecordMetadata(row).asOfDate).sort()[0] },
        };
    }
    /** `selection`, but with the DEV fallback an agent with no Mongo rows gets the stub context instead of a 404. */
    async selectionOrMock(agent, lens) {
        try {
            return await this.selection(agent, lens);
        }
        catch (error) {
            if (!this.devMockFallback || !(error instanceof PerformanceSourceNotFound))
                throw error;
            this.log(`performance DEV MOCK fallback: agent=${agent.agentId} no source rows, using stub context`);
            return { rows: {}, context: contextFor(lens) };
        }
    }
    value(def, rows, lens, repriced = false) {
        const mapping = PERFORMANCE_METRIC_MAPPING[def.metricCode];
        if (!mapping || mapping.valueType !== def.valueType)
            return undefined;
        const path = performanceMetricPath(mapping, lens.period, repriced);
        return path ? sourceMetricScalar(def.valueType, at(rows[mapping.collection], path), mapping.fraction) : undefined;
    }
    async metricList(agent, lens, listScope, codes) {
        const { rows, context } = await this.selectionOrMock(agent, lens);
        const items = effectiveCatalog(lens.scope, lens.basis)
            .filter(def => codes?.length ? codes.includes(def.metricCode) : listScope === 'ALL' || def.effCategory === listScope)
            .map((def) => {
            const collected = this.value(def, rows, lens);
            return { metricCode: def.metricCode, valueType: def.valueType, asOfDate: context.asOfDate,
                ...(def.capabilities.repricing ? { variant: 'WITHOUT_REPRICING' } : {}),
                dataState: collected ? 'OK' : 'EMPTY', ...(collected ? { collected, goal: { state: 'NOT_SET' } } : {}) };
        });
        if (!this.devMockFallback)
            return { context, items };
        const stub = new Map(stubMetricList(lens, listScope, codes).items.map(item => [item.metricCode, item]));
        const filled = [];
        const merged = items.map((item) => {
            const mock = item.dataState === 'EMPTY' ? stub.get(item.metricCode) : undefined;
            if (!mock)
                return item;
            filled.push(item.metricCode);
            return { ...mock, dataState: 'OK', asOfDate: context.asOfDate };
        });
        if (filled.length)
            this.log(`performance DEV MOCK fallback: agent=${agent.agentId} list filled=${filled.join(',')}`);
        return { context, items: merged };
    }
    async metricDetail(agent, code, lens) {
        const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
        if (!def)
            return undefined;
        const { rows, context } = await this.selectionOrMock(agent, lens);
        const collected = this.value(def, rows, lens);
        const alt = collected && def.capabilities.repricing ? this.value(def, rows, lens, true) : undefined;
        // v1.7.0 (AC-P4-02-32) / v1.20.0 (AC-P4-02-58): Penders case count for TPC/PTPC at SELF
        // and TEAM. No collection here materializes this yet (mongodb.md v1.7.0 D-19, OQ-77) —
        // mock-sourced until it does, same interim source as the stub engine in values.ts; never
        // derived from a money field.
        const pendersCaseCount = collected && def.capabilities.repricing
            ? mockTeamPendersCaseCount(code, lens.scope === 'TEAM' ? (lens.teamView ?? 'DIRECT') : 'SELF')
            : undefined;
        const detail = { metricCode: code, valueType: def.valueType, context, dataState: collected ? 'OK' : 'EMPTY',
            ...(collected ? { primary: { variant: 'WITHOUT_REPRICING', collected } } : {}),
            ...(alt ? { altVariants: [{ variant: 'WITH_REPRICING', collected: alt }] } : {}),
            ...(collected && def.threshold ? { threshold: def.threshold } : {}),
            ...(pendersCaseCount !== undefined ? { pendersCaseCount } : {}) };
        if (!this.devMockFallback)
            return detail;
        const { detail: filledDetail, filled } = mockFillDetail(code, lens, detail);
        if (filled.length)
            this.log(`performance DEV MOCK fallback: agent=${agent.agentId} metric=${code} filled=${filled.join(',')}`);
        return filledDetail;
    }
    async metricSeries(agent, code, lens, anchorYear, yearsBack) {
        const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
        if (!def?.capabilities.history)
            return undefined;
        const { context } = await this.selectionOrMock(agent, lens);
        const seriesContext = { businessLine: context.businessLine, basis: context.basis, scope: context.scope,
            ...(context.teamView ? { teamView: context.teamView } : {}), asOfDate: context.asOfDate };
        // No source collection materializes monthly history; the DEV fallback supplies the stub series.
        const stub = this.devMockFallback ? stubMetricSeries(code, lens, anchorYear, yearsBack) : undefined;
        if (stub) {
            this.log(`performance DEV MOCK fallback: agent=${agent.agentId} metric=${code} filled=history`);
            return { ...stub, context: seriesContext };
        }
        return { metricCode: code, valueType: def.valueType, context: seriesContext, anchorYear,
            series: Array.from({ length: yearsBack + 1 }, (_, offset) => ({ year: anchorYear - offset,
                points: Array.from({ length: 12 }, (_, month) => ({ month: month + 1, value: null })) })) };
    }
    async milestones(agent) {
        const { context } = await this.selectionOrMock(agent, { period: 'YTD', scope: 'SELF', basis: 'STANDARD', businessLine: 'INSURANCE' });
        if (!this.devMockFallback)
            return { asOfDate: context.asOfDate, items: [] };
        this.log(`performance DEV MOCK fallback: agent=${agent.agentId} filled=milestones`);
        return { ...stubMilestones(), asOfDate: context.asOfDate };
    }
    async getPreferences(agent, scope, basis) { return getPreferences(agent.tenant, agent.agentId, scope, basis); }
    async putPreferences(agent, scope, basis, body) {
        return putPreferences(agent.tenant, agent.agentId, scope, basis, body);
    }
    async recommendations(agent, scope = 'SELF') {
        if (this.devMockFallback) {
            this.log(`performance DEV MOCK fallback: agent=${agent.agentId} filled=recommendations`);
            return stubRecommendations(agent.agentId, scope);
        }
        const { asOfDate } = await this.milestones(agent);
        return { items: [], generatedAt: `${asOfDate}T00:00:00Z` };
    }
    async recordFeedback(agent, recommendationId, rating) {
        if (!this.devMockFallback || !agent || !recommendationId || !rating)
            return false;
        return stubRecordFeedback(agent.agentId, recommendationId, rating);
    }
    async listTeamMembers(agent, _teamView, basis, query) {
        const base = [
            { agentId: agent.agentId, displayName: agent.name, roleCode: basis },
        ];
        const normalized = query?.trim().toLowerCase() ?? '';
        const items = base
            .filter((m) => !normalized || m.agentId.toLowerCase().includes(normalized) || m.displayName.toLowerCase().includes(normalized))
            .map((m) => ({ ...m, hierarchyBasis: basis }));
        // No source collection holds the hierarchy; the DEV fallback appends the stub roster after the real self entry.
        if (this.devMockFallback)
            items.push(...mockTeamMembers(basis, query).items.filter((m) => m.agentId !== agent.agentId));
        return { asOfDate: '2026-07-27', items };
    }
    async getTeamMemberDashboard(agent, memberAgentId, lens) {
        if (memberAgentId !== agent.agentId)
            return this.devMockFallback ? mockTeamMemberDashboard(memberAgentId, lens) : undefined;
        const list = await this.metricList(agent, { ...lens, scope: 'SELF' }, 'PRIORITY', ['TPC', 'PTPC']);
        return {
            member: {
                agentId: agent.agentId,
                displayName: agent.name,
                hierarchyBasis: 'AGENT',
                roleCode: agent.level === 'P4' ? 'AGENT' : agent.level === 'P3' ? 'AM' : 'UM',
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
