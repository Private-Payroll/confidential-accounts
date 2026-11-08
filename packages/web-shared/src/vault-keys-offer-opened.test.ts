import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, toHex, type Hex } from '../../../src/core/crypto.js';
import type { CompanyKeys } from '../../../src/core/company-key.js';
import type { VaultKeysOffer } from '../../../src/core/vault-keys.js';
import { offerVaultKeysHere } from './roster-here.js';
import { vaultKeysOfferOpened } from './vault-keys-offer-opened.js';

/*
 * The one step that opens a kept vault-keys offer and holds it to the company it names. The fold of the roster and the
 * page's readiness both call it, so one offer is taken or refused the same way, for the same reason, by both.
 */
const CO = `co_${'c1'.repeat(32)}` as CompanyLabel;
const OTHER = `co_${'c2'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'ac'.repeat(32) as never;
const me = identityFromSecret(new Uint8Array(32).fill(1));
const companyKey = new Uint8Array(32).fill(0x21);
const committeeKey = committeeKeyFor(me, CO) as { tag: 'schnorr'; value: string };
const signing = newSigningKeypair();
const SEAT = '4b'.repeat(32);
const ENTRY = signDirectoryEntry(me, CO, ACCOUNT, companyKey, signing.publicKey, SEAT);
const OLD = '5e'.repeat(32) as Hex;
const NEW = '6f'.repeat(32) as Hex;

const offerSealedUnder = async (viewingKey: Hex): Promise<VaultKeysOffer> => {
  let kept: VaultKeysOffer | null = null;
  const statement = signRecordsKey(me, CO, 'c0'.repeat(32) as never, companyKey, SEAT);
  await offerVaultKeysHere(async (_p, init) => { kept = { ...JSON.parse(String(init?.body)).offer, person: 'p' }; return {}; }, 'acc_1', {
    committeeKey: committeeKey as never, companyKey: toHex(companyKey), signingSecret: signing.secret, signerId: 's1',
    recordsKey: statement, entry: ENTRY, viewingKey,
  });
  return kept!;
};
const keysAt = (epoch: number, key: Hex, older: Hex): CompanyKeys => ({
  epoch, key, newest: epoch, keyAt: (e: number) => (e === epoch ? key : older), sealing: () => ({ key, epoch }),
}) as never;

describe('A KEPT VAULT-KEYS OFFER, OPENED AND CHECKED ONCE FOR EVERY CALLER', () => {
  it('OPENS AN OFFER SEALED UNDER AN EARLIER KEY OF THE COMPANY THIS DEVICE STILL HOLDS', async () => {
    const kept = await offerSealedUnder(OLD);
    const opened = vaultKeysOfferOpened('acc_1', kept, keysAt(1, NEW, OLD), CO, ACCOUNT);
    /* RED WHEN: an offer made before the company's key changed is refused once it has. */
    expect(typeof opened).toBe('object');
  });

  it('REFUSES, WITH THE REASON, AN OFFER NO KEY THIS DEVICE HOLDS OPENS', async () => {
    const kept = await offerSealedUnder(OLD);
    const refused = vaultKeysOfferOpened('acc_1', kept, '7a'.repeat(32), CO, ACCOUNT);
    /* RED WHEN: an offer sealed under a key this device does not hold is taken, or refused with no reason a caller can give. */
    expect(typeof refused).toBe('string');
    expect((refused as string).length).toBeGreaterThan(0);
  });

  it('REFUSES, WITH THE REASON, AN OFFER FOR ANOTHER COMPANY THAN THE ONE ASKED ABOUT', async () => {
    const kept = await offerSealedUnder(OLD);
    const refused = vaultKeysOfferOpened('acc_1', kept, OLD, OTHER, ACCOUNT);
    /* RED WHEN: an offer whose wallet statements are for another company is taken. */
    expect(typeof refused).toBe('string');
  });
});

describe('NO CALLER OPENS AN OFFER BY ITS OWN STEPS', () => {
  it('NEITHER THE ROSTER FOLD NOR THE PAGE\'S READINESS NAMES THE OPENING OR THE REFUSAL CHECK: BOTH CALL `vaultKeysOfferOpened`', () => {
    const files = ['packages/web-shared/src/roster-here.ts', 'apps/web/src/adapters/vault-keys.ts'];
    for (const f of files) {
      const code = readFileSync(join(process.cwd(), f), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/u.test(l));
      /* RED WHEN: a second copy of the open-and-check is written beside the shared step. */
      expect(code.filter((l) => /\b(openVaultKeysOffer|vaultKeysOfferRefusal)\b/u.test(l)), f).toEqual([]);
      expect(code.some((l) => /\bvaultKeysOfferOpened\(/u.test(l)), f).toBe(true);
    }
  });
});
