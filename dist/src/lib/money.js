/** Decimal-string money math on integer cents (D-04: no floats on the wire). */
export function toCents(dec) {
    const neg = dec.startsWith('-');
    const [i = '0', f = ''] = (neg ? dec.slice(1) : dec).split('.');
    const frac = (f + '00').slice(0, 2);
    const c = BigInt(i) * 100n + BigInt(frac);
    return neg ? -c : c;
}
export function fromCents(c) {
    const neg = c < 0n;
    const a = neg ? -c : c;
    const i = a / 100n;
    const f = a % 100n;
    return `${neg ? '-' : ''}${i}.${f.toString().padStart(2, '0')}`;
}
/** Source double -> decimal cents using its decimal spelling, not float arithmetic. */
export function sourceMoney(value) {
    const input = String(value);
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(input);
    if (!match || (typeof value === 'number' && !Number.isFinite(value)))
        throw new Error('Invalid source money');
    const fraction = match[3] ?? '';
    const exponent = Number(match[4] ?? 0);
    if (Math.abs(exponent) > 100)
        throw new Error('Source money exceeds supported precision');
    const coefficient = BigInt(match[2] + fraction);
    const shift = 2 + exponent - fraction.length;
    const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
    let cents = shift >= 0 ? coefficient * 10n ** BigInt(shift) : coefficient / divisor;
    if (shift < 0 && 2n * (coefficient % divisor) >= divisor)
        cents += 1n;
    if (match[1])
        cents = -cents;
    const result = fromCents(cents);
    if (!/^-?\d{1,15}\.\d{2}$/.test(result))
        throw new Error('Source money exceeds API range');
    return result;
}
/** Multiply by a rational num/den with half-up rounding — keeps everything integral. */
export function mulRatio(dec, num, den) {
    const c = toCents(dec) * BigInt(num);
    const d = BigInt(den);
    let q = c / d;
    const r = c % d;
    if (2n * (r < 0n ? -r : r) >= d)
        q = c < 0n ? q - 1n : q + 1n;
    return fromCents(q);
}
export function addDec(a, b) { return fromCents(toCents(a) + toCents(b)); }
/**
 * widget-contracts §2 `R-PCT-ROUNDUP` on decimal-string money: integer % change
 * rounded away from zero, computed on exact cents (never parseFloat). Zero prior
 * returns 0 — unresolved (OQ-54), same as `pctChange`.
 */
export function pctRoundUpDec(current, prior) {
    const p = toCents(prior);
    if (p === 0n)
        return 0;
    const diff = toCents(current) - p;
    const num = (diff < 0n ? -diff : diff) * 100n;
    const den = p < 0n ? -p : p;
    const mag = num / den + (num % den === 0n ? 0n : 1n);
    const sign = (diff < 0n ? -1 : 1) * (p < 0n ? -1 : 1);
    return mag === 0n ? 0 : sign * Number(mag);
}
export function pctChange(current, prior) {
    const c = Number(toCents(current));
    const p = Number(toCents(prior));
    if (p === 0)
        return 0;
    return Math.round(((c - p) / p) * 1000) / 10;
}
