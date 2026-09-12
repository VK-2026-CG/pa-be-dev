/**
 * DataSource — the single seam between the HTTP routes and the data layer.
 *
 *  - MemorySource: the deterministic in-process engine (default; tests, dev).
 *  - MongoSource:  reads the C1 collections in MongoDB Atlas. Documents are
 *    keyed exactly per pruaction-spec mongodb.md (unique tuples + lineage
 *    fields); the API-shaped body written by the seeder sits under `payload`
 *    (see scripts/db-seed.ts header for the pipeline note).
 *
 * Selected at boot: MONGODB_URI set ⇒ Mongo, else memory.
 */
import type { Db, Document } from 'mongodb';
import { COLL, getDb } from '../db/mongo.js';
import { AGENTS, type AgentRecord } from './registry.js';
import { CATALOG, effectiveCatalog, type EffectiveDef } from './catalog.js';
import {
  ANCHOR_YEAR, contextFor, metricDetail, metricList, metricSeries, milestones, type Lens,
} from './values.js';
import { getPreferences, putPreferences, type PrefError } from './preferences.js';
import { recommendations, recordFeedback } from './recommendations.js';
import type {
  Basis, MetricDetail, MetricPreferences, MetricSeries, MetricSnapshot, MetricSnapshotList,
  MilestoneProgressList, Scope,
} from '../types.js';
import type { RecommendationListPayload } from './recommendations.js';

export interface DataSource {
  readonly kind: 'memory' | 'mongo';
  metricList(agent: AgentRecord, l: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]): Promise<MetricSnapshotList | undefined>;
  metricDetail(agent: AgentRecord, code: string, l: Lens): Promise<MetricDetail | undefined>;
  metricSeries(agent: AgentRecord, code: string, l: Lens, anchorYear: number, yearsBack: number): Promise<MetricSeries | undefined>;
  milestones(agent: AgentRecord): Promise<MilestoneProgressList>;
  getPreferences(agent: AgentRecord, scope: Scope, basis: Basis): Promise<MetricPreferences>;
  putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }):
    Promise<{ ok: true; prefs: MetricPreferences } | { ok: false; error: PrefError }>;
  recommendations(agent: AgentRecord, scope: Scope): Promise<RecommendationListPayload>;
  recordFeedback(agent: AgentRecord, recommendationId: string, rating: 'UP' | 'DOWN'): Promise<boolean>;
}

/* ── in-memory (existing deterministic engine) ─────────────────────────── */
class MemorySource implements DataSource {
  readonly kind = 'memory' as const;
  async metricList(agent: AgentRecord, l: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]) {
    void agent;
    return metricList(l, listScope, codes);
  }
  async metricDetail(agent: AgentRecord, code: string, l: Lens) {
    return metricDetail(code, l, agent.demoDataState);
  }
  async metricSeries(agent: AgentRecord, code: string, l: Lens, anchorYear: number, yearsBack: number) {
    void agent;
    return metricSeries(code, l, anchorYear, yearsBack);
  }
  async milestones() { return milestones(); }
  async getPreferences(agent: AgentRecord, scope: Scope, basis: Basis) {
    return getPreferences(agent.tenant, agent.agentId, scope, basis);
  }
  async putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }) {
    return putPreferences(agent.tenant, agent.agentId, scope, basis, body);
  }
  async recommendations(agent: AgentRecord, scope: Scope) { return recommendations(agent.agentId, scope); }
  async recordFeedback(agent: AgentRecord, recommendationId: string, rating: 'UP' | 'DOWN') {
    return recordFeedback(agent.agentId, recommendationId, rating);
  }
}

/* ── Mongo-backed reads (C1 collections; see scripts/db-seed.ts) ───────── */
const tv = (l: Lens) => (l.scope === 'SELF' ? '-' : (l.teamView ?? 'DIRECT'));

export class MongoSource implements DataSource {
  readonly kind = 'mongo' as const;
  constructor(private db: Db) {}

  private lensKey(agent: AgentRecord, l: Lens): Document {
    return {
      tenant: agent.tenant, agentId: agent.agentId,
      'period.type': l.period, businessLine: l.businessLine, basis: l.basis,
      scope: l.scope, teamView: tv(l),
    };
  }

  async metricList(agent: AgentRecord, l: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]) {
    const q: Document = { ...this.lensKey(agent, l) };
    if (codes?.length) q.metricCode = { $in: codes };
    const docs = await this.db.collection(COLL.snapshots).find(q).sort({ order: 1 }).toArray();
    if (docs.length === 0) return undefined;
    // Catalog order (effOrder-sorted) — Map preserves insertion order.
    const cat = new Map(effectiveCatalog(l.scope, l.basis).map((d) => [d.metricCode, d]));
    const inScope = (def: EffectiveDef) => listScope === 'ALL' || def.effCategory === listScope;

    const present = new Set<string>();
    const items: MetricSnapshot[] = [];
    for (const d of docs) {
      const def = cat.get(d.metricCode as string);
      if (!def || !inScope(def)) continue;
      present.add(def.metricCode);
      items.push(d.payload as MetricSnapshot); // verbatim — pipelines own the payload shape
    }

    /*
     * A requested-but-absent metric is no longer dropped (mongodb.md §7.13): the card
     * is emitted with `metricCode`/`valueType` (and therefore its nav) intact and NO
     * collected value, so the UI renders a data state instead of the metric silently
     * vanishing. An absent/null source measure is never zero-filled or synthesized
     * (§7.12).
     *
     * §7.7 would resolve "absent while the tenant batch is in flight" to PROCESSING,
     * but that derivation needs the pipeline `batch_control` collection, which does
     * not exist in this repo (source-mapping.md OQ-PA-09). Per §7.13, where that
     * collection is unavailable the state resolves to EMPTY — so we never claim
     * PROCESSING here.
     */
    const first = docs[0]!;
    const asOfDate = (first.context?.asOfDate ?? first.asOfDateStr ?? '') as string;
    for (const def of cat.values()) {
      if (present.has(def.metricCode) || !inScope(def)) continue;
      if (codes?.length && !codes.includes(def.metricCode)) continue; // only what was asked for
      // Placeholders trail the materialized rows, leaving the pipeline `order` sort untouched.
      items.push({ metricCode: def.metricCode, valueType: def.valueType, dataState: 'EMPTY', asOfDate });
    }

    return { context: first.context, items } as MetricSnapshotList;
  }

  async metricDetail(agent: AgentRecord, code: string, l: Lens) {
    const doc = await this.db.collection(COLL.snapshots).findOne({ ...this.lensKey(agent, l), metricCode: code });
    return (doc?.detailPayload ?? undefined) as MetricDetail | undefined;
  }

  async metricSeries(agent: AgentRecord, code: string, l: Lens, anchorYear: number, yearsBack: number) {
    const years = Array.from({ length: yearsBack + 1 }, (_, i) => anchorYear - yearsBack + i);
    const docs = await this.db.collection(COLL.series).find({
      tenant: agent.tenant, agentId: agent.agentId, metricCode: code,
      businessLine: l.businessLine, basis: l.basis, scope: l.scope, teamView: tv(l),
      year: { $in: years },
    }).sort({ year: 1 }).toArray();
    if (docs.length === 0) return undefined;
    const first = docs[0]!;
    return {
      metricCode: code, valueType: first.valueType,
      context: {
        businessLine: l.businessLine, basis: l.basis, scope: l.scope,
        ...(l.scope === 'TEAM' ? { teamView: l.teamView ?? 'DIRECT' } : {}),
        asOfDate: first.asOfDateStr,
      },
      anchorYear,
      series: docs.map((d) => ({ year: d.year, points: d.points })),
    } as MetricSeries;
  }

  async milestones(agent: AgentRecord) {
    const docs = await this.db.collection(COLL.milestones)
      .find({ tenant: agent.tenant, agentId: agent.agentId })
      .sort({ order: 1 }).toArray();
    return { asOfDate: docs[0]?.asOfDateStr ?? '', items: docs.map((d) => d.payload) } as MilestoneProgressList;
  }

  async getPreferences(agent: AgentRecord, scope: Scope, basis: Basis) {
    const doc = await this.db.collection(COLL.preferences).findOne({
      '_id.tenant': agent.tenant, '_id.agentId': agent.agentId, '_id.scope': scope,
    } as Document);
    if (doc) {
      return {
        priorityMetricCodes: doc.priorityMetricCodes, focusMetricCodes: doc.focusMetricCodes,
        source: 'AGENT', updatedAt: doc.updatedAt,
      } as MetricPreferences;
    }
    // Absent ⇒ DEFAULT from catalog (contract §5) — same rule as memory mode.
    return getPreferences(agent.tenant, agent.agentId, scope, basis);
  }

  async putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }) {
    // Reuse the engine's invariant validation (422 rules), then persist.
    const res = putPreferences(agent.tenant, agent.agentId, scope, basis, body);
    if (!res.ok) return res;
    await this.db.collection(COLL.preferences).updateOne(
      { _id: { tenant: agent.tenant, agentId: agent.agentId, scope } } as Document,
      { $set: { priorityMetricCodes: body.priorityMetricCodes, focusMetricCodes: body.focusMetricCodes, updatedAt: res.prefs.updatedAt } },
      { upsert: true },
    );
    return res;
  }

  async recommendations(agent: AgentRecord, scope: Scope) {
    const doc = await this.db.collection(COLL.recommendations).findOne({
      tenant: agent.tenant, agentId: agent.agentId, scope, context: 'PERFORMANCE',
    });
    const payload = (doc?.payload ?? recommendations(agent.agentId, scope)) as RecommendationListPayload;
    const recoId = payload.panel?.recommendationId;
    const fb = recoId ? await this.db.collection(COLL.recoFeedback).findOne({
      '_id.tenant': agent.tenant, '_id.agentId': agent.agentId,
      '_id.recommendationId': recoId,
    } as Document) : null;
    if (fb && payload.panel) payload.panel.feedback = fb.rating;
    return payload;
  }

  async recordFeedback(agent: AgentRecord, recommendationId: string, rating: 'UP' | 'DOWN') {
    const rec = await this.db.collection(COLL.recommendations).findOne({
      tenant: agent.tenant, agentId: agent.agentId, recommendationId,
    });
    if (!rec) return false;
    await this.db.collection(COLL.recoFeedback).updateOne(
      { _id: { tenant: agent.tenant, agentId: agent.agentId, recommendationId } } as Document,
      { $set: { rating, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
    return true;
  }
}

export async function createSource(log: (msg: string) => void = () => {}): Promise<DataSource> {
  if (!process.env.MONGODB_URI) { log('data source: in-memory engine (MONGODB_URI not set)'); return new MemorySource(); }
  const db = await getDb();
  log(`data source: MongoDB (${db.databaseName})`);
  return new MongoSource(db);
}

export { AGENTS, ANCHOR_YEAR, CATALOG, contextFor };
