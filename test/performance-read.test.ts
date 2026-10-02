import { describe, expect, it } from 'vitest';
import { Decimal128, Double, Int32, Long } from 'mongodb';
import { PERFORMANCE_METRIC_MAPPING, PERFORMANCE_SOURCE_KEYS, performanceMetricPath } from '../src/data/performance-mapping.js';
import { sourceSchema } from '../src/data/performance-import.js';
import { sourceDecimalText, sourceInteger, sourceMetricScalar } from '../src/data/performance-values.js';
import { performanceRecordMetadata, performanceWatermark } from '../src/data/performance-record.js';
import { performanceConnection, performanceDatabases, PERFORMANCE_DATABASES } from '../src/config/performance.js';
import { CATALOG } from '../src/data/catalog.js';

describe('existing Performance collection field contract', () => {
  it('AC-PA-DIRECT-18 every mapped field and lookup key exists in the supplied schema', () => {
    for (const [code, mapping] of Object.entries(PERFORMANCE_METRIC_MAPPING)) {
      expect(CATALOG.find(def => def.metricCode === code)?.valueType).toBe(mapping.valueType);
      const schema = sourceSchema(mapping.collection);
      const keys = PERFORMANCE_SOURCE_KEYS[mapping.collection];
      expect(schema.properties?.[keys.identity]?.bsonType).toBe('string');
      expect(schema.properties?.[keys.aggregation]?.bsonType).toBe('string');
      for (const period of mapping.periods) {
        for (const alternate of mapping.alternatePath ? [false, true] : [false]) {
          const fieldPath = performanceMetricPath(mapping, period, alternate)!;
          const field = fieldPath.split('.').reduce<ReturnType<typeof sourceSchema> | undefined>((node, key) => node?.properties?.[key], schema);
          expect(field, `${code}: ${mapping.collection}.${fieldPath}`).toBeDefined();
        }
      }
    }
    expect(performanceMetricPath(PERFORMANCE_METRIC_MAPPING.PERSISTENCY_Y1!, 'MTD')).toBeUndefined();
    expect(performanceMetricPath(PERFORMANCE_METRIC_MAPPING.FYP!, 'YTD', true)).toBeUndefined();
  });
  it('AC-PA-DIRECT-19 money preserves Decimal128 digits and applies approved cents rounding', () => {
    expect(sourceMetricScalar('MONEY', Decimal128.fromString('999999999999999.99'))).toEqual({ kind: 'MONEY', amount: '999999999999999.99', currency: 'MYR' });
    expect(sourceMetricScalar('MONEY', Decimal128.fromString('123456789012345.675'))).toMatchObject({ amount: '123456789012345.68' });
    expect(sourceMetricScalar('MONEY', Decimal128.fromString('-1.005'))).toMatchObject({ amount: '-1.01' });
    expect(sourceMetricScalar('MONEY', Long.fromString('123456789012345'))).toMatchObject({ amount: '123456789012345.00' });
    expect(sourceMetricScalar('MONEY', new Int32(3922))).toMatchObject({ amount: '3922.00' });
    expect(sourceMetricScalar('MONEY', new Double(5815.679999999999))).toMatchObject({ amount: '5815.68' });
    expect(sourceMetricScalar('MONEY', '+3922.000')).toMatchObject({ amount: '3922.00' });
  });
  it('AC-PA-DIRECT-20 invalid measures stay absent, not parsed as zero or partial numbers', () => {
    for (const value of [null, undefined, 'null', '', ' ', '12xyz', true, false, {}, [], NaN, Infinity, 'NaN', 'Infinity', '1'.repeat(129)]) {
      expect(sourceDecimalText(value)).toBeUndefined();
      expect(sourceMetricScalar('MONEY', value)).toBeUndefined();
    }
    expect(sourceMetricScalar('MONEY', '1000000000000000.00')).toBeUndefined();
    expect(sourceMetricScalar('MONEY', '1e9999')).toBeUndefined();
    expect(sourceMetricScalar('PERCENT', Decimal128.fromString('0.88'), true)).toEqual({ kind: 'PERCENT', value: 88 });
    expect(sourceMetricScalar('PERCENT', '1.01', true)).toBeUndefined();
    expect(sourceMetricScalar('DECIMAL', '1e-9999')).toBeUndefined();
    expect(sourceMetricScalar('DECIMAL', new Int32(1))).toEqual({ kind: 'DECIMAL', value: 1, precision: 1 });
  });
  it('AC-PA-DIRECT-20 COUNT rejects exact fractional and unsafe values before Number conversion', () => {
    expect(sourceInteger(Decimal128.fromString('1.000000000000000000001'))).toBeUndefined();
    expect(sourceInteger(Long.fromString('9007199254740993'))).toBeUndefined();
    expect(sourceInteger('9007199254740992')).toBeUndefined();
    expect(sourceInteger('9e2')).toBe(900);
    expect(sourceInteger('1.00')).toBe(1);
    expect(sourceInteger(Long.fromString('9007199254740991'))).toBe(Number.MAX_SAFE_INTEGER);
    expect(sourceMetricScalar('COUNT', new Int32(0))).toEqual({ kind: 'COUNT', value: 0 });
  });
  it('AC-PA-DIRECT-22 UTC watermark and reporting period validation do not accept date rollover', () => {
    expect(performanceWatermark(new Date('2026-09-07T11:09:09Z'))).toBe('2026-09-07');
    expect(performanceWatermark('2026-09-07')).toBe('2026-09-07');
    for (const value of ['2025-02-29T00:00:00Z', '2026-13-01', '2026-09-07T25:00:00Z', '07/09/2026', '2026-09-07 11:09:09', null, 0, new Date('invalid')]) {
      expect(() => performanceWatermark(value)).toThrow('metadata is invalid');
    }
    const row = { period: { year: new Int32(2024), month: new Int32(2), quarter: 'Q1', yyyymm: '2024-02', asOnMonthDay: '29' }, asOnDate: new Date('2026-09-07T00:00:00Z') };
    expect(performanceRecordMetadata(row)).toMatchObject({ year: 2024, month: 2, day: 29, asOfDate: '2026-09-07' });
    for (const patch of [{ year: 2025 }, { year: '2024' }, { month: 13 }, { quarter: 'Q2' }, { yyyymm: '202401' }, { asOnMonthDay: '30' }]) {
      expect(() => performanceRecordMetadata({ ...row, period: { ...row.period, ...patch } })).toThrow('metadata is invalid');
    }
  });
  it('AC-PA-DIRECT-23 fixed DB defaults and dedicated URI selection reject accidental fallback', () => {
    expect(performanceDatabases({})).toEqual(PERFORMANCE_DATABASES);
    // Deployments may name their databases freely; a blank value falls back to the default.
    expect(performanceDatabases({ MONGODB_PAMB_DB: 'prod_pamb', MONGODB_PBTB_DB: ' prod_pbtb ' })).toEqual({ PAMB: 'prod_pamb', PBTB: 'prod_pbtb' });
    expect(performanceDatabases({ MONGODB_PAMB_DB: '  ' })).toEqual(PERFORMANCE_DATABASES);
    expect(performanceConnection({ MONGODB_URI: 'mongodb://shared.invalid' })).toEqual({ databases: PERFORMANCE_DATABASES, uri: 'mongodb://shared.invalid' });
    expect(performanceConnection({ MONGODB_URI: 'mongodb://shared.invalid', MONGODB_PERFORMANCE_URI: 'mongodb://performance.invalid' }).uri).toBe('mongodb://performance.invalid');
    expect(() => performanceConnection({ MONGODB_URI: 'mongodb://shared.invalid', MONGODB_PERFORMANCE_URI: '' })).toThrow('connection required');
  });
});