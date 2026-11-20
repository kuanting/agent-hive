import { describe, expect, it } from "vitest";
import { TaskMessage } from "@hive/shared";
import { principalAllowed } from "../src/run.js";

/**
 * The bee's own check, behind the Queen's routing. If routing is ever wrong, or
 * a message is forged onto a scoped bee's queue, this is what stops a member's
 * desktop from running somebody else's request over its owner's files.
 */

const msg = (principal?: { memberId: string; departmentIds: string[] }) =>
  TaskMessage.parse({
    kind: "task",
    taskId: "t1",
    spec: { customerId: "sme", title: "x", input: "y" },
    envelope: { maxUsd: 0, tier: 3, allowEscalation: true, urgency: "normal" },
    difficulty: "simple",
    principal,
  });

describe("principalAllowed", () => {
  it("lets a shared bee take anyone's work, and work for no one", () => {
    expect(principalAllowed({}, msg())).toBe(true);
    expect(principalAllowed({}, msg({ memberId: "mbr_a", departmentIds: [] }))).toBe(true);
  });

  it("lets a member's bee take only that member's work", () => {
    const cfg = { ownerMemberId: "mbr_a" };
    expect(principalAllowed(cfg, msg({ memberId: "mbr_a", departmentIds: [] }))).toBe(true);
    expect(principalAllowed(cfg, msg({ memberId: "mbr_b", departmentIds: [] }))).toBe(false);
    // unstamped work is nobody's, so not this member's either
    expect(principalAllowed(cfg, msg())).toBe(false);
  });

  it("lets a department's bee take work from any member of that department", () => {
    const cfg = { departmentId: "dep_acct" };
    expect(principalAllowed(cfg, msg({ memberId: "mbr_a", departmentIds: ["dep_sales", "dep_acct"] }))).toBe(true);
    expect(principalAllowed(cfg, msg({ memberId: "mbr_b", departmentIds: ["dep_sales"] }))).toBe(false);
    expect(principalAllowed(cfg, msg())).toBe(false);
  });
});
