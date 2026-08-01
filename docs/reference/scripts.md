# npm scripts

Every script is meant to be run from the repository root — the services load
`.env` from the current working directory.

## Running the hive

| Script | What it does |
|---|---|
| `npm run solo` | The detecting launcher. Probes the machine, starts one bee process per capability class it finds, plus the embedded MQTT broker, the Queen on `:4100` and the console on `:5180`. No Docker, no RabbitMQ. |
| `npm run queen` | The Queen alone: intake API and chat on `:4100`. |
| `npm run worker -- <config.yaml>` | One bee, from a [worker config](/reference/worker-config). |
| `npm run broker` | The embedded Aedes MQTT broker alone. |
| `npm run console` | The React console dev server on `:5180`. |
| `npm run stop` | Stops the hive: shows what will stop, asks, then does it. |

### `npm run solo` flags

```bash
npm run solo -- --frontier            # metered bee uses the frontier model profile
npm run solo -- --only=local,worker   # just those bees
npm run solo -- --no-console          # skip the web console
npm run solo -- --dry-run             # print the roster and exit, start nothing
```

`--dry-run` is the fastest way to answer "what would this machine actually run?"
— it prints the roster, including every capability that was skipped and why,
without starting anything.

### `npm run stop` flags

```bash
npm run stop            # shows what will stop, asks, then stops it
npm run stop -- --yes   # no prompt, for scripts (-y also works)
```

It reports how many bees will stop and whether a task is in flight. An in-flight
task is **finished first** and its result published, not abandoned — dropping it
would throw away tokens already spent *and* leave the Queen waiting out a timeout
for a result that will never arrive, after which it pays for the same work again.
Then it drains the fleet and stops the Queen last.

`HIVE_DEBUG=1` makes it print full stack traces instead of one-line errors.

## Watching

| Script | What it does |
|---|---|
| `npm run watch` | Live bee roster, seat quota, budget, and wire traffic in the terminal. The CLI twin of the console's Activity view. |
| `npm run scoreboard` | What the run actually cost, next to what all-frontier would have cost. |

## Demos

These are shell scripts rather than npm scripts:

```bash
bash demo/walkthrough.sh    # one task per routing branch, narrated
bash demo/chat-scenario.sh  # the planner decomposing one request into a DAG
bash demo/daily-jobs.sh     # personal-data jobs routed to the 🏡 personal bee
python3 demo/chat.py "Write a one-line tagline for the lab edge-AI sensor demo."
```

`demo/walkthrough.sh` is the tour: a tool match that costs zero tokens, simple
prose staying local, complex work landing on a prepaid seat, urgent overflow to a
paid API, confidential work locked on-prem, a seat exhausting and the task
deferring until the window resets, the same block degrading instead of waiting
under a different customer policy, a pinned task, and a cache hit. Run it with
`--frontier` and it also shows the worker's budget guard refusing a call that
would cost 11.8× the task's cap — a beat that costs nothing, because the call
never happens.

## Resetting

```bash
npm run reset             # clear the budget ledger
npm run reset -- --memory # also clear what the Queen has learned
npm run reset -- --all    # also clear the artifact store and learned memory
```

The budget ledger (spend plus seat-window state) persists to `data/ledger.json`
and reloads on startup, so a reset is how you start a demo fresh. Stop the hive
first. The ledger rebuilds from `customers/*.yaml` on the next Queen start.

Plan guides are hand-authored configuration and are **never** removed by any of
these.

## Checks

| Script | What it does |
|---|---|
| `npm test` | vitest across all packages: cost estimator, difficulty scorer, tool matcher, routing policy, log privacy, memory security, bus contract, shutdown. |
| `npm run check` | `tsc --noEmit` over `packages/*/src` and `demo/*.ts`. |

## Documentation

The docs site is a separate npm project in `docs/`, deliberately not a workspace
— so a root `npm install` never pulls VitePress. These wrappers reach it:

| Script | What it does |
|---|---|
| `npm run docs:install` | Install the docs dependencies (needed once per clone). |
| `npm run docs:dev` | Local preview with hot reload. |
| `npm run docs:build` | Production build, plus the DESIGN.md anchor and mermaid verification. |
| `npm run docs:preview` | Serve the built site at its real base path. |

See [Repository layout](/internals/repo-layout#the-documentation-site) for why
`docs/` sits outside the workspace graph.
