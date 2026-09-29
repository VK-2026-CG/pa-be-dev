import type { Document } from 'mongodb';
import { sourceInteger } from './performance-values.js';

export class PerformanceSourceNotFound extends Error {
  readonly status = 404;
  readonly statusCode = 404;
  readonly code = 'INS-4040';
  readonly title = 'No Performance records found for this identity';
  constructor() { super('No Performance records found for this identity'); }
}

/** Safe to expose to HTTP error handling: never includes record content or identifiers. */
export function invalidPerformanceMetadata(): Error {
  return new Error('Performance source metadata is invalid');
}

function calendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1900 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) return false;
  return Number.isInteger(day) && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse only explicit UTC values, not locale strings or Date's permissive rollover. */
export function performanceWatermark(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw invalidPerformanceMetadata();
    value = value.toISOString();
  }
  if (typeof value !== 'string') throw invalidPerformanceMetadata();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z)?$/.exec(value);
  if (!match || !calendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
    || (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59))) {
    throw invalidPerformanceMetadata();
  }
  return value.slice(0, 10);
}

export interface PerformanceRecordMetadata {
  year: number;
  month: number;
  day?: number;
  rank: number;
  asOfDate: string;
}

export function performanceRecordMetadata(row: Document): PerformanceRecordMetadata {
  const period: unknown = row.period;
  if (!period || typeof period !== 'object' || Array.isArray(period)) throw invalidPerformanceMetadata();
  const fields = period as Record<string, unknown>;
  // Source schema declares numeric year/month. Do not accept lexical sorting of strings.
  if (typeof fields.year === 'string' || typeof fields.month === 'string') throw invalidPerformanceMetadata();
  const year = sourceInteger(fields.year), month = sourceInteger(fields.month);
  if (year === undefined || month === undefined || !calendarDate(year, month, 1)) throw invalidPerformanceMetadata();
  if (fields.quarter !== undefined && fields.quarter !== `Q${Math.ceil(month / 3)}`) throw invalidPerformanceMetadata();
  const ym = `${year}${String(month).padStart(2, '0')}`;
  if (fields.yyyymm !== undefined && fields.yyyymm !== ym && fields.yyyymm !== `${year}-${String(month).padStart(2, '0')}`) throw invalidPerformanceMetadata();
  let day: number | undefined;
  if (fields.asOnMonthDay !== undefined && fields.asOnMonthDay !== null) {
    // Production stores a full UTC date here (not a bare day-of-month like MAPA/persistency);
    // its own year/month must agree with the declared period, not just its day-of-month.
    if (fields.asOnMonthDay instanceof Date) {
      if (!Number.isFinite(fields.asOnMonthDay.getTime())
        || fields.asOnMonthDay.getUTCFullYear() !== year || fields.asOnMonthDay.getUTCMonth() + 1 !== month) throw invalidPerformanceMetadata();
      day = fields.asOnMonthDay.getUTCDate();
    } else {
      day = sourceInteger(fields.asOnMonthDay);
    }
    if (day === undefined || !calendarDate(year, month, day)) throw invalidPerformanceMetadata();
  }
  return { year, month, day, rank: year * 12 + month, asOfDate: performanceWatermark(row.asOnDate) };
}