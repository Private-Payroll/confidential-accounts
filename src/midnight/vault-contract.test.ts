/**
 * THE VAULT'S DEPLOY AND ITS OWN FIND. S6e — and `C228` is what most of this
 * file is about.
 *
 * `C228`'s row says private state is filed under
 * `${contractAddress}:${privateStateId}`, that the address half is a mutable
 * closure variable, and that **it worked only because exactly one contract had
 * ever been addressed.** This round addresses a second, and a third: a company
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
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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
}));

const {
  VAULT_CIRCUITS, assertVaultCircuitSet, addressVaultPrivateState,
  requireVaultMaintenanceAuthority, deployVaultContract, findDeployedVaultContract,
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
 * long after `S9`'s split moved — and the test asserting "this is an account"
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
      // And it names what it would take, so the limit is a finding and not a wall.
      expect(failure!.message).toMatch(/M-156/);
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
  it('refuses an account address that is not 32 bytes of hex, naming V-37', async () => {
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
    // Pointing at vault A. Before this round, a find for B would have read and
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

  it('a bare address with no contract is our ignorance, not an empty vault', async () => {
    const { providers } = world({ chain: { [VAULT_A]: null } });
    const failure = await findDeployedVaultContract(
      providers, { compiledContract: {}, contractAddress: VAULT_A },
    ).then(() => null, (e: Error) => e);
    expect(failure!.message).toMatch(/not an empty vault/);
    expect(failure!.message).toMatch(/C110/);
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
