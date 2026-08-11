# Repository layout

An npm-workspaces monorepo. TypeScript throughout, ESM, Node 20+.

**There is no build step for the services.** `tsx` runs the sources directly and
`tsc --noEmit` typechecks them, so `packages/*/package.json` point `main` at
`src/index.ts`. The only thing that gets bundled is the React console.

```
customers/            per-customer budgets, seats, tools, routing policy (core is customer-agnostic)
                      plus *.plan-guide.md: hand-authored advice on how to decompose
data/memory/          what the Queen has learned, one lesson per file (runtime state, gitignored)
packages/shared       schemas, capability model, cost catalog, broker backends (amqp + mqtt)
packages/queen        core (deterministic authority), planner (conversational),
                      analyzer, tier mapper, budget ledger, chat routes
packages/worker       bee host: discovery, capability preflight, registration, lease wallet
packages/adapters     official-agent (🍯) / api-model (💵) / ollama-agent (🏠) / tool (🐝)
apps/web              React console: Home (chat + live task cards), Setup, Activity (live feed)
demo/workers/         one config per bee, each owning exactly one tier
demo/                 walkthrough, scoreboard, watch, chat scenario
docs/                 this documentation site
scripts/solo.mjs      the detecting launcher
```

## The workspaces

`package.json` declares `["packages/*", "apps/*"]`.

| Package | Rough size | What it owns |
|---|---|---|
| `@hive/shared` | ~1.5K LOC | The contract layer. Everything both sides agree on. |
| `@hive/queen` | ~7.9K LOC | The control plane. The largest package by far. |
| `@hive/worker` | ~1.9K LOC | The bee host. |
| `@hive/adapters` | ~2.8K LOC | One module per runtime. |
| `@hive/web` | ~1.2K LOC | The React console. The only package that builds. |

See the [package guide](/internals/packages) for what is in each.

## Runtime state, all gitignored

| Path | Contents |
|---|---|
| `data/ledger.json` | Budget spend and seat-window state. Reloads on startup. |
| `data/memory/<customerId>/` | Learned memories, one per file, plus `INDEX.md`. |
| `data/episodes/episodes.db` | The usage corpus (SQLite): every settled task, its attempts, and the agent tool calls it made. Queryable by anyone; see DESIGN §7. |
| `artifacts/` | The artifact store: content too large to put on the wire. |

`npm run reset` clears these; see [Stopping and resetting](/guide/stopping).

## Configuration, all checked in

| Path | Contents |
|---|---|
| `.env.example` | Every environment variable with its default, heavily annotated. |
| `customers/*.yaml` | Per-customer budget, seats, tools, policy. |
| `customers/*.plan-guide.md` | Prompt configuration — advice for the planner. Not documentation. |
| `demo/workers/*.yaml` | One bee config per tier. |
| `llm_model_api_catalog.yaml` | Model and price catalog the cost estimator reads. |
| `docker-compose.yml` | RabbitMQ only. Not needed for solo mode. |

## Tests

36 `*.test.ts` files across all four packages plus `apps/web/test`, run with
`npm test` (vitest). Several are worth reading as specifications rather than
tests:

| Test | What it fences |
|---|---|
| `packages/queen/test/log-privacy.test.ts` | A source scan of every narration call site, proving no log line can carry prompt or output text. |
| `packages/queen/test/memory-security.test.ts` | That learned memory cannot influence routing. |
| `packages/shared/test/bus-contract.test.ts` | That both broker backends satisfy the same `Bus` interface. |
| `packages/*/test/shutdown.test.ts` | That stopping drains rather than abandons. |

## The documentation site {#the-documentation-site}

`docs/` holds this site, and it is **deliberately not a workspace**.

VitePress plus mermaid is around 100 MB of dependencies. Someone who wants to run
the hive should not pay for that, so `docs/` carries its own `package.json` and
its own `package-lock.json`, and the root `workspaces` array does not match it. A
root `npm install` never touches it.

The consequence to know about: **a fresh clone has no `docs/node_modules` until
you ask for one.**

```bash
npm run docs:install   # once per clone
npm run docs:dev       # preview with hot reload
npm run docs:build     # production build + anchor/mermaid verification
```

Rooting the site at `docs/` rather than the repo root does two other jobs. It
keeps `docs/DESIGN.md` exactly where it has always been, so every relative link
in `README.md` still resolves on GitHub. And it excludes the two markdown
families that must never be published — `customers/*.plan-guide.md` (prompt
configuration) and `demo/personal-data/**` (fake personal data) — *structurally*
rather than by a glob someone has to remember to maintain.

### Linking rules for docs pages

- To another docs page: `/section/page` or `./sibling.md`. VitePress rewrites
  `.md` to a clean URL, and the same link still resolves if someone browses
  `docs/` on GitHub.
- Into `DESIGN.md`: use VitePress's anchor form, which **underscore-prefixes ids
  starting with a digit** — `/DESIGN#_5c-a-queen-that-learns…`, not
  `#5c-…`. This is where GitHub's slugs and VitePress's diverge, so an anchor
  copied out of the GitHub reader fails silently.
- To a repo file **outside** `docs/`: use an absolute GitHub blob URL. A relative
  link that escapes the content root is a dead link, and the build fails on dead
  links deliberately.
- To embed source *content*, use a snippet import
  (`<<< @/../packages/shared/src/messages.ts#taskspec{ts}`) rather than a link.
  It is read from disk, so it can never dead-link and can never drift.
