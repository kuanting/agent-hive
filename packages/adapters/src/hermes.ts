// How we drive the Hermes CLI, in one place — both the ollama-agent and the
// personal-agent shell out to it and must agree on the invocation.
//
// Hermes is interactive by default. The non-interactive surface is
// `hermes chat -q <query>`; `-Q` (quiet) suppresses the banner, spinner and
// tool previews so stdout is just the final answer, which is what an adapter
// can capture. There is no `hermes run` subcommand.
//
// Hermes always advertises tools to the model, so the model must support tool
// calling: gemma4, qwen3.5 and gpt-oss all do, but not every local model does.
// Ollama answers HTTP 400 "does not support tools" for one that cannot, and
// `-t ""` does not suppress them. On a tools-incapable model the adapter's own
// fallback chain takes over, which is the intended degradation.

/** The Hermes binary. Override with HERMES_CMD (name on PATH or absolute path). */
export function hermesCmd(): string {
  return process.env.HERMES_CMD ?? "hermes";
}

/**
 * Argv for one non-interactive Hermes run.
 *
 * The provider defaults to `ollama` because every hive tier that reaches for
 * Hermes is serving a locally-installed Ollama model; HERMES_PROVIDER=auto (or
 * any other name from the user's Hermes config) overrides it, and an empty
 * value leaves the choice to Hermes' own default.
 */
export function hermesArgs(query: string, model: string): string[] {
  const args = ["chat", "-q", query, "-m", model, "-Q"];
  const provider = process.env.HERMES_PROVIDER ?? "ollama";
  if (provider) args.push("--provider", provider);
  return args;
}
