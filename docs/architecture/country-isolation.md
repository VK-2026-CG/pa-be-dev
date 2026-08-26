# Country and database isolation

One deployment serves exactly one country. It owns one frontend, backend,
MongoDB instance, object-storage account, credential set and hostname set.
`COUNTRY_CODE` is deployment configuration; request bodies cannot select a
country or database. The authenticated JWT `cty` claim (development:
`x-tenant`) must equal `COUNTRY_CODE`.

Within a country instance, Insights and Contest use separate logical databases:

- `MONGODB_DB=insights`
- `MONGODB_CONTEST_DB=contests`

There is no URI or database fallback between bounded contexts. `db:setup` owns
only Insights and development mock-source collections;
`db:setup:contests` owns governed Contest collections. Migration is copy-first,
count-verified and country-checked. Source deletion and legacy deletion require
explicit `--confirm` commands.