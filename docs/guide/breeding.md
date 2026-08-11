# Finding work a program could do

The hive records what your agents actually do — not just what they cost, but the
sequence of tools they call. Read that back and a pattern shows up: the same
procedure, over and over, running on a model every time.

That is work a program could do for nothing. Finding it is what the corpus is
for; deciding which ones are worth hardening, and writing them, is yours.

```bash
bash demo/breeding.sh          # the whole loop, end to end
```

## The loop

**Traffic goes in.** An agent asks the hive for a part price, the model asks the
caller to run `digikey_search`, the caller runs it and posts the result, the
model asks for `get_price`. Three turns, three tasks, one loop. Nobody
instruments anything.

**A query finds the procedure.**

```bash
npm run breed -- flows --customer breeder
```

```
flow                         loops  turns      cost  per loop  last seen
digikey_search -> get_price     40     80     $4.80   $0.1200  1h ago
```

This works at `metadata`, the default privacy setting, because a tool call's
*name* and its argument *key names* are structure rather than content. Argument
values are never recorded, at any fidelity. See
[the usage corpus](/reference/usage-corpus) for the schema and the views, and
[reading what repeats](/guide/breeding-survey) for the rest of the commands —
including `survey`, which ranks shapes by what they would stop costing.

**Somebody builds the thing.** A price lookup is not a scrape. The scraper runs
on a schedule and writes a local store; the tool reads it:

```bash
npm run scrape:digikey     # the cron job, writing data/tool-data/digikey/
```

Answering by fetching would put a third party on the critical path of a user's
request — their rate limits, their latency, their outages — and a request that
waits for a scrape has not been made cheaper, only differently expensive.

`packages/adapters/src/tool/digikey.ts` is the tool that came out of this,
written by reading the flow above. Adding one is three edits: an entry in
`BUILTIN_TOOLS`, one in the customer's `tools:` list, and its id in the bee's.
[Writing a tier-4 tool](/guide/breeding-tools) is the full contract.

**And the work stops costing anything.**

```
tier=4 runtime=tool:digikey-price $0.0000
```

## Two things worth knowing before you write one

**A tier-4 failure escalates, and the retry skips tool matching.** So every
`throw` inside a tool is a decision to spend money on a model instead. That
inverts the obvious design for "I don't have that": `digikey-price` returns a
*successful* "not in the local catalogue" rather than an error, because the store
is the authority on its own contents and escalating a correct negative hands the
question to something that will confidently invent a price. Missing
configuration and a missing store still throw — those an operator can fix and a
model cannot.

**A tool never sees a path.** It gets a `ToolData` accessor closed over its root,
resolved through the same sandbox the personal bee uses. `run` is handed input
that came from a caller, and a tool given a directory would be one
`join(root, input.part)` away from serving whatever it was asked for.

## What does not close yet

The tool serves the **structured intake**. The agent loop that produced the
finding still cannot reach it.

A chat completion carries a transcript, so `routes/openai.ts` builds a task with
no `toolInput`, and `matchTool` needs one. The hive *could* read
`digikey_search({part})` off the model's own reply and run its own tool instead
— and does not, because it cannot tell whether that name means the hive's tool or
yours, and a caller's `read_file` reads the caller's disk.

Four ways to close it are written down in [DESIGN §10](/DESIGN); none is chosen,
and choosing one is a decision about who owns the loop rather than a wiring job.
Beat 7 of the demo shows both routings side by side rather than describing the
gap.
