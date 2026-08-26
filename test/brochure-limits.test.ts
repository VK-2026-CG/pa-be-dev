import { afterEach, describe, expect, it } from 'vitest';
import { CONTEST_BROCHURE_HARD_MAX_BYTES, contestBrochureMaxBytes } from '../src/contest/brochure-limits.js';

const original = process.env.CONTEST_BROCHURE_MAX_BYTES;
afterEach(() => { if (original === undefined) delete process.env.CONTEST_BROCHURE_MAX_BYTES; else process.env.CONTEST_BROCHURE_MAX_BYTES = original; });

describe('contest brochure size limit', () => {
  it('defaults to a 10 MiB hard ceiling', () => {
    delete process.env.CONTEST_BROCHURE_MAX_BYTES;
    expect(CONTEST_BROCHURE_HARD_MAX_BYTES).toBe(10_485_760);
    expect(contestBrochureMaxBytes()).toBe(10_485_760);
  });

  it('allows a deployment to lower but never raise the 10 MiB ceiling', () => {
    process.env.CONTEST_BROCHURE_MAX_BYTES = '1048576';
    expect(contestBrochureMaxBytes()).toBe(1_048_576);
    process.env.CONTEST_BROCHURE_MAX_BYTES = '99999999';
    expect(contestBrochureMaxBytes()).toBe(10_485_760);
  });
});