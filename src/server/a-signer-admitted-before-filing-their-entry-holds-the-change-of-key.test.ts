/**
 * **A SIGNER ADMITTED BUT NOT YET IN THE DIRECTORY HOLDS THE COMPANY'S KEY, SO A CHANGE OF THE KEY WAITS FOR THEM.**
 *
 * Dee is invited, the chain seats her and Ada's device admits her, handing her the company's key; she has not yet
 * opened the company, so the directory has no entry for her seat. Cy is then removed. Bo's device does not change the
 * key past her: a copy of the new key goes only to a seat the directory holds, so changing it now would leave her
 * with the key the removed signer holds, and her entry would later be sealed under it.
 *
 * Eve is then admitted by Ada's device, and the entry naming that roster version in the company's records is lost on
 * the way. Bo's device enters it with the entry Ada's seat signed and the version carries, and believes the roster.
 */
import { describe, it, expect } from 'vitest';
import { committeeKeyFor, committeeSigningKeyFor } from 'midnight-identity/profile/committee-key';
import { identityFromSecret } from 'midnight-identity';
import { MidnightCommitments } from '../midnight/commitments.js';
import { leafOfTheContract } from '../testing/directory-seats.js';
import { newSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { acceptAsSignerHere, inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { admitSignerHere, rosterHere } from 'vaults-web-shared/roster-here.js';
import { FiledNotEntered, type RecordsEntered } from 'vaults-web-shared/record-entered-here.js';
import type { PendingSeat } from 'vaults-web-shared/keyring.js';
import { ACME, ORIGIN, fromAda } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, BO, chains, CO, committeeKeyOfLeaf, CY, deviceOf, KEY, LABEL, rosterDoorsOf, sendAs, store,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { aJoinersWallet } from '../testing/a-joiners-wallet.js';
import type { Hex } from '../core/crypto.js';

aCompanyWhoseSignersChange();

const DEES_KEY = committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(5)), LABEL) as { tag: string; value: string };
/** Dees's wallet, which signs the address it takes the seat with. */
const DEES_SIGNS = aJoinersWallet(committeeSigningKeyFor(identityFromSecret(new Uint8Array(32).fill(5)), LABEL).value as Hex, 41);
const EVES_KEY = committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(6)), LABEL) as { tag: string; value: string };
/** Eves's wallet, which signs the address it takes the seat with. */
const EVES_SIGNS = aJoinersWallet(committeeSigningKeyFor(identityFromSecret(new Uint8Array(32).fill(6)), LABEL).value as Hex, 42);

describe('A SIGNER ADMITTED BEFORE A SIGNER LEAVES, WITH NO ENTRY YET', () => {
  it('holds up the change of the company\'s key until they file their entry', async () => {
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'dee', role: 'approver', person: 'dee' }, ORIGIN, fromAda);
    const kept: PendingSeat[] = [];
    const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
      newKeys: newSeatKeys, seal: async (seat) => { kept.push(seat as PendingSeat); }, promote: async () => {},
    }, sendAs('dee'), 'dee', async () => DEES_KEY, DEES_SIGNS.seatAddress);
    const leaf = leafOfTheContract(kept[0]!.opening!)!;
    committeeKeyOfLeaf.set(leaf, DEES_KEY);
    const held = chains.get(CO)!;
    chains.set(CO, { ...held, seats: { ...held.seats, committee: [...held.seats.committee, DEES_KEY as never], seats: [...held.seats.seats, leaf] } });
    await admitSignerHere(rosterDoorsOf(ADA), { signerId: accepted.signerId!, readOut: accepted.fingerprint });
    expect(store.getAccount(CO)!.wrappedKeys.some((w) => w.signerId === accepted.signerId)).toBe(true);
    const versions = store.directoryFilingsOf(CO).length;

    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };
    expect(await removeSignerOnDevice(deviceOf(ADA, { changesTheKey: true }), remove)).toMatchObject({ state: 'waiting-for-approvals' });
    const carried = await removeSignerOnDevice(deviceOf(BO, { changesTheKey: true }), remove);
    /* RED WHEN: the change of key reads who was admitted from the entries whose wallets the directory proves, and so goes past an admitted seat with no entry. */
    expect(carried).toMatchObject({ state: 'done', rotation: { state: 'waits', why: expect.stringMatching(/no entry for yet/u) } });
    expect(store.directoryFilingsOf(CO).slice(versions).some((f) => f.change.kind === 'rotate')).toBe(false);
  }, 170_000);
});

describe('A ROSTER VERSION WHOSE ENTRY WAS LOST', () => {
  it('is entered by another seat\'s device with the entry its filer signed, and believed there', async () => {
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'eve', role: 'approver', person: 'eve' }, ORIGIN, fromAda);
    const kept: PendingSeat[] = [];
    const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
      newKeys: newSeatKeys, seal: async (seat) => { kept.push(seat as PendingSeat); }, promote: async () => {},
    }, sendAs('eve'), 'eve', async () => EVES_KEY, EVES_SIGNS.seatAddress);
    const leaf = leafOfTheContract(kept[0]!.opening!)!;
    committeeKeyOfLeaf.set(leaf, EVES_KEY);
    const held = chains.get(CO)!;
    chains.set(CO, { ...held, seats: { ...held.seats, committee: [...held.seats.committee, EVES_KEY as never], seats: [...held.seats.seats, leaf] } });
    const lost: RecordsEntered = { enter: async () => { throw new FiledNotEntered('the service did not keep it'); } };
    await expect(admitSignerHere({ ...rosterDoorsOf(ADA), entered: lost }, { signerId: accepted.signerId!, readOut: accepted.fingerprint }))
      .rejects.toBeInstanceOf(FiledNotEntered);
    const filed = store.newestRoster(CO)!;

    const read = await rosterHere(rosterDoorsOf(BO));
    /* RED WHEN: only the seat that filed a roster version can enter it again, so every other device refuses or passes over it until that seat acts. */
    expect(read).toMatchObject({ followed: null, version: filed.version });
    expect(read.opened.signers.some((x) => x.leafCommitment?.toLowerCase() === leaf.toLowerCase() && x.status === 'active')).toBe(true);
  }, 170_000);
});
