# Environment variables

Every value in `.env.example` is the built-in default, so an **empty `.env` still
gives you a working local setup**. Copy it and adjust only what you need:

```bash
cp .env.example .env
```

The Queen, the workers and the web dev server all load `.env` through dotenv at
startup, from the current working directory — which is why the npm scripts are
meant to be run from the repo root. Real environment variables take precedence
over anything in the file.

## The ones that matter most

| Variable | Default | Why you'd change it |
|---|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | unset | The only credentials the hive reads, and all the 💵 metered bee needs. The 🍯 honey bee needs none — Claude Code and Codex authenticate through their own CLI sessions, which is precisely what makes them prepaid rather than per-token. |
| `HIVE_BROKER` | `amqp` | `amqp` is RabbitMQ and the production path; `mqtt` is the embedded Aedes broker (lightweight mode). `npm run solo` sets `mqtt` for you and **nothing else does** — see below. |
| `HIVE_PLANNER_MODEL` | `gemma4:12b` | The local model the Queen plans with. Verified at startup and never silently swapped. |
| `HIVE_API_DRYRUN` | unset | `1` skips the network on per-token calls but still reports realistic token counts, so the ledger, budget guard and USD cap behave exactly as live. For re-running or recording a demo without spending. |
| `QUEEN_PORT` | `4100` | The Queen's intake API and chat. |
| `QUEEN_HOST` | `127.0.0.1` | Loopback is the authorization model for every route a bearer key does not cover. Read [which routes are guarded](/reference/http-api#which-routes-are-guarded) before changing it. |
| `HIVE_API_KEYS` | unset | `key:customerId[:userId\|:@gateway]`, comma- or newline-separated. Gates every route but `/events`, and decides whose budget a caller spends. `@gateway` lets one key name a different user per request — see [gateway keys](/reference/http-api#gateway-keys). Unset means the gate is open. |
| `HIVE_USER_HEADER` | `x-openwebui-user-id` | The header a gateway key names its user in. |
| `HIVE_HTTP_WAIT_MS` | `120000` | How long `/v1/chat/completions` waits before answering with a task handle instead of an answer. The task keeps running and is still charged. |
| `HIVE_CONSOLE_KEY` | unset | The console's key, injected by the dev-server proxy. Required once `HIVE_API_KEYS` is set, or `npm run console` gets 401s. |
| `OLLAMA_URL` | `http://localhost:11434` | Where the 🏠 local bee and the planner find Ollama. |
| `HIVE_LOG_LEVEL` | `info` | Threshold for both a bee's terminal and the console's Activity feed. |

## Lightweight mode has to be asked for by name

`HIVE_BROKER` used to fall back to "mqtt if `MQTT_URL` is set", which meant that
merely leaving `MQTT_URL` in a `.env` — `demo/watch.ts` reads it too — silently
moved a Queen onto the backend with the weaker delivery guarantee.

The two genuinely differ. RabbitMQ acks *after* the work finishes and redelivers
a crashed worker's task to a peer. The embedded broker acks *on receipt* and
relies on the Queen's reaper (`HIVE_ACCEPT_TIMEOUT_MS`, `HIVE_STALL_TIMEOUT_MS`)
to notice and redispatch. Which one is running should be a decision, never an
inference — so setting `MQTT_URL` alone does nothing, and `HIVE_BROKER=mqtt` is
the only way in.

## Every documented variable

What follows is `.env.example` itself, embedded from the repository at build
time. It cannot drift from what the code reads, because it *is* the file.

<<< @/../.env.example{bash}

## Variables the code reads but `.env.example` does not list

These are real and settable, but they are absent from `.env.example`, so the
only way to discover them today is to read the source. They are the bounds that
keep the Queen's long-lived maps from growing without limit, plus two debug
switches. The defaults are what the code falls back to.

| Variable | Default | What it bounds | Read in |
|---|---|---|---|
| `HIVE_TASK_RETENTION_MS` | `1800000` (30 min) | How long a *finished* task stays readable. Deliberately generous: `getTask` is read by the task endpoint, by reflection, and by the session-affinity lookup, so evicting eagerly turns a warm follow-up cold — which costs money rather than raising an error. In-flight work is never evicted. | `packages/queen/src/store.ts` |
| `HIVE_RESULT_CACHE_TTL_MS` | `600000` (10 min) | How long a cached result can serve a repeat request for free. | `packages/queen/src/resultCache.ts` |
| `HIVE_RESULT_CACHE_MAX` | `200` | Cache entry count cap. | `packages/queen/src/resultCache.ts` |
| `HIVE_SESSION_TTL_MS` | `3600000` (1 hour) | How long a chat session survives. | `packages/queen/src/planner/session.ts` |
| `HIVE_SESSION_MAX` | `200` | Session count cap. | `packages/queen/src/planner/session.ts` |
| `HIVE_SESSION_WINDOW_CHARS` | `6000` | Character budget for the conversation actually *sent to the planner model*. Turn N used to send 2N−1 messages, so a turn's cost tracked how long the chat had been going rather than how hard the request was. The full transcript is still kept for `GET /sessions/:id`; only the model call is windowed. | `packages/queen/src/planner/index.ts` |
| `HIVE_ARTIFACT_BUDGET_CHARS` | `6000` | Character budget for artifact content injected into a prompt. | `packages/queen/src/planner/index.ts` |
| `HIVE_EPISODE_MAX_DAYS` | `180` | How much history the usage corpus keeps. | `packages/queen/src/episodeStore.ts` |
| `HIVE_EPISODE_MAX_ROWS` | `500000` | Row cap per corpus table, oldest shed first. | `packages/queen/src/episodeStore.ts` |
| `HIVE_EPISODE_DB` | `<root>/data/episodes/episodes.db` | Where the corpus lives. Point it at local disk if `HIVE_ROOT` is a network share — SQLite WAL needs shared memory and does not work over NFS or SMB. | `packages/queen/src/episodeStore.ts` |
| `HIVE_TOOL_ROUNDS` | `4` | Maximum tool-call rounds in one personal-bee turn. | `packages/adapters/src/personal-agent/mini.ts` |
| `HIVE_BREED_MIN_SAMPLES` | `12` | Occurrences before `npm run breed -- survey` considers a shape at all. `--min` overrides it per run. | `packages/queen/src/breed/detect.ts` |
| `HIVE_BREED_MIN_OK_RATE` / `HIVE_BREED_MIN_FIRST_OK` | `0.9` / `0.8` | The reliability and first-attempt gates. | `packages/queen/src/breed/detect.ts` |
| `HIVE_BREED_MIN_SIMILARITY` / `HIVE_BREED_MIN_MARGIN` | `0.6` / `0.25` | How alike a shape's requests must be, and how far they must out-resemble other shapes. | `packages/queen/src/breed/detect.ts` |
| `HIVE_BREED_MAX_MASK` / `HIVE_BREED_MIN_DF` | `0.35` / `0.9` | The two guards that stop masking from manufacturing the similarity the gate looks for. | `packages/queen/src/breed/detect.ts` |
| `HIVE_BREED_LIVE_GAP_MS` | `60000` | Below this gap, two different answers to one request are not "the data moved". | `packages/queen/src/breed/detect.ts` |
| `HIVE_SHUTDOWN_GRACE_MS` | `HIVE_SHUTDOWN_WAIT_MS + 15000` | How long `npm run solo` waits for its children after asking the hive to stop. | `scripts/solo.mjs` |
| `HIVE_DEBUG` | unset | Any truthy value makes `npm run stop` print full stack traces instead of one-line errors. | `scripts/stop.mjs` |

::: tip
Treat this table as a to-do list for `.env.example` rather than a permanent
feature of the docs. Everything here is a knob someone chose to make
configurable; the file is where knobs are supposed to be announced.
:::
