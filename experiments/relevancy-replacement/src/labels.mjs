/**
 * Label mapping: dataset labels (ESCI, WANDS) -> Cortex's RELEVANCE_SCALE (0-3).
 *
 * The four target values are NEVER re-typed here. This module imports
 * RELEVANCE_SCALE directly from Cortex's own source
 * (`../../../src/relevance.mjs`, the single source of truth per
 * `experiments/relevancy-replacement/00-cortex-contract.md`), so if Cortex's
 * scale ever changes, this mapping either tracks it automatically or the
 * `assertValidGrade` checks below start failing loudly instead of silently
 * mapping into a stale scale.
 *
 * Mapping decisions, journaled in `01-decisions-mapping-metrics.md`:
 *
 * ESCI (query-product relevance judgments, E/S/C/I):
 *   E (Exact)      -> 3  Perfect
 *   S (Substitute)  -> 2  Relevant
 *   C (Complement)  -> 1  Marginal   (category-adjacent, not irrelevant -- rejected C->0)
 *   I (Irrelevant)  -> 0  Irrelevant
 *   Rejected: ESCI paper gain weights (1/0.1/0.01/0) -- those are NDCG gains, not ordinal
 *   labels, wrong scale for a 0-3 grade.
 *
 * WANDS (Exact / Partial / Irrelevant):
 *   Exact      -> 3  Perfect
 *   Partial    -> 2  Relevant       (partially satisfies intent, closer to Cortex's 2 than 1)
 *   Irrelevant -> 0  Irrelevant
 *   Grade 1 is deliberately left unpopulated by WANDS (a 3-level label set mapped into a
 *   4-level scale). Rejected: Partial->1 -- flagged for Ferosh's review in journal 01.
 */
import { RELEVANCE_SCALE } from "../../../src/relevance.mjs";

export { RELEVANCE_SCALE };

/** The valid target grade values, derived from RELEVANCE_SCALE keys (never hardcoded). */
export const VALID_GRADES = Object.keys(RELEVANCE_SCALE).map(Number);

function assertValidGrade(grade, sourceLabel, datasetName) {
  if (!VALID_GRADES.includes(grade)) {
    throw new Error(
      `${datasetName} mapping for label "${sourceLabel}" produced grade ${grade}, which is not ` +
        `in Cortex's RELEVANCE_SCALE (${VALID_GRADES.join(", ")}). RELEVANCE_SCALE may have changed.`,
    );
  }
  return grade;
}

export const ESCI_LABEL_MAP = {
  E: assertValidGrade(3, "E", "ESCI"),
  S: assertValidGrade(2, "S", "ESCI"),
  C: assertValidGrade(1, "C", "ESCI"),
  I: assertValidGrade(0, "I", "ESCI"),
};

export const WANDS_LABEL_MAP = {
  Exact: assertValidGrade(3, "Exact", "WANDS"),
  Partial: assertValidGrade(2, "Partial", "WANDS"),
  Irrelevant: assertValidGrade(0, "Irrelevant", "WANDS"),
};

export function esciLabelToGrade(label) {
  if (!(label in ESCI_LABEL_MAP)) {
    throw new Error(`Unknown ESCI label: ${JSON.stringify(label)}`);
  }
  return ESCI_LABEL_MAP[label];
}

export function wandsLabelToGrade(label) {
  if (!(label in WANDS_LABEL_MAP)) {
    throw new Error(`Unknown WANDS label: ${JSON.stringify(label)}`);
  }
  return WANDS_LABEL_MAP[label];
}
