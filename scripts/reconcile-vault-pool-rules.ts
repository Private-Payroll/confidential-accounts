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
import type {
  PoolRecovery, NoteDescribedTwice, SettledByTheChain, RecordOfANote,
} from '../src/midnight/vault-recovery.js';
import { nameTheRecord } from '../src/midnight/vault-recovery.js';
import { theTransactionTheseEventsAreFrom } from '../src/midnight/note-index.js';
import type { Note } from '../src/midnight/vault-notes.js';
import type { CreatingTransactionFound } from '../src/midnight/note-index.js';
import type { Hex } from '../src/core/crypto.js';

/** What the door may do, having looked at what the rebuild came back with. */
export type RebuildDecision =
  /** The pool already says what the chain says. Writing would change nothing. */
  | { do: 'nothing'; why: string }
  /** There is a difference worth writing, and what it is. */
  | { do: 'write'; why: string; recovers: number; drops: number; unexplained: number; records: number }
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
  /**
   * How many notes the write would give a creating transaction that no filed
   * version records - `whatTheRebuildWrites`' `established`. Absent is none.
   */
  transactionsEstablished?: number;
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
  /*
   * **A NOTE GAINING ITS CREATING TRANSACTION IS A REASON TO WRITE ON ITS OWN.**
   * Without it the note is held and cannot be spent; with it a payment can read
   * its place in the tree. A rebuild that established one and then said
   * *nothing needed writing* would throw away the one read that made it spendable.
   */
  const records = input.transactionsEstablished ?? 0;
  if (r.recovered.length === 0 && drops === 0 && records === 0) {
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
      records > 0
        ? `${records} note(s) gain the transaction that created them, which is what lets a payment spend them`
        : '',
    ].filter(Boolean).join('; '),
    recovers: r.recovered.length,
    drops,
    unexplained: r.unexplained.length,
    records,
  };
};

/*
 * **THE REFUSAL OF A RETIRED VAULT USED TO LIVE HERE, AND IT HAD TO MOVE.**
 *
 * It was written for this door and only this door called it, while nine other
 * doors turned a name into the same kind of vault and asked nothing. A rule that
 * one caller remembers is a rule the next caller will not.
 *
 * It is now `theVault` in `src/midnight/vault-record.ts`, inside the lookup that
 * turns a name into an entry -- the one act every door performs, because an
 * address exists in the record and nowhere else. **This door's own reason for
 * refusing hardest is at its call site**, where it belongs: reading the wrong
 * field gives a note set against which every note held is stale and every
 * commitment unexplained, and this door's whole purpose is to write the pool
 * that follows from that comparison.
 */

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
  /**
   * What is being written, as the sentence names it. The journals are sealed the
   * same way as the pool and lose a reader the same way, so they ask the same
   * question; the refusal says which record it is about.
   */
  record = 'this pool',
): void => {
  const to = new Set(willWrapTo);
  const dropped = [...new Set(wrappedFor)].filter((id) => !to.has(id));
  if (dropped.length === 0) return;
  throw new Error(
    `${record} is readable by ${dropped.length} signer(s) that the signers file no longer lists `
    + `(${dropped.join(', ')}), and writing it would re-seal it to the listed ones only. Their `
    + 'access to the record of this vault\x27s money would end, and this run would report success. '
    + 'Nothing is written, and nothing is lost by stopping here. What resolves it: add them back to '
    + 'the signers file and run this again. Taking a signer\x27s access away is a decision about who '
    + 'may read the record of this vault\x27s money, and nothing on this machine makes that decision '
    + 'yet, for this record or any other; until something does, the signers file has to keep '
    + 'listing everyone the record is sealed to.');
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

/* ------------------------------------------------------------------ *
 * what is written, and whether a payment can spend it
 * ------------------------------------------------------------------ */

/** A note the rebuild writes that a payment cannot spend yet, and why. */
export interface NotYetSpendable {
  readonly nonce: string;
  readonly value: bigint;
  readonly why: string;
}

/**
 * **THE CREATING TRANSACTION A FILED VERSION RECORDS FOR THIS NOTE, NEWEST
 * VERSION FIRST.** The newest, because a repair that corrected a wrong hash
 * filed a newer version than the one it corrected; and not only the newest
 * holding the note, because a version written without the hash - which every
 * rebuild before this one wrote - must not hide the one an older version kept.
 */
const recordedCreatingTransaction = (
  versions: readonly { version: number; notes: readonly Note[] }[],
  note: { nonce: string; token: string; value: bigint },
): Hex | undefined => {
  for (const v of [...versions].sort((a, b) => b.version - a.version)) {
    const same = v.notes.find((n) => n.nonce === note.nonce
      && n.token === note.token && n.value === note.value && isAHash(n.createdIn));
    if (same) return same.createdIn;
  }
  return undefined;
};

/**
 * **A RECORDED VALUE COUNTS ONLY IF IT HAS THE SHAPE A SPEND CAN READ.** A
 * version filed before that shape was enforced can carry something that is not
 * a transaction hash, and keeping it would write a note that reads as spendable
 * and is refused at the spend, after its fees. Such a value is treated as not
 * recorded, so the chain is asked. The shape is the product's one statement of
 * it, not a second one written here.
 */
const isAHash = (value: Hex | undefined): boolean => {
  if (value === undefined) return false;
  try {
    theTransactionTheseEventsAreFrom([], { hash: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * **THE NOTES THE CHAIN HOLDS THAT NO FILED VERSION RECORDS A CREATING
 * TRANSACTION FOR** - which is every note a rebuild recovers from a journal,
 * because a journal is written before the transaction exists. These are what
 * the chain is asked about before anything is written.
 */
export const notesNeedingATransaction = (input: {
  versions: readonly { version: number; notes: readonly Note[] }[];
  held: PoolRecovery['held'];
}): Array<{ nonce: Hex; token: Hex; value: bigint }> =>
  input.held
    .filter((n) => recordedCreatingTransaction(input.versions, n) === undefined)
    .map((n) => ({ nonce: n.nonce, token: n.token, value: n.value }));

/**
 * **WHAT A REBUILD WRITES, NOTE BY NOTE, AND WHICH OF IT A PAYMENT CANNOT SPEND.**
 *
 * Additively: every note the newest version claims, plus every note the chain
 * holds. With `alsoDropStaleNotes`: the notes the chain holds, and nothing else.
 *
 * **EACH NOTE CARRIES FOUR FIELDS AND NO OTHER.** The coin, and the transaction
 * that created it. Never an index - a spend reads that from the chain when it
 * spends - and never whatever else a record happened to be carrying.
 *
 * **THE TRANSACTION COMES FROM A FILED VERSION FIRST, AND FROM THE CHAIN SECOND.**
 * This used to be the defect: the notes the chain holds were written over the
 * newest version's by nonce, taken from whichever version had filed the note
 * FIRST - so a note whose transaction was recorded later by the repair lost it
 * again at the next rebuild, and a note whose wrong hash had been corrected got
 * the wrong one back. Now a version's record is kept, and what the chain
 * established in this run (`found`) fills only what no version records.
 *
 * **A NOTE THE CHAIN HOLDS AND NOTHING NAMES THE TRANSACTION OF IS STILL
 * WRITTEN**, and listed in `notYetSpendable` with its reason. Leaving it out would
 * put the money back to being unnameable; writing it is a note the payment path
 * refuses before its money moves, and says why. The door says so for each one,
 * so the record does not read as ordinary money to the person who wrote it.
 */
export const whatTheRebuildWrites = (input: {
  versions: readonly { version: number; notes: readonly Note[] }[];
  held: PoolRecovery['held'];
  alsoDropStaleNotes: boolean;
  /** What the chain answered for `notesNeedingATransaction`. Absent notes were not asked. */
  found: readonly CreatingTransactionFound[];
}): { notes: Note[]; notYetSpendable: NotYetSpendable[]; established: number } => {
  if (input.versions.length === 0) {
    throw new Error('there is no filed version to write a rebuild over, so nothing is written.');
  }
  const newest = [...input.versions].sort((a, b) => b.version - a.version)[0]!;
  const fromTheChain = new Map(input.found.map((f) => [f.nonce as string, f]));
  /*
   * **THE CHAIN WAS ASKED ABOUT A COIN, NOT ABOUT A NONCE.** Its answer is keyed
   * by nonce, so it is applied only to the coin the chain holds under that nonce:
   * a version that describes the same nonce differently must never be handed the
   * transaction that created a different coin.
   */
  const coinKey = (n: { nonce: string; token: string; value: bigint }) => `${n.nonce}:${n.token}:${n.value}`;
  const asTheChainHoldsIt = new Set(input.held.map(coinKey));

  const written = (n: { nonce: Hex; token: Hex; value: bigint }): Note => {
    const recorded = recordedCreatingTransaction(input.versions, n);
    if (recorded !== undefined) return { nonce: n.nonce, token: n.token, value: n.value, createdIn: recorded };
    const answer = fromTheChain.get(n.nonce);
    if (answer !== undefined && 'createdIn' in answer && asTheChainHoldsIt.has(coinKey(n))) {
      return { nonce: n.nonce, token: n.token, value: n.value, createdIn: answer.createdIn };
    }
    return { nonce: n.nonce, token: n.token, value: n.value };
  };

  const byNonce = new Map<string, Note>();
  if (!input.alsoDropStaleNotes) {
    for (const n of newest.notes) byNonce.set(n.nonce, written(n));
  }
  const onChain = new Set<string>();
  for (const n of input.held) {
    onChain.add(n.nonce);
    /*
     * **A NOTE IN BOTH IS WRITTEN ONCE, AS THE CHAIN HOLDS IT.** Usually the two
     * are the same coin. When the newest version describes the nonce differently
     * from the coin the chain holds, the chain has settled it (`settled` in the
     * rebuild) and the version's description is not money: writing it would keep
     * a note every payment that chose it is refused for, and writing both would
     * put two notes under one nonce. So the chain's coin replaces it.
     */
    const already = byNonce.get(n.nonce);
    if (already && already.token === n.token && already.value === n.value) continue;
    byNonce.set(n.nonce, written(n));
  }

  /* Counted over what is actually written, so a note is counted once whatever it replaced. */
  const established = [...byNonce.values()].filter((n) =>
    n.createdIn !== undefined && recordedCreatingTransaction(input.versions, n) === undefined).length;

  const notYetSpendable: NotYetSpendable[] = [];
  for (const n of byNonce.values()) {
    if (n.createdIn !== undefined || !onChain.has(n.nonce)) continue;
    const answer = fromTheChain.get(n.nonce);
    notYetSpendable.push({
      nonce: n.nonce,
      value: n.value,
      why: answer !== undefined && 'unresolved' in answer
        ? answer.unresolved
        : 'the chain was not asked which transaction created it',
    });
  }
  return { notes: [...byNonce.values()], notYetSpendable, established };
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
export const linesForAnOperator = (
  r: PoolRecovery,
  /** Notes that would be written and that a payment cannot spend yet. */
  notYetSpendable: readonly NotYetSpendable[] = [],
  /** Nonces records here describe more than one way, and what the chain said of each. */
  settled: readonly SettledByTheChain[] = [],
): string[] => {
  const lines = [
    `notes the chain holds and this machine can name        ${r.held.length}`,
    `of those, notes the pool had lost                      ${r.recovered.length}`,
    `notes the pool claimed and the chain does not hold     ${r.stale.length}`,
    `notes the chain holds that nothing here explains       ${r.unexplained.length}`,
    ...(settled.length > 0
      ? [`notes described two ways, settled by the chain         ${settled.length}`]
      : []),
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

  /*
   * **"THEY CAN BE SPENT AGAIN" IS SAID ONLY OF NOTES IT IS TRUE OF.** It used to
   * be said of every recovered note, and a recovered note records no creating
   * transaction unless one was found, so the sentence was false for exactly the
   * notes this door exists to bring back.
   */
  /*
   * **A NOTE THE CHAIN SETTLED IS SHOWN ONCE, IN ITS OWN SECTION.** A version
   * that described it wrongly makes the chain's coin look *lost* and the
   * version's look *stale*, and neither word is what happened. A nonce the
   * chain holds NONE of the descriptions of is different: an additive rebuild
   * still writes the newest version's entry for it, exactly as it writes any
   * other note the chain does not hold, so it stays in the stale list too,
   * where what resolves it is said.
   */
  const settledNonces = new Set<string>(settled.filter((x) => x.chainHolds !== undefined).map((x) => x.nonce));
  if (settled.length > 0) {
    lines.push('', 'RECORDS HERE DESCRIBE THESE NOTES MORE THAN ONE WAY, AND THE CHAIN SAID WHICH IS MONEY.');
    lines.push('A nonce is one coin. A description is money only if the vault\x27s note set holds its');
    lines.push('commitment, which binds the vault, the nonce, the colour and the value, so nothing here');
    lines.push('chose. Where the chain holds one, the rebuild uses it. No record is edited, moved or dropped: each');
    lines.push('file stays as it is, and every rebuild settles the same note the same way.');
    const described = (d: { value: bigint; records: readonly RecordOfANote[] }) =>
      `${d.records.map(nameTheRecord).join(', ')} say${d.records.length === 1 ? 's' : ''} ${d.value.toLocaleString()}`;
    for (const x of settled.slice(0, 8)) {
      lines.push(`    ${x.nonce.slice(0, 16)}…`);
      lines.push(x.chainHolds
        ? `      the chain holds this one:  ${described(x.chainHolds)}`
        : '      the chain holds none of them, so no record here describes money this vault holds now');
      for (const d of x.setAside) lines.push(`      set aside:                 ${described(d)}`);
    }
    if (settled.length > 8) lines.push(`    … and ${settled.length - 8} more`);
  }
  const stuck = new Set(notYetSpendable.map((n) => n.nonce));
  const spendable = r.recovered.filter((n) => !stuck.has(n.nonce) && !settledNonces.has(n.nonce));
  if (spendable.length > 0) {
    lines.push('', 'THE POOL HAD LOST THESE AND THE CHAIN STILL HOLDS THEM. They can be spent again:');
    lines.push(...bounded(spendable, aNote));
  }
  if (notYetSpendable.length > 0) {
    lines.push('', 'THESE ARE THE VAULT\x27S AND ON CHAIN, AND A PAYMENT CANNOT SPEND THEM YET.');
    lines.push('A payment reads a note\x27s place in the chain from the transaction that created it,');
    lines.push('and nothing names that transaction for these. They are written so they stay named,');
    lines.push('and a payment that would spend one is refused before its money moves. What resolves');
    lines.push('it: run this rebuild again once the reason below is gone, or name the transaction');
    lines.push('that created the note to the repair that records it.');
    lines.push(...bounded(notYetSpendable, (n) => `${aNote(n)}   ${n.why.slice(0, 300)}`));
  }
  if (r.stale.some((n) => !settledNonces.has(n.nonce))) {
    lines.push('', 'THE POOL CLAIMED THESE AND THE CHAIN DOES NOT HOLD THEM. They are spent, or the');
    lines.push('call that would have created them never landed. Left in, every payment that chose');
    lines.push('one would be proposed, approved, paid for and then refused inside the circuit:');
    lines.push(...bounded(r.stale.filter((n) => !settledNonces.has(n.nonce)), aNote));
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

/**
 * **WHERE, ON THIS MACHINE, EACH RECORD A CONTRADICTION NAMES IS.**
 *
 * The refusal names a record the way the rebuild knows it - *version 2 of the
 * pool*, *the payment journal* - and a person acts on a file. So the door prints
 * the file beside each name, from the same functions that chose the file names.
 */
export const whereTheRecordsAre = (
  refused: NoteDescribedTwice,
  files: {
    /** `vaultPoolVersionFile(poolFile, version)`, relative to the tree. */
    poolVersion: (version: number) => string;
    depositJournal: string;
    paymentJournal: string;
  },
): string[] => refused.descriptions.map((d) => {
  const where = d.record.kind === 'pool version'
    ? files.poolVersion(d.record.version)
    : `${d.record.kind === 'deposit journal' ? files.depositJournal : files.paymentJournal}`
      + ' and its numbered versions';
  return `${nameTheRecord(d.record)}${d.onChain ? ' (the chain holds this one)' : ''}: ${where}`;
});
