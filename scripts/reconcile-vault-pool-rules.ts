/**
 * **THE RULES OF THE REBUILD DOOR, SEPARATED FROM IT SO THEY CAN BE PINNED.**
 *
 * The door that rebuilds a vault's note pool from the chain may not be run by a
 * session, so every decision it makes lives here instead, as functions with no
 * screen, no file system and no network in them. **A door whose logic is inside
 * the door is a door nothing can measure**, and the two worst defects ever found
 * in a door in this project both lived in the half that was outside the typecheck
 * and outside the test glob, where nothing but text matching reached.
 *
 * ------------------------------------------------------------------------
 * **WHAT THE DOOR IS FOR.** A payment, a deposit and a repair all write one note
 * pool. When a write is lost -- a process stopped between the transaction and the
 * write, or a version filed by somebody else first on every attempt -- the money
 * is on chain and the pool does not name it. The pool is the only thing that can
 * say what a note IS, because the chain publishes commitments and a commitment
 * discloses nothing. So the pool has to be rebuilt from the chain's own note set
 * and every version this pool has ever been written at.
 *
 * **THE ONE RULE THAT OUTRANKS THE REST HERE: NEVER WRITE AN EMPTY POOL OVER A
 * VAULT THE CHAIN SAYS HOLDS MONEY.** An empty pool reads as a vault with nothing
 * in it, everywhere afterwards, and it is indistinguishable from the truth. A
 * rebuild that could not explain anything is this machine's ignorance, not a
 * treasury of zero, and the two must never be written down as the same thing.
 */
import type { PoolRecovery } from '../src/midnight/vault-recovery.js';

/** What the door may do, having looked at what the rebuild came back with. */
export type RebuildDecision =
  /** The pool already says what the chain says. Writing would change nothing. */
  | { do: 'nothing'; why: string }
  /** There is a difference worth writing, and what it is. */
  | { do: 'write'; why: string; recovers: number; drops: number; unexplained: number }
  /** Something is wrong enough that no write is correct. */
  | { do: 'refuse'; why: string };

/**
 * **A REBUILD ADDS NOTES BACK BY DEFAULT AND TAKES NONE AWAY, AND THAT DEFAULT
 * WAS PAID FOR BY AN AUDIT OF THIS ROUND'S OWN WORK.**
 *
 * The first version of this door wrote whatever the rebuild came back with, which
 * meant dropping every note the chain does not hold. The auditor found the
 * sequence that makes: a payment settles on chain and has not yet written its
 * change note; the door reads the chain, sees the spent note gone, and files a
 * pool without it; the payment then cannot find the note it spent, refuses -- and
 * that refusal is not a lost race, so nothing retries it. **The change note is
 * then in no version of the pool and never will be.** The door was a third
 * whole-pool writer with nothing but a paragraph between it and that.
 *
 * **SO THE TWO HALVES OF A REBUILD ARE SEPARATED, BECAUSE THEY HAVE OPPOSITE
 * RISKS.** Adding a note the chain holds can strand nothing: a pool with an extra
 * note in it is a pool a payment can still work from. Removing one can, because
 * the note being removed may be the note a payment in flight is about to write
 * its change against. **Adding is the recovery; removing is a convenience** --
 * what it buys is that a later payment does not pay two fees to be refused by the
 * circuit, and that is a refusal rather than a loss.
 *
 * So removing is opt-in, and the door says out loud that it is only safe when
 * nothing is paying out of the vault.
 */
export const decideWhetherToWrite = (input: {
  recovery: PoolRecovery;
  /** How many notes the newest filed version claims. A write is judged against this. */
  notesTheNewestVersionClaims: number;
  /** Whether the operator asked for notes the chain does not hold to be removed. */
  alsoDropStaleNotes: boolean;
}): RebuildDecision => {
  const r = input.recovery;
  /*
   * **WHAT WOULD ACTUALLY BE WRITTEN**, which is what every judgement below is
   * about. Additively that is the newest version plus what was recovered; with
   * dropping it is exactly what the chain holds and this machine can name.
   */
  const wouldHold = input.alsoDropStaleNotes
    ? r.held.length
    : input.notesTheNewestVersionClaims + r.recovered.length;

  /*
   * **THE REFUSAL THAT OUTRANKS THE REST, AND IT IS KEYED ON WHAT WOULD BE
   * WRITTEN RATHER THAN ON WHAT WAS UNEXPLAINED.** The first version asked only
   * whether the chain held notes the rebuild could not explain -- so a chain read
   * that answered ZERO notes left nothing unexplained, the refusal did not fire,
   * and the door wrote an empty pool over a funded vault. That is `C268` -- a
   * partial decode reads as an empty vault -- reaching the one door written to
   * survive it.
   *
   * An empty pool is a CLAIM that this vault has no money, and afterwards nothing
   * can tell that claim from the truth: every balance, every affordability check
   * and every screen agrees.
   */
  if (wouldHold === 0 && (input.notesTheNewestVersionClaims > 0 || r.unexplained.length > 0)) {
    return {
      do: 'refuse',
      why: 'what this would write is an EMPTY POOL, and this vault is not empty: '
        + `${input.notesTheNewestVersionClaims} note(s) are claimed by the pool's newest version `
        + `and the chain holds ${r.unexplained.length} note(s) the rebuild could not explain. `
        + '**An empty pool is a claim that this vault has no money**, and it is indistinguishable '
        + 'afterwards from the truth. This is not that: it is this machine holding no record of '
        + 'notes the chain does hold, or the chain not having answered properly. Nothing is '
        + 'written. If the chain reported no notes at all, read it again before believing it -- a '
        + 'state that decoded without its note set reads exactly like a vault with nothing in it. '
        + 'Otherwise find the records first: a pool version from a backup, or the deposits that '
        + 'created those notes -- because a commitment cannot be inverted and no rebuild can '
        + 'invent what a note is worth.',
    };
  }
  if (wouldHold === 0) {
    return {
      do: 'nothing',
      why: 'the chain holds no notes for this vault and no filed version claims any, so there is '
        + 'nothing to reconcile. A vault that has never been funded looks exactly like this.',
    };
  }
  const drops = input.alsoDropStaleNotes ? r.stale.length : 0;
  if (r.recovered.length === 0 && drops === 0) {
    return {
      do: 'nothing',
      why: r.stale.length > 0
        ? `every note the chain holds is already in this pool (${r.held.length}), and `
          + `${r.stale.length} note(s) the pool claims are not on chain. **Those are not written `
          + 'away here.** Removing one is only safe when nothing is paying out of this vault, '
          + 'because the note being removed may be the one a payment in flight is about to write '
          + 'its change against. Nothing is lost by leaving them: a payment that chose one is '
          + 'refused by the circuit after two fees, which is a cost and not a loss.'
        : `every note the chain holds is already in this pool's newest version (${r.held.length}) `
          + 'and it claims nothing the chain does not. The pool is the chain\'s pool. Nothing is '
          + 'written, because a rewrite of the money is a chance to write half of it and there is '
          + 'no reason here to take it.',
    };
  }
  return {
    do: 'write',
    why: [
      r.recovered.length > 0
        ? `${r.recovered.length} note(s) the chain holds are missing from the pool's newest version`
        : '',
      drops > 0
        ? `${drops} note(s) the pool claims are not on chain and would be refused at the spend`
        : '',
    ].filter(Boolean).join('; '),
    recovers: r.recovered.length,
    drops,
    unexplained: r.unexplained.length,
  };
};

/**
 * **A VAULT RECORDED AS DISPOSED OF IS REFUSED BEFORE THE CHAIN IS ASKED.**
 *
 * A vault deployed before a ledger field was added has an on-chain ledger a field
 * SHORT of what this build compiles, and a client reads a vault's fields by
 * COUNTING -- so the "note set" a read hands back is not its note set. `C465` is
 * that, measured on a live vault.
 *
 * **THIS DOOR IS THE ONE THAT MUST REFUSE HARDEST, BECAUSE OF WHAT IT WOULD DO
 * WITH THE WRONG ANSWER.** Reading the wrong field gives an empty or nonsense note
 * set, against which every note the pool holds is STALE and every commitment
 * UNEXPLAINED -- and the door's whole purpose is to write the pool that follows
 * from that comparison. It would offer to write an emptier pool than the one it
 * started from, about a vault it was reading wrongly.
 *
 * **IT IS A REFUSAL AND NOT A WARNING.** This door is reached by somebody already
 * worried about their money, and a warning is what that person scrolls past.
 *
 * `assertVaultLedgerIsThisBuilds` is the mechanism and holds for a vault nobody
 * has got round to marking; this is the record somebody wrote, and it costs no
 * chain read. Both, because the flag is cheap and the mechanism is certain.
 */
export const assertTheVaultIsNotDisposed = (
  named: string,
  entry: { disposed?: boolean; disposed_why?: string },
  /** The vault the registry records as live, if it records one. */
  current: string | undefined,
): void => {
  if (entry.disposed !== true) return;
  throw new Error(
    `the vault "${named}" is recorded as DISPOSED OF, so nothing here works against it`
    + `${entry.disposed_why === undefined ? '' : `: ${entry.disposed_why}`}.\n`
    + 'A vault whose on-chain ledger is a field short of what this build compiles is read by '
    + 'counting fields, so the note set a read hands back is NOT its note set -- every note would '
    + 'come back as spent and every commitment as unexplained, and this door would offer to write '
    + 'an emptier pool than the one it started from.\n'
    + (current === undefined
      ? 'No vault is recorded as the live one, so this cannot say which one you meant. Name it.'
      : `The live vault is "${current}". Run this again and name that one, or press return when it `
        + 'asks.'));
};

/**
 * **REMOVING A SIGNER'S ACCESS BY WRITING THE POOL, WHICH IS WHAT THIS DOOR
 * WOULD DO SILENTLY.**
 *
 * A write seals the pool afresh under a new key and wraps it to the signers the
 * signers FILE lists. Anybody the file has stopped listing keeps no copy of the
 * new key and their access to the record of the company's money ends -- and the
 * run that did it SUCCEEDS. Opening the pool does not catch it: one matching
 * signer is enough to open it and enough to write it back narrower.
 *
 * The same refusal the deposit door and the repair door make, for the same write.
 * It is here rather than imported from one of them because those live inside
 * doors, and this is the file that can be measured.
 */
export const assertNoSignerWouldLoseAccess = (
  wrappedFor: readonly string[], willWrapTo: readonly string[],
): void => {
  const to = new Set(willWrapTo);
  const dropped = [...new Set(wrappedFor)].filter((id) => !to.has(id));
  if (dropped.length === 0) return;
  throw new Error(
    `this pool is readable by ${dropped.length} signer(s) that the signers file no longer lists `
    + `(${dropped.join(', ')}), and writing it would re-seal it to the listed ones only. Their `
    + 'access to the record of this vault\x27s money would end, and this run would report success. '
    + 'Nothing is written. Either add them back to the signers file, or remove them deliberately '
    + 'with the door that exists for that, so it is a decision somebody made rather than a '
    + 'side effect of a repair.');
};

/**
 * **A REBUILD IS BUILT ON ONE READ OF THE CHAIN, AND A REBUILD IS NOT A DELTA.**
 *
 * Every other writer of this pool records a difference -- one note added, one
 * spent and its change kept -- and a difference can be applied again to a pool
 * that has moved. **This one replaces the whole record**, so if another writer
 * files a version while the chain is being read, re-applying is not available:
 * there is no correct merge of two disagreeing beliefs about which notes exist,
 * and the union invents notes the chain never had while the intersection drops
 * ones it does.
 *
 * So a rebuild that finds the pool has moved says so and asks to be run again,
 * which costs one chain read and is always correct.
 */
export const assertThePoolHasNotMovedSinceTheRebuild = (
  rebuiltFrom: number, storedNow: number,
): void => {
  if (rebuiltFrom === storedNow) return;
  throw new Error(
    `this rebuild was worked out from version ${rebuiltFrom} of the pool and the pool is at version `
    + `${storedNow} now: another writer filed one while the chain was being read. **Nothing has `
    + 'been written**, so what that writer recorded is still there. A rebuild replaces the whole '
    + 'record rather than adding to it, so it cannot be applied to a pool that has moved -- there '
    + 'is no correct merge of two disagreeing records of which notes exist. Run this again; it '
    + 'reads the chain once more and works out the rebuild from what the pool holds now.');
};

/**
 * **WHAT THE OPERATOR IS TOLD, AND WHY UNEXPLAINED MONEY IS NAMED LOUDEST.**
 *
 * `describeRecovery` in `vault-recovery.ts` gives one line for a log. This is the
 * screen, and it exists because the four numbers have four different consequences
 * and a person reading one list will act on all of them the same way.
 *
 * The address is never among these lines. `C236`: a vault's address pasted into a
 * wallet destroys the money sent to it, and a screen is where somebody copies
 * from.
 */
export const linesForAnOperator = (r: PoolRecovery): string[] => {
  const lines = [
    `notes the chain holds and this machine can name        ${r.held.length}`,
    `of those, notes the pool had lost                      ${r.recovered.length}`,
    `notes the pool claimed and the chain does not hold     ${r.stale.length}`,
    `notes the chain holds that nothing here explains       ${r.unexplained.length}`,
  ];
  /*
   * **EVERY LIST IS BOUNDED THE SAME WAY, AND THIS ONE WAS NOT.** `recovered` was
   * printed in full while `stale` and `unexplained` were cut at eight -- so a
   * rebuild that got a hundred notes back would scroll the four counts off the top
   * of the window, and the four counts are where the answer is. Found by an
   * auditor who noticed the test's own fixture left this list empty, so the one
   * unbounded list was the one nothing exercised. `C188`'s shape: a guard on some
   * of N.
   */
  const bounded = <T>(all: readonly T[], show: (one: T) => string): string[] => [
    ...all.slice(0, 8).map(show),
    ...(all.length > 8 ? [`    … and ${all.length - 8} more`] : []),
  ];
  const aNote = (n: { nonce: string; value: bigint }) =>
    `    ${n.nonce.slice(0, 16)}…   ${n.value.toLocaleString()}`;

  if (r.recovered.length > 0) {
    lines.push('', 'THE POOL HAD LOST THESE AND THE CHAIN STILL HOLDS THEM. They can be spent again:');
    lines.push(...bounded(r.recovered, aNote));
  }
  if (r.stale.length > 0) {
    lines.push('', 'THE POOL CLAIMED THESE AND THE CHAIN DOES NOT HOLD THEM. They are spent, or the');
    lines.push('call that would have created them never landed. Left in, every payment that chose');
    lines.push('one would be proposed, approved, paid for and then refused inside the circuit:');
    lines.push(...bounded(r.stale, aNote));
  }
  if (r.unexplained.length > 0) {
    lines.push('', 'THE VAULT HOLDS MONEY THIS MACHINE CANNOT NAME, AND A REBUILD CANNOT FIX IT.');
    lines.push('A commitment discloses nothing and cannot be inverted, so these are notes whose');
    lines.push('nonce, colour and value are not written down anywhere this machine can read.');
    lines.push('They are not lost to the chain and they are not spendable from here. What names');
    lines.push('one is whoever created it: an outside depositor\x27s own record, or a journal from');
    lines.push('the run that made it. The commitments, so they can be matched later:');
    lines.push(...bounded(r.unexplained, (c) => `    ${c.slice(0, 24)}…`));
  }
  return lines;
};
