import { Decimal128, Double, Int32, Long } from 'mongodb';
import { sourceMoney } from '../lib/money.js';
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
/** No Number conversion for Decimal128/Long money; reject objects/booleans/partial parses. */
export function sourceDecimalText(value) {
    let text;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            return undefined;
        text = String(value);
    }
    else if (typeof value === 'string')
        text = value;
    else if (value instanceof Decimal128 || value instanceof Long || value instanceof Double || value instanceof Int32)
        text = value.toString();
    else
        return undefined;
    if (!text.length || text.length > 128 || !DECIMAL.test(text))
        return undefined;
    return text.startsWith('+') ? text.slice(1) : text;
}
/** Detect fractional and unsafe integers exactly before conversion to API COUNT. */
export function sourceInteger(value) {
    const text = sourceDecimalText(value);
    if (text === undefined)
        return undefined;
    const match = DECIMAL.exec(text);
    const fraction = match[3] ?? '';
    const exponent = Number(match[4] ?? 0);
    if (Math.abs(exponent) > 100)
        return undefined;
    let coefficient = BigInt(match[2] + fraction);
    const shift = exponent - fraction.length;
    if (shift >= 0)
        coefficient *= 10n ** BigInt(shift);
    else {
        const divisor = 10n ** BigInt(-shift);
        if (coefficient % divisor !== 0n)
            return undefined;
        coefficient /= divisor;
    }
    if (match[1] === '-')
        coefficient = -coefficient;
    if (coefficient > BigInt(Number.MAX_SAFE_INTEGER) || coefficient < BigInt(Number.MIN_SAFE_INTEGER))
        return undefined;
    return Number(coefficient);
}
export function sourceMetricScalar(kind, value, fraction = false) {
    const text = sourceDecimalText(value);
    if (text === undefined)
        return undefined;
    if (kind === 'MONEY') {
        try {
            return { kind, amount: sourceMoney(text), currency: 'MYR' };
        }
        catch {
            return undefined;
        } // invalid/overflow measure is unavailable; other cards survive
    }
    if (kind === 'COUNT') {
        const integer = sourceInteger(value);
        return integer === undefined ? undefined : { kind, value: integer };
    }
    const numeric = Number(text);
    if (!Number.isFinite(numeric))
        return undefined;
    // Do not convert a nonzero underflow to a false zero.
    if (numeric === 0 && /[1-9]/.test(text.split(/[eE]/)[0]))
        return undefined;
    if (fraction && (numeric < 0 || numeric > 1))
        return undefined;
    const result = fraction ? Number((numeric * 100).toPrecision(15)) : numeric;
    return kind === 'PERCENT' ? { kind, value: result } : { kind: 'DECIMAL', value: result, precision: 1 };
}
