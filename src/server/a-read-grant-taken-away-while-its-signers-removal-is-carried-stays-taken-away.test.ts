/**
 * **A READ GRANT TAKEN AWAY WHILE ONE OF ITS SIGNERS' REMOVAL IS UNDER WAY STAYS TAKEN AWAY.** Acme holds three seats
 * at a seat bar of two. Ada's and Bo's wallets give Rhea, a limited reader, a read grant. Ada raises Cy's removal; then
 * Cy's and Bo's wallets take Rhea's grant away, and Bo carries the removal out, so the taking-away is anchored with Cy's
 * retirement, or after it. A change that only takes reading away counts the signers who have left since, so Rhea's
 * grant does not come back, and no purpose key of the company's new key is wrapped to her.
 *
 * Over real HTTP with the company's records, directory and proposal routes as the service keeps them; the chain and the
 * worker are the stand-ins `a-company-whose-signers-change-on-the-chain.test-support.ts` names.
 */
import { describe, expect, it } from 'vitest';
import { grantEntryOf } from '../midnight/grants-record.js';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { grantsHere } from 'vaults-web-shared/purpose-wraps.js';
import { grantsChangeFiledHere, grantsWrappedAgainHere } from 'vaults-web-shared/grants-filed-here.js';
import {
  aCompanyWhoseSignersChange, ADA, BO, CO, CY, deviceOf, directoryOf, grantsKept, KEY, recordsSecretOf, seatsOnTheChain,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { grantsDoorsOf, readerKeys, RHEA } from './a-read-grant.test-support.js';

aCompanyWhoseSignersChange(2);

describe('A READ GRANT TAKEN AWAY WHILE A SIGNER OF THE TAKING-AWAY IS BEING REMOVED', () => {
  it('RHEA STAYS OUT WHEN THE TAKING-AWAY CY SIGNED IS ANCHORED WITH CY\'S RETIREMENT, AND IS WRAPPED NO NEW KEY', async () => {
    const rhea = grantEntryOf({ recipient: RHEA.recipient, person: RHEA.person, role: 'limited' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { give: rhea })).toMatchObject({ state: 'waiting-for-signers' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { give: rhea })).toMatchObject({ state: 'in-force', by: 2 });

    /* Ada raises Cy's removal; only then do Cy and Bo take Rhea's grant away, and Bo carries the removal out. */
    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };
    expect(await removeSignerOnDevice(deviceOf(ADA, { changesTheKey: true }), remove)).toMatchObject({ state: 'waiting-for-approvals' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(CY), { takeAway: RHEA.recipient })).toMatchObject({ state: 'waiting-for-signers', takesAway: true });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { takeAway: RHEA.recipient })).toMatchObject({ state: 'in-force', by: 2, takesAway: true });
    const takenAway = (await grantsKept()).at(-1)!.version;
    expect(await removeSignerOnDevice(deviceOf(BO, { changesTheKey: true }), remove)).toMatchObject({ state: 'done', rotation: { state: 'rotated', epoch: 1 } });
    expect(seatsOnTheChain()).toEqual([ADA.seat, BO.seat]);

    /* RED WHEN: a taking-away is counted without a signer removed before or with its anchoring, and Rhea's grant is in force again. */
    const after = await grantsHere({ accountId: CO, versions: grantsKept, directory: directoryOf(BO), me: { signerId: BO.seat, wrappingSecret: recordsSecretOf(BO) } });
    expect(after.inForce).toMatchObject({ version: takenAway, grants: { entries: [] } });
    expect(after.revokedAt).toBe(0);
    /* RED WHEN: the upkeep wraps the company's new key to the reader whose grant was taken away. */
    expect(await grantsWrappedAgainHere(await grantsDoorsOf(BO))).toEqual({ state: 'not-needed' });
    expect((await readerKeys(RHEA))?.byEpoch.has(1) ?? false).toBe(false);
  }, 170_000);
});
