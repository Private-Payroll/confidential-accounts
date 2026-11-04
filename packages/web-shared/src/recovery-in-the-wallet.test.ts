// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';

const keyring = vi.hoisted(() => ({ intents: [] as Record<string, string>[] }));
vi.mock('./keyring.js', () => ({
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    keyring.intents.push(intent);
    return { of: 'done', steps: 1, relayed: 0, outcome: { state: 'waiting-for-approvals', approvals: 1, needed: 2 } };
  },
}));

const m = await import('./recovery-in-the-wallet.js');

const ask = { record: 'acc_Company00001', company: 'label' as CompanyLabel, account: 'c0'.repeat(32) as AccountAddress };
const parts: import('./recovery-in-the-wallet.js').RecoveryParts = {
  company: 'acc_Company00001', account: 'c0'.repeat(32), chainId: 'aa'.repeat(32), salt: 'bb'.repeat(32), latest: '1793793600',
  lastRecovery: 'cc'.repeat(32), resumesFrom: { seq: 4, head: 'dd'.repeat(32), root: 'ee'.repeat(32) },
};
const VIEW = {} as never;

beforeEach(() => { keyring.intents.length = 0; });

describe('what the wallet is asked for a recovery', () => {
  /* RED WHEN: a raise names anything but the company, the raise step and the last time as whole seconds in digits. */
  it('asks the raise with the company, the step and the last time in digits', async () => {
    await m.raiseRecoveryInTheWallet({ ...ask, latest: 1793793600 }, 'https://wallet.example', {}, VIEW);
    expect(keyring.intents).toEqual([{ name: 'recovery', record: ask.record, company: 'label', account: ask.account, step: 'raise', latest: '1793793600' }]);
  });

  /* RED WHEN: a carrying out leaves out a part of the file the wallet checks against the chain, or the batch is not in digits. */
  it('asks the carry with every part of the file', async () => {
    await m.carryOutRecoveryInTheWallet({ ...ask, parts }, 'https://wallet.example', {}, VIEW);
    expect(keyring.intents).toEqual([{
      name: 'recovery', record: ask.record, company: 'label', account: ask.account, step: 'carry', proposal: parts.chainId, salt: parts.salt,
      latest: parts.latest, lastRecovery: parts.lastRecovery, resumesFrom: parts.resumesFrom.head, root: parts.resumesFrom.root, seq: '4',
    }]);
  });

  /* RED WHEN: an approval is not the one approval action under the recovery kind with the file's parts. */
  it('asks the approval as the approve action under the recovery kind', async () => {
    await m.approveRecoveryInTheWallet({ ...ask, parts }, 'https://wallet.example', {}, VIEW);
    expect(keyring.intents).toEqual([{
      name: 'approve-proposal', record: ask.record, company: 'label', account: ask.account, proposal: parts.chainId, kind: 'recovery', salt: parts.salt,
      latest: parts.latest, lastRecovery: parts.lastRecovery, resumesFrom: parts.resumesFrom.head, root: parts.resumesFrom.root, seq: '4',
    }]);
  });
});

describe('the parts of a file', () => {
  /* RED WHEN: parts that are not a recovery's (short hashes, a latest time that is not whole, a batch below nothing) are taken as a file's. */
  it('takes only the parts of a recovery', () => {
    expect(m.isRecoveryParts(parts)).toBe(true);
    expect(m.isRecoveryParts({ ...parts, salt: 'zz' })).toBe(false);
    expect(m.isRecoveryParts({ ...parts, account: 'AB'.repeat(32) })).toBe(false);
    expect(m.isRecoveryParts({ ...parts, latest: '12.5' })).toBe(false);
    expect(m.isRecoveryParts({ ...parts, latest: '' })).toBe(false);
    expect(m.isRecoveryParts({ ...parts, resumesFrom: { ...parts.resumesFrom, seq: -1 } })).toBe(false);
    expect(m.isRecoveryParts({ ...parts, resumesFrom: { ...parts.resumesFrom, seq: 1.5 } })).toBe(false);
  });

  /* RED WHEN: the parts the wallet told are read as another company's, or parts told without a batch number, as strings, or with a non-recovery value, are kept. */
  it('reads the parts the wallet told as this company\'s, and nothing short of all of them', () => {
    const told = { proposal: parts.chainId, salt: parts.salt, latest: parts.latest, lastRecovery: parts.lastRecovery, resumesFrom: parts.resumesFrom.head, root: parts.resumesFrom.root, seq: 4 };
    expect(m.recoveryPartsToldBy(parts.company, parts.account, told)).toEqual(parts);
    expect(m.recoveryPartsToldBy(parts.company, parts.account, undefined)).toBeNull();
    expect(m.recoveryPartsToldBy(parts.company, parts.account, { ...told, seq: '4' })).toBeNull();
    expect(m.recoveryPartsToldBy(parts.company, parts.account, { ...told, root: 'xx' })).toBeNull();
    const { salt: _salt, ...withoutSalt } = told;
    expect(m.recoveryPartsToldBy(parts.company, parts.account, withoutSalt)).toBeNull();
  });

  /* RED WHEN: the last time is read in milliseconds, or a time that is exactly now counts as not passed. */
  it('says the last time as an ISO moment and when it has passed', () => {
    expect(m.recoveryUntil(parts)).toBe('2026-11-04T12:00:00.000Z');
    expect(m.recoveryTimePassed(parts, 1793793599_999)).toBe(false);
    expect(m.recoveryTimePassed(parts, 1793793600_000)).toBe(true);
    expect(m.recoveryLatestAt(1793793600_999, 3600)).toBe(1793797200);
    expect(m.recoveryFileName(parts)).toBe('recovery-aaaaaaaa.json');
  });
});

describe('why the wallet stopped', () => {
  /* RED WHEN: a wallet refusal is told as another reason, or one the page does not know is told as one it does. */
  it('names each stop by the key of the words the wallet refused with', () => {
    const why = (code: string) => m.recoveryWhyOf(`act.recovery.why.${code}`);
    expect(why('seat-not-held')).toBe('seat');
    expect(why('still-open')).toBe('still-open');
    expect(why('may-be-sent')).toBe('may-be-sent');
    expect(why('not-raised-here')).toBe('not-done');
    expect(why('not-approved')).toBe('not-done');
    expect(why('not-carried')).toBe('not-done');
    expect(why('hasOwnProperty')).toBe('other');
    expect(why('something-new')).toBe('other');
    expect(m.recoveryWhyOf('act.approve-proposal.why.outrun')).toBe('outrun');
    expect(m.recoveryWhyOf('act.invite.why.outrun')).toBe('other');
    expect(m.recoveryWhyOf(undefined)).toBe('stopped');
  });

  /* RED WHEN: a count the wallet did not tell as a whole number is read as one, or a state it does not name is taken as one of the two. */
  it('reads the state and counts the wallet told, and none it did not', () => {
    const ended = (outcome: Record<string, string | number> | undefined) => ({ of: 'done', steps: 1, relayed: 0, ...(outcome === undefined ? {} : { outcome }) }) as never;
    expect(m.recoveryOutcomeOf(ended({ state: 'carried-out', approvals: 2, needed: 2 }))).toEqual({ state: 'carried-out', approvals: 2, needed: 2 });
    expect(m.recoveryOutcomeOf(ended({ state: 'whatever', approvals: '2', needed: -1 }))).toEqual({ state: null, approvals: null, needed: null });
    expect(m.recoveryOutcomeOf(ended(undefined))).toEqual({ state: null, approvals: null, needed: null });
  });

  /* RED WHEN: a choice of time reaches the week the wallet allows, or is not after now. */
  it('offers only times after now and short of seven days', () => {
    for (const w of m.RECOVERY_WITHIN) {
      expect(w.seconds).toBeGreaterThan(0);
      expect(w.seconds).toBeLessThan(7 * 24 * 60 * 60);
    }
  });
});

describe('the file', () => {
  /* RED WHEN: the file this page writes is not one the company's own file reader takes as the same recovery, or its format name drifts from the reader's, so a file saved here cannot be approved anywhere else. */
  it('writes a file the company\'s own file reader reads as the same recovery', async () => {
    const { proposalFileRead, PROPOSAL_FILE_FORMAT } = await import('./governance-from-the-chain.js');
    const { recoveryPartsOf, recoveryFileOf } = await import('./records-recovered-here.js');
    const text = m.recoveryFileTextOf(parts, 'In the person\'s words');
    const file = proposalFileRead(text);
    expect(file.format).toBe(PROPOSAL_FILE_FORMAT);
    expect(recoveryPartsOf(file)).toEqual(parts);
    expect(file).toEqual({ ...recoveryFileOf(parts), summary: 'In the person\'s words' });
    expect(text.endsWith('\n')).toBe(true);
  });

  /* RED WHEN: a file written by the company's own tools is not read here as the same parts, or a part is believed that the file does not carry. */
  it('reads the parts out of a file the company\'s own tools wrote, and out of the one it writes', async () => {
    const { proposalFileText } = await import('./governance-from-the-chain.js');
    const { recoveryFileOf } = await import('./records-recovered-here.js');
    expect(m.recoveryPartsInFile(proposalFileText(recoveryFileOf(parts)))).toEqual({ parts });
    expect(m.recoveryPartsInFile(m.recoveryFileTextOf(parts, 'x'))).toEqual({ parts });
  });

  /* RED WHEN: a file that is not a recovery's, or one with a part missing or mistaken, or one carrying signatures a recovery never has, is read as a recovery, or refused as the wrong kind of fault. */
  it('refuses a file that is not a recovery\'s, and says whether it could not be read or is another kind of change', () => {
    const good = JSON.parse(m.recoveryFileTextOf(parts, 'x')) as Record<string, unknown>;
    const unreadable = { why: 'unreadable' };
    const read = (over: Record<string, unknown>) => m.recoveryPartsInFile(JSON.stringify({ ...good, ...over }));
    expect(m.recoveryPartsInFile('not json')).toEqual(unreadable);
    expect(m.recoveryPartsInFile('[]')).toEqual(unreadable);
    expect(m.recoveryPartsInFile('null')).toEqual(unreadable);
    expect(read({ format: 'other' })).toEqual(unreadable);
    expect(read({ change: { kind: 'threshold', threshold: 2 } })).toEqual({ why: 'not-a-recovery' });
    expect(read({ change: undefined })).toEqual({ why: 'not-a-recovery' });
    expect(read({ company: '' })).toEqual(unreadable);
    expect(read({ summary: 5 })).toEqual(unreadable);
    expect(read({ salt: 'zz' })).toEqual(unreadable);
    expect(read({ resumesFrom: undefined })).toEqual(unreadable);
    expect(read({ resumesFrom: { seq: '4', head: parts.resumesFrom.head, root: parts.resumesFrom.root } })).toEqual(unreadable);
    expect(read({ resumesFrom: { seq: 4, head: 'ff'.repeat(32), root: parts.resumesFrom.root } })).toEqual(unreadable);
    expect(read({ change: { ...(good['change'] as object), latest: '0' } })).toEqual(unreadable);
    expect(read({ change: { ...(good['change'] as object), latest: 1793793600 } })).toEqual(unreadable);
    expect(read({ joined: [] })).toEqual(unreadable);
    expect(read({ signatures: [] })).toEqual(unreadable);
  });
});
