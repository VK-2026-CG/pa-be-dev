import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importedContestBuilders } from '../src/bff/contest-admin/imported-contests.js';
import { validateImportedContest } from '../src/bff/contest-admin/import-validation.js';
import { IMPORTED_CONTEST_SEED_PATH } from '../src/contest/imported-seed.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const artifacts={
  ACC2026_05:{sourceName:'ACC2026_05_2026 Prudential Wealth Planner.pdf',sha256:'53b06f53a66fb14aa0815a217431cc6153865f109c74f60ef43a7e5c27182824',pdfPages:6,numberedPages:5},
  ACC2026_07:{sourceName:'ACC2026_07_2027 MDRT Series.pdf',sha256:'03cfbfd902387b8f53e34ae81ae7e1d6eedc70d5fccca707c34f8c5fcb136cae',pdfPages:7,numberedPages:6},
  ACC2026_10a:{sourceName:'ACC2026_10a_2026 Star Club Series.pdf',sha256:'13c9521d5c1376e17f370bc2a65144aa92fe7b2b9011b9819dea492d7775fe88',pdfPages:17,numberedPages:16},
  ACC2026_20:{sourceName:'ACC2026_20_2026 Top Achievers.pdf',sha256:'edb1c894d083e7d406cd9fa9dccc7bf252e3b7824ee5fb32d6919f8485a3f649',pdfPages:11,numberedPages:10},
  ACC2026_21a:{sourceName:'ACC2026_21a_2026 RAAP.pdf',sha256:'4f07ef0650b06cd67ebfdb282dcc4550dbef1cbf0077d07a1d76cc7c0bc800a8',pdfPages:10,numberedPages:9},
  ACC2026_26:{sourceName:'ACC2026_26_Race To YunNan.pdf',sha256:'9f356d49f3d3fa2cd30c636819ff62b41d7c8a5b359442a7cb72c4a40130f26f',pdfPages:6,numberedPages:5},
} as const;

async function main(){
  const target=resolve(process.argv[2]??IMPORTED_CONTEST_SEED_PATH);
  const documents=importedContestBuilders.map(builder=>{
    const issues=validateImportedContest(builder);
    if(issues.length)throw new Error(`${builder.contest.code} has ${issues.length} unresolved import references`);
    const configuration=builder.configuration;
    return {
      contest:{...builder.contest,latestVersionId:builder.versionId,country:'MY',timezone:'Asia/Kuala_Lumpur',status:'DRAFT',archived:false,revision:builder.revision},
      version:{versionId:builder.versionId,contestId:builder.contest.contestId,revision:builder.revision,displayVersion:'1.0',status:'DRAFT',configuration,checksum:hash(configuration),catalogueVersion:builder.catalogue.version,createdBy:'SYSTEM_CIRCULAR_IMPORT',createdAt:builder.contest.updatedAt,updatedAt:builder.contest.updatedAt},
    };
  });
  const artifactList=documents.map(({contest,version})=>{const code=contest.code as keyof typeof artifacts;const artifact=artifacts[code];if(!artifact)throw new Error(`No source artifact registered for ${contest.code}`);const imported=version.configuration.importedCircular;if(imported.effectiveCircularCode!==code||imported.sourceName!==artifact.sourceName)throw new Error(`${code} source artifact does not match effective circular`);return{circularCode:code,...artifact};});
  await writeFile(target,`${JSON.stringify({schemaVersion:'1.0',country:'MY',catalogueVersion:'MY-2026.2',generatedFrom:'src/bff/contest-admin/imported-contests.ts',artifacts:artifactList,documents},null,2)}\n`);
  console.log(`Exported ${documents.length} validated contests to ${target}`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
