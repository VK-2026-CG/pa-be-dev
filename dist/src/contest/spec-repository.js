import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Decimal128 } from 'mongodb';
import { COLL, getContestDb } from '../db/mongo.js';
import { loadContestSeed } from './imported-seed.js';
import { initialRuleExpression, RULE_CATALOGUE_VERSION, validateRuleExpression } from './rule-engine.js';
const iso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`.slice(0, 64);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const page = (items) => ({ items, page: { hasMore: false, count: items.length } });
const responseStatus = (operationId) => operationId === 'startContestBrochureImport' || operationId === 'startContestSimulation' || operationId === 'startContestCalculation' ? 202 : operationId.startsWith('create') || operationId === 'uploadContestBrochure' || operationId === 'reactivateContest' ? 201 : 200;
const timestampFields = new Set(['createdAt', 'updatedAt', 'completedAt', 'submittedAt', 'decidedAt', 'validatedAt', 'publishedAt', 'occurredAt', 'receivedAt', 'uploadedAt', 'archivedAt', 'startedAt', 'finishedAt', 'expiresAt']);
function mongoValue(value, key = '') {
    if (Array.isArray(value))
        return value.map(item => mongoValue(item));
    if (value && typeof value === 'object' && !(value instanceof Date) && !('_bsontype' in value))
        return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, mongoValue(item, child)]));
    if (typeof value === 'string' && timestampFields.has(key) && /^\d{4}-\d{2}-\d{2}T/.test(value))
        return new Date(value);
    return value;
}
function wireValue(value) {
    if (value instanceof Decimal128)
        return value.toString();
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value))
        return value.map(wireValue);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_id' && key !== 'tenant').map(([key, item]) => [key, wireValue(item)]));
    return value;
}
export class SpecContestRepository {
    db;
    memory = new Map();
    transaction = new AsyncLocalStorage();
    constructor(db, seed = []) {
        this.db = db;
        if (!db)
            for (const { contest, version } of seed) {
                this.rows(COLL.contests).push({ tenant: 'MY', ...structuredClone(contest) });
                this.rows(COLL.contestVersions).push({ tenant: 'MY', ...structuredClone(version) });
            }
    }
    session() { return this.transaction.getStore() ?? undefined; }
    async withTransaction(action) {
        if (this.transaction.getStore() !== undefined)
            return action();
        if (this.db) {
            const session = this.db.client.startSession();
            try {
                return await session.withTransaction(() => this.transaction.run(session, action));
            }
            finally {
                await session.endSession();
            }
        }
        const snapshot = structuredClone(this.memory);
        try {
            return await this.transaction.run(null, action);
        }
        catch (error) {
            this.memory.clear();
            for (const [name, rows] of snapshot)
                this.memory.set(name, rows);
            throw error;
        }
    }
    rows(name) { let rows = this.memory.get(name); if (!rows) {
        rows = [];
        this.memory.set(name, rows);
    } return rows; }
    async find(name, filter = {}, sort) {
        if (this.db) {
            let cursor = this.db.collection(name).find(filter, { projection: { _id: 0 }, session: this.session() });
            if (sort)
                cursor = cursor.sort(sort);
            return cursor.limit(100).toArray();
        }
        return this.rows(name).filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value)).map((row) => structuredClone(row));
    }
    async one(name, filter) { return (await this.find(name, filter))[0]; }
    async insert(name, value) { if (this.db)
        await this.db.collection(name).insertOne(mongoValue(value), { session: this.session() });
    else
        this.rows(name).push(structuredClone(value)); }
    async replace(name, filter, value) {
        if (this.db)
            return (await this.db.collection(name).replaceOne(filter, mongoValue(value), { session: this.session() })).matchedCount === 1;
        const index = this.rows(name).findIndex((row) => Object.entries(filter).every(([key, expected]) => row[key] === expected));
        if (index < 0)
            return false;
        this.rows(name)[index] = structuredClone(value);
        return true;
    }
    async remove(name, filter) { if (this.db) {
        await this.db.collection(name).deleteMany(filter, { session: this.session() });
        return;
    } const rows = this.rows(name); for (let index = rows.length - 1; index >= 0; index -= 1)
        if (Object.entries(filter).every(([key, expected]) => rows[index]?.[key] === expected))
            rows.splice(index, 1); }
    async idempotent(tenant, operationId, key, input, action) {
        return this.withTransaction(async () => {
            const requestHash = hash(input);
            const filter = { tenant, operationId, key };
            const existing = await this.one(COLL.idempotencyRecords, filter);
            if (existing) {
                if (existing.requestHash !== requestHash)
                    return { kind: 'CONFLICT' };
                if (existing.state === 'COMPLETED')
                    return { kind: 'RESULT', value: structuredClone(existing.responseBody), replay: true };
                return { kind: 'IN_PROGRESS' };
            }
            const reservation = { ...filter, requestHash, state: 'IN_PROGRESS', createdAt: iso() };
            try {
                await this.insert(COLL.idempotencyRecords, reservation);
            }
            catch {
                const winner = await this.one(COLL.idempotencyRecords, filter);
                if (winner?.requestHash !== requestHash)
                    return { kind: 'CONFLICT' };
                if (winner?.state === 'COMPLETED')
                    return { kind: 'RESULT', value: structuredClone(winner.responseBody), replay: true };
                return { kind: 'IN_PROGRESS' };
            }
            const value = await action();
            const resource = value && typeof value === 'object'
                ? Object.fromEntries(['contestId', 'versionId', 'approvalId', 'simulationId', 'jobId', 'runId', 'sourceBatchId', 'assetId', 'ruleVersionId'].flatMap((name) => name in value ? [[name, value[name]]] : []))
                : undefined;
            const completed = { ...reservation, state: 'COMPLETED', responseStatus: responseStatus(operationId), responseHeaders: {}, responseBody: structuredClone(value), ...(resource && Object.keys(resource).length ? { resource } : {}), completedAt: iso() };
            await this.replace(COLL.idempotencyRecords, filter, completed);
            return { kind: 'RESULT', value, replay: false };
        });
    }
    async audit(actor, action, resourceType, resourceId, versionId) {
        const previous = (await this.find(COLL.audit, { tenant: actor.tenant }, { occurredAt: -1 }))[0];
        const occurredAt = iso();
        const base = { eventId: id('audit'), tenant: actor.tenant, occurredAt, actorRef: actor.id, action, resourceType, resourceId, ...(versionId ? { versionId } : {}), outcome: 'SUCCEEDED', previousEventHash: previous?.eventHash };
        await this.insert(COLL.audit, { ...base, eventHash: hash(base) });
    }
    async listContests(tenant, status, query) { const rows = await this.find(COLL.contests, { tenant, ...(status ? { status } : {}), archived: false }, { updatedAt: -1 }); const search = query?.trim().toLowerCase(); const filtered = search ? rows.filter(row => `${row.code ?? ''} ${row.nameKey ?? ''} ${row.ownerRef ?? ''}`.toLowerCase().includes(search)) : rows; return page(filtered.map(this.summary)); }
    summary(row) { return { contestId: row.contestId, code: row.code, nameKey: row.nameKey, status: row.status, ownerRef: row.ownerRef, campaignStart: row.campaignStart ?? '1970-01-01', campaignEnd: row.campaignEnd ?? '1970-01-01', audienceCodes: row.audienceCodes ?? [], ruleCount: row.ruleCount ?? 0, updatedAt: row.updatedAt }; }
    async listHistoric(tenant, status, query) { const all = await this.find(COLL.contests, { tenant }, { updatedAt: -1 }); const terminal = new Set(['COMPLETED', 'CANCELLED', 'ARCHIVED']); const search = query?.trim().toLowerCase(); const rows = all.filter(row => terminal.has(String(row.status)) && (!status || row.status === status) && (!search || `${row.code ?? ''} ${row.nameKey ?? ''} ${row.ownerRef ?? ''}`.toLowerCase().includes(search))); const items = []; for (const row of rows) {
        const version = await this.getVersion(tenant, String(row.latestVersionId));
        const brochure = version?.brochureId ? await this.brochure(tenant, String(version.brochureId)) : undefined;
        items.push({ ...this.summary(row), latestVersionId: row.latestVersionId, revision: row.revision, publishedVersionId: row.publishedVersionId, archivedAt: row.archivedAt, archivedBy: row.archivedBy, completedAt: row.completedAt, ...(brochure ? { brochure } : {}), actions: ['VIEW', ...(brochure?.status === 'AVAILABLE' ? ['VIEW_BROCHURE'] : []), ...(row.status === 'ARCHIVED' ? [] : ['ARCHIVE']), 'REACTIVATE'] });
    } return page(items); }
    async createContest(actor, input) {
        const contestId = id('contest');
        const versionId = id('version');
        const timestamp = iso();
        const configuration = { basics: { code: input.code, nameKey: input.nameKey, country: actor.tenant, timezone: input.timezone }, audience: {}, qualification: {}, calculation: {}, rewards: {}, governance: {}, sourceCitations: [] };
        const contest = { tenant: actor.tenant, contestId, code: input.code, nameKey: input.nameKey, country: actor.tenant, timezone: input.timezone, ownerRef: actor.id, status: 'DRAFT', latestVersionId: versionId, archived: false, revision: 1, campaignStart: '1970-01-01', campaignEnd: '1970-01-01', audienceCodes: [], ruleCount: 0, createdAt: timestamp, updatedAt: timestamp };
        const version = { tenant: actor.tenant, versionId, contestId, revision: 1, displayVersion: '1.0', status: 'DRAFT', configuration, checksum: hash(configuration), createdBy: actor.id, createdAt: timestamp, updatedAt: timestamp };
        await this.insert(COLL.contests, contest);
        await this.insert(COLL.contestVersions, version);
        await this.audit(actor, 'CONTEST_CREATED', 'CONTEST', contestId, versionId);
        return { ...this.summary(contest), country: actor.tenant, timezone: input.timezone, latestVersionId: versionId };
    }
    async createImport(actor, input) { const row = { tenant: actor.tenant, ...input }; await this.insert(COLL.contestImportJobs, row); await this.audit(actor, 'CONTEST_IMPORT_REQUESTED', 'CONTEST_IMPORT', String(input.importId)); return this.importWire(row); }
    importWire(row) { const { tenant: _, brochureObjectKey: __, createdBy: ___, provider: ____, model: _____, providerResponseId: ______, candidateChecksum: _______, ...wire } = row; return wire; }
    async getImport(tenant, importId) { const row = await this.one(COLL.contestImportJobs, { tenant, importId }); return row && this.importWire(row); }
    async updateImport(tenant, importId, patch) { const row = await this.one(COLL.contestImportJobs, { tenant, importId }); if (!row)
        return false; return this.replace(COLL.contestImportJobs, { tenant, importId }, { ...row, ...patch, updatedAt: iso() }); }
    async materializeImport(actor, importId, code, configuration, issueSummary) { return this.withTransaction(async () => { const job = await this.one(COLL.contestImportJobs, { tenant: actor.tenant, importId }); if (!job)
        throw new Error('IMPORT_NOT_FOUND'); if (job.status === 'COMPLETED')
        return this.importWire(job); const contestId = id('contest'), versionId = id('version'), timestamp = iso(); const basics = configuration.basics; const audience = configuration.audience; const routes = configuration.qualification?.routes ?? []; const contest = { tenant: actor.tenant, contestId, code, nameKey: 'contest.created.new', country: actor.tenant, timezone: 'Asia/Kuala_Lumpur', ownerRef: actor.id, status: 'DRAFT', latestVersionId: versionId, archived: false, revision: 1, campaignStart: basics.campaignStart ?? '1970-01-01', campaignEnd: basics.campaignEnd ?? '1970-01-01', audienceCodes: audience.codes ?? [], ruleCount: routes.length, createdAt: timestamp, updatedAt: timestamp }; const version = { tenant: actor.tenant, versionId, contestId, revision: 1, displayVersion: '1.0', status: 'DRAFT', brochureId: job.brochure.brochureId, brochureSha256: job.brochure.sha256, configuration, checksum: hash(configuration), createdBy: actor.id, createdAt: timestamp, updatedAt: timestamp }; const brochure = { tenant: actor.tenant, brochureId: job.brochure.brochureId, contestId, versionId, fileName: job.brochure.fileName, mediaType: 'application/pdf', sizeBytes: job.brochure.sizeBytes, sha256: job.brochure.sha256, objectKey: job.brochureObjectKey, status: 'AVAILABLE', uploadedBy: actor.id, uploadedAt: job.brochure.uploadedAt }; await this.insert(COLL.contests, contest); await this.insert(COLL.contestVersions, version); await this.insert(COLL.brochures, brochure); const result = { contestId, versionId, revision: 1, status: 'DRAFT', reviewState: 'NEEDS_BUSINESS_REVIEW', configurationChecksum: version.checksum }; const completed = { ...job, status: 'COMPLETED', progressPct: 100, stageCode: 'COMPLETE', issueSummary, result, normalizedConfigurationChecksum: version.checksum, completedAt: timestamp, updatedAt: timestamp }; await this.replace(COLL.contestImportJobs, { tenant: actor.tenant, importId }, completed); await this.audit(actor, 'CONTEST_IMPORT_DRAFT_CREATED', 'CONTEST_IMPORT', importId, versionId); return this.importWire(completed); }); }
    async codeAvailable(tenant, code) { return !(await this.one(COLL.contests, { tenant, code, archived: false })); }
    async getContest(tenant, contestId) { const row = await this.one(COLL.contests, { tenant, contestId }); return row && { ...this.summary(row), country: row.country, timezone: row.timezone, latestVersionId: row.latestVersionId, ...(row.publishedVersionId ? { publishedVersionId: row.publishedVersionId } : {}) }; }
    async getVersion(tenant, versionId) { return this.one(COLL.contestVersions, { tenant, versionId }); }
    wireVersion(row) { const { tenant: _, updatedAt: __, ...wire } = row; return wire; }
    async version(tenant, versionId) { const row = await this.getVersion(tenant, versionId); if (!row)
        return undefined; const brochure = row.brochureId ? await this.brochure(tenant, String(row.brochureId)) : undefined; return { ...this.wireVersion(row), ...(brochure ? { brochure } : {}) }; }
    async cloneVersion(actor, contestId, baseVersionId, changeRationale) { const base = await this.getVersion(actor.tenant, baseVersionId); if (!base || base.contestId !== contestId)
        return; const existing = await this.find(COLL.contestVersions, { tenant: actor.tenant, contestId }); const timestamp = iso(); const next = { ...base, versionId: id('version'), revision: existing.length + 1, displayVersion: `${existing.length + 1}.0`, status: 'DRAFT', baseVersionId, changeRationale, createdBy: actor.id, createdAt: timestamp, updatedAt: timestamp }; await this.insert(COLL.contestVersions, next); const contest = await this.one(COLL.contests, { tenant: actor.tenant, contestId }); if (contest)
        await this.replace(COLL.contests, { tenant: actor.tenant, contestId }, { ...contest, latestVersionId: next.versionId, revision: Number(contest.revision) + 1, updatedAt: timestamp }); await this.audit(actor, 'CONTEST_VERSION_CREATED', 'CONTEST_VERSION', next.versionId, next.versionId); return this.wireVersion(next); }
    async archiveContest(actor, contestId, expectedRevision) { return this.withTransaction(async () => { const current = await this.one(COLL.contests, { tenant: actor.tenant, contestId }); if (!current)
        return 'MISSING'; if (current.revision !== expectedRevision)
        return 'STALE'; if (current.status === 'ARCHIVED')
        return { contestId, status: 'ARCHIVED', archived: true, revision: current.revision, archivedAt: current.archivedAt, archivedBy: current.archivedBy }; if (!['COMPLETED', 'CANCELLED'].includes(String(current.status)))
        return 'INVALID'; const archivedAt = iso(); const next = { ...current, status: 'ARCHIVED', archived: true, revision: expectedRevision + 1, archivedAt, archivedBy: actor.id, updatedAt: archivedAt }; if (!(await this.replace(COLL.contests, { tenant: actor.tenant, contestId, revision: expectedRevision }, next)))
        return 'STALE'; await this.audit(actor, 'CONTEST_ARCHIVED', 'CONTEST', contestId, String(current.latestVersionId)); return { contestId, status: 'ARCHIVED', archived: true, revision: next.revision, archivedAt, archivedBy: actor.id }; }); }
    async reactivateContest(actor, contestId, expectedRevision, baseVersionId, changeRationale) { return this.withTransaction(async () => { const current = await this.one(COLL.contests, { tenant: actor.tenant, contestId }); if (!current)
        return 'MISSING'; if (current.revision !== expectedRevision)
        return 'STALE'; if (!['COMPLETED', 'CANCELLED', 'ARCHIVED'].includes(String(current.status)))
        return 'INVALID'; const base = await this.getVersion(actor.tenant, baseVersionId); if (!base || base.contestId !== contestId)
        return 'MISSING'; const versions = await this.find(COLL.contestVersions, { tenant: actor.tenant, contestId }); const timestamp = iso(); const { submittedAt: _, approvedAt: __, publishedAt: ___, ...baseDraft } = base; const next = { ...baseDraft, versionId: id('version'), revision: versions.length + 1, displayVersion: `${versions.length + 1}.0`, status: 'DRAFT', baseVersionId, baseChecksum: base.checksum, changeRationale, createdBy: actor.id, createdAt: timestamp, updatedAt: timestamp }; await this.insert(COLL.contestVersions, next); const { archivedAt: ____, archivedBy: _____, ...activeIdentity } = current; const identity = { ...activeIdentity, status: 'DRAFT', archived: false, latestVersionId: next.versionId, revision: expectedRevision + 1, reactivatedAt: timestamp, updatedAt: timestamp }; if (!(await this.replace(COLL.contests, { tenant: actor.tenant, contestId, revision: expectedRevision }, identity)))
        return 'STALE'; await this.audit(actor, 'CONTEST_REACTIVATED', 'CONTEST', contestId, next.versionId); return this.wireVersion(next); }); }
    async brochure(tenant, brochureId) { const value = await this.one(COLL.brochures, { tenant, brochureId }); if (!value)
        return undefined; const { tenant: _, objectKey: __, ...wire } = value; return wire; }
    async brochureRecord(tenant, versionId) { const version = await this.getVersion(tenant, versionId); if (!version?.brochureId)
        return undefined; return this.one(COLL.brochures, { tenant, brochureId: version.brochureId }); }
    async saveBrochure(actor, versionId, expectedRevision, input) { return this.withTransaction(async () => { const version = await this.getVersion(actor.tenant, versionId); if (!version)
        return 'MISSING'; if (version.status !== 'DRAFT')
        return 'IMMUTABLE'; if (version.revision !== expectedRevision)
        return 'STALE'; const uploadedAt = iso(); if (version.brochureId) {
        const prior = await this.one(COLL.brochures, { tenant: actor.tenant, brochureId: version.brochureId });
        if (prior)
            await this.replace(COLL.brochures, { tenant: actor.tenant, brochureId: version.brochureId }, { ...prior, status: 'SUPERSEDED', supersededAt: uploadedAt });
    } const metadata = { tenant: actor.tenant, contestId: version.contestId, versionId, mediaType: 'application/pdf', status: 'AVAILABLE', uploadedBy: actor.id, uploadedAt, ...input, ...(version.brochureId ? { supersedesBrochureId: version.brochureId } : {}) }; await this.insert(COLL.brochures, metadata); const next = { ...version, revision: expectedRevision + 1, brochureId: input.brochureId, brochureSha256: input.sha256, updatedAt: uploadedAt }; if (!(await this.replace(COLL.contestVersions, { tenant: actor.tenant, versionId, revision: expectedRevision, status: 'DRAFT' }, next)))
        return 'STALE'; await this.audit(actor, version.brochureId ? 'CONTEST_BROCHURE_REPLACED' : 'CONTEST_BROCHURE_UPLOADED', 'BROCHURE', input.brochureId, versionId); const { tenant: _, objectKey: __, ...wire } = metadata; return wire; }); }
    async patchVersion(actor, versionId, revision, patch) {
        const current = await this.getVersion(actor.tenant, versionId);
        if (!current)
            return 'MISSING';
        if (current.status !== 'DRAFT')
            return 'IMMUTABLE';
        if (current.revision !== revision)
            return 'STALE';
        const configuration = { ...current.configuration, ...patch };
        const updatedAt = iso();
        const next = { ...current, revision: revision + 1, configuration, checksum: hash(configuration), updatedAt };
        if (!(await this.replace(COLL.contestVersions, { tenant: actor.tenant, versionId, revision }, next)))
            return 'STALE';
        const contest = await this.one(COLL.contests, { tenant: actor.tenant, contestId: current.contestId });
        if (contest) {
            const periods = Array.isArray(configuration.importedCircular?.periods) ? configuration.importedCircular.periods : [];
            const routes = Array.isArray(configuration.qualification?.routes) ? configuration.qualification.routes : [];
            const audiences = [...new Set(routes.map((route) => String(route.audienceCode ?? '')).filter(Boolean))];
            const campaignStart = periods.map((period) => String(period.from ?? '')).filter(Boolean).sort()[0] ?? contest.campaignStart;
            const campaignEnd = periods.map((period) => String(period.to ?? '')).filter(Boolean).sort().at(-1) ?? contest.campaignEnd;
            await this.replace(COLL.contests, { tenant: actor.tenant, contestId: current.contestId }, { ...contest, campaignStart, campaignEnd, audienceCodes: audiences.filter((code) => code !== 'ROOKIE'), ruleCount: routes.length, updatedAt });
        }
        await this.audit(actor, 'CONTEST_VERSION_UPDATED', 'CONTEST_VERSION', versionId, versionId);
        return this.wireVersion(next);
    }
    validate(row) { const issues = []; for (const section of ['basics', 'audience', 'qualification', 'calculation', 'rewards', 'governance'])
        if (!row.configuration?.[section] || Object.keys(row.configuration[section]).length === 0)
            issues.push({ path: `/configuration/${section}`, code: 'REQUIRED', severity: 'ERROR', messageKey: `contest.validation.${section}.required` }); return { validationRunId: id('validation'), status: issues.length ? 'INVALID' : 'VALID', issues, validatedAt: iso(), configurationChecksum: row.checksum }; }
    async submit(actor, versionId, revision) { const current = await this.getVersion(actor.tenant, versionId); if (!current)
        return 'MISSING'; if (current.status !== 'DRAFT' || current.revision !== revision)
        return 'STALE'; const report = this.validate(current); if (report.status !== 'VALID')
        return 'INVALID'; const timestamp = iso(); const approval = { tenant: actor.tenant, approvalId: id('approval'), contestId: current.contestId, versionId, revision: 1, status: 'PENDING', currentStageId: 'BUSINESS', submittedBy: actor.id, submittedAt: timestamp, snapshotChecksum: current.checksum, stages: [{ stageId: 'BUSINESS', status: 'PENDING' }] }; await this.insert(COLL.approvalInstances, approval); await this.replace(COLL.contestVersions, { tenant: actor.tenant, versionId }, { ...current, status: 'IN_REVIEW', submittedAt: timestamp }); await this.audit(actor, 'CONTEST_VERSION_SUBMITTED', 'CONTEST_VERSION', versionId, versionId); const { tenant: _, ...wire } = approval; return wire; }
    async approvals(tenant, status) { return page((await this.find(COLL.approvalInstances, { tenant, ...(status ? { status } : {}) })).map(({ tenant: _, ...row }) => row)); }
    async approval(tenant, approvalId) { return this.one(COLL.approvalInstances, { tenant, approvalId }); }
    async decide(actor, approvalId, revision, decision, comment, key) { const current = await this.approval(actor.tenant, approvalId); if (!current)
        return 'MISSING'; if (current.submittedBy === actor.id)
        return 'MAKER_CHECKER'; if (current.revision !== revision || current.status !== 'PENDING')
        return 'STALE'; const status = decision === 'APPROVE' ? 'APPROVED' : decision === 'RETURN' ? 'RETURNED' : 'REJECTED'; const decidedAt = iso(); await this.insert(COLL.approvalDecisions, { tenant: actor.tenant, decisionId: id('decision'), approvalId, stageId: current.currentStageId, actorRef: actor.id, decision, comment, snapshotChecksum: current.snapshotChecksum, decidedAt, idempotencyKey: key }); const next = { ...current, revision: revision + 1, status, stages: [{ stageId: current.currentStageId, status, actorRef: actor.id, decidedAt, ...(comment ? { comment } : {}) }] }; await this.replace(COLL.approvalInstances, { tenant: actor.tenant, approvalId }, next); const version = await this.getVersion(actor.tenant, current.versionId); if (version)
        await this.replace(COLL.contestVersions, { tenant: actor.tenant, versionId: current.versionId }, { ...version, status }); await this.audit(actor, `APPROVAL_${decision}`, 'APPROVAL', approvalId, current.versionId); const wire = { ...next }; delete wire.tenant; return wire; }
    async publish(actor, versionId) { const version = await this.getVersion(actor.tenant, versionId); if (!version)
        return 'MISSING'; if (version.status !== 'APPROVED' && version.status !== 'PUBLISHED')
        return 'INVALID'; const job = { tenant: actor.tenant, jobId: id('publish'), type: 'PUBLICATION', status: 'ACCEPTED', createdAt: iso() }; await this.insert(COLL.publicationJobs, job); if (version.status !== 'PUBLISHED') {
        await this.replace(COLL.contestVersions, { tenant: actor.tenant, versionId }, { ...version, status: 'PUBLISHED', publishedAt: iso() });
        const contest = await this.one(COLL.contests, { tenant: actor.tenant, contestId: version.contestId });
        if (contest)
            await this.replace(COLL.contests, { tenant: actor.tenant, contestId: version.contestId }, { ...contest, status: 'SCHEDULED', publishedVersionId: versionId, updatedAt: iso() });
        await this.audit(actor, 'CONTEST_VERSION_PUBLISHED', 'CONTEST_VERSION', versionId, versionId);
    } const { tenant: _, ...wire } = job; return wire; }
    async registerSource(actor, manifest) { const existing = await this.one(COLL.sourceSnapshots, { tenant: actor.tenant, sourceType: manifest.sourceType, sourceBatchId: manifest.sourceBatchId }); if (existing)
        return existing.sha256 === manifest.sha256 ? existing : 'CONFLICT'; const row = { tenant: actor.tenant, ...manifest }; await this.insert(COLL.sourceSnapshots, row); await this.audit(actor, 'SOURCE_SNAPSHOT_REGISTERED', 'SOURCE_SNAPSHOT', manifest.sourceBatchId); const { tenant: _, ...wire } = row; return wire; }
    async startRun(actor, input) { const run = { tenant: actor.tenant, runId: id('run'), businessDate: input.businessDate, status: 'WAITING_FOR_SOURCES', contestIds: input.contestIds ?? [], sourceLineage: { agentMasterBatchId: input.agentMasterBatchId, productionBatchId: input.productionBatchId }, reconciliation: { eligible: 0, calculated: 0, succeeded: 0, failed: 0, quarantined: 0 }, reasonCode: input.reasonCode ?? 'SCHEDULED', requestedBy: actor.id, createdAt: iso(), engineVersion: '0.1.0', mappingVersion: 'MY-0.1.0' }; await this.insert(COLL.calculationRuns, run); const { tenant: _, requestedBy: __, reasonCode: ___, engineVersion: ____, mappingVersion: _____, ...wire } = run; return wire; }
    async run(tenant, runId) { return this.one(COLL.calculationRuns, { tenant, runId }); }
    async diffVersions(tenant, versionId, againstVersionId) {
        const current = await this.getVersion(tenant, versionId);
        const against = await this.getVersion(tenant, againstVersionId);
        if (!current || !against)
            return undefined;
        const changes = [];
        for (const key of ['basics', 'audience', 'qualification', 'calculation', 'rewards', 'governance']) {
            const before = against.configuration?.[key];
            const after = current.configuration?.[key];
            if (hash(before) !== hash(after))
                changes.push({ changeId: id('change'), operation: before === undefined ? 'ADDED' : after === undefined ? 'REMOVED' : 'MODIFIED', path: `/${key}`, materiality: key === 'basics' ? 'NON_MATERIAL' : 'MATERIAL', beforeHash: hash(before), afterHash: hash(after) });
        }
        return { changes };
    }
    async startSimulation(actor, versionId, input) {
        const version = await this.getVersion(actor.tenant, versionId);
        if (!version)
            return undefined;
        if (input.versionChecksum !== version.checksum)
            return 'CHECKSUM_MISMATCH';
        const simulation = { tenant: actor.tenant, simulationId: id('simulation'), jobId: id('job'), versionId, versionChecksum: version.checksum, type: 'SIMULATION', simulationType: input.type, status: 'QUEUED', progressPct: 0, sourceBusinessDate: input.sourceBusinessDate, reconciliation: { eligible: 0, calculated: 0, succeeded: 0, failed: 0, quarantined: 0 }, createdAt: iso() };
        await this.insert(COLL.simulationRuns, simulation);
        await this.audit(actor, 'SIMULATION_STARTED', 'SIMULATION', simulation.simulationId, versionId);
        return wireValue(simulation);
    }
    async simulation(tenant, simulationId) { const value = await this.one(COLL.simulationRuns, { tenant, simulationId }); return value && wireValue(value); }
    async createAsset(actor, kind, input) {
        const collection = COLL.ruleDefinitions;
        if (await this.one(collection, { tenant: actor.tenant, code: input.code }))
            return 'CONFLICT';
        const timestamp = iso();
        const assetId = id(kind);
        const versionId = id(`${kind}version`);
        const value = { tenant: actor.tenant, assetId, code: input.code, name: input.name, nameKey: input.nameKey, type: 'RULE', categoryCode: input.categoryCode, status: 'DRAFT', latestVersion: '1.0', latestVersionId: versionId, adoptionCount: 0, createdBy: actor.id, createdAt: timestamp, updatedAt: timestamp };
        const candidate = input.configuration && typeof input.configuration === 'object' && 'type' in input.configuration ? input.configuration : initialRuleExpression('ALL');
        const options = { periodMode: 'FULL_CAMPAIGN', unknownCodePolicy: 'BLOCK' };
        const report = validateRuleExpression(candidate, options);
        const version = { tenant: actor.tenant, assetId, ruleVersionId: versionId, revision: 1, code: input.code, name: input.name, nameKey: input.nameKey, categoryCode: input.categoryCode, status: 'DRAFT', expression: candidate, options, checksum: report.configurationChecksum, catalogueVersion: RULE_CATALOGUE_VERSION, createdBy: actor.id, createdAt: timestamp, updatedAt: timestamp };
        await this.insert(COLL.ruleVersions, version);
        try {
            await this.insert(collection, value);
            await this.audit(actor, 'RULE_CREATED', 'RULE', assetId, versionId);
        }
        catch (error) {
            await this.remove(collection, { tenant: actor.tenant, assetId });
            await this.remove(COLL.ruleVersions, { tenant: actor.tenant, assetId });
            throw error;
        }
        return wireValue(value);
    }
    async getRuleVersion(tenant, ruleVersionId) { const value = await this.one(COLL.ruleVersions, { tenant, ruleVersionId }); return value && wireValue(value); }
    async patchRuleVersion(actor, ruleVersionId, expectedRevision, input) {
        const current = await this.one(COLL.ruleVersions, { tenant: actor.tenant, ruleVersionId });
        if (!current)
            return 'MISSING';
        if (current.status !== 'DRAFT')
            return 'IMMUTABLE';
        if (current.revision !== expectedRevision)
            return 'STALE';
        const report = validateRuleExpression(input.expression, input.options);
        if (!report.valid)
            return { kind: 'INVALID', report };
        const next = { ...current, revision: expectedRevision + 1, expression: input.expression, options: input.options, checksum: report.configurationChecksum, catalogueVersion: report.catalogueVersion, updatedAt: iso() };
        if (!(await this.replace(COLL.ruleVersions, { tenant: actor.tenant, ruleVersionId, revision: expectedRevision, status: 'DRAFT' }, next)))
            return 'STALE';
        await this.audit(actor, 'RULE_VERSION_UPDATED', 'RULE_VERSION', ruleVersionId, ruleVersionId);
        return wireValue(next);
    }
    async validateRuleVersion(tenant, ruleVersionId, input) { if (!(await this.one(COLL.ruleVersions, { tenant, ruleVersionId })))
        return undefined; return validateRuleExpression(input.expression, input.options); }
    async results(tenant, contestId, participantId, daily = false) { const rows = (await this.find(daily ? COLL.agentDailyResults : COLL.agentResults, { tenant, contestId, ...(participantId ? { participantId } : {}) }, daily ? { businessDate: -1 } : undefined)).map((row) => wireValue(row)); return participantId && !daily ? rows[0] : page(rows); }
    async auditPage(tenant) { return page((await this.find(COLL.audit, { tenant }, { occurredAt: -1 })).map(({ tenant: _, ...row }) => row)); }
    async assets(tenant) { return { items: (await this.find(COLL.ruleDefinitions, { tenant })).map(({ tenant: _, ...row }) => row) }; }
}
export async function createSpecContestRepository() { return process.env.MONGODB_URI ? new SpecContestRepository(await getContestDb()) : new SpecContestRepository(undefined, (await loadContestSeed()).documents); }
