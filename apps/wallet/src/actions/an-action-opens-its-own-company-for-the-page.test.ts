import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import type { ActEnded, ActingChannel } from 'midnight-identity/profile/channel';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActRequest, ServedHandedIn } from 'midnight-identity/profile/request';
import { fromHex, randomBytes, toHex, wrapKey } from '../../../../src/core/crypto.js';
import { inboxPublicKey } from '../../../../src/core/sealed-records.js';
import { sealKeyring, type Keyring, type SavedCreation } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { KeyringMark, KeyringMarks } from '../keyring/held-keyring.js';
import { keyringSealKeyFor } from '../keyring/seal-key.js';
import type { ActionDefinition, Held } from './definition.js';
import { runAction } from './run.js';

/*
 * **AN ACTION RUN WITH THE PAGE'S KEYS CLOSED LEAVES THE PAGE ITS OWN COMPANY OPEN.** Its end answer carries the viewing
 * key of the action's own company, opened here with the seat's wrapping secret from the served keys the ask handed in,
 * and only when that key makes the company's inbox public key, as a keyring answer does. No other company's key, and
 * never a seat's secret.
 */

const secret = newSecret();
const identity = identityFromSecret(secret);
const held: Held = { identity, secret };
const REQUESTER = { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' };
const KEY = toHex(keyringSealKeyFor(identity, { requester: REQUESTER, person: 'usr_a' }));
const OWN = 'acc_OwnCompany01';
const OTHER = 'acc_OtherCompany';
const seat = (n: string) => {
  const wrappingSecret = toHex(randomBytes(32));
  return { signerId: `sig_${n}`, signingSecret: toHex(randomBytes(32)), wrappingSecret, blinding: toHex(randomBytes(32)), scope: '44'.repeat(32) };
};
const SEATS: Record<string, ReturnType<typeof seat>> = { [OWN]: seat('own'), [OTHER]: seat('other') };
const VIEWING: Record<string, string> = { [OWN]: toHex(randomBytes(32)), [OTHER]: toHex(randomBytes(32)) };
const LABEL = drawCompanyLabel();

const servedFor = (accountId: string, inbox = inboxPublicKey(VIEWING[accountId]!, accountId)): ServedHandedIn => ({
  accountId, inboxPublicKey: inbox,
  wrappedKeys: [{
    signerId: SEATS[accountId]!.signerId,
    ...wrapKey(VIEWING[accountId]!, toHex(x25519.getPublicKey(fromHex(SEATS[accountId]!.wrappingSecret)))),
  }] as never,
});
const creation: SavedCreation = {
  accountId: OWN, person: 'usr_a', label: LABEL, foundingKey: { tag: 'schnorr', value: 'ab'.repeat(32) },
  request: { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1 } as never,
  made: true, deploy: null, signed: null, recorded: false,
};
const saved: Keyring = { accounts: SEATS, creations: { [OWN]: creation } };

const request = (intent: ActRequest['intent'], served: readonly ServedHandedIn[]): ActRequest => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: REQUESTER, purpose: 'A test.', nonce: 'n1',
  expiresAt: Date.now() + 20 * 60_000, hearsProgress: true, intent, person: 'usr_a',
  keyring: { sealed: sealKeyring(saved, KEY).sealed, version: 3 }, served,
});
const marks = (): KeyringMarks => {
  const seen = new Map<string, KeyringMark>();
  return { markOf: (p) => seen.get(p) ?? null, raise: (p, m) => { seen.set(p, m); } };
};
const ended = async (r: ActRequest): Promise<ActEnded> => {
  const answers: ActEnded[] = [];
  const channel = {
    step: () => true, answer: (a: unknown) => { answers.push(a as ActEnded); return true; },
    refuse: () => true, progress: () => true, over: () => false, stop: () => {},
  } as unknown as ActingChannel;
  const definition: ActionDefinition = {
    headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null,
    steps: () => [{ title: { key: 'x' }, run: async (c) => { c.keyring!.open(); } }],
  };
  await runAction({ definition, request: r, channel, held, stop: new AbortController().signal, marks: marks() });
  expect(answers).toHaveLength(1);
  return answers[0]!;
};
const createVault = { name: 'create-vault' as never, fields: { record: OWN, company: LABEL, account: 'ab'.repeat(32) } };

describe('AN ACTION\'S END ANSWER OPENS ITS OWN COMPANY FOR THE PAGE, AND NO OTHER', () => {
  it('gives the viewing key of the company the action names, from the served keys handed in', async () => {
    const end = await ended(request(createVault, [servedFor(OWN)]));
    /* RED WHEN: the end answer leaves the key out, so the page asks the wallet again before it opens the company. */
    expect(end.keys!.viewing).toEqual({ [OWN]: VIEWING[OWN] });
    expect(Object.keys(end.keys!.seats).sort()).toEqual([OTHER, OWN].sort());
    /* RED WHEN: a seat's secret crosses with the key. */
    for (const s of Object.values(SEATS)) for (const v of [s.signingSecret, s.wrappingSecret, s.blinding]) expect(JSON.stringify(end)).not.toContain(v);
  });

  it('finishing a company names it by the creation the saved keys hold for the label', async () => {
    const end = await ended(request({ name: 'finish-company' as never, fields: { company: LABEL } }, [servedFor(OWN)]));
    /* RED WHEN: a finish, whose intent names only a label, leaves the page its new company closed. */
    expect(end.keys!.viewing).toEqual({ [OWN]: VIEWING[OWN] });
  });

  it('leaves out a key whose inbox public key does not match, as the keyring answer does', async () => {
    const end = await ended(request(createVault, [servedFor(OWN, inboxPublicKey(VIEWING[OTHER]!, OWN))]));
    /* RED WHEN: a key is given without making the company's inbox public key, so the release is a decryption oracle. */
    expect(end.keys!.viewing).toEqual({});
  });

  it('gives no other company\'s key, though the page hands it in', async () => {
    const end = await ended(request(createVault, [servedFor(OTHER)]));
    /* RED WHEN: the end answer opens a company the action is not about. */
    expect(end.keys!.viewing).toEqual({});
  });
});
