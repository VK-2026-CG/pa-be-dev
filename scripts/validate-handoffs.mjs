import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve('handoffs');
const commitPattern = /^[a-f0-9]{40}$/;
const idPattern = /^[a-z0-9][a-z0-9._-]{7,127}$/;
const acPattern = /^AC-[A-Z0-9-]+$/;
const failures = [];
const assert = (condition, file, message) => { if (!condition) failures.push(`${file}: ${message}`); };
const unique = (values) => new Set(values).size === values.length;
const timestamp = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const files = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.json') ? [join(dir, entry.name)] : []) : [];
const documents = files(root).filter(file => !file.includes(`${join('handoffs', 'schemas')}`)).map(file => ({ file, value: JSON.parse(readFileSync(file, 'utf8')) }));
const handoffs = new Map();

for (const { file, value } of documents) {
  assert(value.schemaVersion === '1.0', file, 'schemaVersion must be 1.0');
  if ('handoffId' in value && 'domain' in value) {
    const allowed = new Set(['schemaVersion','handoffId','specId','jiraId','status','domain','country','compatibility','spec','changedArtifacts','acceptanceCriteria','consumers','openQuestions','createdAt']);
    assert(Object.keys(value).every(key => allowed.has(key)), file, 'contains an undeclared handoff field');
    assert(idPattern.test(value.handoffId), file, 'invalid handoffId');
    if (value.specId !== undefined) assert(/^(?:[A-Z][A-Z0-9]+-[0-9]+-SP[0-9]{2}|SPEC-[0-9]{4}-[0-9]{3})$/.test(value.specId), file, 'invalid specId');
    if (value.jiraId !== undefined) assert(/^[A-Z][A-Z0-9]+-[0-9]+$/.test(value.jiraId), file, 'invalid jiraId');
    assert(['DRAFT','READY','SUPERSEDED'].includes(value.status), file, 'invalid handoff status');
    assert(['insights','contests'].includes(value.domain), file, 'invalid domain');
    assert(/^[A-Z]{2}$/.test(value.country), file, 'country must be ISO alpha-2 uppercase');
    assert(['ADDITIVE','BREAKING','NONE'].includes(value.compatibility), file, 'invalid compatibility');
    assert(value.spec?.repository === 'PruactionSpec', file, 'spec.repository must be PruactionSpec');
    assert(typeof value.spec?.dirty === 'boolean', file, 'spec.dirty must be boolean');
    assert(Array.isArray(value.changedArtifacts) && value.changedArtifacts.length > 0, file, 'changedArtifacts must not be empty');
    assert(unique(value.changedArtifacts ?? []), file, 'changedArtifacts must be unique');
    assert(Array.isArray(value.acceptanceCriteria) && value.acceptanceCriteria.every(id => acPattern.test(id)), file, 'invalid acceptance criterion');
    assert(value.consumers?.backend && value.consumers?.frontend, file, 'both consumers must be declared');
    for (const [consumerName, consumer] of Object.entries(value.consumers ?? {})) {
      assert(typeof consumer.required === 'boolean' && Array.isArray(consumer.requiredActions), file, `${consumerName} consumer is invalid`);
      if (consumer.screenPackages !== undefined) {
        assert(Array.isArray(consumer.screenPackages), file, `${consumerName}.screenPackages must be an array`);
        assert(unique(consumer.screenPackages.map(item => item.screenId)), file, `${consumerName}.screenPackages must have unique screen IDs`);
        for (const item of consumer.screenPackages) assert(/^[A-Z]{2}-[0-9]{2}$/.test(item.screenId) && typeof item.version === 'string' && typeof item.manifest === 'string', file, `${consumerName} screen package is invalid`);
      }
      if (consumer.commonDependencies !== undefined) assert(Array.isArray(consumer.commonDependencies) && unique(consumer.commonDependencies), file, `${consumerName}.commonDependencies must be unique`);
      if (consumer.ux !== undefined) {
        const ux = consumer.ux;
        assert(typeof ux.required === 'boolean' && ['NOT_REQUIRED','BLOCKED','DRAFT','UX_REVIEW','APPROVED'].includes(ux.designStatus), file, `${consumerName}.ux is invalid`);
        for (const key of ['tokenFiles','visualBaselines','fixtures','uxAcceptanceCriteria','unapprovedInferences','openDesignQuestions']) assert(Array.isArray(ux[key]) && unique(ux[key]), file, `${consumerName}.ux.${key} must be a unique array`);
        assert(ux.uxAcceptanceCriteria.every(id => acPattern.test(id)), file, `${consumerName}.ux has invalid acceptance criteria`);
        if (value.status === 'READY' && consumer.required && ux.required) {
          assert(ux.designStatus === 'APPROVED', file, 'READY frontend UX must be APPROVED');
          assert(ux.unapprovedInferences.length === 0, file, 'READY frontend UX cannot have unapproved inferences');
          assert(ux.openDesignQuestions.length === 0, file, 'READY frontend UX cannot have open design questions');
          assert(ux.assetManifest && ux.assetPackVersion && ux.tokenFiles.length && ux.visualBaselines.length && ux.fixtures.length && ux.uxAcceptanceCriteria.length, file, 'READY frontend UX package is incomplete');
        }
      }
    }
    assert(timestamp(value.createdAt), file, 'createdAt must be an ISO timestamp');
    if (value.status === 'READY') { assert(commitPattern.test(value.spec?.commit), file, 'READY requires a full spec commit'); assert(value.spec?.dirty === false, file, 'READY requires dirty=false'); }
    handoffs.set(value.handoffId, { file, value });
  }
}

const vendoredCommit = existsSync('vendor/spec/SPEC_COMMIT') ? readFileSync('vendor/spec/SPEC_COMMIT', 'utf8').trim() : undefined;
for (const { file, value } of documents) {
  if (!('receiptId' in value)) continue;
  const allowed = new Set(['schemaVersion','receiptId','handoffId','specId','jiraId','bugJiraId','defectClassification','consumer','status','specCommit','implementation','validation','operationCoverage','acceptanceCriteria','migrations','gaps','updatedAt','designValidation']);
  assert(Object.keys(value).every(key => allowed.has(key)), file, 'contains an undeclared receipt field');
  assert(idPattern.test(value.receiptId), file, 'invalid receiptId');
  assert(idPattern.test(value.handoffId), file, 'invalid handoffId');
  if (value.specId !== undefined) assert(/^(?:[A-Z][A-Z0-9]+-[0-9]+-SP[0-9]{2}|SPEC-[0-9]{4}-[0-9]{3})$/.test(value.specId), file, 'invalid specId');
  if (value.jiraId !== undefined) assert(/^[A-Z][A-Z0-9]+-[0-9]+$/.test(value.jiraId), file, 'invalid jiraId');
  if (value.bugJiraId !== undefined) assert(/^[A-Z][A-Z0-9]+-[0-9]+$/.test(value.bugJiraId), file, 'invalid bugJiraId');
  if (value.defectClassification !== undefined) assert(['IMPLEMENTATION_DEFECT','TEST_DEFECT','DATA_DEFECT','CONFIGURATION_DEFECT','SPEC_DEFECT','NEW_REQUIREMENT','UNKNOWN'].includes(value.defectClassification), file, 'invalid defectClassification');
  assert(['backend','frontend'].includes(value.consumer), file, 'invalid consumer');
  assert(['IN_PROGRESS','COMPLETE','BLOCKED'].includes(value.status), file, 'invalid receipt status');
  assert(Array.isArray(value.validation) && Array.isArray(value.operationCoverage) && Array.isArray(value.acceptanceCriteria) && Array.isArray(value.migrations) && Array.isArray(value.gaps), file, 'receipt evidence fields must be arrays');
  assert(value.implementation?.repository === (value.consumer === 'backend' ? 'PruactionBackend' : 'PruactionWeb'), file, 'implementation repository does not match consumer');
  assert(unique((value.operationCoverage ?? []).map(item => item.operationId)), file, 'operation coverage IDs must be unique');
  assert(unique((value.acceptanceCriteria ?? []).map(item => item.id)), file, 'acceptance criterion IDs must be unique');
  assert(timestamp(value.updatedAt), file, 'updatedAt must be an ISO timestamp');
  const handoff = handoffs.get(value.handoffId);
  if (handoff) {
    if (handoff.value.specId !== undefined) assert(value.specId === handoff.value.specId, file, 'receipt specId must match handoff');
    if (handoff.value.jiraId !== undefined) assert(value.jiraId === handoff.value.jiraId, file, 'receipt jiraId must match handoff');
    assert(handoff.value.consumers[value.consumer]?.required === true, file, `consumer ${value.consumer} is not required by the handoff`);
    if (handoff.value.status === 'READY') assert(value.specCommit === handoff.value.spec.commit, file, 'receipt specCommit must match READY handoff');
  }
  if (value.designValidation !== undefined) {
    const design = value.designValidation;
    assert(['PASS','FAIL','NOT_RUN','NOT_REQUIRED'].includes(design.status), file, 'invalid designValidation status');
    assert(Array.isArray(design.visualValidation) && Array.isArray(design.responsiveValidation) && Array.isArray(design.accessibilityValidation), file, 'design validation evidence must be arrays');
  }
  if (value.status === 'COMPLETE') {
    assert(commitPattern.test(value.specCommit), file, 'COMPLETE requires specCommit');
    assert(commitPattern.test(value.implementation?.commit), file, 'COMPLETE requires implementation commit');
    assert(value.implementation?.dirty === false, file, 'COMPLETE requires dirty=false');
    assert(value.gaps.length === 0, file, 'COMPLETE cannot have gaps');
    assert(value.validation.length > 0 && value.validation.every(item => item.status === 'PASS'), file, 'COMPLETE requires passing validation evidence');
    assert(value.operationCoverage.every(item => !['BLOCKED'].includes(item.status)), file, 'COMPLETE cannot have blocked operation coverage');
    assert(value.migrations.every(item => item.status !== 'BLOCKED'), file, 'COMPLETE cannot have blocked migrations');
    if (handoff) {
      const covered = new Map(value.acceptanceCriteria.map(item => [item.id, item.status]));
      assert(handoff.value.acceptanceCriteria.every(id => ['PASS','NOT_APPLICABLE'].includes(covered.get(id))), file, 'COMPLETE must cover every handoff acceptance criterion');
      if (value.consumer === 'frontend' && handoff.value.consumers.frontend?.ux?.required) {
        const design = value.designValidation;
        assert(design?.status === 'PASS', file, 'COMPLETE frontend requires passing design validation');
        assert(design?.assetValidation?.assetsPresent === design?.assetValidation?.assetsRequired && design?.assetValidation?.checksumFailures === 0 && design?.assetValidation?.unsafeSvgCount === 0 && design?.assetValidation?.placeholderCount === 0, file, 'COMPLETE frontend asset conformance failed');
        assert(design?.tokenValidation && Object.values(design.tokenValidation).every(count => count === 0), file, 'COMPLETE frontend token conformance failed');
        assert(design?.visualValidation?.length > 0 && design.visualValidation.every(item => item.status === 'PASS'), file, 'COMPLETE frontend visual baselines must pass');
        assert(design?.responsiveValidation?.length > 0 && design.responsiveValidation.every(item => item.status === 'PASS'), file, 'COMPLETE frontend responsive validation must pass');
        assert(design?.accessibilityValidation?.length > 0 && design.accessibilityValidation.every(item => item.status === 'PASS'), file, 'COMPLETE frontend accessibility validation must pass');
      }
    }
  }
}

for (const { file, value } of handoffs.values()) if (value.status === 'READY' && vendoredCommit !== undefined) assert(vendoredCommit === value.spec.commit, file, `spec commit ${value.spec.commit} does not match vendor/spec/SPEC_COMMIT ${vendoredCommit}`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`Validated ${documents.length} handoff document(s).`);