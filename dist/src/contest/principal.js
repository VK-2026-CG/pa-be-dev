import { getCountryContext } from '../config/country.js';
const values = (value) => String(value ?? '').split(/[\s,]+/).filter(Boolean);
/**
 * Development-only identity adapter. Production IAM claim mapping is an open
 * business decision, so CONTEST_AUTH_MODE=iam deliberately fails closed unless
 * the application injects a production ContestPrincipalAdapter.
 */
export class DevelopmentHeaderPrincipalAdapter {
    deploymentCountry;
    constructor(deploymentCountry = getCountryContext().countryCode) {
        this.deploymentCountry = deploymentCountry;
    }
    authorize(request, context) {
        if (process.env.CONTEST_AUTH_MODE === 'iam')
            return { allowed: false, status: 401, code: 'CON-4001', title: 'Production contest principal adapter is not configured' };
        const id = String(request.headers['x-agent-id'] ?? '');
        const tenant = String(request.headers['x-tenant'] ?? '');
        if (!id || !tenant)
            return { allowed: false, status: 401, code: 'CON-4001', title: 'Missing contest identity' };
        if (tenant !== this.deploymentCountry)
            return { allowed: false, status: 403, code: 'CON-4031', title: 'Country deployment mismatch' };
        if (tenant !== context.tenant)
            return { allowed: false, status: 403, code: 'CON-4031', title: 'Tenant grant denied' };
        const scopes = values(request.headers['x-scopes']);
        const hasScopes = context.scopeMode === 'ANY'
            ? context.requiredScopes.some((scope) => scopes.includes(scope))
            : context.requiredScopes.every((scope) => scopes.includes(scope));
        if (scopes.length && !hasScopes)
            return { allowed: false, status: 403, code: 'CON-4031', title: 'Required contest scope is missing' };
        const tenantGrants = values(request.headers['x-tenant-grants']);
        if (tenantGrants.length && !tenantGrants.includes(tenant))
            return { allowed: false, status: 403, code: 'CON-4031', title: 'Tenant grant denied' };
        const entityGrants = values(request.headers['x-entity-grants']);
        if (context.entityId && entityGrants.length && !entityGrants.includes(context.entityId))
            return { allowed: false, status: 403, code: 'CON-4031', title: 'Entity grant denied' };
        const channelGrants = values(request.headers['x-channel-grants']);
        if (context.channelCode && channelGrants.length && !channelGrants.includes(context.channelCode))
            return { allowed: false, status: 403, code: 'CON-4031', title: 'Channel grant denied' };
        return { allowed: true, actor: { id, tenant } };
    }
}
