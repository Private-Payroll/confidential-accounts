/**
 * THE RULES THIS READ IS HELD TO, WITH NOTHING THAT REACHES A NETWORK.
 *
 * The instrument next door reads a deployed contract through the product's own
 * boundary. Everything in here is the part of that instrument which DECIDES:
 * what an unanswered read is allowed to be called, whether two independent
 * readings of the same four numbers agree, whether a half-decoded state may
 * contribute a number, and what verdict the run carries out.
 *
 * ── WHY THE RULES ARE A SEPARATE FILE AND NOT A SECTION ──────────────────
 *
 * Because the instrument cannot be run to check them. It reads a live chain and
 * writes a report a person acts on, so it is started by a person and not by
 * whoever wrote it - and a rule that can only be exercised by starting the
 * instrument is a rule nobody has watched fail. Split out, every decision below
 * is reachable from a test with no indexer, no contract and no filesystem, and
 * each one has a named change that turns a named assertion red.
 *
 * ── THE ONE RULE EVERYTHING HERE SERVES ──────────────────────────────────
 *
 * **AN UNANSWERED READ IS NEVER REPORTED AS AN ANSWER.** A contract this
 * deployment could not ask about and a contract that is genuinely empty arrive
 * at this layer as the same absent value, and the difference between them is
 * the difference between "we do not know" and "there is nothing there". The
 * second is a sentence somebody acts on. Nothing below will produce it from a
 * reading that did not happen.
 */

/** The four public numbers a deployed account answers with. */
export interface AccountNumbers {
  readonly threshold: number;
  readonly signerCount: number;
  readonly openProposals: number;
  readonly movementCount: number;
}

/**
 * What became of one attempt to read an account through the product.
 *
 * **THREE SHAPES, NOT TWO, AND THAT IS THE POINT OF THE TYPE.** The boundary
 * underneath answers with one absent value for two quite different situations,
 * and the instrument can tell them apart because it knows whether an address
 * was ever resolved to send. Writing the third shape down here is what stops
 * the distinction being lost the moment it is printed.
 */
export type Reading =
  /** No address was resolved, so no question left this machine. */
  | { readonly kind: 'never-asked' }
  /** A question was sent and the answer carried no state for that contract. */
  | { readonly kind: 'no-state' }
  /** The question could not be sent or the answer could not be understood. */
  | { readonly kind: 'failed'; readonly cause: string }
  /** The contract answered. */
  | { readonly kind: 'answered'; readonly numbers: AccountNumbers };

/**
 * **WHAT AN OPERATOR IS TOLD A READING WAS.**
 *
 * The two non-answering shapes get sentences that say a reading did not happen.
 * Neither may be phrased as a fact about the contract, because neither is one.
 */
export function sayReading(r: Reading): string {
  switch (r.kind) {
    case 'never-asked':
      return 'NOT ASKED. No contract address was resolved for this account, so no question '
        + 'left this machine. This is not a statement about the contract: it is a statement '
        + 'about what this deployment could look up.';
    case 'no-state':
      return 'ASKED, AND THE ANSWER CARRIED NO STATE for that contract. That is not the same '
        + 'as an empty account, and this instrument will not report it as one: an indexer '
        + 'that has not yet caught up answers exactly like this.';
    case 'failed':
      return `COULD NOT READ: ${r.cause}. That is a fact about this machine and the reach `
        + 'between it and the chain, and it rules on nothing about the contract.';
    case 'answered':
      return 'ANSWERED.';
  }
}

/**
 * **WHETHER A READING MAY CONTRIBUTE NUMBERS TO THE REPORT.** One place, so
 * that no printing site has to remember it.
 */
export const carriesNumbers = (r: Reading): r is { kind: 'answered'; numbers: AccountNumbers } =>
  r.kind === 'answered';

/* ------------------------------------------------------------------ *
 * two readings of the same four numbers
 * ------------------------------------------------------------------ */

export type FieldComparison = 'agree' | 'differ' | 'incomparable';

/**
 * **A MISSING SIDE IS NEVER AGREEMENT.**
 *
 * The whole reason for reading these four twice is that one instrument alone
 * cannot be checked. If either side is absent there is no comparison to make,
 * and calling that agreement would turn a measurement that did not happen into
 * a measurement that passed - which is the loudest form of the thing this file
 * exists to stop.
 */
export function compareField(
  a: number | undefined, b: number | undefined,
): FieldComparison {
  if (a === undefined || b === undefined) return 'incomparable';
  return a === b ? 'agree' : 'differ';
}

/**
 * The four compared together, and the verdict over them.
 *
 * **ONE FIELD THAT DIFFERS DECIDES THE WHOLE**, because the point of the
 * comparison is to notice a divergence, and a summary that averages four
 * answers into a mood hides the one that matters.
 */
export function compareReadbacks(
  recorded: Partial<AccountNumbers>, read: Partial<AccountNumbers>,
): { readonly perField: Record<keyof AccountNumbers, FieldComparison>;
     readonly overall: FieldComparison } {
  const keys: Array<keyof AccountNumbers> =
    ['threshold', 'signerCount', 'openProposals', 'movementCount'];
  const perField = {} as Record<keyof AccountNumbers, FieldComparison>;
  for (const k of keys) perField[k] = compareField(recorded[k], read[k]);
  const values = keys.map(k => perField[k]);
  const overall: FieldComparison = values.includes('differ')
    ? 'differ'
    : values.includes('incomparable') ? 'incomparable' : 'agree';
  return { perField, overall };
}

/* ------------------------------------------------------------------ *
 * a state that only half decoded
 * ------------------------------------------------------------------ */

/**
 * **BOTH NUMBERS OR NEITHER.**
 *
 * A generated reader decodes a contract's state field by field, and a state
 * that is wrong further along can still hand back a well formed value for a
 * field that comes earlier. So a run that got one of these two and threw on the
 * other has not measured the first one either: it has an artefact of how far
 * the decoding got. Reporting the half that survived would put a real looking
 * number beside a refusal, and the number is the thing that gets quoted.
 */
export function vaultNumbers(
  forced: { readonly payments?: string; readonly notes?: string },
): { readonly reportable: false } | {
  readonly reportable: true; readonly payments: string; readonly notes: string;
} {
  if (forced.payments === undefined || forced.notes === undefined) return { reportable: false };
  return { reportable: true, payments: forced.payments, notes: forced.notes };
}

/* ------------------------------------------------------------------ *
 * the verdict
 * ------------------------------------------------------------------ */

/** What the run saw, reduced to the four facts the verdict turns on. */
export interface Run {
  /** Did the product resolve a deployment from what is on disk? */
  readonly deploymentResolved: boolean;
  /** The product's boundary, driven exactly as this deployment is configured. */
  readonly asConfigured: Reading;
  /**
   * The same boundary, with the one input it does not own supplied from the
   * deployment the product itself resolved.
   */
  readonly withAddressSupplied: Reading;
}

export interface Verdict {
  readonly code: 0 | 1 | 2 | 3;
  readonly headline: string;
}

/**
 * **THE EXIT CODE, AND THE ORDER OF ITS QUESTIONS IS THE RULE.**
 *
 * 0  the product answered about the deployed contract as this deployment is
 *    configured. That is the only shape that settles the question this
 *    instrument was built to ask.
 * 1  the product's read path answered, and the product as configured did not.
 *    The path works; the deployment cannot reach the contract with it.
 * 2  something stopped.
 * 3  nothing was read, so nothing is ruled either way.
 *
 * **UNMEASURED IS ASKED FIRST AND NEVER LAST.** A run that never resolved a
 * deployment, or never got an answer from anywhere, returns 3 however many
 * other things it printed. The failure this ordering prevents is a run that
 * could not reach the chain at all reporting the same code as a run that
 * reached it and found the product unable to use it.
 */
export function verdict(run: Run): Verdict {
  if (!run.deploymentResolved) {
    return { code: 3, headline:
      'UNMEASURED. This deployment could not resolve which contract it is talking to, so '
      + 'nothing was asked of any chain and nothing here rules on whether the product can '
      + 'read one.' };
  }
  if (carriesNumbers(run.asConfigured)) {
    return { code: 0, headline:
      'THE PRODUCT READ THE DEPLOYED CONTRACT, configured exactly as it stands on this '
      + 'machine. The claim that this product reads the chain is now backed by a reading.' };
  }
  if (carriesNumbers(run.withAddressSupplied)) {
    return { code: 1, headline:
      'THE READ PATH ANSWERS AND THIS DEPLOYMENT CANNOT USE IT. Handed the contract address '
      + 'the product had already resolved, the product\'s own boundary read the contract. '
      + 'Driven as this deployment is configured, it answered nothing. What is missing is '
      + 'not the ability to read: it is the lookup that turns an account into an address, '
      + 'and that lookup is not a setting anybody has left unset. It is filled in when an '
      + 'account is opened, opening an account writes to the chain, and a deployment with '
      + 'no wallet refuses every write by name. So this code is what a read-only deployment '
      + 'returns until something that can write has opened an account.' };
  }
  return { code: 3, headline:
    'UNMEASURED. Neither route produced a reading, so nothing here rules on whether the '
    + 'product can read a deployed contract.' };
}
