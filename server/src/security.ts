import type { FastifyInstance } from 'fastify';

/**
 * Request guard for the loopback API. The server has no authentication (single-user local tool), so the browser is the
 * attack surface: a page on another site may reach 127.0.0.1 through DNS rebinding (forged Host) or send cross-origin
 * requests (Origin). Every request is checked in `onRequest`, before routing, so new routes are covered automatically.
 */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;
const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** Vite dev server (web/vite.config.ts); its proxy forwards the browser's Host and Origin unchanged. */
export const VITE_DEV_PORT = 5173;

/** Hostname of a Host header, lower-cased, brackets kept for IPv6; undefined when absent or malformed. */
export function parseHostHeader(host: string | undefined): string | undefined {
  const h = host?.trim().toLowerCase();
  if (!h) return undefined;
  const m = h.startsWith('[') ? /^(\[[0-9a-f:.]+\])(?::\d{1,5})?$/.exec(h) : /^([^:]+)(?::\d{1,5})?$/.exec(h);
  return m?.[1];
}

/** Exact origins (scheme://host:port) a browser page may call the API from. */
export function allowedOrigins(opts: { port?: number; extra?: string[] } = {}): Set<string> {
  const ports = [...new Set([opts.port ?? 4317, VITE_DEV_PORT])];
  const out = new Set(LOOPBACK_HOSTS.flatMap((h) => ports.map((p) => `http://${h}:${p}`)));
  for (const o of opts.extra ?? []) if (o.trim()) out.add(o.trim().toLowerCase().replace(/\/+$/, ''));
  return out;
}

export interface GuardOptions { port?: number; allowedOrigins?: string[] }

export function installRequestGuard(app: FastifyInstance, opts: GuardOptions = {}): void {
  const hosts = new Set<string>(LOOPBACK_HOSTS);
  const origins = allowedOrigins({ port: opts.port, extra: opts.allowedOrigins });
  app.addHook('onRequest', async (req, reply) => {
    const deny = (code: number, error: string, header: string) => {
      req.log.warn({ url: req.url.split('?')[0], header }, 'request rejected');
      return reply.code(code).send({ error });
    };
    const host = parseHostHeader(req.headers.host);
    if (!host || !hosts.has(host)) return deny(403, 'Forbidden host: the API only answers loopback requests', 'host');
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return deny(403, 'Forbidden origin: add it to JCI_ALLOWED_ORIGINS to allow it', 'origin');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return deny(403, 'Forbidden cross-site request', 'sec-fetch-site');
    // text/plain and form bodies are CORS "simple requests" (no preflight); only JSON is accepted.
    if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return deny(415, 'POST bodies must be application/json', 'content-type');
    }
  });
}

/** The server must never listen beyond loopback: it has no authentication. */
export function assertLoopbackBind(host: string): void {
  if (!LOOPBACK_BIND.has(host.trim().toLowerCase())) {
    throw new Error(`Refusing to listen on ${host}: the API has no authentication and binds to loopback only (127.0.0.1, ::1)`);
  }
}
