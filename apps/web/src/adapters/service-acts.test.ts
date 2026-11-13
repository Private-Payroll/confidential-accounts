// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Hex } from '../../../../src/core/crypto.js';
import { ACT_REFUSAL } from './refusals.js';

/*
 * THE SERVICE PAGE'S READ OF THE COMPANY'S CHOICE AND ITS ASK OF THE WALLET: the choice in force, the choice being asked for and which
 * seats have filed it, a choice that cannot be read whole and whether it may be filed over, what a filing sends, and what the page says
 * the wallet's stops come to. The keyring, the wallet and the shared reader of the versions are stood in for; the counting of who filed
 * and the page's own choices are the product's.
 */
const COMPANY = 'c-1';
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, seat: null as unknown, filed: null as unknown,
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
vi.mock('vaults-web-shared/company-service-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/company-service-here.js')>()),
  companyServiceFiledHere: async () => kr.filed,
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./service-acts.js');
}

const key = (n: number): Hex => n.toString(16).padStart(64, '0') as Hex;
const SEATS = [1, 2, 3].map((n) => ({ seat: `0${n}`.padEnd(64, '0'), signingKey: key(n) }));
const HERE = {
  leaf: SEATS[1]!.seat, company: 'label-1', account: 'c0'.repeat(32), viewingKey: {}, opened: { signers: [] }, mine: { signerId: 'x', wrappingSecret: key(9) },
  directory: async () => ({ dir: { seats: SEATS } }),
};
const OWN = { service: 'own' as const, at: 'https://service.example.com' };
const filedBy = (version: number, who: number, choice: unknown) => ({ version, filer: key(who), choice });
const reset = (): void => { kr.user = { id: 'u1' }; kr.acts = []; kr.ended = { of: 'done', steps: 1, relayed: 0 }; kr.seat = HERE; kr.filed = { versions: [], needed: 2, highest: 0 }; };
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({ of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', ...(refused === undefined ? {} : { refused }), ...over });

describe('what the page reads of the company\'s choice of service', () => {
  /* RED WHEN: a company that filed nothing is shown as having chosen, or is not told its calls go through ours. */
  it('says nothing was chosen and that the calls go through ours', async () => {
    reset();
    const { readService, SERVICE_READ } = await load();
    const read = await readService('u1', COMPANY);
    expect(read).toMatchObject({ of: SERVICE_READ.read, inForce: { service: 'ours' }, asked: null });
    expect(read.of === SERVICE_READ.read && read.unchosen).toMatch(/not chosen/u);
  });

  /* RED WHEN: a choice filed by too few signers is shown in force, or the seats that filed it, this device's own among them, are not named. */
  it('shows a choice filed by one of two needed as asked, not in force, naming who filed it and which seat is this device\'s', async () => {
    reset();
    kr.filed = { versions: [filedBy(1, 2, OWN)], needed: 2, highest: 1 };
    const { readService, SERVICE_READ } = await load();
    expect(await readService('u1', COMPANY)).toMatchObject({
      of: SERVICE_READ.read, inForce: { service: 'ours' }, asked: { choice: OWN, needed: 2, filers: [{ seat: SEATS[1]!.seat, you: true }] },
    });
  });

  /* RED WHEN: the choice in force is not the one the needed number of signers filed, or the filers of an earlier, different choice are counted for it. */
  it('puts a choice in force once enough seats filed it and counts only the seats that filed the newest choice', async () => {
    reset();
    kr.filed = { versions: [filedBy(1, 2, { service: 'none' }), filedBy(2, 1, OWN), filedBy(3, 3, OWN)], needed: 2, highest: 3 };
    const { readService, SERVICE_READ } = await load();
    expect(await readService('u1', COMPANY)).toMatchObject({
      of: SERVICE_READ.read, inForce: OWN, unchosen: null,
      asked: { choice: OWN, filers: [{ seat: SEATS[0]!.seat, you: false }, { seat: SEATS[2]!.seat, you: false }] },
    });
  });

  /* RED WHEN: a choice that cannot be read whole is shown as ours, or a page that may file over it is told it may not. */
  it('says a choice that cannot be read whole is unread, and whether it may be filed over', async () => {
    reset();
    const { readService, SERVICE_READ } = await load();
    kr.filed = { unread: 'the service did not give version 2', fileOver: { versions: [], needed: 2, highest: 2 } };
    expect(await readService('u1', COMPANY)).toEqual({ of: SERVICE_READ.unread, why: 'the service did not give version 2', canFileOver: true });
    kr.filed = { unread: 'withheld' };
    expect(await readService('u1', COMPANY)).toEqual({ of: SERVICE_READ.unread, why: 'withheld', canFileOver: false });
  });

  /* RED WHEN: a device with no seat or no keys is shown a choice, or a read that throws escapes the page. */
  it('says why a device with no seat reads nothing', async () => {
    reset();
    kr.seat = ACT_REFUSAL.noKeysHere;
    const { readService, SERVICE_READ } = await load();
    expect(await readService('u1', COMPANY)).toEqual({ of: SERVICE_READ.refused, why: ACT_REFUSAL.noKeysHere });
    kr.seat = { ...HERE, directory: async () => { throw new Error('down'); } };
    expect((await readService('u1', COMPANY)).of).toBe(SERVICE_READ.refused);
  });
});

describe('what the page asks of the wallet when the choice is filed', () => {
  /* RED WHEN: the act is not the wallet's choose-company-service, or its address is sent for a choice that names none. */
  it('sends the choice and, for the company\'s own service, its address', async () => {
    reset();
    const { chooseService, SERVICE_ACTED, SERVICE_STATE } = await load();
    kr.ended = { of: 'done', steps: 4, relayed: 0, outcome: { state: SERVICE_STATE.waiting, filed: 1, needed: 2 } };
    expect(await chooseService('u1', COMPANY, OWN)).toEqual({ of: SERVICE_ACTED.done, state: 'waiting-for-signers', filed: 1, needed: 2 });
    await chooseService('u1', COMPANY, { service: 'none' });
    expect(kr.acts.map((a) => ({ name: a['name'], service: a['service'], at: a['at'] }))).toEqual([
      { name: 'choose-company-service', service: 'own', at: OWN.at }, { name: 'choose-company-service', service: 'none', at: undefined },
    ]);
  });

  /* RED WHEN: a choice that is no choice, or an address that is not a site's https address, opens the wallet. */
  it('opens no wallet for a choice that is not one', async () => {
    reset();
    const { chooseService, SERVICE_ACTED } = await load();
    expect(await chooseService('u1', COMPANY, { service: 'own', at: 'http://x.example.com' })).toEqual({ of: SERVICE_ACTED.problem, problem: 'not-an-address' });
    expect(await chooseService('u1', COMPANY, { service: 'own', at: '' })).toEqual({ of: SERVICE_ACTED.problem, problem: 'not-an-address' });
    expect(await chooseService('u1', COMPANY, { service: 'sideways' as 'none' })).toEqual({ of: SERVICE_ACTED.problem, problem: 'not-a-choice' });
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: a stop of the wallet is told as another, or one after which the choice may be filed is not marked partial. */
  it('tells each stop of the wallet by its code', async () => {
    reset();
    const { chooseService, SERVICE_ACTED, SERVICE_WHY } = await load();
    const why = async (code: string | undefined, over: Record<string, unknown> = {}) => {
      kr.ended = stopped(code === undefined ? undefined : `act.choose-company-service.why.${code}`, over);
      return chooseService('u1', COMPANY, OWN);
    };
    expect(await why('role-may-not-file')).toEqual({ of: SERVICE_ACTED.stopped, why: SERVICE_WHY.mayNotFile, partial: false, handedOver: false });
    expect(await why('filed-meanwhile')).toMatchObject({ why: SERVICE_WHY.filedMeanwhile, partial: false });
    expect(await why('unread')).toMatchObject({ why: SERVICE_WHY.unread });
    expect(await why('no-seat')).toMatchObject({ why: SERVICE_WHY.seat });
    expect(await why('not-entered')).toMatchObject({ why: SERVICE_WHY.notEntered, partial: true });
    expect(await why('somewhere-new')).toMatchObject({ why: SERVICE_WHY.other, partial: true });
    expect(await why(undefined, { relayed: 1 })).toMatchObject({ why: SERVICE_WHY.stopped, handedOver: true });
  });

  /* RED WHEN: a device that is not signed in, or has no wallet to ask, files anything. */
  it('refuses a person who is not signed in', async () => {
    reset();
    kr.user = null;
    const { chooseService, SERVICE_ACTED } = await load();
    expect((await chooseService('u1', COMPANY, OWN)).of).toBe(SERVICE_ACTED.refused);
    expect(kr.acts).toEqual([]);
  });
});
