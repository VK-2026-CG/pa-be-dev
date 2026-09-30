import { getPerformanceDb } from '../../src/db/mongo.js';
const AGENTS = (process.argv[2] ?? '1136911,1002809,1089054,1101749').split(',');
const PATHS: Record<string, [string, string]> = {
  TPC: ['my_production', 'ptd.tpc.withoutRepricing'], PTPC: ['my_production', 'ptd.ptpc.withoutRepricing'], FYP: ['my_production', 'ptd.fyp'],
  FYC: ['my_production', 'ptd.fyc'], CASE_COUNT: ['my_production', 'ptd.caseCount.total'],
  MANPOWER: ['my_mapa', 'ptd.manpowerTotal'], ACTIVITY_RATIO: ['my_mapa', 'ptd.activityRatio'], PRODUCTIVITY: ['my_mapa', 'ptd.productivity'],
  AVERAGE_CASE_SIZE: ['my_mapa', 'ptd.averageCaseSize'], NEW_RECRUIT_CONTRACTED: ['my_mapa', 'ptd.newRecruits'],
  PERSISTENCY_CY: ['my_persistency', 'metrics.ytd.currentYearPersistency'], PERSISTENCY_Y1: ['my_persistency', 'metrics.ytd.firstYearPersistency'], PERSISTENCY_Y2: ['my_persistency', 'metrics.ytd.secondYearPersistency'],
};
const get = (o: any, p: string) => p.split('.').reduce((v, k) => v?.[k], o);
const out: any = {};
for (const key of ['PAMB', 'PBTB'] as const) {
  const db = await getPerformanceDb(key);
  for (const id of AGENTS) {
    const h = await db.collection('my_agent_hierarchy').find({ 'hierarchy.leaderId': id }).sort({ asOnDate: -1, 'audit.updatedAt': -1, _id: -1 }).limit(1).toArray();
    const hier = h[0] ? { tier: h[0].displayRows?.tier, reportees: (h[0].subtree?.scopeProfileIds ?? []).filter((x: string) => x !== id).length, asOnDate: h[0].asOnDate } : null;
    const agg: any = {};
    for (const a of ['Personal', 'DirectUnit', 'Group']) {
      const latest: any = {};
      for (const c of ['my_production', 'my_mapa', 'my_persistency']) {
        const q: any = { agentId: id, entity: key, agentAggregation: a }; if (c === 'my_production') q.caseStatus = 'Collected';
        const d = (await db.collection(c).find(q).sort({ 'period.year': -1, 'period.month': -1, id: -1, _id: -1 }).limit(1).toArray())[0];
        if (d) latest[c] = d;
      }
      if (!Object.keys(latest).length) continue;
      const vals: any = { periods: Object.fromEntries(Object.entries(latest).map(([c, d]: any) => [c, `${d.period.yyyymm}${d.period.asOnMonthDay ? '@' + String(d.period.asOnMonthDay).slice(0, 10) : ''}`])) };
      for (const [m, [c, p]] of Object.entries(PATHS)) {
        const d = latest[c]; if (!d) continue;
        const v = get(d, p.startsWith('metrics') ? p : p + '.ytd');
        vals[m] = v === undefined ? 'MISSING' : v;
      }
      agg[a] = vals;
    }
    out[`${key}:${id}`] = { hier, agg };
  }
}
console.log(JSON.stringify(out, (_k, v) => typeof v === 'object' && v?._bsontype ? v.toString() : v, 1));
process.exit(0);
