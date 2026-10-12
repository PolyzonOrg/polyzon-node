// Through an HTTP(S) proxy. HTTPS goes through a CONNECT tunnel: the proxy never sees the token.
// Without the `proxy` option the client honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY.
// Run: npm run build && POLYZON_API_KEY=pzk_... PROXY_URL=http://user:pass@proxy:3128 node examples/proxy.mjs
import Polyzon from 'polyzon';

const client = new Polyzon({
  proxy: process.env.PROXY_URL ?? 'http://proxy.example.com:3128',
  // A TLS-inspecting corporate proxy needs its root certificate:
  // ca: readFileSync('corporate-root-ca.pem'),
});

const limits = await client.limits();
console.log(`Through the proxy: ${limits.daily.remaining} requests left today`);
client.close();
