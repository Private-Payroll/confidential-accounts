// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvitationRefused } from 'vaults-web-shared/invitation-on-device.js';
import { anInvitation, ACCOUNT, COMPANY_NAME, LABEL, offerAnswer, PRIVATE_ADDRESS, PUBLIC_ADDRESS, RECORD, refusedAnswer, type Invitation } from './join-offers.test-support.js';

const wallet = vi.hoisted(() => ({
  origin: 'https://wallet.example', signedIn: true,
  act: vi.fn(), joinByCode: vi.fn(),
}));
vi.mock('./session.js', async (real) => ({
  ...(await real<typeof import('./session.js')>()),
  get ACCOUNT_ORIGIN() { return wallet.origin; },
}));
vi.mock('./keyring-person.js', () => ({ keyringFor: async () => wallet.signedIn }));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  actOnACompanyInTheWallet: wallet.act,
}));
vi.mock('vaults-web-shared/join-in-the-wallet.js', () => ({ joinByCodeInTheWallet: wallet.joinByCode }));

const { CLOSED, joinTheCompany, openTheInvitation, stoppedAs, WAY } = await import('./join.js');
type Opening = Awaited<ReturnType<typeof openTheInvitation>>;

const asked: string[] = [];
const serve = (answer: () => Response | Promise<Response>): void => {
  asked.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { asked.push(path); return answer(); }));
};
const open = (i: Invitation, id = i.id): Promise<Opening> => openTheInvitation(id, i.token, null);
const offeredOf = async (i: Invitation) => {
  serve(() => offerAnswer(i));
  const o = await open(i);
  if (o.of !== 'offered') throw new Error(`not offered: ${o.why}`);
  return o.offer;
};

beforeEach(() => { wallet.origin = 'https://wallet.example'; wallet.signedIn = true; wallet.act.mockReset(); wallet.joinByCode.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the join page opens the invitation its link carried', () => {
  /* RED WHEN: an employee invited by link is not offered the wallet's code way, or its facts are not read off the signed offer, or the read names the token. */
  it('offers an employee invited by link the code way, with the offer\'s facts', async () => {
    const i = anInvitation('employee');
    const offer = await offeredOf(i);
    expect(offer).toMatchObject({
      kind: 'employee', way: WAY.code, name: 'Priya Rao', title: 'Engineer', classification: 'full-time', startDate: '2026-10-01', endDate: '2027-03-31',
      address: null, companyName: COMPANY_NAME, record: RECORD, label: String(LABEL), account: ACCOUNT, role: null,
    });
    expect(asked).toEqual([`/api/invites/${i.id}/offer`]);
    expect(asked.join()).not.toContain(i.token);
  });

  /* RED WHEN: an employee invited at a private address is claimed as a public one, or the address the offer names is lost. */
  it('offers a payee invited at a private address the code way, naming the address', async () => {
    const offer = await offeredOf(anInvitation('employee', { address: PRIVATE_ADDRESS }));
    expect(offer).toMatchObject({ way: WAY.code, address: PRIVATE_ADDRESS });
  });

  /* RED WHEN: a vendor invited at a public address is given the code way, whose fingerprint a public address does not have. */
  it('offers a vendor invited at a public address the claim way', async () => {
    const offer = await offeredOf(anInvitation('vendor', { address: PUBLIC_ADDRESS }));
    expect(offer).toMatchObject({ kind: 'vendor', way: WAY.claim, address: PUBLIC_ADDRESS, title: null, classification: null });
  });

  /* RED WHEN: a signer invited at an address is not offered the seat way, or its role is lost. */
  it('offers a signer the seat way, with the role', async () => {
    expect(await offeredOf(anInvitation('signer'))).toMatchObject({ kind: 'signer', way: WAY.seat, role: 'approver', name: 'Dee' });
  });

  /* RED WHEN: an invitation this page cannot take (a super admin's, a re-issued seat, a signer's seat not made at an address) is offered. */
  it.each([
    ['a super admin\'s', anInvitation('super-admin'), CLOSED.superAdmin],
    ['a re-issued seat', anInvitation('reissue'), CLOSED.reissue],
    ['a signer\'s seat not made at an address', anInvitation('signer', { seatByLink: true }), CLOSED.seatByAddressOnly],
  ] as const)('does not offer %s', async (_what, i, why) => {
    serve(() => offerAnswer(i));
    expect(await open(i)).toEqual({ of: 'closed', why, expiresAt: null });
  });

  /* RED WHEN: a closed invitation's refusal is shown as another reason, or an unreachable service as a closed invitation. */
  it.each([
    [404, 'not-found', CLOSED.notFound], [410, 'withdrawn', CLOSED.withdrawn], [410, 'expired', CLOSED.expired], [410, 'used', CLOSED.used],
    [403, 'not-accepted', CLOSED.notAccepted], [503, 'busy', CLOSED.unreachable],
  ] as const)('says why the service closed it: %s %s', async (status, refused, why) => {
    const i = anInvitation('employee');
    serve(() => refusedAnswer(status, refused));
    expect(await open(i)).toEqual({ of: 'closed', why, expiresAt: null });
  });

  /* RED WHEN: a service that cannot be reached is taken for a closed invitation, or throws out of the page. */
  it('says the service is unreachable when the read fails', async () => {
    const i = anInvitation('employee');
    serve(() => { throw new TypeError('network'); });
    expect(await open(i)).toEqual({ of: 'closed', why: CLOSED.unreachable, expiresAt: null });
  });

  /* RED WHEN: an offer already past its time is opened, is shown as not opened, or carries the device's raw English instead of the page's expired words and its moment. */
  it('closes an expired offer as expired, with the moment it expired and none of the device\'s English', async () => {
    const i = anInvitation('employee', { expiresInMs: -1000 });
    serve(() => offerAnswer(i));
    const o = await open(i);
    expect(o).toEqual({ of: 'closed', why: CLOSED.expired, expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/u) });
    expect(JSON.stringify(o)).not.toMatch(/could not be opened|Nothing was sent/u);
  });

  /* RED WHEN: another refusal of the device (the service sent no sealed offer) is shown with the device's words, or as expired. */
  it('closes any other device refusal as not opened, with no words of the device\'s', async () => {
    const i = anInvitation('employee');
    serve(() => new Response(JSON.stringify({ expiresAt: '2030-01-01T00:00:00.000Z', kind: 'employee' }), { status: 200 }));
    expect(await open(i)).toEqual({ of: 'closed', why: CLOSED.notOpened, expiresAt: null });
  });

  /* RED WHEN: a link whose id is not the token's id is opened, or anything is asked of the service for it. */
  it('does not ask the service for an id the token does not make', async () => {
    const i = anInvitation('employee');
    serve(() => offerAnswer(i));
    expect(await open(i, 'a'.repeat(64))).toMatchObject({ of: 'closed', why: CLOSED.notOpened });
    expect(asked).toEqual([]);
  });

  /* RED WHEN: a refusal of the service stops carrying its code and the page's words. */
  it('keeps the service\'s refusal on the error the device throws', () => {
    expect(new InvitationRefused(410, 'used', 'said').refused).toBe('used');
  });
});

describe('the wallet act the page runs', () => {
  const FIELDS = (offer: { record: string; label: string; account: string; token: string }) =>
    ({ record: offer.record, company: offer.label, account: offer.account, token: offer.token });

  /* RED WHEN: a signer's join asks the wallet for anything but seat-invited with the four fields of the offer, or is not told done. */
  it('runs seat-invited for a signer, with the company and the token only', async () => {
    const offer = await offeredOf(anInvitation('signer'));
    wallet.act.mockResolvedValue({ of: 'done', steps: 2, relayed: 1 });
    expect(await joinTheCompany('u1', offer)).toEqual({ of: 'done' });
    expect(wallet.act).toHaveBeenCalledTimes(1);
    expect(wallet.act.mock.calls[0]![0]).toEqual({ name: 'seat-invited', ...FIELDS(offer) });
    expect(wallet.act.mock.calls[0]![1]).toBe('https://wallet.example');
  });

  /* RED WHEN: an employee by code is sent to any wallet act but join-by-code, or the claim act runs for it. */
  it('runs join-by-code for a payee by link', async () => {
    const offer = await offeredOf(anInvitation('employee'));
    wallet.joinByCode.mockResolvedValue({ of: 'done', steps: 1, relayed: 1 });
    expect(await joinTheCompany('u1', offer)).toEqual({ of: 'done' });
    expect(wallet.joinByCode.mock.calls[0]![0]).toEqual(FIELDS(offer));
    expect(wallet.act).not.toHaveBeenCalled();
  });

  /* RED WHEN: a payee invited at a public address does not claim with the address the offer named. */
  it('runs claim-by-address for a payee at a public address, with that address', async () => {
    const offer = await offeredOf(anInvitation('vendor', { address: PUBLIC_ADDRESS }));
    wallet.act.mockResolvedValue({ of: 'done', steps: 1, relayed: 1 });
    expect(await joinTheCompany('u1', offer)).toEqual({ of: 'done' });
    expect(wallet.act.mock.calls[0]![0]).toEqual({ name: 'claim-by-address', ...FIELDS(offer), address: PUBLIC_ADDRESS });
    expect(wallet.joinByCode).not.toHaveBeenCalled();
  });

  /* RED WHEN: the steps the wallet reports are not handed to the page as they come. */
  it('hands each step to the page as the wallet reports it', async () => {
    const offer = await offeredOf(anInvitation('signer'));
    const seen: unknown[] = [];
    wallet.act.mockImplementation(async (_i: unknown, _o: unknown, opts: { onStep: (at: unknown) => void }) => { opts.onStep({ step: 1, steps: 2 }); return { of: 'done', steps: 2, relayed: 0 }; });
    await joinTheCompany('u1', offer, (at) => seen.push(at));
    expect(seen).toEqual([{ step: 1, steps: 2 }]);
  });

  /* RED WHEN: a stop of the wallet is told as done, or loses where it stopped or the reason it ended with. */
  it('tells a stop with its step and the reason the wallet ended with', async () => {
    const offer = await offeredOf(anInvitation('signer'));
    wallet.act.mockResolvedValue({ of: 'stopped', step: 1, steps: 2, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.seat-invited.why.already-seated' });
    expect(await joinTheCompany('u1', offer)).toEqual({ of: 'stopped', why: 'already-seated', step: 1, steps: 2, handedOver: false });
  });

  /* RED WHEN: a stop after transactions the wallet handed the page (sent, or not confirmed) is told as one that handed none, or the reverse. */
  it('says a stop handed transactions over when any were sent or left unconfirmed, and none when none were', async () => {
    const offer = await offeredOf(anInvitation('signer'));
    for (const [relayed, unconfirmed, handedOver] of [[0, 0, false], [1, 0, true], [0, 1, true]] as const) {
      wallet.act.mockResolvedValue({ of: 'stopped', step: 3, steps: 4, relayed, unconfirmed, why: 'relay-refused', refused: 'act.seat-invited.why.not-sent' });
      expect(await joinTheCompany('u1', offer), `${relayed}/${unconfirmed}`).toEqual({ of: 'stopped', why: 'not-sent', step: 3, steps: 4, handedOver });
    }
  });

  /* RED WHEN: a reason outside the page's list is passed on as its own words, or a key of another shape is read. */
  it('reads only keys of the wallet\'s shape, and the page\'s own list', () => {
    expect(stoppedAs('act.join-by-code.why.used-by-this-wallet')).toBe('used-by-this-wallet');
    expect(stoppedAs('act.seat-invited.why.something-new')).toBe('other');
    expect(stoppedAs('already-seated')).toBe('other');
    expect(stoppedAs(undefined)).toBe('other');
  });

  /* RED WHEN: a site with no wallet is told anything but that it is not set up, or the wallet is asked anyway. */
  it('refuses, saying the site is not set up, before asking the wallet', async () => {
    const offer = await offeredOf(anInvitation('signer'));
    wallet.origin = '';
    expect(await joinTheCompany('u1', offer)).toEqual({ of: 'refused', why: 'not-set-up' });
    expect(wallet.act).not.toHaveBeenCalled();
  });

  /* RED WHEN: a person whose sign-in this tab cannot confirm is sent to the wallet. */
  it('refuses a person this tab cannot confirm, before asking the wallet', async () => {
    const offer = await offeredOf(anInvitation('employee'));
    wallet.signedIn = false;
    expect(await joinTheCompany('u1', offer)).toEqual({ of: 'refused', why: 'not-signed-in' });
    expect(wallet.joinByCode).not.toHaveBeenCalled();
  });

  /* RED WHEN: a wallet that throws is left to throw out of the page instead of becoming a refusal. */
  it('turns a thrown failure into a refusal', async () => {
    const offer = await offeredOf(anInvitation('signer'));
    wallet.act.mockRejectedValue(new TypeError('network'));
    expect(await joinTheCompany('u1', offer)).toEqual({ of: 'refused', why: 'unreachable' });
  });
});
