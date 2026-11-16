// MCP endpoint (POST /mcp, JSON-RPC 2.0 over Streamable HTTP, modern 2026-07-28 era
// with a legacy initialize fallback). Tools act on the same store as REST.

import { VIEWER_LOGIN, type RepoRecord, type Store } from './store.ts';
import { createIssueOnRepo, createPullOnRepo, issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

/** The tool list, built once from a constant so two tools/list answers are byte-identical. */
export const MCP_TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Repository name' }),
        description: Object.freeze({ type: 'string', description: 'Repository description' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private' }),
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
        title: Object.freeze({ type: 'string', description: 'Issue title' }),
        body: Object.freeze({ type: 'string', description: 'Issue body' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed, or all' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
        title: Object.freeze({ type: 'string', description: 'Pull request title' }),
        body: Object.freeze({ type: 'string', description: 'Pull request body' }),
        head: Object.freeze({ type: 'string', description: 'Head branch name' }),
        base: Object.freeze({ type: 'string', description: 'Base branch name' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
        pull_number: Object.freeze({ type: 'number', description: 'Pull request number' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
      additionalProperties: false,
    }),
  }),
]);

export interface McpResponse {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function requiredArgs(args: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

function resolveRepo(store: Store, args: Record<string, unknown>): RepoRecord | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repo === '') return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const missing = requiredArgs(args, ['name']);
      if (missing !== null) return toolError(`missing required argument: ${missing}`);
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`Repository ${repoName} already exists`);
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const missing = requiredArgs(args, ['owner', 'repo']);
      if (missing !== null) return toolError(`missing required argument: ${missing}`);
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const missing = requiredArgs(args, ['owner', 'repo', 'title']);
      if (missing !== null) return toolError(`missing required argument: ${missing}`);
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      try {
        const issue = createIssueOnRepo(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '');
        return toolResult(issueJson(issue, repo));
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
    case 'list_issues': {
      const missing = requiredArgs(args, ['owner', 'repo']);
      if (missing !== null) return toolError(`missing required argument: ${missing}`);
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const items = list.map((issue) => issueJson(issue, repo));
      return toolResult(items);
    }
    case 'create_pull_request': {
      const missing = requiredArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing !== null) return toolError(`missing required argument: ${missing}`);
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      try {
        const pull = createPullOnRepo(store, repo, String(args.head), String(args.base), String(args.title), typeof args.body === 'string' ? args.body : '');
        return toolResult(pullJson(pull, repo));
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
    case 'merge_pull_request': {
      const missing = requiredArgs(args, ['owner', 'repo', 'pull_number']);
      if (missing !== null) return toolError(`missing required argument: ${missing}`);
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return toolError(`pull request #${String(args.pull_number)} not found`);
      if (pull.state !== 'open') return toolError(`pull request #${number} is not open`);
      const merged = store.squashMerge(pull, repo);
      if (merged.conflict || merged.sha === undefined) return toolError('merge conflict');
      return toolResult({ ...pullJson(pull, repo), sha: merged.sha, merged: true });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

/** Handle one JSON-RPC request object. Returns null for a notification (no reply). */
function handleOne(store: Store, request: unknown): McpResponse | null {
  if (!isRecord(request)) return rpcError(null, -32600, 'Invalid Request');
  const id = request.id === undefined ? undefined : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) is answered by the transport, not by a JSON-RPC body.
  if (id === undefined) return null;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: serverInfo() });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (name === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    if (!MCP_TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `unknown tool ${name}`);
    return rpcResult(id, callTool(store, name, args));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle a POST /mcp body. `parsed` is the JSON value, or the sentinel 'bad-json'
 * when the body did not parse (HTTP 400, JSON-RPC -32700).
 */
export function handleMcp(store: Store, parsed: unknown): McpResponse {
  if (parsed === 'bad-json') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const item of parsed) {
      const answer = handleOne(store, item);
      if (answer !== null) responses.push(answer.body);
    }
    return { status: 200, body: responses };
  }
  const answer = handleOne(store, parsed);
  if (answer === null) return { status: 202, body: null };
  return answer;
}
