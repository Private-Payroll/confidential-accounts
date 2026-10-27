/**
 * **A SIGNER ADMITTED BUT NOT YET IN THE DIRECTORY HOLDS THE COMPANY'S KEY, SO A CHANGE OF THE KEY WAITS FOR THEM.**
 *
 * Dee is invited, the chain seats her and Ada's device admits her, handing her the company's key; she has not yet
 * opened the company, so the directory has no entry for her seat. Cy is then removed. Bo's device does not change the
 * key past her: a copy of the new key goes only to a seat the directory holds, so changing it now would leave her
 * with the key the removed signer holds, and her entry would later be sealed under it.
 */
import { describe, it, expect } from 'vitest';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { identityFromSecret } from 'midnight-identity';
import { MidnightCommitments } from '../midnight/commitments.js';
import { leafOfTheContract } from '../testing/directory-seats.js';
import { newSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { acceptAsSignerHere, inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { admitSignerHere } from 'vaults-web-shared/roster-here.js';
import type { PendingSeat } from 'vaults-web-shared/keyring.js';
import { ACME, ORIGIN, fromAda } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, BO, chains, CO, committeeKeyOfLeaf, CY, deviceOf, KEY, LABEL, rosterDoorsOf, sendAs, store,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

const DEES_KEY = committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(5)), LABEL) as { tag: string; value: string };

describe('A SIGNER ADMITTED BEFORE A SIGNER LEAVES, WITH NO ENTRY YET', () => {
  it('holds up the change of the company\'s key until they file their entry', async () => {
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'dee', role: 'approver', person: 'dee' }, ORIGIN, fromAda);
    const kept: PendingSeat[] = [];
    const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
      newKeys: newSeatKeys, seal: async (seat) => { kept.push(seat as PendingSeat); }, promote: async () => {},
    }, sendAs('dee'), 'dee', async () => DEES_KEY);
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
