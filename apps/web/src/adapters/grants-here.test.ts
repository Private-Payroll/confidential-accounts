// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { newSymmetricKey, sign, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { entriesInOrder, grantEntryOf, grantsMessage, type GrantEntry } from '../../../../src/midnight/grants-record.js';
import { ACT_REFUSAL } from './refusals.js';

/*
 * THE READ ACCESS PAGE'S READ OF THE GRANTS AND ITS ASKS OF THE WALLET: who reads now, what waits for more signers and how many have
 * signed it (counted from the signatures themselves), what a give, a take-away and a signature on a waiting change send, and what the
 * page says the wallet's stops come to. The keyring, the wallet and the shared grants reader are stood in for; the counting and the
 * page's own choices are the product's.
 */
const COMPANY = 'c-1';
const ACCOUNT = 'c0'.repeat(32);
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, seat: null as unknown, grants: null as unknown,
  after: null as unknown, reads: 0, fail: null as Error | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => kr.named,
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => { kr.acts.push(intent); return kr.ended; },
}));
vi.mock('./vault-private-money.js', async (real) => ({
  ...(await real<typeof import('./vault-private-money.js')>()),
  seatAndRecordsHere: async () => kr.seat,
}));
vi.mock('vaults-web-shared/purpose-wraps.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/purpose-wraps.js')>()),
  grantsHere: async () => {
    kr.reads += 1;
    if (kr.fail !== null) throw kr.fail;
    return kr.reads > 1 && kr.after !== null ? kr.after : kr.grants;
  },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./grants-here.js');
}

const SECRETS = [newSymmetricKey(), newSymmetricKey(), newSymmetricKey()];
const SEATS = SECRETS.map((secret, i) => ({
  seat: `0${i + 1}`.padEnd(64, '0'), person: `p${i + 1}`, signingKey: signingPublicKeyOf(secret).toLowerCase() as Hex, wrappingKey: 'ab'.repeat(32) as Hex,
  role: 'admin' as const, retired: null,
}));
const HERE = { leaf: SEATS[1]!.seat };
const key = (n: number): Hex => n.toString(16).padStart(64, '0') as Hex;
const RHEA = grantEntryOf({ recipient: key(5), person: 'rhea', role: 'accountant' });
const ABE = grantEntryOf({ recipient: key(6), person: 'abe', role: 'limited' });
const signedBy = (sequence: number, entries: readonly GrantEntry[], who: readonly number[]) => {
  const ordered = entriesInOrder(entries);
  const message = grantsMessage(COMPANY, { sequence, entries: ordered });
  return { sequence, entries: ordered, wraps: {}, signatures: who.map((i) => ({ publicKey: SEATS[i]!.signingKey, signature: sign(message, SECRETS[i]!) })) };
};
const grantsWith = (over: { inForce?: readonly GrantEntry[]; waiting?: ReturnType<typeof signedBy> | null; bar?: number }) => ({
  inForce: { version: 1, keyEpoch: 0, grants: signedBy(1, over.inForce ?? [RHEA], [0, 1]) },
  waiting: over.waiting === null || over.waiting === undefined ? null : { version: 2, keyEpoch: 0, grants: over.waiting },
  revokedAt: null, refused: new Map(),
  here: { dir: { seats: SEATS }, holders: { seats: SEATS.map((s) => s.seat), seatBar: over.bar ?? 2 } },
  highest: 2, inForceSealedTo: [],
});
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({ of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', ...(refused === undefined ? {} : { refused }), ...over });
const reset = (): void => {
  kr.user = { id: 'u1' }; kr.acts = []; kr.ended = { of: 'done', steps: 1, relayed: 0 }; kr.seat = HERE; kr.after = null; kr.reads = 0; kr.fail = null;
  kr.grants = grantsWith({});
};

describe('what the page reads of the read grants', () => {
  /* RED WHEN: a reader the grants in force name is missing from the page's list, or a reader's key is not the one the grants hold it under. */
  it('lists the readers in force with their person, role and key', async () => {
    reset();
    const { readGrants, GRANTS_READ } = await load();
    const read = await readGrants('u1', COMPANY);
    expect(read).toEqual({ of: GRANTS_READ.read, readers: [{ recipient: key(5), person: 'rhea', role: 'accountant' }], waiting: null });
  });

  /* RED WHEN: a change waiting for more signers is not shown as what it gives and what it takes away, or its count is not the signers who signed it. */
  it('shows a waiting give with how many signed of how many are needed, and whether this seat signed', async () => {
    reset();
    kr.grants = grantsWith({ inForce: [RHEA], waiting: signedBy(2, [RHEA, ABE], [0]) });
    const { readGrants } = await load();
    const read = await readGrants('u1', COMPANY);
    expect(read).toMatchObject({ waiting: { gives: [{ recipient: key(6), person: 'abe', role: 'limited' }], takesAway: [], signed: 1, needed: 2, mine: false } });
    kr.grants = grantsWith({ inForce: [RHEA], waiting: signedBy(2, [RHEA, ABE], [0, 1]), bar: 3 });
    expect(await readGrants('u1', COMPANY)).toMatchObject({ waiting: { signed: 2, needed: 3, mine: true } });
  });

  /* RED WHEN: a waiting take-away is shown as a give, or the reader it ends is lost. */
  it('shows a waiting take-away as the reader it ends', async () => {
    reset();
    kr.grants = grantsWith({ inForce: [RHEA, ABE], waiting: signedBy(2, [RHEA], [2]) });
    const { readGrants } = await load();
    expect(await readGrants('u1', COMPANY)).toMatchObject({ waiting: { gives: [], takesAway: [{ recipient: key(6), person: 'abe', role: 'limited' }], signed: 1, mine: false } });
  });

  /* RED WHEN: a signature that does not verify is counted, or the count is shown as a number when it could not be made. */
  it('shows no count when a signature on the waiting change does not verify', async () => {
    reset();
    const w = signedBy(2, [RHEA, ABE], [0]);
    kr.grants = grantsWith({ inForce: [RHEA], waiting: { ...w, signatures: [{ ...w.signatures[0]!, signature: '00'.repeat(64) }] } });
    const { readGrants } = await load();
    expect(await readGrants('u1', COMPANY)).toMatchObject({ waiting: { signed: null, needed: 2 } });
  });

  /* RED WHEN: a page that has no company key released reads the grants anyway, or says nothing about why they were not read. */
  it('refuses with the seat read\'s own reason, and with the reason the grants could not be read', async () => {
    reset();
    kr.seat = ACT_REFUSAL.noKeysHere;
    const { readGrants, GRANTS_READ } = await load();
    expect(await readGrants('u1', COMPANY)).toEqual({ of: GRANTS_READ.refused, why: ACT_REFUSAL.noKeysHere });
    expect(kr.reads).toBe(0);
    kr.seat = HERE; kr.fail = new Error('withheld');
    expect(await readGrants('u1', COMPANY)).toMatchObject({ of: GRANTS_READ.refused });
  });
});

describe('what the page asks of the wallet', () => {
  const NAMED = { name: 'grant-read', record: COMPANY, company: 'label-1', account: ACCOUNT };

  /* RED WHEN: a give carries a key the page chose, or loses the reader's code or role. */
  it('sends a give as the reader\'s code and role, never a key', async () => {
    reset();
    const { giveReadAccess } = await load();
    const ended = await giveReadAccess('u1', COMPANY, { code: ' abc ', role: 'limited' });
    expect(kr.acts).toEqual([{ ...NAMED, code: 'abc', role: 'limited' }]);
    expect(ended).toEqual({ of: 'done', state: null, signed: null, needed: null });
  });

  /* RED WHEN: a give with no code or with a role that is not a reader's reaches the wallet. */
  it('asks nothing of the wallet for a give it can see is not one', async () => {
    reset();
    const { giveReadAccess, GRANT_ACTED } = await load();
    expect(await giveReadAccess('u1', COMPANY, { code: '  ', role: 'limited' })).toEqual({ of: GRANT_ACTED.problem, problem: 'no-code' });
    expect(await giveReadAccess('u1', COMPANY, { code: 'abc', role: 'admin' })).toEqual({ of: GRANT_ACTED.problem, problem: 'no-role' });
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: a take-away carries a code, or does not name the reader's key as the grants in force hold it, or leaves out the choice. */
  it('sends a take-away as the reader\'s key and the choice to take away', async () => {
    reset();
    const { takeAwayReadAccess } = await load();
    await takeAwayReadAccess('u1', COMPANY, key(0xab).toUpperCase());
    expect(kr.acts).toEqual([{ ...NAMED, recipient: key(0xab), away: 'yes' }]);
  });

  /* RED WHEN: the page is not told where the change stands, or how many have signed. */
  it('hands back where the change stands, how many signed and how many are needed', async () => {
    reset();
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'waiting-for-signers', filed: 1, needed: 2 } };
    const { giveReadAccess } = await load();
    expect(await giveReadAccess('u1', COMPANY, { code: 'abc', role: 'limited' })).toEqual({ of: 'done', state: 'waiting-for-signers', signed: 1, needed: 2 });
  });

  /* RED WHEN: a wallet's stop is shown as the wrong reason, or a stop that may have part-filed is not marked so. */
  it('says why the wallet stopped, and whether part of it may have gone through', async () => {
    reset();
    const { giveReadAccess } = await load();
    const why = async (refused?: string, over: Record<string, unknown> = {}) => { kr.ended = stopped(refused, over); return giveReadAccess('u1', COMPANY, { code: 'abc', role: 'limited' }); };
    expect(await why('act.grant-read.why.code-not-signed')).toEqual({ of: 'stopped', why: 'code-not-signed', partial: false, handedOver: false });
    expect(await why('act.grant-read.why.code-another-company')).toMatchObject({ why: 'code-another-company' });
    expect(await why('act.grant-read.why.not-a-reader-code')).toMatchObject({ why: 'not-a-code' });
    expect(await why('act.grant-read.why.filed-meanwhile')).toMatchObject({ why: 'filed-meanwhile', partial: false });
    expect(await why('act.grant-read.why.no-seat')).toMatchObject({ why: 'seat' });
    expect(await why('act.grant-read.why.not-filed')).toMatchObject({ why: 'not-filed', partial: true });
    expect(await why(undefined, { relayed: 1 })).toMatchObject({ why: 'stopped', partial: true, handedOver: true });
    expect(await why('act.grant-read.why.something-new')).toMatchObject({ why: 'other', partial: true });
  });

  /* RED WHEN: a signed-out page or a company with no wallet record still asks the wallet. */
  it('refuses before asking when nobody is signed in or the company is not named', async () => {
    reset();
    const { giveReadAccess, GRANT_ACTED } = await load();
    kr.named = null;
    expect(await giveReadAccess('u1', COMPANY, { code: 'abc', role: 'limited' })).toMatchObject({ of: GRANT_ACTED.refused });
    kr.named = { companyLabel: 'label-1', contractAddress: ACCOUNT };
    expect(kr.acts).toEqual([]);
  });
});

describe('signing a waiting change from a second seat', () => {
  const waitingGive = async () => {
    const { readGrants } = await load();
    const read = await readGrants('u1', COMPANY);
    if (read.of !== 'read' || read.waiting === null) throw new Error('no waiting change');
    return read.waiting;
  };
  const before = () => { reset(); kr.grants = grantsWith({ inForce: [RHEA], waiting: signedBy(2, [RHEA, ABE], [0]) }); };

  /* RED WHEN: the page says a second seat's signature counted when the waiting change still carries only the first seat's. */
  it('says the waiting change carries this seat\'s signature once it does', async () => {
    before();
    const waiting = await waitingGive();
    kr.after = grantsWith({ inForce: [RHEA], waiting: signedBy(2, [RHEA, ABE], [0, 1]), bar: 3 });
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'waiting-for-signers', filed: 2, needed: 3 } };
    const { approveWaitingChange } = await load();
    const ended = await approveWaitingChange('u1', COMPANY, { code: 'abc', role: 'limited' }, waiting);
    expect(kr.acts).toEqual([{ name: 'grant-read', record: COMPANY, company: 'label-1', account: ACCOUNT, code: 'abc', role: 'limited' }]);
    expect(ended).toMatchObject({ acted: { of: 'done', state: 'waiting-for-signers' }, carries: 'signed' });
  });

  /* RED WHEN: a code that made another change is told as the waiting change signed. */
  it('says that is not the waiting change when the code made a different entry', async () => {
    before();
    const waiting = await waitingGive();
    const other = grantEntryOf({ recipient: key(7), person: 'zed', role: 'limited' });
    kr.after = grantsWith({ inForce: [RHEA], waiting: signedBy(2, [RHEA, other], [1]) });
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'waiting-for-signers', filed: 1, needed: 2 } };
    const { approveWaitingChange } = await load();
    expect(await approveWaitingChange('u1', COMPANY, { code: 'zzz', role: 'limited' }, waiting)).toMatchObject({ carries: 'not-the-waiting-change' });
  });

  /* RED WHEN: the page says this seat signed when the change that waits still carries only the other signer's signature. */
  it('does not say it signed when this seat\'s signature is not on the waiting change', async () => {
    before();
    const waiting = await waitingGive();
    kr.after = grantsWith({ inForce: [RHEA], waiting: signedBy(2, [RHEA, ABE], [0]) });
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'waiting-for-signers', filed: 1, needed: 2 } };
    const { approveWaitingChange } = await load();
    expect(await approveWaitingChange('u1', COMPANY, { code: 'abc', role: 'limited' }, waiting)).toMatchObject({ carries: 'not-the-waiting-change' });
  });

  /* RED WHEN: a role other than the waiting change's makes the page say it signed that change. */
  it('says that is not the waiting change when the role differs', async () => {
    before();
    const waiting = await waitingGive();
    const other = grantEntryOf({ recipient: key(6), person: 'abe', role: 'accountant' });
    kr.after = grantsWith({ inForce: [RHEA], waiting: signedBy(2, [RHEA, other], [1]) });
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'waiting-for-signers', filed: 1, needed: 2 } };
    const { approveWaitingChange } = await load();
    expect(await approveWaitingChange('u1', COMPANY, { code: 'abc', role: 'accountant' }, waiting)).toMatchObject({ carries: 'not-the-waiting-change' });
  });

  /* RED WHEN: a change that reached the bar is told as still waiting. */
  it('says the change is in force when the wallet says so, without reading again', async () => {
    before();
    const waiting = await waitingGive();
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'in-force', filed: 2, needed: 2 } };
    const { approveWaitingChange } = await load();
    expect(await approveWaitingChange('u1', COMPANY, { code: 'abc', role: 'limited' }, waiting)).toMatchObject({ carries: 'in-force' });
    expect(kr.reads).toBe(1);
  });

  /* RED WHEN: a take-away waiting for more signers cannot be signed from a second seat by the reader as the grants hold them. */
  it('signs a waiting take-away by the reader\'s key as it stands', async () => {
    reset();
    kr.grants = grantsWith({ inForce: [RHEA, ABE], waiting: signedBy(2, [RHEA], [0]) });
    const waiting = await waitingGive();
    kr.after = grantsWith({ inForce: [RHEA, ABE], waiting: signedBy(2, [RHEA], [0, 1]), bar: 3 });
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'waiting-for-signers', filed: 2, needed: 3 } };
    const { approveWaitingChange } = await load();
    expect(await approveWaitingChange('u1', COMPANY, { takeAway: key(6) }, waiting)).toMatchObject({ carries: 'signed' });
    expect(kr.acts.at(-1)).toEqual({ name: 'grant-read', record: COMPANY, company: 'label-1', account: ACCOUNT, recipient: key(6), away: 'yes' });
  });

  /* RED WHEN: a signature the wallet gave is told as counted when the grants cannot be read again to check it. */
  it('says it could not check when the grants cannot be read again', async () => {
    before();
    const waiting = await waitingGive();
    kr.fail = new Error('withheld');
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'waiting-for-signers', filed: 2, needed: 3 } };
    const { approveWaitingChange } = await load();
    expect(await approveWaitingChange('u1', COMPANY, { code: 'abc', role: 'limited' }, waiting)).toMatchObject({ carries: 'unread' });
  });

  /* RED WHEN: a stop of the wallet is told as a signature, so the page says the change carries this seat's signature. */
  it('says nothing about the change when the wallet stopped', async () => {
    before();
    const waiting = await waitingGive();
    kr.ended = stopped('act.grant-read.why.code-not-signed');
    const { approveWaitingChange } = await load();
    expect(await approveWaitingChange('u1', COMPANY, { code: 'abc', role: 'limited' }, waiting)).toEqual({
      acted: { of: 'stopped', why: 'code-not-signed', partial: false, handedOver: false }, carries: null,
    });
  });
});
