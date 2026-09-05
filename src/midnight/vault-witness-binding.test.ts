/**
 * V-82, the other half: THE WITNESSES MUST GO ON THE COMPILED CONTRACT.
 *
 * The defect: `VaultLedger.call` assigned `witnesses` onto the object
 * `findDeployedContract` RETURNED. Witnesses belong to the `CompiledContract`
 * that is handed IN — `ledger.ts` has always done it that way, and compact-js
 * stores them in its own context, which `createContract` reads to build the
 * contract with `new ctor(witnesses)`. Against the real SDK the assignment was
 * inert, so `noteToSpend` was never called, `pending.spending` was never set,
 * and every payout ended at our own guard telling the operator to rebuild the
 * pool from the chain — an error confidently wrong about what went wrong.
 *
 * **This file exists because reverting that fix left the whole suite green.**
 * Every other test overrides `connect`, so the real one was executed by nothing.
 * Here THE FIND — and only the find — is intercepted, so `connect` runs for
 * real and what it hands over can be looked at.
 *
 * **WHICH FIND MOVED, AND THIS FILE MOVED WITH IT IN THE SAME TURN.** `S6e`.
 * `connect` used to call the SDK's `findDeployedContract`; it now calls
 * `findDeployedVaultContract` (`src/midnight/vault-contract.ts`), which is the
 * vault's own — it checks the operations map is exactly the vault's four,
 * addresses the private-state store per vault before anything reads (`C228`),
 * and samples no signing key, which the SDK's find does for any address the
 * store has none for (`M-155`). So the seam this file stubs is that function
 * rather than the SDK's. **Left pointing at the old name, this file would have
 * gone green while intercepting nothing** — a stub of a function nobody calls
 * is a test of nothing, which is exactly the failure the file was written to
 * prevent.
 */
import { describe, it, expect, vi } from 'vitest';

const handedOver: Array<{ compiledContract: any; contractAddress: string }> = [];

vi.mock('./vault-contract.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    findDeployedVaultContract: async (_providers: unknown, opts: any) => {
      handedOver.push(opts);
      return { callTx: {}, circuits: [] };
    },
  };
});

const VAULT_ARTEFACTS = new URL('../../contracts/managed-vault', import.meta.url).pathname;

/** Reads witnesses back out of compact-js's own context, wherever it keeps them. */
const witnessesCarriedBy = (compiled: unknown): unknown => {
  for (const sym of Object.getOwnPropertySymbols(compiled as object)) {
    const v = (compiled as any)[sym];
    if (v && typeof v === 'object' && 'witnesses' in v) return (v as any).witnesses;
  }
  return undefined;
};

describe('connect() binds the witnesses where the SDK reads them', () => {
  it('hands the vault find a compiled contract CARRYING our witnesses', async () => {
    const { VaultLedger } = await import('./vault-ledger.js');
    const CompactJs: any = await import('@midnight-ntwrk/compact-js');
    const { Contract } = await import('../../contracts/managed-vault/contract/index.js') as any;

    handedOver.length = 0;
    const compiled = CompactJs.CompiledContract.make('vault-under-test', Contract);
    const witnesses = { noteToSpend: () => {} };

    const ledger: any = new VaultLedger(
      { networkId: 'preview' } as never, {} as never, async () => ({}) as never,
      compiled, { load: async () => ({}), save: async () => {} } as never, VAULT_ARTEFACTS);

    await ledger.connect('addr_vault', witnesses);

    expect(handedOver).toHaveLength(1);
    const given = handedOver[0].compiledContract;

    /* The witnesses reached the compiled contract the find was given... */
    expect(witnessesCarriedBy(given)).toBe(witnesses);
    /* ...and it is NOT the bare one, which is what an inert assignment produced. */
    expect(given).not.toBe(compiled);
    /* ...and the bare one was never mutated, so nothing leaks between calls. */
    expect(witnessesCarriedBy(compiled)).not.toBe(witnesses);
    expect(handedOver[0].contractAddress).toBe('addr_vault');
  });

  it('binds them PER CALL, so two calls cannot share one set', async () => {
    const { VaultLedger } = await import('./vault-ledger.js');
    const CompactJs: any = await import('@midnight-ntwrk/compact-js');
    const { Contract } = await import('../../contracts/managed-vault/contract/index.js') as any;

    handedOver.length = 0;
    const compiled = CompactJs.CompiledContract.make('vault-under-test', Contract);
    const ledger: any = new VaultLedger(
      { networkId: 'preview' } as never, {} as never, async () => ({}) as never,
      compiled, { load: async () => ({}), save: async () => {} } as never, VAULT_ARTEFACTS);

    const first = { noteToSpend: () => 'first' };
    const second = { noteToSpend: () => 'second' };
    await ledger.connect('addr_vault', first);
    await ledger.connect('addr_vault', second);

    expect(witnessesCarriedBy(handedOver[0].compiledContract)).toBe(first);
    expect(witnessesCarriedBy(handedOver[1].compiledContract)).toBe(second);
  });
});
