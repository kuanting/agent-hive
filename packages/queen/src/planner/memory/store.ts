import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  MemoryRecord,
  MAX_EVIDENCE,
  MAX_TRIGGERS,
  RETIRE_MISFIRES,
  RETIRE_TRUST,
  trustOf,
  type FeedbackKind,
  type Observation,
} from "./types.js";
import { sanitizeBody, sanitizeName } from "./sanitize.js";

// Read per call rather than at import, so the cap is the one in force now and
// not the one that happened to be set when the first importer loaded. Same
// correction as `episode.ts`'s rotation limits, and for the same reason: a test
// that sets HIVE_MEMORY_MAX_FILES in its body was silently getting 32, so it had
// to write 34 real files to reach an eviction it could have reached with six.
const maxMemories = (): number => Number(process.env.HIVE_MEMORY_MAX_FILES ?? 32);

/**
 * Learned memory on disk: one fact per markdown file, YAML frontmatter plus a
 * short body, under data/memory/<customerId>/.
 *
 * It lives in data/ for the same reasons data/ledger.json does — derived state
 * that rebuilds itself, per-deployment rather than per-repo — and one more that
 * decides it: memory is LLM-authored. Checking it in would let a pull request
 * poison every clone's planner prompt, turning prompt injection into a supply
 * chain problem. Runtime-only keeps the blast radius on one machine.
 *
 * The files are the source of truth. INDEX.md is a regenerated human-readable
 * mirror, which is what keeps index-vs-file drift from being possible at all.
 */
export class MemoryStore {
  constructor(private readonly root: string) {}

  private dir(customerId: string): string {
    return join(this.root, customerId);
  }

  /**
   * Ids that were retired, kept apart from the records themselves.
   *
   * The `retired` flag on a record cannot do this job alone: eviction deletes
   * records, so once the corpus reaches MAX_MEMORIES the retired record is
   * shed, the next detection finds no file, and the Queen mints the lesson
   * fresh with retired=false — the exact learn/retire/relearn cycle the flag
   * was meant to prevent. A list of ids is small enough to keep forever.
   */
  private tombstonePath(customerId: string): string {
    return join(this.dir(customerId), "retired.json");
  }

  private tombstones(customerId: string): Set<string> {
    try {
      const raw = JSON.parse(readFileSync(this.tombstonePath(customerId), "utf8")) as unknown;
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }

  private tombstone(customerId: string, id: string): void {
    const ids = this.tombstones(customerId);
    if (ids.has(id)) return;
    ids.add(id);
    try {
      mkdirSync(this.dir(customerId), { recursive: true });
      writeFileSync(this.tombstonePath(customerId), JSON.stringify([...ids].sort(), null, 2));
    } catch {
      /* best effort; the flag on the record still covers the common case */
    }
  }

  /**
   * Every valid memory for a customer. One malformed file is skipped with a
   * warning and never takes the turn down with it — these files are machine
   * written and hand editable, so bad input is expected, not exceptional.
   */
  load(customerId: string): MemoryRecord[] {
    const dir = this.dir(customerId);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
    } catch {
      return [];
    }

    const out: MemoryRecord[] = [];
    for (const f of files) {
      try {
        const rec = parseMemoryFile(readFileSync(join(dir, f), "utf8"), customerId);
        if (rec) out.push(rec);
        else console.warn(`[queen] skipping malformed memory file ${f}`);
      } catch (err) {
        console.warn(`[queen] skipping unreadable memory file ${f}: ${String(err).slice(0, 120)}`);
      }
    }
    return out;
  }

  /**
   * Record an observation, keyed on its structural cause.
   *
   * Dedupe is by Observation.id — "tool csv-report was missed on key csv" — not
   * by wording. Trigger-set equality would almost never match and the corpus
   * would fill with near-duplicates forever. A repeat bumps `observed`, unions
   * in new triggers, appends the task id, and leaves the body alone: zero
   * tokens, one file, however many times it recurs.
   *
   * The read-modify-write is synchronous with no await in between, so two
   * concurrent SSE turns cannot lose a bump. That is the same property
   * BudgetLedger.save relies on — and an await slipped in here later would
   * silently break it.
   */
  upsert(customerId: string, obs: Observation): { record: MemoryRecord; isNew: boolean } | undefined {
    const name = sanitizeName(obs.name);
    const body = sanitizeBody(obs.body);
    if (name.rejected || body.rejected || !name.text) return undefined;

    const dir = this.dir(customerId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${obs.id}.md`);
    const now = new Date().toISOString();

    let existing: MemoryRecord | undefined;
    let unparseable = false;
    if (existsSync(path)) {
      try {
        existing = parseMemoryFile(readFileSync(path, "utf8"), customerId) ?? undefined;
      } catch {
        existing = undefined;
      }
      // A file that is present but will not parse must NOT be treated as
      // absent: the `else` branch below would rebuild it with retired=false
      // and the counters zeroed, quietly un-retiring a rejected lesson. A hand
      // edit that trips the sanitizer is enough to trigger this.
      unparseable = existing === undefined;
    }

    // A retired lesson stays retired. The detector that minted it is still
    // watching, so without this the cause recurring is enough to resurrect it.
    if (!existing && (unparseable || this.tombstones(customerId).has(obs.id))) {
      return undefined;
    }

    const record: MemoryRecord = existing
      ? {
          ...existing,
          // observed keeps counting even for a retired memory: the cause really
          // did recur, and that fact is not up for revision. What retirement
          // withdraws is the memory's place in the prompt, not the truth of
          // its observation.
          observed: existing.observed + 1,
          lastSeen: now,
          triggers: [...new Set([...existing.triggers, ...obs.triggers])].slice(0, MAX_TRIGGERS),
          skills: [...new Set([...existing.skills, ...obs.skills])].slice(0, MAX_TRIGGERS),
          evidence: [...new Set([...existing.evidence, ...obs.evidence])].slice(-MAX_EVIDENCE),
        }
      : {
          id: obs.id,
          type: obs.type,
          customerId,
          source: obs.source,
          name: name.text,
          description: obs.description.slice(0, 300),
          triggers: [...new Set(obs.triggers)].slice(0, MAX_TRIGGERS),
          skills: [...new Set(obs.skills)].slice(0, MAX_TRIGGERS),
          observed: 1,
          firstSeen: now,
          lastSeen: now,
          evidence: obs.evidence.slice(-MAX_EVIDENCE),
          body: body.text,
          recalled: 0,
          helped: 0,
          misfired: 0,
          retired: false,
        };

    writeFileSync(path, serializeMemoryFile(record));
    // One corpus read for both, and it has to happen after the write above so
    // the record being upserted is part of what eviction ranks.
    this.writeIndex(customerId, this.evict(customerId));
    return { record, isNew: !existing };
  }

  /**
   * Record whether a recalled memory actually worked.
   *
   * This is the counterweight to `observed`. Without it the corpus can only
   * ever become more certain: a lesson gets recalled, the planner ignores it,
   * the detector fires again, and the bump to `observed` *raises* the rank of
   * the memory that just failed. Here a re-detection is read for what it is —
   * evidence against.
   *
   * Synchronous read-modify-write with no await in between, matching upsert
   * and BudgetLedger.save. Two concurrent turns can still race logically (both
   * crediting from the same starting value), which is acceptable: counters are
   * approximate and every threshold that reads them is smoothed.
   */
  recordFeedback(customerId: string, id: string, kind: FeedbackKind): MemoryRecord | undefined {
    const path = join(this.dir(customerId), `${id}.md`);
    if (!existsSync(path)) return undefined;

    let record: MemoryRecord | undefined;
    try {
      record = parseMemoryFile(readFileSync(path, "utf8"), customerId) ?? undefined;
    } catch {
      return undefined;
    }
    if (!record) return undefined;

    const updated: MemoryRecord = {
      ...record,
      recalled: record.recalled + 1,
      helped: record.helped + (kind === "helped" ? 1 : 0),
      misfired: record.misfired + (kind === "misfired" ? 1 : 0),
    };
    // Only pitfalls can be retired this way: theirs is the falsifiable claim
    // ("this detector should not fire again"), so a misfire is real evidence.
    if (
      updated.type === "pitfall" &&
      updated.misfired >= RETIRE_MISFIRES &&
      trustOf(updated) < RETIRE_TRUST &&
      !updated.retired
    ) {
      updated.retired = true;
      this.tombstone(customerId, id); // survives eviction of the record itself
      console.log(`[queen] retiring memory ${id}: ${updated.misfired} misfires, trust ${trustOf(updated).toFixed(2)}`);
    }

    writeFileSync(path, serializeMemoryFile(updated));
    this.writeIndex(customerId);
    return updated;
  }

  /**
   * Retire a memory outright, without waiting for it to accumulate misfires.
   * Used when a lesson has become obsolete rather than merely ineffective —
   * a memory describing a world that no longer exists cannot be disproved by
   * its own detector, so the misfire route would never reach it.
   */
  retire(customerId: string, id: string, reason: string): void {
    const path = join(this.dir(customerId), `${id}.md`);
    this.tombstone(customerId, id);
    if (!existsSync(path)) return;
    try {
      const record = parseMemoryFile(readFileSync(path, "utf8"), customerId);
      if (!record || record.retired) return;
      writeFileSync(path, serializeMemoryFile({ ...record, retired: true }));
      this.writeIndex(customerId);
      console.log(`[queen] retiring memory ${id}: ${reason}`);
    } catch {
      /* best effort — the tombstone above already blocks re-minting */
    }
  }

  /**
   * Cap the corpus. Rank by observations decayed on a 30-day half-life and
   * weighted by trust, so the first things shed are the lessons that were
   * tried and did not work — ahead of ones that are merely old.
   *
   * @returns the records that survived, so the caller does not have to re-read
   * the directory to find out. Every write used to load and zod-parse the whole
   * corpus twice — once here and once in `writeIndex` — for two answers that
   * differ only by the files this method just deleted.
   */
  private evict(customerId: string): MemoryRecord[] {
    const records = this.load(customerId);
    const cap = maxMemories();
    if (records.length <= cap) return records;

    const now = Date.now();
    const score = (m: MemoryRecord) => {
      const ageDays = (now - Date.parse(m.lastSeen || m.firstSeen || "")) / 86_400_000;
      // Keep what is likely to help in future, which is (helped, trust) — not
      // `observed`. Weighting by observed had the same inversion as ranking
      // did: a memory the planner kept ignoring accumulated observations and
      // so survived eviction *longer* than an untried one.
      const worth = (1 + m.helped) * Math.pow(0.5, (Number.isFinite(ageDays) ? ageDays : 0) / 30);
      return worth * trustOf(m);
    };
    const ranked = [...records].sort((a, b) => score(a) - score(b));
    const doomed = ranked.slice(0, records.length - cap);
    for (const m of doomed) {
      try {
        rmSync(join(this.dir(customerId), `${m.id}.md`), { force: true });
      } catch {
        /* best effort */
      }
    }
    return ranked.slice(doomed.length);
  }

  /**
   * Human-readable mirror. Never read back — the .md files are the truth.
   *
   * @param known the corpus, when the caller already has it in hand.
   */
  private writeIndex(customerId: string, known?: MemoryRecord[]): void {
    const records = [...(known ?? this.load(customerId))].sort((a, b) => b.observed - a.observed);
    const rows = records.map(
      (m) =>
        `| ${m.id} | ${m.type} | ${m.observed} | ${m.helped}/${m.misfired} | ${trustOf(m).toFixed(2)} | ` +
        `${m.retired ? "retired" : "active"} | ${m.lastSeen.slice(0, 10)} | ${m.name} |`,
    );
    const md = [
      `# Learned memory — ${customerId}`,
      "",
      "Written by the Queen from structural detectors. The .md files beside this",
      "one are the source of truth; this index is regenerated on every write.",
      "",
      "`observed` counts how often the cause occurred — a fact. `trust` is whether",
      "the lesson actually changed the planner's behavior when it was recalled.",
      "A retired lesson stays here for the record but is no longer put in the prompt.",
      "",
      "| id | type | observed | helped/misfired | trust | state | last seen | lesson |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
    try {
      writeFileSync(join(this.dir(customerId), "INDEX.md"), md);
    } catch {
      /* index is a convenience; never fail a turn over it */
    }
  }

  /** Drop memory for customers whose profile no longer exists, mirroring BudgetLedger.reconcile. */
  reconcile(customerIds: Iterable<string>): void {
    const keep = new Set(customerIds);

    // An empty customer list almost never means "every customer was deleted".
    // loadCustomers (core.ts) swallows any readdir failure and returns [], so a
    // misconfigured HIVE_ROOT or a transient fs error would otherwise reach
    // here and purge every customer's memory. The ledger can survive that —
    // it rebuilds from spend events — but learned memory cannot be recovered.
    // Refuse the destructive interpretation of ambiguous input.
    if (keep.size === 0) {
      console.warn("[queen] skipping memory reconcile: no customers loaded (refusing to purge on an empty list)");
      return;
    }

    let dirs: string[];
    try {
      dirs = readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return;
    }
    for (const d of dirs) {
      if (keep.has(d)) continue;
      try {
        rmSync(join(this.root, d), { recursive: true, force: true });
        console.log(`[queen] dropped memory for removed customer ${d}`);
      } catch {
        /* best effort */
      }
    }
  }
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Parse one memory file. Sanitizing on read as well as on write is deliberate:
 * a file that was clean when stored may have been hand-edited since.
 */
export function parseMemoryFile(raw: string, customerId: string): MemoryRecord | undefined {
  const m = FRONTMATTER.exec(raw);
  if (!m) return undefined;

  let front: unknown;
  try {
    front = parse(m[1]);
  } catch {
    return undefined;
  }

  const name = sanitizeName(String((front as Record<string, unknown>)?.name ?? ""));
  const body = sanitizeBody(m[2] ?? "");
  if (name.rejected || body.rejected || !name.text) return undefined;

  const parsed = MemoryRecord.safeParse({
    ...(front as Record<string, unknown>),
    customerId,
    name: name.text,
    body: body.text,
  });
  return parsed.success ? parsed.data : undefined;
}

export function serializeMemoryFile(m: MemoryRecord): string {
  const { body, ...front } = m;
  return `---\n${stringify(front).trimEnd()}\n---\n${body}\n`;
}
