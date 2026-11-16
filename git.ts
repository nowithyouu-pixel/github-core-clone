// Git smart-HTTP surface: info/refs advertisements (v0 and v2), v2 ls-refs and fetch,
// v0 fetch, and v0 receive-pack (push). All object ids are SHA-1; packs carry whole
// objects only (no deltas), which the client accepts.

import {
  ZERO_OID,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type RepoRecord,
  type Store,
} from './store.ts';
import {
  computeFetch,
  decodePktLines,
  encodePktLine,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  type GitPacket,
} from './gitwire.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonResponse(status: number, body: unknown): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main agent=github-core-clone/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0';

/** All refs of a repo, sorted by name. */
function sortedRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The tip HEAD points at (main, else the first branch), or undefined when the repo is unborn. */
function headTip(repo: RepoRecord): string | undefined {
  const main = repo.refs.get('refs/heads/main');
  if (main !== undefined) return main;
  const branches = sortedRefs(repo).filter((ref) => ref.name.startsWith('refs/heads/'));
  return branches[0]?.oid;
}

/** The peeled commit of an annotated tag object, or undefined. */
function peeledOf(store: Store, oid: string): string | undefined {
  const object = store.getObject(oid);
  if (!object || object.type !== 'tag') return undefined;
  let target = parseTag(object.data).object;
  for (let i = 0; i < 8; i += 1) {
    const next = store.getObject(target);
    if (!next || next.type !== 'tag') return target;
    target = parseTag(next.data).object;
  }
  return target;
}

function v0Advertisement(store: Store, repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const tip = headTip(repo) ?? ZERO_OID;
    parts.push(encodePktLine(`${tip} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peeledOf(store, ref.oid);
        if (peeled !== undefined) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('object-format=sha1\n'),
    encodePktLine('agent=github-core-clone/1.0\n'),
    pktFlush(),
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | null,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(store, repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(store, repo, 'git-receive-pack') };
  }
  return jsonResponse(400, { message: `unknown service ${service}` });
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: GitPacket[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue; // command=, agent=, object-format= lines live before the delim
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

export function handleLsRefs(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
  const packets = decodePktLines(body);
  const first = packets.find((p) => p.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (!first.startsWith('command=ls-refs')) throw new Error(`expected command=ls-refs, got ${JSON.stringify(first)}`);
  const args = parseLsRefsArgs(packets);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const tip = headTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  } else {
    if (tip !== undefined && keep('HEAD')) {
      lines.push(`${tip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.name.startsWith('refs/tags/')) {
        const peeled = peeledOf(store, ref.oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
      lines.push(`${line}\n`);
    }
  }
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(packets: GitPacket[], v2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=fetch')) continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'done') continue;
    if (line.startsWith('want ')) {
      // v0: the first want line may carry capabilities after the oid.
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      args.wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // deepen-since / deepen-not / filter: accepted and ignored.
  }
  return args;
}

/** Wrap band-1 data in sideband pkt-lines (each <= 65520 bytes total). */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX_CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += MAX_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + MAX_CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

export function handleFetchV2(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
  const packets = decodePktLines(body);
  const first = packets.find((p) => p.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (!first.startsWith('command=fetch')) throw new Error(`expected command=fetch, got ${JSON.stringify(first)}`);
  const args = parseFetchArgs(packets, true);
  const plan = computeFetch(store, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function handleFetchV0(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
  const packets = decodePktLines(body);
  const args = parseFetchArgs(packets, false);
  const plan = computeFetch(store, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push, v0 only)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Read pkt-lines from the head of `body` until the first flush; return the commands and the
 * byte offset just past the flush (the pack follows there, raw).
 */
function parsePushBody(body: Buffer): { commands: PushCommand[]; packOffset: number } {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('push body ends before the command flush');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in push body');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const command = nul < 0 ? line : line.slice(0, nul);
    const parts = command.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error(`bad push command ${JSON.stringify(command.slice(0, 80))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  return { commands, packOffset: offset };
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
  const { commands, packOffset } = parsePushBody(body);
  if (commands.length === 0) throw new Error('push with no commands');
  const packBytes = body.subarray(packOffset);
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);

  let unpackError: string | null = null;
  if (updatesRef && packBytes.length === 0) {
    unpackError = 'missing packfile';
  } else if (packBytes.length > 0) {
    // Objects already in the store have a complete closure by construction (every
    // stored commit's tree, blobs and parents were stored with it), so the closure
    // walk below only descends into objects this pack just added: O(pack), not O(history).
    const preExisting = new Set(store.objects.keys());
    let unpacked;
    try {
      unpacked = readPack(packBytes, (oid) => store.getObject(oid));
    } catch (err) {
      unpackError = (err as Error).message;
    }
    if (unpacked !== undefined) {
      // Validate closure against the merged view (pack + store) and only commit
      // the new objects to the store once it passes, so a failed push never
      // leaves objects with an incomplete closure behind.
      const lookup = (oid: string) => unpacked.get(oid) ?? store.getObject(oid);
      for (const command of commands) {
        if (command.newOid === ZERO_OID) continue;
        try {
          const reachable = new Set<string>();
          const queue = [command.newOid];
          while (queue.length) {
            const oid = queue.pop()!;
            if (reachable.has(oid)) continue;
            const object = lookup(oid);
            if (!object) throw new Error(`object ${oid} is missing`);
            reachable.add(oid);
            if (preExisting.has(oid)) continue;
            if (object.type === 'commit') {
              const commit = parseCommit(object.data);
              queue.push(commit.tree);
              for (const parent of commit.parents) queue.push(parent);
            } else if (object.type === 'tag') {
              queue.push(parseTag(object.data).object);
            } else if (object.type === 'tree') {
              for (const entry of parseTree(object.data)) queue.push(entry.oid);
            }
          }
        } catch (err) {
          unpackError = (err as Error).message;
          break;
        }
      }
      if (unpackError === null) {
        for (const [oid, object] of unpacked) {
          if (!store.objects.has(oid)) store.objects.set(oid, object);
        }
      }
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current !== undefined && command.oldOid === current) {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current === undefined) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else {
        // Update: old must match, and the update must be a fast-forward.
        if (current !== undefined && command.oldOid === current && store.isAncestor(command.oldOid, command.newOid)) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      }
      reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} non-fast-forward\n`);
    }
  }

  const band1 = Buffer.concat(reportLines.map((line) => encodePktLine(line)));
  const parts = [...sidebandPackets(band1), pktFlush()];
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}
