/**
 * The Hive Link wire protocol: what an on-premises Hive Box and the iBuddys
 * cloud say to each other over the one WebSocket the box opens.
 *
 * THIS FILE IS SHARED VERBATIM with iBuddys (`shared/hive-link-protocol.ts`).
 * Change it in both places, and run both repos' protocol fixture tests, which
 * parse the same JSON files under `test/fixtures/hive-link/`.
 *
 * Three rules shape every message here:
 *
 * 1. The box dials out. Nothing in the cloud can reach the box, so every
 *    request the cloud makes (assign, cancel, chat, "show me the output") rides
 *    down the socket the box keeps open, and every answer rides back up it.
 * 2. Metadata up, content on request. Task events carry status, cost and a
 *    title (masked when confidential). Outputs stay on the box and travel only
 *    as the answer to an explicit `task.content.request`, which the cloud
 *    gates on the requester being the member or the org being supervised.
 * 3. Duplicates are harmless. Commands carry a sequence number the box dedupes
 *    on; task events carry the task's whole current state plus a version, so
 *    replaying one, or receiving two out of order, cannot move a task backwards.
 *
 * Ids are opaque: `mbr_…` members, `dep_…` departments, `hbx_…` boxes. The box
 * never learns a person's name or email.
 */
import { z } from "zod";

export const LINK_PROTOCOL_VERSION = 1;
/** The path the cloud serves the link on. */
export const LINK_PATH = "/hive-link/v1";

// ---------- shared vocabulary ----------

export const MemberRole = z.enum(["owner", "manager", "employee"]);
export type MemberRole = z.infer<typeof MemberRole>;

/** When an employee must accept work someone else assigned to their agent. */
export const ApprovalPolicy = z.enum(["personal-data", "always", "never"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const LinkTaskStatus = z.enum([
  "queued",
  "awaiting-approval",
  "deferred",
  "running",
  "done",
  "failed",
  "cancelled",
  "declined",
]);
export type LinkTaskStatus = z.infer<typeof LinkTaskStatus>;

export const TERMINAL_LINK_STATUSES: readonly LinkTaskStatus[] = ["done", "failed", "cancelled", "declined"];

export const TaskOrigin = z.enum(["owner-assign", "employee-task", "schedule", "chat"]);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const DirectoryMember = z.object({
  memberId: z.string(),
  role: MemberRole,
  status: z.enum(["active", "suspended"]),
  departmentIds: z.array(z.string()).default([]),
  monthlyBudgetUsd: z.number().nullable().default(null),
  approvalPolicy: ApprovalPolicy.default("personal-data"),
});
export type DirectoryMember = z.infer<typeof DirectoryMember>;

export const DirectoryDepartment = z.object({
  departmentId: z.string(),
  slug: z.string(),
  monthlyBudgetUsd: z.number().nullable().default(null),
});
export type DirectoryDepartment = z.infer<typeof DirectoryDepartment>;

/** Who exists and what they may spend. The cloud is the source of truth; the box applies it. */
export const Directory = z.object({
  version: z.number().int(),
  org: z.object({
    orgId: z.string(),
    hiveCustomerId: z.string(),
    supervised: z.boolean(),
    monthlyBudgetUsd: z.number().nullable().default(null),
    /** the cloud model "savings vs all cloud" is priced against */
    referenceModel: z.string(),
  }),
  departments: z.array(DirectoryDepartment).default([]),
  members: z.array(DirectoryMember).default([]),
});
export type Directory = z.infer<typeof Directory>;

const Usage = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  costUsd: z.number().default(0),
  /** what the same tokens would have cost on the reference cloud model */
  counterfactualUsd: z.number().default(0),
});

/** One task as the box knows it right now. Full state, never a delta. */
export const TaskSnapshot = z.object({
  taskId: z.string(),
  clientRef: z.string().optional(),
  /** increases on every change to this task; the cloud keeps the highest it has seen */
  version: z.number().int(),
  memberId: z.string().optional(),
  departmentId: z.string().optional(),
  origin: TaskOrigin.optional(),
  assignedBy: z.string().optional(),
  status: LinkTaskStatus,
  /** what the agent says it is doing: "reading-files", "thinking", "writing" */
  phase: z.string().max(40).optional(),
  step: z.object({ n: z.number().int(), of: z.number().int().optional() }).optional(),
  /** the task's title, or "Confidential task" when it is confidential and the org is not supervised */
  title: z.string().max(300),
  sensitivity: z.enum(["normal", "confidential"]),
  urgency: z.enum(["normal", "urgent"]),
  tier: z.number().int().optional(),
  agentId: z.string().optional(),
  runtime: z.string().optional(),
  model: z.string().optional(),
  billing: z.string().optional(),
  degraded: z.boolean().default(false),
  attempts: z.number().int().default(0),
  usage: Usage,
  elapsedMs: z.number().default(0),
  durationMs: z.number().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  /** why it is waiting, or why it ended; the hive's own words, never task content */
  reason: z.string().max(300).optional(),
  hasOutput: z.boolean().default(false),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshot>;

export const WorkerSnapshot = z.object({
  agentId: z.string(),
  scope: z.enum(["shared", "member", "department"]),
  memberId: z.string().optional(),
  departmentId: z.string().optional(),
  live: z.boolean(),
  lastSeen: z.number(),
  /** task ids this bee is working on now */
  running: z.array(z.string()).default([]),
  capabilities: z
    .array(
      z.object({
        tier: z.number().int(),
        billing: z.string(),
        runtime: z.string(),
        agent: z.string().optional(),
        model: z.string().optional(),
      }),
    )
    .default([]),
});
export type WorkerSnapshot = z.infer<typeof WorkerSnapshot>;

/** One member's (or the org's, memberKey "org") totals for one UTC hour. Absolute, so the cloud replaces rather than adds. */
export const UsageBucket = z.object({
  memberKey: z.string(),
  departmentId: z.string().optional(),
  bucketStart: z.number(),
  tasks: z.number().int().default(0),
  tasksOk: z.number().int().default(0),
  tasksFailed: z.number().int().default(0),
  chatTurns: z.number().int().default(0),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  localTokens: z.number().default(0),
  cloudTokens: z.number().default(0),
  costUsd: z.number().default(0),
  counterfactualUsd: z.number().default(0),
  durationMs: z.number().default(0),
  /** tasks per tier, keyed "1".."4" */
  tierMix: z.record(z.number()).default({}),
});
export type UsageBucket = z.infer<typeof UsageBucket>;

// ---------- envelope ----------

function message<T extends string, B extends z.ZodTypeAny>(type: T, body: B) {
  return z.object({
    v: z.literal(LINK_PROTOCOL_VERSION),
    id: z.string(),
    type: z.literal(type),
    at: z.number(),
    body,
  });
}

// ---------- cloud -> box ----------

export const LinkWelcome = message(
  "link.welcome",
  z.object({
    boxId: z.string(),
    orgId: z.string(),
    serverTime: z.number(),
    /** the highest event seq the cloud has stored; the box resends anything newer */
    lastEventSeq: z.number().int().default(0),
  }),
);
export const DirectorySync = message("directory.sync", Directory);
export const TaskAssign = message(
  "task.assign",
  z.object({
    seq: z.number().int(),
    clientRef: z.string(),
    memberId: z.string(),
    assignedBy: z.string().optional(),
    origin: TaskOrigin.default("owner-assign"),
    title: z.string().max(300),
    input: z.string().max(20_000),
    skills: z.array(z.string()).default([]),
    sensitivity: z.enum(["normal", "confidential"]).default("normal"),
    urgency: z.enum(["normal", "urgent"]).default("normal"),
    /** run only in this department's sandbox */
    targetDepartmentId: z.string().optional(),
    requireApproval: z.boolean().default(false),
  }),
);
export const TaskCancel = message(
  "task.cancel",
  z.object({
    seq: z.number().int(),
    taskId: z.string().optional(),
    clientRef: z.string().optional(),
    reason: z.string().max(200).default("cancelled"),
  }),
);
export const ChatRequest = message(
  "chat.request",
  z.object({
    requestId: z.string(),
    memberId: z.string(),
    /** an OpenAI chat-completions request body, passed through */
    body: z.record(z.unknown()),
    timeoutMs: z.number().int().default(120_000),
  }),
);
export const TaskContentRequest = message(
  "task.content.request",
  z.object({
    requestId: z.string(),
    taskId: z.string(),
    requesterMemberId: z.string(),
    reason: z.enum(["self", "supervised"]),
  }),
);
export const SnapshotRequest = message("snapshot.request", z.object({}).default({}));
export const LinkAck = message("link.ack", z.object({ upToEventSeq: z.number().int() }));
export const LinkPing = message("link.ping", z.object({}).default({}));

export const CloudToBox = z.discriminatedUnion("type", [
  LinkWelcome,
  DirectorySync,
  TaskAssign,
  TaskCancel,
  ChatRequest,
  TaskContentRequest,
  SnapshotRequest,
  LinkAck,
  LinkPing,
]);
export type CloudToBox = z.infer<typeof CloudToBox>;

// ---------- box -> cloud ----------

export const LinkHello = message(
  "link.hello",
  z.object({
    boxId: z.string(),
    protocol: z.number().int(),
    hiveVersion: z.string(),
    customerId: z.string(),
    lastAppliedCommandSeq: z.number().int().default(0),
    lastEventSeq: z.number().int().default(0),
  }),
);
export const CommandAck = message(
  "command.ack",
  z.object({
    seq: z.number().int(),
    ok: z.boolean(),
    taskId: z.string().optional(),
    clientRef: z.string().optional(),
    error: z.string().max(300).optional(),
  }),
);
export const RosterSnapshot = message("roster.snapshot", z.object({ workers: z.array(WorkerSnapshot) }));
export const TaskEvent = message("task.event", z.object({ eventSeq: z.number().int(), task: TaskSnapshot }));
export const UsageRollup = message("usage.rollup", z.object({ buckets: z.array(UsageBucket) }));
export const BudgetSnapshot = message(
  "budget.snapshot",
  z.object({
    customer: z.object({ capUsd: z.number(), spentUsd: z.number() }).optional(),
    principals: z
      .array(z.object({ key: z.string(), capUsd: z.number().nullable(), spentUsd: z.number() }))
      .default([]),
  }),
);
export const ChatResponse = message(
  "chat.response",
  z.object({
    requestId: z.string(),
    ok: z.boolean(),
    status: z.number().int(),
    /** an OpenAI chat-completions response body, or an OpenAI-shaped error body */
    body: z.record(z.unknown()),
  }),
);
export const TaskContent = message(
  "task.content",
  z.object({
    requestId: z.string(),
    ok: z.boolean(),
    output: z.string().optional(),
    error: z.string().max(300).optional(),
  }),
);
export const LinkPong = message("link.pong", z.object({}).default({}));

export const BoxToCloud = z.discriminatedUnion("type", [
  LinkHello,
  CommandAck,
  RosterSnapshot,
  TaskEvent,
  UsageRollup,
  BudgetSnapshot,
  ChatResponse,
  TaskContent,
  LinkPong,
]);
export type BoxToCloud = z.infer<typeof BoxToCloud>;

/** A message body by its type, for building messages without repeating the envelope. */
export type CloudToBoxBody<T extends CloudToBox["type"]> = Extract<CloudToBox, { type: T }>["body"];
export type BoxToCloudBody<T extends BoxToCloud["type"]> = Extract<BoxToCloud, { type: T }>["body"];

let counter = 0;
/** Wrap a body in the envelope. Ids only need to be unique per sender, for logs and dedupe. */
export function envelope<T extends string, B>(type: T, body: B): { v: 1; id: string; type: T; at: number; body: B } {
  counter = (counter + 1) % 1_000_000;
  return { v: LINK_PROTOCOL_VERSION, id: `${Date.now().toString(36)}-${counter.toString(36)}`, type, at: Date.now(), body };
}

/** The bearer token a box presents: `hbx_<boxId>_<secret>`, split back apart. */
export function parseBoxToken(token: string): { boxId: string; secret: string } | undefined {
  const m = /^hbx_([A-Za-z0-9]+)_([A-Za-z0-9_-]{16,})$/.exec(token.trim());
  return m ? { boxId: m[1], secret: m[2] } : undefined;
}

export function boxToken(boxId: string, secret: string): string {
  return `hbx_${boxId}_${secret}`;
}
