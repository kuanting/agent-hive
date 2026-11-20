import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CostEstimator, TaskSpec, type TaskResult } from "@hive/shared";
import {
  LinkClient,
  LINK_PROTOCOL_VERSION,
  UsageRollups,
  type BoxToCloud,
  type BoxToCloudBody,
  type CloudToBox,
  type CloudToBoxBody,
  type Directory,
  type DirectoryMember,
  type LinkCredentials,
  type LinkTaskStatus,
  type TaskSnapshot,
  type WorkerSnapshot,
} from "@hive/link";
import type { QueenCore, TaskEvent } from "./core.js";
import { budgetKeysOf } from "./core.js";
import { completeChat, completionBody } from "./routes/openai.js";
import { isScoped } from "./registry.js";
import { isTerminal, type CallerContext, type TaskState } from "./store.js";

/** What the bridge needs from a connection. LinkClient in production, a fake in tests. */
export interface LinkTransport {
  send<T extends BoxToCloud["type"]>(type: T, body: BoxToCloudBody<T>): void;
  readonly connected: boolean;
}

export interface LinkBridgeOptions {
  root: string;
  boxId: string;
  /** the customer this box serves; replaced by the directory's once it arrives */
  customerId: string;
  hiveVersion?: string;
}

const DEFAULT_REFERENCE_MODEL = "gpt-5.4";
const CONFIDENTIAL_TITLE = "Confidential task";
/** How long finished outputs stay answerable on the box. */
const ARCHIVE_DAYS = 30;
/** Progress events for one task are sent at most this often, unless something visible changed. */
const PROGRESS_EVERY_MS = 4_000;
const ROSTER_EVERY_MS = 10_000;

interface Persisted {
  lastAppliedCommandSeq: number;
  lastEventSeq: number;
}

interface ArchivedOutput {
  taskId: string;
  memberId?: string;
  title: string;
  sensitivity: string;
  output: string;
  finishedAt: number;
}

/**
 * The Queen's side of the Hive Link: turns the cloud's commands into hive calls,
 * and the hive's events into what the cloud's dashboards show.
 *
 * It holds no authority of its own. A `task.assign` becomes an ordinary
 * `submitTask` with a member as the caller, so every rule the core enforces
 * (scope, budget, confidentiality) applies exactly as it does to any other
 * intake; the bridge only translates.
 *
 * Two things stay on the box, by construction rather than by policy:
 * - task OUTPUT. Events carry status, cost and a title. An output leaves only as
 *   the answer to a `task.content.request`, and only for the member who owns it
 *   or, when the org is supervised, for the cloud's owner view. The box checks
 *   that itself; it does not take the cloud's word for it.
 * - the confidential task's title, which is masked unless the org is supervised.
 */
export class LinkBridge {
  private readonly statePath: string;
  private readonly archiveDir: string;
  private persisted: Persisted = { lastAppliedCommandSeq: 0, lastEventSeq: 0 };
  private directory?: Directory;
  private readonly members = new Map<string, DirectoryMember>();
  /** per-task version, bumped whenever its snapshot changes */
  private readonly versions = new Map<string, { version: number; sig: string; sentAt: number }>();
  /** clientRef -> taskId, so a cancel or a retried assign can find its task */
  private readonly byClientRef = new Map<string, string>();
  /** commands already applied, so a resent one is acknowledged instead of run twice */
  private readonly acked = new Map<number, BoxToCloudBody<"command.ack">>();
  private readonly rollups: UsageRollups;
  private lastRoster = "";
  private lastBudget = "";
  private customerId: string;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe?: () => void;

  constructor(
    private readonly core: QueenCore,
    private transport: LinkTransport,
    private readonly opts: LinkBridgeOptions,
  ) {
    const linkDir = join(opts.root, "data", "link");
    this.statePath = join(linkDir, "state.json");
    this.archiveDir = join(linkDir, "results");
    this.rollups = new UsageRollups(join(linkDir, "rollups.json"));
    this.customerId = opts.customerId;
    try {
      if (existsSync(this.statePath)) this.persisted = { ...this.persisted, ...JSON.parse(readFileSync(this.statePath, "utf8")) };
    } catch {
      /* a lost state file costs a resend, which the cloud dedupes */
    }
    const savedDirectory = join(linkDir, "directory.json");
    try {
      if (existsSync(savedDirectory)) this.applyDirectory(JSON.parse(readFileSync(savedDirectory, "utf8")) as Directory, false);
    } catch {
      /* the cloud sends the directory on every connect anyway */
    }
  }

  /** Swap the transport; used when the production client is created after the bridge. */
  attach(transport: LinkTransport): void {
    this.transport = transport;
  }

  start(): void {
    this.unsubscribe = this.core.onTaskEvent((ev) => this.onTaskEvent(ev));
    const roster = setInterval(() => this.sendRoster(false), ROSTER_EVERY_MS);
    const budget = setInterval(() => this.sendBudget(false), ROSTER_EVERY_MS * 3);
    roster.unref();
    budget.unref();
    this.timers.push(roster, budget);
    this.pruneArchive();
  }

  stop(): void {
    this.unsubscribe?.();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  hello(): BoxToCloudBody<"link.hello"> {
    return {
      boxId: this.opts.boxId,
      protocol: LINK_PROTOCOL_VERSION,
      hiveVersion: this.opts.hiveVersion ?? "dev",
      customerId: this.customerId,
      lastAppliedCommandSeq: this.persisted.lastAppliedCommandSeq,
      lastEventSeq: this.persisted.lastEventSeq,
    };
  }

  /**
   * After every handshake: tell the cloud everything it might have missed.
   * Cheap and idempotent, which is why it beats tracking exactly what was lost.
   */
  onConnected(): void {
    this.sendRoster(true);
    this.sendBudget(true);
    for (const state of this.core.status().tasks as TaskState[]) {
      const full = this.core.getTask(state.taskId);
      if (full && this.reportable(full)) this.sendTask(full, true);
    }
    const buckets = this.rollups.all();
    if (buckets.length) this.transport.send("usage.rollup", { buckets });
  }

  async handle(msg: CloudToBox): Promise<void> {
    switch (msg.type) {
      case "directory.sync":
        this.applyDirectory(msg.body, true);
        return;
      case "task.assign":
        this.assign(msg.body);
        return;
      case "task.cancel":
        this.cancel(msg.body);
        return;
      case "chat.request":
        await this.chat(msg.body);
        return;
      case "task.content.request":
        this.content(msg.body);
        return;
      case "snapshot.request":
        this.onConnected();
        return;
      case "link.welcome":
      case "link.ack":
      case "link.ping":
        return;
    }
  }

  // ---------- commands ----------

  private applyDirectory(dir: Directory, persist: boolean): void {
    this.directory = dir;
    this.customerId = dir.org.hiveCustomerId;
    this.members.clear();
    for (const m of dir.members) this.members.set(m.memberId, m);
    // Budgets are the cloud's to set; the ledger is the box's to enforce.
    for (const m of dir.members) this.core.ledger.setPrincipalCap(`member:${m.memberId}`, m.monthlyBudgetUsd);
    for (const d of dir.departments) this.core.ledger.setPrincipalCap(`dept:${d.departmentId}`, d.monthlyBudgetUsd);
    if (!this.core.customer(this.customerId)) {
      console.warn(
        `[link] the cloud says this box serves '${this.customerId}', but no customers/*.yaml declares it; tasks will run uncapped`,
      );
    }
    if (persist) this.writeJson(join(this.opts.root, "data", "link", "directory.json"), dir);
  }

  /** Run a command once. A resent command (same seq) gets its original answer again. */
  private once(seq: number, run: () => BoxToCloudBody<"command.ack">): void {
    const previous = this.acked.get(seq);
    if (previous) {
      this.transport.send("command.ack", previous);
      return;
    }
    if (seq <= this.persisted.lastAppliedCommandSeq) {
      // Applied before a restart that lost the in-memory answer. Acknowledge
      // without running it again: running twice is the worse failure.
      this.transport.send("command.ack", { seq, ok: true });
      return;
    }
    const ack = run();
    this.acked.set(seq, ack);
    if (this.acked.size > 500) this.acked.delete(this.acked.keys().next().value!);
    this.persisted.lastAppliedCommandSeq = Math.max(this.persisted.lastAppliedCommandSeq, seq);
    this.savePersisted();
    this.transport.send("command.ack", ack);
  }

  private assign(body: CloudToBoxBody<"task.assign">): void {
    this.once(body.seq, () => {
      const member = this.members.get(body.memberId);
      if (this.directory && !member) {
        return { seq: body.seq, ok: false, clientRef: body.clientRef, error: "unknown member" };
      }
      if (member?.status === "suspended") {
        return { seq: body.seq, ok: false, clientRef: body.clientRef, error: "member is suspended" };
      }
      const spec = TaskSpec.parse({
        customerId: this.customerId,
        title: body.title,
        input: body.input,
        skills: body.skills,
        sensitivity: body.sensitivity,
        urgency: body.urgency,
      });
      const caller: CallerContext = {
        memberId: body.memberId,
        userId: body.memberId,
        departmentIds: member?.departmentIds ?? [],
        targetDepartmentId: body.targetDepartmentId,
        origin: body.origin,
        assignedBy: body.assignedBy,
        requireApproval: body.requireApproval,
        clientRef: body.clientRef,
      };
      const outcome = this.core.submitTask(spec, undefined, undefined, caller);
      if (outcome.cached && outcome.result) {
        // A cache hit names the ORIGINAL task, which the cloud already has under
        // another clientRef. Report this request as its own finished task.
        const taskId = `${outcome.taskId}.${body.seq}`;
        this.byClientRef.set(body.clientRef, taskId);
        this.sendCachedHit(taskId, spec, caller, outcome.result);
        return { seq: body.seq, ok: true, taskId, clientRef: body.clientRef };
      }
      this.byClientRef.set(body.clientRef, outcome.taskId);
      // submitTask emitted its events before we knew the clientRef mapping was
      // wanted; send the settled state now so the cloud has it at once.
      const state = this.core.getTask(outcome.taskId);
      if (state) this.sendTask(state, true);
      return { seq: body.seq, ok: true, taskId: outcome.taskId, clientRef: body.clientRef };
    });
  }

  private cancel(body: CloudToBoxBody<"task.cancel">): void {
    this.once(body.seq, () => {
      const taskId = body.taskId ?? (body.clientRef ? this.byClientRef.get(body.clientRef) : undefined);
      if (!taskId) return { seq: body.seq, ok: false, clientRef: body.clientRef, error: "unknown task" };
      const ok = this.core.cancelTask(taskId, body.reason);
      return { seq: body.seq, ok, taskId, clientRef: body.clientRef, error: ok ? undefined : "already finished" };
    });
  }

  private async chat(body: CloudToBoxBody<"chat.request">): Promise<void> {
    const member = this.members.get(body.memberId);
    if (this.directory && (!member || member.status !== "active")) {
      this.transport.send("chat.response", {
        requestId: body.requestId,
        ok: false,
        status: 403,
        body: { error: { message: "this member may not use the hive", type: "permission_error" } },
      });
      return;
    }
    const request = { ...body.body, model: typeof body.body.model === "string" && body.body.model.startsWith("hive/") ? body.body.model : "hive/auto" };
    const started = Date.now();
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), body.timeoutMs).unref());
    const outcome = await Promise.race([
      completeChat(this.core, request, { customerId: this.customerId, userId: body.memberId }, {
        memberId: body.memberId,
        departmentIds: member?.departmentIds ?? [],
        origin: "chat",
      }),
      timeout,
    ]);
    if (outcome === "timeout") {
      this.transport.send("chat.response", {
        requestId: body.requestId,
        ok: false,
        status: 504,
        body: { error: { message: "the agent did not answer in time", type: "timeout" } },
      });
      return;
    }
    if (!outcome.ok) {
      this.transport.send("chat.response", { requestId: body.requestId, ok: false, status: outcome.status, body: outcome.body });
      return;
    }
    // No waitMs, so the answer is the result itself; the iBuddys side keeps the deadline.
    const answer = outcome.answer;
    if ("result" in answer) this.addRollup(body.memberId, member?.departmentIds[0], answer.result, true, Date.now() - started, request);
    this.transport.send("chat.response", {
      requestId: body.requestId,
      ok: true,
      status: 200,
      body: completionBody(outcome.model, answer) as unknown as Record<string, unknown>,
    });
  }

  /**
   * Hand one finished output to the cloud, if this requester may see it.
   *
   * Checked here as well as in the cloud: the box holds the output, so the box
   * decides. A member may always read their own; anyone else only while the org
   * is supervised, which the cloud cannot switch on without the box hearing it
   * through the directory.
   */
  private content(body: CloudToBoxBody<"task.content.request">): void {
    const record = this.readArchive(body.taskId);
    const deny = (error: string) => this.transport.send("task.content", { requestId: body.requestId, ok: false, error });
    if (!record) return deny("no stored output for that task");
    const own = record.memberId !== undefined && record.memberId === body.requesterMemberId;
    const supervised = body.reason === "supervised" && this.directory?.org.supervised === true;
    if (!own && !supervised) return deny("not permitted: only the member, or an owner while supervised mode is on");
    this.transport.send("task.content", { requestId: body.requestId, ok: true, output: record.output });
  }

  // ---------- events ----------

  /** Member work the cloud should see. Chat turns are counted, not shown as tasks. */
  private reportable(state: TaskState): boolean {
    return state.spec.customerId === this.customerId && state.caller?.origin !== "chat";
  }

  private onTaskEvent(ev: TaskEvent): void {
    // "created" fires before routing has decided anything, so its snapshot says
    // "queued" for a task that is about to be deferred or refused. The routing
    // event follows synchronously; report that one.
    if (ev.kind === "created") return;
    const state = this.core.getTask(ev.taskId);
    if (!state || !this.reportable(state)) return;
    const terminal = ev.kind === "done" || ev.kind === "failed" || ev.kind === "cancelled" || ev.kind === "declined";
    if (terminal) this.finish(state, ev.result);
    this.sendTask(state, terminal || ev.kind !== "progress");
  }

  private finish(state: TaskState, result: TaskResult): void {
    if (result.ok && result.output) {
      this.writeJson(this.archivePath(state.caller?.memberId, state.taskId), {
        taskId: state.taskId,
        memberId: state.caller?.memberId,
        title: state.spec.title,
        sensitivity: state.spec.sensitivity,
        output: result.output,
        finishedAt: Date.now(),
      } satisfies ArchivedOutput);
    }
    // Cancelled and declined work is not "a task done" for anyone's numbers,
    // but money a bee spent on it still is.
    if (state.status === "done" || state.status === "failed") {
      const durationMs = (state.history ?? [result]).reduce((n, r) => n + r.durationMs, 0);
      this.addRollup(state.caller?.memberId, this.departmentOf(state.caller), result, false, durationMs, undefined, state);
    }
    this.sendBudget(false);
  }

  private addRollup(
    memberId: string | undefined,
    departmentId: string | undefined,
    result: TaskResult,
    chat: boolean,
    durationMs: number,
    request?: Record<string, unknown>,
    state?: TaskState,
  ): void {
    const attempts = state?.history?.length ? state.history : [result];
    const bucket = this.rollups.add({
      memberKey: memberId ?? "org",
      departmentId,
      at: Date.now(),
      ok: result.ok,
      chat,
      tier: result.tierUsed,
      billing: result.billing,
      inputTokens: attempts.reduce((n, r) => n + r.usage.inputTokens, 0),
      outputTokens: attempts.reduce((n, r) => n + r.usage.outputTokens, 0),
      costUsd: attempts.reduce((n, r) => n + r.usage.costUsd, 0),
      counterfactualUsd: this.counterfactual(result, state?.spec, request),
      durationMs,
    });
    this.transport.send("usage.rollup", { buckets: [bucket] });
  }

  /**
   * What this work would have cost on the org's reference cloud model: the
   * number the owner's "saved vs all cloud" is built from. One attempt, priced
   * on the tokens it really used, or on a rough count when the runtime reported
   * none (a tool, or a CLI that does not say).
   */
  private counterfactual(result: TaskResult, spec?: TaskSpec, request?: Record<string, unknown>): number {
    if (!result.ok) return 0;
    const model = this.directory?.org.referenceModel ?? DEFAULT_REFERENCE_MODEL;
    let inTok = result.usage.inputTokens;
    let outTok = result.usage.outputTokens;
    if (inTok + outTok === 0) {
      inTok = CostEstimator.roughTokens(spec ? `${spec.title}\n${spec.input}` : JSON.stringify(request?.messages ?? ""));
      outTok = CostEstimator.roughTokens(result.output);
    }
    return this.core.priceOf(model, inTok, outTok);
  }

  private departmentOf(caller?: CallerContext): string | undefined {
    return budgetKeysOf(caller)
      .find((k) => k.startsWith("dept:"))
      ?.slice(5);
  }

  private sendTask(state: TaskState, force: boolean): void {
    const snap = this.snapshot(state);
    const sig = JSON.stringify({ ...snap, version: 0, elapsedMs: 0 });
    const prev = this.versions.get(state.taskId);
    const now = Date.now();
    const changed = !prev || prev.sig !== sig;
    if (!changed && !force && now - (prev?.sentAt ?? 0) < PROGRESS_EVERY_MS) return;
    const version = changed ? (prev?.version ?? 0) + 1 : prev!.version;
    this.versions.set(state.taskId, { version, sig, sentAt: now });
    if (this.versions.size > 5_000) this.versions.delete(this.versions.keys().next().value!);
    this.persisted.lastEventSeq += 1;
    this.savePersisted();
    this.transport.send("task.event", { eventSeq: this.persisted.lastEventSeq, task: { ...snap, version } });
  }

  private sendCachedHit(taskId: string, spec: TaskSpec, caller: CallerContext, hit: TaskResult): void {
    const now = Date.now();
    this.writeJson(this.archivePath(caller.memberId, taskId), {
      taskId,
      memberId: caller.memberId,
      title: spec.title,
      sensitivity: spec.sensitivity,
      output: hit.output,
      finishedAt: now,
    } satisfies ArchivedOutput);
    this.persisted.lastEventSeq += 1;
    this.savePersisted();
    this.transport.send("task.event", {
      eventSeq: this.persisted.lastEventSeq,
      task: {
        taskId,
        clientRef: caller.clientRef,
        version: 1,
        memberId: caller.memberId,
        departmentId: this.departmentOf(caller),
        origin: caller.origin,
        assignedBy: caller.assignedBy,
        status: "done",
        title: this.titleFor(spec),
        sensitivity: spec.sensitivity,
        urgency: spec.urgency,
        tier: 4,
        runtime: "cache",
        billing: "free",
        degraded: false,
        attempts: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, counterfactualUsd: this.counterfactual(hit, spec) },
        elapsedMs: 0,
        durationMs: 0,
        startedAt: now,
        finishedAt: now,
        reason: "answered from the cache, zero tokens",
        hasOutput: true,
      },
    });
  }

  snapshot(state: TaskState): TaskSnapshot {
    const caller = state.caller;
    const r = state.result;
    const attempts = state.history?.length ? state.history : r ? [r] : [];
    const finished = isTerminal(state.status);
    const run = state.runningOn;
    return {
      taskId: state.taskId,
      clientRef: caller?.clientRef,
      version: 0,
      memberId: caller?.memberId,
      departmentId: this.departmentOf(caller),
      origin: caller?.origin,
      assignedBy: caller?.assignedBy,
      status: linkStatus(state),
      phase: finished ? undefined : state.live?.phase,
      step: finished ? undefined : state.live?.step,
      title: this.titleFor(state.spec),
      sensitivity: state.spec.sensitivity,
      urgency: state.spec.urgency,
      // A refusal or a cancel before any bee ran reports tier 4 and runtime
      // "none"; that is not a tool having run, so say nothing about where.
      tier: r && r.runtime !== "none" ? r.tierUsed : run?.tier,
      agentId: r?.agentId !== "none" ? (r?.agentId ?? run?.agentId) : run?.agentId,
      runtime: r?.runtime !== "none" ? (r?.runtime ?? run?.runtime) : run?.runtime,
      model: r?.model ?? run?.model,
      billing: r && r.runtime !== "none" ? r.billing : undefined,
      degraded: r?.degraded ?? false,
      attempts: state.attempts,
      usage: {
        inputTokens: attempts.reduce((n, a) => n + a.usage.inputTokens, 0),
        outputTokens: attempts.reduce((n, a) => n + a.usage.outputTokens, 0),
        costUsd: attempts.reduce((n, a) => n + a.usage.costUsd, 0),
        counterfactualUsd: r ? this.counterfactual(r, state.spec) : 0,
      },
      elapsedMs: (state.finishedAt ?? Date.now()) - state.startedAt,
      durationMs: finished ? attempts.reduce((n, a) => n + a.durationMs, 0) : undefined,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      reason: (finished ? (r?.error ?? state.reason) : state.reason)?.slice(0, 300) || undefined,
      hasOutput: !!(r?.ok && r.output),
    };
  }

  /** A confidential task's title stays on the box unless the org is supervised. */
  private titleFor(spec: TaskSpec): string {
    if (spec.sensitivity === "confidential" && !this.directory?.org.supervised) return CONFIDENTIAL_TITLE;
    return spec.title.slice(0, 300);
  }

  private sendRoster(force: boolean): void {
    if (!this.transport.connected && !force) return;
    const running = new Map<string, string[]>();
    for (const t of this.core.status().tasks as TaskState[]) {
      if (t.status !== "dispatched" || !t.runningOn) continue;
      running.set(t.runningOn.agentId, [...(running.get(t.runningOn.agentId) ?? []), t.taskId]);
    }
    const workers: WorkerSnapshot[] = this.core.registry.snapshot().map((w) => ({
      agentId: w.agentId,
      scope: !isScoped(w.owner) ? "shared" : w.owner?.memberId ? "member" : "department",
      memberId: w.owner?.memberId,
      departmentId: w.owner?.departmentId,
      live: this.core.registry.isLive(w.agentId),
      lastSeen: w.lastSeen,
      running: running.get(w.agentId) ?? [],
      capabilities: w.capabilities.map((c) => ({ tier: c.tier, billing: c.billing, runtime: c.runtime, agent: c.agent, model: c.model })),
    }));
    const sig = JSON.stringify(workers.map((w) => ({ ...w, lastSeen: 0 })));
    if (!force && sig === this.lastRoster) return;
    this.lastRoster = sig;
    this.transport.send("roster.snapshot", { workers });
  }

  private sendBudget(force: boolean): void {
    if (!this.transport.connected && !force) return;
    const snap = this.core.ledger.snapshot();
    const customer = snap.customers.find((c) => c.customerId === this.customerId);
    const body: BoxToCloudBody<"budget.snapshot"> = {
      customer: customer ? { capUsd: customer.capUsd, spentUsd: customer.spentUsd } : undefined,
      principals: snap.principals.map((p) => ({ key: p.key, capUsd: p.capUsd, spentUsd: p.spentUsd })),
    };
    const sig = JSON.stringify(body);
    if (!force && sig === this.lastBudget) return;
    this.lastBudget = sig;
    this.transport.send("budget.snapshot", body);
  }

  // ---------- storage ----------

  private archivePath(memberId: string | undefined, taskId: string): string {
    return join(this.archiveDir, (memberId ?? "org").replace(/[^A-Za-z0-9_-]/g, "_"), `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private readArchive(taskId: string): ArchivedOutput | undefined {
    if (!existsSync(this.archiveDir)) return undefined;
    const file = `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
    for (const dir of readdirSync(this.archiveDir)) {
      const path = join(this.archiveDir, dir, file);
      if (existsSync(path)) {
        try {
          return JSON.parse(readFileSync(path, "utf8")) as ArchivedOutput;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  private pruneArchive(): void {
    if (!existsSync(this.archiveDir)) return;
    const cutoff = Date.now() - ARCHIVE_DAYS * 86_400_000;
    for (const dir of readdirSync(this.archiveDir)) {
      const full = join(this.archiveDir, dir);
      for (const f of readdirSync(full)) {
        const path = join(full, f);
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      }
    }
  }

  private savePersisted(): void {
    this.writeJson(this.statePath, this.persisted);
  }

  private writeJson(path: string, data: unknown): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, path);
    } catch (err) {
      console.warn(`[link] could not write ${path}: ${String(err).slice(0, 120)}`);
    }
  }
}

/** The task's status in the link's vocabulary, which separates "waiting on a person" from "running". */
export function linkStatus(state: TaskState): LinkTaskStatus {
  switch (state.status) {
    case "done":
    case "failed":
    case "cancelled":
    case "declined":
    case "deferred":
      return state.status;
    case "dispatched":
      if (state.live?.state === "awaiting-approval") return "awaiting-approval";
      if (state.live?.state === "running") return "running";
      return "queued";
  }
}

/** Start the link for a running Queen. Returns the bridge, already connecting. */
export function startLink(core: QueenCore, root: string, creds: LinkCredentials): LinkBridge {
  const customerId = process.env.HIVE_LINK_CUSTOMER ?? core.customers[0]?.customerId ?? "default";
  const placeholder: LinkTransport = { send: () => {}, connected: false };
  const bridge = new LinkBridge(core, placeholder, {
    root,
    boxId: creds.boxId,
    customerId,
    hiveVersion: process.env.npm_package_version,
  });
  const client = new LinkClient({
    url: creds.url,
    token: creds.token,
    hello: () => bridge.hello(),
    onMessage: (msg) => {
      bridge.handle(msg).catch((err) => console.warn(`[link] handling ${msg.type} failed: ${String(err).slice(0, 160)}`));
    },
    onConnected: () => bridge.onConnected(),
    log: (level, text) => {
      if (level === "debug" && process.env.HIVE_LOG_LEVEL !== "debug") return;
      const line = `[link] ${text.replace(/^link: /, "")}`;
      (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
    },
  });
  bridge.attach(client);
  bridge.start();
  client.start();
  return bridge;
}
