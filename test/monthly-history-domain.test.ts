import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import type { Ajv as AjvInstance } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { checkMonthlyRange, isMonthEndFlag, MONTHLY_HISTORY_METRICS } from '../src/data/monthly-history.js';
import { PERFORMANCE_METRIC_MAPPING } from '../src/data/performance-mapping.js';
import type { MonthlyHistory } from '../src/types.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const Ajv = AjvModule as unknown as new (options?: Record<string, unknown>) => AjvInstance;
const source = await createSource();
const app = buildApp(source);
const H = (agentId: string) => ({ 'x-agent-id': agentId });
const get = (url: string, agentId = 'L3001') => app.inject({ url, headers: H(agentId) });
const history = async (query: string, agentId = 'L3001', path = agentId): Promise<MonthlyHistory> => {
  const res = await get(`/insights/v1/agents/${path}/monthly-history?${query}`, agentId);
  expect(res.statusCode, query).toBe(200);
  return res.json() as MonthlyHistory;
};

describe('GET /insights/v1/agents/:agentId/monthly-history (ARVIJ-1450, AC-P4-03-28)', () => {
  it('AC-P4-03-28 returns ascending records: period, then source (PAMB, PBTB), then aggregation (Personal, DirectUnit, Group)', async () => {
    const body = await history('from=2026-05&to=2026-06');
    expect(body).toMatchObject({ agentId: 'L3001', from: '2026-05', to: '2026-06' });
    expect(body.records.map((r) => `${r.period} ${r.source} ${r.aggregation}`)).toEqual([
      '2026-05 PAMB Personal', '2026-05 PAMB DirectUnit', '2026-05 PAMB Group',
      '2026-05 PBTB Personal', '2026-05 PBTB DirectUnit', '2026-05 PBTB Group',
      '2026-06 PAMB Personal', '2026-06 PAMB DirectUnit', '2026-06 PAMB Group',
      '2026-06 PBTB Personal', '2026-06 PBTB DirectUnit', '2026-06 PBTB Group',
    ]);
    for (const r of body.records) expect([r.year, r.month]).toEqual([Number(r.period.slice(0, 4)), Number(r.period.slice(5))]);
  });

  it('AC-P4-03-28 both collections carry the contract metrics in order (TPC/PTPC with both variants, MTD leaves)', async () => {
    const [record] = (await history('from=2026-06&to=2026-06&aggregation=DirectUnit')).records;
    expect(record!.production!.metrics.map((m) => [m.metricCode, m.variant])).toEqual([
      ['TPC', 'WITHOUT_REPRICING'], ['TPC', 'WITH_REPRICING'], ['PTPC', 'WITHOUT_REPRICING'], ['PTPC', 'WITH_REPRICING'],
      ['FYP', undefined], ['FYC', undefined], ['CASE_COUNT', undefined],
    ]);
    expect(record!.mapa!.metrics.map((m) => m.metricCode)).toEqual(['MANPOWER', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE', 'NEW_RECRUIT_CONTRACTED']);
    // The emitted list and the shared mapping agree on which collection owns each metric.
    for (const [collection, metrics] of Object.entries(MONTHLY_HISTORY_METRICS)) {
      for (const { metricCode } of metrics) expect(PERFORMANCE_METRIC_MAPPING[metricCode]?.collection, metricCode).toBe(collection);
    }
    // Money is a decimal string, never a float.
    expect(record!.production!.metrics[0]!.value).toMatchObject({ kind: 'MONEY', currency: 'MYR', amount: expect.stringMatching(/^\d+\.\d{2}$/) });
  });

  it('AC-P4-03-28 filters by aggregation and reads both source databases', async () => {
    const group = await history('from=2026-03&to=2026-03&aggregation=Group');
    expect(group.records.map((r) => [r.source, r.aggregation])).toEqual([['PAMB', 'Group'], ['PBTB', 'Group']]);
    expect((await history('from=2026-03&to=2026-03')).records).toHaveLength(6);
  });

  it('AC-P4-03-28 omits months with no data: the stub ends with a partial 2026-07 and has nothing after it', async () => {
    const body = await history('from=2026-06&to=2026-12&aggregation=DirectUnit');
    expect([...new Set(body.records.map((r) => r.period))]).toEqual(['2026-06', '2026-07']);
    const [june, july] = [body.records[0]!, body.records[2]!];
    expect(june.production).toMatchObject({ asOnDate: '2026-06-30', monthEnd: true });
    expect(july.production).toMatchObject({ asOnDate: '2026-07-27', monthEnd: false });
    expect((await history('from=2026-08&to=2026-12')).records).toEqual([]);
    expect((await history('from=2019-01&to=2019-12')).records).toEqual([]);
  });

  it('AC-P4-03-28 stub covers 36+ months of closed history and is deterministic', async () => {
    const wide = await history('from=2023-01&to=2026-07&aggregation=Personal');
    expect(new Set(wide.records.filter((r) => r.source === 'PAMB').map((r) => r.period)).size).toBe(43);
    const again = await history('from=2023-01&to=2026-07&aggregation=Personal');
    expect(again).toEqual(wide);
  });

  it('AC-P4-03-28 EMPTY demo agent has no rows (a new agent: records [])', async () => {
    expect((await history('from=2026-01&to=2026-06', 'A1002')).records).toEqual([]);
  });

  describe('validation (INS-4000 problem+json)', () => {
    const bad: Array<[string, string]> = [
      ['from=2026-01', 'missing to'],
      ['to=2026-01', 'missing from'],
      ['from=2026-1&to=2026-02', 'one-digit month'],
      ['from=2026-13&to=2026-14', 'month 13'],
      ['from=2026-00&to=2026-02', 'month 00'],
      ['from=26-01&to=2026-02', 'two-digit year'],
      ['from=2026-01-01&to=2026-02', 'full date'],
      ['from=2026-03&to=2026-02', 'from after to'],
      ['from=2022-01&to=2026-01', '49 months'],
      ['from=2026-01&to=2026-02&aggregation=Scheme', 'unknown aggregation'],
      ['from=2026-01&to=2026-02&aggregation=personal', 'aggregation is case sensitive'],
      ['from=2026-01&from=2026-02&to=2026-03', 'repeated parameter'],
    ];
    for (const [query, why] of bad) {
      it(`AC-P4-03-28 ${why} → 400 INS-4000`, async () => {
        const res = await get(`/insights/v1/agents/L3001/monthly-history?${query}`);
        expect(res.statusCode).toBe(400);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.json()).toMatchObject({ code: 'INS-4000', status: 400, title: 'Invalid parameter' });
      });
    }
    it('AC-P4-03-28 accepts exactly 48 months and rejects 49', async () => {
      expect((await history('from=2023-01&to=2026-12')).records.length).toBeGreaterThan(0);
      const over = await get('/insights/v1/agents/L3001/monthly-history?from=2023-01&to=2027-01');
      expect(over.statusCode).toBe(400);
      expect(over.json().detail).toMatch(/49 months/);
    });
    it('AC-P4-03-28 shared range check', () => {
      expect(checkMonthlyRange('2026-01', '2026-01')).toMatchObject({ ok: true });
      expect(checkMonthlyRange('2026-01', '2025-12')).toMatchObject({ ok: false });
      expect(checkMonthlyRange(undefined, '2025-12')).toMatchObject({ ok: false });
      expect(checkMonthlyRange('2025-01', '2028-12')).toMatchObject({ ok: true });
      expect(checkMonthlyRange('2025-01', '2029-01')).toMatchObject({ ok: false });
    });
  });

  describe('identity (same handling as the series route)', () => {
    it('AC-P4-03-28 unknown caller → 401, unknown path agent → 404, another P4 agent → 403', async () => {
      expect((await get('/insights/v1/agents/L3001/monthly-history?from=2026-01&to=2026-02', 'NOBODY')).statusCode).toBe(401);
      const unknown = await get('/insights/v1/agents/NOBODY/monthly-history?from=2026-01&to=2026-02');
      expect([unknown.statusCode, unknown.json().code]).toEqual([404, 'INS-4040']);
      const other = await get('/insights/v1/agents/L2001/monthly-history?from=2026-01&to=2026-02', 'A1001');
      expect([other.statusCode, other.json().code]).toEqual([403, 'INS-4030']);
    });
    it('AC-P4-03-28 a P4 agent reads its own history; a leader may read a downline agent', async () => {
      expect((await history('from=2026-06&to=2026-06', 'A1001')).agentId).toBe('A1001');
      expect((await history('from=2026-06&to=2026-06', 'L3001', 'A1001')).agentId).toBe('A1001');
    });
    it('AC-P4-03-28 validation does not run before identity (an unknown caller never sees 400 detail)', async () => {
      expect((await get('/insights/v1/agents/L3001/monthly-history?from=bad&to=worse', 'NOBODY')).statusCode).toBe(401);
    });
  });

  describe('contract', () => {
    const spec = parseYaml(readFileSync(new URL('../vendor/spec/insights.v1.yaml', import.meta.url), 'utf8')) as {
      paths: Record<string, { get?: { operationId: string; tags: string[]; parameters: Array<{ name?: string; required?: boolean }> } }>;
      components: Record<string, unknown>;
    };

    it('AC-P4-03-28 the vendored OpenAPI declares getAgentMonthlyHistory with from/to required and aggregation optional', () => {
      const op = spec.paths['/agents/{agentId}/monthly-history']?.get;
      expect(op).toMatchObject({ operationId: 'getAgentMonthlyHistory', tags: ['MonthlyHistory'] });
      const params = Object.fromEntries(op!.parameters.filter((p) => p.name).map((p) => [p.name, Boolean(p.required)]));
      expect(params).toEqual({ from: true, to: true, aggregation: false });
    });

    it('AC-P4-03-28 swagger serves the operation', async () => {
      const res = await app.inject({ url: '/docs/json' });
      expect(res.statusCode).toBe(200);
      expect(res.json().paths['/agents/{agentId}/monthly-history'].get.operationId).toBe('getAgentMonthlyHistory');
    });

    /** OpenAPI 3.0 as JSON Schema: `nullable` (used here without a `type`, beside allOf) becomes null-or-schema; `discriminator` is dropped (the oneOf arms are disjoint on `kind`). */
    const nullable = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(nullable);
      if (!node || typeof node !== 'object') return node;
      const { nullable: isNullable, discriminator: _discriminator, ...rest } = node as Record<string, unknown>;
      const converted = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, nullable(v)]));
      return isNullable === true && converted.type === undefined ? { anyOf: [{ type: 'null' }, converted] } : converted;
    };

    it('AC-P4-03-28 the response validates against the MonthlyHistory schema', async () => {
      const ajv = new Ajv({ strict: false, validateFormats: false });
      const validate = ajv.compile({ $ref: '#/components/schemas/MonthlyHistory', components: nullable(spec.components) as object });
      const body = await history('from=2026-06&to=2026-07');
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...body, records: [{ ...body.records[0], source: 'OTHER' }] })).toBe(false);
    });
  });

  it('AC-P4-03-28 isMonthEnd spelling tolerance (data-owner confirmation pending)', () => {
    for (const yes of ['Y', 'y', 'YES', 'Yes', 'true', 'TRUE', '1', 1, true, ' Y ']) expect(isMonthEndFlag(yes), String(yes)).toBe(true);
    for (const no of [null, undefined, '', 'N', 'no', 'false', '0', 0, false, 'maybe', {}]) expect(isMonthEndFlag(no), String(no)).toBe(false);
  });
});
