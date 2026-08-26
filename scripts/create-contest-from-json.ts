/** Create and configure one governed contest exclusively through the Contest API. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface ImportFile {
  schemaVersion: string;
  source: { fileName: string; sha256: string; pdfPages: number };
  createRequest: { code: string; nameKey: string; timezone: string };
  portfolio: { campaignStart: string; campaignEnd: string; audienceCodes: string[]; ruleCount: number };
  configuration: Record<string, unknown>;
  expectedConfigurationChecksum: string;
  expectedAppliedConfigurationChecksum?: string;
}

const file = resolve(process.argv.find((value) => value.endsWith('.json')) ?? 'data/contest-imports/ACC2026_05.api.json');
const pdfArgument = process.argv.indexOf('--pdf');
const pdfPath = pdfArgument >= 0 ? process.argv[pdfArgument + 1] : undefined;
const base = process.env.CONTESTS_API_URL;
const actor = process.env.CONTEST_IMPORT_ACTOR ?? 'A1001';
const tenant = process.env.COUNTRY_CODE;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const headers = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-agent-id': actor, 'x-tenant': tenant, ...extra });

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function main(): Promise<void> {
  const input = JSON.parse(await readFile(file, 'utf8')) as ImportFile;
  if (input.schemaVersion !== '1.0') throw new Error('Unsupported contest API import schema');
  if (!base) throw new Error('CONTESTS_API_URL is required');
  if (!tenant) throw new Error('COUNTRY_CODE is required');
  if (!pdfPath) throw new Error('--pdf <path> is required');
  const pdf = await readFile(resolve(pdfPath));
  if (sha256(pdf) !== input.source.sha256) throw new Error(`PDF checksum does not match ${input.source.sha256}`);
  if (sha256(JSON.stringify(input.configuration)) !== input.expectedConfigurationChecksum) throw new Error('Configuration checksum does not match the governed JSON');

  const keyBase = `pdf-${input.createRequest.code.toLowerCase()}-${input.source.sha256.slice(0, 12)}`;
  const createdResponse = await fetch(`${base}/contests`, { method: 'POST', headers: headers({ 'idempotency-key': `${keyBase}-create` }), body: JSON.stringify(input.createRequest) });
  const created = await json<{ contestId: string; latestVersionId: string }>(createdResponse);
  let versionResponse = await fetch(`${base}/contest-versions/${created.latestVersionId}`, { headers: headers() });
  let version = await json<{ revision: number; checksum: string; brochure?: { sha256: string } }>(versionResponse);

  const appliedChecksum = input.expectedAppliedConfigurationChecksum ?? input.expectedConfigurationChecksum;
  if (version.checksum !== appliedChecksum) {
    versionResponse = await fetch(`${base}/contest-versions/${created.latestVersionId}`, { method: 'PATCH', headers: headers({ 'if-match': `"${version.revision}"` }), body: JSON.stringify(input.configuration) });
    version = await json(versionResponse);
  }

  if (version.brochure?.sha256 !== input.source.sha256) {
    const form = new FormData(); form.set('file', new Blob([pdf], { type: 'application/pdf' }), input.source.fileName);
    const brochureResponse = await fetch(`${base}/contest-versions/${created.latestVersionId}/brochure`, { method: 'PUT', headers: { 'x-agent-id': actor, 'x-tenant': tenant, 'idempotency-key': `${keyBase}-brochure`, 'if-match': `"${version.revision}"` }, body: form });
    await json(brochureResponse);
    versionResponse = await fetch(`${base}/contest-versions/${created.latestVersionId}`, { headers: headers() });
    version = await json(versionResponse);
  }

  if (version.checksum !== appliedChecksum) throw new Error(`Applied configuration checksum ${version.checksum} does not match ${appliedChecksum}`);
  const receipt = { importedAt: new Date().toISOString(), apiBase: base, source: input.source, contestId: created.contestId, versionId: created.latestVersionId, revision: version.revision, sourceConfigurationChecksum: input.expectedConfigurationChecksum, configurationChecksum: version.checksum, brochureSha256: version.brochure?.sha256 };
  const receiptFile = file.replace(/\.json$/, '.receipt.json'); await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ...receipt, receiptFile }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });