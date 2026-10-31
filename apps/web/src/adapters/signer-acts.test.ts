// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ACT_REFUSAL } from './refusals.js';
import type { SignerAct, SignerActed, SignerWhy } from './signer-acts.js';

/*
 * THE SIGNERS PAGE'S TWO WALLET ACTS: what is asked of the wallet for an approval and for finishing an addition, what the page
 * does before it asks, and what the wallet's stops come to.
 */
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, calls: 0, throws: null as Error | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => kr.named,
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    kr.calls += 1;
    kr.acts.push(intent);
    if (kr.throws !== null) throw kr.throws;
    return kr.ended;
  },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./signer-acts.js');
}
const INVITED = {
  proposal: 'prop_0001', name: 'Sam', role: 'approver', address: 'AB'.repeat(32), scope: 'CD'.repeat(32), coinKey: 'EF'.repeat(32), status: 'open', approvals: null,
  seat: null,
} as const;
const stopped = (refused?: string) => ({ of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }) });

describe('approving a signer invited by address', () => {
  /* RED WHEN: the wallet is asked to approve a proposal other than the one pressed, or for a name, role, address, rights or coin key other than the ones the proposal carries. */
  it('asks the wallet to approve exactly the proposal pressed, with what it invites', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { [m.OUTCOME.state]: 'approved' } };
    expect(await m.approveSigner('u1', 'acc_Company00001', INVITED)).toEqual({ of: m.SIGNER_ACTED.done, state: 'approved' } satisfies SignerActed);
    expect(kr.acts).toEqual([{
      name: m.SIGNER_ACT.approve, record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), proposal: 'prop_0001',
      personName: 'Sam', role: 'approver', address: 'ab'.repeat(32), scope: 'cd'.repeat(32), coinKey: 'ef'.repeat(32),
    }]);
  });

  /* RED WHEN: an approval of a proposal that carries no coin key reaches the wallet. */
  it('asks the wallet for nothing when the proposal carries no coin key', async () => {
    const m = await load();
    kr.calls = 0;
    expect(await m.approveSigner('u1', 'acc_Company00001', { ...INVITED, coinKey: null })).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: a stop is told as a refusal that sent nothing when the approval may have been handed over, or the wallet's own reason is lost. */
  it('gives back the wallet\'s reason, and says which stops may have gone part of the way', async () => {
    const m = await load();
    const act: SignerAct = m.SIGNER_ACT.approve;
    for (const [refused, why, partial] of [
      ['act.approve-signer.why.not-approved', 'not-approved', false], ['act.approve-signer.why.may-be-sent', 'may-be-sent', true],
      ['act.approve-signer.why.withdrawn', 'withdrawn', false], ['act.approve-signer.why.no-seat', 'no-seat', false],
      [undefined, m.WHY.stopped, true], ['act.approve-signer.why.nobody-knows', m.WHY.other, true], ['act.admit-signer.why.no-seat', m.WHY.other, true],
    ] as readonly (readonly [string | undefined, SignerWhy, boolean])[]) {
      kr.ended = stopped(refused);
      expect(await m.approveSigner('u1', 'acc_Company00001', INVITED), why).toEqual({ of: m.SIGNER_ACTED.stopped, act, why, partial, handedOver: false } satisfies SignerActed);
    }
  });
});

describe('finishing the addition of a signer', () => {
  /* RED WHEN: the wallet is asked to admit a signer other than the one pressed. */
  it('asks the wallet to admit exactly the signer pressed', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } };
    expect(await m.admitSigner('u1', 'acc_Company00001', { id: 'sgn_2', name: 'Sam' })).toEqual({ of: 'done', state: 'admitted' });
    expect(kr.acts).toEqual([{ name: m.SIGNER_ACT.admit, record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), signer: 'sgn_2', personName: 'Sam' }]);
  });

  /* RED WHEN: an addition already finished is told as a failure, or a stop that left the company's records unnamed is told as nothing done. */
  it('tells an addition already finished, and a part-way stop that a second press finishes', async () => {
    const m = await load();
    kr.ended = { of: 'done', steps: 4, relayed: 0, outcome: { state: 'already-admitted' } };
    expect(await m.admitSigner('u1', 'acc_Company00001', { id: 'sgn_2', name: 'Sam' })).toMatchObject({ of: 'done', state: 'already-admitted' });
    for (const [refused, why, partial] of [
      ['act.admit-signer.why.filed-not-entered', 'filed-not-entered', true], ['act.admit-signer.why.not-the-invited', 'not-the-invited', false],
      ['act.admit-signer.why.not-admitted', 'not-admitted', false], ['act.approve-signer.why.no-seat', m.WHY.other, true],
      /* RED WHEN: an id the service gave another signer, or a chain the wallet could not read, is told as a reason this page does not know. */
      ['act.admit-signer.why.id-taken', 'id-taken', false], ['act.admit-signer.why.chain-unread', 'chain-unread', false],
    ] as readonly (readonly [string | undefined, SignerWhy, boolean])[]) {
      kr.ended = stopped(refused);
      expect(await m.admitSigner('u1', 'acc_Company00001', { id: 'sgn_2', name: 'Sam' }), why).toEqual({ of: m.SIGNER_ACTED.stopped, act: m.SIGNER_ACT.admit, why, partial, handedOver: false } satisfies SignerActed);
    }
  });
});

describe('before either act reaches the wallet', () => {
  /* RED WHEN: a person who is not signed in, a company that cannot be read, or a wallet window that closed is told as anything but its own refusal. */
  it('asks the wallet for nothing when nobody is signed in or the company cannot be read, and names a window that closed', async () => {
    const m = await load();
    kr.calls = 0; kr.throws = null;
    kr.user = null;
    expect(await m.approveSigner('u1', 'acc_Company00001', INVITED)).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    expect(await m.admitSigner('u1', 'acc_Company00001', { id: 's', name: 'S' })).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' }; kr.named = {};
    expect(await m.approveSigner('u1', 'acc_Company00001', INVITED)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(await m.admitSigner('u1', 'acc_Company00001', { id: 's', name: 'S' })).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.calls).toBe(0);
    kr.named = { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) };
    kr.throws = new TypeError('fetch failed');
    expect(await m.approveSigner('u1', 'acc_Company00001', INVITED)).toEqual({ of: 'refused', why: ACT_REFUSAL.unreachable });
    kr.throws = null;
  });

  /* RED WHEN: a site with no account origin reaches the wallet. */
  it('asks the wallet for nothing on a site not set up for an account', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
    vi.doMock('./session.js', async (real) => ({ ...(await real<typeof import('./session.js')>()), ACCOUNT_ORIGIN: '' }));
    kr.calls = 0;
    const m = await import('./signer-acts.js');
    expect(await m.approveSigner('u1', 'acc_Company00001', INVITED)).toEqual({ of: 'refused', why: ACT_REFUSAL.notSetUp });
    expect(await m.admitSigner('u1', 'acc_Company00001', { id: 's', name: 'S' })).toEqual({ of: 'refused', why: ACT_REFUSAL.notSetUp });
    expect(kr.calls).toBe(0);
    vi.doUnmock('./session.js');
  });
});

describe('a stop after the wallet handed over transactions', () => {
  /* RED WHEN: a refusal that follows transactions the wallet handed the page (sent, or not confirmed as sent) is told as one that sent nothing, or a refusal that handed over none is told as one that did. */
  it('says a stop handed transactions over when any were sent or left unconfirmed, whatever its reason, and none when none were', async () => {
    const m = await load();
    for (const [relayed, unconfirmed, handedOver] of [[0, 0, false], [1, 0, true], [0, 1, true], [2, 1, true]] as const) {
      kr.ended = { ...stopped('act.approve-signer.why.not-approved'), relayed, unconfirmed };
      expect(await m.approveSigner('u1', 'acc_Company00001', INVITED), `approve ${relayed}/${unconfirmed}`)
        .toEqual({ of: m.SIGNER_ACTED.stopped, act: m.SIGNER_ACT.approve, why: 'not-approved', partial: false, handedOver } satisfies SignerActed);
      kr.ended = { ...stopped('act.admit-signer.why.not-admitted'), relayed, unconfirmed };
      expect(await m.admitSigner('u1', 'acc_Company00001', { id: 'sgn_2', name: 'Sam' }), `admit ${relayed}/${unconfirmed}`)
        .toEqual({ of: m.SIGNER_ACTED.stopped, act: m.SIGNER_ACT.admit, why: 'not-admitted', partial: false, handedOver } satisfies SignerActed);
    }
  });
});
