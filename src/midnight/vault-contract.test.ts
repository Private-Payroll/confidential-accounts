/**
 * THE VAULT'S DEPLOY AND ITS OWN FIND, and `C228` is what most of this
 * file is about.
 *
 * `C228`'s row says private state is filed under
 * `${contractAddress}:${privateStateId}`, that the address half is a mutable
 * closure variable, and that **it worked only because exactly one contract had
 * ever been addressed.** This module addresses a second, and a third: a company
 * has many vaults, and a vault reading another vault's pool is a wrong balance
 * in a real payment.
 *
 * Two properties are proved here and they are not the same property:
 *
 *   1. **THE VAULT PATH NEVER READS OR WRITES THE SDK'S PRIVATE STATE AT ALL.**
 *      No `privateStateId` is passed, so `submitDeployTx` writes none
 *      (`index.mjs:1181-1183`) and `createCallTxOptions` carries none
 *      (`:1862`). There is no vault view for a second vault to read.
 *   2. **AND THE ADDRESS IS SET FROM THE VAULT THE CALL IS FOR, BEFORE EVERY
 *      ACCESS ANYWAY**, so no vault operation inherits an account's address and
 *      no account operation inherits a vault's — the exact `C228` arrangement,
 *      driven from both directions.
 *
 * **THE FAKE PROVIDER MIRRORS THE REAL ONE'S ADDRESSING SEMANTICS** — the
 * closure variable, the composed key, the throw when no address was ever set
 * (`midnight-js-level-private-state-provider/dist/index.mjs:767-778`) — and the
 * fake SDK mirrors `deployContract`'s: the `signingKey ?? sampleSigningKey()`
 * fallthrough, the post-submit writes, and the conditional private-state write.
 * `T-34`: a stub without the semantics could not fail the way the product
 * would, and this is now the third standing instance of that obligation.
 *
 * **THE MOCK IS REGISTERED ONCE, AT MODULE SCOPE, AND IS STATELESS.** `C222`
 * cost five suite runs and a wrong diagnosis: a `vi.doMock` factory closing
 * over per-test state is a module-scoped binding wearing a closure. Everything
 * per-test rides on `providers.__harness`, which is the handle the code under
 * test already carries, and the fakes REFUSE providers that have none rather
 * than defaulting to some harness.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { StateValue, ChargedState } from '@midnight-ntwrk/compact-runtime';

/* ------------------------------------------------------------------ *
 * a deployed vault's LEDGER, for a fake that has to be readable
 * ------------------------------------------------------------------ */

/**
 * **THE SLOTS THIS BUILD'S OWN CONTRACT MAKES**, loaded once, from the contract
 * itself rather than from a list somebody typed. The find now compares a
 * deployed vault's ledger shape against this build's, so a fake whose state has
 * no ledger is a fake no vault resembles.
 *
 * Nothing here proves, submits or reaches a network: a constructor runs no
 * circuit, and the witnesses it is handed throw if anything calls one.
 */
let CANONICAL: unknown[] = [];
const ALL_SLOTS: readonly number[] = [0, 1, 2, 3, 4];

beforeAll(async () => {
  const { Contract } = await import('../../contracts/managed-vault/contract/index.js');
  const nothingCallsThese = new Proxy({}, {
    get: () => () => { throw new Error('the vault find\x27s harness runs no circuit'); },
  });
  const built = await new (Contract as new (w: unknown) => {
    initialState(c: unknown, a: { bytes: Uint8Array }): Promise<{
      currentContractState: { data: { state: { asArray(): unknown[] } } };
    }>;
  })(nothingCallsThese).initialState(
    { initialPrivateState: {}, initialZswapLocalState: { coinPublicKey: new Uint8Array(32) } },
    { bytes: new Uint8Array(32) });
  CANONICAL = built.currentContractState.data.state.asArray();
});

/** A contract state carrying exactly the named slots of this build's ledger. */
const stateOfSlots = (take: readonly number[]) => {
  if (CANONICAL.length === 0) {
    throw new Error(
      'this harness was asked for a vault state before the contract had stated its own ledger. '
      + 'Defaulting to a state with no ledger is the shape that made every fake unreadable.');
  }
  let array = StateValue.newArray();
  for (const at of take) array = array.arrayPush(CANONICAL[at] as never);
  return new ChargedState(array);
};

/** The signing keys the fakes sample, so a test can tell "sampled" from "chosen". */
const SAMPLED: Array<{ tag: string; value: string }> = [];

const harnessOf = (providers: any) => {
  const h = providers?.__harness;
  if (!h) {
    throw new Error(
      'these fakes were handed providers carrying no harness. Defaulting to one is the ' +
      'defect C222 is about, so this refuses instead.');
  }
  return h;
};

vi.doMock('@midnight-ntwrk/midnight-js-contracts', () => ({
  /**
   * `deployContract`, with the semantics that matter here rather than a stub.
   *
   * Mirrored from `midnight-js-contracts/dist/index.mjs`: the signing-key
   * fallthrough at `:1907` (which is C225 itself), the address set post-submit
   * at `:1180`, the private-state write **only when `privateStateId` is in the
   * options** at `:1181-1183`, and the signing-key write at `:1184`.
   */
  deployContract: async (providers: any, options: any) => {
    const h = harnessOf(providers);
    h.deployCalls.push(options);
    let signingKey = options.signingKey;
    if (!signingKey) {
      // `options.signingKey ?? sampleSigningKey()` — index.mjs:1907. If this
      // branch is ever taken the vault has an unrecorded authority: C225.
      signingKey = { tag: 'schnorr', value: `sampled-${SAMPLED.length}` };
      SAMPLED.push(signingKey);
    }
    const contractAddress = h.nextAddress;
    providers.privateStateProvider.setContractAddress(contractAddress);
    if ('privateStateId' in options) {
      await providers.privateStateProvider.set(options.privateStateId, options.initialPrivateState);
    }
    await providers.privateStateProvider.setSigningKey(contractAddress, signingKey);
    return {
      deployTxData: {
        public: {
          contractAddress,
          initialContractState: { operations: () => [...h.deployedOps] },
          txId: 'tx_vault_deploy',
        },
        private: { signingKey },
      },
      callTx: {},
    };
  },

  /**
   * `verifyContractState`, mirrored: every requested key must be present on the
   * state and byte-identical, and every failure is reported by name in one
   * throw (`index.mjs:2016-2023`). A stub answering "fine" could not fail the
   * way the product would.
   */
  verifyContractState: (verifierKeys: Array<[string, Uint8Array]>, state: any) => {
    const bad = verifierKeys
      .filter(([id, local]) => {
        const op = state.operation(id);
        if (!op) return true;
        return String(op.verifierKey) !== String(local);
      })
      .map(([id]) => id);
    if (bad.length > 0) {
      throw new Error(
        `Following operations: ${bad.join(', ')}, are undefined or have mismatched verifier keys`);
    }
  },

  createCircuitCallTxInterface: (
    providers: any, _compiled: unknown, contractAddress: string, privateStateId: unknown,
  ) => {
    const h = harnessOf(providers);
    h.interfaces.push({ contractAddress, privateStateId });
    providers.privateStateProvider.setContractAddress(contractAddress);
    return { payout: async () => ({ public: { txId: 'tx_pay' } }) };
  },

  /*
   * The two entry points the HAND-BUILT path uses, mirrored rather than
   * stubbed: a stub without the real semantics could not fail the way the
   * product would.
   *
   * **THE PROPERTY THESE TWO CARRY IS AN ABSENCE, AND IT IS MEASURED FROM THE
   * REAL FILE RATHER THAN ASSUMED.** Neither `createUnprovenDeployTx`
   * (`index.mjs:1113-1115`, delegating to `createUnprovenDeployTxFromVerifierKeys`
   * at `:1058-1112`) nor `submitTx` (`:70-85`, over `submitTxCore` at `:27-69`)
   * touches the signing-key slot. `submitDeployTx` at `:1184` does, and
   * `setOrGetInitialSigningKey` at `:1953`/`:1961` does, and neither is on this
   * path. **A fake that wrote a key here would make this block's central
   * assertion fail for the wrong reason; a fake that could not write one would
   * make it pass for the wrong reason.** So these mirror the real absence, and a
   * separate test in this file re-derives that absence from the real
   * `index.mjs`, so a version bump that moves the call is caught rather than
   * inherited.
   */
  createUnprovenDeployTx: async (providers: any, options: any) => {
    const h = harnessOf(providers);
    h.unprovenCalls.push(options);
    if (h.constructorThrows) throw new Error(h.constructorThrows);
    /*
     * BOTH SENTINELS BELOW WERE MISSING FROM THE FIRST DRAFT, AND BOTH OF THIS
     * REVIEW FOUND NEUTERINGS THAT WERE GREEN ONLY BECAUSE OF IT.
     * A fake without the real one's semantics cannot fail the way the product
     * would.
     *
     *   `public.contractAddress` is the CONSTRUCTOR's address, derived from the
     *   interim authority the runtime built, and it is NOT the address of the
     *   state this path actually deploys. Returning it means a path that reached
     *   for it would be caught rather than silently right.
     *
     *   `private.signingKey` is the key the runtime samples when none is passed
     *   (`ContractExecutable.js:277-280`), which is exactly what happens in
     *   COMMITTEE mode. It is real key material for the length of the deploy
     *   call, and the sentinel makes any path that stores, returns or reports it
     *   visible. A report is a plaintext home for anything put in it.
     */
    return {
      public: {
        contractAddress: h.constructorAddress,
        initialContractState: h.constructedState(),
      },
      private: {
        signingKey: { tag: 'schnorr', value: h.sampledSentinel },
        unprovenTx: h.unprovenTx ?? {},
        newCoins: h.newCoins ?? [],
        initialPrivateState: h.initialPrivateState,
      },
    };
  },

  submitTx: async (providers: any, options: any) => {
    const h = harnessOf(providers);
    h.submitted.push(options.unprovenTx);
    return h.submitStatus ?? { status: 'SucceedEntirely', txId: 'tx_vault_handbuilt' };
  },

  DeployTxFailedError: class DeployTxFailedError extends Error {
    constructor(public finalizedTxData: unknown) {
      super('deploy tx failed');
    }
  },

  /*
   * MIRRORED SO A CALL TO IT IS OBSERVABLE, NOT SO IT CAN BE USED. The
   * hand-built path must reach neither this nor `deployContract`, because those
   * are two of the three SDK functions that write the signing-key slot
   * (`setOrGetInitialSigningKey`, reached here at `:2053`). A test that asserts
   * the store is empty proves the key did not land; this proves the door was not
   * opened.
   */
  findDeployedContract: async (providers: any, options: any) => {
    const h = harnessOf(providers);
    h.findDeployedContractCalls.push(options);
    throw new Error(
      'findDeployedContract was called. It samples and stores a signing key under the ' +
      'address when the store holds none (index.mjs:1951-1963) and no vault path may reach ' +
      'it.');
  },
}));

const {
  VAULT_CIRCUITS, assertVaultCircuitSet, addressVaultPrivateState,
  requireVaultMaintenanceAuthority, deployVaultContract, findDeployedVaultContract,
  requireHandBuiltVaultAuthority, vaultDeployCustody, buildVaultDeployState,
  submitHandBuiltVaultDeployTx,
} = await import('./vault-contract.js');
const { DEPLOYED_CIRCUITS } = await import('./deferral.js');

/* ------------------------------------------------------------------ *
 * the world: one account, two vaults
 * ------------------------------------------------------------------ */

const ACCOUNT = 'ac'.repeat(32);
const VAULT_A = 'a7'.repeat(32);
const VAULT_B = 'b8'.repeat(32);

/** The account's private-state id, exactly as `ledger.ts` composes it. */
const ACCOUNT_STATE_ID = 'confidential-accounts-stagenet:default';

/**
 * The account's deployed operations map, taken from the account's OWN list.
 *
 * `T-34`: a fake's circuit names are checked where the fake is CONSTRUCTED, or
 * a stale mirror becomes a refusal by arithmetic instead of by name. Hard-coded
 * here, this fixture would keep describing the eleven-circuit account of 29 Aug
 * long after the account's split moved, and the test asserting "this is an account"
 * would be asserting it of a contract this project no longer deploys.
 */
const ACCOUNT_OPS = [...DEPLOYED_CIRCUITS];

const KEY_OF = (circuit: string): Uint8Array =>
  new TextEncoder().encode(`vk:${circuit}`);

const CHOSEN = {
  kind: 'single-key' as const,
  signingKey: { tag: 'schnorr', value: 'the-key-somebody-chose' },
  temporary: { fixedBy: 'the first deployment on a network that matters' },
};

/**
 * The real provider's addressing semantics, mirrored. `T-34`.
 *
 * `trace` records the ORDER of address-sets, reads and writes, because the
 * property under test is not only where state landed but that the address was
 * set before anything touched the store.
 */
const levelLikeProvider = () => {
  const store = new Map<string, any>();
  const signingKeys = new Map<string, any>();
  const trace: string[] = [];
  let contractAddress: string | null = null;
  const keyFor = (id: string): string => {
    if (contractAddress === null) {
      throw new Error('Contract address not set. Call setContractAddress() before accessing private state.');
    }
    return `${contractAddress}:${id}`;
  };
  return {
    store, signingKeys, trace,
    setContractAddress(address: string): void {
      contractAddress = address;
      trace.push(`address ${address}`);
    },
    async get(id: string): Promise<any> {
      const k = keyFor(id);
      trace.push(`get ${k}`);
      return store.get(k) ?? null;
    },
    async set(id: string, value: any): Promise<void> {
      const k = keyFor(id);
      trace.push(`set ${k}`);
      store.set(k, value);
    },
    /* Keyed by the address it is GIVEN, never by the closure — index.mjs:823. */
    async getSigningKey(address: string): Promise<any> {
      trace.push(`getSigningKey ${address}`);
      return signingKeys.get(address) ?? null;
    },
    async setSigningKey(address: string, key: any): Promise<void> {
      trace.push(`setSigningKey ${address}`);
      signingKeys.set(address, key);
    },
  };
};

const world = (opts: {
  /** What the chain holds, per address. */
  chain?: Record<string, string[] | null>;
  /** Which verifier keys the zk config has. Defaults to all four vault circuits. */
  keys?: string[];
  /** A key the chain holds that differs from ours, to drive M-9's comparison. */
  corrupt?: string;
  /**
   * Which of this build's ledger slots the deployed vault actually carries.
   *
   * **DEFAULTS TO ALL OF THEM, WHICH IS WHAT A VAULT DEPLOYED FROM THIS BUILD
   * HAS.** again: a state with no ledger on it could not fail the way a
   * vault deployed from an older contract fails, so the fake carries a real
   * one, assembled out of the slots this build's own contract constructor
   * makes. Give a shorter list for a vault deployed before a field existed.
   */
  ledgerSlots?: readonly number[];
  nextAddress?: string;
  deployedOps?: string[];
} = {}) => {
  const provider = levelLikeProvider();
  const chain = opts.chain ?? { [VAULT_A]: [...VAULT_CIRCUITS], [VAULT_B]: [...VAULT_CIRCUITS] };
  const have = opts.keys ?? [...VAULT_CIRCUITS];

  const providers: any = {
    __harness: {
      deployCalls: [] as any[],
      interfaces: [] as any[],
      nextAddress: opts.nextAddress ?? VAULT_B,
      deployedOps: opts.deployedOps ?? [...VAULT_CIRCUITS],
      /* The hand-built path's half of the harness. Everything per-test
       * rides here rather than in a mock closure: a factory closing over
       * per-test state is a module-scoped binding wearing a closure. */
      unprovenCalls: [] as any[],
      submitted: [] as any[],
      findDeployedContractCalls: [] as any[],
      newCoins: [] as any[],
      unprovenTx: {} as any,
      initialPrivateState: undefined as any,
      submitStatus: undefined as any,
      constructorThrows: undefined as any,
      /* The CONSTRUCTOR's address, which is not the hand-built deploy's. */
      constructorAddress: VAULT_A,
      /* The key the runtime samples when none is passed. A sentinel, never a
       * key: nothing in this repository may carry key material. */
      sampledSentinel: 'sentinel-sampled-by-the-runtime-never-ours',
      /* Replaced per-test by handBuiltWorld(); the SDK-path tests never call it. */
      constructedState: () => {
        throw new Error(
          'this harness was not given a constructed vault state. handBuiltWorld() supplies ' +
          'one; defaulting to a plausible object is the defect this refuses.');
      },
    },
    privateStateProvider: provider,
    zkConfigProvider: {
      getVerifierKeys: async (ids: string[]) => ids.map((id) => {
        if (!have.includes(id)) {
          throw new Error(`Failed to find a verifier key for circuit '${id}'`);
        }
        return [id, KEY_OF(id)] as [string, Uint8Array];
      }),
    },
    publicDataProvider: {
      queryContractState: async (address: string) => {
        /*
         * TRACED, AND IN THE SAME TRACE AS THE ADDRESS-SETS. The property under
         * test is that the vault's address is set BEFORE the chain is read —
         * and without the read in the trace, an ordering assertion passes on
         * whatever the SDK's own call interface sets afterwards, which is a
         * test of the SDK rather than of this module. Watched failing.
         */
        provider.trace.push(`query ${address}`);
        const ops = chain[address];
        if (!ops) return null;
        return {
          operations: () => [...ops],
          operation: (id: string) => ops.includes(id)
            ? { verifierKey: id === opts.corrupt ? new TextEncoder().encode('different') : KEY_OF(id) }
            : undefined,
          /*
           * A REAL LEDGER, NOT A PLACEHOLDER. It is built out of the slots this
           * build's own contract constructor produces, so a vault this harness
           * serves is readable exactly as far as a real one of that shape is.
           */
          data: stateOfSlots(opts.ledgerSlots ?? ALL_SLOTS),
        };
      },
    },
  };
  return { providers, provider };
};

/** The physical key the level store would use for one contract's state. */
const physical = (address: string, id: string) => `${address}:${id}`;

/* ------------------------------------------------------------------ *
 * C225 — the vault refuses to sample, and says what it cannot express
 * ------------------------------------------------------------------ */

describe('C225: the vault chooses its maintenance authority, deliberately, or not at all', () => {
  it('refuses an absent choice before anything is deployed', async () => {
    const { providers } = world();
    await expect(deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: undefined,
    })).rejects.toThrow(/no maintenance authority was given/);
    // Nothing reached the SDK, so nothing could have been sampled.
    expect(providers.__harness.deployCalls).toEqual([]);
    expect(SAMPLED).toEqual([]);
  });

  it('PASSES the chosen key, so the SDK never reaches its sampling default', async () => {
    const { providers } = world();
    await deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: CHOSEN,
    });
    expect(providers.__harness.deployCalls[0].signingKey).toEqual(CHOSEN.signingKey);
    // The fake takes the `?? sampleSigningKey()` branch when no key is passed,
    // exactly as index.mjs:1907 does. It was never taken.
    expect(SAMPLED).toEqual([]);
  });

  it('refuses a committee and an empty committee BY NAME rather than recording one the chain would not have', () => {
    for (const choice of [
      { kind: 'committee' as const, committee: [{ tag: 'schnorr', value: 'k' }], threshold: 1 },
      { kind: 'unmaintainable' as const },
    ]) {
      const failure = (() => {
        try { requireVaultMaintenanceAuthority(choice); return null; } catch (e) { return e as Error; }
      })();
      expect(failure).not.toBeNull();
      expect(failure!.message).toMatch(/cannot be deployed with a "/);
      // It names the source of the limit rather than asserting one.
      expect(failure!.message).toMatch(/ContractExecutable\.js:276-290/);
      expect(failure!.message).toMatch(/replaceAuthority/);
      // And it names the way out by the name of the function that IS it, so
      // the limit is a signpost and not a wall. Re-checked when the message
      // stopped citing a document the reader cannot open.
      expect(failure!.message).toMatch(/submitHandBuiltVaultDeployTx/);
    }
  });

  it('still requires a single key to be RECORDED as temporary', () => {
    expect(() => requireVaultMaintenanceAuthority(
      { kind: 'single-key', signingKey: { tag: 'schnorr', value: 'k' } } as never,
    )).toThrow(/temporary\.fixedBy must name the round/);
  });

  it('reports the authority as a shape and never as key material', async () => {
    const { providers } = world();
    const out = await deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: CHOSEN,
    });
    expect(out.authority).toEqual({
      kind: 'single-key', committeeSize: 1, threshold: 1,
      fixedBy: CHOSEN.temporary.fixedBy,
    });
    expect(JSON.stringify(out.authority)).not.toContain(CHOSEN.signingKey.value);
  });
});

/* ------------------------------------------------------------------ *
 * the deploy's own refusals, before a fee is spent
 * ------------------------------------------------------------------ */

describe('the vault deploy refuses what it can refuse before anything is spent', () => {
  it('refuses an account address that is not 32 bytes of hex, and says the pin is permanent', async () => {
    const { providers } = world();
    for (const bad of ['', 'not-hex', 'ab'.repeat(31), `0x${'ac'.repeat(32)}`]) {
      await expect(deployVaultContract(providers, {
        compiledContract: {}, accountAddress: bad, maintenanceAuthority: CHOSEN,
      })).rejects.toThrow(/married to ONE account/);
    }
    expect(providers.__harness.deployCalls).toEqual([]);
  });

  it('refuses when the vault has no verifier keys on disk, and names the file that builds them', async () => {
    const { providers } = world({ keys: ['deposit', 'payout'] });
    await expect(deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: CHOSEN,
    })).rejects.toThrow(/COMPILE-VAULT\.command/);
    expect(providers.__harness.deployCalls).toEqual([]);
  });

  it('hands the constructor the account as a contract reference, and nothing else', async () => {
    const { providers } = world();
    await deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: CHOSEN,
    });
    const args = providers.__harness.deployCalls[0].args;
    expect(args).toHaveLength(1);
    expect(Buffer.from(args[0].bytes).toString('hex')).toBe(ACCOUNT);
  });

  it('reports the operations map it actually deployed rather than asserting it', async () => {
    // Read back off the deploy's own state. A wrong shape here is REPORTED and
    // never thrown: after the submission the address exists, and losing it is
    // worse than any shape it could have.
    const { providers } = world({ deployedOps: ['deposit', 'payout'] });
    const out = await deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: CHOSEN,
    });
    expect(out.contractAddress).toBe(VAULT_B);
    expect(out.circuits).toEqual(['deposit', 'payout']);
  });
});

/* ------------------------------------------------------------------ *
 * C228 — a vault reads neither the account's view nor another vault's
 * ------------------------------------------------------------------ */

describe('C228: vault private state is addressed per vault, before every access', () => {
  it('the deploy writes NO private state at all, so there is none to read wrongly', async () => {
    const { providers, provider } = world();
    // The C228 arrangement: an SDK entry point for the ACCOUNT ran last and
    // left the provider pointing there, with the account's own view seated.
    provider.setContractAddress(ACCOUNT);
    await provider.set(ACCOUNT_STATE_ID, { marker: 'the account' });

    await deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: CHOSEN,
    });

    // No `privateStateId` was passed, so nothing was written under any prefix.
    expect(providers.__harness.deployCalls[0]).not.toHaveProperty('privateStateId');
    expect([...provider.store.keys()]).toEqual([physical(ACCOUNT, ACCOUNT_STATE_ID)]);
    // The account's own record is exactly as it was.
    expect(provider.store.get(physical(ACCOUNT, ACCOUNT_STATE_ID))).toEqual({ marker: 'the account' });
  });

  it('the deploy leaves the store pointing at the vault it deployed, not at whatever ran last', async () => {
    const { providers, provider } = world();
    provider.setContractAddress(ACCOUNT);
    await deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: CHOSEN,
    });
    // The last address set is the vault's, and it was set explicitly by this
    // module as well as by the SDK — the rule does not depend on the SDK
    // having done it.
    expect(provider.trace[provider.trace.length - 1]).toBe(`address ${VAULT_B}`);
    expect(provider.trace.filter((l) => l === `address ${VAULT_B}`).length).toBeGreaterThanOrEqual(2);
  });

  it('the signing key is filed under the VAULT\'s address, never the account\'s', async () => {
    const { providers, provider } = world();
    provider.setContractAddress(ACCOUNT);
    await deployVaultContract(providers, {
      compiledContract: {}, accountAddress: ACCOUNT, maintenanceAuthority: CHOSEN,
    });
    expect(provider.signingKeys.get(VAULT_B)).toEqual(CHOSEN.signingKey);
    expect(provider.signingKeys.get(ACCOUNT)).toBeUndefined();
  });

  it('the find sets the vault\'s own address BEFORE the first read, even when the provider points elsewhere', async () => {
    const { providers, provider } = world();
    // Pointing at vault A. Without the addressing rule, a find for B would read and
    // written under A's prefix — the exact C228 arrangement, one vault along.
    provider.setContractAddress(VAULT_A);
    provider.trace.length = 0;

    await findDeployedVaultContract(providers, { compiledContract: {}, contractAddress: VAULT_B });

    // THE ORDER IS THE PROPERTY: B is addressed, and only then is anything
    // read. A find that read first would read whatever address was left
    // behind, which is C228 exactly.
    expect(provider.trace).toEqual([
      `address ${VAULT_B}`,
      `query ${VAULT_B}`,
      `address ${VAULT_B}`,   // createCircuitCallTxInterface sets it too — index.mjs:1876
    ]);
    // And A was never addressed again during the find.
    expect(provider.trace.filter((l) => l === `address ${VAULT_A}`)).toEqual([]);
  });

  it('a vault find reads and writes NOTHING in the private state store', async () => {
    const { providers, provider } = world();
    provider.setContractAddress(ACCOUNT);
    await provider.set(ACCOUNT_STATE_ID, { marker: 'the account' });
    provider.trace.length = 0;

    await findDeployedVaultContract(providers, { compiledContract: {}, contractAddress: VAULT_B });

    expect(provider.trace.filter((l) => l.startsWith('get '))).toEqual([]);
    expect(provider.trace.filter((l) => l.startsWith('set '))).toEqual([]);
    /*
     * AND IT SAMPLES NO SIGNING KEY. The SDK's own `findDeployedContract` would
     * have: `setOrGetInitialSigningKey` invents one and stores it under the
     * address when the store holds none (`index.mjs:1951-1963`) — a key that
     * maintains nothing, recorded where a later replaceAuthority reads the
     * real one. M-155.
     */
    expect(provider.trace.filter((l) => l.startsWith('setSigningKey'))).toEqual([]);
    expect(provider.signingKeys.size).toBe(0);
    // The account's record is untouched.
    expect(provider.store.get(physical(ACCOUNT, ACCOUNT_STATE_ID))).toEqual({ marker: 'the account' });
  });

  it('the call interface it hands back carries NO privateStateId, so no call reads private state', async () => {
    const { providers } = world();
    await findDeployedVaultContract(providers, { compiledContract: {}, contractAddress: VAULT_A });
    expect(providers.__harness.interfaces).toEqual([
      { contractAddress: VAULT_A, privateStateId: undefined },
    ]);
  });

  it('two vaults in one process keep their own addressing, in either order', async () => {
    const { providers, provider } = world();
    await findDeployedVaultContract(providers, { compiledContract: {}, contractAddress: VAULT_A });
    await findDeployedVaultContract(providers, { compiledContract: {}, contractAddress: VAULT_B });
    await findDeployedVaultContract(providers, { compiledContract: {}, contractAddress: VAULT_A });

    // Every find addressed its own vault first; none inherited the previous one.
    expect(provider.trace).toEqual([
      `address ${VAULT_A}`, `query ${VAULT_A}`, `address ${VAULT_A}`,
      `address ${VAULT_B}`, `query ${VAULT_B}`, `address ${VAULT_B}`,
      `address ${VAULT_A}`, `query ${VAULT_A}`, `address ${VAULT_A}`,
    ]);
    expect(providers.__harness.interfaces.map((i: any) => i.contractAddress))
      .toEqual([VAULT_A, VAULT_B, VAULT_A]);
  });

  it('refuses an empty address rather than filing under a shared prefix', () => {
    const { providers, provider } = world();
    for (const bad of ['', '   ', undefined as never, null as never]) {
      expect(() => addressVaultPrivateState(providers, bad)).toThrow(/empty address/);
    }
    expect(provider.trace).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * the find: the vault's own, and it cannot be confused with the account's
 * ------------------------------------------------------------------ */

describe('the vault\'s find', () => {
  it('accepts a whole vault and reports the four circuits from the chain', async () => {
    const { providers } = world();
    const found = await findDeployedVaultContract(
      providers, { compiledContract: {}, contractAddress: VAULT_A });
    expect(found.circuits).toEqual([...VAULT_CIRCUITS].sort());
    expect(typeof found.callTx.payout).toBe('function');
  });

  it('SAYS SO when the address is an account rather than failing on verifier keys', async () => {
    const { providers } = world({ chain: { [ACCOUNT]: ACCOUNT_OPS } });
    const failure = await findDeployedVaultContract(
      providers, { compiledContract: {}, contractAddress: ACCOUNT },
    ).then(() => null, (e: Error) => e);
    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/THIS IS AN ACCOUNT, NOT A VAULT/);
    // It points at the account's own find rather than leaving a reader to guess.
    expect(failure!.message).toMatch(/findDeployedPartialContract/);
    // And it does not print the address. C236.
    expect(failure!.message).not.toContain(ACCOUNT);
  });

  it('refuses a vault missing a circuit, and one carrying an extra', async () => {
    const short = world({ chain: { [VAULT_A]: ['deposit', 'payout', 'retire'] } });
    await expect(findDeployedVaultContract(
      short.providers, { compiledContract: {}, contractAddress: VAULT_A },
    // The COUNT is derived, not typed. The product builds this message from
    // `expected.length`; a literal here is a second copy of the number and it
    // is what made this test fail the turn the contract gained three circuits.
    )).rejects.toThrow(
      new RegExp(`does not carry the ${VAULT_CIRCUITS.length} circuits a vault has`));

    const long = world({ chain: { [VAULT_A]: [...VAULT_CIRCUITS, 'somethingElse'] } });
    await expect(findDeployedVaultContract(
      long.providers, { compiledContract: {}, contractAddress: VAULT_A },
    )).rejects.toThrow(/has been maintained since/);
  });

  it('keeps M-9: a deployed verifier key that differs is refused, by name', async () => {
    const { providers } = world({ corrupt: 'payout' });
    await expect(findDeployedVaultContract(
      providers, { compiledContract: {}, contractAddress: VAULT_A },
    )).rejects.toThrow(/Following operations: payout/);
  });

  /*
   * **THE VAULT ON THIS PROJECT'S REGISTRY THAT PASSES EVERY OTHER CHECK.**
   *
   * A vault deployed on 29 Aug carries four ledger fields; the contract this
   * build compiled declares five. Its circuits are the right seven and its
   * verifier keys compare equal - measured against the live chain - so the two
   * checks above pass it, and a client reading the fifth field off it reads
   * past the end of its ledger. Here it is with the same circuits and the same
   * keys as a good vault, refused on the one thing that differs.
   */
  it('refuses a vault whose LEDGER is a field short, with the same circuits and the same keys', async () => {
    const { providers } = world({ ledgerSlots: [0, 1, 2, 3] });
    const failure = await findDeployedVaultContract(
      providers, { compiledContract: {}, contractAddress: VAULT_A },
    ).then(() => null, (e: Error) => e);
    /* RED WHEN the find resolves a vault this build cannot read, which is the defect this file is about. */
    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/holds 4 ledger fields/);
    expect(failure!.message).toMatch(/compiled has 5/);
    /* RED WHEN a refusal on the money path does not say whether money moved. */
    expect(failure!.message).toMatch(/Nothing was proved, submitted or spent\./);
    /* RED WHEN the address is printed. */
    expect(failure!.message).not.toContain(VAULT_A);
  });

  it('refuses BEFORE it hands back a call interface, so no circuit can be built on it', async () => {
    const { providers } = world({ ledgerSlots: [0, 1, 3] });
    await expect(findDeployedVaultContract(
      providers, { compiledContract: {}, contractAddress: VAULT_A })).rejects.toThrow();
    /* RED WHEN the refusal happens after the interface is made, which is a call away from a fee. */
    expect(providers.__harness.interfaces).toEqual([]);
  });

  it('lets a vault of this build\x27s own ledger through, which every payment needs', async () => {
    const { providers } = world();
    /* RED WHEN the gate refuses the vault this build deploys. */
    const found = await findDeployedVaultContract(
      providers, { compiledContract: {}, contractAddress: VAULT_A });
    expect(found.circuits).toEqual([...VAULT_CIRCUITS].sort());
  });

  it('a bare address with no contract is our ignorance, not an empty vault', async () => {
    const { providers } = world({ chain: { [VAULT_A]: null } });
    const failure = await findDeployedVaultContract(
      providers, { compiledContract: {}, contractAddress: VAULT_A },
    ).then(() => null, (e: Error) => e);
    expect(failure!.message).toMatch(/not an empty vault/);
    expect(failure!.message).toMatch(/indexer has not caught up/);
    expect(failure!.message).not.toContain(VAULT_A);
  });
});

describe('the vault\'s circuit list is the vault\'s', () => {
  it('is exactly what the COMPILER declares, sorted — read off the artefact, not typed in', () => {
    /*
     * `contract-info.json` is compactc's own answer and the only thing that
     * knows the real circuit set — `M-38`'s reason for reading this file rather
     * than the generated wrappers, which all take rest parameters. If the vault
     * ever gains or loses a circuit, this fails in the same turn the contract
     * is recompiled rather than on a chain.
     */
    const info = JSON.parse(readFileSync(
      new URL('../../contracts/managed-vault/compiler/contract-info.json', import.meta.url),
      'utf8'));
    const provable = (info.circuits as any[])
      .filter((c) => c.proof === true).map((c) => String(c.name)).sort();
    expect([...VAULT_CIRCUITS]).toEqual(provable);
    expect([...VAULT_CIRCUITS]).toEqual([...VAULT_CIRCUITS].sort());
  });

  it('the account tells it refuses on are circuits the account ACTUALLY deploys', () => {
    /*
     * The production refusal names three account entry points by hand, on
     * purpose: coupling it to the account's DEPLOYMENT lists would make the
     * message change when an unrelated decision changes. This is the pin that
     * keeps the hand-written names true — if the account's split ever defers
     * all three, the "this is an account" refusal stops firing and this fails.
     */
    const tells = ['adopt', 'recordPayment', 'setVaultThreshold'];
    expect(tells.some((t) => ACCOUNT_OPS.includes(t as never))).toBe(true);
  });

  it('names the thing being described, because the same refusal fires twice', () => {
    expect(() => assertVaultCircuitSet(['deposit'], 'the compiled vault'))
      .toThrow(/^the compiled vault does not carry/);
    expect(() => assertVaultCircuitSet(['deposit'], 'the contract at the address given'))
      .toThrow(/^the contract at the address given does not carry/);
  });

  it('accepts the whole set in any order', () => {
    // Reversed rather than re-typed: the assertion under test is about the SET,
    // and a hand-written list here is a third copy of the deployment (the
    // contract, VAULT_CIRCUITS, and this) that goes stale silently.
    expect(() => assertVaultCircuitSet(
      [...VAULT_CIRCUITS].reverse(), 'the compiled vault')).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * ROUTE (a): THE HAND-BUILT DEPLOY, AND THE KEY THAT IS NOT STORED
 * ------------------------------------------------------------------ */

/**
 * **THE ONE PROPERTY THIS BLOCK EXISTS FOR: a vault deployed under a committee
 * stores NO signing key, and this goes red the day the call comes back.**
 * A custody surface that is gone because nobody has exercised the path is a
 * property nobody has established; one that is gone because a test goes red the
 * day it returns is a property. This is that difference, written down.
 *
 * **THE NEGATIVE CONTROL IS IN THE SAME BLOCK AND IS NOT OPTIONAL.** This
 * project has shipped assertions that could not fail, inside the fix for a
 * defect whose whole cause was a test that could not fail. So every assertion
 * below that says *no key was stored* is paired with one driving the SAME
 * function,
 * against the SAME provider, with a `single-key` choice, and watches a key land.
 * **A green pair proves the store is reachable and the committee case is the
 * thing that empties it. A single green assertion would prove neither.**
 *
 * **WHAT THESE TESTS DO NOT COVER, STATED HERE RATHER THAN DISCOVERED LATER.**
 * They drive fakes of `createUnprovenDeployTx` and `submitTx`. Those fakes
 * mirror the real functions' silence about the signing-key slot, and that
 * silence is re-derived from the real `node_modules` file by the last test in
 * this block. **But a version bump that made `createUnprovenDeployTx` itself
 * store a key would be caught by that last test and by nothing else here, and a
 * version bump that introduced a fourth writer under a name nobody pinned would
 * be caught by it too and only because it pins a SET rather than a count.**
 * That is the same shape one layer out: somebody else's code, moving.
 */
describe('the hand-built vault deploy, and the second custody surface', () => {
  const ACCOUNT_PIN = ACCOUNT;

  /**
   * `JSON.stringify` with a bigint-safe replacer, for the sweeps that ask
   * whether a value reached ANY field of a result. The returned
   * `initialContractState` carries the authority, whose counter is a bigint,
   * and a bare `stringify` throws on it rather than answering the question.
   */
  const everything = (v: unknown): string =>
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)) ?? '';

  /** A committee of three VERIFYING keys. Not signing keys, and not real ones. */
  const COMMITTEE = {
    kind: 'committee' as const,
    committee: [
      { tag: 'schnorr', value: 'placeholder-verifying-key-one' },
      { tag: 'schnorr', value: 'placeholder-verifying-key-two' },
      { tag: 'schnorr', value: 'placeholder-verifying-key-three' },
    ],
    threshold: 2,
  };

  /**
   * The runtime's `ContractState`, mirrored, semantics and all.
   *
   * `data` and `maintenanceAuthority` are assignable and `setOperation` cannot
   * remove, which is the whole reason the account's path rebuilds from empty
   * (`ledger-v9.d.ts:808-830` gives `operations()`, `operation()`,
   * `setOperation()` and no removal). `serialize` renders everything that
   * decides the address, authority included, because the property under test is
   * that the authority is IN the state the address is derived from.
   */
  class FakeContractState {
    data: any = null;
    maintenanceAuthority: any = null;
    private ops = new Map<string, any>();
    operations(): string[] { return [...this.ops.keys()]; }
    operation(name: string): any { return this.ops.get(name); }
    setOperation(name: string, op: any): void { this.ops.set(name, op); }
    serialize(): Uint8Array {
      /* The counter is a bigint: `@midnightntwrk/ledger-v9/ledger-v9.d.ts:792`,
       * inside `ContractMaintenanceAuthority` at `:769`. (`:848` is the FIELD on
       * `ContractState` and was this comment's first, wrong, citation, corrected
       * caught in review.) `JSON.stringify`
       * throws on a bigint. The real `serialize` renders it; a fake that could not
       * would refuse every deploy for a reason the product does not have,
       * Found by the first run of this file, which failed nine tests on it. */
      return new TextEncoder().encode(JSON.stringify(
        { data: this.data, authority: this.maintenanceAuthority, ops: [...this.ops.keys()].sort() },
        (_k, v) => (typeof v === 'bigint' ? `${v}n` : v),
      ));
    }
  }

  class FakeAuthority {
    constructor(
      public committee: any[], public threshold: number, public counter?: bigint,
    ) {}
  }

  /**
   * The primitives, injected. Every one of them records, so the test asserts
   * what the path DID rather than what it returned.
   */
  const primitives = () => {
    const seen = {
      authorities: [] as FakeAuthority[],
      serialized: [] as string[],
      intents: [] as any[],
      ledgerReads: 0,
    };
    const prims = {
      ContractState: FakeContractState as any,
      ContractMaintenanceAuthority: class extends FakeAuthority {
        constructor(c: any[], t: number, n?: bigint) {
          super(c, t, n);
          seen.authorities.push(this);
        }
      } as any,
      ContractDeploy: class {
        address: string;
        constructor(public state: any) {
          /* The address is derived from the state, so a different authority is a
           * different address. That is the real relationship and the fake keeps
           * it: a fake with a constant address could not fail the way the
           * product would. */
          const text = typeof state === 'string' ? state : JSON.stringify(state);
          let h = 0n;
          for (const ch of text) h = (h * 31n + BigInt(ch.codePointAt(0)!)) % (1n << 64n);
          this.address = h.toString(16).padStart(64, '0');
        }
      } as any,
      Intent: {
        new: (ttl: unknown) => {
          const intent = {
            ttl,
            addDeploy(deploy: unknown) {
              seen.intents.push({ ttl, deploy, returned: intent });
              return intent;
            },
          };
          return intent;
        },
      } as any,
      Transaction: { fromParts: (...parts: unknown[]) => ({ parts }) } as any,
      ttlOneHour: () => 'ttl-one-hour',
      deserializeContractState: (bytes: Uint8Array, _ctx: unknown) => {
        const text = new TextDecoder().decode(bytes);
        seen.serialized.push(text);
        return text;
      },
      getNetworkId: () => 'the-network',
      SucceedEntirely: 'SucceedEntirely',
      readVaultLedger: (data: any) => {
        seen.ledgerReads += 1;
        if (data === 'unreadable') throw new Error('the artefact could not read this state');
        return { account: { bytes: Uint8Array.from(Buffer.from(String(data?.account), 'hex')) } };
      },
    };
    return { prims, seen };
  };

  /**
   * A world whose fake constructor produces a real-shaped vault state.
   *
   * `ops` defaults to the vault's own list read off `VAULT_CIRCUITS` rather
   * than typed in: a hard-coded fixture here would keep describing the
   * four-circuit vault of 27 Aug long after the unshielded circuits moved it.
   */
  const handBuiltWorld = (opts: {
    ops?: string[];
    keyless?: string;
    account?: string;
    newCoins?: any[];
    unprovenTx?: any;
  } = {}) => {
    const w = world();
    const h = w.providers.__harness;
    h.newCoins = opts.newCoins ?? [];
    h.unprovenTx = opts.unprovenTx ?? {};
    h.constructedState = () => {
      const st = new FakeContractState();
      st.data = { account: opts.account ?? ACCOUNT_PIN };
      st.maintenanceAuthority = new FakeAuthority(
        [{ tag: 'schnorr', value: 'placeholder-runtime-built' }], 1, 0n);
      for (const name of (opts.ops ?? [...VAULT_CIRCUITS])) {
        st.setOperation(name, name === opts.keyless ? {} : { verifierKey: KEY_OF(name) });
      }
      return st;
    };
    return w;
  };

  /* ---------------------------------------------------------------- *
   * DEPENDENCY 9: THE PROPERTY THIS WHOLE PATH EXISTS FOR
   * ---------------------------------------------------------------- */

  it('a COMMITTEE deploy stores NO signing key, anywhere', async () => {
    const { providers, provider } = handBuiltWorld();
    const { prims } = primitives();

    const out = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      prims,
    );

    /*
     * THE ASSERTION THIS WHOLE PATH EXISTS FOR.
     *
     * TURNS RED WHEN: the guarded write at the end of
     * submitHandBuiltVaultDeployTx becomes unconditional; or the path starts
     * going through the SDK's deployContract/submitDeployTx (index.mjs:1184);
     * or any helper it calls reaches privateStateProvider.setSigningKey by any
     * route. The provider records EVERY access by name, so the assertion does
     * not depend on knowing which route was taken.
     *
     * WATCHED: yes. The unconditional write was put back, in a copy outside
     * this repository, and this failed on both lines.
          */
    expect(provider.trace.filter((l: string) => l.startsWith('setSigningKey'))).toEqual([]);
    expect(provider.signingKeys.size).toBe(0);

    /* And the path says so about itself: which copies exist afterwards,
     * recorded rather than assumed. */
    expect(out.custody.storesSigningKey).toBe(false);
    expect(out.custody.keyCopies).toBe(0);
  });

  it('THE NEGATIVE CONTROL: the same function, the same provider, a single key, and one lands', async () => {
    /*
     * Without this the assertion above is green against a provider that
     * might simply be unreachable, and nobody would know. Same world, same
     * primitives, same call, one field different.
     */
    const { providers, provider } = handBuiltWorld();
    const { prims } = primitives();

    const out = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: CHOSEN },
      prims,
    );

    expect(provider.trace.filter((l: string) => l.startsWith('setSigningKey')))
      .toEqual([`setSigningKey ${out.contractAddress}`]);
    expect(provider.signingKeys.size).toBe(1);
    expect(provider.signingKeys.get(out.contractAddress)).toEqual(CHOSEN.signingKey);
    expect(out.custody.storesSigningKey).toBe(true);
    expect(out.custody.keyCopies).toBe(2);
  });

  it('the SDK path stores one and the hand-built committee path stores none, in one process', async () => {
    /*
     * The two paths side by side, which is the sentence worth recording. Not
     * two suites and not two files: one provider, both deploys,
     * and the store read at the end.
     */
    const sdk = handBuiltWorld();
    await deployVaultContract(sdk.providers, {
      compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: CHOSEN,
    });
    expect(sdk.provider.signingKeys.size).toBe(1);

    const hand = handBuiltWorld();
    const { prims } = primitives();
    await submitHandBuiltVaultDeployTx(
      hand.providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      prims,
    );
    expect(hand.provider.signingKeys.size).toBe(0);
  });

  it('reaches neither deployContract nor findDeployedContract, which are two of the SDK\'s three writers', async () => {
    const { providers } = handBuiltWorld();
    const { prims } = primitives();
    await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      prims,
    );
    expect(providers.__harness.deployCalls).toEqual([]);
    expect(providers.__harness.findDeployedContractCalls).toEqual([]);
    /* And it DID go through the two that write nothing. */
    expect(providers.__harness.unprovenCalls.length).toBe(1);
    expect(providers.__harness.submitted.length).toBe(1);
  });

  it('passes no signingKey to the constructor under a committee, so nothing is sampled from one', async () => {
    const { providers } = handBuiltWorld();
    const { prims } = primitives();
    await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      prims,
    );
    expect('signingKey' in providers.__harness.unprovenCalls[0]).toBe(false);
    /* And under a single key it IS passed, or createDeployTxOptions' own
     * `?? sampleSigningKey()` (index.mjs:1907) would invent one. C225. */
    const single = handBuiltWorld();
    await submitHandBuiltVaultDeployTx(
      single.providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: CHOSEN },
      primitives().prims,
    );
    expect(single.providers.__harness.unprovenCalls[0].signingKey).toEqual(CHOSEN.signingKey);
  });

  it('the committee reaches the state the ADDRESS is derived from, not just the report', async () => {
    /*
     * A deploy that recorded a committee the chain does not have is, in
     * requireVaultMaintenanceAuthority's own words, the failure that would
     * matter. The authority is inside the serialized state, so a different
     * committee is a different address.
     */
    const a = handBuiltWorld();
    const pa = primitives();
    const outA = await submitHandBuiltVaultDeployTx(
      a.providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      pa.prims,
    );
    expect(pa.seen.authorities[0].committee).toEqual(COMMITTEE.committee);
    expect(pa.seen.authorities[0].threshold).toBe(2);
    expect(pa.seen.authorities[0].counter).toBe(0n);
    expect(pa.seen.serialized[0]).toContain('placeholder-verifying-key-two');

    const b = handBuiltWorld();
    const outB = await submitHandBuiltVaultDeployTx(
      b.providers,
      {
        compiledContract: {}, accountAddress: ACCOUNT_PIN,
        maintenanceAuthority: { ...COMMITTEE, threshold: 3 },
      },
      primitives().prims,
    );
    expect(outB.contractAddress).not.toBe(outA.contractAddress);
  });

  /* ---------------------------------------------------------------- *
   * THE OTHER EIGHT DEPENDENCIES
   * ---------------------------------------------------------------- */

  it('DEPENDENCY 1: a constructor map missing a circuit refuses BEFORE anything is submitted', async () => {
    const { providers } = handBuiltWorld({ ops: [...VAULT_CIRCUITS].filter((c) => c !== 'payout') });
    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);

    expect(failure!.message).toMatch(/^the compiled vault does not carry/);
    expect(failure!.message).toContain('payout');
    /* Nothing was submitted, so no fee was spent on a vault money could never
     * leave: VerifierKeyNotPresent, and retire refuses a non-empty vault. */
    expect(providers.__harness.submitted).toEqual([]);
  });

  it('DEPENDENCY 1: an EXTRA circuit refuses too, and it is not a vault', async () => {
    const { providers } = handBuiltWorld({ ops: [...VAULT_CIRCUITS, 'recordPayment'] });
    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);
    expect(failure!.message).toMatch(/THIS IS AN ACCOUNT, NOT A VAULT/);
    expect(providers.__harness.submitted).toEqual([]);
  });

  it('DEPENDENCY 1: a circuit with no verifier key refuses, naming what rebuilds them', async () => {
    const { providers } = handBuiltWorld({ keyless: 'splitNote' });
    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);
    expect(failure!.message).toContain('splitNote');
    expect(failure!.message).toContain('compile step');
    expect(failure!.message).toContain('unmeasurable');
    expect(providers.__harness.submitted).toEqual([]);
  });

  it('DEPENDENCY 2: the refusal is the VAULT\'s, and it names the vault\'s own list', async () => {
    /*
     * The account's assertKnownCircuitSet is account-only by construction
     * (deferral.ts:126-140), so a vault driven through it would throw with the
     * account's names. This pins that the hand-built path uses the vault's.
     */
    const { providers } = handBuiltWorld({ ops: ['deposit'] });
    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);
    for (const c of VAULT_CIRCUITS) expect(failure!.message).toContain(c);
    expect(failure!.message).not.toContain('setVaultThreshold');
  });

  it('DEPENDENCY 3: a state married to a DIFFERENT account refuses, and does not print either address', async () => {
    const { providers } = handBuiltWorld({ account: VAULT_A });
    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);

    expect(failure!.message).toMatch(/married to a DIFFERENT account/);
    expect(failure!.message).toContain('can never be redirected');
    /* No address reaches a message: a shielded output addressed to a vault
     * with no deposit call is money nobody can spend. */
    expect(failure!.message).not.toContain(ACCOUNT_PIN);
    expect(failure!.message).not.toContain(VAULT_A);
    expect(providers.__harness.submitted).toEqual([]);
  });

  it('DEPENDENCY 3: an UNREADABLE state refuses rather than proceeding', async () => {
    const { providers } = handBuiltWorld();
    const h = providers.__harness;
    const inner = h.constructedState;
    h.constructedState = () => { const st = inner(); st.data = 'unreadable'; return st; };

    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);

    expect(failure!.message).toMatch(/could not be read back/);
    expect(failure!.message).toContain('Nothing has been spent');
    expect(providers.__harness.submitted).toEqual([]);
  });

  it('DEPENDENCY 4: nothing is written to the private-state store, for either authority', async () => {
    for (const authority of [COMMITTEE, CHOSEN]) {
      const { providers, provider } = handBuiltWorld();
      await submitHandBuiltVaultDeployTx(
        providers,
        { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: authority },
        primitives().prims,
      );
      /* The account's path writes one unconditionally (partial-contract.ts:357).
       * A vault driven through it would write under <address>:undefined, a real
       * shared key: C228's failure created by moving paths. */
      expect(provider.trace.filter((l: string) => l.startsWith('set '))).toEqual([]);
      expect(provider.trace.filter((l: string) => l.startsWith('get '))).toEqual([]);
      expect(provider.store.size).toBe(0);
      /* And no privateStateId was offered to the constructor for it to write from. */
      expect('privateStateId' in providers.__harness.unprovenCalls[0]).toBe(false);
    }
  });

  it('DEPENDENCY 5: the address is set through the vault\'s named rule, after submission', async () => {
    const { providers, provider } = handBuiltWorld();
    provider.setContractAddress(VAULT_A);
    provider.trace.length = 0;

    const out = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    );

    expect(provider.trace).toEqual([`address ${out.contractAddress}`]);
    expect(provider.trace.filter((l: string) => l === `address ${VAULT_A}`)).toEqual([]);
  });

  it('DEPENDENCY 5: an empty address refuses rather than sharing a prefix', () => {
    /* addressVaultPrivateState is the rule, and this is why the hand-built path
     * calls it rather than setContractAddress raw. C228. */
    expect(() => addressVaultPrivateState({ privateStateProvider: {} }, ''))
      .toThrow(/refusing to address a vault's private state by an empty address/);
  });

  it('DEPENDENCY 6: initialContractState is RETURNED, so nothing throws after submission', async () => {
    const { providers } = handBuiltWorld();
    const out = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    );
    /*
     * The account's path does not return it (partial-contract.ts:362-369), and
     * deployVaultContract reads it. opNames(undefined) throws AFTER submission,
     * at the exact point an address we deployed and did not write down is money
     * nobody can reach. A mechanical break, not a hazard.
     */
    const state: any = out.deployTxData.public.initialContractState;
    expect(state).toBeDefined();
    expect([...state.operations()].sort()).toEqual([...VAULT_CIRCUITS]);
    expect(out.circuits).toEqual([...VAULT_CIRCUITS]);
    expect(out.contractAddress).toEqual(expect.any(String));
    expect(out.contractAddress.length).toBeGreaterThan(0);
  });

  it('DEPENDENCY 7: a constructor that produced coins refuses, and the message is about the VAULT', async () => {
    const { providers } = handBuiltWorld({ newCoins: [{ value: 1n }] });
    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);

    expect(failure!.message).toContain('VAULT');
    expect(failure!.message).toContain('Vault.compact:262-264');
    /* The account's guard says the same thing about the account's constructor.
     * A guard describing the wrong contract is a guard nobody acts on. */
    expect(failure!.message).not.toContain('account constructor has never minted');
    expect(providers.__harness.submitted).toEqual([]);
  });

  it('DEPENDENCY 7: an offer on either slot refuses too, not only minted coins', async () => {
    for (const tx of [{ guaranteedOffer: {} }, { fallibleOffer: {} }]) {
      const { providers } = handBuiltWorld({ unprovenTx: tx });
      const failure = await submitHandBuiltVaultDeployTx(
        providers,
        { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
        primitives().prims,
      ).then(() => null, (e: Error) => e);
      expect(failure!.message).toMatch(/does not carry offers/);
    }
  });

  it('DEPENDENCY 8: unmaintainable is refused for a vault, by name and with the reason', () => {
    const failure = (() => {
      try { requireHandBuiltVaultAuthority({ kind: 'unmaintainable' }); return null; }
      catch (e) { return e as Error; }
    })();
    expect(failure!.message).toMatch(/cannot be deployed unmaintainable/);
    expect(failure!.message).toContain('permanently insolvent');
    /* The reason, not a citation: an operator can act on a reason, and a
     * refusal that names what resolves it is the only kind worth reading. */
    expect(failure!.message).toContain('recoverable grief');
    expect(failure!.message).toContain('irrecoverable loss');
  });

  it('DEPENDENCY 8: a committee IS accepted here and is still refused on the SDK path', () => {
    /*
     * The narrowing is not deleted, it is scoped. requireVaultMaintenanceAuthority
     * still guards deployVaultContract, which goes through deployContract and
     * can express one key and nothing else: a committee handed to THAT path
     * would be recorded and not carried, which its own comment calls the failure
     * that would matter.
     */
    expect(requireHandBuiltVaultAuthority(COMMITTEE)).toEqual(COMMITTEE);
    expect(() => requireVaultMaintenanceAuthority(COMMITTEE))
      .toThrow(/a vault cannot be deployed with a "committee" maintenance authority/);
  });

  it('DEPENDENCY 8: the SDK path\'s refusal no longer says the way out does not exist', () => {
    /*
     * That message ended `it is not taken here` until the hand-built path
     * existed. A sentence claiming what the system does
     * is checked when it is written, and this is the check.
     */
    const failure = (() => {
      try { requireVaultMaintenanceAuthority(COMMITTEE); return null; }
      catch (e) { return e as Error; }
    })();
    expect(failure!.message).toContain('submitHandBuiltVaultDeployTx');
    expect(failure!.message).not.toContain('it is not taken here');
  });

  /* ---------------------------------------------------------------- *
   * WHAT THE CUSTODY ANSWER SAYS, AND WHAT IT MUST NEVER SAY
   * ---------------------------------------------------------------- */

  it('vaultDeployCustody answers the custody question for both choices, by name', () => {
    const committee = vaultDeployCustody(COMMITTEE);
    expect(committee.storesSigningKey).toBe(false);
    expect(committee.keyCopies).toBe(0);
    expect(committee.where.join(' ')).toMatch(/nowhere/);

    const single = vaultDeployCustody(CHOSEN);
    expect(single.storesSigningKey).toBe(true);
    /* TWO: the 0600 file the authority door wrote, and the level store.
     * The second is the one nobody chose. */
    expect(single.keyCopies).toBe(2);
    expect(single.where.length).toBe(2);
    expect(single.where.join(' ')).toContain('0600');
    expect(single.where.join(' ')).toContain('private-state store');
  });

  it('vaultDeployCustody carries NO key material, for either choice', () => {
    /*
     * A report is a plaintext home for anything put in it, and a key that
     * reaches a file which is not 0600 and ignored by version control has left
     * the only place it was meant to be. It has happened in this repository.
     * This describes places, the way describeMaintenanceAuthority describes
     * shapes.
     */
    const text = JSON.stringify([vaultDeployCustody(COMMITTEE), vaultDeployCustody(CHOSEN)]);
    expect(text).not.toContain(CHOSEN.signingKey.value);
    for (const k of COMMITTEE.committee) expect(text).not.toContain(k.value);
  });

  /* ---------------------------------------------------------------- *
   * WHAT THE FAKES CANNOT SEE: THE VERSION BUMP, MEASURED
   * ---------------------------------------------------------------- */

  it('the SDK mentions setSigningKey at exactly four sites, all of them off this path', () => {
    /*
     * SOMEBODY ELSE'S CODE, MOVING. Every other test in this block drives a
     * FAKE of the SDK. This one reads the real file, so a version bump that
     * moved `setSigningKey` into a function this path DOES call is caught here
     * and nowhere else in this repository.
     *
     * **IT PINS THE CALL SITES THEMSELVES, NOT THE FUNCTIONS AROUND THEM, AND
     * THIS IS THE SECOND DRAFT OF IT.** The first walked the file tracking
     * the most recent column-0 `function` / `async function` / `const x = (` and
     * pinned the set of enclosing names. A review found four writers it did
     * not see, put into `createUnprovenDeployTx` and `submitTx`:
     * a `class` method, a `var` arrow, a call written `setSigningKey (a, b)`
     * with a space, and a destructured `const { setSigningKey } = provider`.
     * **Each was green, because an unmatched enclosing form silently inherits
     * the previous name, and the previous name was already in the expected
     * set.** Scope inference from line-start text cannot be made safe, so this
     * does not attempt it.
     *
     * What it pins instead is every line in the file mentioning the identifier
     * at all, trimmed. That is blind to enclosing form, to spacing inside the
     * call, and to destructuring, because a mention is a mention. It goes red on
     * a cosmetic reformat of the dependency too, and that is the right trade: a
     * reformat is a version change and this is a version pin.
     *
     * TURNS RED WHEN: the dependency is bumped and any mention moves, changes,
     * disappears or gains a sibling, in any syntactic form.
     * WATCHED: yes, against a copy of `index.mjs` outside this repository, for
     * all four shapes review found and for the two the first draft caught.
     */
    const version =
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
        .dependencies['@midnight-ntwrk/midnight-js-contracts'];
    /* Pinned so a bump names itself in the failure rather than leaving a bare
     * set diff. `package.json` fixes it exactly, with no range. */
    expect(version).toBe('5.0.0-beta.4');

    const sdk = readFileSync(
      new URL('../../node_modules/@midnight-ntwrk/midnight-js-contracts/dist/index.mjs',
        import.meta.url), 'utf8');

    const mentions = (source: string): string[] =>
      source.split('\n').filter((l) => /\bsetSigningKey\b/.test(l)).map((l) => l.trim());

    /*
     * The four, in file order, verbatim. THREE FUNCTIONS HOLD THEM:
     * `submitReplaceAuthorityTx` (`:556`), `submitDeployTx` (`:1184`) and
     * `setOrGetInitialSigningKey` (`:1953`, `:1961`), which
     * `findDeployedContract` reaches at `:2053`. This path calls none of the
     * three: it uses `createUnprovenDeployTx` (`:1113`, delegating to
     * `createUnprovenDeployTxFromVerifierKeys` at `:1058-1112`) and `submitTx`
     * (`:70-85`, over `submitTxCore` at `:27-69`).
     */
    expect(mentions(sdk)).toEqual([
      'await providers.privateStateProvider.setSigningKey(contractAddress, newAuthority);',
      'await providers.privateStateProvider.setSigningKey(unprovenDeployTxData.public.contractAddress, unprovenDeployTxData.private.signingKey);',
      'await privateStateProvider.setSigningKey(options.contractAddress, options.signingKey);',
      'await privateStateProvider.setSigningKey(options.contractAddress, freshSigningKey);',
    ]);
  });

  it('the mention-pin sees all four shapes that beat the first draft, so it is not vacuous', () => {
    /*
     * For the assertion that is hardest to watch fail: the one over
     * somebody else's file. Each shape below is one review put into a copy of
     * the real `index.mjs` and watched the FIRST draft pass. Built here
     * as strings rather than by editing anything on disk: a
     * test that mutates the repository owns every assertion about it, and this
     * one mutates nothing.
     */
    const mentions = (source: string): string[] =>
      source.split('\n').filter((l) => /\bsetSigningKey\b/.test(l)).map((l) => l.trim());

    /* 1. A class method. `class` is not a function declaration, so scope
     *    inference attributed this to whatever came before it. */
    expect(mentions([
      'class SigningKeyStore {',
      '  async put(p, a, k) { await p.privateStateProvider.setSigningKey(a, k); }',
      '}',
    ].join('\n'))).toEqual([
      'async put(p, a, k) { await p.privateStateProvider.setSigningKey(a, k); }',
    ]);

    /* 2. A `var` arrow. */
    expect(mentions('var store = async (p, a, k) => { await p.privateStateProvider.setSigningKey(a, k); };'))
      .toHaveLength(1);

    /* 3. A space before the parenthesis, which `.includes(".setSigningKey(")`
     *    could not see. */
    expect(mentions('    await providers.privateStateProvider.setSigningKey (a, b);'))
      .toEqual(['await providers.privateStateProvider.setSigningKey (a, b);']);

    /* 4. Destructured, so there is no dot before the name at the call. */
    expect(mentions([
      'const { setSigningKey } = providers.privateStateProvider;',
      'await setSigningKey(a, b);',
    ].join('\n'))).toHaveLength(2);

    /* And a source with no mention at all is empty, so the filter is a filter. */
    expect(mentions('const x = 1;\nawait providers.privateStateProvider.set(a, b);')).toEqual([]);
    /* A near-miss identifier is NOT a mention: the word boundary is doing work. */
    expect(mentions('await p.setSigningKeyOfSomethingElse(a, b);')).toEqual([]);
  });

  /* ---------------------------------------------------------------- *
   * buildVaultDeployState ON ITS OWN: the checks, without a submission
   * ---------------------------------------------------------------- */

  it('buildVaultDeployState decides everything before a transaction exists', () => {
    const { prims, seen } = primitives();
    const constructed = new FakeContractState();
    constructed.data = { account: ACCOUNT_PIN };
    constructed.maintenanceAuthority = new FakeAuthority([], 1, 0n);
    for (const name of VAULT_CIRCUITS) constructed.setOperation(name, { verifierKey: KEY_OF(name) });

    const { state, circuits } = buildVaultDeployState(prims, {
      constructed: constructed as any,
      offer: { newCoins: 0, guaranteed: undefined, fallible: undefined },
      accountAddress: ACCOUNT_PIN,
      authority: COMMITTEE,
    });

    expect(circuits).toEqual([...VAULT_CIRCUITS]);
    expect(state.data).toBe(constructed.data);
    expect((state.maintenanceAuthority as FakeAuthority).threshold).toBe(2);
    expect(seen.ledgerReads).toBe(1);
    /* Nothing was serialized, submitted or addressed: this function builds and
     * checks, and the one that submits does no checking of its own. */
    expect(seen.serialized).toEqual([]);
    expect(seen.intents).toEqual([]);
  });

  it('buildVaultDeployState refuses a state whose operations map came out WRONG, not only one that went in wrong', () => {
    /*
     * THE POST-BUILD CHECK, AND IT IS HERE BECAUSE IT SURVIVED A PLANTED BREAK.
     *
     * The first draft of this block was probed with twenty-two breaks and
     * twenty-one went red. The one that did not was deleting
     * `assertVaultCircuitSet(circuits, 'the vault state this deploy would
     * submit')`, because the pre-build assertion already guarantees the input
     * and every fake `setOperation` in this file honours what it is given.
     * **So the check was real and the assertion behind it could not fail, which
     * is exactly the class this block is written to avoid.**
     *
     * The hazard it guards is not hypothetical and is not the input: dependency
     * 1's failure is a map that is WRONG ON CHAIN, and `setOperation` is a
     * runtime call this path makes seven times and reads back never. A vault
     * deployed missing `payout` can be deposited into and can never pay out.
     * So the check stays and this drives the case it exists for: a
     * `ContractState` that accepts a `setOperation` and does not keep it.
     *
     * TURNS RED WHEN: the post-build assertion is deleted or weakened.
     * WATCHED: yes, both ways round.
     */
    const { prims } = primitives();
    class DroppingContractState extends FakeContractState {
      setOperation(name: string, op: any): void {
        if (name === 'payout') return;   // accepted, and silently not kept
        super.setOperation(name, op);
      }
    }

    const constructed = new FakeContractState();
    constructed.data = { account: ACCOUNT_PIN };
    constructed.maintenanceAuthority = new FakeAuthority([], 1, 0n);
    for (const name of VAULT_CIRCUITS) constructed.setOperation(name, { verifierKey: KEY_OF(name) });

    const failure = (() => {
      try {
        buildVaultDeployState(
          { ...prims, ContractState: DroppingContractState as any },
          {
            constructed: constructed as any,
            offer: { newCoins: 0, guaranteed: undefined, fallible: undefined },
            accountAddress: ACCOUNT_PIN,
            authority: COMMITTEE,
          },
        );
        return null;
      } catch (e) { return e as Error; }
    })();

    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/^the vault state this deploy would submit does not carry/);
    expect(failure!.message).toContain('payout');
    /* And the pre-build assertion did NOT fire: the input was whole, which is
     * what makes this a different check rather than the same one twice. */
    expect(failure!.message).not.toMatch(/^the compiled vault/);
  });

  it('buildVaultDeployState keeps the runtime\'s own authority for a single key, rather than rebuilding it', () => {
    const { prims, seen } = primitives();
    const constructed = new FakeContractState();
    constructed.data = { account: ACCOUNT_PIN };
    const runtimeBuilt = new FakeAuthority([{ tag: 'schnorr', value: 'placeholder-runtime-built' }], 1, 0n);
    constructed.maintenanceAuthority = runtimeBuilt;
    for (const name of VAULT_CIRCUITS) constructed.setOperation(name, { verifierKey: KEY_OF(name) });

    const { state } = buildVaultDeployState(prims, {
      constructed: constructed as any,
      offer: { newCoins: 0, guaranteed: undefined, fallible: undefined },
      accountAddress: ACCOUNT_PIN,
      authority: CHOSEN,
    });

    /* Two implementations of one rule is the more expensive mistake. The
     * runtime made this from the key we passed; rebuilding it here would be the
     * second. */
    expect(state.maintenanceAuthority).toBe(runtimeBuilt);
    expect(seen.authorities).toEqual([]);
  });
  /* ---------------------------------------------------------------- *
   * WHAT REVIEW FOUND UNWATCHED, AND THE ASSERTIONS THAT NOW WATCH IT
   *
   * This block's first draft was probed with 22 deliberate breaks and 21 went
   * red. REVIEW THEN TRIED 58 MORE AND FOUND EIGHTEEN THAT STAYED GREEN, one of
   * them able to deploy an unmaintainable vault while reporting success. Every
   * test below exists because a specific weakening survived, and every one was
   * tried again afterwards and watched to go red. **Probing your own work
   * against your own model of what can break is not sufficient.**
   * ---------------------------------------------------------------- */

  it('THE TRANSACTION SUBMITTED IS THE ONE THIS PATH BUILT, not the constructor\'s', async () => {
    /*
     * THE WORST ONE REVIEW FOUND, AND THE ONLY ONE GRADED THAT HIGH.
     *
     * The first draft asserted that submitTx was called ONCE and never looked at
     * WHAT was submitted. Swapping `{ unprovenTx }` for `{ unprovenTx: tx }` at
     * the submit call left all 54 tests green, and `tx` is
     * `unproven.private.unprovenTx`: the transaction the SDK built from the
     * CONSTRUCTOR's state, whose authority is the single key the runtime
     * sampled and that this path never stores.
     *
     * **SO THE MUTATED PATH DEPLOYS AN UNMAINTAINABLE VAULT, AT A DIFFERENT
     * ADDRESS, AND RETURNS THE COMMITTEE ADDRESS AND `keyCopies: 0`.** Both
     * consequences are irreversible: a deployed authority nobody holds can never
     * be replaced, and money sent to the returned address reaches nothing. Rule
     * 28.
     *
     * TURNS RED WHEN: anything other than the transaction built from the state
     * `buildVaultDeployState` returned is submitted. WATCHED: yes, with the
     * exact swap above.
     */
    const { providers } = handBuiltWorld();
    const { prims, seen } = primitives();
    const sentinelTx = { theConstructorsOwn: true };
    providers.__harness.unprovenTx = sentinelTx;

    await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      prims,
    );

    const submitted = providers.__harness.submitted[0];
    /* It is the object Transaction.fromParts made, and it carries the intent
     * this path assembled. */
    expect(submitted).toHaveProperty('parts');
    expect(seen.intents.length).toBe(1);
    expect((submitted as any).parts).toContain(seen.intents[0].returned);
    /* And it is NOT the constructor's. */
    expect(submitted).not.toBe(sentinelTx);
  });

  it('the transaction carries this path\'s network id and its one-hour TTL', async () => {
    /* Unasserted in the first draft: replacing both with wrong constants was
     * green. A deploy on the wrong network is a vault the product cannot see. */
    const { providers } = handBuiltWorld();
    const { prims, seen } = primitives();
    await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      prims,
    );
    expect(seen.intents[0].ttl).toBe('ttl-one-hour');
    expect((providers.__harness.submitted[0] as any).parts[0]).toBe('the-network');
  });

  it('a submission that did not SUCCEED ENTIRELY throws, and hands back no address', async () => {
    /*
     * Found twice in review, independently. Deleting the status check left 54
     * green because nothing ever drove a failing status, and the SDK's own words
     * (`index.mjs:1150-1157`) are that a fallible-phase failure is recorded on
     * chain with a non-SucceedEntirely status and the contract "may be partially
     * deployed but not functional", fee taken. Without the check this function
     * returns a real-looking result, with an address and `custody` saying no key
     * is stored, for a vault that does not work. A failure that looks like a
     * success, on the contract that holds the money.
     *
     * TURNS RED WHEN: the status check is deleted or weakened. WATCHED: yes.
     */
    const { providers, provider } = handBuiltWorld();
    providers.__harness.submitStatus = { status: 'FailFallible', txId: 'tx_partial' };

    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);

    expect(failure).not.toBeNull();
    expect((failure as any).finalizedTxData).toEqual({ status: 'FailFallible', txId: 'tx_partial' });
    /* And nothing was addressed or stored on the strength of a deploy that did
     * not land. */
    expect(provider.trace.filter((l: string) => l.startsWith('address '))).toEqual([]);
    expect(provider.signingKeys.size).toBe(0);
  });

  it('requireHandBuiltVaultAuthority keeps EVERY refusal it delegates for', () => {
    /*
     * Found twice in review. Replacing the delegation to
     * `requireMaintenanceAuthority` with a pass-through left 54 green, because
     * the only assertion on the accepting side compared the input to itself.
     * What is lost that way is not cosmetic:
     *
     *   MEASURED on ledger 9: one holder of K signs ONCE and attaches that signature at every seat
     *   holding K, because the signed data does not cover the signer index. So
     *   [K,K,K] at threshold 3 is a 1-of-3 wearing a 3-of-3's clothes. **On a
     *   vault that is the single-key drain wearing a committee's paperwork**,
     *   which is the exact failure this whole path exists to remove.
     *
     * TURNS RED WHEN: the delegation is cut, or any of the four refusals below
     * is lost. WATCHED: yes, with the pass-through review used.
     */
    const refusalFor = (choice: any): string => {
      try { requireHandBuiltVaultAuthority(choice); return '(accepted)'; }
      catch (e) { return (e as Error).message; }
    };
    const K = { tag: 'schnorr', value: 'placeholder-verifying-key-one' };

    /* One key at three seats is not a 3-of-3. */
    expect(refusalFor({ kind: 'committee', committee: [K, K, K], threshold: 3 }))
      .toMatch(/lists at least one key more than once/);
    /* An empty committee is the unmaintainable state said indirectly. */
    expect(refusalFor({ kind: 'committee', committee: [], threshold: 1 }))
      .toMatch(/needs at least one verifying key/);
    /* A threshold above the committee size is the same state again. */
    expect(refusalFor({ kind: 'committee', committee: [K], threshold: 2 }))
      .toMatch(/cannot have threshold 2/);
    /* And a single key with no recorded replacement is an unrecorded one. */
    expect(refusalFor({ kind: 'single-key', signingKey: K }))
      .toMatch(/RECORDED temporary state/);
    /* An absent choice is not a default. */
    expect(refusalFor(undefined)).toMatch(/no maintenance authority was given/);
  });

  it('the report states the authority that was actually installed, for both kinds', async () => {
    /*
     * Unasserted in the first draft: hard-coding a single-key description was
     * green, so a COMMITTEE deploy could report `single-key`, and
     * `requireVaultMaintenanceAuthority`'s own message calls a deploy recording
     * an authority the chain does not have "the failure that would matter".
     */
    const c = handBuiltWorld();
    const outC = await submitHandBuiltVaultDeployTx(
      c.providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    );
    expect(outC.authority).toEqual({ kind: 'committee', committeeSize: 3, threshold: 2 });

    const k = handBuiltWorld();
    const outK = await submitHandBuiltVaultDeployTx(
      k.providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: CHOSEN },
      primitives().prims,
    );
    expect(outK.authority).toEqual({
      kind: 'single-key', committeeSize: 1, threshold: 1, fixedBy: CHOSEN.temporary.fixedBy,
    });
    /* And the report is a SHAPE. No key material reaches it, either kind. */
    const printed = JSON.stringify([outC.authority, outK.authority]);
    expect(printed).not.toContain(CHOSEN.signingKey.value);
    for (const key of COMMITTEE.committee) expect(printed).not.toContain(key.value);
  });

  it('the KEY THE RUNTIME SAMPLED reaches nothing this deploy returns, stores or reports', async () => {
    /*
     * The sentinel the fake constructor now hands back on
     * `private.signingKey`. In committee mode the runtime DOES sample a key
     * (`ContractExecutable.js:277-280`), this path discards it, and the first
     * draft could not have noticed if it had stopped doing so: the fake had no
     * key to leak. Review found a weakening that spread `unproven.private`
     * into the returned object and stayed green.
     *
     * A report is a plaintext home for anything put in it, and that has cost
     * this repository once already.
     */
    const { providers, provider } = handBuiltWorld();
    const sentinel = providers.__harness.sampledSentinel;
    const out = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    );
    expect(everything(out)).not.toContain(sentinel);
    expect(everything([...provider.store.entries()])).not.toContain(sentinel);
    expect(everything([...provider.signingKeys.entries()])).not.toContain(sentinel);
    expect(provider.trace.join('\n')).not.toContain(sentinel);
    /* And the sweep is a sweep: the sentinel IS findable when it is there. */
    expect(everything({ anywhere: sentinel })).toContain(sentinel);
  });

  it('the address returned is the one derived from the state this path built, not the constructor\'s', async () => {
    /*
     * The fake constructor now returns `public.contractAddress`, as the real one
     * does (`index.mjs:1073`). It is derived from the INTERIM authority, so
     * against the real SDK reaching for it would return the address of a vault
     * carrying a sampled single key rather than the committee. The first draft
     * could not have caught that, because the fake did not return the field.
     */
    const { providers } = handBuiltWorld();
    const out = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    );
    expect(out.contractAddress).not.toBe(providers.__harness.constructorAddress);
    expect(out.contractAddress).not.toBe(VAULT_A);
  });

  it('the key-on-disk check and the address-shape check guard THIS path too, not only the SDK\'s', async () => {
    /*
     * Both were pinned for `deployVaultContract` and neither for this one, so
     * both could be deleted and the suite stayed green. The V-37 regex is
     * load-bearing rather than tidy: `Buffer.from(account, 'hex')` truncates
     * silently on anything it does not like, so without the regex the
     * constructor is handed a short or empty argument instead of being refused.
     */
    const noKeys = world({ keys: [] });
    noKeys.providers.__harness.constructedState = () => { throw new Error('unreached'); };
    const keyFailure = await submitHandBuiltVaultDeployTx(
      noKeys.providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    ).then(() => null, (e: Error) => e);
    expect(keyFailure!.message).toMatch(/verifier keys are not on disk/);
    expect(keyFailure!.message).toContain('compile step');
    expect(noKeys.providers.__harness.unprovenCalls).toEqual([]);

    for (const bad of ['', '   ', 'not-hex', 'ab'.repeat(31), 'ab'.repeat(33)]) {
      const w = handBuiltWorld();
      const failure = await submitHandBuiltVaultDeployTx(
        w.providers,
        { compiledContract: {}, accountAddress: bad, maintenanceAuthority: COMMITTEE },
        primitives().prims,
      ).then(() => null, (e: Error) => e);
      expect(failure!.message).toMatch(/not 32 bytes of ` ?hex|not 32 bytes of hex/);
      expect(failure!.message).toContain('can never be redirected');
      expect(w.providers.__harness.unprovenCalls).toEqual([]);
    }
  });

  it('the account pin is compared WHOLE and case-insensitively, not by prefix', async () => {
    /*
     * The only negative case in the first draft differed in every byte, so
     * weakening the comparison to a two-character prefix check stayed green.
     * These are the near misses: one byte different at each end, and the same
     * address in the other case, which must be ACCEPTED rather than refused on
     * a correct vault.
     */
    const lastByteDiffers = ACCOUNT_PIN.slice(0, 62) + 'ff';
    const firstByteDiffers = 'ff' + ACCOUNT_PIN.slice(2);
    for (const near of [lastByteDiffers, firstByteDiffers]) {
      const { providers } = handBuiltWorld({ account: near });
      const failure = await submitHandBuiltVaultDeployTx(
        providers,
        { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
        primitives().prims,
      ).then(() => null, (e: Error) => e);
      expect(failure!.message).toMatch(/married to a DIFFERENT account/);
      expect(providers.__harness.submitted).toEqual([]);
    }

    /* And the same address in upper case is the SAME address. Without the
     * lower-casing this refuses a correct vault, which fails closed and is
     * still a door nobody can get through. */
    const upper = handBuiltWorld({ account: ACCOUNT_PIN });
    await expect(submitHandBuiltVaultDeployTx(
      upper.providers,
      {
        compiledContract: {}, accountAddress: ACCOUNT_PIN.toUpperCase(),
        maintenanceAuthority: COMMITTEE,
      },
      primitives().prims,
    )).resolves.toBeDefined();
  });

  it('an unbuildable committee refuses with a sentence naming the seat and the file, not the runtime\'s', () => {
    /*
     * A REFUSAL NAMES WHAT RESOLVES IT. The runtime refuses a malformed
     * verifying key with `failed to
     * fill whole buffer`, which names neither. This wraps it. Review
     * measured the runtime's own behaviour: a blank value, an unknown tag,
     * non-hex, 64 zeros and both wrong lengths are all refused, and a
     * WELL-FORMED key nobody holds is accepted, which nothing can fix here.
     */
    const { prims } = primitives();
    const exploding = {
      ...prims,
      ContractMaintenanceAuthority: class {
        constructor() { throw new Error('failed to fill whole buffer'); }
      } as any,
    };
    const constructed = new FakeContractState();
    constructed.data = { account: ACCOUNT_PIN };
    constructed.maintenanceAuthority = new FakeAuthority([], 1, 0n);
    for (const name of VAULT_CIRCUITS) constructed.setOperation(name, { verifierKey: KEY_OF(name) });

    const failure = (() => {
      try {
        buildVaultDeployState(exploding, {
          constructed: constructed as any,
          offer: { newCoins: 0, guaranteed: undefined, fallible: undefined },
          accountAddress: ACCOUNT_PIN,
          authority: COMMITTEE,
        });
        return null;
      } catch (e) { return e as Error; }
    })();

    expect(failure!.message).toMatch(/committee of 3 could not be built/);
    expect(failure!.message).toContain('failed to fill whole buffer');
    expect(failure!.message).toContain('.midnight/');
    expect(failure!.message).toContain('Nothing has been spent');
    /* And it says what it cannot check, so nobody reads it as a possession
     * proof. */
    expect(failure!.message).toMatch(/well formed but whose signing half\s+nobody holds|well formed but whose signing half nobody holds/);
  });

  it('the deploy refuses an empty address rather than filing under a shared prefix, THROUGH the path', async () => {
    /*
     * `addressVaultPrivateState` was only ever driven directly, so replacing the
     * call with a raw `setContractAddress` was green: both spellings leave the
     * same trace. This drives the rule's own refusal through the deploy, which
     * a raw call does not have.
     */
    const { providers, provider } = handBuiltWorld();
    const { prims } = primitives();
    const emptyAddress = {
      ...prims,
      ContractDeploy: class { address = ''; constructor(public state: any) {} } as any,
    };
    const failure = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      emptyAddress,
    ).then(() => null, (e: Error) => e);

    expect(failure!.message).toMatch(/refusing to address a vault's private state by an empty address/);
    expect(failure!.message).toContain('shared one');
    expect(provider.signingKeys.size).toBe(0);
  });

  it('the finalized transaction data reaches the caller, so a fee and a txId are not lost', async () => {
    /* The spread was unasserted: dropping it took `txId` and `status` out of the
     * result with nothing noticing, and those are what a deploy report reads. */
    const { providers } = handBuiltWorld();
    const out = await submitHandBuiltVaultDeployTx(
      providers,
      { compiledContract: {}, accountAddress: ACCOUNT_PIN, maintenanceAuthority: COMMITTEE },
      primitives().prims,
    );
    expect(out.deployTxData.public.txId).toBe('tx_vault_handbuilt');
    expect(out.deployTxData.public.status).toBe('SucceedEntirely');
    /* And the address is this path's, not whatever the finalized data carried. */
    expect(out.deployTxData.public.contractAddress).toBe(out.contractAddress);
  });

});
