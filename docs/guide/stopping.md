# Stopping and resetting

## Stopping the hive

```bash
npm run stop            # shows what will stop, asks, then stops it
npm run stop -- --yes   # no prompt, for scripts
```

It reports how many bees will stop and whether a task is in flight, then drains
the fleet and stops the Queen last. `Ctrl-C` on `npm run solo` does the same
drain before falling back to signalling process groups.

**An in-flight task is finished first and its result published, not abandoned.**
That is a cost decision, not a politeness. A bee two minutes into a model call
has already spent those tokens; dropping the task throws the spend away *and*
leaves the Queen waiting out a timeout for a result that will never arrive, after
which it pays for the same work again. `HIVE_DRAIN_GRACE_MS` (default 60 s)
bounds it, so one wedged adapter call cannot make "stop the hive" an operation
that never finishes.

A stopping bee stops *receiving* — it cancels its subscriptions rather than
merely declining, since a declined task is a lost task on either backend —
finishes what is running, publishes those results, says goodbye, and exits.

## Why this is a command and not a button

The console has **no shutdown at all**, deliberately.

There is no user authentication yet, so admin capability is confined to the
hive's own host: a user should be able to give the hive jobs, not stop other
people's. The Queen refuses `POST /shutdown` from anything but loopback — but a
dev-server proxy forwards from its own process, so that guard cannot survive
being proxied. Removing the path is what actually enforces it.

See [Roles: admins operate the hive, users give it
jobs](/DESIGN#_1-goals-and-non-goals).

## Restarting the Queen does not stop the hive

Bees are autonomous consumers, usually on other hosts, so they keep serving
across a Queen restart **by design**. Nothing infers a shutdown from the Queen's
absence, and the Queen's own `SIGINT` deliberately publishes nothing.

Stopping is an *order*, never an inference. That order is the `queen.shutdown`
message, and `npm run stop` (or [`POST /shutdown`](/reference/http-api#post-shutdown))
is how an operator gives it.

## Resetting demo state

The budget ledger — spend plus seat-window state — persists to `data/ledger.json`
and reloads on startup. To start fresh, stop the hive and run:

```bash
npm run reset             # clear the budget ledger
npm run reset -- --memory # also clear what the Queen has learned
npm run reset -- --all    # also clear the artifact store and learned memory
```

The ledger rebuilds from `customers/*.yaml` on the next Queen start.

**Plan guides are hand-authored configuration and are never removed** by any of
these. Learned memory is the Queen's own writing and is; the distinction is the
same one that runs through the whole system — see
[YAML is authority, markdown is advice](/guide/memory).
