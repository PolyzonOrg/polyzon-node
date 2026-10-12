// Fetch many model cards in parallel (at most 4 requests in flight). Results come in input
// order; each holds either the model or the error.
// Run: npm run build && POLYZON_API_KEY=pzk_... node examples/batch.mjs
import Polyzon, { GoneError } from 'polyzon';

const client = new Polyzon();

const page = await client.search({ q: 'органайзер', size: 10 });
const results = await client.getModels(page.items, { concurrency: 4 });

for (const result of results) {
  const ref = `${result.source}/${result.id}`;
  if (result.error instanceof GoneError) {
    console.log(`${ref}: removed at the right holder's request — delete your copy`);
  } else if (result.error) {
    console.log(`${ref}: ${result.error.message}`);
  } else {
    console.log(`${ref}: ${result.model.title} (${result.model.images.length} images)`);
  }
}
