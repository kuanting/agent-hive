# Running distributed with RabbitMQ

The large-scale path: a RabbitMQ broker with bees you can spread across hosts.
**Competing consumers mean several bees can share a tier here**, which is the one
thing the embedded broker cannot do.

```bash
npm install
docker compose up -d          # RabbitMQ (management UI: http://localhost:15672, guest/guest)

# terminal 1: the Queen (intake API + chat on :4100)
npm run queen

# terminals 2..n: one bee each, or several on the same tier
npm run worker -- demo/workers/local-bee.yaml
npm run worker -- demo/workers/honey-bee.yaml

# last terminal: the web console (http://localhost:5180)
npm run console
```

## Choosing the backend

`HIVE_BROKER` selects it, and the choice must be explicit:

- **`amqp` (RabbitMQ) is the default and the production path.**
- `mqtt` is lightweight mode. `npm run solo` sets it for you; **nothing else does.**

Lightweight mode has to be asked for by name. This used to fall back to "mqtt if
`MQTT_URL` is set", so merely leaving `MQTT_URL` in a `.env` — `demo/watch.ts`
reads it too — silently moved a Queen onto the backend with the weaker delivery
guarantee. The two genuinely differ in what they promise, so which one is running
should be a decision, never an inference.

## What the two backends actually promise

|  | RabbitMQ (`amqp`, default) | embedded Aedes (`mqtt`, lightweight) |
|---|---|---|
| ack | after the handler finishes | on receipt |
| a crashed worker's task | redelivered to a peer by the broker | gone; the Queen redispatches |
| an undelivered message | waits in its durable queue | dropped |
| retry owner | the broker, then the Queen on failure | the Queen, always |

Acking on completion is right on RabbitMQ and was catastrophic on MQTT — see
[§4 Message protocol](/DESIGN#_4-message-protocol) for the full account of why,
which is one of the better bug stories in the repository.

The Queen's reaper is gated to lightweight mode for the same reason. It is not
"amqp is fine, skip it": redispatching there would be *wrong*, because the
message is still sitting in its queue and a second copy would genuinely
double-execute on two processes that no worker-local dedup can reconcile.

## Several bees on one tier

This is the reason to run RabbitMQ. Tier queues are shared work queues —
competing consumers, prefetch 1, manual ack, dead-letter on failure — so any
worker with a matching capability record pulls from them, and adding a second
worker on the same tier adds throughput.

Under the embedded broker, two workers bound to the same tier + skill would each
receive every such task and both would execute it, because Aedes has no shared
subscriptions. The Queen warns per overlapping tier + skill key when that
invariant is broken.

## Connecting to a remote broker

```bash
AMQP_URL=amqp://user:password@host:5672        # credentials
AMQP_URL=amqps://user:password@host:5671       # TLS
```

Every worker and the Queen read the same variable. Workers reach the Queen only
over the broker — they never call its HTTP API — so a bee on another host needs
`AMQP_URL` and nothing else.

::: warning Do not follow it by exposing the Queen
It is tempting to set `QUEEN_HOST=0.0.0.0` once bees are on other machines. Don't:
the bees don't need it, and it is the one change that puts `/chat`, `/events` and
`/tasks` on the network — none of which a bearer key covers. Only `/v1` and
`/status` are gated, and `/shutdown` refuses anything but loopback. See
[which routes are guarded](/reference/http-api#which-routes-are-guarded).
:::

## Verifying the routing

The console shows a live task card per step with its tier, runtime, model, cost
and `degraded` marker; the CLI prints the same events.

```bash
curl -s localhost:4100/status | jq   # bees, budgets, seat windows, planner spend
npm run watch                        # the same, live, in a terminal
```
