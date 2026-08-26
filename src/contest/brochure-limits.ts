/** Temporary hard ceiling for contest PDF brochures: 10 MiB. */
export const CONTEST_BROCHURE_HARD_MAX_BYTES = 10 * 1024 * 1024;

/** Deployments may lower the limit, but cannot raise it above the hard ceiling. */
export function contestBrochureMaxBytes(): number {
  const configured = Number(process.env.CONTEST_BROCHURE_MAX_BYTES ?? CONTEST_BROCHURE_HARD_MAX_BYTES);
  if (!Number.isSafeInteger(configured) || configured < 1) return CONTEST_BROCHURE_HARD_MAX_BYTES;
  return Math.min(configured, CONTEST_BROCHURE_HARD_MAX_BYTES);
}