/**
 * **A VAULT'S RETIRE, RAISED, APPROVED AND CARRIED OUT FROM A DEVICE.** The company's records are kept as the service
 * keeps them and sealed for real; the proposal's identity is made by the account's own functions; the chain is a map of
 * where each proposal stands and what the vault holds, moved by what the device sends.
 */
import { describe, it, expect } from 'vitest';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import type { Hex } from '../../../src/core/crypto.js';
import { sealTransferProposal, signProposalFiling } from '../../../src/core/proposal-filing.js';
import type { SealedProposal } from '../../../src/core/types.js';
import { identityOfAChange, type RoundOnChain } from './governed-call-builder.js';
import { proposalsKeptInATest } from './a-vaults-start-proposals.test-support.js';
import { adoptionRoundOf } from '../../../src/midnight/vault-start.js';
import {
  approveRetireHere,
  carryRetireHere,
  retiredBy,
  retireFoundHere,
  retireGivesUpHere,
  retireRaisedHere,
  type RetireDoors
} from './vault-retire-round.js';

const VAULT = 'ab'.repeat(32) as Hex;
const OTHER_VAULT = 'cd'.repeat(32) as Hex;
const ACCOUNT = 'ac'.repeat(32);
const SEAT = '0b'.repeat(32) as Hex;

const TOKEN = '01'.repeat(32);

/** A one-off's record as the raising seat files it, naming the vault it pays from, under its identity on the chain. */
const aRunRecord = (vault: Hex, chainId: string, n: number, viewingKey = '44'.repeat(32) as Hex): SealedProposal => {
  const sealed = sealTransferProposal({
    accountId: 'acc_1',
    viewingKey,
    vault,
    summary: 'Pay once',
    oneOff: { id: `one_${n}`, version: 1 },
    change: { asset: '00'.repeat(32), amount: 1n, batchDigest: '00'.repeat(32) as Hex, salt: '11'.repeat(32) as Hex },
    proposedBy: 'ada'
  });
  const filed = signProposalFiling(
    'acc_1',
    {
      id: `prp_run${String(n).padStart(9, '0')}`,
      digest: 'dd'.repeat(32) as Hex,
      chainId: chainId as Hex,
      keyEpoch: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
      sealed
    },
    SEAT
  );
  return { ...filed, accountId: 'acc_1', status: 'open', approvalCount: 0 } as SealedProposal;
};

const aCompany = (
  over: {
    readonly needed?: number;
    readonly notes?: string[];
    readonly publicMoney?: boolean;
    readonly depositOnItsWay?: boolean;
    readonly paymentOnItsWay?: boolean;
    readonly readFails?: boolean;
    readonly proves?: (circuit: string) => boolean;
  } = {}
) => {
  const rounds = new Map<string, RoundOnChain>();
  const sent: string[] = [];
  const chain = {
    notes: over.notes ?? [],
    publicBalances: over.publicMoney === true ? [{ token: TOKEN, amount: '5' }] : [{ token: TOKEN, amount: '0' }],
    readFails: over.readFails === true,
    openRuns: [] as string[]
  };
  const kept = proposalsKeptInATest({
    signingSecret: SEAT,
    onRaise: (chainId) => {
      rounds.set(chainId, { held: 'open', approvals: 1, needed: over.needed ?? 2, approvedHere: true });
    }
  });
  const made = { salt: (s: string) => s };
  const builder = {
    proposalIdentity: async (change: never, salt: string) =>
      identityOfAChange({ accountPure: pureCircuits as never }, change, made.salt(salt)),
    roundsOnChain: async (i: { chainIds: readonly string[] }) =>
      Object.fromEntries(i.chainIds.map((id) => [id, rounds.get(id) ?? { held: 'never', approvals: 0 }])),
    runsOutrun: async () => {
      if (chain.readFails) throw new Error('the indexer did not answer');
      return Object.fromEntries(chain.openRuns.map((id) => [id, 0]));
    },
    vaultOnChain: async () => {
      if (chain.readFails) throw new Error('the indexer did not answer');
      return {
        onChain: true,
        state: 's',
        notes: chain.notes,
        publicBalances: chain.publicBalances,
        notesFromThisBuild: true,
        everCreated: [],
        account: ACCOUNT,
        started: true,
        retired: false
      };
    },
    governedCall: async (i: { order: { circuit: string } }) => {
      sent.push(`build ${i.order.circuit}`);
      return { tx: i.order.circuit.toUpperCase() };
    },
    chainAtOneBlock: async () => ({
      blockHash: 'bh',
      vaultState: 'vs',
      zswapState: 'zs',
      parameters: 'pp',
      accountState: 'as'
    }),
    retire: async (i: { vault: string; account: string; proposal: string; salt: string }) => {
      sent.push(`build retire ${i.vault === VAULT && i.account === ACCOUNT}`);
      return { tx: `RETIRE ${i.proposal} ${i.salt}` };
    }
  };
  const toChain = async (tx: string, call: { kind: string; contract: string; circuit: string }) => {
    sent.push(`to the chain ${call.kind} ${call.contract === VAULT} ${call.circuit}`);
    const [, id] = tx.split(' ');
    rounds.set(id!, { ...rounds.get(id!)!, held: 'closed', closedBy: ['retireVault'] });
    (doors as { sentTx?: string }).sentTx = tx;
  };
  const doors = {
    ...(over.proves === undefined ? {} : { proves: over.proves }),
    sleep: async () => {},
    waitMs: 3,
    everyMs: 1,
    account: ACCOUNT,
    builder,
    proposals: kept.doors,
    me: { signerId: 'ada' },
    material: { signingSecret: SEAT },
    indexer: async () => ({ indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' }),
    handOver: {
      path: 'service',
      fallback: {
        toChain,
        fellBack: () => {},
        taken: () => false
      }
    },
    approveSent: async (id: string) => {
      sent.push(`approve ${id}`);
      const rec = kept.kept.find((r) => r.id === id)!;
      const r = rounds.get(rec.chainId)!;
      rounds.set(rec.chainId, { ...r, approvals: r.approvals + 1, approvedHere: true });
    },
    closedSent: async (id: string) => {
      sent.push(`written down ${id}`);
    },
    inFlight: {
      deposits: { get: async () => (over.depositOnItsWay === true ? {} : null) },
      payments: { get: async () => (over.paymentOnItsWay === true ? {} : null) }
    }
  } as unknown as RetireDoors & { sentTx?: string };
  return { doors, rounds, sent, kept, chain, made };
};

const NOTHING = { notes: 'none', public: 'none' };

describe('A VAULT RETIRED FROM THE DEVICE', () => {
  it('a vault holding money is raised and carried all the same', async () => {
    const cases: Array<{ notes?: string[]; publicMoney?: boolean }> = [
      { notes: ['n1'] },
      { publicMoney: true },
      { notes: ['n1'], publicMoney: true }
    ];
    for (const over of cases) {
      const c = aCompany({ ...over, needed: 1 });
      /* RED WHEN: a retire is refused for money the vault holds, so anyone who pays a vault one token can block its retirement. */
      const { found } = await retireRaisedHere(c.doors, VAULT);
      /* RED WHEN: the carrying out refuses on holdings. */
      expect(await carryRetireHere(c.doors, { vault: VAULT, proposal: found.rec.id })).toEqual({
        state: 'carried-out',
        said: null
      });
      expect(c.sent.filter((x) => x.startsWith('to the chain'))).toEqual(['to the chain vault-retire true retire']);
    }
  });

  it("an approver is shown what the retire gives up, read on their own device: the vault's holdings and the runs open on it", async () => {
    const c = aCompany({ notes: ['n1'] });
    c.kept.kept.push(
      aRunRecord(VAULT, '0a'.repeat(32), 1),
      aRunRecord(VAULT, '0b'.repeat(32), 2),
      aRunRecord(OTHER_VAULT, '0c'.repeat(32), 3)
    );
    c.chain.openRuns = ['0a'.repeat(32), '0c'.repeat(32)];
    /* RED WHEN: a run closed on the chain, or a run of another vault, is counted among this vault's, or an open one of this vault is not. */
    expect(await retireGivesUpHere(c.doors, VAULT)).toEqual({ money: { notes: 'holds', public: 'none' }, openRuns: 1 });
    c.chain.notes = [];
    c.chain.openRuns = [];
    expect(await retireGivesUpHere(c.doors, VAULT)).toEqual({ money: NOTHING, openRuns: 0 });
    /* A run open on the chain whose record this device cannot open may be a run of this vault: not read, never counted as none. */
    const sealedElsewhere = aRunRecord(VAULT, '0d'.repeat(32), 4, '55'.repeat(32) as Hex);
    c.kept.kept.push(sealedElsewhere);
    c.chain.openRuns = ['0d'.repeat(32)];
    /* RED WHEN: a run whose record this device cannot open is passed over, so an approver is told no run is open on the vault. */
    expect((await retireGivesUpHere(c.doors, VAULT)).openRuns).toBeNull();
    c.chain.openRuns = ['0e'.repeat(32)];
    /* RED WHEN: a run open on the chain that no record here names is counted as another vault's. */
    expect((await retireGivesUpHere(c.doors, VAULT)).openRuns).toBeNull();
    c.chain.readFails = true;
    /* RED WHEN: holdings or runs that could not be read are shown as none, so an approver gives up money they were told was not there. */
    expect(await retireGivesUpHere(c.doors, VAULT)).toEqual({
      money: { notes: 'unread', public: 'unread' },
      openRuns: null
    });
  });

  it('money this device keeps on its way into or out of the vault holds the retire back, and the refusal says which press settles it', async () => {
    /* RED WHEN: a vault is retired while this device still has a deposit or a payment on its way, which would land in a retired vault. */
    await expect(retireRaisedHere(aCompany({ depositOnItsWay: true }).doors, VAULT)).rejects.toThrow(
      /Press Deposit on this vault again/u
    );
    await expect(retireRaisedHere(aCompany({ paymentOnItsWay: true }).doors, VAULT)).rejects.toThrow(
      /Press Pay on this vault again/u
    );
  });

  it("is raised once, with the raiser's approval counted, waits for the rest, and is carried by the vault's own retire under the approved proposal and its salt", async () => {
    const c = aCompany({ needed: 2 });
    const { found } = await retireRaisedHere(c.doors, VAULT);
    expect(found.onChain).toMatchObject({ held: 'open', approvals: 1 });
    /* RED WHEN: pressing again raises a second retire beside the first. */
    const again = await retireRaisedHere(c.doors, VAULT);
    expect(again.found.rec.id).toBe(found.rec.id);
    expect(c.kept.kept).toHaveLength(1);
    const named = { vault: VAULT, proposal: found.rec.id };
    /* RED WHEN: a retire short of its approvals is sent, or anything at all is built for it. */
    c.sent.length = 0;
    expect(await carryRetireHere(c.doors, named)).toEqual({ state: 'waiting', said: null });
    expect(c.sent).toEqual([]);
    c.rounds.set(found.round.chainId, { ...c.rounds.get(found.round.chainId)!, approvals: 2 });
    expect(await carryRetireHere(c.doors, named)).toEqual({ state: 'carried-out', said: null });
    /* RED WHEN: the retire is sent another way than the vault's own call, through another contract, or under another proposal or salt. */
    expect(c.sent).toEqual([
      'build retire true',
      'to the chain vault-retire true retire',
      `written down ${found.rec.id}`
    ]);
    expect(c.doors.sentTx).toBe(`RETIRE ${found.round.chainId} ${found.salt}`);
  });

  it("a seat's approval is sent once, and not again once the chain counts it", async () => {
    const c = aCompany({ needed: 3 });
    const { found } = await retireRaisedHere(c.doors, VAULT);
    const named = { vault: VAULT, proposal: found.rec.id };
    /* RED WHEN: a seat whose approval the chain already counts sends another, which the account refuses after its fee. */
    expect(await approveRetireHere(c.doors, named)).toBe('counted');
    c.rounds.set(found.round.chainId, { ...c.rounds.get(found.round.chainId)!, approvedHere: false });
    c.sent.length = 0;
    expect(await approveRetireHere(c.doors, named)).toBe('approved');
    expect(c.sent).toEqual(['build approve', `approve ${found.rec.id}`]);
  });

  it('a record whose identity is not the retire this device makes from its vault and salt is never acted on', async () => {
    const c = aCompany();
    const { found } = await retireRaisedHere(c.doors, VAULT);
    /* The record's salt now makes another identity than the one the record was filed under. */
    c.made.salt = () => '99'.repeat(32);
    /* RED WHEN: a record's own identity is trusted instead of the one its vault and salt make, so a seat approves another proposal. */
    await expect(retireFoundHere(c.doors, { vault: VAULT, proposal: found.rec.id })).rejects.toThrow(
      /Do not approve it\./u
    );
  });

  it('a retired vault is adopted again only under a retire the chain shows carried out, never one open or withdrawn', async () => {
    const c = aCompany({ needed: 1 });
    const { found } = await retireRaisedHere(c.doors, VAULT);
    const named = { vault: VAULT, proposal: found.rec.id };
    /* RED WHEN: a vault is adopted again under a retire still open, whose adoption the account then makes from a proposal never carried. */
    await expect(retiredBy(c.doors, named)).rejects.toThrow(/does not show this retire carried out/u);
    c.rounds.set(found.round.chainId, { ...c.rounds.get(found.round.chainId)!, held: 'closed', closedBy: ['cancel'] });
    await expect(retiredBy(c.doors, named)).rejects.toThrow(/does not show this retire carried out/u);
    await carryRetireHere(c.doors, named).catch(() => undefined);
    c.rounds.set(found.round.chainId, {
      ...c.rounds.get(found.round.chainId)!,
      held: 'closed',
      closedBy: ['retireVault']
    });
    expect(await retiredBy(c.doors, named)).toBe(found.round.chainId);
  });

  it('a vault is not adopted again under a retire whose adoption again the chain already closed, since the vault was retired again after it', async () => {
    const c = aCompany({ needed: 1 });
    const { found } = await retireRaisedHere(c.doors, VAULT);
    const named = { vault: VAULT, proposal: found.rec.id };
    c.rounds.set(found.round.chainId, {
      ...c.rounds.get(found.round.chainId)!,
      held: 'closed',
      closedBy: ['retireVault']
    });
    const adoption = adoptionRoundOf(pureCircuits as never, VAULT, found.round.chainId).proposal.toLowerCase();
    c.rounds.set(adoption, { held: 'closed', approvals: 1, needed: 1, closedBy: ['adopt'] });
    /* RED WHEN: an adoption the account already carried out and closed is made again under an older retire, whose approvals the account never forgets. */
    await expect(retiredBy(c.doors, named)).rejects.toThrow(/retired again since this retire/u);
    c.rounds.set(adoption, { held: 'never', approvals: 0 });
    expect(await retiredBy(c.doors, named)).toBe(found.round.chainId);
  });

  it("a wallet that cannot yet send the vault's retire stops before anything is raised or sent, and says what clears it", async () => {
    const retire = aCompany({ proves: (circuit) => circuit !== 'retire' });
    /* RED WHEN: a retire is raised, and its approvals spent, from a wallet that can never prove the vault's retire that carries it out. */
    await expect(retireRaisedHere(retire.doors, VAULT)).rejects.toThrow(
      /^This wallet cannot retire this vault yet\. It needs an update first\. Nothing was sent\.$/u
    );
    expect([retire.sent, retire.kept.log]).toEqual([[], []]);
  });
});
