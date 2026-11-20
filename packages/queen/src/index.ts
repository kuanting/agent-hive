import "@hive/shared/env"; // must stay first: loads .env before env-reading modules initialize
import express from "express";
import { resolve } from "node:path";
import { loadCredentials } from "@hive/link";
import { loadApiKeys, requireKey } from "./auth.js";
import { QueenCore } from "./core.js";
import { startLink } from "./link-bridge.js";
import { checkPlannerModel } from "./planner/model.js";
import { mountChatRoutes } from "./routes/chat.js";
import { mountEventRoutes } from "./routes/events.js";
import { mountOpenAiRoutes } from "./routes/openai.js";
import { mountTaskRoutes } from "./routes/tasks.js";

const ROOT = resolve(process.env.HIVE_ROOT ?? ".");
const PORT = Number(process.env.QUEEN_PORT ?? 4100);
/**
 * Loopback by default, because this API is the hive's admin surface and there is
 * no authentication yet.
 *
 * It used to bind every interface — `app.listen(PORT)` with no host — which put
 * /status (every task's title and input, confidential ones included), /events,
 * /sessions/:id and /shutdown on the network for anyone who could route to the
 * machine. Until users can be told apart, locality is what stands in for
 * authorization, so admin capability stops at this host.
 *
 * Nothing in the data plane is affected: workers reach the Queen over the broker
 * and never call this API. Opening it up is a deliberate act with a warning
 * attached, not the default nobody chose.
 */
const HOST = process.env.QUEEN_HOST ?? "127.0.0.1";

async function main() {
  // Say up front whether the Queen can actually think. Checked at boot, not on
  // the first chat turn, so a misconfigured planner is visible before anyone
  // relies on it — and never silently papered over with a different model.
  // Ahead of the bus connection on purpose: it is a pure local probe, and an
  // operator debugging a broker outage should still learn about this one.
  await checkPlannerModel();

  const core = await QueenCore.create(ROOT);

  // The Hive Link: an outbound socket to iBuddys, when this box is enrolled (or
  // HIVE_LINK_URL + HIVE_LINK_TOKEN are set). It is the box's only remote
  // surface, which is why the HTTP API below can stay on loopback.
  const linkCreds = loadCredentials(ROOT);
  if (linkCreds) {
    startLink(core, ROOT, linkCreds);
    console.log(`[queen] hive link: dialing ${linkCreds.url} as box ${linkCreds.boxId}`);
  }

  const app = express();
  // Raised from 256kb for the OpenAI surface: an agent client re-sends its whole
  // transcript plus every tool schema on every turn, and a few loops of that is
  // routinely past the old cap. Still a cap — an unbounded body is how one
  // caller takes the Queen down for everyone.
  app.use(express.json({ limit: process.env.HIVE_MAX_BODY ?? "4mb" }));
  const apiKeys = loadApiKeys();

  // ---- structured intake ----
  mountTaskRoutes(app, core, apiKeys);

  // Guarded for the same reason /v1 is: this returns every task's title and
  // input, so the moment the Queen is reachable by more than one person,
  // "locality stands in for authorization" stops being true. With no keys
  // configured it passes through, which keeps the loopback default working.
  app.get("/status", requireKey(apiKeys), (_req, res) => res.json(core.status()));

  // ---- stop the whole hive, on purpose ----
  //
  // The only thing in the hive that stops other machines, so it is the only
  // route that is guarded. Two cheap gates rather than an auth system (DESIGN §1
  // lists auth as a non-goal): loopback only, so it is not reachable from the
  // network a fleet is spread across, and an explicit confirm field, so no stray
  // curl, browser preflight or link-prefetch can trip it.
  //
  // Note what does NOT do this: the Queen's own SIGINT. Restarting the control
  // plane must leave the fleet running — see QueenCore.shutdownHive.
  app.post("/shutdown", async (req, res) => {
    const addr = req.socket.remoteAddress ?? "";
    const local = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
    if (!local) {
      return res.status(403).json({ error: "shutdown is loopback-only", from: addr });
    }
    if (req.body?.confirm !== "shutdown") {
      return res.status(400).json({ error: 'send {"confirm":"shutdown"} to stop the hive' });
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : undefined;

    // Answer before leaving: the caller is about to lose the server it is
    // talking to, and "connection reset" is a poor way to learn it worked.
    const outcome = await core.shutdownHive(reason);
    res.json({ stopped: true, ...outcome });
    res.on("finish", () => setTimeout(() => process.exit(0), 100).unref());
  });

  // ---- conversational Queen ----
  mountChatRoutes(app, core, ROOT, apiKeys);

  // ---- the hive as an LLM: OpenAI-compatible intake ----
  // The map from above, not a second parse of the same variable: one grammar,
  // read once, so a gateway marker cannot mean different things on two routes.
  mountOpenAiRoutes(app, core, apiKeys);

  // ---- live narration for the console's Activity view ----
  mountEventRoutes(app, core);

  app.listen(PORT, HOST, () => {
    console.log(`[queen] intake API + chat + /v1 (OpenAI-compatible) on ${HOST}:${PORT}`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
      // Keys change what this warning should say, but not by much: they gate
      // /v1 and /status, and /chat is still wide open. Naming exactly what is
      // covered beats a blanket warning people learn to scroll past.
      const gateways = [...apiKeys.values()].filter((c) => c.gateway).length;
      console.warn(
        apiKeys.size
          ? `[queen] listening on ${HOST}. /v1, /tasks, /chat, /sessions and /status require a bearer key; ` +
              `/events does NOT. Keys identify and budget callers — they do not isolate them from each other: ` +
              `/status still returns every task's input, and artifacts are a shared directory.` +
              (gateways
                ? ` ${gateways} key${gateways === 1 ? " is a gateway" : "s are gateways"}, and may name ` +
                  `the user each request is for — so anything that can reach that key can spend as anyone.`
                : "")
          : `[queen] WARNING: listening on ${HOST}, so this API is reachable from the network ` +
              `with no authentication: /status returns every task's input, /v1 and /chat spend the ` +
              `budget, and /shutdown stops the fleet. Set HIVE_API_KEYS, or expose it only on a trusted network.`,
      );
    }
  });
}

main().catch((err) => {
  console.error("[queen] fatal:", err);
  process.exit(1);
});
