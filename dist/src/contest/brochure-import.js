import { createHash, randomUUID } from 'node:crypto';
import Ajv2020Module from 'ajv/dist/2020.js';
import schema from '../../vendor/spec/brochure-extraction-candidate.schema.json' with { type: 'json' };
import { contestBrochureMaxBytes } from './brochure-limits.js';
import { validateRuleExpression } from './rule-engine.js';
const Ajv2020 = Ajv2020Module;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateCandidate = ajv.compile(schema);
const sha256 = (value) => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const safe = (value, prefix) => `${prefix}_${value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_')}`.slice(0, 64);
function expression(node) { if (node.type === 'PREDICATE')
    return { nodeId: safe(String(node.nodeKey), 'node'), type: 'PREDICATE', metricCode: node.metricCode, operator: node.operator, ...(node.operand ? { operand: node.operand } : {}), context: Object.fromEntries(Object.entries(node.context ?? {}).filter(([, value]) => value !== null).map(([key, value]) => [key === 'periodKey' ? 'periodId' : key, value])), sourceCitationIds: node.sourceCitationIds }; if (node.type === 'NOT')
    return { nodeId: safe(String(node.nodeKey), 'node'), type: 'NOT', child: expression(node.child) }; return { nodeId: safe(String(node.nodeKey), 'node'), type: node.type, ...(node.type === 'ANY' ? { minimumPass: node.minimumPass } : {}), children: node.children.map(expression) }; }
function normalize(candidate, actor) {
    const routes = candidate.qualificationRoutes.map((route, index) => { const tree = expression(route.expression); const report = validateRuleExpression(tree, { periodMode: candidate.periods.length > 1 ? 'CUSTOM_WINDOWS' : 'FULL_CAMPAIGN', unknownCodePolicy: 'BLOCK' }); if (!report.valid)
        throw new Error(`INVALID_RULE:${JSON.stringify(report.issues)}`); return { routeId: safe(String(route.routeKey), 'route'), code: String(route.routeKey).toUpperCase(), labelKey: 'contest.created.new', name: route.name, order: index + 1, enabled: true, audienceCode: route.audienceCode, expression: tree, tierIds: route.tierKeys.map(key => safe(key, 'tier')), sourceCitationIds: route.sourceCitationIds }; });
    const citations = candidate.citations.map(item => ({ citationId: item.citationId, circularCode: 'AI_IMPORT', issuedAt: new Date().toISOString().slice(0, 10), page: item.page, section: item.section, status: 'ACTIVE' }));
    const configuration = { basics: { code: candidate.document.contestCodeCandidate, name: 'AI generated contest', nameKey: 'contest.created.new', country: actor.tenant, timezone: 'Asia/Kuala_Lumpur', campaignStart: candidate.basics.campaignStart, campaignEnd: candidate.basics.campaignEnd }, audience: { codes: candidate.audiences.map(item => item.audienceCode) }, qualification: { routes, tiers: candidate.tiers.map((tier, index) => ({ tierId: safe(String(tier.tierKey), 'tier'), code: String(tier.tierKey).toUpperCase(), labelKey: 'contest.created.new', order: index + 1, rewardCode: tier.rewardCode })), periods: candidate.periods.map((period, index) => ({ periodId: period.periodKey, labelKey: 'contest.period.FULL', order: index + 1 })), targets: candidate.targets.map(target => ({ tierId: safe(String(target.tierKey), 'tier'), periodId: target.periodKey, state: target.state, ...(target.value !== null ? { value: target.value } : {}) })), rewardPrecedenceCode: 'HIGHEST_ONLY' }, calculation: { rules: candidate.calculationRules }, rewards: { items: candidate.rewards }, governance: candidate.governance, sourceCitations: citations, importedCircular: { sourceName: 'AI imported brochure', effectiveCircularCode: 'AI_IMPORT', citations, periods: candidate.periods.map(item => ({ periodId: item.periodKey, labelKey: 'contest.period.FULL', from: item.from, to: item.to })), audienceRules: [], awardRules: [], creditRules: [], trackingRules: candidate.trackingRules, exclusions: candidate.exclusions.map(item => ({ code: item.exclusionCode, labelKey: 'contest.error.ruleInvalid', sourceCitationIds: item.sourceCitationIds })), reviewState: 'NEEDS_BUSINESS_REVIEW' }, provenance: { origin: 'AI_BROCHURE_IMPORT', reviewState: 'NEEDS_BUSINESS_REVIEW', unresolvedItems: candidate.unresolvedItems } };
    return { code: String(candidate.document.contestCodeCandidate ?? `AI_${randomUUID().slice(0, 8)}`).toUpperCase(), configuration, issueSummary: { errors: 0, warnings: candidate.unresolvedItems.length, unresolvedFields: candidate.unresolvedItems.length } };
}
export class ContestBrochureImportService {
    repository;
    store;
    provider;
    constructor(repository, store, provider) {
        this.repository = repository;
        this.store = store;
        this.provider = provider;
    }
    async start(actor, file, requestedCode) { if (file.mediaType !== 'application/pdf' || !file.fileName.toLowerCase().endsWith('.pdf') || !file.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
        throw new Error('INVALID_PDF'); const max = contestBrochureMaxBytes(); if (!file.bytes.length || file.bytes.length > max)
        throw new Error('PDF_TOO_LARGE'); const importId = `contestimport_${randomUUID().replaceAll('-', '')}`.slice(0, 64), brochureId = `brochure_${randomUUID().replaceAll('-', '')}`.slice(0, 64), digest = sha256(file.bytes); const stored = await this.store.put(actor.tenant, brochureId, file.bytes); const createdAt = new Date().toISOString(); const job = { importId, status: 'QUEUED', progressPct: 10, stageCode: 'UPLOAD', brochure: { brochureId, fileName: file.fileName, mediaType: 'application/pdf', sizeBytes: file.bytes.length, sha256: digest, status: 'AVAILABLE', uploadedAt: createdAt }, brochureObjectKey: stored.objectKey, catalogueVersion: 'MY-2026.2', requestedCode, createdBy: actor.id, createdAt }; await this.repository.createImport(actor, job); setTimeout(() => void this.process(actor, importId, file).catch(() => undefined), 0); return job; }
    async get(tenant, importId) { return this.repository.getImport(tenant, importId); }
    async process(actor, importId, file) { try {
        await this.repository.updateImport(actor.tenant, importId, { status: 'EXTRACTING', progressPct: 45, stageCode: 'EXTRACTION', startedAt: new Date().toISOString() });
        const current = await this.repository.getImport(actor.tenant, importId);
        const inferred = await this.provider.extract({ bytes: file.bytes, sha256: String(current.brochure.sha256), fileName: file.fileName, requestedCode: current.requestedCode });
        if (!validateCandidate(inferred.candidate))
            throw new Error(`INVALID_CANDIDATE:${ajv.errorsText(validateCandidate.errors)}`);
        const normalized = normalize(inferred.candidate, actor);
        if (!(await this.repository.codeAvailable(actor.tenant, normalized.code)))
            throw new Error('DUPLICATE_CODE');
        await this.repository.updateImport(actor.tenant, importId, { status: 'MATERIALIZING', progressPct: 85, stageCode: 'MATERIALIZATION', provider: inferred.provider, model: inferred.model, providerResponseId: inferred.providerResponseId, candidateChecksum: sha256(inferred.candidate) });
        await this.repository.materializeImport(actor, importId, normalized.code, normalized.configuration, normalized.issueSummary);
    }
    catch (error) {
        await this.repository.updateImport(actor.tenant, importId, { status: 'FAILED', progressPct: 100, stageCode: 'COMPLETE', problem: { code: 'CON-4223', messageKey: error instanceof Error && error.message === 'DUPLICATE_CODE' ? 'contest.error.duplicateCode' : 'contest.error.importCandidateInvalid', retryable: false }, completedAt: new Date().toISOString() });
    } }
}
