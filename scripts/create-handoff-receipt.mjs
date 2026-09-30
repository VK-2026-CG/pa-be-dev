// Retired: handoff/receipt validation is no longer a development gate; kept for history.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const handoffFile = process.argv[2];
if (!handoffFile) throw new Error('Usage: npm run handoff:receipt -- <handoff-file>');
const handoff = JSON.parse(readFileSync(resolve(handoffFile), 'utf8'));
if (handoff.schemaVersion !== '1.0' || !handoff.handoffId) throw new Error('Unsupported handoff document');
const consumer = 'backend';
if (handoff.consumers?.[consumer]?.required !== true) throw new Error(`Handoff does not require ${consumer}`);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
const safeName = basename(handoffFile).replace(/\.json$/, '').replace(/\.draft$/, '');
const output = resolve('handoffs/outbox/receipts', `${safeName}.backend.json`);
const existing = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {};
const receipt = {
  schemaVersion: '1.0',
  receiptId: existing.receiptId ?? `backend-${handoff.handoffId}`.slice(0, 128),
  handoffId: handoff.handoffId,
  ...(handoff.specId ? { specId: handoff.specId } : {}),
  ...(handoff.jiraId ? { jiraId: handoff.jiraId } : {}),
  ...(existing.bugJiraId ? { bugJiraId: existing.bugJiraId } : {}),
  ...(existing.defectClassification ? { defectClassification: existing.defectClassification } : {}),
  consumer,
  status: existing.status ?? 'IN_PROGRESS',
  specCommit: handoff.spec?.commit ?? null,
  implementation: { repository: 'PruactionBackend', commit, dirty },
  validation: existing.validation ?? [],
  operationCoverage: existing.operationCoverage ?? [],
  acceptanceCriteria: existing.acceptanceCriteria ?? handoff.acceptanceCriteria.map(id => ({ id, status: 'BLOCKED', evidence: 'Evidence not recorded yet' })),
  migrations: existing.migrations ?? [],
  gaps: existing.gaps ?? [...handoff.consumers[consumer].requiredActions],
  updatedAt: new Date().toISOString(),
};
mkdirSync(resolve('handoffs/outbox/receipts'), { recursive: true });
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(output);