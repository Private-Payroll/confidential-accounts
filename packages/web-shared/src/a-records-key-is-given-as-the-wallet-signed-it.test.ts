import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, toHex } from '../../../src/core/crypto.js';
import { vaultKeysAreTheSigners } from '../../../src/core/vault-keys.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { giveVaultKeys } from './vault-page-doors.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { storedSignerLeaf } from '../../../src/core/signer-leaf.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';

/*
 * A signer's vault keys go to the company with their wallet's own statement
 * over the records key beside them, and only for the records key this device
 * works out from the same release.
 */
const CO = `co_${'c1'.repeat(32)}` as CompanyLabel;
const me = identityFromSecret(new Uint8Array(32).fill(1));
const companyKey = new Uint8Array(32).fill(0x21);
const committeeKey = committeeKeyFor(me, CO) as { tag: string; value: string };
const signing = newSigningKeypair();
const SEAT = '4b'.repeat(32);

const giving = () => {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const api = async (path: string, init?: RequestInit) => { sent.push({ path, body: JSON.parse(String(init?.body)) }); return {}; };
  return { sent, api };
};

describe('A SIGNER\'S RECORDS KEY IS GIVEN AS THEIR WALLET SIGNED IT', () => {
  it('sends the wallet\'s statement beside the two keys, signed into this signer\'s own roster entry', async () => {
    const { sent, api } = giving();
    const statement = signRecordsKey(me, CO, 'c0'.repeat(32) as never, companyKey, SEAT);
    await giveVaultKeys(api, 'acc_1', {
      committeeKey, companyKey: toHex(companyKey), signingSecret: signing.secret, signerId: 's1', viewingKey: 'vk' as never,
      recordsKey: statement,
    });
    expect(sent).toHaveLength(1);
    /* RED WHEN: the statement is left behind, so no other signer's device can check this signer's key. */
    expect(sent[0]!.body.recordsKeyStatement).toBe(statement.signature);
    /* RED WHEN: the seat the statement is signed for is left behind, so no device can hold it to the seats held now. */
    expect(sent[0]!.body.recordsKeySeat).toBe(SEAT);
    expect(sent[0]!.body.recordsKey).toBe(recordsKeypairFrom(companyKey).publicKey);
    /* And the roster signature still covers the two keys, as before. */
    expect(vaultKeysAreTheSigners('acc_1', {
      id: 's1', signingPublicKey: signing.publicKey, vaultKeys: sent[0]!.body as never,
    })).toBe(true);
  });

  it('REFUSES, SENDING NOTHING, A STATEMENT FOR ANY OTHER RECORDS KEY THAN THE ONE THIS DEVICE DERIVES', async () => {
    const { sent, api } = giving();
    const forAnother = signRecordsKey(me, CO, 'c0'.repeat(32) as never, new Uint8Array(32).fill(0x22), SEAT);
    /* RED WHEN: a statement for a key other than the one the company key opens is sent as this signer's. */
    await expect(giveVaultKeys(api, 'acc_1', {
      committeeKey, companyKey: toHex(companyKey), signingSecret: signing.secret, signerId: 's1', viewingKey: 'vk' as never,
      recordsKey: forAnother,
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
