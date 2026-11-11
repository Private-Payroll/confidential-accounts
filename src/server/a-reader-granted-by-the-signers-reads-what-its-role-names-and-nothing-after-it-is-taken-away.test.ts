/**
 * **A READER GRANTED BY THE SIGNERS AT THE SEAT BAR READS WHAT ITS ROLE NAMES, AND NOTHING SEALED AFTER IT IS TAKEN
 * AWAY.** Acme holds three seats at a seat bar of two. Ada's wallet gives a limited reader, Rhea, a read grant; it
 * counts once Bo's wallet signs it too. Rhea's own device then opens the signers and each proposal's summary through
 * the keys-by-purpose seam, and nothing a limited seat does not read; she holds no seat, so she approves and invites
 * nothing. A spending policy sealed again to the readers given `policy` opens for her. An accountant is granted the
 * same way. When the signers take Rhea's grant away, every device seals nothing new until the company's key is
 * repaired; after the repair and the grants wrapped again, the accountant opens what is sealed under the new key and
 * Rhea opens nothing sealed after it, while what she opened before stays hers (the accepted risk, "A READER OR READ
 * GRANT TAKEN AWAY KEEPS WHAT IT ALREADY OPENED").
 *
 * Over real HTTP with the company's records and directory as the service keeps them; the chain and the worker are
 * the stand-ins `a-company-whose-signers-change-on-the-chain.test-support.ts` names. A reader's device reads the
 * grants record as the service keeps it, without the member gate this test's service mounts.
 */
import { describe, expect, it } from 'vitest';
import { mayInvite } from '../core/roles.js';
import { keyForThePurpose, openRecord, sealRecord } from '../core/sealed-records.js';
import { openRoster } from '../core/roster-record.js';
import { grantEntryOf, openGrants, purposeWrapsFor, readerIdOf, sealGrants } from '../midnight/grants-record.js';
import { newSymmetricKey, signingPublicKeyOf, type Hex } from '../core/crypto.js';
import { filingRefusalOf } from '../midnight/seat-directory.js';
import { openSpendingPolicy, SPENDING_POLICY_KIND } from '../midnight/spending-policy-record.js';
import { companyKeyHere, rotateTheCompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { grantsHere, revokedAtHere } from 'vaults-web-shared/purpose-wraps.js';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { keysByPurpose } from 'vaults-web-shared/keys-by-purpose.js';
import { sealPoliciesToNewSignersHere } from 'vaults-web-shared/spending-policy-here.js';
import { grantsChangeFiledHere, grantsWrappedAgainHere } from 'vaults-web-shared/grants-filed-here.js';
import { peopleRecords } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, aPolicyFiledBy, BO, CO, companyKeyDoorsOf, CY, deviceOf, directoryOf, grantsKept, KEY, recordsSecretOf,
  seatsOnTheChain, store, VAULT, walletOf,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { ABE, grantsDoorsOf, keysOf, policyFilingOf, readerKeys, RHEA } from './a-read-grant.test-support.js';

aCompanyWhoseSignersChange(2);

describe('A READ GRANT GIVEN AND TAKEN AWAY BY THE SIGNERS AT THE SEAT BAR', () => {
  it('RHEA READS THE SIGNERS, THE PROPOSALS\' SUMMARIES AND THE POLICY ONCE TWO WALLETS SIGNED HER GRANT, FILES NOTHING, AND OPENS NOTHING SEALED AFTER IT IS TAKEN AWAY', async () => {
    /* A proposal raised before any grant: Ada's removal of Cy, waiting for Bo's approval. Its summary is sealed under the proposals purpose. */
    expect(await removeSignerOnDevice(deviceOf(ADA), { viewingKey: KEY, leaf: CY.seat, name: 'cy' })).toMatchObject({ state: 'waiting-for-approvals' });
    const raised = store.listProposals(CO)[0]!;
    const policyVersion = await aPolicyFiledBy(ADA, [ADA, BO, CY]);

    /* Ada's wallet gives Rhea a limited read grant: one signature of the two the bar needs. */
    const rhea = grantEntryOf({ recipient: RHEA.recipient, person: RHEA.person, role: 'limited' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { give: rhea })).toMatchObject({ state: 'waiting-for-signers', by: 1, needed: 2 });
    /* RED WHEN: a grant one signer filed is believed below the seat bar, so one wallet alone could hand a stranger the company's records. */
    expect(await readerKeys(RHEA)).toBeNull();
    /* RED WHEN: the version still waiting for the bar is sealed to Rhea or carries her purpose keys. */
    const waitingVersion = (await grantsKept()).at(-1)!;
    expect(waitingVersion.wrapped.some((w) => w.signerId === readerIdOf(RHEA.recipient))).toBe(false);

    /* Bo's wallet signs the same change: it is in force. */
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { give: rhea })).toMatchObject({ state: 'in-force', by: 2, needed: 2, takesAway: false });
    const held = await readerKeys(RHEA);
    expect(held).not.toBeNull();
    const at0 = keysByPurpose(held!).at(0);
    /* RED WHEN: a reader holding only its purpose wraps cannot open the signers through the seam. */
    expect(openRoster(store.newestRoster(CO)!, at0).signers.map((s) => s.name).sort()).toEqual(['ada', 'bo', 'cy']);
    /* RED WHEN: a reader cannot open a proposal's summary through the seam. */
    expect(openRecord<{ kind?: string }>('proposals', CO, raised.sealed, keysByPurpose(held!).at(raised.keyEpoch))).toMatchObject({ kind: expect.any(String) });
    /* RED WHEN: a limited reader holds a key for anything its role does not read: the people, the runs, the company's vaults. */
    for (const purpose of ['people', 'payroll', 'vaults', 'one-offs', 'vendors', 'inbox'] as const) {
      expect(() => keyForThePurpose(at0, CO, purpose), purpose).toThrow(/holds no key for the "[a-z-]+" records/u);
    }
    /* RED WHEN: a reader's keys answer a former key, so it opens a person sealed under payroll before people had their own purpose. */
    expect(at0.formerKeyFor).toBeUndefined();

    /* RED WHEN: a reader holds a seat: it would approve on the chain, be counted by a threshold or be wrapped the company key. */
    const here = await directoryOf(ADA)();
    expect(here.dir.seats.some((x) => x.wrappingKey.toLowerCase() === RHEA.recipient)).toBe(false);
    expect(seatsOnTheChain()).toHaveLength(3);
    /* RED WHEN: a reader may file a proposal or invite: no entry of the directory files for her key, and her role invites nobody. */
    expect(filingRefusalOf(here.dir, here.holders.seats as never, RHEA.recipient, 'proposal', 'company:proposal:x', 1)).toBe('no-entry');
    expect(mayInvite({ role: 'limited' })).toBe(false);

    /* The vault's spending policy, sealed to the seats before the grant, does not open for Rhea; Ada's device seals it again to her. */
    const resealed = await sealPoliciesToNewSignersHere({ records: await policyFilingOf(ADA), accountId: CO, viewingKey: KEY, keyEpoch: 0, filingKey: ADA.statement.signingKey });
    expect(resealed).toMatchObject({ sealed: [expect.any(String)], refused: [] });
    const policyVersions = await peopleRecords.versions(CO, SPENDING_POLICY_KIND, resealed.sealed[0]!);
    const rheaOpens = { signerId: readerIdOf(RHEA.recipient), wrappingSecret: RHEA.wrappingSecret };
    expect(() => openSpendingPolicy(policyVersions[policyVersion - 1]!, rheaOpens)).toThrow(/not sealed to you/u);
    /* RED WHEN: a policy is sealed again to the seats alone, so a reader granted the policy purpose opens none (F12). */
    expect(openSpendingPolicy(policyVersions.at(-1)!, rheaOpens).secrets.vault).toBe(VAULT);

    /* Abe, an accountant, is granted the same way: he reads the people beside what Rhea reads. */
    const abe = grantEntryOf({ recipient: ABE.recipient, person: ABE.person, role: 'accountant' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { give: abe })).toMatchObject({ state: 'waiting-for-signers' });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { give: abe })).toMatchObject({ state: 'in-force', by: 2 });
    const abeHeld = await readerKeys(ABE);
    expect(keysByPurpose(abeHeld!).at(0).keyFor('people', CO)).not.toBeNull();
    expect(keysByPurpose((await readerKeys(RHEA))!).at(0).keyFor('people', CO)).toBeNull();

    /* Rhea's grant is taken away: below the bar nothing changes, at the bar every device stops sealing under the key she holds. */
    expect(await grantsChangeFiledHere(await grantsDoorsOf(ADA), { takeAway: RHEA.recipient })).toMatchObject({ state: 'waiting-for-signers', takesAway: true });
    expect((await keysOf(BO)).notSealing).toBeNull();
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { takeAway: RHEA.recipient })).toMatchObject({ state: 'in-force', by: 2, takesAway: true });
    /* RED WHEN: a device goes on sealing under the key a reader whose grant was taken away still holds. */
    expect((await keysOf(ADA)).notSealing).toMatch(/a read grant was taken away.*The next action a signer who stays makes in their wallet changes it first/su);
    /* RED WHEN: the service leaving out the version that took the grant away reads as nothing taken away, so devices seal on. */
    const takeAway = (await grantsKept()).at(-1)!.version;
    const withheld = await companyKeyHere({
      ...companyKeyDoorsOf(ADA), accountId: CO, material: { signingSecret: ADA.signingSecret }, records: deviceOf(ADA).records!,
      revoked: () => revokedAtHere({
        accountId: CO, versions: async () => (await grantsKept()).filter((r) => r.version !== takeAway), directory: directoryOf(ADA),
        signingPublicKey: signingPublicKeyOf(ADA.signingSecret as Hex), released: async () => walletOf(ADA).companyKey,
      }),
    });
    expect(withheld.notSealing).toMatch(new RegExp(`read grants could not be read .*name version ${takeAway} of them and the service did not give it`, 'su'));
    /* RED WHEN: a seat whose wallet has not released the company's key reads the grants as nothing taken away. */
    await expect(revokedAtHere({
      accountId: CO, versions: grantsKept, directory: directoryOf(ADA), signingPublicKey: signingPublicKeyOf(ADA.signingSecret as Hex), released: async () => null,
    })).rejects.toThrow(/your wallet has not released the company's key on this visit.*Open the company with your wallet/su);
    /* RED WHEN: a signer may file the grants again at a key epoch the company never reached, and every later change is refused. */
    const inForceNow = (await grantsKept()).at(-1)!;
    const opened = openGrants(inForceNow, { signerId: ADA.seat, wrappingSecret: recordsSecretOf(ADA) })!;
    const inflated = sealGrants({
      company: CO, version: inForceNow.version + 1, keyEpoch: 5, seats: await (await grantsDoorsOf(ADA)).seats(),
      grants: { ...opened, wraps: purposeWrapsFor(opened.entries, () => newSymmetricKey(), 5) },
    });
    await (await grantsDoorsOf(ADA)).file(inflated);
    expect((await grantsHere({ accountId: CO, versions: grantsKept, directory: directoryOf(BO), me: { signerId: BO.seat, wrappingSecret: recordsSecretOf(BO) } }))
      .refused.get(inflated.version)).toBe('epoch-not-reached');
    /* RED WHEN: a chain read with no seat bar counts one signature as the bar. */
    const noBar = async (asked?: Parameters<ReturnType<typeof directoryOf>>[0]) => {
      const here = await directoryOf(BO)(asked);
      return { ...here, holders: { ...here.holders, seatBar: Number.NaN } };
    };
    await expect(grantsHere({ accountId: CO, versions: grantsKept, directory: noBar, me: { signerId: BO.seat, wrappingSecret: recordsSecretOf(BO) } }))
      .rejects.toThrow(/read without the approvals a change of who is seated needs\. Reload the page/u);

    /* Bo's device repairs the company's key: a new key for the same seats, the payout seed kept, after no retirement. */
    expect(await rotateTheCompanyKeyHere({
      ...companyKeyDoorsOf(BO), accountId: CO, material: { signingSecret: BO.signingSecret }, records: deviceOf(BO).records!, leaving: async () => new Set<string>(),
    })).toMatchObject({ state: 'rotated', epoch: 1 });
    const repair = store.directoryFilingsOf(CO).at(-1)!.change as { kind: string; repairs?: number; seed?: unknown; wraps: readonly { seat: string }[] };
    expect([repair.kind, repair.repairs, repair.seed]).toEqual(['rotate', 0, undefined]);
    /* RED WHEN: a reader is wrapped the company key: the repair goes to the seats alone. */
    expect(repair.wraps.map((w) => w.seat).sort()).toEqual([ADA.seat, BO.seat, CY.seat].sort());
    const ada = await keysOf(ADA);
    expect([ada.epoch, ada.notSealing]).toEqual([1, null]);
    /* The grants in force wrapped again to the new key, for Abe. */
    expect(await grantsWrappedAgainHere(await grantsDoorsOf(BO))).toEqual({ state: 'filed' });

    /* A proposal's summary sealed after the repair. */
    const after = sealRecord('proposals', CO, { kind: 'after-the-repair' }, ada.keyAt(1));
    /* RED WHEN: a reader who stays reads nothing sealed under the repaired key, because the grants are not wrapped again. */
    expect(openRecord<{ kind: string }>('proposals', CO, after, keysByPurpose((await readerKeys(ABE))!).at(1))).toEqual({ kind: 'after-the-repair' });
    /* RED WHEN: Rhea, her grant taken away, opens a record sealed after the repair, with any key she was ever wrapped. */
    const rheaNow = (await readerKeys(RHEA)) ?? held!;
    for (const k of [...keysByPurpose(rheaNow).everyEpoch(), ...keysByPurpose(held!).everyEpoch()]) {
      expect(() => openRecord('proposals', CO, after, k)).toThrow();
    }
    expect(() => openRecord('proposals', CO, after, keysByPurpose(rheaNow).at(1))).toThrow(/holds no key for the "proposals" records/u);
    /* What she opened before is still hers: the accepted risk, not a defect. */
    expect(openRecord<{ kind?: string }>('proposals', CO, raised.sealed, at0)).toMatchObject({ kind: expect.any(String) });
  }, 170_000);
});
