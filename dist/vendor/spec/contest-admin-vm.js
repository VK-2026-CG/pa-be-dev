export {};
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
