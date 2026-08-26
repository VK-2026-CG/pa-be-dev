export const COUNTRY_CODES = ['MY'] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

export interface CountryContext {
  countryCode: CountryCode;
  lbuCode: 'my';
  defaultTimezone: 'Asia/Kuala_Lumpur';
  contestCatalogueVersion: 'MY-2026.2';
}

const COUNTRIES: Record<CountryCode, CountryContext> = {
  MY: { countryCode: 'MY', lbuCode: 'my', defaultTimezone: 'Asia/Kuala_Lumpur', contestCatalogueVersion: 'MY-2026.2' },
};

/** One process serves exactly one country instance. Unknown configuration fails closed. */
export function getCountryContext(value = process.env.COUNTRY_CODE ?? 'MY'): CountryContext {
  const code = value.toUpperCase();
  if (!COUNTRY_CODES.includes(code as CountryCode)) throw new Error(`Unsupported COUNTRY_CODE: ${code}`);
  return COUNTRIES[code as CountryCode];
}