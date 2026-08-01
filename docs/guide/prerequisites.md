# Prerequisites

**Node 20+ is the only hard requirement.** Everything else adds a bee; nothing
else is needed to get a running hive.

| Add this | Get this |
|---|---|
| nothing | 🐝 worker bee — tools, always available |
| [Ollama](https://ollama.com) + `ollama pull gemma4:12b` | 🏠 local bee, and the planner's default brain |
| the same Ollama (or an OpenClaw gateway / Hermes CLI) | 🏡 personal bee — reads local personal data in `demo/personal-data/` |
| `claude` and/or `codex` CLI, logged in | 🍯 honey bee |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | 💵 metered bee |

A hive with only the worker bee is a real hive — it routes, it budgets, it logs.
It just can't reach an LLM. Each row above unlocks one more rung of the
[capability ladder](/guide/capability-ladder).

## The planner's brain is a separate concern

`ollama pull gemma4:12b` does double duty: it gives you the local bee *and* the
model the Queen plans with (`HIVE_PLANNER_MODEL`).

That model is verified at startup and **never silently swapped for another**. An
absent planner model is reported, not worked around — the Queen's plan decides
every task's routing and confidentiality, so quietly substituting a different
model there would quietly change both.

## Optional runtimes

`ollama launch opencode` / `ollama launch openclaw` give you the real
OpenCode/OpenClaw runtimes. Without them the local bee falls back to direct
Ollama calls, marked `ollama-direct` — expected, not an error.

## Docker is optional

Docker is only for the distributed/RabbitMQ path. **Solo mode needs neither
Docker nor RabbitMQ** — it brings up a pure-JS MQTT broker (Aedes) in-process.

## Checking what you have

Before starting anything, ask the launcher what this machine would actually run:

```bash
npm install
npm run solo -- --dry-run
```

It prints the roster and exits, naming every capability it found and the reason
for every one it skipped:

```
  ✓ 🍯 honey bee    tier 1 · subscription seats claude + codex
  · 💵 metered bee  tier 2 · per-token API      no OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY set
  ✓ 🏠 local bee    tier 3 · local models       gemma4:12b
  ✓ 🏡 personal bee tier 3 · personal data      built-in mini agent on gemma4:12b
  ✓ 🐝 worker bee   tier 4 · tools, no LLM      csv-report, log-extract
```

A `·` line is not a failure. It is the launcher telling you which prerequisite
would light that bee up.
