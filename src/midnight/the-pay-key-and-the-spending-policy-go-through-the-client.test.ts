/*
 * The pay-record key and the spending policy, read and set through the ledger client
 * against the fake chain.
 */
import { describe, it, expect } from 'vitest';
import { fromHex, toHex } from '../core/crypto.js';
import type { Hex } from '../core/crypto.js';
import { assetIdBytes } from '../core/assets.js';
import { policyCommitmentOf, policyBarKey } from './spending-policy.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { TEST_TOKEN } from '../testing/assets.js';
import { argHex, BY, CFG, CHANGE, harness, PROPOSAL_ID } from './a-ledger-on-a-fake-chain.test-support.js';

describe('the pay-record key on chain, and what the approving device can read', () => {
  const COMMIT = toHex(pureCircuits.payKeyCommitmentOf(new Uint8Array(32).fill(0x3c))) as Hex;
  const WRAP = [1, 2, 3, 4].map(n => ('0' + n).repeat(32) as Hex);
  const at = toHex(pureCircuits.payKeyCommitmentKey()) as Hex;

  it('refuses to seal the first copy without an approved round, before anything is built', async () => {
    const { ledger, calls } = harness({});
    /* RED WHEN the first copy can be sealed with no round: the commitment would be first-come. */
    await expect(ledger.prepare('acct', { kind: 'sealPayKey', wrap: WRAP, commitment: COMMIT, proposalId: null }))
      .rejects.toThrow(/nobody has confirmed this company's pay-record key on chain yet/);
    await expect(ledger.prepare('acct', { kind: 'sealPayKey', wrap: WRAP, commitment: COMMIT, proposalId: PROPOSAL_ID }))
      .resolves.toBeDefined();
    const short = harness({ approvals: 1n, threshold: 2n });
    await expect(short.ledger.prepare('acct', { kind: 'sealPayKey', wrap: WRAP, commitment: COMMIT, proposalId: PROPOSAL_ID }))
      .rejects.toThrow(/1 of 2 approvals/);
    expect([...calls, ...short.calls]).toHaveLength(0);
  });

  it('refuses a later copy of a key the account did not commit to, and a copy of the wrong shape', async () => {
    const { ledger } = harness({ signerRoles: [[at, toHex(new Uint8Array(32).fill(9)) as Hex]] });
    /* RED WHEN a later copy is not compared with the commitment on chain before a fee is paid. */
    await expect(ledger.prepare('acct', { kind: 'sealPayKey', wrap: WRAP, commitment: COMMIT, proposalId: null }))
      .rejects.toThrow(/not the one this company confirmed on chain/);
    await expect(ledger.prepare('acct', { kind: 'sealPayKey', wrap: WRAP.slice(0, 3), commitment: COMMIT, proposalId: null }))
      .rejects.toThrow(/four 32-byte entries/);
  });

  it('hands the circuit the four parts, the commitment and a zero proposal for a later copy', async () => {
    const { ledger, calls } = harness({ signerRoles: [[at, COMMIT]] });
    await ledger.sealPayKey('acct', WRAP, COMMIT, null, BY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.circuit).toBe('sealPayKey');
    expect((calls[0]!.args[0] as Uint8Array[]).map(toHex)).toEqual(WRAP);
    expect(toHex(calls[0]!.args[1] as Uint8Array)).toBe(COMMIT);
    expect(toHex(calls[0]!.args[2] as Uint8Array)).toBe('00'.repeat(32));
    expect(await ledger.payKeyCommitment('acct')).toBe(COMMIT);
  });

  it('finds one signer\'s sealed copy under the entries the contract derives from their key and this account', async () => {
    const address = 'ab'.repeat(32);
    const sk = new Uint8Array(32).fill(7);
    const keys = [0n, 1n, 2n, 3n].map(i => toHex(pureCircuits.payKeyWrapKeyOf(fromHex(address), sk, i)) as Hex);
    const { ledger } = harness({ address, signerRoles: keys.map((k, i) => [k, WRAP[i]!] as [Hex, Hex]) });
    /* RED WHEN the entries are looked up under any derivation but the contract's own. */
    expect(await ledger.sealedPayKeyOf('acct', toHex(sk) as Hex)).toEqual(WRAP);
    expect(await ledger.sealedPayKeyOf('acct', toHex(new Uint8Array(32).fill(8)) as Hex)).toBeNull();
  });

  it('reads which nonces the account records as paid, and the device\'s check from them', async () => {
    const key = '3c'.repeat(32) as Hex;
    const { payRecordNonceOf } = await import('./run-keys.js');
    const r = { person: 'emp_ada', month: '2026-09', kind: 'salary', occurrence: 0 };
    const paid = payRecordNonceOf(key, r);
    const { ledger } = harness({ movementValues: [toHex(pureCircuits.paidOnceOf(fromHex(paid))) as Hex] });
    const other = payRecordNonceOf(key, { ...r, person: 'emp_bo' });
    /* RED WHEN the read tests anything but the contract's own `paidOnceOf` of each nonce. */
    expect(await ledger.paidOnceAmong('acct', [paid, other])).toEqual({ known: true, paid: [paid] });
    const [ada, bo] = (await ledger.alreadyPaid('acct', key, [{ ...r, occurrence: 0 }, { ...r, person: 'emp_bo' }]))!;
    expect(ada!.paid).toEqual([0]);
    expect(ada!.refused).toBe(true);
    expect(bo!.paid).toEqual([]);
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────
 * A VAULT'S SPENDING POLICY: SETTING ONE, AND CHARGING A RUN TO ITS PERIOD.
 * Both calls stopped before the chain, with every argument put in the slot the
 * compiled artifact names for it, and what the circuit reads from private state
 * staged on this device.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe('a spending policy, set and charged through the client', () => {
  const POLICY = {
    terms: {
      bands: [1n, 2n, 3n, 4n].map((n) => ({ ceiling: n * 1_000n, approvals: n })),
      periodLimit: 50_000n, periodStart: 1_799_000_000n, periodLength: 2_592_000n,
    },
    blinding: new Uint8Array(32).fill(0x6c),
  };
  const VAULT = 'a7'.repeat(32) as Hex;
  const RUN = {
    root: 'b1'.repeat(32) as Hex, payees: 3n, opensAt: 1_800_000_000n, closesAt: 1_800_003_600n,
    vault: VAULT, required: 2n,
  };
  const slotsOf = async (circuit: string) => {
    const { readFileSync } = await import('node:fs');
    const info = JSON.parse(readFileSync(`${CFG.zkConfigPath}/compiler/contract-info.json`, 'utf8'));
    return (info.circuits.find((c: { name: string }) => c.name === circuit).arguments as Array<{ name: string }>)
      .map((a) => a.name);
  };

  it('setPolicy: the vault, the commitment and the proposal, in the slots the contract names, with the token and the policy staged', async () => {
    const { ledger, staged } = harness({});
    const commitment = policyCommitmentOf(POLICY);
    const call = await ledger.prepare('acct', { kind: 'setPolicy', vault: VAULT, asset: TEST_TOKEN, policy: POLICY, proposalId: PROPOSAL_ID });
    expect(call.circuit).toBe('setPolicy');
    const slots = await slotsOf('setPolicy');
    /* RED WHEN two arguments are swapped, or one is missing. */
    expect(slots).toEqual(['vault', 'commitment', 'proposal']);
    expect([argHex(call.args[0]), argHex(call.args[1]), argHex(call.args[2])]).toEqual([VAULT, commitment, PROPOSAL_ID]);
    /* RED WHEN the token the policy is for is not staged: the circuit derives the policy's key from it. */
    expect(staged.at(-1)?.value.assetId).toEqual(assetIdBytes(TEST_TOKEN));
    /* RED WHEN the policy is not staged: the circuit opens it to learn its highest band. */
    expect(staged.at(-1)?.value.policy).toEqual(POLICY);
  });

  it('setPolicy: refused before the fee when the proposal is not yet approved', async () => {
    const { ledger } = harness({ approvals: 1n, threshold: 2n });
    /* RED WHEN the client stops asking whether the proposal is approved. */
    await expect(ledger.prepare('acct', {
      kind: 'setPolicy', vault: VAULT, asset: TEST_TOKEN, policy: POLICY, proposalId: PROPOSAL_ID,
    })).rejects.toThrow(/that proposal has 1 of 2 approvals/);
  });

  describe('a change of who is seated, a policy change and a change to its bar are checked at the bar, as the chain checks them', () => {
    const LEAF = 'b1'.repeat(32) as Hex;
    const OTHER_LEAF = 'b2'.repeat(32) as Hex;
    const steps = [
      { kind: 'reseatSigner' as const, oldLeaf: LEAF, newLeaf: OTHER_LEAF, proposalId: PROPOSAL_ID },
      { kind: 'removeSigner' as const, removedLeaf: LEAF, proposalId: PROPOSAL_ID },
      { kind: 'setPolicyBar' as const, newBar: 2, proposalId: PROPOSAL_ID },
      { kind: 'setPolicy' as const, vault: VAULT, asset: TEST_TOKEN, policy: POLICY, proposalId: PROPOSAL_ID },
    ];
    for (const step of steps) {
      it(`${step.kind}: refused below a bar above the threshold, naming the number it needs, and built at it`, async () => {
        const short = harness({ approvals: 2n, threshold: 2n, signerCount: 4n, vaultThresholds: [[policyBarKey(), 3n]] });
        /* RED WHEN the device compares with the account threshold alone: two of a threshold of two would pass, and the chain refuse. */
        await expect(short.ledger.prepare('acct', step)).rejects.toThrow(/that proposal has 2 of 3 approvals\. It needs as many as a policy change needs \(3\)/);
        expect(short.calls).toHaveLength(0);
        const met = harness({ approvals: 3n, threshold: 2n, signerCount: 4n, vaultThresholds: [[policyBarKey(), 3n]] });
        /* At the bar it passes the check. */
        const reached = await met.ledger.prepare('acct', step).then(() => 'built', (e: unknown) => String(e));
        expect(reached).toBe('built');
      });
    }

    it('removeSigner: refused when it would leave fewer signers than a policy change needs', async () => {
      const { ledger, calls } = harness({ approvals: 3n, threshold: 2n, signerCount: 3n, vaultThresholds: [[policyBarKey(), 3n]] });
      /* RED WHEN the device checks a removal against the threshold's floor alone, as the chain does not. */
      await expect(ledger.prepare('acct', steps[1]!)).rejects.toThrow(/that would leave 2 signers when a policy change needs 3/);
      expect(calls).toHaveLength(0);
    });

    it('setPolicy: refused before the fee on a vault the company does not hold', async () => {
      const { ledger, calls } = harness({ heldVaults: [] });
      /* RED WHEN the device stops reading the vaults before a policy: the chain refuses it after the fee. */
      await expect(ledger.prepare('acct', steps[3]!)).rejects.toThrow(/that is not a vault this company holds; adopt the vault first/);
      expect(calls).toHaveLength(0);
      await expect(harness({ heldVaults: [VAULT] }).ledger.prepare('acct', steps[3]!)).resolves.toBeDefined();
    });

    it("a governance step is refused at its bar when raised, and when a signer was removed since", async () => {
      const step = { kind: 'setThreshold' as const, newThreshold: 2, proposalId: PROPOSAL_ID };
      const high = harness({ approvals: 2n, threshold: 2n, holds: [[PROPOSAL_ID, { needed: 3n, removals: 0n }]] });
      /* RED WHEN the device compares with today's threshold alone: a proposal raised needing three passes at two. */
      await expect(high.ledger.prepare('acct', step)).rejects.toThrow(/that proposal has 2 of 3 approvals/);
      const stale = harness({ removalsSoFar: 1n, holds: [[PROPOSAL_ID, { needed: 0n, removals: 0n }]] });
      /* RED WHEN the device ignores a removal since the proposal was raised, which the chain refuses. */
      await expect(stale.ledger.prepare('acct', step)).rejects.toThrow(/1 signer removal\(s\) or re-seat\(s\) since this was raised/);
      expect([...high.calls, ...stale.calls]).toHaveLength(0);
      /* RED WHEN the steps checked at the seat bar skip those two questions, which their circuits ask first. */
      const reseatStale = harness({ approvals: 3n, signerCount: 4n, removalsSoFar: 1n, holds: [[PROPOSAL_ID, { needed: 0n, removals: 0n }]] });
      await expect(reseatStale.ledger.prepare('acct', steps[0]!)).rejects.toThrow(/1 signer removal\(s\) or re-seat\(s\) since this was raised/);
    });

    it('setPolicyBar: refused above the signers, naming both numbers', async () => {
      const { ledger } = harness({ approvals: 3n, threshold: 2n, signerCount: 3n });
      /* RED WHEN the device stops comparing the new bar with the signers, as the circuit does. */
      await expect(ledger.prepare('acct', { kind: 'setPolicyBar', newBar: 4, proposalId: PROPOSAL_ID }))
        .rejects.toThrow(/a policy change cannot need 4 approvals when the company has 3 signers/);
    });

    it('setVaultThreshold: refused on the company-wide marker, on the policy bar\'s key, and above the bar on bytes the company does not hold', async () => {
      const set = (vault: Hex, n: number) => ({ kind: 'setVaultThreshold' as const, vault, newThreshold: n, proposalId: PROPOSAL_ID });
      const at = (held: Hex[]) => harness({ approvals: 3n, threshold: 2n, signerCount: 4n, heldVaults: held, vaultThresholds: [[policyBarKey(), 3n]] }).ledger;
      /* RED WHEN either key is let through to the chain, which refuses both. */
      await expect(at([]).prepare('acct', set(toHex(pureCircuits.companyWide()) as Hex, 2))).rejects.toThrow(/the company-wide decision always takes the account's threshold/);
      await expect(at([]).prepare('acct', set(policyBarKey(), 2))).rejects.toThrow(/that is not a vault; to change the approvals a policy change needs/);
      /* RED WHEN bytes no vault holds may raise the bar on the device. */
      await expect(at([]).prepare('acct', set(VAULT, 4))).rejects.toThrow(/that is not a vault this company holds, so its threshold cannot exceed 3/);
      /* At the bar, or once held, it is built. */
      await expect(at([]).prepare('acct', set(VAULT, 3))).resolves.toBeDefined();
      await expect(at([VAULT]).prepare('acct', set(VAULT, 4))).resolves.toBeDefined();
    });

    it('with no bar stored, the threshold rules', async () => {
      const { ledger } = harness({ approvals: 1n, threshold: 2n });
      /* RED WHEN the bar is the stored number alone, read as zero while none is stored: one approval would pass. */
      await expect(ledger.prepare('acct', steps[0]!)).rejects.toThrow(/that proposal has 1 of 2 approvals/);
    });

    it("setVaultThreshold: refused above the signers, past the bar, or lowering a vault, short of the bar; up to the bar at the threshold", async () => {
      const at = (vt: Array<[Hex, bigint]>, approvals = 2n, signerCount = 4n) =>
        harness({ approvals, threshold: 2n, signerCount, vaultThresholds: vt }).ledger;
      const set = (n: number) => ({ kind: 'setVaultThreshold' as const, vault: VAULT, newThreshold: n, proposalId: PROPOSAL_ID });
      /* RED WHEN the device stops comparing a vault threshold with the signers seated, as the circuit does. */
      await expect(at([], 4n, 3n).prepare('acct', set(4))).rejects.toThrow(/a vault cannot need 4 approvals when the company has 3 signers/);
      /* RED WHEN raising a vault past the bar is checked at the threshold alone. */
      await expect(at([[policyBarKey(), 3n]]).prepare('acct', set(4))).rejects.toThrow(/that proposal has 2 of 3 approvals/);
      /* RED WHEN lowering a vault is checked at the threshold alone. */
      await expect(at([[policyBarKey(), 3n], [VAULT, 3n]]).prepare('acct', set(2))).rejects.toThrow(/that proposal has 2 of 3 approvals/);
      /* RED WHEN an unset vault is not read at the account's threshold: setting it to one lowers it. */
      await expect(at([[policyBarKey(), 3n]]).prepare('acct', set(1))).rejects.toThrow(/that proposal has 2 of 3 approvals/);
      /* Up to the bar, and not below the vault, the threshold is enough. */
      await expect(at([[policyBarKey(), 3n]]).prepare('acct', set(3))).resolves.toBeDefined();
      await expect(at([[policyBarKey(), 3n], [VAULT, 3n]], 3n).prepare('acct', set(2))).resolves.toBeDefined();
    });
  });

  /** The fresh half of a run's salt. */
  const FRESH = 'f1'.repeat(32);

  it("clearRun: the run's parts, its tree and its period in the slots the contract names, and the policy staged", async () => {
    const { ledger, staged } = harness({});
    const step = {
      kind: 'clearRun' as const, proposalId: PROPOSAL_ID, run: RUN, salt: CHANGE.salt, fresh: FRESH, asset: TEST_TOKEN,
      top: 77n, total: 4_321n, period: 0n, policy: POLICY, spent: 1_234n,
    };
    const call = await ledger.prepare('acct', step);
    expect(call.circuit).toBe('clearRun');
    const slots = await slotsOf('clearRun');
    const at = (name: string) => call.args[slots.indexOf(name)];
    /* RED WHEN any argument lands in another's slot: the compiler cannot see a swap among these. */
    expect(argHex(at('proposal'))).toBe(PROPOSAL_ID);
    expect(argHex(at('vault'))).toBe(VAULT);
    expect(argHex(at('root'))).toBe(RUN.root);
    expect([at('payees'), at('opensAt'), at('closesAt'), at('required')]).toEqual([3n, RUN.opensAt, RUN.closesAt, 2n]);
    expect(argHex(at('salt'))).toBe(CHANGE.salt);
    expect([at('top'), at('total'), at('period')]).toEqual([77n, 4_321n, 0n]);
    /* A run of its own: no leg, and the fresh half of its salt. RED WHEN the service charges a run with another fresh salt, or names a leg. */
    expect(argHex(at('fresh'))).toBe(FRESH);
    expect(argHex(at('leg'))).toBe('00'.repeat(32));
    expect(call.args).toHaveLength(slots.length);
    /* RED WHEN the policy's opening, what the period has been charged, or the token is not staged. */
    expect(staged.at(-1)?.value).toMatchObject({ policy: POLICY, periodSpent: 1_234n, assetId: assetIdBytes(TEST_TOKEN) });
  });

  it("clearRun: refused before anything is staged when the run's window leaves the period named", async () => {
    const { ledger, staged } = harness({});
    const before = staged.length;
    /* RED WHEN the client stops comparing the window with the period before a fee. */
    await expect(ledger.prepare('acct', {
      kind: 'clearRun', proposalId: PROPOSAL_ID, run: { ...RUN, closesAt: 1_801_592_001n }, salt: CHANGE.salt, fresh: FRESH,
      asset: TEST_TOKEN, top: 1n, total: 1n, period: 0n, policy: POLICY, spent: 0n,
    })).rejects.toThrow(/does not lie inside the period 2027-01-03 to 2027-02-02/);
    /* RED WHEN the client stops comparing the window's start with the period's. */
    await expect(ledger.prepare('acct', {
      kind: 'clearRun', proposalId: PROPOSAL_ID, run: { ...RUN, opensAt: 1_798_999_999n }, salt: CHANGE.salt, fresh: FRESH,
      asset: TEST_TOKEN, top: 1n, total: 1n, period: 0n, policy: POLICY, spent: 0n,
    })).rejects.toThrow(/does not lie inside the period/);
    /* RED WHEN the client reads a later period's start as the first period's: this window lies in period 0. */
    await expect(ledger.prepare('acct', {
      kind: 'clearRun', proposalId: PROPOSAL_ID, run: RUN, salt: CHANGE.salt, fresh: FRESH,
      asset: TEST_TOKEN, top: 1n, total: 1n, period: 1n, policy: POLICY, spent: 0n,
    })).rejects.toThrow(/does not lie inside the period 2027-02-02 to 2027-03-04/);
    expect(staged.length).toBe(before);
  });
});
