import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { assertLoopbackBind } from './security.js';

const dbFile = process.env.JCI_DB ?? resolve(import.meta.dirname, '../../workspace/jci.db');
const port = Number(process.env.JCI_PORT ?? 4317);
// Local developer tool without authentication: bind to loopback only (JCI_HOST may pick another loopback address).
const host = process.env.JCI_HOST ?? '127.0.0.1';
assertLoopbackBind(host);
// Extra browser origins (comma-separated, e.g. http://localhost:4173) besides this port and the Vite dev server.
const allowedOrigins = (process.env.JCI_ALLOWED_ORIGINS ?? '').split(',').filter((s) => s.trim());

const app = buildApp(openDb(dbFile), { logger: true, security: { port, allowedOrigins } });
await app.listen({ host, port });
