import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, toHex } from '../../../src/core/crypto.js';
import { vaultKeysAreTheSigners, vaultKeysOfferRefusal, type VaultKeysOffer } from '../../../src/core/vault-keys.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { offerVaultKeysHere } from './roster-here.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { storedSignerLeaf } from '../../../src/core/signer-leaf.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';

/*
 * A signer's vault keys are offered to the company with their wallet's own
 * statement over the records key beside them, and only for the records key
 * this device works out from the same release.
 */
const CO = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'ac'.repeat(32) as never;
const me = identityFromSecret(new Uint8Array(32).fill(1));
const companyKey = new Uint8Array(32).fill(0x21);
const committeeKey = committeeKeyFor(me, CO) as { tag: 'schnorr'; value: string };
const signing = newSigningKeypair();
const SEAT = '4b'.repeat(32);
const ENTRY = signDirectoryEntry(me, CO, ACCOUNT, companyKey, signing.publicKey, SEAT);

const giving = () => {
  const sent: Array<{ path: string; method?: string; body: { offer: VaultKeysOffer } }> = [];
  const api = async (path: string, init?: RequestInit) => {
    sent.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) }); return {};
  };
  return { sent, api };
};

describe('A SIGNER\'S RECORDS KEY IS OFFERED AS THEIR WALLET SIGNED IT', () => {
  it('offers the wallet\'s statement beside the two keys, signed into this signer\'s own roster entry, with the entry the wallet signed', async () => {
    const { sent, api } = giving();
    const statement = signRecordsKey(me, CO, 'c0'.repeat(32) as never, companyKey, SEAT);
    await offerVaultKeysHere(api, 'acc_1', {
      committeeKey: committeeKey as never, companyKey: toHex(companyKey), signingSecret: signing.secret, signerId: 's1',
      recordsKey: statement, entry: ENTRY,
    });
    expect(sent.map((x) => `${x.method} ${x.path}`)).toEqual(['PUT /api/accounts/acc_1/vault-keys']);
    const { offer } = sent[0]!.body;
    /* RED WHEN: the statement is left behind, so no other signer's device can check this signer's key. */
    expect(offer.keys.recordsKeyStatement).toBe(statement.signature);
    /* RED WHEN: the seat the statement is signed for is left behind, so no device can hold it to the seats held now. */
    expect(offer.keys.recordsKeySeat).toBe(SEAT);
    expect(offer.keys.recordsKey).toBe(recordsKeypairFrom(companyKey).publicKey);
    /* RED WHEN: the offer carries no entry signed by the wallet, so the service cannot hold its signature to a seat's own key. */
    expect(offer.entry).toEqual({ committeeKey, statement: ENTRY });
    /* And the roster signature covers the two keys, and the company keeps the offer as it came. */
    expect(vaultKeysAreTheSigners('acc_1', { id: 's1', signingPublicKey: signing.publicKey, vaultKeys: offer.keys })).toBe(true);
    expect(vaultKeysOfferRefusal(CO, ACCOUNT, 'acc_1', offer)).toBeNull();
  });

  it('REFUSES, SENDING NOTHING, A STATEMENT FOR ANY OTHER RECORDS KEY THAN THE ONE THIS DEVICE DERIVES', async () => {
    const { sent, api } = giving();
    const forAnother = signRecordsKey(me, CO, 'c0'.repeat(32) as never, new Uint8Array(32).fill(0x22), SEAT);
    /* RED WHEN: a statement for a key other than the one the company key opens is offered as this signer's. */
    await expect(offerVaultKeysHere(api, 'acc_1', {
      committeeKey: committeeKey as never, companyKey: toHex(companyKey), signingSecret: signing.secret, signerId: 's1',
      recordsKey: forAnother, entry: ENTRY,
    })).rejects.toThrow(/not the one your company key gives/);
    expect(sent).toEqual([]);
  });
});

/*
 * The seat a records key is signed for is the one this signer's own key
 * material makes, worked out where the account's circuits are loaded, with the
 * one definition every writer of a seat calls.
 */
describe('THE SEAT A RECORDS KEY IS SIGNED FOR IS THE ONE THIS DEVICE\'S OWN KEY MAKES', () => {
  const ownSeat = async (material: Record<string, string>) => {
    const a = await answerVaultAsk(async () => ({}) as never, { id: 1, network: 'undeployed', ask: 'own-seat', material: material as never });
    if (!a.ok || a.ask !== 'own-seat') throw new Error(a.ok ? 'another answer' : a.error);
    return a.seat;
  };

  /* RED WHEN: the worker answers with anything but the leaf the writers of a seat make from this material, scope included. */
  it('is the leaf the writers of a seat make from the same material', async () => {
    const material = { signingSecret: '1c'.repeat(32), blinding: '2d'.repeat(32) };
    expect(await ownSeat(material)).toBe(storedSignerLeaf(material, MidnightCommitments).toLowerCase());
    const scoped = { ...material, scope: '3e'.repeat(32) };
    expect(await ownSeat(scoped)).toBe(storedSignerLeaf(scoped, MidnightCommitments).toLowerCase());
    expect(await ownSeat(scoped)).not.toBe(await ownSeat(material));
    expect(await ownSeat({ ...material, blinding: '2e'.repeat(32) })).not.toBe(await ownSeat(material));
  });

  /* RED WHEN: a seat is worked out from material that cannot make one. */
  it('is refused for material that cannot make a seat', async () => {
    await expect(ownSeat({ signingSecret: 'aa', blinding: '2d'.repeat(32) })).rejects.toThrow(/no usable key for its seat/);
    await expect(ownSeat({ signingSecret: '1c'.repeat(32), blinding: 'cc' })).rejects.toThrow(/no usable key for its seat/);
  });
});
