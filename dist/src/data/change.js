import { addDec, mulRatio, pctChange } from '../lib/money.js';
import { findDef } from './catalog.js';
export function roundToOneDecimal(n) { return Math.round(n * 10) / 10; }
export function sentimentFor(code, delta) {
    if (delta === 0)
        return 'NEUTRAL';
    const fav = findDef(code)?.favourability ?? 'HIGHER_IS_BETTER';
    const good = fav === 'HIGHER_IS_BETTER' ? delta > 0 : delta < 0;
    return good ? 'POSITIVE' : 'NEGATIVE';
}
export function directionFor(delta) {
    return delta === 0 ? 'FLAT' : delta > 0 ? 'UP' : 'DOWN';
}
/** Prior-year Change for two like-kind scalars, honoring the metric's changeDisplay (PCT/PP/ABS). */
export function changeFor(code, current, prior) {
    const display = findDef(code)?.changeDisplay ?? 'PCT';
    if (current.kind === 'MONEY' && prior.kind === 'MONEY') {
        const pct = pctChange(current.amount, prior.amount);
        const direction = directionFor(pct);
        const sentiment = sentimentFor(code, pct);
        return display === 'ABS'
            ? { basis: 'LAST_YEAR', direction, sentiment, abs: { kind: 'MONEY', amount: addDec(current.amount, mulRatio(prior.amount, -1, 1)), currency: current.currency } }
            : { basis: 'LAST_YEAR', direction, sentiment, pct };
    }
    if (current.kind === 'COUNT' && prior.kind === 'COUNT') {
        const diff = current.value - prior.value;
        const pct = prior.value === 0 ? 0 : Math.round(((current.value - prior.value) / prior.value) * 1000) / 10;
        const direction = directionFor(diff);
        const sentiment = sentimentFor(code, diff);
        return display === 'ABS'
            ? { basis: 'LAST_YEAR', direction, sentiment, abs: { kind: 'COUNT', value: diff } }
            : { basis: 'LAST_YEAR', direction, sentiment, pct };
    }
    if (current.kind === 'PERCENT' && prior.kind === 'PERCENT') {
        const pp = roundToOneDecimal(current.value - prior.value);
        const pct = prior.value === 0 ? 0 : roundToOneDecimal((current.value - prior.value) / prior.value * 100);
        const direction = directionFor(pp);
        const sentiment = sentimentFor(code, pp);
        return display === 'PCT' ? { basis: 'LAST_YEAR', direction, sentiment, pct } : { basis: 'LAST_YEAR', direction, sentiment, pp };
    }
    const cur = current;
    const pri = prior;
    const diff = roundToOneDecimal(cur.value - pri.value);
    return { basis: 'LAST_YEAR', direction: directionFor(diff), sentiment: sentimentFor(code, diff), abs: { kind: 'DECIMAL', value: diff, precision: 1 } };
}
