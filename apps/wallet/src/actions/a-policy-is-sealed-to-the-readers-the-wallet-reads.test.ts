/**
 * **A SPENDING POLICY IS SEALED TO THE READERS THE WALLET READS FROM THE GRANTS IN FORCE.** Acme's signers at the seat
 * bar give Rhea a limited read grant; the wallet's own door to a vault's spending policies (`spendingPoliciesFor`) reads
 * her as a reader of the policy purpose, and a policy sealed again through it opens for her. Over real HTTP with the
 * company of `a-company-whose-signers-change-on-the-chain.test-support.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../../src/core/crypto.js';
import { grantEntryOf, readerIdOf } from '../../../../src/midnight/grants-record.js';
import { VIEWING_KEY_FIELD } from '../../scripts/viewing-key-tripwire.mjs';
import { openSpendingPolicy, SPENDING_POLICY_KIND } from '../../../../src/midnight/spending-policy-record.js';
import { sealPoliciesToNewSignersHere } from '../../../../packages/web-shared/src/spending-policy-here.js';
import { grantsChangeFiledHere } from '../../../../packages/web-shared/src/grants-filed-here.js';
import { peopleRecords } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, ADDRESS, apiAs, aPolicyFiledBy, BO, CO, CY, directoryOf, KEY, LABEL, VAULT, walletOf, type Seat,
} from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { grantsDoorsOf, keysOf, policyFilingOf, RHEA } from '../../../../src/server/a-read-grant.test-support.js';
import { spendingPoliciesFor, type SpendingPoliciesReach } from './spending-policies-reach.js';

type ResealDoors = Parameters<typeof sealPoliciesToNewSignersHere>[0];

aCompanyWhoseSignersChange(2);

/** The part of `s`'s wallet reach its spending policies' readers are read through; the rest refuses, being unused here. */
const walletReachOf = async (s: Seat): Promise<SpendingPoliciesReach> => ({
  leaf: s.seat as Hex, companyKey: walletOf(s).companyKey, api: apiAs(s.person), accountId: CO, account: ADDRESS, label: LABEL,
  companyKeys: await keysOf(s), roster: async () => { throw new Error('the policy readers read no roster'); },
  builder: { spendingPolicyKeys: async () => { throw new Error('the policy readers make no policy keys'); } }, chain: {},
  judges: { directoryHereFor: () => directoryOf(s) },
});

describe('A SPENDING POLICY SEALED THROUGH THE WALLET\'S OWN DOOR', () => {
  it('IS SEALED TO THE READER THE GRANTS IN FORCE GIVE THE POLICY PURPOSE, AND OPENS FOR HER', async () => {
    const version = await aPolicyFiledBy(ADA, [ADA, BO, CY]);
    const rhea = grantEntryOf({ recipient: RHEA.recipient, person: RHEA.person, role: 'limited' });
    await grantsChangeFiledHere(await grantsDoorsOf(ADA), { give: rhea });
    expect(await grantsChangeFiledHere(await grantsDoorsOf(BO), { give: rhea })).toMatchObject({ state: 'in-force' });
    const wallet = spendingPoliciesFor(await walletReachOf(ADA));
    /* RED WHEN: the wallet's door reads no reader of the grants in force, so every policy it seals leaves readers out (F12). */
    expect(await wallet.grantReaders()).toEqual([{ id: readerIdOf(RHEA.recipient), wrappingPublicKey: RHEA.recipient }]);
    const records = await policyFilingOf(ADA);
    /* The field name comes from the tripwire's own constant, so its type is `string`; the cast gives the one key it names its real type. */
    const theCompanyKey = { [VIEWING_KEY_FIELD]: KEY } as Pick<ResealDoors, Exclude<keyof ResealDoors & `${string}Key`, 'filingKey'>>;
    const resealed = await sealPoliciesToNewSignersHere({
      records: { ...records, spendingPolicies: { ...records.spendingPolicies!, grantReaders: wallet.grantReaders } },
      accountId: CO, ...theCompanyKey, keyEpoch: 0, filingKey: ADA.statement.signingKey,
    });
    expect(resealed).toMatchObject({ sealed: [expect.any(String)], refused: [] });
    const versions = await peopleRecords.versions(CO, SPENDING_POLICY_KIND, resealed.sealed[0]!);
    const rheaOpens = { signerId: readerIdOf(RHEA.recipient), wrappingSecret: RHEA.wrappingSecret };
    expect(() => openSpendingPolicy(versions[version - 1]!, rheaOpens)).toThrow(/not sealed to you/u);
    /* RED WHEN: a policy sealed through the wallet's door does not open for a reader granted the policy purpose. */
    expect(openSpendingPolicy(versions.at(-1)!, rheaOpens).secrets.vault).toBe(VAULT);
  }, 170_000);
});
