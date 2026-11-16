// GraphQL v4 surface: a hand-written recursive-descent parser for the fixed documents
// the suite sends, plus resolvers over the same store as REST. Supports variables,
// inline enum lists, inline input objects, null variables, operation names, aliases,
// inline fragments, and batched bodies (handled by app.ts).

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  parseCommit,
  type PullRecord,
  type RepoRecord,
  type Store,
} from './store.ts';
import { createIssueOnRepo, createPullOnRepo } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// global ids (opaque, stable): base64 of a typed key
// ---------------------------------------------------------------------------------------------

export function gid(kind: 'R' | 'I' | 'P' | 'C', ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || !['R', 'I', 'P', 'C'].includes(kind)) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$&|@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser (AST)
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): OperationNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '{') {
      return { type: 'query', name: null, selections: this.parseSelections() };
    }
    const typeToken = this.next();
    if (typeToken.kind !== 'name' || (typeToken.value !== 'query' && typeToken.value !== 'mutation')) {
      throw new Error(`expected query or mutation, got ${JSON.stringify(typeToken)}`);
    }
    const type = typeToken.value as 'query' | 'mutation';
    let name: string | null = null;
    const next = this.peek();
    if (next?.kind === 'name') name = this.next().value;
    // Variable definitions: ($x: Type!, $y: Type = default)
    if (this.matchPunct('(')) {
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.kind === 'punct' && t.value === '(') depth += 1;
        else if (t.kind === 'punct' && t.value === ')') depth -= 1;
      }
    }
    return { type, name, selections: this.parseSelections() };
  }

  parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.pos += 1;
        return selections;
      }
      if (token.kind === 'spread') {
        this.pos += 1;
        let typeCondition: string | null = null;
        const on = this.peek();
        if (on?.kind === 'name' && on.value === 'on') {
          this.pos += 1;
          typeCondition = this.expectName();
        }
        // Directives after a fragment spread: skip @name(args).
        this.skipDirectives();
        selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelections() });
        continue;
      }
      selections.push(this.parseField());
    }
  }

  skipDirectives(): void {
    for (;;) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '@') {
        this.pos += 1;
        this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
          this.pos += 1;
          let depth = 1;
          while (depth > 0) {
            const t = this.next();
            if (t.kind === 'punct' && t.value === '(') depth += 1;
            else if (t.kind === 'punct' && t.value === ')') depth -= 1;
          }
        }
        continue;
      }
      return;
    }
  }

  parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.matchPunct('(')) {
      for (;;) {
        const token = this.peek();
        if (token?.kind === 'punct' && token.value === ')') {
          this.pos += 1;
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelections();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        const t = this.peek();
        if (t?.kind === 'punct' && t.value === ']') {
          this.pos += 1;
          return { kind: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const t = this.peek();
        if (t?.kind === 'punct' && t.value === '}') {
          this.pos += 1;
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// values (resolved entities carry their type tag)
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | null
  | string
  | number
  | boolean
  | GqlObject
  | GqlValue[];

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function repoValue(repo: RepoRecord): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: RepoRecord, issue: { id: number; number: number; title: string; body: string; state: string }): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: RepoRecord, pull: PullRecord): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

// ---------------------------------------------------------------------------------------------
// introspection schema (static)
// ---------------------------------------------------------------------------------------------

const SCHEMA_TYPES: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'author', 'url', 'createdAt', 'updatedAt', 'comments', 'labels'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'url', 'createdAt', 'mergedAt', 'mergeCommit'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'REGISTRY', 'PROJECT', 'MILESTONE'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

class Executor {
  private errors: Array<{ message: string }> = [];
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  execute(document: string, variables: Record<string, unknown>): GraphQLResult {
    this.errors = [];
    let operation: OperationNode;
    try {
      operation = new Parser(tokenize(document)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
    const root: GqlObject = operation.type === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
    const data = this.executeSelections(root, operation.selections, variables);
    const result: GraphQLResult = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  private executeSelections(parent: GqlObject, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
        Object.assign(out, this.executeSelections(parent, selection.selections, variables));
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, variables);
      const value = this.resolveField(parent, selection.name, args);
      const key = selection.alias ?? selection.name;
      if (value === null || value === undefined) {
        out[key] = null;
        continue;
      }
      if (selection.selections !== null && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = this.executeSelections(value as GqlObject, selection.selections, variables);
      } else if (selection.selections !== null && Array.isArray(value)) {
        out[key] = value.map((item) =>
          item !== null && typeof item === 'object' ? this.executeSelections(item as GqlObject, selection.selections!, variables) : item,
        );
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private unknownField(parent: GqlObject, name: string): null {
    this.errors.push({ message: `Cannot query field "${name}" on type "${parent.__typename}".` });
    return null;
  }

  private resolveField(parent: GqlObject, name: string, args: Record<string, unknown>): GqlValue {
    switch (parent.__typename) {
      case 'Query':
        return this.resolveQuery(parent, name, args);
      case 'Mutation':
        return this.resolveMutation(parent, name, args);
      case 'User':
        if (name === 'login') return VIEWER_LOGIN;
        if (name === 'id') return String(VIEWER_ID);
        if (name === 'name') return VIEWER_NAME;
        if (name === 'email') return VIEWER_EMAIL;
        return this.unknownField(parent, name);
      case 'Repository':
        return this.resolveRepository(parent, name, args);
      case 'Ref':
        if (name === 'name') return String(parent.name);
        return this.unknownField(parent, name);
      case 'Issue':
        return this.resolveIssue(parent, name);
      case 'IssueConnection': {
        if (name === 'nodes') return (parent.nodes as GqlValue[]) ?? [];
        if (name === 'pageInfo') return parent.pageInfo as GqlObject;
        return this.unknownField(parent, name);
      }
      case 'PageInfo':
        if (name === 'hasNextPage') return Boolean(parent.hasNextPage);
        if (name === 'endCursor') return (parent.endCursor as string | null) ?? null;
        return this.unknownField(parent, name);
      case 'PullRequest':
        return this.resolvePullRequest(parent, name, args);
      case 'PullRequestConnection':
        if (name === 'nodes') return (parent.nodes as GqlValue[]) ?? [];
        return this.unknownField(parent, name);
      case 'PullRequestChangedFileConnection':
        if (name === 'nodes') return (parent.nodes as GqlValue[]) ?? [];
        return this.unknownField(parent, name);
      case 'PullRequestChangedFile':
        if (name === 'path') return String(parent.path);
        return this.unknownField(parent, name);
      case '__Type':
        return this.resolveType(parent, name);
      case '__Field':
        if (name === 'name') return String(parent.name);
        return this.unknownField(parent, name);
      case '__EnumValue':
        if (name === 'name') return String(parent.name);
        return this.unknownField(parent, name);
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
        if (name === 'issue') return parent.issue as GqlObject;
        return this.unknownField(parent, name);
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
        if (name === 'pullRequest') return parent.pullRequest as GqlObject;
        return this.unknownField(parent, name);
      case 'AddCommentPayload':
        if (name === 'commentEdge') return parent.commentEdge as GqlObject;
        return this.unknownField(parent, name);
      case 'CommentEdge':
        if (name === 'node') return parent.node as GqlObject;
        return this.unknownField(parent, name);
      case 'IssueComment':
        if (name === 'id') return String(parent.id);
        if (name === 'body') return String(parent.body);
        return this.unknownField(parent, name);
      default:
        return this.unknownField(parent, name);
    }
  }

  private resolveQuery(_parent: GqlObject, name: string, args: Record<string, unknown>): GqlValue {
    if (name === 'viewer') {
      return { __typename: 'User' };
    }
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = this.store.getRepo(owner, repoName);
      return repo === undefined ? null : repoValue(repo);
    }
    if (name === 'node') {
      const parsed = typeof args.id === 'string' ? parseGid(args.id) : null;
      if (parsed === null) return null;
      if (parsed.kind === 'R') {
        const [fullName] = parsed.parts;
        if (fullName === undefined) return null;
        const slash = fullName.indexOf('/');
        const repo = this.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
        return repo === undefined ? null : repoValue(repo);
      }
      if (parsed.kind === 'I') {
        const [fullName, num] = parsed.parts;
        if (fullName === undefined || num === undefined) return null;
        const slash = fullName.indexOf('/');
        const repo = this.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
        const issue = repo?.issues.find((i) => i.number === Number.parseInt(num, 10));
        return repo !== undefined && issue !== undefined ? issueValue(repo, issue) : null;
      }
      if (parsed.kind === 'P') {
        const [fullName, num] = parsed.parts;
        if (fullName === undefined || num === undefined) return null;
        const slash = fullName.indexOf('/');
        const repo = this.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
        const pull = repo?.pulls.find((p) => p.number === Number.parseInt(num, 10));
        return repo !== undefined && pull !== undefined ? pullValue(repo, pull) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      const schema = SCHEMA_TYPES[typeName];
      if (schema === undefined) return null;
      return {
        __typename: '__Type',
        name: typeName,
        kind: schema.kind,
        fields: (schema.fields ?? []).map((field) => ({ __typename: '__Field', name: field })),
        enumValues: (schema.enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value })),
      };
    }
    return this.unknownField({ __typename: 'Query' }, name);
  }

  private resolveRepository(parent: GqlObject, name: string, args: Record<string, unknown>): GqlValue {
    const repo = parent.repo as RepoRecord;
    switch (name) {
      case 'id':
        return gid('R', `${repo.owner}/${repo.name}`);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User' };
      case 'defaultBranchRef':
        return { __typename: 'Ref', name: repo.defaultBranch };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.private;
      case 'issue': {
        const number = Number(args.number);
        const issue = repo.issues.find((i) => i.number === number);
        return issue === undefined ? null : issueValue(repo, issue);
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'DESC');
        list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        const first = typeof args.first === 'number' ? args.first : list.length;
        const after = typeof args.after === 'string' && args.after !== '' ? decodeCursor(args.after) : null;
        let start = 0;
        if (after !== null) {
          const index = list.findIndex((issue) => issue.number === after);
          start = index < 0 ? list.length : index + 1;
        }
        const page = list.slice(start, start + first);
        const hasNextPage = start + first < list.length;
        const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
        return {
          __typename: 'IssueConnection',
          nodes: page.map((issue) => issueValue(repo, issue)),
          pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
        };
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
        const open = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => b.seq - a.seq);
        return {
          __typename: 'PullRequestConnection',
          nodes: open.slice(0, first).map((pull) => pullValue(repo, pull)),
        };
      }
      case 'pullRequest': {
        const number = Number(args.number);
        const pull = repo.pulls.find((p) => p.number === number);
        return pull === undefined ? null : pullValue(repo, pull);
      }
      default:
        return this.unknownField(parent, name);
    }
  }

  private resolveIssue(parent: GqlObject, name: string): GqlValue {
    const issue = parent.issue as { id: number; number: number; title: string; body: string; state: string };
    const repo = parent.repo as RepoRecord;
    switch (name) {
      case 'id':
        return gid('I', `${repo.owner}/${repo.name}`, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      default:
        return this.unknownField(parent, name);
    }
  }

  private resolvePullRequest(parent: GqlObject, name: string, args: Record<string, unknown>): GqlValue {
    const pull = parent.pull as PullRecord;
    const repo = parent.repo as RepoRecord;
    switch (name) {
      case 'id':
        return gid('P', `${repo.owner}/${repo.name}`, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        if (pull.state === 'open') return 'OPEN';
        return pull.merged ? 'MERGED' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return this.store.mergeable(pull, repo);
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        if (baseTip === undefined || headTip === undefined) return { __typename: 'PullRequestChangedFileConnection', nodes: [] };
        const mergeBase = this.store.mergeBase(baseTip, headTip) ?? pull.baseSha;
        const baseTree = parseCommit(this.store.getObject(mergeBase)!.data).tree;
        const headTree = parseCommit(this.store.getObject(headTip)!.data).tree;
        const diffs = this.store.diffTrees(baseTree, headTree);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: diffs.slice(0, first).map((diff) => ({ __typename: 'PullRequestChangedFile', path: diff.filename })),
        };
      }
      default:
        return this.unknownField(parent, name);
    }
  }

  private resolveType(parent: GqlObject, name: string): GqlValue {
    if (name === 'name') return String(parent.name);
    if (name === 'kind') return String(parent.kind);
    if (name === 'fields') return (parent.fields as GqlValue[]) ?? [];
    if (name === 'enumValues') return (parent.enumValues as GqlValue[]) ?? [];
    return this.unknownField(parent, name);
  }

  private resolveMutation(_parent: GqlObject, name: string, args: Record<string, unknown>): GqlValue {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = this.repoFromGid(input.repositoryId);
      if (repo === null) {
        this.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const title = String(input.title ?? '');
      const body = typeof input.body === 'string' ? input.body : '';
      try {
        const issue = createIssueOnRepo(this.store, repo, title, body);
        return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
      } catch (err) {
        this.errors.push({ message: (err as Error).message });
        return null;
      }
    }
    if (name === 'closeIssue') {
      const found = this.issueFromGid(input.issueId);
      if (found === null) {
        this.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue) };
    }
    if (name === 'createPullRequest') {
      const repo = this.repoFromGid(input.repositoryId);
      if (repo === null) {
        this.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const title = String(input.title ?? '');
      const body = typeof input.body === 'string' ? input.body : '';
      try {
        const pull = createPullOnRepo(this.store, repo, head, base, title, body);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) };
      } catch (err) {
        // A duplicate open PR: answer the existing one (the REST fixture tolerates a 422 the same way).
        const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (existing !== undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, existing) };
        this.errors.push({ message: (err as Error).message });
        return null;
      }
    }
    if (name === 'mergePullRequest') {
      const found = this.pullFromGid(input.pullRequestId);
      if (found === null) {
        this.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      const { repo, pull } = found;
      if (pull.state !== 'open') {
        return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) };
      }
      const merged = this.store.squashMerge(pull, repo);
      if (merged.conflict) {
        this.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) };
    }
    if (name === 'addComment') {
      const found = this.issueFromGid(input.subjectId);
      if (found === null) {
        this.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const body = String(input.body ?? '');
      const comment = { id: this.store.nextCommentId, body };
      this.store.nextCommentId += 1;
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: {
            __typename: 'IssueComment',
            id: gid('C', `${found.repo.owner}/${found.repo.name}`, found.issue.number, comment.id),
            body,
          },
        },
      };
    }
    return this.unknownField({ __typename: 'Mutation' }, name);
  }

  private repoFromGid(id: unknown): RepoRecord | null {
    const parsed = typeof id === 'string' ? parseGid(id) : null;
    if (parsed === null || parsed.kind !== 'R') return null;
    const fullName = parsed.parts[0];
    if (fullName === undefined) return null;
    const slash = fullName.indexOf('/');
    if (slash < 0) return null;
    return this.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1)) ?? null;
  }

  private issueFromGid(id: unknown): { repo: RepoRecord; issue: { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; comments: Array<{ id: number; body: string }> } } | null {
    const parsed = typeof id === 'string' ? parseGid(id) : null;
    if (parsed === null || parsed.kind !== 'I') return null;
    const [fullName, num] = parsed.parts;
    if (fullName === undefined || num === undefined) return null;
    const slash = fullName.indexOf('/');
    if (slash < 0) return null;
    const repo = this.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
    if (repo === undefined) return null;
    const issue = repo.issues.find((i) => i.number === Number.parseInt(num, 10));
    return issue === undefined ? null : { repo, issue };
  }

  private pullFromGid(id: unknown): { repo: RepoRecord; pull: PullRecord } | null {
    const parsed = typeof id === 'string' ? parseGid(id) : null;
    if (parsed === null || parsed.kind !== 'P') return null;
    const [fullName, num] = parsed.parts;
    if (fullName === undefined || num === undefined) return null;
    const slash = fullName.indexOf('/');
    if (slash < 0) return null;
    const repo = this.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
    if (repo === undefined) return null;
    const pull = repo.pulls.find((p) => p.number === Number.parseInt(num, 10));
    return pull === undefined ? null : { repo, pull };
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Execute one GraphQL operation document. */
export function executeGraphQL(store: Store, document: string, variables: Record<string, unknown>): GraphQLResult {
  return new Executor(store).execute(document, variables);
}
