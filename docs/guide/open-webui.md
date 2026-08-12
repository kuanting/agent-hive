# A shared hive, with Open WebUI in front

The hive speaks OpenAI, so anything that speaks OpenAI can be its front end. That
includes [Open WebUI](https://openwebui.com), which already owns everything a
multi-user chat surface needs and the hive has no business owning: accounts
(password, OIDC, LDAP), per-user conversation storage, group-scoped model
permissions, and per-message token usage in its own analytics.

The division that makes this work: **Open WebUI counts tokens per user, the hive
counts dollars per user.** Open WebUI cannot price a hive request — `hive/auto` is
a pseudo-model whose real cost depends on a routing decision only the Queen sees —
and the hive has no interest in storing conversations. Each side keeps what it is
already the authority on.

## The one thing that needs configuring on both sides

Open WebUI holds **one** upstream key per connection. Without help, all of its
users would collapse into a single hive user, and every report would say one
person spent everything.

So the hive's key is marked as a gateway, and Open WebUI is told to forward who
each request is for:

```bash
# .env, on the Queen's host
HIVE_API_KEYS=sk-owui:aiotlab:@gateway,sk-console:aiotlab:admin
```

```bash
# Open WebUI
ENABLE_FORWARD_USER_INFO_HEADERS=true
```

That second variable is the entire bridge. Without it the hive refuses every
completion with `user_header_required` and names it in the message — which is
deliberate: a silent `unattributed` bucket is how usage tracking rots. See
[gateway keys](/reference/http-api#gateway-keys) for what a gateway key can and
cannot do.

## Run Open WebUI beside the Queen, not across a network

Point Open WebUI at `http://127.0.0.1:4100/v1` and leave `QUEEN_HOST` on
loopback. Open WebUI proxies upstream requests server-side, so this needs no CORS
work, and it is the single highest-leverage choice available:

- Users reach Open WebUI and nothing else. `/status`, which returns **every task's
  prompt text to any key holder**, is unreachable. So is the console.
- Content isolation between users is Open WebUI's job, and it already does it —
  each account sees its own conversations, in Open WebUI's own database.
- The hive's remaining shared surfaces — the flat `artifacts/` directory, global
  seat windows — are never user-facing.

What this posture does *not* fix: anyone with shell or console access on the
Queen's host still sees every prompt. That is the honest boundary, and it is why
[§10 Known gaps](/DESIGN#_10-known-gaps) still lists scoping `/status` as open.

## Settings that matter more than they look

| Setting | Value | Why |
|---|---|---|
| `TASK_MODEL_EXTERNAL` | a cheap `hive/<local-model>` id | **Do not skip this.** Open WebUI fires its own background completions per chat — title, tags, RAG query rewriting. Each becomes a hive task that can land on a prepaid seat: 2–4× the task volume, seat contention, and noise in every per-user report. |
| `HIVE_BROKER` | `amqp`, with several bees per tier | `npm run solo` forces the embedded broker, which cannot put two bees on one tier. With `HIVE_MAX_CONCURRENT_TASKS=1` that means ten users serialize, each up to `HIVE_EXEC_TIMEOUT_MS`. This is the difference between a multi-user hive and a queue. See [Distributed](/guide/distributed). |
| `HIVE_HTTP_WAIT_MS` | `120000` (default) | How long a request waits before the hive answers with a handle instead of an answer. Under Open WebUI's `AIOHTTP_CLIENT_TIMEOUT` of 300s with room to spare. |
| `HIVE_CONSOLE_KEY` | `sk-console` | The console has no key of its own; the dev-server proxy supplies this one. Without it, setting `HIVE_API_KEYS` breaks `npm run console`. |

There is **no rate limiting anywhere** in the Queen, and seat quota windows are
global, so one enthusiastic user can drain a prepaid window everyone else is
queued behind. Per-user USD allowances and seat fair-share are both open — see
[§10](/DESIGN#_10-known-gaps).

## What Open WebUI users get, and what they do not

`/v1/chat/completions` reaches `submitTask` directly. So routing, budgets, the
result cache, retries and the confidentiality gate all apply exactly as they do to
any other task — and each answer carries `x_hive` saying which bee served it, on
which tier, and what it cost.

What it deliberately skips is the planner. No memory, no DAG decomposition, no
plan guide, and **no tier-4 tool matches** — a chat completion carries a
transcript rather than a structured payload, so it has no `toolInput` to match on.
That is the accepted consequence of letting the client own the conversation, but it
means the cost story for these users rests on local bees and prepaid seats rather
than on zero-token tool matches. If you want the Queen's own planning, that lives
behind [`POST /chat`](/guide/planner).

Long tasks are worth knowing about: a request that outlives `HIVE_HTTP_WAIT_MS`
comes back as a normal assistant message naming the task and why it is waiting.
The task keeps running and is still charged to whoever asked; sending the same
request again serves the finished answer from cache rather than running it twice.

## Reading the bill

```bash
npm run breed -- usage                 # every person, most expensive first
npm run breed -- usage --user ada      # one of them
npm run breed -- usage --daily         # per UTC day
```

Cross-check against Open WebUI's own analytics: the two should agree on tokens.
Only the hive knows the dollars. Details in
[Usage corpus](/reference/usage-corpus).
