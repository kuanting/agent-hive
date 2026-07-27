import { describe, expect, it } from "vitest";
import { pickRouteSkill } from "../src/core.js";

describe("pickRouteSkill", () => {
  it("prefers a skill the capability shares with the task", () => {
    expect(pickRouteSkill(["email", "daily-report"], ["email", "files", "calendar"])).toBe("email");
  });

  it("falls back to the capability's own first skill when none overlap", () => {
    // The personal bee (bindGeneral:false) binds only its own skills, so an
    // untagged task routed to it must land on one of those, not "general".
    expect(pickRouteSkill([], ["email", "files"])).toBe("email");
    expect(pickRouteSkill(["coding"], ["email", "files"])).toBe("email");
  });

  it("uses 'general' only when the capability advertises no skills", () => {
    expect(pickRouteSkill(["coding"], [])).toBe("general");
  });
});
