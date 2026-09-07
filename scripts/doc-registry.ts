/**
 * EVERY GENERATED BLOCK IN THE REPOSITORY, IN ONE TABLE, AND THE TABLE IS THE
 * ONLY PLACE ANY OF THEM IS NAMED.
 *
 * `scripts/artifact-freshness.ts` carries the same shape for source/artifact
 * pairs and its comment says why: a guard that knows about one of the things it
 * guards is a guard the others walk past — that file's own table was written
 * after nothing in this repository had ever checked the vault's artifact.
 *
 * The generator writes exactly these blocks and the gate checks exactly these
 * blocks, from this list, so the two cannot disagree about what exists. Adding a
 * document to the set is one entry here plus the delimiters in the file.
 *
 * `inputs` IS THE POINT. A block is stale when the files it was generated FROM
 * have changed, so each entry names them, and the gate hashes exactly that list.
 * An entry with an empty `inputs` would be a block that can never go stale,
 * which is the `C238` shape, and `docFreshnessRefusals` refuses one.
 */
export type GeneratedBlock = {
  /** Repository-relative markdown file the block lives in. */
  readonly file: string;
  /** `id` on both delimiters. Unique across the repository. */
  readonly id: string;
  /**
   * THE COMMAND THAT REWRITES IT, AND IT SHIPS. Rule 19: a refusal names a door,
   * and a reader of the published repository must be able to open the thing it
   * names. It used to name a local `.command`, which no clone has — so every
   * mention of it, here, in each document's delimiter and in the refusal text,
   * was a path the reader could not follow, and registering a document RAISED
   * the count of two files that were already at their floor. Naming a script in
   * the shipping `package.json` makes the citation followable and the count
   * falls instead.
   */
  readonly door: string;
};

/**
 * THERE IS NO LIST OF INPUT FILES HERE ANY MORE, AND ITS ABSENCE IS THE FIX.
 *
 * This registry used to carry one, and it was wrong three times in one
 * round, each time in the same shape and each time repaired by moving a
 * boundary one step outwards:
 *
 *   1. `edges.json` was outside the gate entirely.
 *   2. The list held the two contracts and not the six generator modules, so a
 *      round that CORRECTED an extractor bug and did not regenerate left the
 *      wrong table on disk under a green summary line.
 *   3. The list then held the generator and not the three trees the generator
 *      READS — `src`, `scripts`, `contracts/test` — so the client-file→circuit
 *      edges were derived from files the gate could not see change. MEASURED:
 *      the suite passed the gate at 07:23 and a regeneration rewrote two
 *      documents at 07:24 with nothing changed in between; a second run rewrote
 *      nothing, so the generator is deterministic and that was real staleness.
 *
 * **A LIST OF INPUTS IS A PROXY FOR THE QUESTION, AND EVERY PROXY HAS AN EDGE
 * SOMEBODY WILL EVENTUALLY STAND ON.** The question is *would the generator
 * write something different from what is on disk*, and `scripts/doc-freshness.ts`
 * now answers it by RENDERING and COMPARING rather than by hashing what it
 * guessed the render depends on. There is no fourth boundary to move.
 *
 * WHAT THAT COSTS, STATED RATHER THAN DISCOVERED — and it is smaller than the
 * list it replaces, in both directions:
 *
 *   - The gate runs the extraction on every suite run. Measured: 440 ms cold,
 *     174 ms warm, once per run in the main process.
 *   - It goes red when the OUTPUT changes and at no other time. Hashing `src/`
 *     wholesale would have turned the suite red on every application edit for
 *     the whole of phase 2; of the 290 files the scan reads today, 33 contribute
 *     an edge and the other 257 do not change the output AS THEY STAND. That is
 *     a statement about today's contents, not a guarantee about the files: an
 *     auditor turned one of the 257 into a contributor with a single appended
 *     line and the gate went red, correctly. The set is derived rather than
 *     curated, so a file that starts calling a circuit joins it with nothing to
 *     update — which is the whole reason this is not a list.
 *   - It NO LONGER goes red for a comment or a refactor inside the generator,
 *     which the six-module list did. That cost is removed rather than moved.
 *   - What it does still catch, and a person should expect: editing one of the
 *     33 contributing files in a way that shifts a LINE moves a `file:line`
 *     locator in the edge list, which is a real change to the artefact and turns
 *     the gate red until `npm run docs` runs.
 *   - And the gate now depends on the extractor working. If `artifact-scan.ts`
 *     throws, the suite does not start and the message is the extractor's.
 *     `scripts/artifact-freshness.globalSetup.ts` runs first, so a stale or
 *     missing artifact is still reported as a compile problem and not as this.
 */

/**
 * EVERY GENERATED BLOCK, AND THE TABLE IS THE ONLY PLACE ANY OF THEM IS NAMED.
 *
 * `scripts/generate-docs.ts` refuses to render a block this list names and it
 * has no renderer for, and `scripts/doc-freshness.ts` refuses an empty list, so
 * adding a document is one entry here plus the delimiters in the file.
 */
export const GENERATED_BLOCKS: readonly GeneratedBlock[] = [
  { file: 'docs/design/circuits.md', id: 'circuits', door: 'npm run docs' },
  { file: 'docs/design/ledger-fields.md', id: 'ledger-fields', door: 'npm run docs' },
  { file: 'docs/design/modules.md', id: 'modules', door: 'npm run docs' },
];

/**
 * FILES GENERATED WHOLE, WITH NO PROSE AROUND THEM AND THEREFORE NO DELIMITERS.
 *
 * `docs/design/edges.json` was outside the gate entirely until a test-coverage pass
 * and a money-safety pass found it independently — and it is the ONE
 * artefact a later round reads INSTEAD of building its own picture. A hand-edit
 * setting a field's writers to `[]` passed the whole suite in silence.
 *
 * It carries its hand-edit digest in its own payload rather than in delimiters:
 * `payload`, which is the same question a block's `body` digest answers. Its
 * staleness is answered the same way a block's is — by rendering and comparing.
 */
export type GeneratedFile = {
  readonly file: string;
  readonly door: string;
};

export const GENERATED_FILES: readonly GeneratedFile[] = [
  { file: 'docs/design/edges.json', door: 'npm run docs' },
];

/** The machine-readable edge list, which is generated whole rather than as a block. */
export const EDGE_LIST_FILE = 'docs/design/edges.json';
