/**
 * Proxy support without dependencies: proxy URL parsing, the standard proxy environment
 * variables, and an `https.Agent` that reaches HTTPS targets through an HTTP CONNECT tunnel
 * (end-to-end TLS: the proxy never sees the token) while keeping keep-alive pooling.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';

/** A parsed proxy: its origin without credentials plus the ready `Proxy-Authorization`. */
export interface ProxyConfig {
  /** `http(s)://host:port` — no userinfo, safe to log. */
  readonly url: URL;
  /** `Basic …` built from the URL userinfo, or `null`. */
  readonly authorization: string | null;
}

/**
 * Parses a proxy URL. A value without a scheme (`proxy.corp:3128`, common in env vars) is
 * treated as `http://`. Messages never echo the value: it may hold credentials.
 *
 * @param value The proxy URL.
 * @param what Name of the setting for error messages.
 */
export function parseProxy(value: string | URL, what = 'proxy'): ProxyConfig {
  const raw = String(value).trim();
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    throw new TypeError(`${what} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(
      `${what} must be an http:// or https:// URL; for SOCKS pass an agent such as socks-proxy-agent`,
    );
  }
  if (!url.hostname) throw new TypeError(`${what} has no host`);
  let authorization: string | null = null;
  if (url.username || url.password) {
    let credentials: string;
    try {
      credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    } catch {
      throw new TypeError(`${what} has malformed percent-encoding in its credentials`);
    }
    authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  return { url: new URL(url.origin), authorization };
}

/** `localhost`, `*.localhost`, `127.0.0.0/8` or `::1` — never sent through env proxies. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Whether `NO_PROXY` exempts the target. Entries are separated by commas or spaces: `*`
 * (everything), a host or domain matched as a suffix on a label boundary (`example.com`,
 * `.example.com` and `*.example.com` all match `api.example.com`), optionally with a port
 * (`example.com:8443`), or an exact IP literal (`10.0.0.1`, `[::1]:8080`). CIDR ranges are
 * not supported.
 */
export function matchesNoProxy(target: URL, noProxy: string): boolean {
  const host = target.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const raw of noProxy.toLowerCase().split(/[\s,]+/)) {
    if (!raw) continue;
    if (raw === '*') return true;
    let entry = raw;
    let entryPort = '';
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
    if (bracketed) {
      entry = bracketed[1] ?? '';
      entryPort = bracketed[2] ?? '';
    } else if (raw.split(':').length === 2) {
      [entry = '', entryPort = ''] = raw.split(':');
    }
    if (entryPort && entryPort !== port) continue;
    entry = entry.replace(/^\*?\./, '').replace(/\.$/, '');
    if (entry && (host === entry || host.endsWith(`.${entry}`))) return true;
  }
  return false;
}

const env = (environment: NodeJS.ProcessEnv, ...names: string[]): [string, string] | null => {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return [name, value];
  }
  return null;
};

/**
 * The proxy the environment asks for for this target, or `null`. HTTPS targets use
 * `https_proxy` / `HTTPS_PROXY`, falling back to `http_proxy` / `HTTP_PROXY` (like undici);
 * `no_proxy` / `NO_PROXY` exempts targets; loopback targets are never proxied.
 */
export function proxyFromEnv(target: URL, environment: NodeJS.ProcessEnv = process.env): ProxyConfig | null {
  if (isLoopback(target.hostname)) return null;
  const found =
    target.protocol === 'https:'
      ? env(environment, 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY')
      : env(environment, 'http_proxy', 'HTTP_PROXY');
  if (!found) return null;
  const noProxy = env(environment, 'no_proxy', 'NO_PROXY');
  if (noProxy && matchesNoProxy(target, noProxy[1])) return null;
  return parseProxy(found[1], found[0]);
}

/** `host:port` for the CONNECT request line; IPv6 hosts in brackets. */
const authority = (host: string, port: number | string): string =>
  `${host.includes(':') ? `[${host}]` : host}:${port}`;

/** Options of {@link TunnelAgent}. */
export interface TunnelAgentOptions extends https.AgentOptions {
  /** How long the proxy may take to answer CONNECT, milliseconds. */
  connectTimeout: number;
}

/**
 * An `https.Agent` whose connections are TLS sessions to the target, opened inside an
 * HTTP CONNECT tunnel through the proxy. The agent pools them like direct connections.
 */
export class TunnelAgent extends https.Agent {
  readonly #proxy: ProxyConfig;
  readonly #connectTimeout: number;
  readonly #ca: TunnelAgentOptions['ca'];

  /**
   * @param proxy The proxy to tunnel through.
   * @param options Agent options; `ca` is also trusted for an `https://` proxy.
   */
  constructor(proxy: ProxyConfig, options: TunnelAgentOptions) {
    const { connectTimeout, ...agentOptions } = options;
    super(agentOptions);
    this.#proxy = proxy;
    this.#connectTimeout = connectTimeout;
    this.#ca = options.ca;
  }

  /** Opens the tunnel, then TLS to the target; hands the TLS socket to `callback`. */
  override createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    const host = options.hostname ?? options.host ?? 'localhost';
    const target = authority(host, options.port ?? 443);
    const proxy = this.#proxy.url;
    const secureProxy = proxy.protocol === 'https:';
    const request = (secureProxy ? https : http).request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: proxy.port || (secureProxy ? 443 : 80),
      method: 'CONNECT',
      path: target,
      headers: {
        host: target,
        ...(this.#proxy.authorization ? { 'proxy-authorization': this.#proxy.authorization } : {}),
      },
      agent: false,
      ...(secureProxy && this.#ca ? { ca: this.#ca } : {}),
    });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      callback?.(error, undefined as unknown as Duplex);
    };
    const timer = setTimeout(() => {
      fail(new Error(`proxy did not answer CONNECT within ${this.#connectTimeout} ms`));
    }, this.#connectTimeout);
    // Node reports every answer to CONNECT (2xx or not) as 'connect'.
    request.once('connect', (response, socket, head) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        socket.destroy();
        fail(new Error(`proxy refused CONNECT to ${target} with HTTP ${status}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (head.length > 0) socket.unshift(head);
      const secure = tls.connect({
        socket,
        host,
        ...(isIP(host) ? {} : { servername: options.servername || host }),
        ...(this.#ca ? { ca: this.#ca } : {}),
      });
      callback?.(null, secure);
    });
    request.once('error', fail);
    request.end();
    return undefined;
  }
}
