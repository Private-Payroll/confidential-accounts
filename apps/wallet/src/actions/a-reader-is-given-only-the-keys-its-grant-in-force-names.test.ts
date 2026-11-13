/**
 * **A READER'S WALLET GIVES ITS PAGE ONLY THE KEYS THE READ GRANT IN FORCE NAMES, FOR THAT ONE COMPANY.** Acme holds three
 * seats at a seat bar of two. Rhea's own wallet works out her reader key for Acme; Ada's and Bo's wallets give her a
 * limited read grant to it. Her wallet's `reader-keys` act reads the grants through the page and believes them only as
 * every device does: from the company's directory, read with the records keys the seats' own wallets attested in the
 * roster her keys open, and the chain. With no grant, or one below the seat bar, it gives nothing, even from a service
 * that serves her everything a member reads; a service that does not list her as a reader is refused by name. One seat
 * alone cannot cut her off; taken away at the seat bar, she is refused and told, and handed no key, even when one seat
 * files her old grant again; given read access again, she reads the new grant. Over real HTTP with the company of `a-company-whose-signers-change-on-the-chain.test-support.ts`.
 */
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
import type { ActIntent } from 'midnight-identity/profile/request';
import type { ReadKeysReleased } from 'midnight-identity/profile/read-keys-release';
import { grantEntryOf, grantsMessage, openGrants, purposeWrapsFor, readerIdOf, sealGrants } from '../../../../src/midnight/grants-record.js';
import { sign, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { purposeKey } from '../../../../src/core/sealed-records.js';
import { openRoster } from '../../../../src/core/roster-record.js';
import { grantsChangeFiledHere, grantsWrappedAgainHere } from '../../../../packages/web-shared/src/grants-filed-here.js';
import { rotateTheCompanyKeyHere } from '../../../../packages/web-shared/src/company-key-here.js';
import { readerKeysHere } from '../../../../packages/web-shared/src/purpose-wraps.js';
import { readerDirectoryFor } from '../../../../packages/web-shared/src/reader-directory-here.js';
import { heldFromRelease } from '../../../../packages/web-shared/src/reader-keys-released.js';
import { keysByPurpose } from '../../../../packages/web-shared/src/keys-by-purpose.js';
import { acmeReads } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, ADDRESS, apiAs, BO, CO, companyKeyDoorsOf, deviceOf, grantsKept, LABEL, sendAs, store,
} from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { grantsDoorsOf } from '../../../../src/server/a-read-grant.test-support.js';
import { readerKeypairOfThisWallet } from '../screens/join-code-reader-key.js';
import { readFileSync } from 'node:fs';
import type { StepContext, Words } from './definition.js';
import { readerKeysAction } from './reader-keys.js';
import { StepRefused } from './definition.js';

aCompanyWhoseSignersChange(2);

const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const RHEAS_WALLET = identityFromSecret(new Uint8Array(32).fill(9));
const RHEAS_KEY = readerKeypairOfThisWallet(RHEAS_WALLET, LABEL).publicKey;
const intent: ActIntent = { name: 'reader-keys', fields: { record: CO, company: LABEL, account: ADDRESS } };
const unused = (): never => { throw new Error('a reader\'s act uses no such door'); };
const reads = {
  holders: acmeReads.holders, leaves: acmeReads.leaves, anchored: acmeReads.anchored, invitedSeats: acmeReads.invitedSeats,
  proposalIdentity: acmeReads.proposalIdentity,
};

/**
 * Runs the act's one step as Rhea's wallet, through a page signed in as `as`: the keys it hands over, or the words it
 * refused with. Through Ada's sign-in the service serves Rhea's wallet everything a member reads, as a service that
 * lists anyone as a reader would.
 */
async function rheaReads(as = 'ada'): Promise<ReadKeysReleased | Words | null> {
  let released: ReadKeysReleased | null = null;
  const ctx: StepContext = {
    intent, asker: { origin: 'https://payroll.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'rhea',
    held: { identity: RHEAS_WALLET, secret: new Uint8Array(32).fill(9) }, at: { step: 1, steps: 1 }, signal: new AbortController().signal,
    relay: unused, call: async (method, path, body) => sendAs(as)(path, { method, ...(body === undefined ? {} : { body }) }),
    sentByTheWallet: unused, seenOnTheChain: unused, tell: unused, show: unused, confirm: unused, keyring: null,
    releaseReadKeys: (keys) => { released = keys; },
  };
  const [step] = readerKeysAction({ chain: unused, builder: unused, readsFor: () => reads }).steps(intent);
  try {
    await step!.run(ctx);
  } catch (e) {
    if (e instanceof StepRefused) return e.words;
    throw e;
  }
  return released;
}

describe('A READER\'S WALLET HANDS ITS PAGE THE READ KEYS OF ONE COMPANY', () => {
  it('GIVES NOTHING WITHOUT A GRANT AT THE SEAT BAR, ONLY WHAT A GRANT AT THE BAR WRAPS, AND THE NEW GRANT ONCE GIVEN AGAIN', async () => {
    /* RED WHEN: a service that does not let a person read the company reads to them as a fault, not as access not given. */
    expect(await rheaReads('rhea')).toEqual({ key: 'act.reader-keys.why.not-a-reader-here' });
    /* RED WHEN: a reader the service does not let in is not told that a signer giving the read access again lets them in. */
    expect(WORDS['act.reader-keys.why.not-a-reader-here']).toMatch(/A signer of the company gives you read access again in their wallet/u);
    /* RED WHEN: a reader's wallet hands over keys for a company that gives it no read grant. */
    expect(await rheaReads()).toEqual({ key: 'act.reader-keys.why.no-grant' });

    /* Ada's device alone files a grant to Rhea and, unlike an honest seat, seals it and her keys to her below the bar. */
    const rhea = grantEntryOf({ recipient: RHEAS_KEY, person: 'rhea', role: 'limited' });
    const ada = await grantsDoorsOf(ADA);
    const message = grantsMessage(CO, { sequence: 1, entries: [rhea] });
    await ada.file(sealGrants({
      company: CO, version: 1, keyEpoch: ada.keys.newest, seats: await ada.seats(),
      grants: {
        sequence: 1, entries: [rhea], signatures: [{ publicKey: signingPublicKeyOf(ADA.signingSecret as Hex).toLowerCase(), signature: sign(message, ADA.signingSecret as Hex) }],
        wraps: purposeWrapsFor([rhea], (epoch, purpose) => purposeKey(ada.keys.keyAt(epoch), CO, purpose), ada.keys.newest),
      },
    }));
    /* RED WHEN: a grant one signer filed, below the seat bar, gives a reader's page any key, even one sealed to the reader. */
    expect(await rheaReads()).toEqual({ key: 'act.reader-keys.why.no-grant' });

    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { give: rhea })).toMatchObject({ state: 'waiting-for-signers' });
    expect(await rheaReads()).toEqual({ key: 'act.reader-keys.why.no-grant' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { give: rhea })).toMatchObject({ state: 'in-force' });
    const released = await rheaReads();
    expect(released).toMatchObject({ accountId: CO });
    const held = heldFromRelease(released as ReadKeysReleased, CO)!;
    /* RED WHEN: what the wallet hands over is not exactly what the grant in force wraps to this reader's key. */
    const pair = readerKeypairOfThisWallet(RHEAS_WALLET, LABEL);
    const inForce = await readerKeysHere({
      accountId: CO, versions: grantsKept, me: { recipient: pair.publicKey, wrappingSecret: pair.secret },
      directoryFor: readerDirectoryFor({ accountId: CO, label: LABEL, account: ADDRESS, api: apiAs('ada'), ...reads }),
    });
    expect(inForce.of === 'held' ? inForce.held.byEpoch : null).toEqual(held.byEpoch);
    /* RED WHEN: a limited reader's page is handed a key for what its role does not read. */
    expect([...held.byEpoch.get(0)!.keys()].sort()).toEqual(['policy', 'proposals', 'roster']);
    expect(openRoster(store.newestRoster(CO)!, keysByPurpose(held).at(0)).signers.map((s) => s.name).sort()).toEqual(['ada', 'bo', 'cy']);
    /* RED WHEN: the release carries the reader's own key or its secret, which would open every grant ever wrapped to it. */
    expect(JSON.stringify(released)).not.toContain(pair.secret);
    expect(JSON.stringify(released)).not.toContain(pair.publicKey);

    const givenAtTheBar = (await grantsKept()).at(-1)!;
    /* One seat alone files taking Rhea away: below the bar it changes nothing, and tells her nothing. */
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { takeAway: RHEAS_KEY })).toMatchObject({ state: 'waiting-for-signers' });
    /* RED WHEN: a take-away still waiting for the bar is sealed to the reader it would take away, who learns of it before it is decided. */
    expect((await grantsKept()).at(-1)!.wrapped.some((w) => w.signerId === readerIdOf(RHEAS_KEY))).toBe(false);
    /* RED WHEN: one seat, below the seat bar, stops a reader the grant in force still names from reading. */
    expect(await rheaReads()).toEqual(released);
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { takeAway: RHEAS_KEY })).toMatchObject({ state: 'in-force', takesAway: true });
    /* RED WHEN: a take-away in force is not sealed to the reader it takes away, so its wallet cannot tell it is taken away. */
    expect((await grantsKept()).at(-1)!.wrapped.some((w) => w.signerId === readerIdOf(RHEAS_KEY))).toBe(true);
    /* RED WHEN: a reader whose grant a later version in force takes away is handed any key, or not told so. */
    expect(await rheaReads()).toEqual({ key: 'act.reader-keys.why.taken-away' });
    /* RED WHEN: a reader taken away is not told that a signer giving read access again clears it. */
    expect(WORDS['act.reader-keys.why.taken-away']).toMatch(/A signer of the company gives you read access again from their wallet/u);

    /* Ada's device alone files Rhea's old grant again, signatures and all, as the newest version sealed to her. */
    const adaDoors = await grantsDoorsOf(ADA);
    const old = openGrants(givenAtTheBar, adaDoors.me)!;
    await adaDoors.file(sealGrants({ company: CO, version: (await grantsKept()).at(-1)!.version + 1, keyEpoch: givenAtTheBar.keyEpoch, seats: await adaDoors.seats(), grants: old }));
    /* RED WHEN: one seat filing an older grant again, below the bar on its own, gives back the keys of a reader taken away. */
    expect(await rheaReads()).toEqual({ key: 'act.reader-keys.why.taken-away' });
    expect(await rotateTheCompanyKeyHere({
      ...companyKeyDoorsOf(BO), accountId: CO, material: { signingSecret: BO.signingSecret }, records: deviceOf(BO).records!, leaving: async () => new Set<string>(),
    })).toMatchObject({ state: 'rotated', epoch: 1 });
    expect(await grantsWrappedAgainHere(await grantsDoorsOf(BO))).toEqual({ state: 'not-needed' });

    /* The signers give Rhea read access again, under the new key. */
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { give: rhea })).toMatchObject({ state: 'waiting-for-signers' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { give: rhea })).toMatchObject({ state: 'in-force' });
    const again = heldFromRelease((await rheaReads()) as ReadKeysReleased, CO)!;
    /* RED WHEN: a reader taken away and given read access again is handed nothing, or only the keys of its first grant. */
    expect([...again.byEpoch.keys()]).toContain(1);
    expect(keysByPurpose(again).at(1).keyFor('roster', CO)).not.toBeNull();
  }, 170_000);
});
