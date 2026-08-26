import { resolve } from 'node:path';
import { closeDb, COLL, getContestDb } from '../src/db/mongo.js';
import { IMPORTED_CONTEST_SEED_PATH, loadContestSeed } from '../src/contest/imported-seed.js';

const source=resolve(process.argv.find(value=>value.endsWith('.json'))??IMPORTED_CONTEST_SEED_PATH);
const dryRun=process.argv.includes('--dry-run');

async function main(){
  const seed=await loadContestSeed(source);
  const summary=seed.documents.map(({contest,version})=>`${contest.code}: ${((version.configuration as Record<string,unknown>).qualification as {routes:unknown[]}).routes.length} routes`).join('\n');
  if(dryRun){console.log(`Validated ${seed.documents.length} contests in ${seed.country}:\n${summary}`);return;}
  const db=await getContestDb();const session=db.client.startSession();
  try{
    await session.withTransaction(async()=>{
      for(const {contest,version} of seed.documents){
        const tenant=seed.country;
        const existing=await db.collection(COLL.contestVersions).findOne({tenant,versionId:version.versionId},{session});
        if(existing&&existing.status!=='DRAFT')throw new Error(`${contest.code} ${version.versionId} is ${existing.status}; source import may only replace DRAFT versions`);
        await db.collection(COLL.contests).replaceOne({tenant,contestId:contest.contestId},{tenant,...contest},{upsert:true,session});
        await db.collection(COLL.contestVersions).replaceOne({tenant,versionId:version.versionId},{tenant,...version},{upsert:true,session});
      }
    });
  }finally{await session.endSession();}
  console.log(`Imported ${seed.documents.length} validated DRAFT contests into ${db.databaseName}:\n${summary}`);
  await closeDb();
}
main().catch(async error=>{console.error(error);await closeDb();process.exitCode=1;});