// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { recoveryFileTextOf } from 'vaults-web-shared/recovery-in-the-wallet.js';
import { ACT_REFUSAL } from './refusals.js';

/*
 * THE RECOVERY ADAPTER: what is asked of the person's wallet to raise, approve and carry out a recovery, the file made from what the
 * wallet tells, the file opened again, what the chain is read for, and what a stop of the wallet comes to.
 */
const ACCOUNT = 'c0'.repeat(32);
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, throws: null as Error | null,
  rounds: {} as Record<string, unknown>, asked: [] as unknown[], indexer: { indexerUri: 'http://i', indexerWsUri: 'ws://i' } as unknown, readThrows: false,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => kr.named,
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    kr.acts.push(intent);
    if (kr.throws !== null) throw kr.throws;
    return kr.ended;
  },
}));
vi.mock('./vault-builder.js', async (real) => ({
  ...(await real<typeof import('./vault-builder.js')>()),
  theVaultBuilder: async () => ({
    roundsOnChain: async (ask: unknown) => { kr.asked.push(ask); if (kr.readThrows) throw new Error('indexer gone'); return kr.rounds; },
  }),
}));

const rs = vi.hoisted(() => ({ here: null as unknown, throws: false, keys: { signingPublicKey: 'k' } as unknown, opened: { signers: [] } as unknown, asked: [] as unknown[] }));
vi.mock('./keyring-person.js', async (real) => ({ ...(await real<typeof import('./keyring-person.js')>()), keysOnTheWayIn: async () => rs.keys }));
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
  walletIndexerFor: async () => kr.indexer,
  openedHere: async () => rs.opened,
  companyKeysFor: async () => ({ current: 'key' }),
  directoryWithItsRecordsFor: (...args: unknown[]) => async (asked: unknown) => { rs.asked.push([args[0], args[1], args[2], asked]); if (rs.throws) throw new Error('behind'); return rs.here; },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  rs.throws = false; rs.keys = { signingPublicKey: 'k' }; rs.opened = { signers: [] }; rs.asked = [];
  kr.named = { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) };
  kr.acts = []; kr.asked = []; kr.throws = null; kr.rounds = {}; kr.readThrows = false; kr.user = { id: 'u1' }; kr.indexer = { indexerUri: 'http://i', indexerWsUri: 'ws://i' };
  return import('./recovery.js');
}
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const told = (over: Record<string, string | number> = {}) => ({
  state: 'waiting-for-approvals', approvals: 1, needed: 2, proposal: 'aa'.repeat(32), salt: 'bb'.repeat(32), latest: String(NOW / 1000 + 86400),
  lastRecovery: 'cc'.repeat(32), resumesFrom: 'dd'.repeat(32), root: 'ee'.repeat(32), seq: 4, ...over,
});
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({
  of: 'stopped', step: 3, steps: 3, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }), ...over,
});
const here = async (m: Awaited<ReturnType<typeof load>>) => {
  kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: told() };
  const raised = await m.raiseRecovery('u1', 'c-1', 'day', undefined, () => NOW);
  if (raised.of !== 'done' || raised.held === null) throw new Error('the raise did not give a recovery');
  kr.acts = [];
  return raised.held;
};

describe('raising a recovery', () => {
  /*
   * RED WHEN: the last time is not a moment after now by the choice made, or reaches the week the wallet allows, or the wallet is asked
   * anything but the company, the step and the time; or the page names a coin, a call or a relay for a recovery.
   */
  it('asks the wallet for the company, the raise step and a moment after now by the choice made', async () => {
    const m = await load();
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: told() };
    await m.raiseRecovery('u1', 'c-1', 'three-days', undefined, () => NOW);
    expect(kr.acts).toEqual([{ name: 'recovery', record: 'c-1', company: 'label-1', account: ACCOUNT, step: 'raise', latest: String(NOW / 1000 + 3 * 86400) }]);
    for (const w of m.RECOVERY_WITHIN) {
      expect(w.seconds).toBeGreaterThan(0);
      expect(w.seconds).toBeLessThan(7 * 24 * 60 * 60);
    }
    expect((await m.raiseRecovery('u1', 'c-1', 'nope' as never, undefined, () => NOW)).of).toBe('refused');
    expect(kr.acts).toHaveLength(1);
  });

  /* RED WHEN: a raise that finished does not give back the recovery with the time it may be carried out and the name its file is saved under, or gives back parts the wallet did not tell. */
  it('gives back the recovery from the parts the wallet told', async () => {
    const m = await load();
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: told() };
    const raised = await m.raiseRecovery('u1', 'c-1', 'day', undefined, () => NOW);
    expect(raised).toMatchObject({ of: 'done', act: 'raise', state: 'waiting-for-approvals', approvals: 1, needed: 2 });
    const held = (raised as { held: Awaited<ReturnType<typeof here>> }).held;
    expect(held).toEqual({
      parts: {
        company: 'c-1', account: ACCOUNT, chainId: 'aa'.repeat(32), salt: 'bb'.repeat(32), latest: String(NOW / 1000 + 86400), lastRecovery: 'cc'.repeat(32),
        resumesFrom: { seq: 4, head: 'dd'.repeat(32), root: 'ee'.repeat(32) },
      },
      until: new Date(NOW + 86400_000).toISOString(), fileName: 'recovery-aaaaaaaa.json',
    });
  });

  /* RED WHEN: a raise the wallet stopped after raising (its carrying out refused) loses the file, so the other signers can never approve it. */
  it('gives the file back on a stop, where the wallet had raised before it stopped', async () => {
    const m = await load();
    kr.ended = stopped('act.recovery.why.no-dust', { outcome: told() });
    const raised = await m.raiseRecovery('u1', 'c-1', 'day', undefined, () => NOW);
    expect(raised).toMatchObject({ of: 'stopped', act: 'raise', why: 'no-dust', partial: false });
    expect((raised as { held: unknown }).held).not.toBeNull();
    kr.ended = stopped('act.recovery.why.no-dust');
    expect(await m.raiseRecovery('u1', 'c-1', 'day', undefined, () => NOW)).toMatchObject({ of: 'stopped', held: null });
  });

  /* RED WHEN: parts that are not a recovery's (a short hash, a negative batch, a time that is not whole seconds) are made into a file the other signers are sent. */
  it('makes no file from parts that are not a recovery\'s', async () => {
    const m = await load();
    for (const bad of [{ salt: 'zz' }, { seq: -1 }, { latest: '12.5' }, { proposal: 'aa' }] as Record<string, string | number>[]) {
      kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: told(bad) };
      expect(await m.raiseRecovery('u1', 'c-1', 'day', undefined, () => NOW), JSON.stringify(bad)).toMatchObject({ of: 'done', held: null });
    }
  });

  /* RED WHEN: a person not signed in, no wallet address, or a company the service does not name reaches the wallet window. */
  it('refuses before the wallet window when the person or the company is not there', async () => {
    const m = await load();
    kr.user = { id: 'someone-else' };
    expect(await m.raiseRecovery('u1', 'c-1', 'day')).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' };
    kr.named = null;
    expect(await m.raiseRecovery('u1', 'c-1', 'day')).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    kr.named = { companyLabel: 'label-1', contractAddress: ACCOUNT };
    expect(kr.acts).toEqual([]);
  });
});

describe('approving and carrying out', () => {
  /* RED WHEN: Approve is not the wallet's one approval act under the recovery's kind, or it leaves out a part of the file the wallet checks against the chain. */
  it('asks the wallet to approve under the recovery kind, with every part of the file', async () => {
    const m = await load();
    const held = await here(m);
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'carried-out', approvals: 2, needed: 2 } };
    expect(await m.approveRecovery('u1', 'c-1', held)).toMatchObject({ of: 'done', act: 'approve', state: 'carried-out', approvals: 2, needed: 2, held });
    expect(kr.acts).toEqual([{
      name: 'approve-proposal', record: 'c-1', company: 'label-1', account: ACCOUNT, proposal: 'aa'.repeat(32), kind: 'recovery', salt: 'bb'.repeat(32),
      latest: String(NOW / 1000 + 86400), lastRecovery: 'cc'.repeat(32), resumesFrom: 'dd'.repeat(32), root: 'ee'.repeat(32), seq: '4',
    }]);
  });

  /* RED WHEN: Carry out is not the wallet's recovery act at its carry step, with every part of the file, or a short count is told as carried out. */
  it('asks the wallet to carry out with every part of the file, and tells a short count as waiting', async () => {
    const m = await load();
    const held = await here(m);
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { state: 'waiting-for-approvals', approvals: 1, needed: 2 } };
    expect(await m.carryOutRecovery('u1', 'c-1', held)).toMatchObject({ of: 'done', act: 'carry', state: 'waiting-for-approvals' });
    expect(kr.acts).toEqual([{
      name: 'recovery', record: 'c-1', company: 'label-1', account: ACCOUNT, step: 'carry', proposal: 'aa'.repeat(32), salt: 'bb'.repeat(32),
      latest: String(NOW / 1000 + 86400), lastRecovery: 'cc'.repeat(32), resumesFrom: 'dd'.repeat(32), root: 'ee'.repeat(32), seq: '4',
    }]);
  });

  /* RED WHEN: a file of another company, or of another account, is sent to the wallet under this company's name. */
  it('asks the wallet nothing for a recovery that is not this company\'s', async () => {
    const m = await load();
    const held = await here(m);
    kr.named = { companyLabel: 'label-1', contractAddress: 'd1'.repeat(32) };
    expect(await m.approveRecovery('u1', 'c-1', held)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(await m.carryOutRecovery('u1', 'c-1', held)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: a stop is told as a refusal that sent nothing when the wallet says part of it may have gone, or a code the page does not know is told as one it does. */
  it('tells each stop of the wallet as the page names it, and part-sent as part-sent', async () => {
    const m = await load();
    const held = await here(m);
    const why = async (refused?: string, over: Record<string, unknown> = {}) => {
      kr.ended = stopped(refused, over);
      return m.carryOutRecovery('u1', 'c-1', held);
    };
    expect(await why('act.recovery.why.still-open')).toMatchObject({ why: 'still-open', partial: false });
    expect(await why('act.recovery.why.may-be-sent')).toMatchObject({ why: 'may-be-sent', partial: true });
    expect(await why('act.recovery.why.not-carried')).toMatchObject({ why: 'not-done', partial: false });
    expect(await why('act.recovery.why.seat-not-held')).toMatchObject({ why: 'seat' });
    expect(await why('act.recovery.why.outrun')).toMatchObject({ why: 'outrun' });
    expect(await why('act.recovery.why.something-new')).toMatchObject({ why: 'other' });
    expect(await why(undefined)).toMatchObject({ why: 'stopped' });
    expect(await why('act.recovery.why.no-dust', { unconfirmed: 1 })).toMatchObject({ why: 'no-dust', partial: true });
  });

  /* RED WHEN: the wallet closing or the page failing to reach it throws out of the press instead of ending as a refusal in words. */
  it('ends a thrown failure as a refusal', async () => {
    const m = await load();
    const held = await here(m);
    kr.throws = new TypeError('Failed to fetch');
    expect(await m.carryOutRecovery('u1', 'c-1', held)).toEqual({ of: 'refused', why: ACT_REFUSAL.unreachable });
  });
});

describe('opening a saved file', () => {
  /* RED WHEN: a file this page saved does not open as the same recovery, or opens under the wrong time. */
  it('opens the file it saved as the same recovery', async () => {
    const m = await load();
    const held = await here(m);
    const opened = await m.openRecoveryFile('c-1', recoveryFileTextOf(held.parts, 'a summary'));
    expect(opened).toEqual({ of: 'opened', held });
  });

  /* RED WHEN: a file that is not JSON, not a proposal file, not a recovery, or another company's opens, or the reason for the refusal is the wrong one. */
  it('refuses a file that is not a recovery of this company, and says which way', async () => {
    const m = await load();
    const held = await here(m);
    expect(await m.openRecoveryFile('c-1', 'not json')).toEqual({ of: 'refused', why: 'unreadable' });
    expect(await m.openRecoveryFile('c-1', '{"format":"other"}')).toEqual({ of: 'refused', why: 'unreadable' });
    const file = recoveryFileTextOf(held.parts, 'a summary');
    const addSigner = JSON.stringify({ ...JSON.parse(file), change: { kind: 'threshold', threshold: 2 } });
    expect(await m.openRecoveryFile('c-1', addSigner)).toEqual({ of: 'refused', why: 'not-a-recovery' });
    expect(await m.openRecoveryFile('c-2', file)).toEqual({ of: 'refused', why: 'not-this-company' });
    kr.named = { companyLabel: 'label-1', contractAddress: 'd1'.repeat(32) };
    expect(await m.openRecoveryFile('c-1', file)).toEqual({ of: 'refused', why: 'not-this-company' });
    kr.named = null;
    expect(await m.openRecoveryFile('c-1', file)).toEqual({ of: 'refused', why: 'company-unread' });
  });
});

describe('where the chain holds a recovery', () => {
  /* RED WHEN: the standing is taken from the file or from the service instead of the chain, or the wrong recovery's round is read, or the time is not tested against the file's last moment. */
  it('reads where the chain holds this recovery through the wallet\'s indexer, and whether its time has passed', async () => {
    const m = await load();
    const held = await here(m);
    kr.rounds = { ['aa'.repeat(32)]: { held: 'open', approvals: 1, needed: 2 } };
    expect(await m.recoveryStanding('c-1', held, () => NOW)).toEqual({ of: 'read', held: 'open', approvals: 1, needed: 2, outrun: false, passed: false });
    expect(kr.asked).toEqual([{ account: ACCOUNT, indexer: { indexerUri: 'http://i', indexerWsUri: 'ws://i' }, chainIds: ['aa'.repeat(32)] }]);
    kr.rounds = { ['aa'.repeat(32)]: { held: 'open', approvals: 1, outrun: true } };
    expect(await m.recoveryStanding('c-1', held, () => NOW + 2 * 86400_000)).toEqual({ of: 'read', held: 'open', approvals: 1, needed: null, outrun: true, passed: true });
    kr.rounds = { ['aa'.repeat(32)]: { held: 'never', approvals: 0 } };
    expect(await m.recoveryStanding('c-1', held, () => NOW)).toMatchObject({ held: 'never' });
  });

  /* RED WHEN: an unreadable chain throws out of the page, or is told as a recovery the chain does not hold. */
  it('says unread, and never throws, when the chain cannot be read', async () => {
    const m = await load();
    const held = await here(m);
    kr.readThrows = true;
    expect(await m.recoveryStanding('c-1', held)).toEqual({ of: 'unread' });
    kr.readThrows = false;
    kr.indexer = null;
    expect(await m.recoveryStanding('c-1', held)).toEqual({ of: 'unread' });
    kr.indexer = { indexerUri: 'http://i', indexerWsUri: 'ws://i' };
    kr.rounds = {};
    expect(await m.recoveryStanding('c-1', held)).toEqual({ of: 'unread' });
  });
});

describe('what the company\'s records stand at', () => {
  const directory = (over: Record<string, unknown> = {}, records: Record<string, unknown> = {}) => ({
    records: { reached: { seq: 7 }, stopped: null, notYetAnchored: [], ...records }, passedOver: [], refiledRefused: [], ...over,
  });

  /* RED WHEN: the page reads the records with the reader that refuses past a stop, so a stop is thrown as a sentence and never told as a state; or a state the read holds is dropped. */
  it('reads the stop, where the check began, what a recovery gave up, the passed-over versions and the unanchored count', async () => {
    const m = await load();
    const stop = { stop: 'not-given', seq: 7, what: 'x', movedBy: 'ab'.repeat(32), anchorsInBlock: 2 };
    rs.here = directory(
      { passedOver: [{ version: 3 }, { version: 5 }], refiledRefused: [{ version: 6, signedAt: 4, why: 'x' }] },
      { stopped: stop, checkedFrom: { by: 'vouched', seq: 2, head: 'h', run: 'r', at: 9 }, recovered: { resumedFrom: { seq: 4 }, gaveUpTo: 6 }, notYetAnchored: [{}, {}, {}] },
    );
    expect(await m.readRecordsStates('u1', 'c-1')).toEqual({
      of: 'read', value: {
        reached: 7, stopped: stop, checkedFrom: { by: 'vouched', seq: 2, head: 'h', run: 'r', at: 9 }, recovered: { resumedFrom: 4, gaveUpTo: 6 },
        notYetAnchored: 3, passedOver: [3, 5], notApplied: [6],
      },
    });
    expect(rs.asked).toEqual([['c-1', 'label-1', ACCOUNT, {}]]);
  });

  /* RED WHEN: a read with nothing wrong shows a state, or a read that cannot be made (the wallet's indexer behind, the service withholding a record) throws out of the page instead of being told as unread. */
  it('tells a quiet read as no states, and a read that fails as unreadable', async () => {
    const m = await load();
    rs.here = directory();
    expect(await m.readRecordsStates('u1', 'c-1')).toEqual({
      of: 'read', value: { reached: 7, stopped: null, checkedFrom: null, recovered: null, notYetAnchored: 0, passedOver: [], notApplied: [] },
    });
    rs.throws = true;
    expect(await m.readRecordsStates('u1', 'c-1')).toEqual({ of: 'unreadable' });
    rs.throws = false;
    rs.keys = null;
    expect(await m.readRecordsStates('u1', 'c-1')).toEqual({ of: 'unreadable' });
    rs.keys = { signingPublicKey: 'k' };
    rs.opened = null;
    expect(await m.readRecordsStates('u1', 'c-1')).toEqual({ of: 'unreadable' });
    kr.user = { id: 'someone-else' };
    expect(await m.readRecordsStates('u1', 'c-1')).toEqual({ of: 'unreadable' });
  });
});
