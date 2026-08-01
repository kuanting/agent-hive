# Worker configuration

One YAML file per bee. `npm run worker -- path/to/bee.yaml` starts a bee that
advertises exactly what its file declares — and nothing else.

That last part is the design rule: **the hive manages agents you harnessed, not
models it found.** An agent is something someone installed and configured, so the
hive never invents capabilities on your behalf. What a machine merely *could* run
— every installed Ollama model, which binaries are on `PATH` — is reported
separately to the console's Setup view, so `ollama pull` changes what you are
*offered*, never what the hive *promises*.

## The schema

<<< @/../packages/worker/src/config.ts{ts}

## A capability record

Each entry under `capabilities:` is a `CapabilityRecord`. The pair that defines a
capability is **agent × model**, not the agent alone: OpenCode on a local 8B and
OpenCode on a cloud frontier model are different capabilities with different
costs.

```yaml
capabilities:
  - agent: hermes         # what to call it, everywhere in the hive
    runtime: personal     # which adapter drives it
    model: gemma4:12b     # what that agent runs
    tier: 3
    billing: local
    skills: [email, files, calendar]
```

| Field | Required | Meaning |
|---|---|---|
| `agent` | no | Operator-chosen name of the harnessed agent. The identity humans see in the console, the logs and the rosters. Absent means "call it by its runtime", which is what every capability did before the field existed — so old configs behave identically. |
| `runtime` | yes | The dispatch key that selects an adapter: `claude-code`, `codex`, `opencode`, `openclaw`, `hermes`, `ollama`, `personal`, `api`, `tool`. Naming an agent never changes how a task executes. |
| `tier` | yes | `1`–`4`. Describes **composition, not cost** — see below. |
| `billing` | yes | `subscription`, `per-token`, `local`, or `free`. This is what determines real marginal cost. |
| `model` | no | What the agent is told to run. Advisory: environment overrides win, and a model the host has not pulled falls back to whatever Ollama does report. |
| `skills` | no | Free-form tags the Queen routes on. Defaults to `[]`. |
| `toolId` | no | For tier-4 records: which hardcoded tool this serves. |
| `quotaWindow` | no | The prepaid seat this capability meters against. Only its `seatId` matters here — the window's size comes from the customer profile. |

`runtime: ollama` is the bare daemon with no agent harness in front of it. That
is the honest declaration for a host that has models pulled but has installed
none of opencode/openclaw/hermes; naming one of those instead would advertise a
binary that isn't there and fail once per task before degrading.

### Tier describes composition; billing describes cost

This separation is the whole basis of the routing:

| Tier | Composition | Bee |
|---|---|---|
| 1 | Official agent + paid frontier model | 🍯 honey bee |
| 2 | Open-source agent + paid model (per-token API, or an Ollama cloud plan) | 💵 metered bee |
| 3 | Open-source agent + local model | 🏠 local bee, 🏡 personal bee |
| 4 | Hardcoded tool, no LLM at all | 🐝 worker bee |

The Queen ranks by **`billing`**, not by tier number: `free` → `local` →
subscription (Ollama cloud seat before frontier seat) → `per-token` last. That
is why a tier-1 honey bee is dispatched *ahead of* a tier-2 metered bee. See
[The capability ladder](/guide/capability-ladder).

`billing` also gates confidentiality: only `local` and `free` capabilities may
serve a `sensitivity: confidential` task. Confidential work never leaves the
premises, and this is the one line of code that enforces it.

## `bindGeneral` is load-bearing on the embedded broker

Each bee also binds a per-tier `general` fan-in queue by default. Set
`bindGeneral: false` when a bee shares a tier with another bee but owns a
*disjoint* skill set.

The reason is specific to lightweight mode: Aedes has no shared subscriptions, so
two bees binding the same tier + skill would each receive every such task and
both would execute it. The personal bee sets `bindGeneral: false` precisely
because the local bee already owns tier-3 `general`.

This is a constraint on *overlap*, not on worker count. Bees with disjoint
bindings never contend, which is exactly why solo mode can run one bee per tier
on one broker and still have every task find exactly one taker. Use the `amqp`
backend when you want several workers sharing one tier as competing consumers.

## `autoDiscoverOllama` is deprecated

Still parsed so an older config keeps loading — the worker warns once — but
ignored. It used to turn every model installed in local Ollama into an advertised
capability, which meant the hive decided for itself what it could do: stamping
one configured runtime onto every model, and changing its promises whenever
someone ran `ollama pull`. Declare the agents you harnessed under `capabilities:`
instead.

## Preflight: nothing is advertised that would fail on dispatch

At startup a bee checks each configured capability against the machine it is
actually on:

- A capability whose CLI, API key or model is **missing** is **dropped**, with
  the reason printed.
- One that will run but **degrade** — agent binary absent, model can't do tool
  calls — is **kept and flagged**.

So the same config files work on a fully-equipped laptop and a bare one, and the
roster the Queen sees is always a roster of things that will actually run.

## The six example bees

`demo/workers/` holds one config per bee class, each owning exactly one tier:

| File | Bee | Tier |
|---|---|---|
| `honey-bee.yaml` | 🍯 official agent on a prepaid seat | 1 |
| `metered-bee.yaml` | 💵 per-token API | 2 |
| `metered-bee-frontier.yaml` | 💵 the same, on the frontier model profile | 2 |
| `local-bee.yaml` | 🏠 local Ollama model | 3 |
| `personal-bee.yaml` | 🏡 the user's agent over local personal data | 3 |
| `worker-bee.yaml` | 🐝 hardcoded tools, no LLM | 4 |

Each file's comments explain the choices it makes; `personal-bee.yaml` in
particular is worth reading for how `agent:` behaves as a preference rather than
a pin.
