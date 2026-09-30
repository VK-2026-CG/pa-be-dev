export const COUNTRY_CODES = ['MY'];
const COUNTRIES = {
    MY: { countryCode: 'MY', lbuCode: 'my', defaultTimezone: 'Asia/Kuala_Lumpur', contestCatalogueVersion: 'MY-2026.2' },
};
/** One process serves exactly one country instance. Unknown configuration fails closed. */
export function getCountryContext(value = process.env.COUNTRY_CODE ?? 'MY') {
    const code = value.toUpperCase();
    if (!COUNTRY_CODES.includes(code))
        throw new Error(`Unsupported COUNTRY_CODE: ${code}`);
    return COUNTRIES[code];
}
