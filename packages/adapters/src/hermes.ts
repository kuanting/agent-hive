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

/**
 * `-Q` does not actually guarantee stdout is the answer alone.
 *
 * Hermes narrates through `agent._vprint` under an `if not agent.quiet_mode`
 * guard, which `-Q` silences — but a couple of dozen call sites in
 * `agent/conversation_loop.py` use a bare `print()` with no guard at all, and
 * Python's `print` writes to stdout. The one seen in the wild is the tool-name
 * repair at conversation_loop.py:3039, which fires whenever the model emits a
 * tool name Hermes has to fuzzy-match (`research:search_files` ->
 * `search_files`). Others are error paths: exhausted API retries, provider 401
 * blocks. Whatever fires ends up prepended to what we capture as the answer.
 *
 * So the CLI's stdout is untrusted and gets split rather than returned whole.
 * Nothing is discarded: the diagnostics travel back on `ExecResult.diagnostics`
 * and the worker logs them against the task id, which is strictly more than the
 * old code did — it dropped stderr entirely and only ever revealed a diagnostic
 * by corrupting a result.
 */
export interface HermesOutput {
  /** the model's answer, with leading CLI diagnostics removed */
  answer: string;
  /** diagnostic lines in the order emitted — for the log, never for the answer */
  diagnostics: string[];
}

/**
 * Markers that open one of Hermes' unguarded `print()` lines, after the optional
 * `log_prefix` (empty for a plain `hermes chat`, `[B1:P0] ` under the batch
 * runner, `[subagent-2] ` under delegation).
 */
const DIAGNOSTIC_LINE = /^(?:\[[^\]]{1,40}\]\s*)?(?:🔧|🔐|❌|⚠️?|🔄|📊)/u;

/** Indented continuation of a multi-line block, e.g. the 401 troubleshooting list. */
const CONTINUATION_LINE = /^\s+(?:[•\-*]|\w[\w ]{0,30}:)/u;

/**
 * Lines naming a credential. Redacted rather than dropped, so the log still
 * shows that an auth block happened without carrying the fragment itself —
 * conversation_loop.py:2025 prints the first 12 characters of the live token,
 * and a bee's output reaches results, logs and the Queen's feed.
 */
const SECRET_LINE = /token|api[_-]?key|secret|credential|password|bearer/i;

function redact(line: string): string {
  return SECRET_LINE.test(line) ? `${line.split(/[:=]/, 1)[0]}: [redacted]` : line;
}

/**
 * Split a Hermes run into its answer and its diagnostics.
 *
 * Only a *leading* run of diagnostic lines is stripped. Hermes prints these
 * during the tool loop, before the answer, so position is the reliable signal —
 * and matching on shape alone would eat a legitimate answer that happens to
 * open with a bulleted or emoji-prefixed line. A false positive is visible
 * rather than silent: the line still shows up in the bee log.
 */
export function splitHermesOutput(stdout: string, stderr = ""): HermesOutput {
  const diagnostics: string[] = [];
  const lines = stdout.split("\n");
  let i = 0;
  let sawDiagnostic = false;
  while (i < lines.length) {
    const line = lines[i];
    if (DIAGNOSTIC_LINE.test(line)) {
      diagnostics.push(redact(line.trim()));
      sawDiagnostic = true;
    } else if (sawDiagnostic && (CONTINUATION_LINE.test(line) || line.trim() === "")) {
      // Blank lines and indented bullets belong to the block above, not to the
      // answer. Without this the 401 block's bullet list survives into the result.
      if (line.trim()) diagnostics.push(redact(line.trim()));
    } else {
      break;
    }
    i++;
  }

  for (const line of stderr.split("\n")) {
    if (line.trim()) diagnostics.push(redact(line.trim()));
  }

  return { answer: lines.slice(i).join("\n").trim(), diagnostics };
}
