/**
 * **HOW FAR A VAULT'S START HAS GOT, READ OFF THE TWO LEDGERS, AND THE START
 * MADE THE SAME WAY EVERY TIME.** The ledgers are stood in by maps holding what
 * the contracts would write; the functions are the contracts' own. The whole
 * start against the ledger's own state machine is
 * `contracts/test/a-company-vault-from-the-page.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { pureCircuits as P } from '../../contracts/managed/contract/index.js';
import { pureCircuits as V } from '../../contracts/managed-vault/contract/index.js';
import { fromHex, toHex } from '../core/crypto.js';
import {
  adoptionRoundOf, firstSecretRunOf, secretRunProposalOf, startStandingOf, secretRunWindowFrom,
  type AccountLedgerForAStart, type VaultLedgerForAStart,
} from './vault-start.js';
import { openSecretCopy } from './sealed-secret-copy.js';
import { recordsKeypairFrom } from './company-nonce-secret.js';

const circuits = { vault: V as never, account: P as never };
const VAULT = 'ab'.repeat(32);
/* Thirty-one bytes and a zero, the only shape a vault's secret takes. */
const SECRET = '5e'.repeat(31) + '00';
const A = recordsKeypairFrom(new Uint8Array(32).fill(1));
const B = recordsKeypairFrom(new Uint8Array(32).fill(2));
const key = (b: Uint8Array) => toHex(b);

const accountLedger = (over: {
  threshold?: bigint; vaults?: string[]; open?: Record<string, { approvals: bigint; needed: bigint; removals?: bigint }>;
  windows?: Array<[string, { opensAt: bigint; closesAt: bigint }]>; removals?: bigint; vaultBars?: Record<string, bigint>;
} = {}): AccountLedgerForAStart => {
  const open = over.open ?? {};
  const holds = new Map<string, { needed: bigint; removals: bigint }>(
    Object.entries(open).map(([id, o]) => [id, { needed: o.needed, removals: o.removals ?? 0n }]));
  holds.set(key(P.removalCountKey()), { needed: 0n, removals: over.removals ?? 0n });
  return {
    threshold: over.threshold ?? 1n,
    vaults: { member: (v) => (over.vaults ?? []).includes(key(v)) },
    thresholds: { member: (v) => key(v) in (over.vaultBars ?? {}), lookup: (v) => over.vaultBars![key(v)]! },
    openProposals: { member: (id) => key(id) in open },
    approvalCounts: { member: (id) => key(id) in open, lookup: (id) => open[key(id)]!.approvals },
    proposalHolds: { member: (id) => holds.has(key(id)), lookup: (id) => holds.get(key(id))! },
    runWindow: (over.windows ?? []).map(([id, w]) => [fromHex(id), w] as [Uint8Array, { opensAt: bigint; closesAt: bigint }]),
  };
};
const vaultLedger = (entries: Array<[Uint8Array, Uint8Array]> = [], commitment = new Uint8Array(32)): VaultLedgerForAStart => {
  const m = new Map(entries.map(([k, v]) => [key(k), v]));
  return { nonceCommitment: commitment, secretCopies: { member: (k) => m.has(key(k)), lookup: (k) => m.get(key(k))! } };
};

describe('A VAULT\'S START', () => {
  const run = firstSecretRunOf(circuits, { vault: VAULT, secret: SECRET, readers: [B.publicKey, A.publicKey, A.publicKey] });

  it('IS MADE THE SAME WAY EVERY TIME, FROM THE SECRET AND ITS READERS, WHATEVER ORDER THE READERS ARE GIVEN IN', () => {
    /* RED WHEN: a start run again makes another run than the one its signers approved. */
    expect(firstSecretRunOf(circuits, { vault: VAULT, secret: SECRET, readers: [A.publicKey, B.publicKey] })).toEqual(run);
    expect(run.copies.map((c) => c.reader)).toEqual([A.publicKey, B.publicKey].sort());
    expect(run.count).toBe(2n);
    /* Every reader's copy opens to the secret with their own records key. */
    for (const r of [A, B]) {
      const copy = run.copies.find((c) => c.reader === r.publicKey)!;
      expect(openSecretCopy({ vault: VAULT, parts: copy.parts.map(fromHex), reader: r })).toBe(SECRET);
    }
    /* RED WHEN: another secret makes the same run - its identity would say nothing about which secret was approved. */
    expect(firstSecretRunOf(circuits, { vault: VAULT, secret: '5f'.repeat(31) + '00', readers: [A.publicKey] }).salt).not.toBe(run.salt);
  });

  it('CARRIES THE EDGE THE VAULT CHECKS, and refuses a secret the vault would refuse, before anything is built', () => {
    /* RED WHEN the run's edge is not the path to the first place past its copies: the vault would refuse the run. */
    expect(V.emptyFrom(fromHex(run.copiesRoot), run.count, run.edge as never)).toBe(true);
    expect(V.emptyFrom(fromHex(run.copiesRoot), run.count - 1n, run.edge as never)).toBe(false);
    /* RED WHEN a secret whose last byte is not zero is made into a run: the vault would refuse it after the approvals. */
    expect(() => firstSecretRunOf(circuits, { vault: VAULT, secret: '5e'.repeat(32), readers: [A.publicKey] }))
      .toThrow(/ends in a zero byte/);
  });

  it('READS AN ADOPTION NOT RAISED, RAISED AND SHORT OF APPROVALS, MADE STALE BY A REMOVAL, AND CARRIED OUT', () => {
    const round = adoptionRoundOf(P as never, VAULT);
    const now = 1_000n;
    const none = startStandingOf(circuits, { vault: VAULT, account: accountLedger(), vaultLedger: vaultLedger(), now });
    expect(none).toMatchObject({ adopted: false, adoption: { proposal: round.proposal, open: false } });
    const short = startStandingOf(circuits, {
      vault: VAULT, now, vaultLedger: vaultLedger(),
      account: accountLedger({ threshold: 2n, open: { [round.proposal]: { approvals: 1n, needed: 2n } } }),
    });
    /* RED WHEN: a round short of approvals is read as ready to carry out, or its bar is not the account's. */
    expect(short.adoption).toMatchObject({ open: true, approvals: 1, needed: 2, stale: false });
    const stale = startStandingOf(circuits, {
      vault: VAULT, now, vaultLedger: vaultLedger(),
      account: accountLedger({ removals: 1n, open: { [round.proposal]: { approvals: 1n, needed: 1n, removals: 0n } } }),
    });
    /* RED WHEN: a governance round raised before a removal is read as one that can still be carried out. */
    expect(stale.adoption.stale).toBe(true);
    expect(startStandingOf(circuits, { vault: VAULT, now, vaultLedger: vaultLedger(), account: accountLedger({ vaults: [VAULT] }) }).adopted).toBe(true);
  });

  it('FINDS THE SECRET RUN BY THE WINDOWS THE ACCOUNT HOLDS, AND SAYS WHETHER ITS WINDOW IS OPEN NOW', () => {
    const window = secretRunWindowFrom(10_000n);
    const id = secretRunProposalOf(P as never, run, window);
    const other = secretRunProposalOf(P as never, run, { opensAt: 1n, closesAt: 2n });
    const account = accountLedger({
      vaults: [VAULT], vaultBars: { [VAULT]: 2n },
      open: { [id]: { approvals: 1n, needed: 1n } },
      windows: [['77'.repeat(32), { opensAt: 0n, closesAt: 99_999n }], [id, window]],
    });
    const read = startStandingOf(circuits, { vault: VAULT, account, vaultLedger: vaultLedger(), run, now: 10_000n });
    /* RED WHEN: the run is not found again from the chain, or is approved at a bar that is not the vault's own. */
    expect(read.secret?.run).toMatchObject({ proposal: id, approvals: 1, needed: 2, inWindow: true });
    expect(startStandingOf(circuits, { vault: VAULT, account, vaultLedger: vaultLedger(), run, now: window.closesAt }).secret?.run?.inWindow).toBe(false);
    expect(other).not.toBe(id);
    expect(read.secret).toMatchObject({ set: false, another: false, started: false, written: [false, false] });
  });

  it('READS THE SECRET SET, EACH COPY WRITTEN, AND THE VAULT STARTED ONLY WHEN THE LAST COPY CLOSED ITS LIST', () => {
    const commitment = new Uint8Array(fromHex(run.commitment));
    const rootKey = V.copiesRootKeyOf(commitment);
    const first = V.copyKeyOf(commitment, new Uint8Array(fromHex(run.copies[0]!.reader)), 0n, 0n);
    const second = V.copyKeyOf(commitment, new Uint8Array(fromHex(run.copies[1]!.reader)), 1n, 0n);
    const account = accountLedger({ vaults: [VAULT] });
    const set = startStandingOf(circuits, {
      vault: VAULT, account, run, now: 1n,
      vaultLedger: vaultLedger([[rootKey, fromHex(run.copiesRoot)], [first, new Uint8Array(32)]], commitment),
    });
    /* RED WHEN: a vault with a copy still to write is read as started. */
    expect(set.secret).toMatchObject({ set: true, rootIsThisRuns: true, written: [true, false], started: false });
    const all = startStandingOf(circuits, {
      vault: VAULT, account, run, now: 1n,
      vaultLedger: vaultLedger([[rootKey, fromHex(run.copiesRoot)], [first, new Uint8Array(32)], [second, new Uint8Array(32)],
        [V.copiesWrittenKey(), commitment]], commitment),
    });
    expect(all.secret).toMatchObject({ written: [true, true], started: true });
    /* RED WHEN: a vault holding another secret is read as one whose first secret is still to set. */
    const another = startStandingOf(circuits, { vault: VAULT, account, run, now: 1n, vaultLedger: vaultLedger([], new Uint8Array(32).fill(9)) });
    expect(another.secret).toMatchObject({ set: false, another: true });
  });
});
