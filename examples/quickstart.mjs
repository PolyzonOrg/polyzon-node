// Quick start: who am I, a search, one model card, remaining quota.
// Run: npm run build && POLYZON_API_KEY=pzk_... node examples/quickstart.mjs
import Polyzon from 'polyzon';

const client = new Polyzon(); // reads POLYZON_API_KEY

const me = await client.me();
console.log(`Token "${me.token.name}" of ${me.account.displayName ?? 'an account'}`);

const page = await client.search({ q: 'дракон', size: 5, free: true, sort: 'popular' });
console.log(`${page.total} models found (request id ${page.meta.requestId})`);
for (const item of page.items) {
  console.log(`- [${item.source}] ${item.title} — ${item.url}`);
}

const first = page.items[0];
if (first) {
  const model = await client.getModel(first.source, first.id, { lang: 'en' });
  console.log(`${model.title}: license ${model.license?.id ?? 'unknown'}, ${model.images.length} images`);
}

const limits = await client.limits();
console.log(
  `Left: ${limits.perMinute.remaining}/${limits.perMinute.limit} this minute, ` +
    `${limits.daily.remaining}/${limits.daily.limit} today`,
);
