import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Confines every test's scratch directory to one run-scoped folder and
    // deletes it afterwards. See vitest.globalSetup.ts for why this is done once
    // here rather than at each mkdtempSync call site.
    globalSetup: ["./vitest.globalSetup.ts"],
  },
});
