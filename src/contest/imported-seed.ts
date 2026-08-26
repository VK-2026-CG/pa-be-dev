import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Document } from 'mongodb';
import { validateRuleExpression } from './rule-engine.js';

export interface ContestSeedArtifact { circularCode:string;sourceName:string;sha256:string;pdfPages:number;numberedPages:number }
export interface ContestSeedDocument { contest:Document;version:Document }
export interface ContestSeed { schemaVersion:string;country:string;catalogueVersion:string;generatedFrom:string;artifacts:ContestSeedArtifact[];documents:ContestSeedDocument[] }

export const IMPORTED_CONTEST_SEED_PATH=fileURLToPath(new URL('../../vendor/spec/imported-contests.my-2026.json',import.meta.url));
const expected:Record<string,{contestId:string;versionId:string;sha256:string;pdfPages:number}>={
  ACC2026_05:{contestId:'contest_wealth_planner_2026',versionId:'version_wealth_planner_2026_v1',sha256:'53b06f53a66fb14aa0815a217431cc6153865f109c74f60ef43a7e5c27182824',pdfPages:6},
  ACC2026_07:{contestId:'contest_mdrt_2027',versionId:'version_mdrt_2027_v1',sha256:'03cfbfd902387b8f53e34ae81ae7e1d6eedc70d5fccca707c34f8c5fcb136cae',pdfPages:7},
  ACC2026_10a:{contestId:'contest_star_club_2026',versionId:'version_star_club_2026_v1',sha256:'13c9521d5c1376e17f370bc2a65144aa92fe7b2b9011b9819dea492d7775fe88',pdfPages:17},
  ACC2026_20:{contestId:'contest_top_achievers_2026',versionId:'version_top_achievers_2026_v1',sha256:'edb1c894d083e7d406cd9fa9dccc7bf252e3b7824ee5fb32d6919f8485a3f649',pdfPages:11},
  ACC2026_21a:{contestId:'contest_raap_2026',versionId:'version_raap_2026_v1',sha256:'4f07ef0650b06cd67ebfdb282dcc4550dbef1cbf0077d07a1d76cc7c0bc800a8',pdfPages:10},
  ACC2026_26:{contestId:'contest_race_yunnan_2026',versionId:'version_race_yunnan_2026_v1',sha256:'9f356d49f3d3fa2cd30c636819ff62b41d7c8a5b359442a7cb72c4a40130f26f',pdfPages:6},
};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalDecimal=/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function walk(value:unknown,visit:(item:Document,path:string)=>void,path=''):void{
  if(Array.isArray(value)){value.forEach((item,index)=>walk(item,visit,`${path}/${index}`));return;}
  if(value&&typeof value==='object'){const item=value as Document;visit(item,path);for(const [key,child] of Object.entries(item))walk(child,visit,`${path}/${key}`);}
}

export function validateContestSeed(seed:ContestSeed):void{
  if(seed.schemaVersion!=='1.0'||seed.country!=='MY'||seed.catalogueVersion!=='MY-2026.2')throw new Error('Expected MY contest seed schema 1.0 / catalogue MY-2026.2');
  const expectedCodes=Object.keys(expected);const codes=seed.documents.map(item=>String(item.contest.code));
  if(seed.documents.length!==expectedCodes.length||new Set(codes).size!==expectedCodes.length||expectedCodes.some(code=>!codes.includes(code)))throw new Error(`Expected contest codes ${expectedCodes.join(', ')}`);
  if(seed.artifacts.length!==expectedCodes.length)throw new Error('Expected one source artifact per contest');
  const artifacts=new Map(seed.artifacts.map(item=>[item.circularCode,item]));
  for(const {contest,version} of seed.documents){
    const code=String(contest.code);const identity=expected[code];const artifact=artifacts.get(code);if(!identity||!artifact)throw new Error(`Unknown contest ${code}`);
    if(contest.contestId!==identity.contestId||version.versionId!==identity.versionId||contest.contestId!==version.contestId||contest.latestVersionId!==version.versionId)throw new Error(`${code} stable identity mismatch`);
    if(contest.status!=='DRAFT'||version.status!=='DRAFT'||contest.archived!==false)throw new Error(`${code} imported configuration must remain DRAFT and active`);
    if(artifact.sha256!==identity.sha256||artifact.pdfPages!==identity.pdfPages||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new Error(`${code} source artifact hash/page mismatch`);
    if(version.catalogueVersion!==seed.catalogueVersion||version.checksum!==hash(version.configuration))throw new Error(`${code} configuration checksum/catalogue mismatch`);
    const imported=(version.configuration as Document)?.importedCircular as Document|undefined;
    if(!imported||imported.effectiveCircularCode!==code||imported.sourceName!==artifact.sourceName||imported.reviewState!=='VERIFIED')throw new Error(`${code} effective source mismatch`);
    const citations=imported.citations as Document[]|undefined;if(!Array.isArray(citations)||!citations.length)throw new Error(`${code} has no citations`);
    const citationIds=new Set<string>();for(const citation of citations){const citationId=String(citation.citationId);const active=citation.circularCode===code&&citation.status==='ACTIVE';const superseded=citation.status==='SUPERSEDED'&&citation.supersededBy===code;if(citationIds.has(citationId)||(!active&&!superseded)||!Number.isInteger(citation.page)||citation.page<1||citation.page>artifact.numberedPages)throw new Error(`${code} invalid citation ${citationId}`);citationIds.add(citationId);}
    const periods=imported.periods as Document[]|undefined;const periodIds=new Set((periods??[]).map(item=>String(item.periodId)));if(!periodIds.size)throw new Error(`${code} has no periods`);
    const routes=(version.configuration as Document)?.qualification?.routes as Document[]|undefined;if(!Array.isArray(routes)||!routes.length)throw new Error(`${code} has no qualification routes`);
    const periodMode=periodIds.size>1?'CUSTOM_WINDOWS':'FULL_CAMPAIGN';
    for(const route of routes){const report=validateRuleExpression(route.expression,{periodMode,unknownCodePolicy:'BLOCK'});if(!report.valid)throw new Error(`${code}/${route.routeId} is invalid: ${JSON.stringify(report.issues)}`);}
    walk(version.configuration,(item,path)=>{
      if(Array.isArray(item.sourceCitationIds))for(const citationId of item.sourceCitationIds)if(!citationIds.has(String(citationId)))throw new Error(`${code} unknown citation ${citationId} at ${path}`);
      if(item.context?.periodId&&!periodIds.has(String(item.context.periodId)))throw new Error(`${code} unknown period ${item.context.periodId} at ${path}`);
      if(['MONEY','DECIMAL','PERCENT'].includes(String(item.kind))&&typeof item.value==='string'&&!canonicalDecimal.test(item.value))throw new Error(`${code} non-canonical decimal at ${path}`);
    });
    if(code==='ACC2026_21a'&&!citations.some(item=>item.circularCode==='ACC2026_21'&&item.status==='SUPERSEDED'&&item.supersededBy==='ACC2026_21a'))throw new Error('ACC2026_21a must retain ACC2026_21 as superseded provenance');
  }
}

export async function loadContestSeed(path=IMPORTED_CONTEST_SEED_PATH):Promise<ContestSeed>{const seed=JSON.parse(await readFile(path,'utf8')) as ContestSeed;validateContestSeed(seed);return seed;}