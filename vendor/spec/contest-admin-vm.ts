/** PRUAction Contest Administration C3 contract. @version 0.1.0 Draft */
export type ContestRouteRef = { route: string; params?: Record<string, string> };
export type ContestStatus = 'DRAFT'|'IN_REVIEW'|'RETURNED'|'APPROVED'|'SCHEDULED'|'ACTIVE'|'TRACKING'|'COMPLETED'|'NEEDS_ATTENTION'|'ARCHIVED'|'CANCELLED';
export type QualificationStatus = 'IN_PROGRESS'|'QUALIFIED'|'NOT_QUALIFIED'|'QUALITY_GATE_FAILED'|'DISQUALIFIED'|'TRACKING'|'FINAL';
export type JobStatus = 'QUEUED'|'RUNNING'|'COMPLETED'|'FAILED'|'CANCELLED'|'DEAD_LETTERED';
export type ContestImportStatus = 'UPLOADING'|'QUEUED'|'INSPECTING'|'EXTRACTING'|'VALIDATING'|'MATERIALIZING'|'COMPLETED'|'NEEDS_SECURITY_REVIEW'|'NEEDS_INPUT'|'FAILED'|'CANCELLED';
export interface ContestMeta { traceId:string; generatedAt:string; partial?:boolean; failedSections?:string[]; permissions:string[] }
export interface ContestSummaryVM { contestId:string; code:string; nameKey:string; status:ContestStatus; ownerRef:string; campaignStart:string; campaignEnd:string; audienceCodes:string[]; ruleCount:number; updatedAt:string; nav:ContestRouteRef }
export interface ContestPortfolioVM { meta:ContestMeta; metrics:Array<{code:string;value:number;supportingCode?:string}>; attentionItems:Array<{id:string;type:string;severity:'INFO'|'WARNING'|'ERROR';nav:ContestRouteRef}>; contests:ContestSummaryVM[]; page:{nextCursor?:string;hasMore:boolean;count:number}; filters:{statuses:ContestStatus[];cycles:string[];entityCodes:string[];channelCodes:string[]} }
export interface ValidationIssueVM { issueId:string; severity:'ERROR'|'WARNING'|'INFO'; code:string; path:string; messageKey:string; acknowledgementAllowed:boolean }
export interface BuilderStepVM { stepCode:'BASICS'|'AUDIENCE'|'QUALIFICATION'|'CALCULATION'|'REWARDS'|'GOVERNANCE'|'REVIEW'; status:'NOT_STARTED'|'IN_PROGRESS'|'VALID'|'WARNING'|'ERROR'; issueCount:number; nav:ContestRouteRef }
export type RuleOperator = 'GTE'|'GT'|'LTE'|'LT'|'EQ'|'NEQ'|'IN'|'NOT_IN'|'BETWEEN'|'EXISTS';
export type OperandVM =
  | { kind:'DECIMAL'|'MONEY'|'PERCENT'; value:string; currency?:string }
  | { kind:'INTEGER'; value:number }
  | { kind:'BOOLEAN'; value:boolean }
  | { kind:'DATE'; value:string }
  | { kind:'DATE_RANGE'; from:string; to:string }
  | { kind:'RANGE'; from:string; to:string; currency?:string }
  | { kind:'LOV'; lovKey:string; valueCode:string }
  | { kind:'LOV_SET'; lovKey:string; valueCodes:string[] };
export interface RulePredicateVM { nodeId:string; type:'PREDICATE'; metricCode:string; operator:RuleOperator; operand?:OperandVM; context?:{periodId?:string;audienceCode?:string;aggregationCode?:string;repricingCode?:string;productScopeCode?:string}; sourceCitationIds?:string[] }
export interface RuleAllVM { nodeId:string; type:'ALL'; children:RuleExpressionVM[] }
export interface RuleAnyVM { nodeId:string; type:'ANY'; minimumPass?:number; children:RuleExpressionVM[] }
export interface RuleNotVM { nodeId:string; type:'NOT'; child:RuleExpressionVM }
export type RuleExpressionVM = RulePredicateVM|RuleAllVM|RuleAnyVM|RuleNotVM;
export interface RuleOptionsVM { periodMode:'FULL_CAMPAIGN'|'MONTHLY_INDEPENDENT'|'CUMULATIVE'|'CUSTOM_WINDOWS'; considerationPeriodCode?:string; unknownCodePolicy:'BLOCK' }
export interface CatalogueValueVM { code:string; labelKey:string; status:'ACTIVE'|'DEPRECATED'; descriptionKey?:string }
export interface MetricDefinitionVM extends CatalogueValueVM { kind:MetricVM['kind']; operators:RuleOperator[]; operandLovKey?:string; currency?:string }
export interface LovDefinitionVM { key:string; version:number; effectiveFrom:string; values:CatalogueValueVM[] }
export interface ContestCatalogueVM { version:string; metrics:MetricDefinitionVM[]; lovs:LovDefinitionVM[] }
export interface BrochureMetadataVM { brochureId:string;fileName:string;mediaType:'application/pdf';sizeBytes:number;sha256:string;status:'UPLOADING'|'AVAILABLE'|'SUPERSEDED'|'QUARANTINED'|'FAILED';uploadedAt:string;downloadNav:ContestRouteRef }
export interface ContestImportBrochureVM { brochureId:string;fileName:string;mediaType:'application/pdf';sizeBytes:number;sha256:string;status:'UPLOADING'|'AVAILABLE'|'QUARANTINED'|'FAILED';uploadedAt:string;downloadNav?:ContestRouteRef }
export interface RankingPolicyVM { mode:'ALL_QUALIFIERS'|'TOP_N';topN?:number;rankByMetricCode?:string;rankDirection?:'ASC'|'DESC';tieBreakers?:Array<{order:number;metricCode:string;direction:'ASC'|'DESC'}> }
export interface RouteRewardPolicyVM { rewardCodes:string[];precedenceCode:'HIGHEST_ONLY'|'HIGHEST_ELIGIBLE'|'MAX_ONE'|'MAX_ONE_EXTRA'|'STACKABLE';cashAlternative?:{amount:string;currency:string} }
export interface QualificationRouteVM { routeId:string; code:string; labelKey:string; name?:string; order:number; enabled:boolean; audienceCode?:string; expression:RuleExpressionVM; tierIds:string[];selectionPolicy?:RankingPolicyVM;rewardPolicy?:RouteRewardPolicyVM;trackingPolicyIds?:string[];sourceCitationIds?:string[] }
export interface QualificationTierVM { tierId:string; code:string; labelKey:string; order:number; rewardCode:string }
export interface QualificationPeriodVM { periodId:string; labelKey:string; order:number }
export interface TierTargetCellVM { tierId:string; periodId:string; state:'EXPLICIT'|'INHERITED'|'NOT_APPLICABLE'|'NOT_CONFIGURED'; value?:string; inheritedFromPeriodId?:string }
export interface QualificationConfigurationVM { routes:QualificationRouteVM[]; tiers:QualificationTierVM[]; periods:QualificationPeriodVM[]; targets:TierTargetCellVM[]; rewardPrecedenceCode:string }
/** Source-backed rules imported from an approved contest circular. These supplement the
 * executable expression tree with selection, calculation and governance semantics that
 * cannot be reduced to a participant threshold (for example Top-N and clawback rules). */
export interface ContestCitationVM { citationId:string; circularCode:string; issuedAt:string; page:number; section:string; status:'ACTIVE'|'SUPERSEDED'; supersededBy?:string }
export interface ContestAudienceRuleVM { audienceCode:string; rankCodes:string[]; include:boolean; contractFrom?:string; contractTo?:string; maxAge?:number; entityCodes?:string[]; productScope?:string[]; sourceCitationIds:string[] }
export interface ContestThresholdVM { metricCode:string; operator:RuleOperator; value:string|number; currency?:string; periodId?:string; qualifierCode?:string; sourceCitationIds:string[] }
export interface ContestQualificationOptionVM { optionCode:string; allOf:ContestThresholdVM[]; sourceCitationIds:string[] }
export interface ContestAwardRuleVM { ruleId:string; labelKey:string; audienceCode:string; rankCodes:string[]; options:ContestQualificationOptionVM[]; rewardCodes:string[]; topN?:number; rankByMetricCode?:string; tieBreakMetricCode?:string; precedenceCode?:string; sourceCitationIds:string[] }
export interface ContestCreditRuleVM { ruleId:string; metricCode:string; productCode:string; rate:string; capPctOfMetric?:string; minimumSharePct?:string; include:boolean; sourceCitationIds:string[] }
export interface ContestTrackingRuleVM { ruleId:string; type:'REGISTRATION'|'PRODUCTION'|'PERSISTENCY'|'CONTRACT_STATUS'|'SUBMISSION_CUTOFF'|'CLAWBACK'; effectiveTo:string; actionCode:string; sourceCitationIds:string[] }
export interface ImportedCircularVM { sourceName:string; effectiveCircularCode:string; citations:ContestCitationVM[]; periods:Array<{periodId:string;labelKey:string;from:string;to:string}>; audienceRules:ContestAudienceRuleVM[]; awardRules:ContestAwardRuleVM[]; creditRules:ContestCreditRuleVM[]; trackingRules:ContestTrackingRuleVM[]; exclusions:Array<{code:string;labelKey:string;sourceCitationIds:string[]}>; reviewState:'VERIFIED'|'NEEDS_BUSINESS_REVIEW' }
export interface ContestConfigurationVM { basics?:Record<string,unknown>; audience?:Record<string,unknown>; qualification?:QualificationConfigurationVM; calculation?:Record<string,unknown>; rewards?:Record<string,unknown>; governance?:Record<string,unknown>; provenance?:Record<string,unknown>; [section:string]:unknown }
export interface ContestBuilderVM { meta:ContestMeta; contest:ContestSummaryVM; versionId:string; revision:number; etag:string; readOnly:boolean; steps:BuilderStepVM[]; activeStep:BuilderStepVM['stepCode']; configuration:ContestConfigurationVM; catalogue:ContestCatalogueVM; brochure?:BrochureMetadataVM; validation:{score?:number;blocking:boolean;issues:ValidationIssueVM[]}; autosave:{state:'IDLE'|'SAVING'|'SAVED'|'CONFLICT'|'OFFLINE'|'ERROR';savedAt?:string} }
export interface RuleNodeResultVM { nodeId:string; passed?:boolean; errorCode?:string; normalizedValue?:string|number|boolean; sourceCitationIds?:string[] }
export interface RuleEditorVM { meta:ContestMeta; contestId:string; versionId:string; ruleId:string; categoryCode:string; tierCode:string; expression:RuleExpressionVM; options:RuleOptionsVM; catalogue:ContestCatalogueVM; limits:{maxDepth:number;maxNodes:number}; issues:ValidationIssueVM[]; etag?:string; readOnly?:boolean; editorContext?:'CONTEST_VERSION'|'REUSABLE_RULE'; displayName?:string; cancelNav?:ContestRouteRef; testResult?:{qualificationStatus:QualificationStatus;metrics:MetricVM[];nodeResults:RuleNodeResultVM[];configurationChecksum:string;engineVersion:string} }
export interface MetricVM { metricCode:string; kind:'MONEY'|'COUNT'|'PERCENT'|'DECIMAL'|'BOOLEAN'|'DATE'; value:string|number|boolean; currency?:string; priorDailyValue?:string; dailyDelta?:string }
export interface ReviewVM { meta:ContestMeta; contest:ContestSummaryVM; versionId:string; checksum:string; sections:Array<{stepCode:string;status:string;summaryKeys:string[];editNav:ContestRouteRef}>; changes:Array<{changeId:string;operation:string;path:string;materiality:string}>; validation:{blocking:boolean;issues:ValidationIssueVM[]}; approvalStages:Array<{stageId:string;order:number;type:string;status:string;assigneeRef?:string}>; impact?:SimulationVM }
export interface AssetVM { assetId:string; code:string; name?:string; type:'RULE'; categoryCode:string; status:'DRAFT'|'IN_REVIEW'|'APPROVED'|'DEPRECATED';latestVersion:string;latestVersionId?:string;adoptionCount:number;rootType?:'ALL'|'ANY';nav:ContestRouteRef }
export interface HistoricContestSummaryVM extends ContestSummaryVM { latestVersionId:string;revision:number;publishedVersionId?:string;archivedAt?:string;archivedBy?:string;completedAt?:string;brochure?:BrochureMetadataVM;actions:Array<'VIEW'|'VIEW_BROCHURE'|'ARCHIVE'|'REACTIVATE'> }
export interface HistoricContestLibraryVM { meta:ContestMeta;items:HistoricContestSummaryVM[];page:{nextCursor?:string;hasMore:boolean;count:number};filters:{statuses:Array<'COMPLETED'|'CANCELLED'|'ARCHIVED'>} }
export interface RuleLibraryVM { meta:ContestMeta; items:AssetVM[]; filters:{categoryCodes:string[];statuses:string[]} }
export interface ApprovalVM { approvalId:string; contest:ContestSummaryVM; versionId:string;snapshotChecksum:string;status:string;riskCode?:string;dueAt?:string;submittedBy:string;submittedAt:string;materialChanges:number;validationPct?:number;actions:Array<'OPEN'|'APPROVE'|'RETURN'|'REJECT'>;nav:ContestRouteRef }
export interface ApprovalInboxVM { meta:ContestMeta; inbox:'ASSIGNED'|'SUBMITTED'|'COMPLETED';counts:Record<string,number>;items:ApprovalVM[];page:{nextCursor?:string;hasMore:boolean;count:number} }
export interface AuditLogVM { meta:ContestMeta; items:Array<{eventId:string;occurredAt:string;actorRef:string;action:string;resourceType:string;resourceId:string;outcome:string;detailNav?:ContestRouteRef}>;page:{nextCursor?:string;hasMore:boolean;count:number} }
export interface SimulationVM { jobId:string;status:JobStatus;progressPct?:number;type:'SAMPLE_PARTICIPANT'|'PORTFOLIO_IMPACT';summary?:Record<string,string|number>;problemCode?:string }
export interface SimulationWorkspaceVM { meta:ContestMeta; contestId:string;versionId:string;simulation?:SimulationVM;allowedTypes:SimulationVM['type'][] }
export interface AgentContestResultVM { contestId:string;contestVersionId:string;participantRef:string;businessDate:string;eligibilityStatus:string;qualificationStatus:QualificationStatus;categoryResults:Array<{categoryCode:string;qualificationStatus:QualificationStatus;cumulativeMetrics:MetricVM[];achievedTierCode?:string;nextTierCode?:string;rewardCode?:string}>;historyNav:ContestRouteRef }
export interface CalculationRunVM { runId:string;businessDate:string;status:string;sourceBatchRefs:string[];counts:{eligible:number;calculated:number;succeeded:number;failed:number;quarantined:number};createdAt:string;publishedAt?:string }
export interface ContestProblemVM { code:string;status:number;messageKey:string;traceId:string;errors?:Array<{path:string;code:string;messageKey:string}> }
export interface ContestImportVM { meta:ContestMeta;importId:string;status:ContestImportStatus;progressPct:number;stageCode:'UPLOAD'|'INSPECTION'|'EXTRACTION'|'VALIDATION'|'MATERIALIZATION'|'COMPLETE';brochure:ContestImportBrochureVM;catalogueVersion:string;issueSummary?:{errors:number;warnings:number;unresolvedFields:number};result?:{contestId:string;versionId:string;revision:number;status:'DRAFT';reviewState:'NEEDS_BUSINESS_REVIEW';configurationChecksum:string;nav:ContestRouteRef};problem?:{code:string;messageKey:string;retryable:boolean};createdAt:string;startedAt?:string;completedAt?:string }

/** Additive BFF command contracts. Domain commands remain defined by contests.v1.yaml. */
export interface CreateContestRequestVM { code:string; nameKey:string; timezone:string }
export interface CreateContestResultVM extends ContestSummaryVM { country:string; timezone:string; latestVersionId:string }
export interface StartContestImportResultVM { importId:string;status:ContestImportStatus;brochure:ContestImportBrochureVM;catalogueVersion:string;createdAt:string;statusNav:ContestRouteRef }
export interface ArchiveContestResultVM { contestId:string;status:'ARCHIVED';archived:true;revision:number;archivedAt:string;archivedBy:string }
export interface ReactivateContestRequestVM { baseVersionId:string;changeRationale:string }
export interface ReactivateContestResultVM { contestId:string;versionId:string;revision:number;status:'DRAFT';baseVersionId:string;baseChecksum:string;nav:ContestRouteRef }
export interface CreateRuleAssetRequestVM { code:string; name:string; categoryCode:'ELIGIBILITY'|'QUALITY'|'PRODUCTION'; rootType:'ALL'|'ANY' }
export interface CreateRuleAssetResultVM extends AssetVM { type:'RULE'; status:'DRAFT'; rootType:'ALL'|'ANY'; latestVersionId:string }
export interface CreateQualificationRouteRequestVM { code:string;name:string;audienceCode:string;rootType:'ALL'|'ANY';tierCode:string;rewardCode:string;periodMode:RuleOptionsVM['periodMode'];etag:string }
export interface SaveRuleRequestVM { expression:RuleExpressionVM; options:RuleOptionsVM; etag:string }
export interface TestRuleRequestVM { expression:RuleExpressionVM; options:RuleOptionsVM }
export interface StartSimulationRequestVM { type:SimulationVM['type']; versionChecksum:string; sourceBusinessDate?:string }
export interface SubmitContestRequestVM { attested:true; changeRationale:string; validationRunId?:string; simulationRunId?:string }
export interface SubmitContestResultVM { approvalId:string; versionId:string; snapshotChecksum:string; status:'IN_PROGRESS'; nav:ContestRouteRef }
export interface ApprovalDecisionRequestVM { decision:'APPROVE'|'RETURN'|'REJECT'; comment?:string }
export interface ApprovalDecisionResultVM { approvalId:string; status:'APPROVED'|'RETURNED'|'REJECTED'; decidedAt:string; editableDraftNav?:ContestRouteRef }
export interface AuditExportVM { jobId:string; status:'QUEUED'|'RUNNING'|'VERIFIED'|'FAILED'; verificationCode?:string }

/** BFF routes:
 * GET /api/bff/v1/contest-admin/portfolio -> ContestPortfolioVM
 * GET/PATCH /api/bff/v1/contest-admin/contests/:contestId/versions/:versionId -> ContestBuilderVM
 * GET /api/bff/v1/contest-admin/contests/:contestId/versions/:versionId/review -> ReviewVM
 * GET /api/bff/v1/contest-admin/historic-contests -> HistoricContestLibraryVM
 * DELETE /api/bff/v1/contest-admin/contests/:contestId -> ArchiveContestResultVM
 * POST /api/bff/v1/contest-admin/contests/:contestId/reactivations -> ReactivateContestRequestVM / ReactivateContestResultVM
 * PUT/GET /api/bff/v1/contest-admin/contests/:contestId/versions/:versionId/brochure -> BrochureMetadataVM / application/pdf
 * GET /api/bff/v1/contest-admin/rules -> RuleLibraryVM
 * GET /api/bff/v1/contest-admin/approvals -> ApprovalInboxVM
 * GET /api/bff/v1/contest-admin/audit -> AuditLogVM
 * GET /api/bff/v1/contest-admin/contests/:contestId/versions/:versionId/simulations -> SimulationWorkspaceVM
 * POST /api/bff/v1/contest-admin/contests -> CreateContestRequestVM / CreateContestResultVM
 * POST /api/bff/v1/contest-admin/contest-imports -> multipart PDF / StartContestImportResultVM
 * GET /api/bff/v1/contest-admin/contest-imports/:importId -> ContestImportVM
 * POST /api/bff/v1/contest-admin/rules -> CreateRuleAssetRequestVM / CreateRuleAssetResultVM
 * GET/PATCH /api/bff/v1/contest-admin/rules/:assetId/versions/:ruleVersionId -> RuleEditorVM
 * POST /api/bff/v1/contest-admin/rules/:assetId/versions/:ruleVersionId/test -> RuleEditorVM
 * PATCH /api/bff/v1/contest-admin/contests/:contestId/versions/:versionId/rules/:ruleId -> SaveRuleRequestVM / RuleEditorVM
 * POST /api/bff/v1/contest-admin/contests/:contestId/versions/:versionId/rules/:ruleId/test -> TestRuleRequestVM / RuleEditorVM
 * POST /api/bff/v1/contest-admin/contests/:contestId/versions/:versionId/simulations -> StartSimulationRequestVM / SimulationWorkspaceVM
 * POST /api/bff/v1/contest-admin/contests/:contestId/versions/:versionId/submit -> SubmitContestRequestVM / SubmitContestResultVM
 * POST /api/bff/v1/contest-admin/approvals/:approvalId/decisions -> ApprovalDecisionRequestVM / ApprovalDecisionResultVM
 * POST /api/bff/v1/contest-admin/audit/exports -> AuditExportVM
 */