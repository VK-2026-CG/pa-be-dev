import { buildApp } from './app.js';
import { createSource } from './data/source.js';
import { createSpecContestRepository } from './contest/spec-repository.js';
const port = Number(process.env.PORT ?? 4600);
const host = process.env.HOST ?? '0.0.0.0';
Promise.all([createSource((m) => console.log(m)), createSpecContestRepository()])
    .then(([source, specContestRepository]) => buildApp(source, specContestRepository).listen({ port, host }))
    .then((addr) => {
    console.log(`pruaction-insights-service (Insights API 1.4.0) listening on ${addr}`);
})
    .catch((err) => {
    console.error(err);
    process.exit(1);
});
