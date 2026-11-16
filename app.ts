// The HTTP server: routing, auth, body reading, and the request-id header.
// main.ts owns the lifecycle (bind, register, poll /done); this file owns the surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  decodePktLines,
  type GitPacket,
} from './gitwire.ts';
import {
  handleFetchV0,
  handleFetchV2,
  handleInfoRefs,
  handleLsRefs,
  handleReceivePack,
  type GitResponse,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match === null ? null : match[1];
}

function authorized(req: IncomingMessage): boolean {
  const token = bearerOf(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function decodeSegments(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Read the whole request body (null when there is none). Rejects over the size cap. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(chunks.length === 0 ? null : Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res: ServerResponse, store: Store, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const all: Record<string, string> = {
    'x-github-request-id': `req-${++store.requestSeq}`,
    ...headers,
  };
  if (body !== null) {
    all['content-type'] = JSON_TYPE;
    all['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, all);
  res.end(text);
}

function sendBuffer(res: ServerResponse, store: Store, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'x-github-request-id': `req-${++store.requestSeq}`,
    'content-type': contentType,
    'content-length': String(body.length),
  });
  res.end(body);
}

function sendGit(res: ServerResponse, store: Store, answer: GitResponse): void {
  sendBuffer(res, store, answer.status, answer.contentType, answer.body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const { path, query } = parseUrl(req);
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No token.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, store, 200, { ok: true });
          return;
        }

        // The GitHub API root (public, as the starter answers it).
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, store, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const tail = gitMatch[3] ?? '';
          if (method === 'GET' && tail === 'info/refs') {
            sendGit(res, store, handleInfoRefs(store, owner, repoName, query.get('service') ?? '', req.headers['git-protocol'] ?? null));
            return;
          }
          if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
            const body = await readBody(req);
            if (body === null) {
              sendJson(res, store, 400, { message: 'empty request body' });
              return;
            }
            if (tail === 'git-receive-pack') {
              sendGit(res, store, handleReceivePack(store, owner, repoName, body));
              return;
            }
            // git-upload-pack: v2 ls-refs / fetch when Git-Protocol: version=2, else v0 fetch.
            const protocol = req.headers['git-protocol'] ?? null;
            if (protocol === 'version=2') {
              const packets = decodePktLines(body);
              const first = packets.find((p: GitPacket) => p.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
              if (first.startsWith('command=ls-refs')) {
                sendGit(res, store, handleLsRefs(store, owner, repoName, body));
                return;
              }
              if (first.startsWith('command=fetch')) {
                sendGit(res, store, handleFetchV2(store, owner, repoName, body));
                return;
              }
              sendJson(res, store, 400, { message: `unknown v2 command ${JSON.stringify(first)}` });
              return;
            }
            sendGit(res, store, handleFetchV0(store, owner, repoName, body));
            return;
          }
          sendJson(res, store, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, store, 404, { message: 'Not Found' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, store, 401, { message: 'Unauthorized' });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown = null;
          try {
            parsed = body === null ? null : (JSON.parse(body.toString('utf8')) as unknown);
          } catch {
            sendJson(res, store, 400, { errors: [{ message: 'Parse error' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              if (entry === null || typeof entry !== 'object' || typeof (entry as { query?: unknown }).query !== 'string') {
                return { data: null, errors: [{ message: 'a batched entry needs a query string' }] };
              }
              const variables = (entry as { variables?: unknown }).variables;
              return executeGraphQL(store, (entry as { query: string }).query, isRecord(variables) ? variables : {});
            });
            sendJson(res, store, 200, results);
            return;
          }
          if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { query?: unknown }).query !== 'string') {
            sendJson(res, store, 400, { errors: [{ message: 'a GraphQL body needs a query string' }] });
            return;
          }
          const variables = (parsed as { variables?: unknown }).variables;
          sendJson(res, store, 200, executeGraphQL(store, (parsed as { query: string }).query, isRecord(variables) ? variables : {}));
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, store, 202, null);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, store, 404, { message: 'Not Found' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, store, 401, { message: 'Unauthorized' });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown = 'bad-json';
          try {
            parsed = body === null ? null : (JSON.parse(body.toString('utf8')) as unknown);
          } catch {
            parsed = 'bad-json';
          }
          const answer = handleMcp(store, parsed);
          if (answer.body === null) {
            sendJson(res, store, answer.status, null);
            return;
          }
          sendJson(res, store, answer.status, answer.body);
          return;
        }

        // REST v3 (meta is public; everything else needs the token).
        if (path === '/api/v3/meta' || path.startsWith('/api/v3/')) {
          if (path !== '/api/v3/meta' && !authorized(req)) {
            sendJson(res, store, 401, { message: 'Unauthorized' });
            return;
          }
          const segments = decodeSegments(path.slice('/api/v3'.length));
          const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
          const answer = handleRest(method, segments, query, body, originOf(req), store);
          if (answer.status === 204) {
            res.writeHead(204, { 'x-github-request-id': `req-${++store.requestSeq}` });
            res.end();
            return;
          }
          sendJson(res, store, answer.status, answer.body, answer.headers ?? {});
          return;
        }

        // Everything else: a JSON 404.
        sendJson(res, store, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, store, 500, { message: (err as Error).message });
        } else {
          res.end();
        }
      }
    })();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
