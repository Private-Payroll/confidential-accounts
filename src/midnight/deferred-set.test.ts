/**
 * The deferred-set check moves with the list.
 *
 * `findDeployedPartialContract` checks both directions against `deferral.ts`: the kept circuits' verifier keys
 * must match byte for byte, and the deferred circuits must be absent. The deferred list is now empty, because
 * the contract fits under the ceiling whole, so the absent direction has nothing left to be absent. The tests
 * that exercised it are not kept iterating an empty list, which would report green while asserting nothing.
 * What stands in their place is a test that the list is empty and that nothing removed from the contract is
 * treated as merely deferred. As a result a deployment carrying an operation nobody decided on is not refused by
 * name; that is a gap in the client and not something a test invents.
 *
 * The contract's own circuit set is a change to what is compiled, and this file says so in two places on
 * purpose: the count below, and the comparison against `contracts/managed/keys/`, which is read off disk and
 * will disagree until the contract is compiled again. A red line there is this file doing its job, and is not a
 * number to bring back into agreement by hand.
 *
 * Every fixture except three is derived from the lists in `deferral.ts`, so a change to them carries its own
 * proof rather than a stale copy. The three exceptions are deliberate: the test that pins what is decided (a
 * silent change to it should fail a test), and the two fixtures that are records of real deployments, the live
 * account and an older one. Both are written as records and neither tracks the source tree, because what a chain
 * is carrying does not change when a `.compact` file does.
 *
 * The fake `verifyContractState` mirrors the SDK's semantics rather than stubbing them: every requested circuit
 * must exist in the deployed state with a byte-identical verifier key, and every failure is reported by name in
 * one throw. A stub without the semantics could not fail the way the product would.
 */
import { served, testAddress, TEST_SETTINGS } from '../testing/served-state.js';
import { describe, it, expect, vi } from 'vitest';
import type { PrivateStateAnswer } from './governed-call.js';
import { existsSync, readdirSync } from 'node:fs';

import {
  DEPLOYED_CIRCUITS,
  DEFERRED_CIRCUITS,
  FIRST_STEP_CIRCUITS,
  SECOND_STEP_CIRCUITS,
  assertKnownCircuitSet,
  isDeferredCircuit,
  isDeployedCircuit,
} from './deferral.js';

/* ------------------------------------------------------------------ *
 * fixtures, derived from the lists
 * ------------------------------------------------------------------ */

/** A deterministic per-circuit verifier key, distinct per name. */
// Derived from this file's own location: read relatively, a run started from
// anywhere but the root skips the assertion below without saying so.
const KEY_DIR = new URL('../../contracts/managed/keys', import.meta.url);

if (!existsSync(KEY_DIR)) {
  console.log(
    '  NOT CHECKED HERE: contracts/managed/keys is not on disk, so the assertion that the deferral\n' +
    '  list names exactly the circuits with keys did not run. `npm run compact` builds them.',
  );
}

const keyFor = (name: string): Uint8Array => new TextEncoder().encode(`vk:${name}`);

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** A fake deployed contract state carrying exactly `names`, keyed by `keyFor`. */
const stateWith = (names: string[], overrides: Record<string, Uint8Array> = {}) => {
  const ops = new Map(names.map((n) => [n, { verifierKey: overrides[n] ?? keyFor(n) }]));
  return { operation: (n: string) => ops.get(n) };
};

const providersFor = (state: unknown) => {
  const getVerifierKeys = vi.fn(async (names: string[]) =>
    names.map((n) => [n, keyFor(n)] as [string, Uint8Array]));
  return {
    providers: {
      config: TEST_SETTINGS,
      publicDataProvider: { queryContractState: vi.fn(async () => served(state)) },
      zkConfigProvider: { getVerifierKeys },
    },
    getVerifierKeys,
  };
};

/*
 * The SDK seam, mirrored. `findDeployedPartialContract` imports the module
 * dynamically at call time, so `vi.doMock` here governs it.
 */
vi.doMock('@midnight-ntwrk/midnight-js-contracts', () => ({
  verifyContractState: async (verifierKeys: Array<[string, Uint8Array]>, servedState: any) => {
    const state = servedState.deserialize();
    const bad = verifierKeys
      .filter(([name, key]) => {
        const op = state.operation(name);
        return !op || !op.verifierKey || !bytesEqual(op.verifierKey, key);
      })
      .map(([name]) => name);
    if (bad.length > 0) {
      throw new Error(
        `Following operations: ${bad.join(', ')}, are undefined or have mismatched verifier keys`);
    }
  },
  createCircuitCallTxInterface: () => ({ __callTx: true }),
}));

const find = async (state: unknown, privateStateId: PrivateStateAnswer = 'a-key:acct') => {
  const { findDeployedPartialContract } = await import('./partial-contract.js');
  const { providers, getVerifierKeys } = providersFor(state);
  const call = findDeployedPartialContract(providers as any, {
    compiledContract: {},
    contractAddress: testAddress(1),
    privateStateId,
  });
  return { call, getVerifierKeys };
};

/* ------------------------------------------------------------------ *
 * the lists themselves
 * ------------------------------------------------------------------ */

describe('the deferral list: nothing is deferred, stated where a diff will show it', () => {
  it('defers NOTHING — the whole contract deploys', () => {
    // Deliberately not derived: this is the product decision. Deferring a circuit again should have to change
    // this line in the same change.
    expect([...DEFERRED_CIRCUITS]).toEqual([]);
  });

  it('deploys retireVault, because a vault with no retirement has no ending', () => {
    /*
     * `retireVault` was once deferred on the reasoning that a vault cannot be retired on that deployment, but the
     * vault contract calls `account.retireVault(...)`, so a vault with no retirement has no ending. A deploy
     * run against a list that defers it again leaves vaults that can never be retired.
     */
    expect(DEPLOYED_CIRCUITS).toContain('retireVault');
    expect(isDeployedCircuit('retireVault')).toBe(true);
    expect(isDeferredCircuit('retireVault')).toBe(false);
  });

  it('treats a removed circuit as absent, not as deferred', () => {
    /*
     * `credit`, `attestSolvency` and `execute` were removed from the contract. None of the three is deferred:
     * deferred means compiled, tested and left out of one deployment, and anything that asks "is it deferred?"
     * to decide whether a call can be made would get the wrong answer for a name that does not exist at all.
     * Callers that decide whether a call can be made ask `isDeployedCircuit` for exactly this reason.
     *
     * `execute` is the one that matters here. It is present in the live deployment (see the fixture below) and
     * absent from the contract, which is the one combination where a predicate answering "not deferred" could be
     * read as "so it can be called".
     */
    for (const shed of ['credit', 'attestSolvency', 'execute']) {
      expect(isDeferredCircuit(shed)).toBe(false);
      expect(isDeployedCircuit(shed)).toBe(false);
    }
  });

  it('deploys the three circuits the vault system needs', () => {
    for (const needed of ['adopt', 'recordPaymentFromVault', 'setVaultThreshold']) {
      expect(DEPLOYED_CIRCUITS).toContain(needed);
      expect(isDeployedCircuit(needed)).toBe(true);
      expect(isDeferredCircuit(needed)).toBe(false);
    }
  });

  it('the two lists name twenty-two circuits between them, none twice', () => {
    // The count is what the source decides today: the set has grown and shrunk as circuits were merged, removed
    // and added, and this number moves with `deferral.ts` and the compiled contract together.
    // "No overlap" is not claimed: while DEFERRED_CIRCUITS is empty it cannot fail. What is checked is that the
    // concatenation has no duplicate, which can fail, and that assertKnownCircuitSet accepts the set it was
    // built from.
    const all = [...DEPLOYED_CIRCUITS, ...DEFERRED_CIRCUITS];
    expect(all).toHaveLength(22);
    expect(new Set(all).size).toBe(22);
    expect(() => assertKnownCircuitSet(all)).not.toThrow();
  });

  it.skipIf(!existsSync(KEY_DIR))('names exactly the circuits the compiled contract has keys for [needs contracts/managed/keys; `npm run compact` builds them]', () => {
    /*
     * Read off disk, not transcribed, and the difference is the whole point.
     *
     * A hand-written list of names asserted against a hand-written list of names is green whatever `contracts/`
     * holds, which is how a contract can shed circuits and leave `deferral.ts` naming them with every test still
     * passing. `contracts/managed/keys/` is the deployable set: `partial-contract.ts` asks the zk config provider
     * for a verifier key per deployed circuit, so a name here without a key on disk is a deploy that stops, and
     * a key on disk without a name here is a circuit the deployment silently drops. The comparison is against
     * the compiled artefact, so the next contract change fails this line rather than a deploy.
     *
     * If the keys on disk are from an older compile, both assertions go red together and for one reason: the
     * count below is what the source decides, not a reading of the directory. Compile the contract again
     * (`npm run compact`) and redeploy what a changed contract owes. Editing either number to make this green
     * against a stale artefact defeats the test.
     */
    const keyed = [...new Set(
      readdirSync(KEY_DIR)
        .filter((f) => f.endsWith('.verifier'))
        .map((f) => f.replace(/\.verifier$/, '')),
    )].sort();

    expect(keyed).toHaveLength(22);
    expect([...DEPLOYED_CIRCUITS]).toEqual(keyed);
    expect(() => assertKnownCircuitSet(keyed)).not.toThrow();
  });

  it('assertKnownCircuitSet refuses drift in either direction', () => {
    const all = [...DEPLOYED_CIRCUITS, ...DEFERRED_CIRCUITS];
    expect(() => assertKnownCircuitSet(all.slice(1))).toThrow(/does not export/);
    expect(() => assertKnownCircuitSet([...all, 'fourteenthCircuit'])).toThrow(/does not export/);
    expect(() => assertKnownCircuitSet([...all.slice(0, -1), 'renamedCircuit']))
      .toThrow(/does not export/);
  });

  /*
   * There is no test that a deployed circuit is not treated as deferred: it would ask a set built from
   * `DEPLOYED_CIRCUITS` whether it held each name, then ask an empty set the same, and neither half could go red
   * for any change to either list. A test that cannot fail reports that something is checked when nothing is.
   */
});

/* ------------------------------------------------------------------ *
 * direction one: the deferred set must be absent, and it is empty
 *
 * There are no tests here that iterate the deferred list: an empty `it.each` reports no failure and proves no
 * property. What they would cover, that a deployment carrying an operation this client did not decide on is
 * refused by name, is unenforced while the deferred list is empty.
 * ------------------------------------------------------------------ */

describe('findDeployedPartialContract: the deployment must be exactly the deployed set', () => {
  it('accepts the deployment that carries exactly the deployed set', async () => {
    const { call, getVerifierKeys } = await find(stateWith([...DEPLOYED_CIRCUITS]));
    await expect(call).resolves.toMatchObject({ callTx: { __callTx: true } });
    // The kept-set comparison is driven by the LIST, not by a copied array.
    expect(getVerifierKeys).toHaveBeenCalledWith([...DEPLOYED_CIRCUITS]);
  });

  it('refuses the live stagenet shape, because it is missing retireVault', async () => {
    /*
     * Not derived, and not derivable: this is a record of a chain. It is the operation set of the live account
     * (`90ebef16...`, block 217,275, `SucceedEntirely`, deployed 29 Aug 00:17 IST), which cannot retire a vault.
     * The client must refuse it rather than build calls against it; a redeploy fixes that, a reconnection does
     * not.
     *
     * It does not move when the source tree moves, and that is the point of writing it out. `execute` was taken
     * out of the contract source and not off the chain. Editing this array to match the new contract would
     * produce a fixture describing a deployment that has never existed, and would quietly delete the only
     * statement in `src/` of what the account is actually running.
     *
     * What does the refusing is the missing `retireVault` and nothing else. This deployment carries two
     * operations this client does not know, `credit` and `execute`, and neither is refused by name: the
     * deferred-absence check iterates an empty list, and `verifyContractState` reduces over the client's keys, so
     * it is structurally silent about extras. This test would pass identically with both names removed from the
     * fixture, and identically with a name nobody decided on added to it. Nothing enforces the extras direction
     * today.
     */
    const live = [
      'adopt', 'amendSigner', 'approve', 'cancel', 'closeExpiredRun', 'credit',
      'execute', 'propose', 'recordPayment', 'setThreshold', 'setVaultThreshold',
    ];
    const { call } = await find(stateWith(live));
    await expect(call).rejects.toThrow(/retireVault.*undefined or have mismatched/);
  });
});

/* ------------------------------------------------------------------ *
 * direction two: the kept set must match, byte-for-byte
 * ------------------------------------------------------------------ */

describe('findDeployedPartialContract: the kept circuits must match byte-for-byte', () => {
  it('refuses an older eleven-circuit deployment instead of silently accepting it', async () => {
    /*
     * The shape deployed on 28 Aug at 93ac...9d8, before the split was re-decided. It lacks five circuits this
     * client now requires (`adopt`, `amendSigner`, `recordPayment`, `retireVault`, `setVaultThreshold`) and
     * carries six the contract no longer has at all, `execute` and `credit` among them. A client that accepted it
     * would build proofs against an operations map nobody chose, which is the exact defect this check exists to
     * stop. The array does not move when the contract does, and must not: it is what that block is carrying.
     */
    const oldEleven = [
      'addSigner', 'approve', 'attestSolvency', 'cancel', 'closeExpiredRun',
      'credit', 'execute', 'propose', 'proposeRun', 'removeSigner', 'setThreshold',
    ];
    const { call } = await find(stateWith(oldEleven));
    await expect(call).rejects.toThrow(/undefined or have mismatched verifier keys/);
  });

  it.each([...FIRST_STEP_CIRCUITS])(
    'refuses a deployment missing the kept circuit "%s"',
    async (kept) => {
      const { call } = await find(stateWith(DEPLOYED_CIRCUITS.filter((n) => n !== kept)));
      await expect(call).rejects.toThrow(new RegExp(`${kept}.*undefined or have mismatched`));
    });

  it.each([...SECOND_STEP_CIRCUITS])(
    'refuses an account whose creation did not finish, missing "%s", and says so by name',
    async (inserted) => {
      const { call } = await find(stateWith(DEPLOYED_CIRCUITS.filter((n) => n !== inserted)));
      /* RED WHEN a half-created account is reported as a key mismatch, or accepted. */
      await expect(call).rejects.toThrow(new RegExp(`creation was not finished: it does not carry ${inserted}`));
    });

  it('refuses a deployment whose kept key differs by one byte', async () => {
    const [first] = DEPLOYED_CIRCUITS;
    const tampered = keyFor(first).slice();
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const { call } = await find(stateWith([...DEPLOYED_CIRCUITS], { [first]: tampered }));
    await expect(call).rejects.toThrow(/undefined or have mismatched verifier keys/);
  });

  it('refuses an address with no contract at all', async () => {
    const { call } = await find(null);
    await expect(call).rejects.toThrow(/no contract is deployed/);
  });
});
