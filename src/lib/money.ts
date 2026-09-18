/** Decimal-string money math on integer cents (D-04: no floats on the wire). */
export function toCents(dec: string): bigint {
  const neg = dec.startsWith('-');
  const [i = '0', f = ''] = (neg ? dec.slice(1) : dec).split('.');
  const frac = (f + '00').slice(0, 2);
  const c = BigInt(i) * 100n + BigInt(frac);
  return neg ? -c : c;
}
export function fromCents(c: bigint): string {
  const neg = c < 0n; const a = neg ? -c : c;
  const i = a / 100n; const f = a % 100n;
  return `${neg ? '-' : ''}${i}.${f.toString().padStart(2, '0')}`;
}

/** Source double -> decimal cents using its decimal spelling, not float arithmetic. */
export function sourceMoney(value: number | string): string {
  const input = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(input);
  if (!match || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid source money');
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 100) throw new Error('Source money exceeds supported precision');
  const coefficient = BigInt(match[2]! + fraction);
  const shift = 2 + exponent - fraction.length;
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  let cents = shift >= 0 ? coefficient * 10n ** BigInt(shift) : coefficient / divisor;
  if (shift < 0 && 2n * (coefficient % divisor) >= divisor) cents += 1n;
  if (match[1]) cents = -cents;
  const result = fromCents(cents);
  if (!/^-?\d{1,15}\.\d{2}$/.test(result)) throw new Error('Source money exceeds API range');
  return result;
}
/** Multiply by a rational num/den with half-up rounding — keeps everything integral. */
export function mulRatio(dec: string, num: number, den: number): string {
  const c = toCents(dec) * BigInt(num);
  const d = BigInt(den);
  let q = c / d; const r = c % d;
  if (2n * (r < 0n ? -r : r) >= d) q = c < 0n ? q - 1n : q + 1n;
  return fromCents(q);
}
export function addDec(a: string, b: string): string { return fromCents(toCents(a) + toCents(b)); }
export function pctChange(current: string, prior: string): number {
  const c = Number(toCents(current)); const p = Number(toCents(prior));
  if (p === 0) return 0;
  return Math.round(((c - p) / p) * 1000) / 10;
}
