/**
 * **A PERSON THE CHAIN SEATED BEFORE A SIGNER LEFT IS ADMITTED AFTER THE COMPANY'S KEY CHANGES, WITH THE NEW KEY.**
 *
 * Dee is invited by Ada's seat, answers on her own device, and the chain seats her leaf; she is not yet admitted, so
 * she holds no company key and has no entry in the directory. Cy is then removed, and Bo's device changes the
 * company's key once the chain takes Cy's leaf off. The change does not wait for Dee, gives her no copy, and names her
 * request as waiting; Ada's device then admits her with the key in force, and Dee's own device reads that key and
 * every older one.
 */
import { describe, it, expect } from 'vitest';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { identityFromSecret } from 'midnight-identity';
import { unwrapKey, type Hex } from '../core/crypto.js';
import { openAccount } from '../core/account.js';
import { answerDigestOf, type SealedAnswer } from '../core/answer-opened.js';
import type { RotateChange } from '../midnight/seat-directory.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { leafOfTheContract } from '../testing/directory-seats.js';
import { newSeatKeys, type NewSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { acceptAsSignerHere, inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { rotateTheCompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { admitSignerHere, rosterHere } from 'vaults-web-shared/roster-here.js';
import { companyKeyHere } from 'vaults-web-shared/company-key-here.js';
import type { PendingSeat } from 'vaults-web-shared/keyring.js';
import { ACME, acmeDirectoryDeps, ORIGIN, fromAda } from './a-company-of-two-seats.test-support.js';
import { directoryHere } from 'vaults-web-shared/vault-page-doors.js';
import {
  aCompanyWhoseSignersChange, ADA, BO, chains, CO, committeeKeyOfLeaf, companyKeyDoorsOf, CY, deviceOf, KEY, LABEL, rosterDoorsOf,
  seatsOnTheChain, sendAs, store,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

const DEES_KEY = committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(4)), LABEL) as { tag: string; value: string };

describe('A PERSON SEATED ON THE CHAIN BEFORE A SIGNER LEAVES IS ADMITTED AFTER THE KEY CHANGES', () => {
  it('the change of key does not wait for Dee, names her request, and Ada admits her with the new key, which Dee then reads', async () => {
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'dee', role: 'approver', person: 'dee' }, ORIGIN, fromAda);
    const kept: PendingSeat[] = [];
    const made_: NewSeatKeys[] = [];
    const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
      newKeys: (w) => { const k = newSeatKeys(w); made_.push(k); return k; }, seal: async (seat) => { kept.push(seat as PendingSeat); }, promote: async () => {},
    }, sendAs('dee'), 'dee', async () => DEES_KEY);
    const leaf = leafOfTheContract(kept[0]!.opening!)!;
    committeeKeyOfLeaf.set(leaf, DEES_KEY);
    const signerId = accepted.signerId!;
    const box = store.getAccount(CO)!.pendingSigners.find((p) => p.id === signerId)!.sealed as SealedAnswer;
    /* The chain seats Dee's leaf; nobody admits her yet. */
    const held = chains.get(CO)!;
    chains.set(CO, { ...held, seats: { ...held.seats, committee: [...held.seats.committee, DEES_KEY as never], seats: [...held.seats.seats, leaf] } });

    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };
    expect(await removeSignerOnDevice(deviceOf(ADA), remove)).toMatchObject({ state: 'waiting-for-approvals' });
    expect(await removeSignerOnDevice(deviceOf(BO), remove)).toMatchObject({ state: 'done' });
    /* Bo's device changes the key through the support's own doors, its read of who the roster admitted among them. */
    const rotate = () => rotateTheCompanyKeyHere({
      ...companyKeyDoorsOf(BO), accountId: CO, material: { signingSecret: BO.signingSecret },
      records: { directory: (asked) => directoryHere(acmeDirectoryDeps(), asked) }, leaving: async () => new Set(),
    }, { leaf: CY.seat });
    const served = store.newestRoster.bind(store);
    const older = store.rosterVersions(CO).at(-2)!;
    for (const [what, read] of [
      ['the service withholds the roster', () => null],
      ['the service serves a roster older than the one the anchor names', () => older],
      ['the roster cannot be read', () => { throw new Error('the roster store is down'); }],
    ] as const) {
      store.newestRoster = read as never;
      try {
        /* RED WHEN: a roster read that is withheld, stale or fails is taken as admitting nobody, so the change of key goes past an admitted seat. */
        expect.soft(await rotate(), what).toMatchObject({ state: 'waits', why: expect.stringMatching(/could not be read/u) });
      } finally {
        store.newestRoster = served;
      }
    }
    /* RED WHEN: a seat the chain holds that was never admitted, and so holds no key, makes the change of key wait. */
    expect(await rotate()).toMatchObject({ state: 'rotated', epoch: 1 });
    expect(seatsOnTheChain()).toContain(leaf);
    const change = store.directoryFilingsOf(CO).at(-1)!.change as RotateChange;
    /* RED WHEN: the change of key does not name the request waiting under the old inbox, so Dee could never be admitted from it. */
    expect(change.waiting).toEqual([answerDigestOf(box)]);

    const keysOf = (s: typeof ADA) => companyKeyHere({ ...companyKeyDoorsOf(s), accountId: CO, material: { signingSecret: s.signingSecret }, records: deviceOf(s).records! });
    const ada = await keysOf(ADA);
    expect(ada.epoch).toBe(1);
    /* RED WHEN: every device refuses the roster while a seat the chain holds waits for its admission across the change. */
    expect((await rosterHere({ ...rosterDoorsOf(ADA), viewingKey: ada })).account.notBelieved).toContain(leaf);
    await admitSignerHere({ ...rosterDoorsOf(ADA), viewingKey: ada }, { signerId, readOut: accepted.fingerprint });
    /* RED WHEN: the person admitted after the change is handed the key the removed signer still holds. */
    const wrapped = store.getAccount(CO)!.wrappedKeys.find((w) => w.signerId === signerId)!;
    const handed = unwrapKey(wrapped as never, made_[0]!.wrappingSecret);
    expect(handed).toBe(ada.key);
    expect(handed).not.toBe(KEY);
    expect(openAccount(store.getAccount(CO)!, ada, store.newestRoster(CO) as never).signers.find((x) => x.id === signerId)?.status).toBe('active');
    /* RED WHEN: the roster that admits her is sealed under the key from before the change. */
    expect(store.newestRoster(CO)!.keyEpoch).toBe(1);

    /* Dee's own device reads the key in force from the copy she was given, and every older key through it. */
    const dee = await companyKeyHere({
      accountId: CO, material: { signingSecret: made_[0]!.signingSecret },
      records: { directory: (asked) => directoryHere(acmeDirectoryDeps(), asked) }, filings: async () => store.directoryFilingsOf(CO),
      served: async () => handed as Hex, released: () => null, askTheWallet: async () => null,
    });
    /* RED WHEN: a person admitted after the change cannot read what was sealed before it, or reads no key in force. */
    expect([dee.epoch, dee.keyAt(0)]).toEqual([1, KEY]);
  }, 170_000);
});
