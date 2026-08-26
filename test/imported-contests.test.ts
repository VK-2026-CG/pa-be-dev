import { describe,expect,it } from 'vitest';
import { createSpecContestRepository,SpecContestRepository } from '../src/contest/spec-repository.js';
import { loadContestSeed,validateContestSeed,type ContestSeed } from '../src/contest/imported-seed.js';

describe('MY 2026 imported contest seed',()=>{
  it('validates exact artifacts, stable identities, checksums, citations and custom periods',async()=>{
    const seed=await loadContestSeed();
    expect(seed.documents.map(item=>item.contest.code)).toEqual(['ACC2026_05','ACC2026_07','ACC2026_10a','ACC2026_20','ACC2026_21a','ACC2026_26']);
    expect(seed.artifacts.every(item=>/^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    const yunnan=seed.documents.find(item=>item.contest.code==='ACC2026_26')!.version.configuration.importedCircular;
    expect(yunnan.periods.map((item:{periodId:string})=>item.periodId)).toEqual(['H1','H2','FULL']);
  });

  it('uses ACC2026_21a thresholds and retains ACC2026_21 only as superseded provenance',async()=>{
    const seed=await loadContestSeed();const raap=seed.documents.find(item=>item.contest.code==='ACC2026_21a')!;
    expect(raap.version.configuration.importedCircular.citations).toEqual(expect.arrayContaining([expect.objectContaining({circularCode:'ACC2026_21',status:'SUPERSEDED',supersededBy:'ACC2026_21a'})]));
    const routes=raap.version.configuration.qualification.routes;
    const money=(routeId:string)=>JSON.stringify(routes.find((item:{routeId:string})=>item.routeId===routeId).expression);
    expect(money('raap_group_am')).toContain('1000000.00');expect(money('raap_group_health')).toContain('1000000.00');
    expect(money('raap_du_um')).toContain('500000.00');expect(money('raap_rookie')).toContain('125000.00');
    expect(money('raap_health')).toContain('PRODUCT_CODE');expect(money('raap_health')).toContain('RIDER_CODE');
  });

  it('rejects tampering before materialization',async()=>{
    const seed=structuredClone(await loadContestSeed()) as ContestSeed;
    seed.documents[0]!.version.configuration.basics.code='TAMPERED';
    expect(()=>validateContestSeed(seed)).toThrow(/checksum/);
  });

  it('loads six drafts through the application factory while direct repositories stay isolated',async()=>{
    process.env.MONGODB_URI='';
    const direct=new SpecContestRepository();expect((await direct.listContests('MY')).items).toHaveLength(0);
    const repository=await createSpecContestRepository();const contests=await repository.listContests('MY');
    expect(contests.items).toHaveLength(6);expect(contests.items.every(item=>item.status==='DRAFT')).toBe(true);
    expect(await repository.version('MY','version_raap_2026_v1')).toMatchObject({status:'DRAFT',configuration:{basics:{sourceCircular:'ACC2026_21a'}}});
    expect((await repository.listContests('MY','DRAFT','ACC2026_21a')).items.map(item=>item.code)).toEqual(['ACC2026_21a']);
  });
});