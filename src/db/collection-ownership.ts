import { COLL } from './mongo.js';

export const PERFORMANCE_COLLECTIONS = [COLL.production, COLL.mapa, COLL.persistency] as const;

export const CONTEST_COLLECTIONS = [
  COLL.contests, COLL.contestVersions, COLL.brochures, COLL.contestImportJobs,
  COLL.ruleDefinitions, COLL.ruleVersions, COLL.approvalInstances, COLL.approvalDecisions,
  COLL.validationRuns, COLL.simulationRuns, COLL.simulationResults, COLL.sourceSnapshots,
  COLL.agentStaging, COLL.productionStaging, COLL.calculationRuns, COLL.agentResults,
  COLL.agentDailyResults, COLL.qualificationExplanations, COLL.publicationJobs,
  COLL.contestOutbox, COLL.contestNotifications, COLL.audit, COLL.idempotencyRecords,
] as const;

export const LEGACY_CONTEST_COLLECTIONS = [
  'query_definitions', 'approval_requests', 'evaluation_schedules', 'evaluation_runs',
  'evaluation_shards', 'contest_participants', 'participant_metric_snapshots',
  'participant_qualification_results', 'contest_presentation_versions',
  'participant_contest_read_models', 'participant_reporting_home',
  'user_contest_preferences', 'contest_insight_snapshots', 'evaluation_traces',
  'outbox_events', 'access_policies', 'data_sources', 'catalog_objects',
  'catalog_fields', 'lov_definitions', 'lov_values', 'lov_versions',
  'contest_idempotency_records', 'contest_templates', 'contest_template_versions',
] as const;