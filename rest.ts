// GitHub REST v3 surface: repos, branches, commits, contents, labels, issues, pull
// requests. Every reply is JSON; every reply carries X-GitHub-Request-Id (app.ts adds
// it); unknown routes are JSON 404s; malformed JSON bodies are 400s.

import {
  FIXED_DATE,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  isObjectId,
  parseCommit,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
  type Store,
} from './store.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

function parseBody(raw: Buffer | null): { value: unknown; bad: boolean } {
  if (raw === null || raw.length === 0) return { value: undefined, bad: false };
  try {
    return { value: JSON.parse(raw.toString('utf8')) as unknown, bad: false };
  } catch {
    return { value: undefined, bad: true };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pageOf<T>(items: readonly T[], query: URLSearchParams): { page: T[]; hasNext: boolean; perPage: number; pageNum: number } {
  const perPage = Math.min(100, Math.max(1, intParam(query, 'per_page', 30)));
  const pageNum = Math.max(1, intParam(query, 'page', 1));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, perPage, pageNum };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, perPage: number, pageNum: number, hasNext: boolean, total: number): string | null {
  if (!hasNext) return null;
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(pageNum + 1));
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const last = new URLSearchParams(query);
  last.set('per_page', String(perPage));
  last.set('page', String(lastPage));
  return `<${origin}${path}?${next.toString()}>; rel="next", <${origin}${path}?${last.toString()}>; rel="last"`;
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User' };
}

export function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER_ID),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    has_pull_requests: true,
  };
}

function labelJson(label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(issue: IssueRecord, repo: RepoRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    comments: issue.comments.length,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: userJson(VIEWER_LOGIN, VIEWER_ID) };
}

export function pullJson(pull: PullRecord, repo: RepoRecord): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
  };
}

function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

function commitJson(store: Store, sha: string): Record<string, unknown> {
  const object = store.getObject(sha);
  if (!object || object.type !== 'commit') return { sha, commit: { message: '' } };
  const parsed = parseCommit(object.data);
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_DATE };
    const epoch = Number.parseInt(match[3], 10);
    return { name: match[1], email: match[2], date: new Date(epoch * 1000).toISOString() };
  };
  const author = ident(parsed.author);
  const committer = ident(parsed.committer);
  return {
    sha,
    commit: { message: parsed.message, author, committer },
    author: userJson(VIEWER_LOGIN, VIEWER_ID),
    committer: userJson(VIEWER_LOGIN, VIEWER_ID),
  };
}

// ---------------------------------------------------------------------------------------------
// helpers shared with graphql.ts and mcp.ts
// ---------------------------------------------------------------------------------------------

/** Create an issue on a repo (labels must already exist). Throws an Error with a message on failure. */
export function createIssueOnRepo(store: Store, repo: RepoRecord, title: string, body: string, labels: readonly string[] = []): IssueRecord {
  for (const name of labels) {
    if (!repo.labels.has(name)) throw new Error(`Label '${name}' does not exist`);
  }
  const issue: IssueRecord = {
    id: store.nextIssueId,
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [...labels],
    seq: store.nextSeq,
    comments: [],
  };
  store.nextIssueId += 1;
  store.nextSeq += 1;
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request on a repo. Throws on a bad head/base or a duplicate open PR. */
export function createPullOnRepo(
  store: Store,
  repo: RepoRecord,
  head: string,
  base: string,
  title: string,
  body: string,
): PullRecord {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined) throw new Error(`head branch '${head}' does not exist`);
  if (baseTip === undefined) throw new Error(`base branch '${base}' does not exist`);
  const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (duplicate) throw new Error('a pull request from this head branch is already open');
  const pull: PullRecord = {
    id: store.nextPullId,
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    seq: store.nextSeq,
  };
  store.nextPullId += 1;
  store.nextSeq += 1;
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Resolve a ref query (?ref= / ?sha=) to a commit oid: branch name, refs/heads/x, or an oid. */
export function resolveRefToCommit(store: Store, repo: RepoRecord, ref: string | null, fallbackBranch: string): string | undefined {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${fallbackBranch}`);
  if (isObjectId(ref)) {
    const object = store.getObject(ref);
    return object?.type === 'commit' ? ref : undefined;
  }
  if (ref.startsWith('refs/heads/')) return repo.refs.get(ref);
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`);
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  rawBody: Buffer | null,
  origin: string,
  store: Store,
): RestResponse {
  const { value: body, bad } = parseBody(rawBody);
  if (bad) return err(400, 'malformed JSON body');
  const bodyObj = isRecord(body) ? body : {};

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user, POST /api/v3/user/repos, GET /api/v3/user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return ok(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
      });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.viewerRepos();
        const { page, hasNext, perPage, pageNum } = pageOf(repos, query);
        const link = linkHeader(origin, '/api/v3/user/repos', query, perPage, pageNum, hasNext, repos.length);
        return ok(200, page.map(repoJson), link === null ? undefined : { link });
      }
      if (method === 'POST') {
        const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
        if (name === '') return err(422, 'name is required');
        if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, `Repository ${name} already exists`);
        const repo = store.createRepo(
          name,
          typeof bodyObj.description === 'string' ? bodyObj.description : '',
          bodyObj.private === true,
        );
        return ok(201, repoJson(repo));
      }
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const rest = segments.slice(3);
    if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
    const repo = store.getRepo(owner, name);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) return err(404, 'Not Found');
        return ok(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (repo === undefined) return err(404, 'Not Found');
        if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
        if (typeof bodyObj.name === 'string' && bodyObj.name !== '' && bodyObj.name !== repo.name) {
          if (store.getRepo(owner, bodyObj.name) !== undefined) return err(422, `Repository ${bodyObj.name} already exists`);
          store.repos.delete(store.repoKey(owner, repo.name));
          repo.name = bodyObj.name;
          store.repos.set(store.repoKey(owner, repo.name), repo);
        }
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (repo === undefined) return err(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    if (repo === undefined) return err(404, 'Not Found');

    // POST /repos/{o}/{r}/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
      if (method !== 'POST') return err(404, 'Not Found');
      const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
      const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, `invalid ref ${ref}`);
      if (!isObjectId(sha) || store.getObject(sha) === undefined) return err(422, `unknown sha ${sha}`);
      if (repo.refs.has(ref)) return err(422, `ref ${ref} already exists`);
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha, type: store.getObject(sha)?.type ?? 'commit' } });
    }
    // GET /repos/{o}/{r}/git/refs/heads/{branch...}
    if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length >= 4) {
      if (method !== 'GET') return err(404, 'Not Found');
      const branch = rest.slice(3).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    // GET /repos/{o}/{r}/branches
    if (rest[0] === 'branches' && rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => branchJson(ref.slice('refs/heads/'.length), sha))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return ok(200, branches);
    }
    // GET /repos/{o}/{r}/branches/{branch...}
    if (rest[0] === 'branches' && rest.length >= 2) {
      if (method !== 'GET') return err(404, 'Not Found');
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, branchJson(branch, sha));
    }
    // GET /repos/{o}/{r}/commits
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const tip = resolveRefToCommit(store, repo, query.get('sha'), repo.defaultBranch);
      if (tip === undefined) return ok(200, []);
      return ok(200, store.commitList(tip).map((sha) => commitJson(store, sha)));
    }
    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRefToCommit(store, repo, query.get('ref'), repo.defaultBranch);
        if (tip === undefined) return err(404, 'Not Found');
        const commit = store.getObject(tip);
        if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
        const found = store.readTreePath(parseCommit(commit.data).tree, path);
        if (found === null) return err(404, 'Not Found');
        if (found.kind === 'file') {
          const blob = store.getObject(found.oid)!;
          const name = path.split('/').pop() ?? path;
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: found.size,
            name,
            path,
            sha: found.oid,
            content: blob.data.toString('base64'),
          });
        }
        const entries = found.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (store.getObject(entry.oid)?.data.length ?? 0),
        }));
        return ok(200, entries);
      }
      if (method === 'PUT') {
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : '';
        const contentB64 = typeof bodyObj.content === 'string' ? bodyObj.content : '';
        if (contentB64 === '') return err(422, 'content is required');
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        let existed = false;
        let currentSha: string | undefined;
        if (tip !== undefined) {
          const commit = store.getObject(tip);
          if (commit && commit.type === 'commit') {
            const found = store.readTreePath(parseCommit(commit.data).tree, path);
            if (found !== null && found.kind === 'file') {
              existed = true;
              currentSha = found.oid;
            }
          }
        }
        if (existed) {
          const given = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
          if (given === '' || given.toLowerCase() !== (currentSha ?? '').toLowerCase()) {
            return err(409, 'the blob sha does not match the current file (stale sha)');
          }
        }
        const result = store.commitFile(repo, branch, path, content, message);
        const name = path.split('/').pop() ?? path;
        return ok(existed ? 200 : 201, {
          content: { name, path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const branch = repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        const commit = store.getObject(tip);
        if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
        const found = store.readTreePath(parseCommit(commit.data).tree, path);
        if (found === null || found.kind !== 'file') return err(404, 'Not Found');
        const given = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
        if (given !== '' && given.toLowerCase() !== found.oid.toLowerCase()) return err(409, 'the blob sha does not match the current file (stale sha)');
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : '';
        const result = store.commitFile(repo, branch, path, null, message);
        return ok(200, { content: null, commit: { sha: result.commitSha, message } });
      }
      return err(404, 'Not Found');
    }
    // labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method !== 'POST') return err(404, 'Not Found');
      const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
      if (name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing) return ok(201, labelJson(existing));
      const label = {
        id: store.nextLabelId,
        name,
        color: typeof bodyObj.color === 'string' ? bodyObj.color : 'ededed',
        description: typeof bodyObj.description === 'string' ? bodyObj.description : '',
      };
      store.nextLabelId += 1;
      repo.labels.set(name, label);
      return ok(201, labelJson(label));
    }
    // issues
    if (rest[0] === 'issues' && rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        if (sort === 'created') {
          list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page } = pageOf(list, query);
        return ok(200, page.map((issue) => issueJson(issue, repo)));
      }
      if (method === 'POST') {
        const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
        const bodyText = typeof bodyObj.body === 'string' ? bodyObj.body : '';
        const labels = Array.isArray(bodyObj.labels) ? bodyObj.labels.filter((l): l is string => typeof l === 'string') : [];
        if (title === '') return err(422, 'title is required');
        try {
          const issue = createIssueOnRepo(store, repo, title, bodyText, labels);
          return ok(201, issueJson(issue, repo));
        } catch (e) {
          return err(422, (e as Error).message);
        }
      }
      return err(404, 'Not Found');
    }
    // issues/{n} and issues/{n}/comments
    if (rest[0] === 'issues' && rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, issueJson(issue, repo));
        if (method === 'PATCH') {
          if (typeof bodyObj.state === 'string' && (bodyObj.state === 'open' || bodyObj.state === 'closed')) issue.state = bodyObj.state;
          if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
          if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
          return ok(200, issueJson(issue, repo));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments' && rest.length === 3) {
        if (method === 'GET') return ok(200, issue.comments.map(commentJson));
        if (method === 'POST') {
          const text = typeof bodyObj.body === 'string' ? bodyObj.body : '';
          if (text === '') return err(422, 'body is required');
          const comment = { id: store.nextCommentId, body: text };
          store.nextCommentId += 1;
          issue.comments.push(comment);
          return ok(201, commentJson(comment));
        }
      }
      return err(404, 'Not Found');
    }
    // pulls
    if (rest[0] === 'pulls' && rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        const { page } = pageOf(list, query);
        return ok(200, page.map((pull) => pullJson(pull, repo)));
      }
      if (method === 'POST') {
        const head = typeof bodyObj.head === 'string' ? bodyObj.head : '';
        const base = typeof bodyObj.base === 'string' && bodyObj.base !== '' ? bodyObj.base : repo.defaultBranch;
        const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
        const bodyText = typeof bodyObj.body === 'string' ? bodyObj.body : '';
        if (head === '' || title === '') return err(422, 'head and title are required');
        try {
          const pull = createPullOnRepo(store, repo, head, base, title, bodyText);
          return ok(201, pullJson(pull, repo));
        } catch (e) {
          return err(422, (e as Error).message);
        }
      }
      return err(404, 'Not Found');
    }
    // pulls/{n}, pulls/{n}/files, pulls/{n}/merge
    if (rest[0] === 'pulls' && rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (rest.length === 2) {
        if (method !== 'GET') return err(404, 'Not Found');
        if (pull === undefined) return err(404, 'Not Found');
        return ok(200, pullJson(pull, repo));
      }
      if (rest[2] === 'files' && rest.length === 3) {
        if (method !== 'GET') return err(404, 'Not Found');
        if (pull === undefined) return err(404, 'Not Found');
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        if (baseTip === undefined || headTip === undefined) return err(404, 'Not Found');
        const mergeBase = store.mergeBase(baseTip, headTip) ?? pull.baseSha;
        const baseTree = parseCommit(store.getObject(mergeBase)!.data).tree;
        const headTree = parseCommit(store.getObject(headTip)!.data).tree;
        return ok(200, store.diffTrees(baseTree, headTree));
      }
      if (rest[2] === 'merge' && rest.length === 3) {
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull === undefined) return err(404, 'Not Found');
        if (pull.state !== 'open') return err(405, 'Pull request is not open');
        const merged = store.squashMerge(pull, repo);
        if (merged.conflict || merged.sha === undefined) return err(405, 'Merge conflict');
        return ok(200, { sha: merged.sha, merged: true, message: pull.title });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
