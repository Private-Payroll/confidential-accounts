/**
 * **A VAULT'S RETIRE, RAISED, APPROVED AND CARRIED OUT FROM A DEVICE.** The company's records are kept as the service
 * keeps them and sealed for real; the proposal's identity is made by the account's own functions; the chain is a map of
 * where each proposal stands and what the vault holds, moved by what the device sends.
 */
import { describe, it, expect } from 'vitest';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import type { Hex } from '../../../src/core/crypto.js';
import { identityOfAChange, type RoundOnChain } from './governed-call-builder.js';
import { proposalsKeptInATest } from './a-vaults-start-proposals.test-support.js';
import { adoptionRoundOf } from '../../../src/midnight/vault-start.js';
import { approveRetireHere, carryRetireHere, retiredBy, retireFoundHere, retireRaisedHere, type RetireDoors } from './vault-retire-round.js';

const VAULT = 'ab'.repeat(32) as Hex;
const ACCOUNT = 'ac'.repeat(32);
const SEAT = '0b'.repeat(32) as Hex;

const TOKEN = '01'.repeat(32);

const aCompany = (over: {
  readonly needed?: number; readonly notes?: string[]; readonly publicMoney?: boolean; readonly depositOnItsWay?: boolean; readonly paymentOnItsWay?: boolean;
  readonly listed?: string[]; readonly heldOfListed?: string; readonly listUnread?: boolean; readonly forgetNotShown?: boolean;
  readonly forgetUnbuilt?: string; readonly proves?: (circuit: string) => boolean;
} = {}) => {
  const rounds = new Map<string, RoundOnChain>();
  const sent: string[] = [];
  const listed = over.listed ?? (over.publicMoney === true ? [TOKEN] : []);
  const chain = {
    notes: over.notes ?? [],
    publicBalances: over.publicMoney === true ? [{ token: TOKEN, amount: '5' }] : listed.map((token) => ({ token, amount: over.heldOfListed ?? '0' })),
    tokens: over.listUnread === true ? undefined : listed as string[] | undefined,
    forgetLands: over.forgetNotShown !== true,
  };
  const kept = proposalsKeptInATest({
    signingSecret: SEAT,
    onRaise: (chainId) => { rounds.set(chainId, { held: 'open', approvals: 1, needed: over.needed ?? 2, approvedHere: true }); },
  });
  const made = { salt: (s: string) => s };
  const builder = {
    proposalIdentity: async (change: never, salt: string) => identityOfAChange({ accountPure: pureCircuits as never }, change, made.salt(salt)),
    roundsOnChain: async (i: { chainIds: readonly string[] }) => Object.fromEntries(i.chainIds.map((id) => [id, rounds.get(id) ?? { held: 'never', approvals: 0 }])),
    vaultOnChain: async () => ({
      onChain: true, state: 's', notes: chain.notes, publicBalances: chain.publicBalances, notesFromThisBuild: true, everCreated: [], account: ACCOUNT, started: true,
      ...(chain.tokens === undefined ? { unshieldedTokensWhy: 'the ledger is of another shape' } : { unshieldedTokens: [...chain.tokens] }),
    }),
    governedCall: async (i: { order: { circuit: string } }) => { sent.push(`build ${i.order.circuit}`); return { tx: i.order.circuit.toUpperCase() }; },
    chainAtOneBlock: async () => ({ blockHash: 'bh', vaultState: 'vs', zswapState: 'zs', parameters: 'pp', accountState: 'as' }),
    retire: async (i: { vault: string; account: string; proposal: string; salt: string }) => {
      sent.push(`build retire ${i.vault === VAULT && i.account === ACCOUNT}`);
      return { tx: `RETIRE ${i.proposal} ${i.salt}` };
    },
    forgetUnshielded: async (i: { vault: string; account: string; token: string }) => {
      if (i.token === over.forgetUnbuilt) throw new Error('the chain could not be read at one block');
      sent.push(`build forget ${i.vault === VAULT && i.account === ACCOUNT} ${i.token === TOKEN}`);
      return { tx: `FORGET ${i.token}` };
    },
  };
  const toChain = async (tx: string, call: { kind: string; contract: string; circuit: string }) => {
    sent.push(`to the chain ${call.kind} ${call.contract === VAULT} ${call.circuit}`);
    const [what, id] = tx.split(' ');
    if (what === 'FORGET') {
      if (chain.forgetLands) chain.tokens = chain.tokens?.filter((t) => t !== id);
      return;
    }
    rounds.set(id!, { ...rounds.get(id!)!, held: 'closed', closedBy: ['retireVault'] });
    (doors as { sentTx?: string }).sentTx = tx;
  };
  const doors = {
    ...(over.proves === undefined ? {} : { proves: over.proves }),
    sleep: async () => {}, waitMs: 3, everyMs: 1,
    account: ACCOUNT, builder, proposals: kept.doors, me: { signerId: 'ada' }, material: { signingSecret: SEAT },
    indexer: async () => ({ indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' }),
    handOver: {
      path: 'service',
      fallback: {
        toChain,
        fellBack: () => {}, taken: () => false,
      },
    },
    approveSent: async (id: string) => {
      sent.push(`approve ${id}`);
      const rec = kept.kept.find((r) => r.id === id)!;
      const r = rounds.get(rec.chainId)!;
      rounds.set(rec.chainId, { ...r, approvals: r.approvals + 1, approvedHere: true });
    },
    closedSent: async (id: string) => { sent.push(`written down ${id}`); },
    inFlight: {
      deposits: { get: async () => (over.depositOnItsWay === true ? {} : null) },
      payments: { get: async () => (over.paymentOnItsWay === true ? {} : null) },
    },
  } as unknown as RetireDoors & { sentTx?: string };
  return { doors, rounds, sent, kept, chain, made };
};

describe('A VAULT RETIRED FROM THE DEVICE', () => {
  it('a vault holding money is not retired: nothing is raised, built or sent, and the refusal says to pay it out', async () => {
    for (const over of [{ notes: ['n1'] }, { publicMoney: true }]) {
      const c = aCompany(over);
      /* RED WHEN: a retire is raised for a vault the chain shows holding money, which the vault would refuse only after a fee was paid. */
      await expect(retireRaisedHere(c.doors, VAULT)).rejects.toThrow(/still holds .*Nothing was sent\. Pay (them|it) out of the vault, then retire it\./u);
      expect([c.sent, c.kept.log]).toEqual([[], []]);
    }
  });

  it('money this device keeps on its way into or out of the vault holds the retire back, and the refusal says which press settles it', async () => {
    /* RED WHEN: a vault is retired while this device still has a deposit or a payment on its way, which would land in a retired vault. */
    await expect(retireRaisedHere(aCompany({ depositOnItsWay: true }).doors, VAULT)).rejects.toThrow(/Press Deposit on this vault again/u);
    await expect(retireRaisedHere(aCompany({ paymentOnItsWay: true }).doors, VAULT)).rejects.toThrow(/Press Pay on this vault again/u);
  });

  it('is raised once, with the raiser\'s approval counted, waits for the rest, and is carried by the vault\'s own retire under the approved proposal and its salt', async () => {
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
    expect(c.sent).toEqual(['build retire true', 'to the chain vault-retire true retire', `written down ${found.rec.id}`]);
    expect(c.doors.sentTx).toBe(`RETIRE ${found.round.chainId} ${found.salt}`);
  });

  it('a retire held at its bar is still not carried while the vault holds money', async () => {
    const c = aCompany({ needed: 1 });
    const { found } = await retireRaisedHere(c.doors, VAULT);
    c.chain.notes = ['paid in after the raise'];
    c.sent.length = 0;
    /* RED WHEN: money paid in after the raise is stranded by a retire carried without reading the vault again. */
    await expect(carryRetireHere(c.doors, { vault: VAULT, proposal: found.rec.id })).rejects.toThrow(/still holds 1 note/u);
    expect(c.sent).toEqual([]);
  });

  it('a seat\'s approval is sent once, and not again once the chain counts it', async () => {
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
    await expect(retireFoundHere(c.doors, { vault: VAULT, proposal: found.rec.id })).rejects.toThrow(/Do not approve it\./u);
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
    c.rounds.set(found.round.chainId, { ...c.rounds.get(found.round.chainId)!, held: 'closed', closedBy: ['retireVault'] });
    expect(await retiredBy(c.doors, named)).toBe(found.round.chainId);
  });

  it('a vault is not adopted again under a retire whose adoption again the chain already closed, since the vault was retired again after it', async () => {
    const c = aCompany({ needed: 1 });
    const { found } = await retireRaisedHere(c.doors, VAULT);
    const named = { vault: VAULT, proposal: found.rec.id };
    c.rounds.set(found.round.chainId, { ...c.rounds.get(found.round.chainId)!, held: 'closed', closedBy: ['retireVault'] });
    const adoption = adoptionRoundOf(pureCircuits as never, VAULT, found.round.chainId).proposal.toLowerCase();
    c.rounds.set(adoption, { held: 'closed', approvals: 1, needed: 1, closedBy: ['adopt'] });
    /* RED WHEN: an adoption the account already carried out and closed is made again under an older retire, whose approvals the account never forgets. */
    await expect(retiredBy(c.doors, named)).rejects.toThrow(/retired again since this retire/u);
    c.rounds.set(adoption, { held: 'never', approvals: 0 });
    expect(await retiredBy(c.doors, named)).toBe(found.round.chainId);
  });

  it('a vault once paid publicly and paid back to nothing has each token it lists taken off its list first, then is raised and carried', async () => {
    const c = aCompany({ needed: 1, listed: [TOKEN] });
    /* RED WHEN: a vault the chain's retire refuses, because it still lists a token, is read as empty and its retire raised and approved for nothing. */
    const { found } = await retireRaisedHere(c.doors, VAULT);
    expect(c.sent.slice(0, 2)).toEqual(['build forget true true', 'to the chain vault-forget true forgetUnshielded']);
    expect(c.chain.tokens).toEqual([]);
    /* RED WHEN: a token paid in and back out again after the raise is still listed when the vault's retire is sent, which the vault refuses. */
    c.chain.tokens = [TOKEN];
    c.sent.length = 0;
    expect(await carryRetireHere(c.doors, { vault: VAULT, proposal: found.rec.id })).toEqual({ state: 'carried-out', said: null });
    expect(c.sent).toEqual([
      'build forget true true', 'to the chain vault-forget true forgetUnshielded',
      'build retire true', 'to the chain vault-retire true retire', `written down ${found.rec.id}`,
    ]);
  });

  it('a token the vault still holds some of is never taken off its list: nothing is sent, and the refusal says to pay it out', async () => {
    const c = aCompany({ listed: [TOKEN], heldOfListed: '7' });
    /* RED WHEN: a token the vault holds money of is sent to be forgotten, or the retire is raised over money the vault holds. */
    await expect(retireRaisedHere(c.doors, VAULT)).rejects.toThrow(/still holds public money.*Nothing was sent\. Pay it out of the vault, then retire it\./u);
    expect([c.sent, c.kept.log]).toEqual([[], []]);
  });

  it('a balance the chain keeps at nothing for a token the vault no longer lists does not hold the retire back', async () => {
    const c = aCompany({ needed: 1 });
    c.chain.publicBalances = [{ token: TOKEN, amount: '0' }];
    /* RED WHEN: an entry at nothing refuses with "pay it out", which nobody can do at nothing, so the vault can never retire. */
    await expect(retireRaisedHere(c.doors, VAULT)).resolves.toMatchObject({ found: { onChain: { held: 'open' } } });
  });

  it('a public amount is read by the one reading the page keeps a retired vault listed by', async () => {
    const c = aCompany({ needed: 1, listed: [TOKEN], heldOfListed: '00' });
    /* RED WHEN: the retire reads an amount at nothing as money held, where the page reads it as nothing, so the two disagree on one vault. */
    await expect(retireRaisedHere(c.doors, VAULT)).resolves.toMatchObject({ found: { onChain: { held: 'open' } } });
    expect(await retireRaisedHere(aCompany({ listed: [TOKEN], heldOfListed: '0x0' }).doors, VAULT).then(() => null, (e: Error) => e.message)).toMatch(/still holds public money/u);
  });

  it('a list of public tokens that could not be read refuses, naming what clears it, and is never read as empty', async () => {
    const c = aCompany({ listed: [TOKEN], listUnread: true });
    /* RED WHEN: an unread list is taken as an empty one, so the retire is raised and approved and the chain then refuses it. */
    await expect(retireRaisedHere(c.doors, VAULT)).rejects.toThrow(/^Which public tokens this vault lists could not be read \(the ledger is of another shape\).*Nothing was sent\. Press again in a minute\./u);
    expect([c.sent, c.kept.log]).toEqual([[], []]);
  });

  it('a token sent to be taken off the list that the network still lists stops the retire, saying the call was sent', async () => {
    const c = aCompany({ listed: [TOKEN], forgetNotShown: true });
    /* RED WHEN: the retire is raised while the chain still lists the token, or the refusal says nothing was sent when the call was. */
    await expect(retireRaisedHere(c.doors, VAULT)).rejects.toThrow(/was sent, and the network still lists .*The retire was not raised\. Press again in a minute/u);
    expect(c.sent).toEqual(['build forget true true', 'to the chain vault-forget true forgetUnshielded']);
    expect(c.kept.log).toEqual([]);
  });

  it('a later token whose call cannot be built after an earlier one went out says how many went out, never that nothing was sent', async () => {
    const OTHER = '02'.repeat(32);
    const c = aCompany({ listed: [TOKEN, OTHER], forgetUnbuilt: OTHER });
    /* RED WHEN: a press that sent one call taking a token off the list, and paid its fee, says nothing was sent. */
    const e = await retireRaisedHere(c.doors, VAULT).then(() => null, (x: Error) => x.message);
    expect(e).toMatch(/1 call taking a public token off this vault's list already went out, each paying only its network fee and moving no money; nothing more was sent\. The retire was not raised\. Press again/u);
    expect(e).not.toMatch(/Nothing was sent/u);
    expect(c.kept.log).toEqual([]);
  });

  it('on the carry, a token the network still lists says the retire stays raised and approved, never that it was not raised', async () => {
    const c = aCompany({ needed: 1 });
    const { found } = await retireRaisedHere(c.doors, VAULT);
    c.chain.tokens = [TOKEN];
    c.chain.publicBalances = [{ token: TOKEN, amount: '0' }];
    c.chain.forgetLands = false;
    /* RED WHEN: the carry's refusal says the retire was not raised, which the chain shows raised and approved. */
    const e = await carryRetireHere(c.doors, { vault: VAULT, proposal: found.rec.id }).then(() => null, (x: Error) => x.message);
    expect(e).toMatch(/The retire stays raised and approved on the network, and was not sent\. Press again in a minute/u);
    expect(e).not.toMatch(/not raised/u);
  });

  it('a wallet that cannot yet send a call the retire needs stops before anything is raised or sent, and says what clears it', async () => {
    const forget = aCompany({ listed: [TOKEN], proves: (circuit) => circuit !== 'forgetUnshielded' });
    /* RED WHEN: a wallet that cannot prove the call taking a token off the list starts it, or refuses without naming what clears it. */
    await expect(retireRaisedHere(forget.doors, VAULT)).rejects.toThrow(/^The vault still lists a public token it was once paid, and it will not retire until that is cleared\. This wallet cannot clear it yet: it needs an update first\. Nothing was sent\.$/u);
    expect([forget.sent, forget.kept.log]).toEqual([[], []]);
    const retire = aCompany({ proves: (circuit) => circuit !== 'retire' });
    /* RED WHEN: a retire is raised, and its approvals spent, from a wallet that can never prove the vault's retire that carries it out. */
    await expect(retireRaisedHere(retire.doors, VAULT)).rejects.toThrow(/^This wallet cannot retire this vault yet\. It needs an update first\. Nothing was sent\.$/u);
    expect([retire.sent, retire.kept.log]).toEqual([[], []]);
  });
});
