# Package guide

What each package owns, file by file. Pair this with
[Repository layout](/internals/repo-layout).

---

## `@hive/shared`

The contract layer. Everything the Queen and the bees agree on lives here, and
nothing else does. Both sides import it; it imports neither.

`src/index.ts` is a clean barrel re-exporting six modules.

| File | Owns |
|---|---|
| `capability.ts` | `Tier`, `BillingType`, `Difficulty`, `Sensitivity`, `Urgency`, `QuotaWindow`, `CapabilityRecord`, plus the pure functions the router is built on: `costRank`, `adequateTiers`, `allowedByConfidentiality`, `agentName`, `agentLabel`, `isRuntimeFallback`. |
| `messages.ts` | Every wire schema. See the [message protocol reference](/reference/messages). |
| `catalog.ts` | Loads `llm_model_api_catalog.yaml` and prices a call. |
| `host.ts` | `HostInventory` — what a machine *could* run, for the console's Setup view. |
| `artifacts.ts` | The artifact store: content too large for the wire, passed by reference. |
| `env.ts` | dotenv bootstrap. **Must be imported first**, before any env-reading module initializes. |
| `bus/types.ts` | The `Bus` interface both backends implement. |
| `bus/index.ts` | Backend selection from `HIVE_BROKER`. |
| `bus/amqp.ts` | RabbitMQ. The default and the production path. |
| `bus/mqtt.ts` | The MQTT client for lightweight mode. |
| `bus/broker-entry.ts` | The embedded Aedes broker (`npm run broker`). |

Two functions in `capability.ts` repay a close read. `costRank` is where the
"subscription seats are prepaid" insight becomes code — it is why tier 1
outranks tier 2. And `isRuntimeFallback` exists because a plain
`configured !== actual` comparison read every tool call and every API call as a
fallback: adapters report `runtimeUsed` at finer grain (`tool:csv-report` for
runtime `tool`), which is extra information, not a substitution.

---

## `@hive/queen`

The control plane, and by a wide margin the largest package.

### Deterministic authority

| File | Owns |
|---|---|
| `core.ts` | `QueenCore`. The single entry point into the hive — both structured intake and the planner go through `submitTask`, and nothing bypasses it. Also owns sensitivity grounding, dispatch, the retry ladder, the reaper, and `/status` assembly. |
| `analyzer.ts` | Tool matching and `scoreDifficulty`. |
| `tierMapper.ts` | `decide()` — cheapest adequate capability, ranked by billing. `RoutePolicy` lives here. |
| `budget.ts` | The dual-currency ledger: USD caps, seat windows, leases. |
| `registry.ts` | Live worker roster, heartbeats, rollcall, the overlap warning. |
| `resultCache.ts` | Keyed on normalized input **plus** `sensitivity`, `continues`, the capability the caller named, and the caller's whole transcript — each of which decides the answer, so leaving any of them out would serve one request from another's result. |
| `store.ts` | `JobStore` / `InMemoryJobStore`: task state, bounded and expiring. |
| `episode.ts` | The episode record and the privacy ratchets that shape it — the evidence base for refining the planner. |
| `episodeStore.ts`, `episodeDb.ts`, `episodeSchema.ts` | The usage corpus: retention, the SQLite connection, and the versioned schema plus the views that are its published interface. |
| `episodeJsonl.ts`, `episodeImport.ts` | The legacy append-only log, and the one-way import that carried it into the database. |
| `auth.ts` | `HIVE_API_KEYS`: who is calling, and whose budget they spend. Identifies and attributes; does not isolate. |
| `hiveLog.ts` | The narration ring buffer behind `GET /events`. |
| `index.ts` | The Express app: `/tasks`, `/tasks/:id`, `/status`, `/shutdown`, and the loopback binding. |
| `routes/chat.ts` | `POST /chat` (SSE), `GET /sessions/:id`. |
| `routes/events.ts` | `GET /events` (SSE). |
| `routes/openai.ts` | `/v1/models` and `/v1/chat/completions` — [the hive as an LLM](/reference/http-api#post-v1-chat-completions). |

### Breeding

Reading the corpus back, so recurring work can be replaced by a program. Nothing
here spends a token, reads a model, or writes to the database.

| File | Owns |
|---|---|
| `breed/cli.ts` | `npm run breed`: `flows`, `steps`, `shapes`, `sql` report facts; `survey` is one frozen opinionated reading. |
| `breed/query.ts` | The fact commands, run against the documented views. |
| `breed/corpus.ts` | Grouping task rows into recurring shapes, on whatever basis the recorded fidelity allows. |
| `breed/detect.ts` | The gates, the verdicts, the volatility signal and the counterfactual price. |
| `breed/mask.ts` | Masking values out of task text, so two requests differing only in their parameters read as one template. |
| `breed/lex.ts` | Reading a request as an ordered sequence with offsets, which is what masking a span and putting it back requires. Shares the planner's stopword list rather than copying it. |

### The planner

| File | Owns |
|---|---|
| `planner/index.ts` | The turn: recall → plan → dispatch → synthesize → learn. |
| `planner/orchestrator.ts` | Runs a plan as a DAG in parallel waves. |
| `planner/model.ts` | The planner model call, and the startup verification that refuses to substitute. |
| `planner/session.ts` | Chat sessions, bounded and windowed. |
| `planner/guide.ts` | Loads the plan guides. |
| `planner/types.ts` | `PlannedTask`, `ChatEvent`, the decision schema. |
| `planner/memory/detect.ts` | The five detectors. |
| `planner/memory/recall.ts` | The trigger-word gate and ranking. |
| `planner/memory/reflect.ts` | Grading, trust decay, retirement. |
| `planner/memory/sanitize.ts` | What may be written down at all. |
| `planner/memory/store.ts` | On-disk memory plus `INDEX.md` and the `retired.json` tombstone. |

The wall between the two halves is worth naming: `core.ts` knows nothing about
memory. The planner contributes its snapshot to `/status` through
`registerStatusSection`, which is a read-only hook — memory belongs to the brain,
and the deterministic authority stays unaware of it.

---

## `@hive/worker`

The bee host. One process, one tier.

| File | Owns |
|---|---|
| `config.ts` | The [worker config](/reference/worker-config) schema and loader. |
| `discovery.ts` | What this machine could run — the `HostInventory` that rides the hello. |
| `preflight.ts` | Checks each configured capability against reality. Missing → dropped with a reason; degraded → kept and flagged. |
| `gate.ts` | The confidentiality and budget guard, plus `(taskId, attempt)` dedup — a repeated delivery replays the stored result rather than re-executing. |
| `wallet.ts` | The lease: what this bee may spend before asking again. |
| `log.ts` | Narration, level-gated, identifiers only. |
| `index.ts` | The consumer loop: bind, register, execute, report, drain. |

---

## `@hive/adapters`

One module per runtime, behind a two-method interface.

```ts
export interface RuntimeAdapter {
  /** runtimes this adapter can execute */
  runtimes: string[];
  execute(task: TaskMessage, capability: CapabilityRecord, prompt: string): Promise<ExecResult>;
}
```

| Module | Bee | Drives |
|---|---|---|
| `official-agent/` | 🍯 | `claude -p`, `codex exec` |
| `api-model/` | 💵 | OpenAI / Anthropic / Google, via `providers.ts` |
| `ollama-agent/` | 🏠 | OpenCode, OpenClaw, or direct Ollama (`ollama-direct` fallback) |
| `personal-agent/` | 🏡 | Hermes, an OpenClaw gateway, or the built-in `mini.ts` over `sandbox.ts` |
| `tool/` | 🐝 | The tier-4 tool registry. No LLM. |
| `hermes.ts` | 🏡 | The Hermes CLI specifically. |

`types.ts` defines `ExecResult`, and three of its fields exist because of
specific failures:

- **`diagnostics`** keeps a runtime's chatter about *itself* separate from the
  answer. Before it existed, stderr was discarded and stdout was silently
  prepended to the result — so the only way to see a runtime's diagnostics was
  for them to corrupt an answer.
- **`cacheReadTokens` / `cacheWriteTokens`** exist so the hive can *check*
  whether prompt caching is working rather than assume it. A `cache_control`
  marker on a prefix shorter than the model's minimum is silently ignored, and a
  zero here is the only way to see that.
- **`sessionRef`** is an identifier only — never the transcript it refers to.
  That is what makes it safe to put on the wire at all.

---

## `@hive/web`

The React console. The only package with a build step (`vite build`), served on
`:5180` in dev with a proxy to the Queen on `:4100`.

| File | Owns |
|---|---|
| `App.tsx` | **Home** — chat plus live task cards. |
| `Setup.tsx` | **Setup** — what your machines could run but don't yet. |
| `Activity.tsx` | **Activity** — the wire feed, filterable and pausable. |
| `api.ts` | The Queen client, including the hand-rolled SSE reader for `POST /chat`. |
| `commands.ts` | Console command parsing (`test/commands.test.ts` covers it). |
| `labels.ts` | Display naming, delegating to `agentLabel` so a bee is called the same thing everywhere. |

It has **no shutdown control**, deliberately — see
[Stopping and resetting](/guide/stopping#why-this-is-a-command-and-not-a-button).
