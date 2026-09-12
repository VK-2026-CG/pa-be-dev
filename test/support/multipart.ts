/** Minimal multipart/form-data body builder for tests that upload a file (Fastify's `inject()` has no built-in multipart helper, unlike Playwright's `request` fixture). */
const BOUNDARY = 'bff-test-boundary-1a2b3c';

export interface MultipartFile { fieldName: string; fileName: string; contentType: string; buffer: Buffer }

export function buildMultipart(fields: Record<string, string>, file?: MultipartFile): { contentType: string; body: Buffer } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${BOUNDARY}`, body: Buffer.concat(parts) };
}
