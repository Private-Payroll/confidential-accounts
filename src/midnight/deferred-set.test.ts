/**
 * THE DEFERRED-SET CHECK MOVES WITH THE LIST. S9, emptied by S25.
 *
 * `S8c` built `findDeployedPartialContract` to check BOTH directions against
 * `src/midnight/deferral.ts`: the kept circuits' verifier keys must match
 * byte-for-byte, and the deferred circuits must be ABSENT. `S9` changed which
 * circuits defer, and this file was the proof that round owed.
 *
 * `S25` EMPTIED THE DEFERRED LIST — `S23` shed `credit` and `attestSolvency`
 * from the contract, and what remained fit under the ceiling whole — so the
 * ABSENT direction has nothing left to be absent. **The tests that
 * exercised it are DELETED rather than left iterating an empty list**, which
 * would report green while asserting nothing. What replaces them is a test
 * that the list IS empty and that nothing shed is treated as merely deferred.
 * The consequence — that a deployment carrying an operation nobody decided is
 * no longer refused by name — is a `BACKLOG.md` row, not a check invented
 * here.
 *
 * **`C292`/`S26` THEN TOOK `execute` OUT OF THE CONTRACT**, with the account's
 * balance ledger, so the contract's own set is TEN. That is a change to what is
 * COMPILED, and this file says so in two places on purpose: the count below,
 * and the comparison against `contracts/managed/keys/` — which is read off disk
 * and will disagree until `COMPILE-CONTRACT.command` regenerates it. **A red
 * line there is this file doing its job**, and is not a number to bring back
 * into agreement by hand; that is exactly the defect `V-251` was raised for.
 *
 * Every fixture except three is DERIVED from the lists in `deferral.ts`, so the
 * next round to change them inherits the proof rather than a stale copy. The
 * three exceptions are deliberate: the test that pins what `S25` decided (a
 * product decision — a silent change to it should fail a test), and the two
 * fixtures that are records of REAL DEPLOYMENTS — the live account and `S8b`'s
 * older one. **Both are written as history and neither tracks the source tree**,
 * because what a chain is carrying does not change when a `.compact` file
 * does.
 *
 * The fake `verifyContractState` MIRRORS the SDK's semantics rather than
 * stubbing them (`midnight-js-contracts/dist/index.mjs:2016-2052`): every
 * requested circuit must exist in the deployed state with a byte-identical
 * verifier key, and every failure is reported by name in one throw. T-34's
 * rule: a stub without the semantics could not fail the way the product would.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';

import {
  DEPLOYED_CIRCUITS,
  DEFERRED_CIRCUITS,
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
      publicDataProvider: { queryContractState: vi.fn(async () => state) },
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
  verifyContractState: (verifierKeys: Array<[string, Uint8Array]>, state: any) => {
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

const find = async (state: unknown) => {
  const { findDeployedPartialContract } = await import('./partial-contract.js');
  const { providers, getVerifierKeys } = providersFor(state);
  const call = findDeployedPartialContract(providers as any, {
    compiledContract: {},
    contractAddress: 'addr_under_test',
  });
  return { call, getVerifierKeys };
};

/* ------------------------------------------------------------------ *
 * the lists themselves
 * ------------------------------------------------------------------ */

describe('the deferral list: S25\'s decision, stated where a diff will show it', () => {
  it('defers NOTHING — the whole contract deploys', () => {
    // Deliberately NOT derived: this is the product decision. A round that
    // defers a circuit again should have to change this line in the same turn.
    expect([...DEFERRED_CIRCUITS]).toEqual([]);
  });

  it('deploys retireVault, which S9 deferred and C288 is the cost of', () => {
    /*
     * THE POINT OF S25. `S9` deferred `retireVault` on the reasoning that "a
     * vault cannot be retired on this deployment, which version one accepts".
     * Version one no longer accepts it — `C288` — and `Vault.compact:1018`
     * calls `account.retireVault(...)`, so a vault with no retirement has no
     * ending. A deploy run against a list that defers it again re-opens C288.
     */
    expect(DEPLOYED_CIRCUITS).toContain('retireVault');
    expect(isDeployedCircuit('retireVault')).toBe(true);
    expect(isDeferredCircuit('retireVault')).toBe(false);
  });

  it('treats a REMOVED circuit as absent, not as deferred', () => {
    /*
     * `credit` and `attestSolvency` were shed from the contract by S23, and
     * `execute` was removed by `C292`/`S26` with the account's balance ledger.
     * None of the three is deferred — deferred means compiled, tested and left
     * out of ONE deployment — and anything that asks "is it deferred?" to
     * decide whether a call can be made would get the wrong answer for a name
     * that does not exist at all. `scripts/sponsor-test.ts` asks
     * `isDeployedCircuit` for exactly this reason.
     *
     * **`execute` IS THE ONE THAT MATTERS HERE AND THE OTHER TWO ARE NOT.** It
     * is present in the LIVE deployment (see the fixture below) and absent from
     * the contract, which is the one combination where a predicate answering
     * "not deferred" could be read as "so it can be called".
     */
    for (const shed of ['credit', 'attestSolvency', 'execute']) {
      expect(isDeferredCircuit(shed)).toBe(false);
      expect(isDeployedCircuit(shed)).toBe(false);
    }
  });

  it('deploys the three circuits the vault system needs', () => {
    for (const needed of ['adopt', 'recordPayment', 'setVaultThreshold']) {
      expect(DEPLOYED_CIRCUITS).toContain(needed);
      expect(isDeployedCircuit(needed)).toBe(true);
      expect(isDeferredCircuit(needed)).toBe(false);
    }
  });

  it('the two lists name ten circuits between them, none twice', () => {
    // Fifteen before the S11 merges (addSigner+removeSigner → amendSigner,
    // propose+proposeRun → propose), thirteen after them, eleven once S23 shed
    // credit and attestSolvency, TEN since `C292`/`S26` removed `execute` with
    // the account's balance ledger.
    
    // "No overlap" is what this used to claim, and while DEFERRED_CIRCUITS is
    // empty that claim cannot fail, so it is not made. What IS checked is that
    // the concatenation has no duplicate — which can fail — and that
    // assertKnownCircuitSet accepts the set it was built from.
    const all = [...DEPLOYED_CIRCUITS, ...DEFERRED_CIRCUITS];
    expect(all).toHaveLength(10);
    expect(new Set(all).size).toBe(10);
    expect(() => assertKnownCircuitSet(all)).not.toThrow();
  });

  it.skipIf(!existsSync(KEY_DIR))('names exactly the circuits the COMPILED CONTRACT has keys for [needs contracts/managed/keys; `npm run compact` builds them]', () => {
    /*
     * READ OFF DISK, NOT TRANSCRIBED, and the difference is the whole point.
     *
     * A hand-written list of eleven names asserted against a hand-written list
     * of eleven names is green whatever `contracts/` holds — which is exactly
     * how `S23` shed two circuits and left `deferral.ts` naming thirteen with
     * every test still passing (`V-251`). `contracts/managed/keys/` is the
     * deployable set: `partial-contract.ts` asks the zk config provider for a
     * verifier key per deployed circuit, so a name here without a key on disk
     * is a deploy that stops, and a key on disk without a name here is a
     * circuit the deployment silently drops.
     *
     * This is the test `V-251` asked for: the comparison is against the
     * artefact, so the NEXT contract change fails this line rather than a
     * deploy.
     *
     * **AND THAT IS WHAT IT IS DOING NOW, SO READ THE FAILURE BEFORE CHANGING
     * IT.** `C292`/`S26` removed `execute` from `ConfidentialAccount.compact`
     * and from `deferral.ts` — TEN — while `contracts/managed/keys/` still
     * holds the eleven keys of the last compile, `execute.verifier` among them.
     * The number below is the count the source decides, not a reading of the
     * directory, so both assertions go red together and for one reason.
     * **THE DOOR IS `npm run compact`**, followed by the redeploy that
     * a changed contract already owes. Editing either number to make this green
     * against a stale artefact is the whole of `V-251`.
     */
    const keyed = [...new Set(
      readdirSync(KEY_DIR)
        .filter((f) => f.endsWith('.verifier'))
        .map((f) => f.replace(/\.verifier$/, '')),
    )].sort();

    expect(keyed).toHaveLength(10);
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
   * `it('no deployed circuit is treated as deferred')` WAS HERE AND IS GONE.
   *
   * It iterated `DEPLOYED_CIRCUITS` and asked a Set built from
   * `DEPLOYED_CIRCUITS` whether it held each name, then asked an EMPTY Set
   * whether it held them. Neither half could go red for any change to either
   * list. A test that cannot fail is not weaker coverage than one that can —
   * it is a report that something is checked when nothing is, which is `C286`'s
   * rule applied to a test file.
   */
});

/* ------------------------------------------------------------------ *
 * direction one: the deferred set must be ABSENT — and it is empty
 *
 * The two tests that lived here, both driven by `it.each([...DEFERRED_CIRCUITS])`
 * over a pair of real deferred names, are DELETED by S25 rather than left to
 * iterate nothing: an empty `it.each` reports no failure and proves no
 * property, which is the precise shape of a test that has quietly stopped
 * testing. What they covered — a deployment carrying an operation this client
 * did not decide on is refused BY NAME — is unenforced while the deferred list
 * is empty, and that is a BACKLOG row rather than a check invented here.
 * ------------------------------------------------------------------ */

describe('findDeployedPartialContract: the deployment must be exactly the deployed set', () => {
  it('accepts the deployment that carries exactly the deployed set', async () => {
    const { call, getVerifierKeys } = await find(stateWith([...DEPLOYED_CIRCUITS]));
    await expect(call).resolves.toMatchObject({ callTx: { __callTx: true } });
    // The kept-set comparison is driven by the LIST, not by a copied array.
    expect(getVerifierKeys).toHaveBeenCalledWith([...DEPLOYED_CIRCUITS]);
  });

  it('refuses the LIVE stagenet shape, because it is missing retireVault', async () => {
    /*
     * **NOT DERIVED, AND NOT DERIVABLE. THIS IS A RECORD OF A CHAIN.** Copied
     * from `.midnight/stagenet-contract.json`, written by the deploy itself:
     * `90ebef16…`, block 217,275, `SucceedEntirely`, stamped
     * `2026-08-28T18:47:08Z` — 29 Aug 00:17 IST. `C288` is the row for the fact
     * that it cannot retire a vault. The client must REFUSE it rather than
     * build calls against it; the redeploy is what closes C288, not a
     * reconnection.
     *
     * **IT DOES NOT MOVE WHEN THE SOURCE TREE MOVES, AND THAT IS THE POINT OF
     * WRITING IT OUT.** `C292`/`S26` took `execute` out of
     * `ConfidentialAccount.compact`. It did not take it off the chain. Editing
     * this array to match the new contract would produce a fixture describing a
     * deployment that has never existed, and would quietly delete the only
     * statement in `src/` of what the account is actually running.
     *
     * WHAT DOES THE REFUSING IS THE MISSING `retireVault`, AND NOTHING ELSE.
     * **This deployment now carries TWO operations this client does not know —
     * `credit`, shed by `S23`, and `execute`, removed by `C292`/`S26` — and
     * NEITHER is refused by name.** The deferred-absence check that would have
     * named them iterates an empty list since `S25`
     * (`partial-contract.ts:417`), and `verifyContractState` reduces over the
     * CLIENT's keys, so it is structurally silent about extras. **So this test
     * would pass identically with both names removed from the fixture, and it
     * would pass identically with a name nobody ever decided on added to it.**
     * That is stated rather than fixed: `V-259` is the row, the check it asks
     * for is a NEW one, and a test file is not where a missing check gets
     * invented. Under `C286` and rule 27 — nothing enforces the extras
     * direction today.
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
  it('refuses S8b\'s OLD eleven-circuit deployment instead of silently accepting it', async () => {
    /*
     * History, written as history: the shape deployed on 28 Aug at
     * 93ac…9d8, before S9 re-decided the split. **It lacks FIVE circuits this
     * client now requires** — `adopt`, `amendSigner`, `recordPayment`,
     * `retireVault`, `setVaultThreshold` — **and carries six the contract no
     * longer has at all**, `execute` and `credit` among them. A client that
     * accepted it would build proofs against an operations map nobody chose —
     * C231's money shape, the exact defect this check exists to stop.
     *
     * The counts moved because the CONTRACT moved (`S11`'s merges, `S23`'s
     * shed, `C292`/`S26`'s removal of `execute`). **The array did not**, and
     * must not: it is what block 215,346 is carrying.
     */
    const oldEleven = [
      'addSigner', 'approve', 'attestSolvency', 'cancel', 'closeExpiredRun',
      'credit', 'execute', 'propose', 'proposeRun', 'removeSigner', 'setThreshold',
    ];
    const { call } = await find(stateWith(oldEleven));
    await expect(call).rejects.toThrow(/undefined or have mismatched verifier keys/);
  });

  it.each([...DEPLOYED_CIRCUITS])(
    'refuses a deployment missing the kept circuit "%s"',
    async (kept) => {
      const { call } = await find(stateWith(DEPLOYED_CIRCUITS.filter((n) => n !== kept)));
      await expect(call).rejects.toThrow(new RegExp(`${kept}.*undefined or have mismatched`));
    });

  it('refuses a deployment whose kept key differs by one byte', async () => {
    const [first] = DEPLOYED_CIRCUITS;
    const tampered = keyFor(first).slice();
    tampered[0] ^= 0xff;
    const { call } = await find(stateWith([...DEPLOYED_CIRCUITS], { [first]: tampered }));
    await expect(call).rejects.toThrow(/undefined or have mismatched verifier keys/);
  });

  it('refuses an address with no contract at all', async () => {
    const { call } = await find(null);
    await expect(call).rejects.toThrow(/no contract is deployed/);
  });
});
