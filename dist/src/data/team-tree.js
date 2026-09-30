/**
 * Deterministic Team Drilldown hierarchy for the offline memory engine
 * (SPEC-2026-004 · S-P4-07 0.2.0). Names/figures follow the requester's
 * "My Team" frames; badges, goal status, direct-report counts and per-member
 * activity have NO approved upstream source (spec OQ-79), so they exist only
 * here and are never emitted by the Mongo source mode.
 */
import { fromCents, toCents } from '../lib/money.js';
import { scaleMoney } from './values.js';
const NODES = new Map();
const add = (n) => NODES.set(n.agentId, { reports: [], ...n });
/**
 * Mock avatars cropped from the requester frames (FE `public/mock-avatars/`,
 * stub only — OQ-79). Named people keep their own face; generated members
 * cycle through the set so every card shows the designed photo face.
 */
const FACES = [
    'marcus-lee', 'jamal-thompson', 'sophia-patel', 'omar-hassan', 'isabel-nguyen',
    'david-muller', 'aiko-tanaka', 'liam-oconnor', 'isabella-martinez', 'noah-patel',
];
const FACE_BY_NAME = {
    'Marcus Lee': 'marcus-lee', 'Jamal Thompson': 'jamal-thompson', 'Sophia Patel': 'sophia-patel',
    'Omar Hassan': 'omar-hassan', 'Isabel Nguyen': 'isabel-nguyen', 'David Müller': 'david-muller',
    'Aiko Tanaka': 'aiko-tanaka', "Liam O'Connor": 'liam-oconnor', 'Isabella Martinez': 'isabella-martinez',
    'Noah Patel': 'noah-patel', 'Farid Ismail': 'noah-patel', 'Aisyah Rahman': 'isabella-martinez',
};
const photo = (name, seed) => `/mock-avatars/${FACE_BY_NAME[name] ?? FACES[seed % FACES.length]}.png`;
/** Badge mixes seen across the frames (f01/f06/f12/f15), cycled deterministically. */
const BADGE_SETS = [
    ['PV', 'ROOKIE', 'VIOLET', 'PWP'], ['MDRT', 'PWP'], ['PV', 'VIOLET', 'PWP'], ['ROOKIE', 'VIOLET', 'PWP'],
    ['PV', 'ROOKIE'], ['PV', 'ROOKIE', 'MDRT', 'PWP'], ['COT', 'EWP'], ['TOT', 'SWP', 'PV'], ['PWP'], ['WP', 'ROOKIE'],
];
/** Deterministic generated agent for a UM's team (stable per id). */
function genAgent(agentId, name, seed) {
    return {
        agentId, name, basis: 'AGENT', photo: photo(name, seed), badges: BADGE_SETS[seed % BADGE_SETS.length],
        goal: seed % 5 === 3 ? 'NOT_SET' : 'SET',
        tpc: 165_000 - seed * 1_000, ptpc: 198_000 - (seed % 4) * 2_000,
        cases: 3 + (seed % 5), active: seed % 7 !== 6, reports: [],
    };
}
const POOL = [
    'Omar Hassan', 'Isabel Nguyen', 'David Müller', 'Aiko Tanaka', "Liam O'Connor", 'Isabella Martinez',
    'Noah Patel', 'Chen Wei', 'Priya Nair', 'Hafiz Rahman', 'Sarah Lim', 'Daniel Ong', 'Nur Aina',
    'Kumar Selvam', 'Grace Tan', 'Arif Zulkifli', 'Mei Chan', 'Ravi Menon', 'Siti Aminah', 'Jason Koh',
    'Aisha Karim', 'Benjamin Lau', 'Farah Idris', 'Kevin Teo',
];
function team(prefix, size, offset) {
    const ids = [];
    for (let i = 0; i < size; i++) {
        const id = `${prefix}${String(i + 1).padStart(2, '0')}`;
        NODES.set(id, genAgent(id, POOL[(i + offset) % POOL.length], i + offset));
        ids.push(id);
    }
    return ids;
}
// UM teams opened from the subteam button (frame f12: "Marcus Lee's Team (24)").
const marcusTeam = team('KCM002', 24, 0);
const jamalTeam = team('KCM005', 24, 5);
const sophiaTeam = team('KCM004', 12, 7);
const faridTeam = team('KCM003', 8, 3);
// The AM (P2, L3001) has 10 direct reports: 4 UMs with teams + 6 agents (frames f01/f06/f15).
add({ agentId: 'KCM00101', name: 'Marcus Lee', basis: 'UM', photo: photo('Marcus Lee', 0), badges: ['MDRT', 'PWP'], goal: 'SET', tpc: 172_000, ptpc: 198_000, cases: 6, active: true, reports: marcusTeam });
add({ agentId: 'KCM00107', name: 'Jamal Thompson', basis: 'UM', photo: photo('Jamal Thompson', 1), badges: ['MDRT', 'PWP'], goal: 'SET', tpc: 171_000, ptpc: 198_000, cases: 6, active: true, reports: jamalTeam });
add({ agentId: 'KCM00102', name: 'Sophia Patel', basis: 'UM', photo: photo('Sophia Patel', 2), badges: ['PWP'], goal: 'NOT_SET', tpc: 171_000, ptpc: 198_000, cases: 5, active: true, reports: sophiaTeam });
// The P3 persona (L2001) is itself a UM in the AM's downline; its team includes the A1002/A1003 demo agents.
add({ agentId: 'L2001', name: 'Farid Ismail', basis: 'UM', photo: photo('Farid Ismail', 3), badges: ['MDRT', 'PWP'], goal: 'SET', tpc: 158_000, ptpc: 190_000, cases: 4, active: true, reports: [...faridTeam, 'A1002', 'A1003'] });
add({ agentId: 'A1002', name: 'Demo Empty', basis: 'AGENT', photo: photo('Demo Empty', 4), badges: [], goal: 'NOT_SET', tpc: 90_000, ptpc: 120_000, cases: 2, active: false });
add({ agentId: 'A1003', name: 'Demo Processing', basis: 'AGENT', photo: photo('Demo Processing', 5), badges: ['ROOKIE'], goal: 'NOT_SET', tpc: 95_000, ptpc: 125_000, cases: 2, active: true });
add({ agentId: 'KCM00103', name: 'Omar Hassan', basis: 'AGENT', photo: photo('Omar Hassan', 0), badges: ['PV', 'VIOLET', 'PWP'], goal: 'SET', tpc: 165_000, ptpc: 198_000, cases: 5, active: true });
add({ agentId: 'KCM00104', name: 'Isabel Nguyen', basis: 'AGENT', photo: photo('Isabel Nguyen', 0), badges: ['ROOKIE', 'VIOLET', 'PWP'], goal: 'SET', tpc: 164_000, ptpc: 198_000, cases: 4, active: true });
add({ agentId: 'KCM00105', name: "Liam O'Connor", basis: 'AGENT', photo: photo("Liam O'Connor", 0), badges: ['PV', 'ROOKIE', 'MDRT', 'PWP'], goal: 'SET', tpc: 163_000, ptpc: 197_000, cases: 4, active: true });
add({ agentId: 'KCM00106', name: 'David Müller', basis: 'AGENT', photo: photo('David Müller', 0), badges: ['PV', 'ROOKIE', 'MDRT', 'PWP'], goal: 'NOT_SET', tpc: 170_000, ptpc: 198_000, cases: 3, active: true });
add({ agentId: 'KCM00108', name: 'Aiko Tanaka', basis: 'AGENT', photo: photo('Aiko Tanaka', 0), badges: ['PV', 'ROOKIE'], goal: 'SET', tpc: 161_000, ptpc: 198_000, cases: 4, active: true });
add({ agentId: 'A1001', name: 'Aisyah Rahman', basis: 'AGENT', photo: photo('Aisyah Rahman', 0), badges: ['TOT', 'PV'], goal: 'SET', tpc: 150_000, ptpc: 180_000, cases: 4, active: true });
// Leaders.
add({ agentId: 'L3001', name: 'Mei Lin Tan', basis: 'AM', badges: [], goal: 'SET', tpc: 0, ptpc: 0, cases: 0, active: true,
    reports: ['KCM00101', 'KCM00107', 'KCM00102', 'L2001', 'KCM00103', 'KCM00104', 'KCM00105', 'KCM00106', 'KCM00108', 'A1001'] });
const LEVEL = { AM: 'P2', UM: 'P3', AGENT: 'P4' };
function money(amount, lens) {
    return { kind: 'MONEY', amount: scaleMoney(`${amount}.00`, lens), currency: 'MYR' };
}
function toMember(n, lens) {
    return {
        agentId: n.agentId, displayName: n.name, hierarchyBasis: n.basis, roleCode: n.basis,
        ...(n.badges.length ? { badges: n.badges } : {}),
        goalStatus: n.goal,
        tpc: money(n.tpc, lens),
        ptpc: money(n.ptpc, lens),
        ...(n.reports.length ? { directReportCount: n.reports.length } : {}),
        ...(n.photo ? { photoUrl: n.photo } : {}),
    };
}
/** Every node in `id`'s organisation, excluding `id` itself. */
function downline(id) {
    const out = [];
    for (const r of NODES.get(id)?.reports ?? []) {
        const n = NODES.get(r);
        if (n)
            out.push(n, ...downline(r));
    }
    return out;
}
export function teamNode(agentId) { return NODES.get(agentId); }
/** Resolves a hierarchy member to an AgentRecord so the dashboard can be composed for it. */
export function teamAgentRecord(agentId) {
    const n = NODES.get(agentId);
    return n ? { agentId: n.agentId, tenant: 'MY', level: LEVEL[n.basis], name: n.name } : undefined;
}
/** D-14 visibility: P3 sees its DIRECT team only; P2 sees its whole downline. */
export function visibleMember(leader, memberAgentId, lens) {
    const pool = leader.level === 'P2' ? downline(leader.agentId) : (NODES.get(leader.agentId)?.reports ?? []).map((r) => NODES.get(r));
    const n = pool.find((m) => m?.agentId === memberAgentId);
    return n ? toMember(n, lens) : undefined;
}
/** Direct reports of `ownerId`, filtered (ANY-match badges), sorted, with KPI stats over the filtered set. */
export function listTeam(ownerId, q) {
    const needle = q.query?.trim().toLowerCase() ?? '';
    const wanted = new Set(q.badges ?? []);
    const nodes = (NODES.get(ownerId)?.reports ?? [])
        .map((r) => NODES.get(r))
        .filter((n) => !q.basis || n.basis === q.basis)
        .filter((n) => !needle || n.agentId.toLowerCase().includes(needle) || n.name.toLowerCase().includes(needle))
        .filter((n) => wanted.size === 0 || n.badges.some((b) => wanted.has(b)));
    const key = (n) => (q.sortBy === 'PTPC' ? n.ptpc : n.tpc);
    nodes.sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name));
    // Roll-up over each filtered member's organisation (member + downline).
    const org = nodes.flatMap((n) => [n, ...downline(n.agentId)]);
    const manpower = org.length;
    const active = org.filter((n) => n.active);
    const cases = org.reduce((s, n) => s + n.cases, 0);
    const tpcCents = org.reduce((s, n) => s + toCents(scaleMoney(`${n.tpc}.00`, q.lens)), 0n);
    const summary = [
        { metricCode: 'MANPOWER', value: { kind: 'COUNT', value: manpower } },
        { metricCode: 'ACTIVITY_RATIO', ...(manpower ? { value: { kind: 'PERCENT', value: Math.round((active.length * 100) / manpower) } } : {}) },
        { metricCode: 'PRODUCTIVITY', ...(active.length ? { value: { kind: 'DECIMAL', value: Math.round((cases * 10) / active.length) / 10, precision: 1 } } : {}) },
        { metricCode: 'AVERAGE_CASE_SIZE', ...(cases ? { value: { kind: 'MONEY', amount: fromCents(tpcCents / BigInt(cases)), currency: 'MYR' } } : {}) },
    ];
    return { items: nodes.map((n) => toMember(n, q.lens)), summary };
}
