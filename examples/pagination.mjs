// Walk search results page by page. Every page costs one request of the daily quota,
// so use size: 50 and stop as soon as you have enough.
// Run: npm run build && POLYZON_API_KEY=pzk_... node examples/pagination.mjs
import Polyzon from 'polyzon';

const client = new Polyzon();

let count = 0;
for await (const item of client.searchAll({
  q: 'shelf bracket',
  size: 50,
  lang: 'en',
  sources: ['printables', 'thingiverse'],
  formats: ['stl', '3mf'],
})) {
  console.log(`${String(++count).padStart(3)}. ${item.title} (${item.stats.likes ?? '?'} likes)`);
  if (count >= 120) break; // 3 pages = 3 requests
}
