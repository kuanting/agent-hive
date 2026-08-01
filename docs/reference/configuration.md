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
| `QUEEN_HOST` | `127.0.0.1` | Loopback is the authorization model, not a dev default. Read [the warning](/reference/http-api#before-anything-else-this-api-is-unauthenticated) before changing it. |
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
| `HIVE_EPISODE_FILES` | `20` | Rotated episode file count. | `packages/queen/src/episode.ts` |
| `HIVE_EPISODE_FILE_BYTES` | `8388608` (8 MiB) | Size at which an episode file rotates. | `packages/queen/src/episode.ts` |
| `HIVE_TOOL_ROUNDS` | `4` | Maximum tool-call rounds in one personal-bee turn. | `packages/adapters/src/personal-agent/mini.ts` |
| `HIVE_SHUTDOWN_GRACE_MS` | `HIVE_SHUTDOWN_WAIT_MS + 15000` | How long `npm run solo` waits for its children after asking the hive to stop. | `scripts/solo.mjs` |
| `HIVE_DEBUG` | unset | Any truthy value makes `npm run stop` print full stack traces instead of one-line errors. | `scripts/stop.mjs` |

::: tip
Treat this table as a to-do list for `.env.example` rather than a permanent
feature of the docs. Everything here is a knob someone chose to make
configurable; the file is where knobs are supposed to be announced.
:::
