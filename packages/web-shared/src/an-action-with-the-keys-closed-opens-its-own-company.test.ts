import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { x25519 } from '@noble/curves/ed25519.js';
import { identityFromWords } from 'midnight-identity';
import { ACT_ENDED_SCHEMA, READY_PING } from 'midnight-identity/profile/channel';
import { drawCompanyLabel, type AccountAddress } from 'midnight-identity/profile/company-label';
import { parseAsk, type ActRequest, type KeyringRequest } from 'midnight-identity/profile/request';
import { keyringHolderFor } from 'midnight-identity/profile/unlock';
import { fromHex, randomBytes, toHex, wrapKey } from '../../../src/core/crypto.js';
import { inboxPublicKey } from '../../../src/core/sealed-records.js';
import { invitationIdOf, invitationLink } from '../../../src/core/invitation.js';
import { keyringAsTheWalletAnswers, savedKeysSealKey } from '../../../src/testing/a-wallet-founds-a-company.js';
import * as keyring from './keyring.js';
import { inviteInTheWallet, type InviteAsk } from './invite-in-the-wallet.js';
import { admitSignerInTheWallet, approveSignerInTheWallet } from './signer-in-the-wallet.js';
import { joinByCodeInTheWallet } from './join-in-the-wallet.js';
import { admitPersonInTheWallet, changePersonInTheWallet } from './person-in-the-wallet.js';
import { withCompanyKeys } from './governed-call-on-device.js';
import { metadataOf, openKeyring, sealKeyring, seatsOf, servedKeysOpenedFrom } from './keyring-blob.js';
import type { Openable } from './wallet-sign-in.js';

/*
 * **A CREATE VAULT OR A FINISH PRESSED WITH THE KEYS CLOSED LEAVES THE PAGE ITS OWN COMPANY OPEN.** The tab hands the
 * wallet the action's own company's served keys with the ask; the wallet's end answer gives that company's viewing key
 * (opened and believed as a keyring answer's is) with its seat's public halves; the tab takes them as a read of that
 * company alone. So opening the company and reading its new vault ask the wallet for nothing more, and every other
 * company still waits for the wallet to read the saved keys.
 */
const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const A = { id: 'usr_a', email: null, name: 'Priya' };
const identity = identityFromWords(TEST_MNEMONIC);
const OWN = 'acc_OwnCompany01';
const OTHER = 'acc_OtherCompany';
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const seat = (n: string) => ({
  signerId: `sig_${n}`, signingSecret: toHex(randomBytes(32)), wrappingSecret: toHex(randomBytes(32)), blinding: toHex(randomBytes(32)), scope: '44'.repeat(32),
});
const SEATS: Record<string, ReturnType<typeof seat>> = { [OWN]: seat('own'), [OTHER]: seat('other') };
const VIEWING: Record<string, string> = { [OWN]: toHex(randomBytes(32)), [OTHER]: toHex(randomBytes(32)) };
const KEY = savedKeysSealKey(identity, { requester: { origin: US, name: 'x', rdns: 'x' }, person: A.id } as never);
const BUNDLE = sealKeyring({ accounts: SEATS }, KEY as never).sealed;
const listed = (inboxOf: (id: string) => string) => [OWN, OTHER].map((id) => ({
  id, inboxPublicKey: inboxOf(id),
  wrappedKeys: [{ signerId: SEATS[id]!.signerId, ...wrapKey(VIEWING[id]!, toHex(x25519.getPublicKey(fromHex(SEATS[id]!.wrappingSecret)))) }],
}));

/** A wallet that answers an action as this wallet's code does: what the saved keys hold that is not secret, and the served keys it believes. */
class Wallet implements Openable {
  readonly asks: Array<{ kind: string; body: unknown }> = [];
  /** When set, the end answer gives this company's key in place of the one the action is about, and this value for it. */
  givesTheKeyOf: string | null = null;
  givesTheValue: string | null = null;
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => { void this.onAsk(m); } };
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void { this.handler = h; queueMicrotask(() => this.deliver({ schema: READY_PING })); }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void { this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent); }
  private async onAsk(message: unknown): Promise<void> {
    let answer: unknown = { schema: 'nothing-given' };
    try {
      const ask = parseAsk(message, US, Date.now());
      this.asks.push({ kind: ask.kind, body: ask });
      if (ask.kind === 'keyring') {
        answer = keyringAsTheWalletAnswers(identity, ask as KeyringRequest, (a) => a === ADDRESS);
      } else if (ask.kind === 'act') {
        const a = ask as ActRequest;
        const k = openKeyring(a.keyring!.sealed as never, KEY as never);
        answer = {
          schema: ACT_ENDED_SCHEMA, nonce: a.nonce, intent: a.intent.name, ended: 'done', step: 1, steps: 1, relayed: 0, unconfirmed: 0,
          keys: {
            seats: seatsOf(k),
            viewing: this.givesTheKeyOf === null ? servedKeysOpenedFrom(k, a.served ?? [])
              : { [this.givesTheKeyOf]: this.givesTheValue ?? VIEWING[this.givesTheKeyOf] },
            metadata: metadataOf(k),
            holder: keyringHolderFor(identity, a as never), resealed: null,
          },
        };
      }
    } catch { /* answered as nothing given */ }
    queueMicrotask(() => this.deliver(answer));
  }
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });
const aService = (inboxOf: (id: string) => string = (id) => inboxPublicKey(VIEWING[id]!, id)) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (route === 'GET /api/me/keys') return json(200, { keyBundle: BUNDLE, version: 1 });
    if (route === 'GET /api/accounts') return json(200, listed(inboxOf));
    if (route === `POST /api/accounts/${OWN}/unlock`) return json(200, { company: LABEL, account: ACCOUNT });
    return json(404, { error: `no route for ${route}` });
  }) as typeof fetch;
};
const signIn = () => keyring.signedInByAnotherScreen({ user: A, address: ADDRESS, created: true, session: {} });
const createVault = (wallet: Wallet) => keyring.actOnACompanyInTheWallet(
  { name: 'create-vault', record: OWN, company: LABEL, account: ACCOUNT }, WALLET, {}, wallet);
const finish = (wallet: Wallet) => keyring.finishCompanyInTheWallet(OWN, WALLET, {}, wallet, US);

/** What opening the company and reading its vault turn on in this tab: its seat, its viewing key, and that it may open it. */
const ownCompanyOpens = (): void => {
  expect(keyring.canOpenCompanies(OWN)).toBe(true);
  expect(keyring.seatHeldHere(OWN)?.signerId).toBe(SEATS[OWN]!.signerId);
  expect(keyring.viewingKeyFor({ id: OWN, wrappedKeys: [] })).toBe(VIEWING[OWN]);
};

describe('AN ACTION WITH THE KEYS CLOSED OPENS ITS OWN COMPANY, AND ONLY THAT', () => {
  for (const [name, run] of [['Create vault', createVault], ['Finish', finish]] as const) {
    it(`after a cold ${name}, the company opens and its vault reads with no keys window`, async () => {
      aService();
      signIn();
      const wallet = new Wallet();
      expect(keyring.canOpenCompanies(OWN)).toBe(false);
      await run(wallet);
      /* RED WHEN: the ask hands the wallet no served keys, or more than the action's own company's. */
      const ask = wallet.asks[0]!.body as ActRequest;
      expect(ask.served?.map((s) => s.accountId)).toEqual([OWN]);
      /* RED WHEN: the end answer's key is left out, or not taken, so the company asks the wallet again. */
      ownCompanyOpens();
      expect(wallet.asks.map((a) => a.kind)).toEqual(['act']);
      /* RED WHEN: a read of one company is taken as the saved keys read for every company. */
      expect(keyring.canOpenCompanies(OTHER)).toBe(false);
      expect(keyring.canOpenCompanies()).toBe(false);
      expect(keyring.seatHeldHere(OTHER)).toBeNull();
    });
  }

  it('a viewing key whose inbox public key does not match is left out, and the company stays closed', async () => {
    aService((id) => inboxPublicKey(VIEWING[OTHER]!, id));
    signIn();
    const wallet = new Wallet();
    await createVault(wallet);
    /* RED WHEN: a key is believed without making the company's inbox public key. */
    expect(keyring.canOpenCompanies(OWN)).toBe(false);
    expect(keyring.seatHeldHere(OWN)).toBeNull();
  });

  it('an end answer giving another company\'s key is not taken as a read at all', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    wallet.givesTheKeyOf = OTHER;
    await createVault(wallet);
    /* RED WHEN: the tab takes a key for a company the action was not about. */
    expect(keyring.canOpenCompanies(OTHER)).toBe(false);
    expect(keyring.canOpenCompanies(OWN)).toBe(false);
    expect(keyring.seatHeldHere(OTHER)).toBeNull();
  });

  it('in a tab whose saved keys were read, an end answer giving another company\'s key changes nothing held for it', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    await keyring.openKeysWithWallet(WALLET, wallet, US);
    expect(keyring.viewingKeyFor({ id: OTHER, wrappedKeys: [] })).toBe(VIEWING[OTHER]);
    wallet.givesTheKeyOf = OTHER;
    wallet.givesTheValue = toHex(randomBytes(32));
    await createVault(wallet);
    /* RED WHEN: an end answer for one company's action replaces the key this tab holds for another. */
    expect(keyring.viewingKeyFor({ id: OTHER, wrappedKeys: [] })).toBe(VIEWING[OTHER]);
  });
});

describe('A PRIVATE DEPOSIT IS ASKED OF THE WALLET AS ONE ACTION', () => {
  /* RED WHEN: the amount reaches the wallet as anything but the whole number of the token's smallest units, or the ask names more than the company, the vault, the token and the amount. */
  it('names the company, the vault, the token and the amount in the token\'s smallest units, written in decimal', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const vault = 'd1'.repeat(32), token = '02'.repeat(32);
    await keyring.privateDepositInTheWallet({ record: OWN, company: LABEL, account: ACCOUNT as AccountAddress, vault, token, units: 12_345_678_901_234_567_890n }, WALLET, {}, wallet);
    const ask = wallet.asks[0]!.body as ActRequest;
    expect(ask.intent).toEqual({ name: 'private-deposit', fields: { record: OWN, company: LABEL, account: ACCOUNT, vault, token, amount: '12345678901234567890' } });
  });
});

describe('AN INVITATION IS ASKED OF THE WALLET AS ONE ACTION, WITH THE PAGE\'S OWN TOKEN', () => {
  const at = { record: OWN, company: LABEL, account: ACCOUNT as AccountAddress };
  const token = '02'.repeat(32);
  const askOf = async (ask: InviteAsk) => {
    aService();
    signIn();
    const wallet = new Wallet();
    const made = await inviteInTheWallet(ask, WALLET, { origin: US }, wallet);
    return { made, intent: (wallet.asks[0]!.body as ActRequest).intent };
  };

  it('an employee\'s details reach the wallet as the action\'s own fields, and the link is made here from the token handed in', async () => {
    const { made, intent } = await askOf({
      ...at, kind: 'employee', name: 'Ada', email: '', title: 'Engineer', asset: token, units: 5_000_000_000_000_000_000n, startDate: '2026-11-01',
      classification: 'full-time',
    });
    /* RED WHEN: a field the wallet does not read is sent, an empty one is sent, or the pay is not the whole number of smallest units. */
    expect(intent).toEqual({ name: 'invite', fields: {
      ...at, token: intent.fields['token'], kind: 'employee', personName: 'Ada', title: 'Engineer', asset: token, amount: '5000000000000000000',
      startDate: '2026-11-01', classification: 'full-time',
    } });
    /* RED WHEN: the link given to the person is not the one the token the wallet was handed makes. */
    expect(intent.fields['token']).toMatch(/^[0-9a-f]{64}$/u);
    expect(made.link).toBe(invitationLink(US, intent.fields['token'] as never));
    expect(made.id).toBe(invitationIdOf(intent.fields['token'] as never));
  });

  it('a vendor paid monthly and a signer by address are asked with their own fields', async () => {
    const vendor = (await askOf({ ...at, kind: 'vendor', name: 'Acme', startDate: '2026-11-01', terms: { kind: 'monthly', asset: token, units: 10n } })).intent;
    expect(vendor.fields).toMatchObject({ kind: 'vendor', terms: 'monthly', termsAsset: token, termsAmount: '10' });
    const signer = (await askOf({ ...at, kind: 'signer', name: 'Dee', role: 'approver', address: ADDRESS })).intent;
    /* RED WHEN: a signer's address or role does not reach the wallet that checks them. */
    expect(signer.fields).toMatchObject({ kind: 'signer', role: 'approver', address: ADDRESS });
    expect(Object.keys(signer.fields)).not.toContain('scope');
  });
});

describe('A SIGNER IS APPROVED AND ADMITTED BY ASKING THE WALLET ONE ACTION EACH', () => {
  const at = { record: OWN, company: LABEL, account: ACCOUNT as AccountAddress };
  const intentOf = async (ask: (wallet: Openable) => Promise<unknown>) => {
    aService();
    signIn();
    const wallet = new Wallet();
    await ask(wallet as never);
    return (wallet.asks[0]!.body as ActRequest).intent;
  };

  it('an approval names the proposal and exactly what the page showed it inviting', async () => {
    const intent = await intentOf((w) => approveSignerInTheWallet({
      ...at, proposal: 'prp_abcdefghijkl', name: 'Dee', role: 'viewer', address: 'AA'.repeat(32), scope: 'BB'.repeat(32), coinKey: 'CC'.repeat(32),
    }, WALLET, {}, w));
    /* RED WHEN: what the page showed does not reach the wallet that holds the proposal to it, or reaches it in another case. */
    expect(intent).toEqual({ name: 'approve-signer', fields: {
      ...at, proposal: 'prp_abcdefghijkl', personName: 'Dee', role: 'viewer', address: 'aa'.repeat(32), scope: 'bb'.repeat(32), coinKey: 'cc'.repeat(32),
    } });
  });

  it('an admission names the person waiting and the name the page showed, and nothing read out', async () => {
    const intent = await intentOf((w) => admitSignerInTheWallet({ ...at, signer: 'sig_dee', name: 'Dee' }, WALLET, {}, w));
    /* RED WHEN: the admission is asked with a field the wallet does not read, or without the person the page showed. */
    expect(intent).toEqual({ name: 'admit-signer', fields: { ...at, signer: 'sig_dee', personName: 'Dee' } });
  });
});

describe('A PERSON OR A VENDOR IS ADMITTED AND CHANGED BY ASKING THE WALLET ONE ACTION EACH', () => {
  const at = { record: OWN, company: LABEL, account: ACCOUNT as AccountAddress };
  const intentOf = async (ask: (wallet: Openable) => Promise<unknown>) => {
    aService();
    signIn();
    const wallet = new Wallet();
    await ask(wallet as never);
    return (wallet.asks[0]!.body as ActRequest).intent;
  };

  it('an admission names the person, their kind, the name the page showed and the fingerprint read out, or none for a claim', async () => {
    const byFingerprint = await intentOf((w) => admitPersonInTheWallet({ ...at, kind: 'employee', person: 'emp_ada', name: 'Ada', fingerprint: ' ABCD-EFGH ' }, WALLET, {}, w));
    /* RED WHEN: the fingerprint read out does not reach the wallet that checks it, or reaches it under another person. */
    expect(byFingerprint).toEqual({ name: 'admit-person', fields: { ...at, kind: 'employee', person: 'emp_ada', personName: 'Ada', fingerprint: 'ABCD-EFGH' } });
    const byClaim = await intentOf((w) => admitPersonInTheWallet({ ...at, kind: 'vendor', person: 'ven_acme', name: 'Acme' }, WALLET, {}, w));
    expect(byClaim).toEqual({ name: 'admit-person', fields: { ...at, kind: 'vendor', person: 'ven_acme', personName: 'Acme' } });
  });

  it('a change names each field the page changed, amounts in the smallest unit written in decimal, and a date taken off as cleared', async () => {
    const employee = await intentOf((w) => changePersonInTheWallet({
      ...at, kind: 'employee', person: 'emp_ada', name: 'Ada',
      change: { pay: { amount: 6000n, asset: 'AA'.repeat(32), from: '2026-11-01' }, classification: { classification: 'part-time', from: '2026-11-01' }, endDate: null, leavingDate: null },
    }, WALLET, {}, w));
    /* RED WHEN: a date taken off reaches the wallet as no change, or an amount reaches it in another form than it reads. */
    expect(employee).toEqual({ name: 'change-person', fields: {
      ...at, kind: 'employee', person: 'emp_ada', personName: 'Ada', payAmount: '6000', asset: 'aa'.repeat(32), payFrom: '2026-11-01',
      classification: 'part-time', classificationFrom: '2026-11-01', clear: 'endDate,leavingDate',
    } });
    const vendor = await intentOf((w) => changePersonInTheWallet({
      ...at, kind: 'vendor', person: 'ven_acme', name: 'Acme', change: { terms: { kind: 'monthly', asset: 'BB'.repeat(32), amount: 900n }, endDate: '2027-01-31', status: 'leaver' },
    }, WALLET, {}, w));
    expect(vendor).toEqual({ name: 'change-person', fields: {
      ...at, kind: 'vendor', person: 'ven_acme', personName: 'Acme', terms: 'monthly', termsAsset: 'bb'.repeat(32), termsAmount: '900', endDate: '2027-01-31', status: 'leaver',
    } });
  });
});

describe('THE WALLET HANDS THE COMPANY\'S KEYS TO THE SHARED CODE UNDER THE NAME IT READS THEM BY', () => {
  it('a door keeps its own fields and carries the company\'s keys as the shared code reads them', () => {
    const keys = { epoch: 0 } as never;
    /* RED WHEN: a door built in the wallet hands the shared code no company keys, or other ones, or drops its own fields. */
    expect(withCompanyKeys({ id: 'acc_1', keyEpoch: 0 }, keys)).toEqual({ id: 'acc_1', keyEpoch: 0, viewingKey: keys });
  });
});

describe('A PAYEE JOINS BY ASKING THE WALLET ONE ACTION, WITH THEIR SAVED KEYS', () => {
  it('names the invitation by its token and nothing the wallet does not read from the offer itself, and hands the saved keys', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const at = { record: OWN, company: LABEL, account: ACCOUNT as AccountAddress };
    await joinByCodeInTheWallet({ ...at, token: 'AB'.repeat(32) }, WALLET, {}, wallet as never);
    const request = wallet.asks[0]!.body as ActRequest;
    /* RED WHEN: the join is asked with a field the wallet does not read, or with the token in another case than the link's. */
    expect(request.intent).toEqual({ name: 'join-by-code', fields: { ...at, token: 'ab'.repeat(32) } });
    /* RED WHEN: the join is asked without the saved keys the wallet lists the company in before it hands anything over. */
    expect(request.keyring).toBeDefined();
  });
});

describe('A COMPANY KEY RELEASED TO THIS TAB IS TOLD TO WHAT WAITS FOR IT', () => {
  /* RED WHEN: a vault page left unable to read what the vault holds privately is never told that its company's key has since been released, so it stays unread until the page is reloaded. */
  it('tells each watcher the company whose key the wallet released, and no longer once it stops watching', async () => {
    aService();
    signIn();
    const told: string[] = [];
    const stop = keyring.watchCompanyKeyReleased((id) => { told.push(id); });
    await keyring.companyKeysForVaults(OWN, WALLET, new Wallet(), US);
    expect(keyring.companyKeyReleasedFor(OWN)).not.toBeNull();
    expect(told).toEqual([OWN]);
    stop();
    keyring.forgetLocally();
    signIn();
    await keyring.companyKeysForVaults(OWN, WALLET, new Wallet(), US);
    expect(told).toEqual([OWN]);
  });
});
