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
  adoptionRoundOf, firstSecretRunCarriedOf, secretRunOf, secretRunProposalOf, startStandingOf,
  type AccountLedgerForAStart, type VaultLedgerForAStart,
} from './vault-start.js';
import { secretRunWindowFrom } from './secret-run-window.js';
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
const vaultLedger = (entries: Array<[Uint8Array, Uint8Array]> = [], commitment: Uint8Array = new Uint8Array(32)): VaultLedgerForAStart => {
  const m = new Map(entries.map(([k, v]) => [key(k), v]));
  return { nonceCommitment: commitment, secretCopies: { member: (k) => m.has(key(k)), lookup: (k) => m.get(key(k))! } };
};

describe('A VAULT\'S START', () => {
  const run = secretRunOf(circuits, { vault: VAULT, secret: SECRET, readers: [B.publicKey, A.publicKey, A.publicKey] });

  it('IS MADE THE SAME WAY EVERY TIME, FROM THE SECRET AND ITS READERS, WHATEVER ORDER THE READERS ARE GIVEN IN', () => {
    /* RED WHEN: a start run again makes another run than the one its signers approved. */
    expect(secretRunOf(circuits, { vault: VAULT, secret: SECRET, readers: [A.publicKey, B.publicKey] })).toEqual(run);
    expect(run.copies.map((c) => c.reader)).toEqual([A.publicKey, B.publicKey].sort());
    expect(run.count).toBe(2n);
    /* Every reader's copy opens to the secret with their own records key. */
    for (const r of [A, B]) {
      const copy = run.copies.find((c) => c.reader === r.publicKey)!;
      expect(openSecretCopy({ vault: VAULT, parts: copy.parts.map(fromHex), reader: r })).toBe(SECRET);
    }
    /* RED WHEN: another secret makes the same run - its identity would say nothing about which secret was approved. */
    expect(secretRunOf(circuits, { vault: VAULT, secret: '5f'.repeat(31) + '00', readers: [A.publicKey] }).salt).not.toBe(run.salt);
  });

  it('CARRIES THE EDGE THE VAULT CHECKS, and refuses a secret the vault would refuse, before anything is built', () => {
    /* RED WHEN the run's edge is not the path to the first place past its copies: the vault would refuse the run. */
    expect(V.emptyFrom(fromHex(run.copiesRoot), run.count, run.edge as never)).toBe(true);
    expect(V.emptyFrom(fromHex(run.copiesRoot), run.count - 1n, run.edge as never)).toBe(false);
    /* RED WHEN a secret whose last byte is not zero is made into a run: the vault would refuse it after the approvals. */
    expect(() => secretRunOf(circuits, { vault: VAULT, secret: '5e'.repeat(32), readers: [A.publicKey] }))
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

  it("SAYS WHETHER THIS SEAT'S APPROVAL IS ON THE CHAIN FOR EACH ROUND OF THE START, ASKED BY THAT ROUND'S OWN IDENTITY", () => {
    const round = adoptionRoundOf(P as never, VAULT);
    const window = secretRunWindowFrom(10_000n);
    const id = secretRunProposalOf(P as never, run, window);
    const read = (approved: string[]) => startStandingOf(circuits, {
      vault: VAULT, now: 10_000n, vaultLedger: vaultLedger(), run, approvedHere: (asked) => approved.includes(key(asked)),
      account: accountLedger({
        threshold: 2n, vaultBars: { [VAULT]: 2n },
        open: { [round.proposal]: { approvals: 1n, needed: 2n }, [id]: { approvals: 1n, needed: 2n } }, windows: [[id, window]],
      }),
    });
    /* RED WHEN: a round is asked about by another round's identity - this seat's raise of the adoption then reads as its approval of the run. */
    expect([read([round.proposal]).adoption.approvedHere, read([round.proposal]).secret?.run?.approvedHere]).toEqual([true, false]);
    expect([read([id]).adoption.approvedHere, read([id]).secret?.run?.approvedHere]).toEqual([false, true]);
    /* Read with no seat, nothing is said of any seat's approval. */
    expect('approvedHere' in startStandingOf(circuits, { vault: VAULT, now: 1n, vaultLedger: vaultLedger(), account: accountLedger() }).adoption).toBe(false);
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

  it('IS FOUND AGAIN FROM ITS PUBLIC PARTS ONCE ITS SECRET IS SET, AND ITS ROOT IS MADE AGAIN ONLY UNDER THE SECRET IT SETS', () => {
    const window = secretRunWindowFrom(10_000n);
    const parts = {
      root: run.root, opensAt: String(window.opensAt), closesAt: String(window.closesAt), salt: run.salt, nonce: run.nonce,
      copiesRoot: run.copiesRoot, count: String(run.count),
    };
    const found = firstSecretRunCarriedOf(circuits, VAULT, parts);
    /* RED WHEN: the run made again from its parts is not the run the chain holds, so a service could not tell which run set the secret. */
    expect(found.proposal).toBe(secretRunProposalOf(P as never, run, window));
    expect(found.payload).toBe(toHex(P.runPayload(fromHex(run.root), 1n, window.opensAt, window.closesAt, 0n)));
    /* RED WHEN: the root is made without the commitment of the secret the run sets, so any run of the vault would pass for this one. */
    expect(found.rootUnder(run.commitment)).toBe(run.root);
    expect(found.rootUnder('77'.repeat(32))).not.toBe(run.root);
    /* RED WHEN: the run's identity leaves out the vault it is for, so another vault's run passes for it. */
    expect(firstSecretRunCarriedOf(circuits, 'cd'.repeat(32), parts).proposal).not.toBe(found.proposal);
    /* RED WHEN: a part that is not one is taken, and a run is made from it. */
    expect(() => firstSecretRunCarriedOf(circuits, VAULT, { ...parts, count: '-1' })).toThrow(/not the public parts/u);
    expect(() => firstSecretRunCarriedOf(circuits, VAULT, { ...parts, nonce: 'zz' })).toThrow(/not the public parts/u);
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

  describe('A SECRET RUN REPLACING THE VAULT\'S SECRET', () => {
    const HELD = '9c'.repeat(32);
    const NEXT = '6e'.repeat(31) + '00';
    const replacing = secretRunOf(circuits, { vault: VAULT, secret: NEXT, readers: [A.publicKey, B.publicKey], previous: HELD });

    it('IS MADE OVER THE COMMITMENT THE VAULT HOLDS, SO IT IS ANOTHER RUN THAN THE SAME SECRET AS A FIRST, AND IS NOT READ AS ANOTHER SECRET', () => {
      /* RED WHEN: the run's leaf binds zero whatever it replaces, as the first secret's does: the vault refuses it (that run replaces a secret this vault no longer holds). */
      expect(replacing.previous).toBe(HELD);
      expect(replacing.details).not.toBe(secretRunOf(circuits, { vault: VAULT, secret: NEXT, readers: [A.publicKey, B.publicKey] }).details);
      expect(() => secretRunOf(circuits, { vault: VAULT, secret: NEXT, readers: [A.publicKey], previous: 'zz' })).toThrow(/the commitment a secret run replaces/u);
      const read = startStandingOf(circuits, { vault: VAULT, account: accountLedger({ vaults: [VAULT] }), vaultLedger: vaultLedger([], fromHex(HELD)), run: replacing, now: 1n });
      /* RED WHEN: the vault holding the very secret the run replaces is read as holding another, so no replacement is ever approved. */
      expect(read.secret).toMatchObject({ set: false, another: false, held: HELD });
      const parts = {
        root: replacing.root, opensAt: '1', closesAt: '2', salt: replacing.salt, nonce: replacing.nonce,
        copiesRoot: replacing.copiesRoot, count: String(replacing.count), previous: HELD,
      };
      /* RED WHEN: the run made again from its public parts drops the commitment it replaced, so the service cannot write it down. */
      expect(firstSecretRunCarriedOf(circuits, VAULT, parts).rootUnder(replacing.commitment)).toBe(replacing.root);
    });

    it('FINDS THE SECRET IT MUST CARRY: THE ONE THE VAULT LAST HAD EVERY COPY WRITTEN FOR, AMONG THOSE THIS DEVICE HOLDS', () => {
      const oldest = '1a'.repeat(31) + '00';
      const last = '2b'.repeat(31) + '00';
      const written = V.secretCommitmentOf(fromHex(VAULT), fromHex(last));
      const ledger = vaultLedger([[V.copiesWrittenKey(), written]], fromHex(HELD));
      const read = (earlier: string[]) => startStandingOf(circuits, { vault: VAULT, account: accountLedger({ vaults: [VAULT] }), vaultLedger: ledger, run: replacing, now: 1n, earlier }).secret?.earlier;
      /* RED WHEN: the newest secret held is passed as the earlier one, which is not always the one whose copies were last all written. */
      expect(read([oldest, last, NEXT])).toEqual({ secret: last });
      /* RED WHEN: a device holding none of them builds the call anyway, which the vault refuses. */
      expect(read([oldest])).toEqual({ unheld: true });
      /* RED WHEN: a vault no secret's copies were all written for is asked to carry one. */
      expect(startStandingOf(circuits, { vault: VAULT, account: accountLedger({ vaults: [VAULT] }), vaultLedger: vaultLedger(), run: replacing, now: 1n, earlier: [oldest] }).secret?.earlier).toBeNull();
    });

    it('WITH TWO RUNS OF ONE SECRET OPEN, READS THE ONE UNDER THE WINDOW IT IS ASKED ABOUT, WHICHEVER THE LEDGER LISTS FIRST', () => {
      const w1 = { opensAt: 0n, closesAt: 99_999n };
      const w2 = secretRunWindowFrom(10_000n, true);
      const id1 = secretRunProposalOf(P as never, replacing, w1);
      const id2 = secretRunProposalOf(P as never, replacing, w2);
      for (const windows of [[[id1, w1], [id2, w2]], [[id2, w2], [id1, w1]]] as Array<Array<[string, { opensAt: bigint; closesAt: bigint }]>>) {
        const account = accountLedger({ vaults: [VAULT], open: { [id1]: { approvals: 1n, needed: 1n, removals: 0n }, [id2]: { approvals: 1n, needed: 1n, removals: 1n } }, windows, removals: 1n });
        const read = (window?: { opensAt: bigint; closesAt: bigint }) => startStandingOf(circuits, {
          vault: VAULT, account, vaultLedger: vaultLedger([], fromHex(HELD)), run: replacing, now: 10_000n, ...(window === undefined ? {} : { window }),
        }).secret?.run;
        /* RED WHEN: the run the ledger lists first is reported whatever window the read names, so the run raised before the removal is approved or carried. */
        expect(read(w2)).toMatchObject({ proposal: id2, beforeARemoval: false });
        expect(read(w1)).toMatchObject({ proposal: id1, beforeARemoval: true });
      }
    });

    it('LISTS EVERY IDENTITY THE ACCOUNT HOLDS THE RUN UNDER, AND READS ONE RAISED BEFORE A REMOVAL AS SUCH', () => {
      const w1 = { opensAt: 0n, closesAt: 5n };
      const w2 = secretRunWindowFrom(10_000n, true);
      const id1 = secretRunProposalOf(P as never, replacing, w1);
      const id2 = secretRunProposalOf(P as never, replacing, w2);
      const account = accountLedger({ vaults: [VAULT], open: { [id2]: { approvals: 1n, needed: 1n, removals: 0n } }, windows: [[id1, w1], [id2, w2]], removals: 1n });
      const read = startStandingOf(circuits, { vault: VAULT, account, vaultLedger: vaultLedger([], fromHex(HELD)), run: replacing, now: 10_000n });
      /* RED WHEN: only the run reported is looked for, so a landed run over another window is called dead. */
      expect(read.secret?.landed).toEqual([id1, id2]);
      expect(read.secret?.run).toMatchObject({ proposal: id2, inWindow: true });
      /* RED WHEN: a run raised at a removal count below the account's is read as raised after it. */
      expect(read.secret?.run?.beforeARemoval).toBe(true);
      /* RED WHEN: the account's count of removals is not read, so a device cannot tell a secret a leaver may open. */
      expect(read.removals).toBe(1);
      /* The window a replacement is raised with: open from just before now, for the day a raise is given to land in. */
      expect(w2).toEqual({ opensAt: 10_000n - 600n, closesAt: 10_000n + 86_400n });
      expect(secretRunWindowFrom(10_000n)).toEqual({ opensAt: 10_000n - 600n, closesAt: 10_000n + 14n * 86_400n });
    });
  });
});
