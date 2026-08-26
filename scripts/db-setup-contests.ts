import { closeDb, COLL, getContestDb } from '../src/db/mongo.js';

const validators:Record<string,object>={
  [COLL.contests]:{bsonType:'object',required:['tenant','contestId','code','nameKey','country','timezone','ownerRef','status','latestVersionId','archived','revision','createdAt','updatedAt'],properties:{tenant:{bsonType:'string'},contestId:{bsonType:'string'},code:{bsonType:'string'},status:{enum:['DRAFT','IN_REVIEW','RETURNED','APPROVED','SCHEDULED','ACTIVE','TRACKING','COMPLETED','NEEDS_ATTENTION','ARCHIVED','CANCELLED']},latestVersionId:{bsonType:'string'},archived:{bsonType:'bool'},revision:{bsonType:'int'}},additionalProperties:true},
  [COLL.contestVersions]:{bsonType:'object',required:['tenant','contestId','versionId','revision','status','configuration','checksum','createdBy','createdAt'],properties:{tenant:{bsonType:'string'},contestId:{bsonType:'string'},versionId:{bsonType:'string'},revision:{bsonType:'int'},status:{enum:['DRAFT','IN_REVIEW','RETURNED','APPROVED','PUBLISHED','SUPERSEDED','CANCELLED']},configuration:{bsonType:'object'},checksum:{bsonType:'string'}},additionalProperties:true},
  [COLL.brochures]:{bsonType:'object',required:['tenant','brochureId','contestId','versionId','fileName','mediaType','sizeBytes','sha256','objectKey','status','uploadedBy','uploadedAt'],properties:{tenant:{bsonType:'string'},brochureId:{bsonType:'string'},contestId:{bsonType:'string'},versionId:{bsonType:'string'},mediaType:{enum:['application/pdf']},sizeBytes:{bsonType:['int','long']},sha256:{bsonType:'string'},objectKey:{bsonType:'string'},status:{enum:['UPLOADING','AVAILABLE','SUPERSEDED','QUARANTINED','FAILED']}},additionalProperties:true},
  [COLL.contestImportJobs]:{bsonType:'object',required:['tenant','importId','status','progressPct','stageCode','brochure','brochureObjectKey','catalogueVersion','createdBy','createdAt'],properties:{tenant:{bsonType:'string'},importId:{bsonType:'string'},status:{enum:['UPLOADING','QUEUED','INSPECTING','EXTRACTING','VALIDATING','MATERIALIZING','COMPLETED','NEEDS_SECURITY_REVIEW','NEEDS_INPUT','FAILED','CANCELLED']},progressPct:{bsonType:'int'},brochureObjectKey:{bsonType:'string'}},additionalProperties:true},
  [COLL.idempotencyRecords]:{bsonType:'object',required:['tenant','operationId','key','requestHash','state','createdAt'],additionalProperties:false,properties:{_id:{},tenant:{bsonType:'string'},operationId:{bsonType:'string'},key:{bsonType:'string'},requestHash:{bsonType:'string',pattern:'^[a-f0-9]{64}$'},state:{enum:['IN_PROGRESS','COMPLETED']},responseStatus:{bsonType:'int',minimum:100,maximum:599},responseHeaders:{bsonType:'object'},responseBody:{},resource:{bsonType:'object'},createdAt:{bsonType:['date','string']},completedAt:{bsonType:['date','string']}}},
};

async function main(){
  const db=await getContestDb();const existing=new Set((await db.listCollections({}, {nameOnly:true}).toArray()).map(item=>item.name));
  for(const [name,schema] of Object.entries(validators)){if(existing.has(name))await db.command({collMod:name,validator:{$jsonSchema:schema},validationLevel:'strict',validationAction:'error'});else await db.createCollection(name,{validator:{$jsonSchema:schema},validationLevel:'strict',validationAction:'error'});}
  const contestIndexes=await db.collection(COLL.contests).indexes();const legacyContest=contestIndexes.find(index=>index.name==='uq_contest'&&JSON.stringify(index.key)===JSON.stringify({tenant:1,id:1}));if(legacyContest)await db.collection(COLL.contests).dropIndex('uq_contest');
  const versionIndexes=await db.collection(COLL.contestVersions).indexes();const legacyVersion=versionIndexes.find(index=>index.name==='uq_contest_version'&&JSON.stringify(index.key)===JSON.stringify({tenant:1,contestId:1,version:1}));if(legacyVersion)await db.collection(COLL.contestVersions).dropIndex('uq_contest_version');
  await db.collection(COLL.contests).createIndex({tenant:1,contestId:1},{unique:true,name:'uq_contest_c1'});
  await db.collection(COLL.contests).createIndex({tenant:1,code:1},{unique:true,partialFilterExpression:{archived:false},name:'uq_contest_active_code'});
  await db.collection(COLL.contests).createIndex({tenant:1,archived:1,status:1,updatedAt:-1,contestId:1},{name:'ix_contest_portfolio_c1'});
  await db.collection(COLL.contestVersions).createIndex({tenant:1,versionId:1},{unique:true,name:'uq_contest_version_c1'});
  await db.collection(COLL.contestVersions).createIndex({tenant:1,contestId:1,revision:1},{unique:true,name:'uq_contest_revision'});
  await db.collection(COLL.contestVersions).createIndex({tenant:1,contestId:1,createdAt:-1},{name:'ix_contest_versions'});
  await db.collection(COLL.brochures).createIndex({tenant:1,brochureId:1},{unique:true,name:'uq_contest_brochure'});
  await db.collection(COLL.brochures).createIndex({tenant:1,contestId:1,versionId:1},{name:'ix_contest_brochure_version'});
  await db.collection(COLL.brochures).createIndex({tenant:1,versionId:1},{unique:true,partialFilterExpression:{status:'AVAILABLE'},name:'uq_available_brochure_per_version'});
  await db.collection(COLL.contestImportJobs).createIndex({tenant:1,importId:1},{unique:true,name:'uq_contest_import'});
  await db.collection(COLL.contestImportJobs).createIndex({tenant:1,status:1,updatedAt:1},{name:'ix_contest_import_worker'});
  await db.collection(COLL.contestImportJobs).createIndex({tenant:1,contestId:1,versionId:1},{name:'ix_contest_import_result'});
  await db.collection(COLL.contestImportJobs).createIndex({tenant:1,'brochure.sha256':1,catalogueVersion:1,createdBy:1},{name:'ix_contest_import_diagnostic'});
  await db.collection(COLL.ruleDefinitions).createIndex({tenant:1,code:1},{unique:true,name:'uq_rule_code'});
  await db.collection(COLL.ruleVersions).createIndex({tenant:1,assetId:1,revision:1},{unique:true,name:'uq_rule_version'});
  await db.collection(COLL.ruleVersions).createIndex({tenant:1,ruleVersionId:1},{unique:true,name:'uq_rule_version_id'});
  await db.collection(COLL.simulationRuns).createIndex({tenant:1,simulationId:1},{unique:true,name:'uq_simulation_run'});
  await db.collection(COLL.simulationRuns).createIndex({tenant:1,status:1,createdAt:1},{name:'ix_simulation_operations'});
  await db.collection(COLL.approvalInstances).createIndex({tenant:1,approvalId:1},{unique:true,name:'uq_approval_instance'});
  await db.collection(COLL.approvalInstances).createIndex({tenant:1,'stages.assigneeRef':1,status:1,dueAt:1},{name:'ix_approval_inbox'});
  await db.collection(COLL.approvalDecisions).createIndex({tenant:1,approvalId:1,stageId:1,idempotencyKey:1},{unique:true,name:'uq_approval_decision'});
  await db.collection(COLL.sourceSnapshots).createIndex({tenant:1,sourceType:1,sourceBatchId:1},{unique:true,name:'uq_source_snapshot'});
  await db.collection(COLL.sourceSnapshots).createIndex({tenant:1,businessDate:-1,sourceType:1,status:1},{name:'ix_source_snapshot_lookup'});
  await db.collection(COLL.agentStaging).createIndex({tenant:1,sourceBatchId:1,participantId:1},{unique:true,name:'uq_agent_staging'});
  await db.collection(COLL.productionStaging).createIndex({tenant:1,sourceBatchId:1,transactionId:1},{unique:true,name:'uq_production_staging'});
  await db.collection(COLL.calculationRuns).createIndex({tenant:1,runId:1},{unique:true,name:'uq_calculation_run'});
  await db.collection(COLL.calculationRuns).createIndex({tenant:1,status:1,createdAt:1},{name:'ix_calculation_run_operations'});
  await db.collection(COLL.agentResults).createIndex({tenant:1,contestId:1,contestVersionId:1,participantId:1},{unique:true,name:'uq_contest_agent_result'});
  await db.collection(COLL.agentResults).createIndex({tenant:1,contestId:1,'currentResult.qualificationStatus':1,participantId:1},{name:'ix_contest_agent_result_page'});
  await db.collection(COLL.agentResults).createIndex({tenant:1,participantId:1,'currentResult.businessDate':-1},{name:'ix_participant_result'});
  await db.collection(COLL.agentDailyResults).createIndex({tenant:1,contestId:1,contestVersionId:1,participantId:1,businessDate:1,calculationRevision:1},{unique:true,name:'uq_contest_agent_daily_result'});
  await db.collection(COLL.agentDailyResults).createIndex({tenant:1,contestId:1,participantId:1,businessDate:-1,calculationRevision:-1},{name:'ix_contest_agent_daily_latest'});
  await db.collection(COLL.publicationJobs).createIndex({tenant:1,jobId:1},{unique:true,name:'uq_publication_job'});
  await db.collection(COLL.contestOutbox).createIndex({tenant:1,eventId:1},{unique:true,name:'uq_contest_outbox'});
  await db.collection(COLL.contestNotifications).createIndex({tenant:1,eventId:1,recipientRef:1,channel:1},{unique:true,name:'uq_contest_notification'});
  await db.collection(COLL.audit).createIndex({tenant:1,eventId:1},{unique:true,sparse:true,name:'uq_contest_audit_event'});
  await db.collection(COLL.audit).createIndex({tenant:1,occurredAt:-1,eventId:1},{name:'ix_contest_audit_time'});
  await db.collection(COLL.audit).createIndex({tenant:1,resourceType:1,resourceId:1,occurredAt:-1},{name:'ix_contest_audit_resource'});
  await db.collection(COLL.brochures).createIndex({tenant:1,sha256:1},{name:'ix_contest_brochure_sha256'});
  const idempotencyIndexes=await db.collection(COLL.idempotencyRecords).indexes();if(!idempotencyIndexes.some(index=>index.unique===true&&JSON.stringify(index.key)===JSON.stringify({tenant:1,operationId:1,key:1})))await db.collection(COLL.idempotencyRecords).createIndex({tenant:1,operationId:1,key:1},{unique:true,name:'uq_contest_idempotency'});
  console.log(`Contest collections and indexes ensured in ${db.databaseName}.`);await closeDb();
}
main().catch(async error=>{console.error(error);await closeDb();process.exitCode=1;});