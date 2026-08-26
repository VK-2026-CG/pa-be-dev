import { describe, expect, it } from 'vitest';
import { getCountryContext } from '../src/config/country.js';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';

process.env.MONGODB_URI = '';

describe('country-isolated deployment context', () => {
  it('resolves the registered Malaysia adapter and fails closed for an unknown country', () => {
    expect(getCountryContext('MY')).toMatchObject({ countryCode: 'MY', lbuCode: 'my' });
    expect(() => getCountryContext('PH')).toThrow('Unsupported COUNTRY_CODE: PH');
  });

  it('rejects a request whose country does not match the deployment instance', async () => {
    const app = buildApp(await createSource());
    const response = await app.inject({ url: '/contests/v1/contests', headers: { 'x-agent-id': 'A1001', 'x-tenant': 'PH' } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('CON-4031');
  });
});