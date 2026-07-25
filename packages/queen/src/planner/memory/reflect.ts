import { detect, type TurnFacts } from "./detect.js";
import type { MemoryStore } from "./store.js";
import { trustOf, type FeedbackKind, type MemoryRecord } from "./types.js";

/** One bad turn must not be able to spam the corpus. */
const MAX_WRITES_PER_TURN = 2;

export interface LearnedMemory {
  id: string;
  type: string;
  name: string;
  observed: number;
  isNew: boolean;
  trust: number;
  retired: boolean;
}

export interface ReflectInput extends TurnFacts {
  customerId: string;
  /** true when any task in this plan was confidential — see below */
  confidential: boolean;
  /** true when the "plan" was fabricated because the planner model was unreachable */
  plannerDegraded: boolean;
  /** memories injected into this turn's prompt, for scoring whether they worked */
  recalled?: MemoryRecord[];
}

/**
 * Did the memories we put in front of the planner actually change anything?
 *
 * The detector ids are the answer, and they were already there. A pitfall's id
 * encodes its structural cause, so if `mt-csv-report-csv` was recalled and D1
 * fires again producing that same id, the planner was told and did it anyway —
 * direct evidence against that specific memory. No guessing, and no punishing
 * the two unrelated memories that happened to share the turn.
 *
 * Feedback follows falsifiability, which is why the types differ:
 *
 *   pitfall   symmetric. Its claim is self-checking — "this detector should not
 *             fire again" — so both outcomes are informative.
 *   playbook  positive only. Re-detection confirms the shape recurred cleanly,
 *             but NON-detection is ambiguous (the request may simply have been
 *             different). Scoring that as a misfire would just be "the turn
 *             went badly, blame everything recalled" wearing a hat, and it
 *             would corrupt what trust means for pitfalls too.
 *   fact      never auto-graded. It is operator-written; the Queen does not get
 *             to mark its human's homework.
 *
 * Being recalled is the applicability test: recall already required trigger
 * overlap with the message. That is imperfect — a pitfall about CSVs can be
 * recalled on a turn where no reporting task existed, and would then be
 * credited for a success it had no part in. The error is deliberately biased
 * safe: false credit merely keeps a memory alive, whereas a false *misfire*
 * needs the exact same detector id to fire again, which is precise.
 */
function scoreRecalled(
  recalled: MemoryRecord[],
  detectedIds: Set<string>,
  facts: TurnFacts,
): { feedback: Array<[string, FeedbackKind]>; obsolete: string[] } {
  const feedback: Array<[string, FeedbackKind]> = [];
  const obsolete: string[] = [];

  for (const m of recalled) {
    // A lesson whose detector can no longer fire is not a lesson that works —
    // it is a lesson that has become unfalsifiable, and crediting it would let
    // trust climb to 1.0 forever while its advice quietly went stale. Worse,
    // retirement needs misfired >= 3, which such a memory can never reach. Its
    // advice is also now actively wrong, so retire it rather than grade it.
    if (isObsolete(m, facts)) {
      obsolete.push(m.id);
      continue;
    }
    const reDetected = detectedIds.has(m.id);
    if (m.type === "pitfall") feedback.push([m.id, reDetected ? "misfired" : "helped"]);
    else if (m.type === "playbook" && reDetected) feedback.push([m.id, "helped"]);
  }
  return { feedback, obsolete };
}

/**
 * Has the world moved on under this memory? Checked against live state, so a
 * config change or a newly-registered worker invalidates the note that
 * described the old world instead of silently making it unkillable.
 */
function isObsolete(m: MemoryRecord, f: TurnFacts): boolean {
  // us-<tag>: minted because no worker advertised <tag>. If one does now, the
  // note ("the hive has no X skill") is simply false.
  const unknownSkill = /^us-(.+)$/.exec(m.id);
  if (unknownSkill) {
    const live = new Set(f.liveSkills.map((s) => s.toLowerCase()));
    return [...live].some((s) => s.replace(/[^a-z0-9]+/g, "-") === unknownSkill[1]);
  }

  // mt-<toolId>-<keys>: minted against a tool's required keys. If the customer
  // dropped the tool or changed its schema, this exact id can never be
  // produced again and the advice no longer reaches tier 4.
  const missedTool = /^mt-(.+)$/.exec(m.id);
  if (missedTool) {
    return !f.tools.some((t) => missedTool[1].startsWith(t.toolId) &&
      t.requiredKeys.every((k) => missedTool[1].includes(k)));
  }

  return false;
}

/**
 * Turn a finished plan into memory.
 *
 * Two rules carry most of the weight here:
 *
 * 1. Detectors observe deterministically; the model only ever phrases. Four of
 *    the five detectors are templated from customers/*.yaml values and cost
 *    nothing. Only a novel clean multi-step plan spends one local call, and its
 *    dedupe check runs *before* that call, so a repeated shape is free too.
 *
 * 2. A confidential turn writes nothing at all. "Structural lessons only" does
 *    not survive following the taint: triggers derive from the user's message,
 *    titles derive from it, and even skill tags can (a tag could name a
 *    project). What is left untainted is toolIds and required key names — and a
 *    memory built only from those has an empty trigger set, so recall's overlap
 *    gate would never surface it. A memory that can never be recalled is not
 *    worth the risk of writing.
 */
export async function reflect(
  input: ReflectInput,
  store: MemoryStore,
  phrase?: (prompt: string) => Promise<{ text: string; costUsd: number }>,
): Promise<{ learned: LearnedMemory[]; costUsd: number }> {
  const empty = { learned: [], costUsd: 0 };
  if (input.confidential) return empty;
  // A fabricated single-task plan is not evidence of anything; without this
  // every offline turn would mint the same bogus under-decomposition lesson.
  if (input.plannerDegraded) return empty;

  try {
    const detected = detect(input);
    const detectedIds = new Set(detected.map((o) => o.id));

    // Score the recalled memories FIRST, against the state that existed when
    // they were recalled — before this turn's upserts bump anything. A misfire
    // must be recorded against the record the planner actually saw.
    const { feedback, obsolete } = scoreRecalled(input.recalled ?? [], detectedIds, input);
    for (const [id, kind] of feedback) store.recordFeedback(input.customerId, id, kind);
    for (const id of obsolete) store.retire(input.customerId, id, "the hive changed under it");

    const observations = detected.slice(0, MAX_WRITES_PER_TURN);
    if (observations.length === 0) return empty;

    const learned: LearnedMemory[] = [];
    let costUsd = 0;

    for (const obs of observations) {
      // Dedupe before phrasing: a shape we have already seen costs zero tokens.
      const known = store.load(input.customerId).some((m) => m.id === obs.id);

      if (!known && obs.phrasePrompt && phrase) {
        try {
          const said = await phrase(obs.phrasePrompt);
          costUsd += said.costUsd;
          const line = said.text.trim();
          // The template is always present; the model only ever improves on it.
          if (line) obs.name = line;
        } catch {
          /* keep the deterministic sentence — the Queen still learns with no model running */
        }
      }

      const written = store.upsert(input.customerId, obs);
      if (written) learned.push(toLearned(written.record, written.isNew));
    }

    return { learned, costUsd };
  } catch (err) {
    // Reflection can never fail a turn. The user already has their answer.
    console.warn(`[queen] reflection failed: ${String(err).slice(0, 200)}`);
    return empty;
  }
}

function toLearned(m: MemoryRecord, isNew: boolean): LearnedMemory {
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    observed: m.observed,
    isNew,
    trust: trustOf(m),
    retired: m.retired,
  };
}
