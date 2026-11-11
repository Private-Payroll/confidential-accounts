/**
 * **A READ GRANT TAKEN AWAY STAYS TAKEN AWAY WHEN A SIGNER OF THE TAKING-AWAY IS REMOVED LATER.** Acme holds three
 * seats at a seat bar of two. Ada's and Bo's wallets give Rhea, a limited reader, a read grant; Cy's and Bo's wallets
 * take it away. Then Cy is removed, and the company's key changes for the seats who stay. Each version of the grants is counted
 * against the seats and the seat bar as the company's records anchored it, so Cy's signature on the taking-away still
 * counts once Cy has left: Rhea's grant does not come back, no purpose key of the new key is wrapped to her, and a
 * later grant to Abe carries her nowhere.
 *
 * Over real HTTP with the company's records, directory and proposal routes as the service keeps them; the chain and the
 * worker are the stand-ins `a-company-whose-signers-change-on-the-chain.test-support.ts` names.
 */
import { describe, expect, it } from 'vitest';
import { grantEntryOf, GRANTS_RECORD } from '../midnight/grants-record.js';
import { recordKeyOf } from '../midnight/record-manifest.js';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { grantsHere } from 'vaults-web-shared/purpose-wraps.js';
import { grantsChangeFiledHere, grantsWrappedAgainHere } from 'vaults-web-shared/grants-filed-here.js';
import {
  aCompanyWhoseSignersChange, ADA, BO, CO, CY, deviceOf, directoryOf, grantsKept, KEY, recordsSecretOf, seatsOnTheChain,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { ABE, grantsDoorsOf, readerKeys, RHEA } from './a-read-grant.test-support.js';

aCompanyWhoseSignersChange(2);

/** Whether any version of the grants Rhea's own device opens wraps her a purpose key of the company's new key. */
const rheaHoldsTheNewKey = async (): Promise<boolean> => (await readerKeys(RHEA))?.byEpoch.has(1) ?? false;

/** The grants as Bo's device believes them. */
const grantsAtBo = () => grantsHere({ accountId: CO, versions: grantsKept, directory: directoryOf(BO), me: { signerId: BO.seat, wrappingSecret: recordsSecretOf(BO) } });

describe('A READ GRANT TAKEN AWAY, THEN A SIGNER OF THE TAKING-AWAY REMOVED', () => {
  it('RHEA STAYS OUT ONCE CY, WHO SIGNED HER GRANT AWAY, IS REMOVED: NOT IN FORCE, NOT WRAPPED THE NEW KEY, AND NOT CARRIED INTO A LATER GRANT', async () => {
    const rhea = grantEntryOf({ recipient: RHEA.recipient, person: RHEA.person, role: 'limited' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { give: rhea })).toMatchObject({ state: 'waiting-for-signers' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { give: rhea })).toMatchObject({ state: 'in-force', by: 2 });
    expect(await readerKeys(RHEA)).not.toBeNull();

    /* Cy and Bo take Rhea's grant away. */
    expect(await grantsChangeFiledHere(await grantsDoorsOf(CY), { takeAway: RHEA.recipient })).toMatchObject({ state: 'waiting-for-signers', takesAway: true });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { takeAway: RHEA.recipient })).toMatchObject({ state: 'in-force', by: 2, takesAway: true });
    const takenAway = (await grantsKept()).at(-1)!.version;

    /* Cy is removed: Ada raises it, Bo approves and carries it out, and Bo's device changes the company's key for the seats who stay. */
    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };
    expect(await removeSignerOnDevice(deviceOf(ADA, { changesTheKey: true }), remove)).toMatchObject({ state: 'waiting-for-approvals' });
    expect(await removeSignerOnDevice(deviceOf(BO, { changesTheKey: true }), remove)).toMatchObject({ state: 'done', rotation: { state: 'rotated', epoch: 1 } });
    expect(seatsOnTheChain()).toEqual([ADA.seat, BO.seat]);
    const here = await directoryOf(BO)({ records: [{ store: 'company', ...GRANTS_RECORD }] });
    expect(here.dir.seats.find((x) => x.seat === CY.seat)?.retired).not.toBeNull();
    expect(here.records.history.get(recordKeyOf({ store: 'company', ...GRANTS_RECORD }))?.map((v) => v.version)).toContain(takenAway);

    /* RED WHEN: a version of the grants is counted against today's seats, so the taking-away Cy signed falls below the bar and Rhea's grant is in force again. */
    const after = await grantsAtBo();
    expect(after.inForce).toMatchObject({ version: takenAway });
    expect(after.inForce!.grants.entries).toEqual([]);
    expect(after.revokedAt).toBe(0);
    /* RED WHEN: the grants are wrapped again to the new key for a reader whose grant was taken away. */
    expect(await grantsWrappedAgainHere(await grantsDoorsOf(BO))).toEqual({ state: 'not-needed' });
    expect(await rheaHoldsTheNewKey()).toBe(false);

    /* RED WHEN: a later grant is built on the grant before the taking-away, so it signs Rhea back in. */
    const abe = grantEntryOf({ recipient: ABE.recipient, person: ABE.person, role: 'accountant' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { give: abe })).toMatchObject({ state: 'waiting-for-signers' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { give: abe })).toMatchObject({ state: 'in-force', by: 2 });
    expect((await grantsAtBo()).inForce!.grants.entries.map((e) => e.person)).toEqual([ABE.person]);
    expect((await readerKeys(ABE))?.byEpoch.has(1)).toBe(true);
    expect(await rheaHoldsTheNewKey()).toBe(false);

    /* Who held the account as the records anchored the grants cannot be read on Bo's device: the grants are not read at all. */
    const unheld: ReturnType<typeof directoryOf> = async (asked) => {
      const read = await directoryOf(BO)(asked);
      return { ...read, records: { ...read.records, held: () => null } };
    };
    const filed = (await grantsKept()).length;
    /* RED WHEN: an anchored version whose holders cannot be read is counted against today's seats, so withholding them brings a reader back. */
    await expect(grantsHere({ accountId: CO, versions: grantsKept, directory: unheld, me: { signerId: BO.seat, wrappingSecret: recordsSecretOf(BO) } }))
      .rejects.toThrow(/who held the company's account when the records anchored a version of them could not be read.*Reload the page/su);
    await expect(grantsWrappedAgainHere({ ...(await grantsDoorsOf(BO)), directory: unheld })).rejects.toThrow(/could not be read/u);
    expect((await grantsKept()).length).toBe(filed);
  }, 170_000);
});
