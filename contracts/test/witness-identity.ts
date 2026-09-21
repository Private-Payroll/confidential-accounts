/**
 * **THE CHECK THAT EVERY WITNESS HANDS BACK THE PRIVATE STATE IT WAS GIVEN.**
 *
 * The property and what rests on it are written up in
 * `witnesses-keep-the-state-they-were-given.test.ts`, which is the file that
 * asserts it. This one is the mechanism, and it is separate for one reason:
 * **it takes the witness map as an ARGUMENT, so the same check can be pointed
 * at a deliberately broken copy of the contract's private half and watched
 * naming it.** A check that can only ever be run against the real thing is a
 * check nobody has seen fail.
 *
 * Not a `.test.ts`, so the runner does not collect it.
 */
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

import { VACANT_SLOT, witnesses, type AccountPrivateState, type SignerPath } from '../src/witnesses.js';

/** Every witness's name, from the map itself rather than from a list here. */
export type WitnessName = keyof typeof witnesses;

/** The shape every witness in this contract returns. */
export type WitnessResult = readonly [AccountPrivateState, unknown];
export type WitnessFn = (
  context: WitnessContext<unknown, AccountPrivateState>,
  ...rest: any[]
) => WitnessResult;

/**
 * A path a device already holds, so `signerPath` answers without a tree.
 *
 * `pinAnyLeaf` is the seam that makes it answer for whatever leaf it is asked
 * about. Used here for REACH rather than for forgery.
 *
 * **AND IT IS ONLY ONE OF THAT WITNESS'S TWO BRANCHES, WHICH IS WHY THERE IS A
 * LEDGER ARGUMENT BELOW.** A pinned record short-circuits before the tree is
 * touched, so a check that only ever ran pinned would never execute the branch
 * that resolves a path out of the signer tree - and a memoisation of the
 * resolved path back into the record is exactly the change this whole check
 * exists to catch, made in the one place a check that never goes there cannot
 * see.
 */
export const PINNED_PATH: SignerPath = { leaf: VACANT_SLOT, path: [] };

/**
 * A signer tree that answers with a path, so the unpinned branch can be run.
 *
 * The shape is the one `signerPath` asks for and nothing more: what is under
 * test is which object comes back beside the answer, not what the answer is.
 */
export const aTreeThatFindsAPath = (found: SignerPath = PINNED_PATH): unknown =>
  ({ signers: { findPathForLeaf: () => found } });

/**
 * What each witness takes after the context.
 *
 * **EXHAUSTIVE OVER THE WITNESS MAP BY CONSTRUCTION, AND THAT IS THE HALF THAT
 * SURVIVES A CHANGE THAT ADDS A WITNESS.** A driver that guessed would hand
 * `undefined` to the one witness that takes an argument and then report a green
 * result about a call that never happened. A tenth witness does not compile
 * until somebody says how to call it; a witness that takes nothing still needs
 * an entry, and the entry is `[]`.
 */
export const EXTRA_ARGUMENTS: Record<WitnessName, readonly unknown[]> = {
  localSecretKey: [],
  signerBlinding: [],
  signerScope: [],
  signerPath: [VACANT_SLOT],
  assetId: [],
  assetBlinding: [],
  proposalSalt: [],
  changeAmount: [],
  changeBatchDigest: [],
};

/**
 * Runs every witness in a map and names the ones that did not hand back the
 * object they were given.
 *
 * **IDENTITY, NOT EQUALITY.** `{ ...state }` is deeply equal to `state` and is
 * a different object, so a comparison written the obvious way passes on exactly
 * the change this exists to catch.
 *
 * A witness that THROWS is reported under its own reason rather than passing. A
 * check that swallowed a throw would report a clean bill of health for a
 * private half nobody could call at all.
 */
export const witnessesThatDidNotHandBackWhatTheyWereGiven = (
  map: Readonly<Record<string, WitnessFn>>,
  state: AccountPrivateState,
  ledger: unknown = {},
): string[] => {
  const context = {
    ledger,
    privateState: state,
    contractAddress: 'read by no witness here',
  } as unknown as WitnessContext<unknown, AccountPrivateState>;

  const wrong: string[] = [];
  for (const [name, witness] of Object.entries(map)) {
    const extra = EXTRA_ARGUMENTS[name as WitnessName];
    if (extra === undefined) {
      wrong.push(`${name}: this check does not know how to call it`);
      continue;
    }
    let result: WitnessResult;
    try {
      result = witness(context, ...extra);
    } catch (e) {
      wrong.push(`${name}: threw - ${String((e as Error)?.message ?? e)}`);
      continue;
    }
    if (!Array.isArray(result)) {
      wrong.push(`${name}: did not return a pair`);
      continue;
    }
    if (result[0] !== state) wrong.push(`${name}: handed back a different object`);
  }
  return wrong;
};
