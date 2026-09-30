import { createHash } from 'node:crypto';
import { LOVS } from './catalog.js';
export const RULE_ENGINE_VERSION = 'contest-rule-engine-0.2.0';
export const RULE_CATALOGUE_VERSION = 'MY-2026.2';
const MAX_DEPTH = 8;
const MAX_NODES = 200;
const numericOperators = ['GTE', 'GT', 'LTE', 'LT', 'EQ', 'NEQ', 'BETWEEN', 'EXISTS'];
const lovOperators = ['EQ', 'NEQ', 'IN', 'NOT_IN', 'EXISTS'];
const booleanOperators = ['EQ', 'NEQ', 'EXISTS'];
const metric = (code, kind, operators, extra = {}) => ({ code, kind, operators, ...extra });
const metrics = [
    metric('AGENT_ACTIVE', 'BOOLEAN', booleanOperators),
    metric('PRODUCER_CLASS', 'LOV', lovOperators, { lovKey: 'rank' }), metric('CHANNEL', 'LOV', lovOperators, { lovKey: 'channel' }),
    ...['TPC', 'PTPC', 'FYP', 'FYC', 'ANNUAL_INCOME', 'RISK_INCOME', 'VNA_TPC', 'APE', 'API'].map(code => metric(code, 'MONEY', numericOperators, { currency: 'MYR' })),
    ...['CASE_COUNT', 'PWYP_CASE_COUNT', 'VNA_COUNT', 'MDRT_MEMBER_COUNT', 'DIRECT_UNIT_QUALIFIER_COUNT', 'NEW_ACCOUNT_COUNT', 'PREMIER_CONSECUTIVE_YEARS', 'CONTRACT_TENURE_MONTHS', 'PAYMENT_TERM_YEARS'].map(code => metric(code, 'INTEGER', numericOperators)),
    ...['IPR', 'CURRENT_IPR', 'BASE_PRODUCT_SHARE'].map(code => metric(code, 'PERCENT', numericOperators)),
    ...['UGQP', 'PQP'].map(code => metric(code, 'DECIMAL', numericOperators)),
    ...['IS_ROOKIE', 'IS_VALIDATED_NEW_AGENT', 'IS_REGISTERED_MDRT', 'SUMMIT_QUALIFIED', 'DIRECT_OR_GROUP_QUALIFIED', 'IS_CONTRACTED', 'IS_REJOINED_AGENT', 'IS_IMMEDIATE_FAMILY', 'IS_FIRST_TIME_QUALIFIER'].map(code => metric(code, 'BOOLEAN', booleanOperators)),
    ...['CONTRACT_DATE', 'CAPTURE_DATE', 'SUBMISSION_DATE', 'REGISTRATION_DATE', 'BUSINESS_DATE'].map(code => metric(code, 'DATE', numericOperators)),
    metric('AGENT_LEVEL', 'LOV', lovOperators, { lovKey: 'agent.level' }), metric('AUDIENCE_TYPE', 'LOV', lovOperators, { lovKey: 'qualifier.type' }),
    metric('BUSINESS_LINE', 'LOV', lovOperators, { lovKey: 'business.line' }), metric('PRODUCT_FAMILY', 'LOV', lovOperators, { lovKey: 'product.family' }),
    metric('PRODUCT_CODE', 'LOV', lovOperators, { lovKey: 'product.code' }), metric('RIDER_CODE', 'LOV', lovOperators, { lovKey: 'rider.code' }),
    metric('PREMIUM_TYPE', 'LOV', lovOperators, { lovKey: 'premium.type' }), metric('TRANSACTION_TYPE', 'LOV', lovOperators, { lovKey: 'transaction.type' }),
    metric('BUSINESS_TYPE', 'LOV', lovOperators, { lovKey: 'business.type' }), metric('REPRICING_TREATMENT', 'LOV', lovOperators, { lovKey: 'production.repricing' }),
    metric('SOURCE_QUALIFICATION', 'LOV', lovOperators, { lovKey: 'source.qualification' }), metric('REGION', 'LOV', lovOperators, { lovKey: 'contest.region' }),
];
const catalogue = new Map(metrics.map((item) => [item.code, item]));
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalDecimal = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
function operandValid(metric, operator, operand) {
    if (operator === 'EXISTS')
        return operand === undefined;
    if (!operand || typeof operand !== 'object')
        return false;
    const value = operand;
    if (operator === 'BETWEEN') {
        if (metric.kind === 'DATE')
            return value.kind === 'DATE_RANGE' && typeof value.from === 'string' && typeof value.to === 'string';
        return value.kind === 'RANGE' && typeof value.from === 'string' && canonicalDecimal.test(value.from) && typeof value.to === 'string' && canonicalDecimal.test(value.to);
    }
    if (metric.kind === 'BOOLEAN')
        return value.kind === 'BOOLEAN' && typeof value.value === 'boolean';
    if (metric.kind === 'INTEGER')
        return value.kind === 'INTEGER' && Number.isInteger(value.value);
    if (metric.kind === 'DATE')
        return value.kind === 'DATE' && typeof value.value === 'string' && !Number.isNaN(Date.parse(value.value));
    if (metric.kind === 'LOV') {
        const codes = ['IN', 'NOT_IN'].includes(operator) && value.kind === 'LOV_SET' && Array.isArray(value.valueCodes) ? value.valueCodes
            : value.kind === 'LOV' && typeof value.valueCode === 'string' ? [value.valueCode] : [];
        const allowed = metric.lovKey ? LOVS[metric.lovKey]?.map(item => item.code) : undefined;
        return value.lovKey === metric.lovKey && codes.length > 0 && Boolean(allowed) && codes.every(code => allowed.includes(String(code)));
    }
    return ['MONEY', 'DECIMAL', 'PERCENT'].includes(String(value.kind)) && typeof value.value === 'string' && canonicalDecimal.test(value.value) && (metric.kind !== 'MONEY' || value.currency === metric.currency);
}
export function validateRuleExpression(expression, options) {
    const issues = [];
    const outcomes = [];
    const ids = new Set();
    let nodes = 0;
    const add = (path, code, messageKey) => issues.push({ path, code, messageKey });
    const visit = (value, depth) => {
        const node = value;
        const nodeId = typeof node?.nodeId === 'string' ? node.nodeId : `missing_${nodes}`;
        const path = `/expression/nodes/${nodeId}`;
        nodes += 1;
        if (!node || typeof node !== 'object') {
            add(path, 'INVALID_NODE', 'contest.error.ruleNodeInvalid');
            return;
        }
        if (depth > MAX_DEPTH)
            add(path, 'RULE_DEPTH_LIMIT', 'contest.error.ruleDepth');
        if (typeof node.nodeId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(node.nodeId))
            add(`${path}/nodeId`, 'INVALID_NODE_ID', 'contest.error.ruleNodeId');
        else if (ids.has(node.nodeId))
            add(`${path}/nodeId`, 'DUPLICATE_NODE_ID', 'contest.error.duplicateNodeId');
        else
            ids.add(node.nodeId);
        if (node.type === 'ALL' || node.type === 'ANY') {
            if (!Array.isArray(node.children) || node.children.length === 0)
                add(`${path}/children`, 'EMPTY_GROUP', 'contest.error.emptyRuleGroup');
            if (node.type === 'ANY' && node.minimumPass !== undefined && (!Number.isInteger(node.minimumPass) || node.minimumPass < 1 || node.minimumPass > (node.children?.length ?? 0)))
                add(`${path}/minimumPass`, 'INVALID_MINIMUM_PASS', 'contest.error.minimumPass');
            for (const child of node.children ?? [])
                visit(child, depth + 1);
        }
        else if (node.type === 'NOT') {
            if (!node.child)
                add(`${path}/child`, 'MISSING_CHILD', 'contest.error.emptyRuleGroup');
            else
                visit(node.child, depth + 1);
        }
        else if (node.type === 'PREDICATE') {
            const metric = catalogue.get(String(node.metricCode));
            if (!metric)
                add(`${path}/metricCode`, 'UNKNOWN_METRIC', 'contest.error.unknownMetric');
            else if (!metric.operators.includes(String(node.operator)))
                add(`${path}/operator`, 'INVALID_OPERATOR', 'contest.error.operatorType');
            else if (!operandValid(metric, String(node.operator), node.operand))
                add(`${path}/operand`, 'INVALID_OPERAND', 'contest.error.operandType');
        }
        else
            add(`${path}/type`, 'INVALID_NODE_TYPE', 'contest.error.ruleNodeInvalid');
        outcomes.push({ nodeId, outcome: 'NOT_EVALUATED', ...(issues.some((issue) => issue.path.startsWith(path)) ? { reasonCode: 'VALIDATION_ERROR' } : {}) });
    };
    visit(expression, 1);
    if (nodes > MAX_NODES)
        add('/expression', 'RULE_NODE_LIMIT', 'contest.error.ruleLimit');
    const opts = options;
    if (!opts || !['FULL_CAMPAIGN', 'MONTHLY_INDEPENDENT', 'CUMULATIVE', 'CUSTOM_WINDOWS'].includes(String(opts.periodMode)) || opts.unknownCodePolicy !== 'BLOCK')
        add('/options', 'INVALID_OPTIONS', 'contest.error.ruleOptions');
    return { valid: issues.length === 0, issues, nodeOutcomes: outcomes, configurationChecksum: sha256({ expression, options }), engineVersion: RULE_ENGINE_VERSION, catalogueVersion: RULE_CATALOGUE_VERSION };
}
export function initialRuleExpression(root = 'ALL') { return { nodeId: `root_${createHash('sha1').update(`${root}:${Date.now()}`).digest('hex').slice(0, 12)}`, type: root, children: [] }; }
