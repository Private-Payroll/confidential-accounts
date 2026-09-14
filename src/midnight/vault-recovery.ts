/**
 * REBUILDING A VAULT'S NOTE POOL FROM ITS HISTORY AND THE CHAIN. `C200`, and
 * rows 1, `B1` and `C199` of `docs/how-money-can-be-lost.md`.
 *
 * A shielded vault publishes only commitments. The notes themselves — the
 * things that can actually be spent — live on the owner's device, and every
 * payment, deposit and split changes which ones exist. So a device dying
 * between a call landing and the pool being written leaves the vault holding
 * money nobody can move: the next payment offers a note the commitment set does
 * not contain, and it is refused forever. **No rescan finds it**, because
 * Midnight creates no coin ciphertext to tell a recipient about a coin.
 *
 * That is `B1`, and `C199` is the ordering that depends on this file existing.
 *
 * ------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY THE OLD SHAPE WAS THE DEFECT.
 *
 * This file used to model **one coin chained forward**: a deposit, then a list
 * of amounts, each payment's change following from the one before. **The
 * contract has held a POOL since `V-58`** — `notes` is a `Set<Bytes<32>>` of
 * commitments (`Vault.compact:73-103`), `deposit` inserts one, `payout` removes
 * the spent one and inserts the change, `splitNote` removes one and inserts
 * two. **A vault holding two notes of a token is the normal case, not a mess to
 * tidy**, in the contract's own words.
 *
 * A chain is not a wrong description of a pool. It is a description of a
 * different vault. Replaying it against a real pool answers with a coin that
 * never existed, and the answer looks entirely reasonable.
 *
 * **AND ONE PROPERTY IS GAINED RATHER THAN RESTORED.** The old input insisted
 * payments be given IN ORDER, globally, because each coin followed from the one
 * before. A pool has no global order: **two payments spending DIFFERENT notes
 * have nothing to say to each other.** Only the events touching one note are
 * ordered with respect to each other, and this file requires exactly that much.
 *
 * ------------------------------------------------------------------------
 * THE ONE RULE THIS FILE IS BUILT ON: **THE CHAIN DECIDES, THE REPLAY ONLY
 * PROPOSES.**
 *
 * A commitment discloses nothing. It cannot be inverted, so nothing here can
 * read the chain and be told what a note is. What it can do is *propose*: build
 * every note the owner's history says has ever existed, compute each one's
 * commitment with the vault contract's own circuits, and ask the chain's set
 * whether it is a member.
 *
 * **That is what makes `V-47`'s trap harmless here.** A derivation below that is
 * subtly wrong cannot produce a false note, because a wrong note has a wrong
 * commitment and the chain refuses it — it shows up as an UNEXPLAINED
 * commitment, which is a loud, recoverable, investigable state. There is no
 * path through this file that hands a caller a note the chain has not already
 * agreed to. **A nearly-right derivation is worse than none** only where it is
 * believed; nothing here believes one.
 *
 * ------------------------------------------------------------------------
 * WHY THE DERIVATIONS ARE COPIED FROM THE GENERATED CODE RATHER THAN THE
 * DOCUMENTED `evolveNonce`, and this is the whole reason `V-47` exists: they are
 * different functions with almost the same name.
 *
 *     evolveNonce   hash([ "midnight:kernel:nonce_evolve",   index, nonce ])
 *     the change    hash([ "midnight:kernel:nonce_evolve/2",        nonce ])
 *
 * A circuit built on the first compiled, read plausibly, and produced the wrong
 * value. **So these derivations are trustworthy only because a test SPENDS what
 * they reconstruct** — see `contracts/test/vault-recovery.test.ts`. A recovery
 * path nobody has run does not exist.
 */
import {
  transientHash, degradeToTransient, upgradeFromTransient,
  convertBytesToUint, CompactTypeField, CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';
import { toHex, fromHex, type Hex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';

/**
 * THREE DERIVATIONS, ALL BUT ONE UNDOCUMENTED, AND NO TWO OF THEM THE SAME.
 * Transcribed from the compiled contract, because the documentation describes
 * only the first and it is the one that is never used here:
 *
 *     evolveNonce(i, n)   hash([ "midnight:kernel:nonce_evolve",   i, n ])
 *     the SENT coin       hash([ "midnight:kernel:nonce_evolve",      n ])
 *     the CHANGE coin     hash([ "midnight:kernel:nonce_evolve/2",    n ])
 *
 * The middle one shares the documented domain and drops the index; the last
 * uses a domain that appears in no document we have. Any of the three read as
 * "the obvious one" from a distance, which is exactly how `V-47` happened.
 *
 * **"SENT" RATHER THAN "THE PAYEE'S", SINCE `S6d`.** `sendShielded` does not
 * know or care who the recipient is: `payout` sends to a person and `splitNote`
 * sends to `kernel.self()`, and both take the same derivation for the coin that
 * leaves and the same one for the coin that stays. Calling the first "the
 * payee's" was true of the only caller that existed when it was written and is
 * not a property of the function. `contracts/test/vault-recovery.test.ts` pins
 * both halves of a split against the coins the call actually produced.
 */
const DOMAIN = (text: string) => convertBytesToUint(
  52435875175126190479447740508185965837690552500527637822603658699938581184512n,
  text.length,
  new TextEncoder().encode(text),
  'Field',
  '<standard library>');

const CHANGE_DOMAIN = () => DOMAIN('midnight:kernel:nonce_evolve/2');
const SENT_DOMAIN = () => DOMAIN('midnight:kernel:nonce_evolve');

const FIELD_PAIR = new CompactTypeVector(2, CompactTypeField);

/**
 * The nonce the coin that STAYS carries — a payout's change, a split's
 * remainder — given the nonce it was sent from.
 *
 * `vault-notes.ts` needs this rather than the coin itself in one place: the
 * pool's entry for a payment's change is written from the spent note's nonce.
 * For reading back a call that already happened, **prefer the coin the call
 * itself produced** (`changeCoinOf` in `vault-coins.ts`, which reads the
 * transaction's own Zswap local state). This is for when that reading was lost,
 * which is what a crash in `C199`'s window destroys.
 */
export const changeNonceOf = (spentNonce: Uint8Array): Uint8Array =>
  upgradeFromTransient(transientHash(
    FIELD_PAIR, [CHANGE_DOMAIN(), degradeToTransient(spentNonce)]));

/**
 * The nonce the coin that LEAVES carries — a payout's payee coin, a split's
 * requested piece — given the nonce it was sent from.
 *
 * Factored out of `paidCoinOf` by `S6d` because a split needs the same
 * derivation with a different token and value, and two copies of a rule the
 * money depends on is `M-104`.
 */
export const sentNonceOf = (spentNonce: Uint8Array): Uint8Array =>
  upgradeFromTransient(transientHash(
    FIELD_PAIR, [SENT_DOMAIN(), degradeToTransient(spentNonce)]));

/**
 * The coin a PAYEE received, derived from the coin it was paid out of.
 *
 * **This is what makes a lost payslip survivable.** A shielded payment tells
 * the payee nothing unless the coin ciphertext reached them — so if that
 * delivery is lost, or was built with the wrong encryption key, the payer can
 * derive the coin again from their own history rather than the money being
 * gone. See `B4` and `C7` in `docs/how-money-can-be-lost.md`.
 *
 * The `spentNonce` is the note the payment was made out of, BEFORE it was paid.
 */
export const paidCoinOf = (
  spentNonce: Hex, token: Hex, amount: bigint,
): VaultCoin => ({
  nonce: toHex(sentNonceOf(fromHex(spentNonce))),
  token,
  value: amount,
});

/* ------------------------------------------------------------------ *
 * the pool
 * ------------------------------------------------------------------ */

/** A coin as the vault contract's pure circuits take it. */
interface RawCoin { nonce: Uint8Array; color: Uint8Array; value: bigint }

/**
 * The vault contract's own two pure circuits, passed in rather than imported.
 *
 * **ONE IMPLEMENTATION OF THE RULE, NEVER A SECOND.** `M-104`, and `C124` is
 * what a second copy costs here: a device that derives a blinding a shade
 * differently from the one a note was committed under cannot spend that note,
 * ever, and nothing says so until a payment is refused. So this file computes
 * no commitment of its own — it composes the contract's, and the caller hands
 * them over so this module does not depend on generated code.
 */
export interface VaultNoteCircuits {
  heldCommitmentOf(coin: RawCoin, blinding: Uint8Array): Uint8Array;
  noteBlindingOf(vault: Uint8Array, coin: RawCoin): Uint8Array;
}

/**
 * What the chain holds for one note of one vault.
 *
 * The composition lives here, once, because both readers of it — this file's
 * replay and `VaultLedger.reconcile` — were about to spell it out separately,
 * and `heldCommitmentOf(coin, noteBlindingOf(vault, coin))` written twice is
 * two chances to write it once with the arguments the other way round.
 */
export const commitmentForNote = (
  circuits: VaultNoteCircuits, vault: Hex, coin: VaultCoin,
): Hex => {
  const raw: RawCoin = {
    nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value,
  };
  const vaultBytes = fromHex(vault);
  return toHex(circuits.heldCommitmentOf(raw, circuits.noteBlindingOf(vaultBytes, raw)));
};

/**
 * One thing that happened to this vault, as the owner's records remember it.
 *
 * **EVERY SPENDING EVENT NAMES THE NOTE IT SPENT**, and that field is the whole
 * difference between this and the function it replaces. A pool has no "the"
 * note, so an amount alone does not say which of sixteen notes moved. The
 * client already has it: `VaultLedger.payout` returns `spentNote`, taken from
 * the `noteToSpend` witness the contract actually called.
 *
 * `splitNote` is the contract's name; `presplit` is the scope's word for when
 * it is run. They are the same circuit.
 */
export type VaultEvent =
  /** Money arriving. The coin is the depositor's own record of what they sent. */
  | { kind: 'deposit'; coin: VaultCoin }
  /** One payee of an approved run. `spent` is the nonce of the note paid from. */
  | { kind: 'payout'; spent: Hex; amount: bigint }
  /** Housekeeping: one note into two, both kept. `amount` is the piece asked for. */
  | { kind: 'split'; spent: Hex; amount: bigint };

/** A note, with wherever the chain filed it if that is known. */
export interface PoolNote extends VaultCoin {
  /**
   * Where the chain filed its commitment, which is what makes a coin QUALIFIED
   * and spendable. **Not derivable and never derived** — the commitment tree
   * assigns it. Absent on a note the pool never recorded: recovering one costs
   * a rescan of the chain, which is inconvenience rather than money.
   */
  index?: bigint;
  /** What the chain holds for it. */
  commitment: Hex;
}

/**
 * What the chain says this vault holds, set against what the pool believed.
 *
 * Four answers rather than one, and they must be four: they have different
 * consequences and a caller that cannot tell them apart will do the wrong one.
 */
export interface PoolRecovery {
  /**
   * Every note the chain holds that the history can name. **This is the pool,
   * rebuilt** — replace the local one with it rather than merging.
   */
  held: PoolNote[];
  /**
   * The subset of `held` the pool did not know about. **This is `C199`'s
   * window, answered**: a call landed and the pool write never happened.
   */
  recovered: PoolNote[];
  /**
   * Notes the pool holds that the chain does not. Either they were spent and
   * the pool never learned, or a call the pool recorded never landed. **They
   * would be refused at payment time**, so they are dropped rather than carried.
   */
  stale: PoolNote[];
  /**
   * Commitments the chain holds that nothing in the history explains. **These
   * are NOT recovered and must not be guessed at**: a commitment discloses
   * nothing, so there is no way from these 32 bytes to a spendable note. The
   * money is visibly on chain and needs whoever created the note — an outside
   * depositor, or a missing page of the history — to say what it was.
   */
  unexplained: Hex[];
  /**
   * Every coin this history paid OUT, in the order the events give. What a
   * payer needs to re-serve somebody who lost their payslip (`B4`).
   */
  paid: VaultCoin[];
}

export interface PoolRecoveryInput {
  /** The vault's own address, hex. Part of every one of its commitments. */
  vault: Hex;
  /** The vault's `notes` set as the chain holds it, hex commitments. */
  chain: readonly Hex[];
  /** The pool as it was last written. May be stale, empty, or wrong. */
  pool: readonly VaultCoin[];
  /**
   * Everything that has happened to this vault, from the owner's records.
   *
   * Events touching ONE note must be in order relative to each other. Events
   * touching different notes need no order at all — that is the pool's own
   * property and it is why a payroll does not stall behind one stuck payment.
   */
  history: readonly VaultEvent[];
  /** The vault contract's `heldCommitmentOf` and `noteBlindingOf`. */
  circuits: VaultNoteCircuits;
  /**
   * Where the chain filed each note, by commitment, if the caller has read it.
   *
   * Optional because a recovery that stops for want of an index would be a
   * recovery nobody runs: an index costs a rescan and a nonce cannot be got
   * back at all. What is missing is reported as missing.
   */
  indexOf?: (commitment: Hex) => bigint | undefined;
}

/**
 * Rebuilds a vault's pool from its history and the chain's own note set.
 *
 * **The result is what the CHAIN holds**, not what the history says: every note
 * in `held` has been checked for membership in the set the chain published.
 * Nothing here is a candidate a caller has to verify afterwards, which is what
 * the function this replaces returned and what made it dangerous to use.
 *
 * It throws only where the history cannot be true — a note spent that never
 * existed, an amount larger than the note it came from — because a replay past
 * an impossible event produces notes belonging to no vault. **Refusing is the
 * recoverable failure; continuing is not.**
 */
export const replayVault = (input: PoolRecoveryInput): PoolRecovery => {
  const { vault, circuits } = input;
  const commitmentOf = (coin: VaultCoin): Hex => commitmentForNote(circuits, vault, coin);

  /**
   * Every note the history says has EVER existed, by commitment.
   *
   * Ever, and not "currently": a call that did not land leaves the chain
   * holding a note this replay has already spent, and a note spent long ago is
   * one the chain has already dropped. **Proposing every note that has ever
   * existed and letting the chain choose collapses both crash windows into one
   * question** — did it land? — which is the only question the chain can
   * actually answer.
   */
  const everKnown = new Map<Hex, VaultCoin>();
  /** The notes the history believes are live, by nonce, for looking up a spend. */
  const live = new Map<Hex, VaultCoin>();
  const paid: VaultCoin[] = [];

  const remember = (coin: VaultCoin) => {
    everKnown.set(commitmentOf(coin), coin);
    live.set(coin.nonce, coin);
  };

  const spend = (nonce: Hex, amount: bigint, at: number, what: string): VaultCoin => {
    const note = live.get(nonce);
    if (!note) {
      throw new Error(
        `event ${at} ${what} note ${nonce}, which this vault's history has never held ` +
        '(or has already spent). No note derived past this point is real, so nothing is ' +
        'derived: correct the history, or reconcile against the chain from the last ' +
        'event you are sure of.');
    }
    if (amount <= 0n) {
      throw new Error(`event ${at} moves ${amount}, which is not a ${what}`);
    }
    if (amount > note.value) {
      throw new Error(
        `event ${at} ${what} ${amount} out of note ${nonce}, which holds ${note.value}. ` +
        'The history is wrong, and no note derived past this point is real.');
    }
    live.delete(nonce);
    return note;
  };

  input.history.forEach((e, i) => {
    if (e.kind === 'deposit') {
      if (e.coin.value <= 0n) throw new Error(`event ${i} deposits ${e.coin.value}, which is not a deposit`);
      if (live.has(e.coin.nonce)) {
        throw new Error(
          `event ${i} deposits note ${e.coin.nonce}, which this vault already holds. ` +
          'Two notes cannot share a nonce, so one of these two records is wrong.');
      }
      /* A deposit adds ONE note. It merges with nothing — the vault holding two
       * notes of a token is the normal case, not a mess to tidy. */
      remember(e.coin);
      return;
    }

    if (e.kind === 'payout') {
      const note = spend(e.spent, e.amount, i, 'pays');
      paid.push(paidCoinOf(e.spent, note.token, e.amount));
      /*
       * NO CHANGE COIN WHEN THE NOTE IS SPENT EXACTLY. `payout` inserts only
       * `if (result.change.is_some)`, so a pool entry here would be a note the
       * chain does not have — the divergence that makes a pool unspendable.
       */
      if (e.amount < note.value) {
        remember({
          nonce: toHex(changeNonceOf(fromHex(e.spent))),
          token: note.token,
          value: note.value - e.amount,
        });
      }
      return;
    }

    /*
     * A SPLIT KEEPS BOTH HALVES, so both are proposed. The contract asserts
     * `amount < coin.value` — a split of a note into the whole of itself is
     * refused — so the remainder always exists, and asserting it here rather
     * than branching keeps this file's model of the circuit honest.
     */
    const note = spend(e.spent, e.amount, i, 'splits');
    if (e.amount >= note.value) {
      throw new Error(
        `event ${i} splits ${e.amount} out of a note holding ${note.value}. A split has to ` +
        'leave something behind, so the contract refuses this and it cannot have happened.');
    }
    remember({
      nonce: toHex(sentNonceOf(fromHex(e.spent))), token: note.token, value: e.amount,
    });
    remember({
      nonce: toHex(changeNonceOf(fromHex(e.spent))),
      token: note.token,
      value: note.value - e.amount,
    });
  });

  /* What the pool believed, by commitment, so "did the pool know" is a lookup. */
  const knownToPool = new Map<Hex, VaultCoin>(
    input.pool.map((n) => [commitmentOf(n), n]));

  const onChain = new Set<Hex>(input.chain);
  const noteFor = (commitment: Hex, coin: VaultCoin): PoolNote => ({
    ...coin, commitment, index: input.indexOf?.(commitment),
  });

  const held: PoolNote[] = [];
  const recovered: PoolNote[] = [];
  for (const [commitment, coin] of everKnown) {
    if (!onChain.has(commitment)) continue;
    const note = noteFor(commitment, coin);
    held.push(note);
    if (!knownToPool.has(commitment)) recovered.push(note);
  }

  const stale: PoolNote[] = [];
  for (const [commitment, coin] of knownToPool) {
    if (!onChain.has(commitment)) stale.push(noteFor(commitment, coin));
  }

  const explained = new Set<Hex>(held.map((n) => n.commitment));
  const unexplained = input.chain.filter((c) => !explained.has(c));

  return { held, recovered, stale, unexplained, paid };
};

/**
 * **REBUILD A POOL FROM THE CHAIN AND THE POOL'S OWN FILED VERSIONS, WITH NO
 * HISTORY OF EVENTS AT ALL.**
 *
 * `replayVault` above needs a `history` of what has happened to the vault, and
 * **nothing in this repository produces one** -- which is why fourteen refusals
 * across the money path have been naming a remedy that cannot be run. This is
 * the route that needs no history, and it exists because the pool's versions
 * stopped being overwritten: each one is filed under its own name, so the union
 * of all of them is every note this pool has ever believed in.
 *
 * **THE WHOLE OF IT IS: PROPOSE EVERY NOTE EVER FILED, AND LET THE CHAIN
 * CHOOSE.** A note the chain still holds is held; one it does not is spent or was
 * never created, and either way it is not money. That is `replayVault`'s own
 * design -- *"proposing every note that has ever existed and letting the chain
 * choose collapses both crash windows into one question"* -- reached from a
 * different record of what has ever existed. **So it delegates rather than
 * deriving anything itself**: no second implementation of the rule the money
 * depends on, which is the failure this project has paid for most often.
 *
 * ------------------------------------------------------------------------
 * **WHAT IT CANNOT RECOVER, SAID PLAINLY BECAUSE THE GAP IS THE POINT.**
 *
 * A note that was never written to ANY version is not in the union, so it is not
 * proposed, and it comes back as an unexplained commitment rather than as money.
 * **That is exactly the note a payment loses when the process stops between the
 * transaction and the pool write**: the change note, on chain, named nowhere.
 * Its nonce is derivable from the note that was spent (`changeNonceOf`, and the
 * spent note IS still in the pool because the write never happened) and its
 * colour is that note's colour -- but its VALUE is the spent note's value minus
 * an amount only the payment knew, and a commitment cannot be inverted to find
 * it. **Nothing here guesses.** Closing that needs the amount written down
 * before the money moves, which is a journal and not a derivation.
 */
export const reconcileVaultPool = (input: {
  /** The vault's own address, hex. Part of every one of its commitments. */
  vault: Hex;
  /** The vault's `notes` set as the chain holds it, hex commitments. */
  chain: readonly Hex[];
  /**
   * Every version of this pool that has been filed, in any order. The newest is
   * taken as what the pool currently believes; the union of all of them is what
   * is proposed to the chain.
   */
  versions: readonly { version: number; notes: readonly VaultCoin[] }[];
  circuits: VaultNoteCircuits;
  indexOf?: (commitment: Hex) => bigint | undefined;
}): PoolRecovery => {
  if (input.versions.length === 0) {
    throw new Error(
      'this pool has no filed versions, so there is nothing to propose to the chain. That is not '
      + 'a vault holding nothing: it is this machine holding no record of it. A rebuild needs '
      + 'either a version of the pool or a history of the vault\'s events, and with neither there '
      + 'is nothing to reconcile -- a commitment discloses nothing and cannot be inverted.');
  }
  const newest = [...input.versions].sort((a, b) => b.version - a.version)[0]!;

  /*
   * **ONE ENTRY PER NONCE, AND A NONCE THAT DESCRIBES TWO DIFFERENT COINS IS A
   * CONTRADICTION RATHER THAN A CHOICE.**
   *
   * The same note appears in every version filed after it arrived, so the union
   * has to be taken by nonce. Two versions disagreeing about what a nonce is
   * worth cannot both be true, and picking one would be this function inventing
   * money: it is handed to `replayVault` as two deposits of one nonce, which is
   * the contradiction that function already refuses by name.
   */
  const everFiled = new Map<Hex, VaultCoin>();
  const contradictions: VaultCoin[] = [];
  for (const v of input.versions) {
    for (const note of v.notes) {
      const already = everFiled.get(note.nonce);
      if (!already) { everFiled.set(note.nonce, note); continue; }
      if (already.token !== note.token || already.value !== note.value) contradictions.push(note);
    }
  }

  return replayVault({
    vault: input.vault,
    chain: input.chain,
    pool: newest.notes,
    /*
     * **EVERY NOTE EVER FILED, OFFERED AS A DEPOSIT, AND THE KIND IS NOT A LIE
     * ABOUT WHERE IT CAME FROM.** `replayVault` reads a deposit event as *"this
     * coin existed"* and nothing more -- it is the only event shape that carries
     * a whole coin, and what this function knows about each note is the whole
     * coin. Whether it arrived by deposit, as change, or as a split's remainder
     * is not a question the chain is being asked: the question is whether the
     * chain still holds it.
     */
    history: [...everFiled.values(), ...contradictions].map((coin) => ({ kind: 'deposit' as const, coin })),
    circuits: input.circuits,
    ...(input.indexOf === undefined ? {} : { indexOf: input.indexOf }),
  });
};

/**
 * The one-line answer for an operator: is this pool the chain's pool?
 *
 * A convenience over `replayVault`, and deliberately not a boolean — a caller
 * that can read a `false` and carry on is the failure `C198` replaced.
 */
export const describeRecovery = (r: PoolRecovery): string =>
  `${r.held.length} note(s) held, ${r.recovered.length} recovered that the pool did not know ` +
  `about, ${r.stale.length} the pool held that the chain does not, ` +
  `${r.unexplained.length} commitment(s) nothing in the history explains`;
