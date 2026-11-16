// The forge's store: git objects, refs, repos, issues, pull requests, labels, comments.
// One in-memory store; no wall clock, no randomness anywhere in it, so two runs on the
// same request sequence hold byte-identical state.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** Fixed epoch (2026-01-01T00:00:00Z) for every commit the server itself writes. */
export const FIXED_EPOCH = 1767225600;
export const FIXED_DATE = '2026-01-01T00:00:00Z';
/** The empty tree's id, a git constant. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** git's tree-entry sort: byte order, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const author = fields.author ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const committer = fields.committer ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${timestamp} +0000`, `committer ${committer} ${timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const tagger = fields.tagger ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger} ${timestamp} +0000\n\n${fields.message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots`. Throws on a missing object. */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------------

export interface CommentRecord {
  id: number;
  body: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: CommentRecord[];
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface RepoRecord {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  nextIssue: number;
  nextPull: number;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, RepoRecord>();
  nextRepoId = 10000;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  nextLabelId = 1;
  nextSeq = 1;
  requestSeq = 0;

  // -- objects ---------------------------------------------------------------

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  // -- repos -----------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, description: string, priv: boolean): RepoRecord {
    const repo: RepoRecord = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: priv,
      defaultBranch: 'main',
      createdSeq: this.nextSeq,
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** All of the viewer's repositories, in creation order. */
  viewerRepos(): RepoRecord[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER_LOGIN)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -- refs and commits ------------------------------------------------------

  refTip(repo: RepoRecord, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The best common ancestor of two commits (BFS from both sides), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (depth-first pre-order). */
  commitList(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') return;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) visit(parent);
    };
    visit(tip);
    return out;
  }

  // -- trees -----------------------------------------------------------------

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path -> blob oid map. */
  buildTreeFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Read one path out of a tree: file, directory listing, or null. */
  readTreePath(
    treeOid: string,
    path: string,
  ): { kind: 'file'; oid: string; size: number } | { kind: 'dir'; entries: TreeEntry[] } | null {
    if (path === '' || path === '/') {
      const object = this.objects.get(treeOid);
      if (!object || object.type !== 'tree') return null;
      return { kind: 'dir', entries: parseTree(object.data) };
    }
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const dir = this.objects.get(entry.oid);
          if (!dir || dir.type !== 'tree') return null;
          return { kind: 'dir', entries: parseTree(dir.data) };
        }
        const blob = this.objects.get(entry.oid);
        if (!blob) return null;
        return { kind: 'file', oid: entry.oid, size: blob.data.length };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  // -- contents commits ------------------------------------------------------

  /**
   * Commit one file change on `branch` (create the branch from the default tip when it
   * does not exist yet, create the default branch when the repo is unborn).
   * `content` null deletes the file. Returns the new commit sha and the blob sha (null on delete).
   */
  commitFile(
    repo: RepoRecord,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined && branch !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip !== undefined) repo.refs.set(ref, tip);
    }
    let flat = new Map<string, { oid: string; mode: string }>();
    const parents: string[] = [];
    if (tip !== undefined) {
      const commit = this.objects.get(tip);
      if (!commit || commit.type !== 'commit') throw new Error('branch tip is not a commit');
      flat = this.flattenTree(parseCommit(commit.data).tree);
      parents.push(tip);
    }
    let blobSha: string | null = null;
    if (content === null) {
      flat.delete(path);
    } else {
      blobSha = this.putObject('blob', content);
      flat.set(path, { oid: blobSha, mode: '100644' });
    }
    const treeOid = this.buildTreeFromFlat(flat);
    const commitData = buildCommit({ tree: treeOid, parents, message });
    const commitSha = this.putObject('commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha };
  }

  // -- diff and merge --------------------------------------------------------

  diffTrees(baseTree: string, headTree: string): FileDiff[] {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: FileDiff[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const old = this.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const counts = lineDiffCounts(old, Buffer.alloc(0));
        out.push({ filename: path, status: 'removed', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      } else if (!b && h) {
        const next = this.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const counts = lineDiffCounts(Buffer.alloc(0), next);
        out.push({ filename: path, status: 'added', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      } else if (b && h && b.oid !== h.oid) {
        const old = this.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const next = this.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const counts = lineDiffCounts(old, next);
        out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      }
    }
    return out;
  }

  /**
   * Three-way merge of base/head trees. Returns the merged tree oid, or conflict:true.
   * `baseTip` is the merge base commit, `oursTip` the base branch tip, `theirsTip` the head tip.
   */
  threeWayMerge(baseTip: string, oursTip: string, theirsTip: string): { conflict: boolean; treeOid?: string } {
    const baseTree = parseCommit(this.objects.get(baseTip)!.data).tree;
    const oursTree = parseCommit(this.objects.get(oursTip)!.data).tree;
    const theirsTree = parseCommit(this.objects.get(theirsTip)!.data).tree;
    const base = this.flattenTree(baseTree);
    const ours = this.flattenTree(oursTree);
    const theirs = this.flattenTree(theirsTree);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const oOid = o?.oid ?? null;
      const tOid = t?.oid ?? null;
      const bOid = b?.oid ?? null;
      if (oOid === tOid) {
        if (o) merged.set(path, o);
      } else if (oOid === bOid) {
        if (t) merged.set(path, t);
      } else if (tOid === bOid) {
        if (o) merged.set(path, o);
      } else {
        return { conflict: true };
      }
    }
    return { conflict: false, treeOid: this.buildTreeFromFlat(merged) };
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha or a conflict. */
  squashMerge(pr: PullRecord, repo: RepoRecord): { conflict: boolean; sha?: string } {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (baseTip === undefined || headTip === undefined) return { conflict: true };
    const base = this.mergeBase(baseTip, headTip);
    if (base === null) return { conflict: true };
    const merged = this.threeWayMerge(base, baseTip, headTip);
    if (merged.conflict || merged.treeOid === undefined) return { conflict: true };
    const commitData = buildCommit({ tree: merged.treeOid, parents: [baseTip], message: pr.title });
    const sha = this.putObject('commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_DATE;
    pr.mergeCommitSha = sha;
    return { conflict: false, sha };
  }

  /** Whether an open pull request would merge cleanly (dry run, no state change). */
  mergeable(pr: PullRecord, repo: RepoRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.state !== 'open') return 'UNKNOWN';
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
    const base = this.mergeBase(baseTip, headTip);
    if (base === null) return 'UNKNOWN';
    // Dry run: compute the merge on a scratch copy of the flat maps without storing.
    const baseTree = parseCommit(this.objects.get(base)!.data).tree;
    const oursTree = parseCommit(this.objects.get(baseTip)!.data).tree;
    const theirsTree = parseCommit(this.objects.get(headTip)!.data).tree;
    const b = this.flattenTree(baseTree);
    const o = this.flattenTree(oursTree);
    const t = this.flattenTree(theirsTree);
    const paths = new Set([...b.keys(), ...o.keys(), ...t.keys()]);
    for (const path of paths) {
      const bOid = b.get(path)?.oid ?? null;
      const oOid = o.get(path)?.oid ?? null;
      const tOid = t.get(path)?.oid ?? null;
      if (oOid === tOid) continue;
      if (oOid === bOid) continue;
      if (tOid === bOid) continue;
      return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
}

/** Line counts of a two-way diff (LCS on lines; small files only, with a safe fallback). */
export function lineDiffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const splitLines = (data: Buffer): string[] => {
    if (data.length === 0) return [];
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = splitLines(oldData);
  const b = splitLines(newData);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    // Too big for LCS: fall back to a set-based estimate (still exact when one side is a subset).
    const setA = new Set(a);
    const setB = new Set(b);
    let additions = 0;
    for (const line of b) if (!setA.has(line)) additions += 1;
    let deletions = 0;
    for (const line of a) if (!setB.has(line)) deletions += 1;
    return { additions, deletions };
  }
  // LCS dynamic programming, two rows.
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[b.length];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}
