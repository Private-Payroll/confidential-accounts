import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import {
  advance, cancelRecovery, completeRecovery, offerPiece, progress, startRecovery, withdrawPiece,
} from './session.js';
import type { RecoverySession } from './session.js';
import { combinePieces, splitSecret } from './pieces.js';
import type { Placement } from './pieces.js';
import { identityFromSecret, newSecret, secretFromWords, wordsFromSecret } from '../keys/derivation.js';

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const THREE: readonly Placement[] = [
  { label: 'Your Google account', holder: 'google:person@example.com' },
  { label: 'Printed', holder: 'paper' },
  { label: 'My other laptop', holder: 'device:laptop-2' },
];

const T0 = 1_700_000_000_000;
const secret = secretFromWords(TEST_MNEMONIC);
const pieces = async () => (await splitSecret(secret, THREE, 2)).pieces;

const offer = (p: { placement: Placement; bytes: Uint8Array }) =>
  ({ holder: p.placement.holder, bytes: p.bytes });

describe('a recovery that finishes', () => {
  it('walks gathering → ready → completed, and gives back the account', async () => {
    const [google, paper] = await pieces();
    let session: RecoverySession = startRecovery({ id: 'r1', threshold: 2, now: T0 });
    expect(progress(session)).toEqual({ have: 0, need: 2, state: 'gathering' });

    session = offerPiece(session, offer(google!), T0 + 1_000);
    expect(session.state).toBe('gathering');

    session = offerPiece(session, offer(paper!), T0 + 2_000);
    expect(session.state).toBe('ready');

    const { secret: back, session: done } = await completeRecovery(session, T0 + 3_000);
    expect(hex(back)).toBe(hex(secret));
    expect(done.state).toBe('completed');

    /*
     * AND IT KEEPS NONE OF THE PIECES. A completed session is what a
     * host stores, and it has no reason to hold enough of somebody's account to
     * rebuild it for ever afterwards.
     */
    expect(done.gathered).toHaveLength(0);
    expect(done.usedCount).toBe(2);

    /* The thing that actually matters. */
    expect(wordsFromSecret(back).join(' ')).toBe(TEST_MNEMONIC);
    expect(identityFromSecret(back).money.zswap).toEqual(identityFromSecret(secret).money.zswap);
  });

  it('can be picked up on another device, because it is a value and not a call', async () => {
    /*
     * §7.11's whole point. The session is a plain frozen object, so a host can
     * store it, send it, and carry on somewhere else — which is what people
     * actually do: start on a laptop, finish where the pieces are.
     */
    const [google, , laptop] = await pieces();
    const started = offerPiece(
      startRecovery({ id: 'r2', threshold: 2, now: T0 }), offer(google!), T0);

    const carried: RecoverySession = JSON.parse(JSON.stringify({
      ...started,
      gathered: started.gathered.map((p) => ({ holder: p.holder, bytes: Array.from(p.bytes) })),
    })) as never;
    const restored: RecoverySession = {
      ...carried,
      gathered: carried.gathered.map((p) => ({
        holder: p.holder, bytes: Uint8Array.from(p.bytes as unknown as number[]),
      })),
    };

    const finished = offerPiece(restored, offer(laptop!), T0 + 60_000);
    expect(finished.state).toBe('ready');
    expect(hex((await completeRecovery(finished, T0 + 60_001)).secret)).toBe(hex(secret));
  });
});

describe('what a recovery refuses', () => {
  it('will not finish before the threshold is met', async () => {
    const [google] = await pieces();
    const session = offerPiece(
      startRecovery({ id: 'r3', threshold: 2, now: T0 }), offer(google!), T0);
    await expect(completeRecovery(session, T0 + 1)).rejects.toMatchObject({
      code: 'not-enough-pieces',
    });
  });

  it('COUNTS TWO PIECES FROM ONE HOLDER ONCE', async () => {
    /*
     * Somebody who opens a Google account can fetch everything in it. Counting
     * both would let one compromised account reach a threshold of two on its
     * own — the same failure the "no two pieces behind one holder" rule
     * prevents at set-up, arriving through the other door.
     *
     * A second offer from the same holder REPLACES the first, so a re-fetch
     * after a dropped connection is not an error.
     */
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'r4', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, { holder: 'GOOGLE:Person@Example.com', bytes: google!.bytes }, T0);
    expect(session.gathered).toHaveLength(1);
    expect(session.state).toBe('gathering');

    session = offerPiece(session, offer(paper!), T0);
    expect(session.state).toBe('ready');
  });

  it('refuses a threshold of one at the door', () => {
    expect(() => startRecovery({ id: 'r5', threshold: 1, now: T0 }))
      .toThrow(/not a threshold/u);
  });

  it('refuses a piece that does not say where it came from', async () => {
    const [google] = await pieces();
    const session = startRecovery({ id: 'r6', threshold: 2, now: T0 });
    expect(() => offerPiece(session, { holder: '  ', bytes: google!.bytes }, T0)).toThrow();
  });

  it('drops back to gathering when a piece is taken out', async () => {
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'r7', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);
    expect(session.state).toBe('ready');

    session = withdrawPiece(session, 'paper', T0 + 10);
    expect(session.state).toBe('gathering');
    expect(session.readyAt).toBeNull();
    await expect(completeRecovery(session, T0 + 20)).rejects.toThrow();
  });
});

describe('what a finished recovery leaves behind', () => {
  it('A CANCELLED RECOVERY KEEPS NO PIECES EITHER', async () => {
    /*
     * The first version emptied a COMPLETED session and left the cancelled one
     * carrying everything. Cancellation is the veto — the path taken when a
     * recovery is believed to be a theft — so the artefact left behind by a
     * REFUSED takeover was the one still holding enough pieces to rebuild the
     * account that was nearly taken. The good outcome forgot and the bad one
     * remembered.
     */
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'x1', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);

    const stopped = cancelRecovery(session, 'that was not me');
    expect(stopped.gathered).toHaveLength(0);
    expect(stopped.usedCount).toBe(2);
    /* And there is nothing left in it to rebuild anything from. */
    await expect(combinePieces(stopped.gathered.map((p) => p.bytes))).rejects.toThrow();
  });

  it('still reports how far it got, after the pieces are gone', async () => {
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'x2', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);
    const { session: done } = await completeRecovery(session, T0);
    expect(progress(done)).toEqual({ have: 2, need: 2, state: 'completed' });
  });

  it('REFUSES A BLOB THE LIBRARY CANNOT READ AT THE DOOR, in the library\'s words', async () => {
    /*
     * The door used to peek at one byte: anything whose first two bytes looked
     * right was accepted for its threshold. Now the same header read the
     * rebuild does runs at the door, so the refusal happens when the piece is
     * offered — not after somebody has gathered everything else.
     */
    const session = startRecovery({ id: 'c81a', threshold: 2, now: T0 });
    expect(() => offerPiece(session, { holder: 'the safe', bytes: new Uint8Array(10) }, T0))
      .toThrow(/a recovery piece is more than/u);
    const wrongFormat = new Uint8Array(20);
    wrongFormat[0] = 2;
    expect(() => offerPiece(session, { holder: 'the safe', bytes: wrongFormat }, T0))
      .toThrow(/format 2/u);
  });

  it('REFUSES A PIECE THAT DISAGREES ABOUT THE THRESHOLD, and names it', async () => {
    /*
     * The reproduction: one good piece of a 2-of-3 set plus a blob
     * claiming a different threshold read "2 of 9 pieces" with no error, in
     * front of a `combinePieces` whose refusals were all correct and all too
     * late. The number on the screen is the AGREED one; a piece naming a
     * different one is refused by name. (Crafted from a REAL piece so only the
     * threshold byte disagrees — the account check catches the fingerprint first otherwise.)
     */
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'c81b', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    expect(session.threshold).toBe(2);

    const altered = Uint8Array.from(paper!.bytes);
    altered[1] = 9;
    expect(() => offerPiece(session, { holder: 'the safe', bytes: altered }, T0))
      .toThrow(/says 9 pieces are needed, and the piece already in says 2/u);
    /* And nothing moved: the count still describes the pieces that are in. */
    expect(session.threshold).toBe(2);
    expect(session.gathered).toHaveLength(1);
  });

  it('REFUSES A PIECE FROM A DIFFERENT ACCOUNT AT THE DOOR, and says so', async () => {
    /*
     * The door reads the whole header now, not a third of it. A piece whose
     * fingerprint names another secret can never combine with the pieces
     * already in — counting it toward "enough" moves the failure to the
     * last press instead of removing it.
     */
    const [google] = await pieces();
    const foreign = await splitSecret(newSecret(), THREE, 2);
    let session = startRecovery({ id: 'c83a', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    expect(() => offerPiece(
      session, { holder: 'the safe', bytes: foreign.pieces[1]!.bytes }, T0))
      .toThrow(/from a DIFFERENT ACCOUNT/u);
    expect(session.gathered).toHaveLength(1);
    expect(session.state).toBe('gathering');
  });

  it('REFUSES A PIECE FROM A DIFFERENT CUT of the same account, and says which', async () => {
    /*
     * The rules preserve superseded sets and name their holders, so old and new
     * cards coexist in the same drawer BY DESIGN, for exactly the person who
     * is recovering. Same fingerprint, same threshold, different set id: the
     * two sentences are different and the header can tell them apart.
     */
    const [google] = await pieces();
    const recut = await splitSecret(secret, THREE, 2);
    let session = startRecovery({ id: 'c83b', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    expect(() => offerPiece(
      session, { holder: 'the safe', bytes: recut.pieces[1]!.bytes }, T0))
      .toThrow(/different cut of the same account/u);
    /* Never "enough pieces" from a mixture that cannot combine. */
    expect(session.state).toBe('gathering');
    expect(session.gathered).toHaveLength(1);
  });

  it('RECOMPUTES THE THRESHOLD ON WITHDRAWAL from the pieces that remain', async () => {
    /*
     * Belt to the door's braces. A session that somehow carries a number its
     * remaining pieces do not say — the exact artefact the forgiving door
     * used to leave behind — is corrected by the next withdrawal, because the
     * number is re-read from what is actually in rather than kept.
     */
    const [google] = await pieces();
    const lying: RecoverySession = Object.freeze({
      id: 'c81c',
      state: 'gathering' as const,
      threshold: 9,
      gathered: Object.freeze([offer(google!)]),
      usedCount: 0,
      startedAt: T0,
      readyAt: null,
      waitMs: 0,
      cancelledBecause: null,
    });
    const corrected = withdrawPiece(lying, 'nobody-of-that-name', T0 + 1);
    expect(corrected.threshold).toBe(2);
    expect(corrected.gathered).toHaveLength(1);
  });

  it('TAKES THE THRESHOLD OFF THE PIECES, not out of somebody\'s memory', async () => {
    /*
     * Every piece carries its own threshold precisely so nobody would
     * have to remember it, and the session in front of it still asked. A 2-of-3
     * set recovered through a session started with the wrong number refused
     * with *"you have 2 of the 3 pieces you need"* — while those same two
     * pieces rebuilt the account perfectly. Somebody told they are short a
     * piece they will never find concludes the account is gone.
     */
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'x3', threshold: 9, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    expect(session.threshold).toBe(2);
    session = offerPiece(session, offer(paper!), T0);
    expect(session.state).toBe('ready');
    expect(hex((await completeRecovery(session, T0)).secret)).toBe(hex(secret));
  });
});

describe('the waiting period, which is what the chain version needs — §7.11', () => {
  const WAIT = 48 * 60 * 60 * 1000;

  it('is ZERO in v1, so a session goes straight to ready', async () => {
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'w0', threshold: 2, now: T0 });
    expect(session.waitMs).toBe(0);
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);
    expect(session.state).toBe('ready');
  });

  it('holds a session in WAITING until the window is up, and refuses to finish early',
    async () => {
      /*
       * Switched on, this is the whole veto: enough pieces are in, and the
       * account still does not move for two days, during which any device the
       * real owner still holds can stop it. Nothing about the flow changes —
       * which is the property this file exists to guarantee.
       */
      const [google, paper] = await pieces();
      let session = startRecovery({ id: 'w1', threshold: 2, now: T0, waitMs: WAIT });
      session = offerPiece(session, offer(google!), T0);
      session = offerPiece(session, offer(paper!), T0);

      expect(session.state).toBe('waiting');
      expect(session.readyAt).toBe(T0 + WAIT);
      await expect(completeRecovery(session, T0 + WAIT - 1))
        .rejects.toThrow(/waiting period/u);

      const later = advance(session, T0 + WAIT);
      expect(later.state).toBe('ready');
      expect(hex((await completeRecovery(later, T0 + WAIT)).secret)).toBe(hex(secret));
    });

  it('CAN BE VETOED while it waits, and the veto is final', async () => {
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'w2', threshold: 2, now: T0, waitMs: WAIT });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);
    expect(session.state).toBe('waiting');

    const stopped = cancelRecovery(session, 'that was not me');
    expect(stopped.state).toBe('cancelled');
    expect(stopped.cancelledBecause).toBe('that was not me');

    /* Terminal in every direction. */
    await expect(completeRecovery(stopped, T0 + WAIT + 1)).rejects.toThrow(/cancelled/u);
    expect(() => offerPiece(stopped, offer(google!), T0 + WAIT)).toThrow(/cancelled/u);
    expect(advance(stopped, T0 + WAIT * 10).state).toBe('cancelled');
    expect(cancelRecovery(stopped, 'again').cancelledBecause).toBe('that was not me');
  });

  it('does not restart its clock when pieces are shuffled', async () => {
    /*
     * A window that resets on every change is a window an attacker keeps open
     * for ever. The deadline is set once, when the threshold is first met.
     */
    const [google, paper, laptop] = await pieces();
    let session = startRecovery({ id: 'w3', threshold: 2, now: T0, waitMs: WAIT });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);
    const deadline = session.readyAt;

    session = offerPiece(session, offer(laptop!), T0 + 5_000);
    expect(session.readyAt).toBe(deadline);
    expect(session.state).toBe('waiting');
  });

  it('starts a NEW clock if the threshold was lost and met again', async () => {
    /*
     * The other half of the same rule: dropping below the threshold clears the
     * deadline, so a piece removed and re-added cannot inherit a window that
     * was already most of the way through.
     */
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'w4', threshold: 2, now: T0, waitMs: WAIT });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);
    expect(session.readyAt).toBe(T0 + WAIT);

    session = withdrawPiece(session, 'paper', T0 + WAIT - 1_000);
    expect(session.readyAt).toBeNull();

    session = offerPiece(session, offer(paper!), T0 + WAIT - 1_000);
    expect(session.readyAt).toBe(T0 + WAIT - 1_000 + WAIT);
    await expect(completeRecovery(session, T0 + WAIT)).rejects.toThrow(/waiting period/u);
  });

  it('cannot be cancelled after it has finished, and says why', async () => {
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'w5', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);
    const { session: done } = await completeRecovery(session, T0);
    expect(() => cancelRecovery(done, 'too late')).toThrow(/already finished/u);
  });

  it('cannot be completed twice', async () => {
    const [google, paper] = await pieces();
    let session = startRecovery({ id: 'w6', threshold: 2, now: T0 });
    session = offerPiece(session, offer(google!), T0);
    session = offerPiece(session, offer(paper!), T0);
    const { session: done } = await completeRecovery(session, T0);
    await expect(completeRecovery(done, T0 + 1)).rejects.toThrow(/completed/u);
  });
});
