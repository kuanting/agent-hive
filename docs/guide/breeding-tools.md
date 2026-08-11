# Writing a tier-4 tool

A finding is not a saving. Once the corpus has shown you a procedure that runs
forty times a week on a model, somebody has to write the program that does it for
nothing. This page is what that takes.

`packages/adapters/src/tool/digikey.ts` is the worked example — it exists because
`npm run breed -- flows` said `digikey_search -> get_price` and what it cost, and
somebody wrote it after reading that.

## The contract

```ts
export interface HardcodedTool {
  toolId: string;
  skills: string[];
  inputSchema: z.ZodType<Record<string, unknown>>;
  run(input: Record<string, unknown>, readArtifact: (ref: string) => string, data?: ToolData): string;
}
```

That is all of it. `run` is synchronous, returns the answer as a string, and gets
three things: the validated input, a reader for artifacts passed by reference,
and — when the operator configured one — this tool's own local store.

## Three edits to register it

| Where | What |
|---|---|
| `packages/adapters/src/tool/index.ts` | an entry in `BUILTIN_TOOLS` |
| `customers/<customer>.yaml` | an entry in `tools:` — this is what makes it matchable |
| `demo/workers/worker-bee.yaml` | the `toolId` in `tools:`, so a bee actually serves it |

```yaml
# customers/breeder.yaml
tools:
  - toolId: digikey-price
    skills: [sourcing]
    requiredKeys: [part]
```

**`requiredKeys` is not the input schema, and confusing the two is the mistake
worth naming.** It lists what a task must *supply* for the match to fire. The
schema says what `run` will accept. `qty` is optional in `digikey-price`'s schema
and deliberately absent from `requiredKeys` — listing it would make every request
that did not name a quantity miss the tool and fall through to a model.

**Tools are scoped per customer.** `QueenCore.toolsFor` reads the profile, so a
tool bred from one customer's traffic belongs to that customer; routing somebody
else's task into it would be a cross-tenant path. `tool-scope.test.ts` exists
because of that.

## How a task reaches it

```ts
export function matchTool(spec: TaskSpec, tools: ToolInfo[]): ToolInfo | undefined {
  if (!spec.toolInput) return undefined;
  const keys = new Set(Object.keys(spec.toolInput));
  return tools.find(
    (t) =>
      t.requiredKeys.every((k) => keys.has(k)) &&
      (t.skills.length === 0 || t.skills.some((s) => spec.skills.includes(s))),
  );
}
```

Matching runs at the very top of `dispatch`, *before* tier mapping, and
`tierMapper` then filters tier 4 out of capability selection entirely on the
reasoning that tool matching already had its chance. So a tool is never something
the router chooses between — it either matched or the work went to a model.

Two consequences:

- **A retry skips tool matching.** An escalation is by definition the path taken
  because the cheap one did not work.
- **The conversational path fills `toolInput` on purpose.** Planner reflection
  uses `missedToolMatch` to learn the single most valuable lesson available:
  supplying these keys moves the task to tier 4, where it costs zero tokens.

## Every `throw` is a decision to spend money

A tier-4 failure escalates, and the retry skips matching — so a thrown error
inside a tool hands the question to a model. That inverts the obvious design for
"I don't have that":

```ts
// Not stocked is an ANSWER, not a malfunction.
if (!row || !sku) {
  return [
    `part: ${part} -> not in the local catalogue`,
    `catalogue holds ${Object.keys(catalog).length} part(s); this store does not cover it.`,
    asOf,
  ].join("\n");
}
```

The store is the authority on its own contents, and escalating a correct negative
hands the question to something that will confidently invent a price. What still
throws is what an operator can fix and a model cannot: missing configuration, a
missing store, a truncated file.

Say which of those it is. `digikey-price` distinguishes "no tool data root is
configured (`HIVE_TOOL_DATA_DIR`)" from "no local price store — run
`npm run scrape:digikey`", because one sends someone to the config and the other
to the schedule.

## A tool never sees a path

```ts
export interface ToolData {
  read(rel: string): string;
  readJson<T>(rel: string): T;
  list(rel?: string): DirEntry[];
  exists(rel: string): boolean;
}
```

`run` is handed input that came from a caller, and a tool given a directory would
be one `join(root, input.part)` away from serving whatever it was asked for. So
it gets an accessor closed over its root, resolved through the same sandbox the
🏡 personal bee uses — escaping it is impossible rather than discouraged, and
`exists` on a path outside the root answers "no" rather than leaking whether it
is there.

`readJson` is not just `read` plus `JSON.parse`: the sandbox truncates at its
read cap rather than throwing, which is right for prose and wrong for anything
parsed. Without that distinction you get a syntax error and go hunting for a
corrupt file that is perfectly well formed.

All tier-4 stores live under one root — `HIVE_TOOL_DATA_DIR`, default
`data/tool-data/` — with each tool owning a subdirectory.

## The scraper writes, the tool reads

The useful shape for anything the survey marks `live`:

```bash
npm run scrape:digikey     # the scheduled half, writing data/tool-data/digikey/
```

A price lookup is not a scrape. Answering by fetching would put a third party on
the critical path of a user's request — their rate limits, their latency, their
outages — and a request that waits for a scrape has not been made cheaper, only
differently expensive. Every answer carries the tick and timestamp of the
snapshot it read, so a stale store is visible rather than silent.

Writer and reader live in one file on purpose. Two files agreeing about a format
is a thing that stops being true quietly.

## Tests worth copying

| Test | Asserts |
|---|---|
| `packages/adapters/test/tool.test.ts` | the tool's own behaviour, including that a missing store and a missing config fail differently |
| `packages/queen/test/digikey-routing.test.ts` | that a task with the right `toolInput` actually lands on tier 4 |
| `packages/queen/test/tool-scope.test.ts` | that another customer's task does not |
| `packages/queen/test/breed-collapse.test.ts` | that the flow the corpus reported collapses to one free call |

The routing test is the one people skip and shouldn't. A tool that works
perfectly and is never matched is indistinguishable, in the ledger, from a tool
that was never written.

## Where this stops

The tool serves the structured intake. The agent loop that produced the finding
still cannot reach it — see
[what does not close yet](/guide/breeding#what-does-not-close-yet).
