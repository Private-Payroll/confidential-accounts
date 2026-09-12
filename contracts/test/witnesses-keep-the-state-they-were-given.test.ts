/**
 * **EVERY WITNESS HANDS BACK THE PRIVATE STATE IT WAS GIVEN, AND THIS IS THE
 * ALARM THAT GOES OFF WHEN ONE STOPS.**
 *
 * -- WHAT THE PROPERTY IS ------------------------------------------------
 *
 * A witness is handed the calling device's private state and returns a pair:
 * the state to carry forward, and the value the circuit reads. Every witness in
 * `contracts/src/witnesses.ts` returns THE SAME OBJECT it was handed - not a
 * copy of it, not a merge into it, the identical reference - because none of
 * them changes anything about the device. `same()` is that statement written
 * once, and this file is the check that it is still true.
 *
 * -- WHY IT IS LOAD-BEARING RATHER THAN TIDY -----------------------------
 *
 * After a call settles entirely, the SDK writes the state the circuit ran with
 * back into whatever store the call was configured against. While every witness
 * hands back what it was given, that write puts back exactly what it read, so
 * it can add nothing to a store that was not already there.
 *
 * **THAT IS THE WHOLE REASON A DEVICE CAN ANSWER FOR ITS SIGNING SECRET
 * WITHOUT STORING ONE.** A device may compose the record a circuit reads - its
 * secret key, its blinding, its scope - in memory at the moment it is asked,
 * hand it to the scheme, and keep none of it, and nothing downstream can
 * persist it, because nothing downstream ever holds anything but the object it
 * was passed. The day one witness returns a NEW object instead, that stops
 * being true, and it stops being true SILENTLY: the call still succeeds, the
 * proof is still valid, and a signer's secret key is simply in a store
 * afterwards.
 *
 * -- WHY IT IS A TEST AND NOT A COMMENT ----------------------------------
 *
 * It is a property nothing declares, nothing enforces and nothing reads. It
 * survives today because no one has yet written the code that would end it, and
 * the code that would end it is one defensive copy inside a witness somebody
 * adds for a reason that looks entirely sensible where they are standing.
 *
 * -- AND IDENTITY IS THE ASSERTION, NOT EQUALITY -------------------------
 *
 * `{ ...state }` is deeply equal to `state` and is a different object, so a
 * check written with a deep comparison passes on exactly the change this file
 * exists to catch. Every comparison here is a reference comparison, in
 * `witness-identity.ts`.
 */
import { describe, expect, it } from 'vitest';

import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import {
  EXTRA_ARGUMENTS,
  PINNED_PATH,
  aTreeThatFindsAPath,
  witnessesThatDidNotHandBackWhatTheyWereGiven,
  type WitnessFn,
} from './witness-identity.js';
import { privateStateFor } from './simulator.js';

describe('the private half hands back the state it was given', () => {
  /** A device replaying a path it captured. `signerPath` short-circuits. */
  const pinned = (): AccountPrivateState =>
    ({ ...privateStateFor(1), pinnedPath: PINNED_PATH, pinAnyLeaf: true });

  /**
   * A device with no pin, which is every real one. `signerPath` goes to the
   * tree, and that is its OTHER branch - the one a check that only ever ran
   * pinned would never execute.
   */
  const unpinned = (): AccountPrivateState =>
    ({ ...privateStateFor(1), pinnedPath: null, pinAnyLeaf: false });

  const real = witnesses as unknown as Record<string, WitnessFn>;

  /**
   * **THE ALARM.**
   *
   * Goes red the day any witness returns an object that is not the one it was
   * handed - a spread, a merge, a normalisation, a defensive copy - and the
   * message says which one it was and what it costs.
   */
  it('EVERY witness returns the identical object, so a call can add nothing to a device', () => {
    expect(
      witnessesThatDidNotHandBackWhatTheyWereGiven(real, pinned()),
      'a witness no longer hands back the record it was given. A device may only answer for a '
      + 'signing secret it does not store because the record a call carries forward is the '
      + 'identical object it was handed - the moment one is a copy, the write that follows a '
      + 'settled call puts a secret into a store instead of putting back what it read',
    ).toEqual([]);
  });

  /**
   * **AND AGAIN ON THE BRANCH A PINNED RECORD NEVER REACHES.** `signerPath` is
   * the one witness with two answers: replay the path this device already
   * holds, or resolve one out of the signer tree. Only the second runs on a
   * real device, and it is the one where a resolved path is sitting in a local
   * variable next to the record - which is where somebody memoises it into the
   * record and ends this property without touching anything else.
   */
  it('EVERY witness does it again with no pin, so the branch a real device takes is covered', () => {
    expect(
      witnessesThatDidNotHandBackWhatTheyWereGiven(real, unpinned(), aTreeThatFindsAPath()),
      'a witness no longer hands back the record it was given when the path is resolved from '
      + 'the tree rather than replayed - which is the branch every device that has not pinned '
      + 'anything takes, and that is all of them',
    ).toEqual([]);
  });

  /**
   * **AND THE MAP IS COVERED, NOT SAMPLED.** The loop is only as good as the
   * map it walks, so what the check knows how to call is asserted against what
   * the contract's private half actually declares. The compiler already refuses
   * a missing entry; this refuses a stale one.
   */
  it('the alarm covers every witness the contract declares, not a list written beside it', () => {
    const declared = Object.keys(witnesses).sort();
    expect(
      Object.keys(EXTRA_ARGUMENTS).sort(),
      'a witness has been added or removed and the check was not told how to call it, so it '
      + 'has been walking past it',
    ).toEqual(declared);
    expect(declared).toHaveLength(9);
  });

  /**
   * **THE NEGATIVE CONTROL, ONE PER WITNESS AND NOT ONE PER FILE.**
   *
   * Each REAL witness is wrapped in turn so that it returns a spread of the
   * state it was handed - deeply equal, different object - which is the exact
   * change this file exists to catch and the exact change a deep comparison
   * would miss. Nine mutations, nine red results, so the green case above is
   * known to be a claim that CAN fail rather than a loop that reports nothing.
   */
  it.each(Object.keys(witnesses))('goes red when %s returns a copy instead', (name) => {
    const mutated: Record<string, WitnessFn> = { ...real };
    mutated[name] = (context, ...rest) => {
      const [ps, value] = real[name](context, ...rest);
      return [{ ...ps }, value];
    };

    expect(witnessesThatDidNotHandBackWhatTheyWereGiven(mutated, pinned()))
      .toEqual([`${name}: handed back a different object`]);
    expect(witnessesThatDidNotHandBackWhatTheyWereGiven(mutated, unpinned(), aTreeThatFindsAPath()))
      .toEqual([`${name}: handed back a different object`]);
  });

  /**
   * **THE CONTROL FOR THE BRANCH ITSELF, AND IT IS THE ONE THAT WOULD HAVE
   * BEEN MISSED.** The change this models is the realistic one: remember the
   * path that was just resolved, so the next call does not walk the tree again.
   * It is invisible to a pinned record, because a pinned record never gets
   * there.
   */
  it('goes red when the RESOLVED path is memoised into the record, and only then', () => {
    const mutated: Record<string, WitnessFn> = { ...real };
    mutated.signerPath = (context, ...rest) => {
      const [ps, found] = real.signerPath(context, ...rest);
      /* Only when the answer came from the tree, which is what a memoisation is. */
      if ((ps as AccountPrivateState).pinnedPath === null) {
        return [{ ...(ps as AccountPrivateState), pinnedPath: found as any }, found];
      }
      return [ps, found];
    };

    expect(witnessesThatDidNotHandBackWhatTheyWereGiven(mutated, unpinned(), aTreeThatFindsAPath()),
      'the unpinned run does not reach the branch that resolves a path from the tree, so a '
      + 'change made there is invisible to this check')
      .toEqual(['signerPath: handed back a different object']);

    /* And the pinned run cannot see it, which is the whole reason both exist. */
    expect(witnessesThatDidNotHandBackWhatTheyWereGiven(mutated, pinned())).toEqual([]);
  });

  /**
   * **AND THE OTHER WAY A SILENT FAILURE ARRIVES: A WITNESS THAT CANNOT BE
   * CALLED AT ALL.** A check that treated a throw as "not a copy" would report
   * a clean private half for a contract whose witnesses all fail, which is the
   * shape of green this repository has paid for more than once.
   */
  it('goes red when a witness throws rather than reporting it clean', () => {
    const mutated: Record<string, WitnessFn> = { ...real };
    mutated.localSecretKey = () => { throw new Error('no record on this device'); };

    expect(witnessesThatDidNotHandBackWhatTheyWereGiven(mutated, pinned()))
      .toEqual(['localSecretKey: threw - no record on this device']);
  });

  /**
   * **AND A WITNESS THE CHECK DOES NOT KNOW HOW TO CALL IS NAMED RATHER THAN
   * SKIPPED.** The compiler catches one added to the contract; this catches a
   * map that grew at run time, which is what a wrapper or a seam does.
   */
  it('goes red when a witness arrives that it does not know how to call', () => {
    const mutated: Record<string, WitnessFn> = {
      ...real,
      somethingNew: ((c: any) => [c.privateState, 1]) as unknown as WitnessFn,
    };

    expect(witnessesThatDidNotHandBackWhatTheyWereGiven(mutated, pinned()))
      .toEqual(['somethingNew: this check does not know how to call it']);
  });
});
