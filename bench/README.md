# bench — measuring the hive

The repo's thesis is that routing work to the cheapest adequate capability costs
less without costing quality. This directory is where that claim gets tested
against something other than a demo script.

It is deliberately **not** a second test suite. `npm test` asserts correctness in
two seconds against fake buses; everything here runs slowly, spends real money or
GPU time, and produces *data* rather than pass/fail. The two answer different
questions and should never share a runner.

## Why this lives in the hive's own repo

A benchmark harness reads `TaskSpec`, `CapabilityRecord`, `TaskResult` and the
episode log. Those change — extensively, and recently. In-repo, a schema change
breaks the harness at `tsc` time in the same commit that caused it; in a separate
repo it breaks silently and you discover it weeks later in a run whose numbers
you can no longer explain.

A result is a claim of the form *"agent-hive at commit X, config Y, benchmark Z,
date D → N% at $M"*. That claim binds a hive commit. Living here means the
binding is free instead of a submodule pin somebody forgets to bump.

What does **not** live here:

- **Results.** They go to `data/bench/<run-id>/`, which is gitignored. A few
  hundred benchmark tasks is hundreds of MB of traces, and once committed it is
  in every clone forever. Publish the runs you cite as release artifacts.
- **The benchmarks themselves.** SWE-bench and friends drag in Python, conda and
  Docker images. Run them as external processes; this harness orchestrates and
  collects. Keeping their dependency graphs out is the whole reason this can sit
  in a clean Node repo.

## The setup this is built around

Most public agent benchmarks already speak OpenAI, and so does the hive. So
pointing one at it is two environment variables:

```bash
export OPENAI_BASE_URL=http://localhost:4100/v1
export OPENAI_API_KEY=sk-lab-kt          # matches HIVE_API_KEYS
```

Every response carries an `x_hive` block naming the tier, the bee, the model and
`cost_usd` for that call — so an unmodified third-party harness yields per-request
cost attribution for free.

That also hands you the ablation axis. `hive/auto` is the router's own choice;
every other model id is one capability, pinned. Running the same task set against
`hive/auto` and against each capability by name gives a cost/quality frontier
where the only variable is routing.

## Provenance first

`src/provenance.ts` writes a run record before any task executes: commit SHA and
whether the tree was dirty, a hash of the resolved config, the fleet as
`/v1/models` reported it, and the wall-clock window. Per-task outcomes append to
`results.jsonl` as they finish.

This exists first, and on purpose. A number without the commit and config that
produced it cannot be reproduced, and retrofitting provenance means re-running
everything you have already paid for.

```bash
npm run bench -- bench/configs/smoke.yaml
```

Writes `data/bench/<run-id>/{run.json,results.jsonl}`.

## What is here, and what is not

Here: provenance, a client that records `x_hive` per call, a runner that walks a
task file, and example config matrices.

Not here: adapters for specific benchmarks (SWE-bench, GAIA, τ-bench, …). Those
are shaped by which benchmark you pick and what it expects of a model endpoint,
so they are better written against a real one than guessed at now. Add them as
`src/adapters/<benchmark>.ts`.

## Reading a run

`run.json` is the header — one object, everything needed to reproduce.
`results.jsonl` is one line per task: the request, the answer, and the `x_hive`
block. `npm run scoreboard` still answers the repo's own headline question (what
it cost versus what all-frontier would have cost); this is the same question
asked of a benchmark instead of a demo.
