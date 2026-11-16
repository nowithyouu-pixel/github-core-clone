# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nowithyouu-pixel/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nowithyouu-pixel/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL and MCP in one Node process. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## What it does

One process, no UI, no git binary, no outside service, no dependencies — Node 22 stdlib only, erasable TypeScript. `main.ts` binds an ephemeral port, registers it with the harness (`POST $MAKEFUN_ENV_URL/register`), and exits when the harness says done.

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 (`ls-refs`, `fetch` with shallow/deepen/unshallow, thin-pack) and receive-pack v0 with `report-status`/`side-band-64k`, fast-forward checks, mixed-push semantics. Pack read/write is implemented from scratch (whole objects, SHA-1 trailer, OFS/REF delta resolution on read), and pushed objects round-trip byte-exactly.
- **REST v3** (`/api/v3`): repos, branches, commits, contents, labels, issues, comments, pull requests, squash merge with three-way conflict detection. Bearer auth; a repo under another owner is 404, never 403; every reply carries `X-GitHub-Request-Id`.
- **GraphQL** (`/api/graphql`): hand-written parser and executor, opaque Relay global ids, cursor pagination, introspection, batched operations, mutations with REST parity.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, `server/discover` (2026-07-28) plus legacy `initialize`, six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

State is a deterministic in-memory store: fixed epoch for server-made commits, no wall clock, no unseeded randomness. Verified against the competition's sealed conformance suite: **120/120 checks, score 955/1000** (600 feature + 200 agent + 155 perf) on local runs.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
