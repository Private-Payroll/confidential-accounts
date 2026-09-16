/**
 * **A DEPOSIT'S COIN CHOSEN ON THE DEVICE**, against in-memory stores. The same
 * journey over the real route, with a rebuild and a spend, is
 * `contracts/test/a-deposit-made-on-the-device.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  depositCoinOnThisDevice, startVaultNonceSecretOnThisDevice, recordsReaderOf, type DeviceSigner, type DeviceRecords,
} from './deposit-on-device.js';
import { MemorySealedPoolStore, SealedNotePool, type PoolSigner } from '../midnight/vault-pool.js';
import {
  openNonceSecrets, recordsKeypairFrom, rotateNonceSecret, currentDepositNonceKey,
} from '../midnight/company-nonce-secret.js';
import { depositNonceAt, DepositCoinAlreadyMade } from '../midnight/deposit-nonce.js';
import { newWrappingKeypair, type Hex } from '../core/crypto.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';

const VAULT = 'ab'.repeat(32) as Hex;
const GBP = 'aa'.repeat(32) as Hex;
const person = (id: string, fill: number) => {
  const w = newWrappingKeypair();
  return {
    me: { signerId: id, wrappingSecret: w.secret, companyKey: new Uint8Array(32).fill(fill) } as DeviceSigner,
    who: { id, wrappingPublicKey: w.publicKey } as PoolSigner,
  };
};
const storesFor = (): { records: DeviceRecords; kept: Map<WireRecord, MemorySealedPoolStore> } => {
  const kept = new Map<WireRecord, MemorySealedPoolStore>();
  return { kept, records: (r) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)! };
};
const nothingMade = { everCreated: new Set<string>(), outputCommitmentOf: () => 'none', heldNow: () => false };

describe('a deposit\'s coin, chosen on the device', () => {
  it('IS DERIVED FROM THE VAULT\'S CURRENT EPOCH AT THE FIRST FREE SLOT, by any signer, and filed as a sealed line', async () => {
    const ada = person('ada', 1); const bo = person('bo', 2);
    const { records, kept } = storesFor();
    await startVaultNonceSecretOnThisDevice(VAULT, ada.me, [recordsReaderOf(bo.me.companyKey)], records, new Set());
    await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: ada.me.wrappingSecret }, async () => [ada.who, bo.who]).create(VAULT, { notes: [] });
    const signers = async () => [ada.who, bo.who];
    const made = { ...nothingMade, everCreated: new Set(['x', 'y']) };
    const byBo = await depositCoinOnThisDevice({ vault: VAULT, money: { token: GBP, value: 70n }, me: bo.me, signers, records, chain: made });
    const secrets = openNonceSecrets((await kept.get('nonce-secret')!.get(VAULT))!, VAULT, recordsKeypairFrom(ada.me.companyKey));
    expect(byBo.slot, 'RED WHEN: the slot is not the one after everything the vault has made').toBe(3);
    expect(byBo.coin.nonce, 'RED WHEN: a signer\'s deposit is not derived from the company\'s secret, so only they could name it')
      .toBe(depositNonceAt(currentDepositNonceKey(secrets), { token: GBP, value: 70n }, 3));
    expect(byBo.epoch).toBe(1);
    expect((await kept.get('deposit-journal')!.versions(VAULT)), 'the line is filed before the coin is handed back').toHaveLength(1);
    expect(JSON.stringify(await kept.get('deposit-journal')!.versions(VAULT)), 'RED WHEN: the line is filed in the clear').not.toContain(byBo.coin.nonce);
  });

  it('DEPOSITS UNDER THE NEWEST EPOCH, and refuses when the pool already holds the coin at every slot', async () => {
    const ada = person('ada', 1); const bo = person('bo', 2);
    const { records, kept } = storesFor();
    await startVaultNonceSecretOnThisDevice(VAULT, ada.me, [recordsReaderOf(bo.me.companyKey)], records, new Set());
    const store = kept.get('nonce-secret')!;
    await store.put(VAULT, rotateNonceSecret((await store.get(VAULT))!, VAULT, recordsKeypairFrom(ada.me.companyKey),
      { remaining: [recordsReaderOf(ada.me.companyKey)], leaving: [recordsReaderOf(bo.me.companyKey)] }));
    const pool = new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: ada.me.wrappingSecret }, async () => [ada.who, bo.who]);
    await pool.create(VAULT, { notes: [] });
    const got = await depositCoinOnThisDevice({ vault: VAULT, money: { token: GBP, value: 9n }, me: ada.me, signers: async () => [ada.who, bo.who], records, chain: nothingMade });
    expect(got.epoch, 'RED WHEN: a deposit is made under an epoch a signer who left knows').toBe(2);
    await expect(depositCoinOnThisDevice({ vault: VAULT, money: { token: GBP, value: 9n }, me: bo.me, signers: async () => [ada.who, bo.who], records, chain: nothingMade }),
      'RED WHEN: a signer who left deposits under the epoch before they left').rejects.toThrow(/no copy is wrapped/);
    await expect(depositCoinOnThisDevice({
      vault: VAULT, money: { token: GBP, value: 9n }, me: ada.me, signers: async () => [ada.who, bo.who], records,
      chain: { ...nothingMade, heldNow: () => true },
    }), 'RED WHEN: a coin the vault holds is made again').rejects.toBeInstanceOf(DepositCoinAlreadyMade);
  });

  it('REFUSES a deposit into a vault with no nonce secret, and a second secret for a vault that has one', async () => {
    const ada = person('ada', 1);
    const { records } = storesFor();
    await expect(depositCoinOnThisDevice({ vault: VAULT, money: { token: GBP, value: 9n }, me: ada.me, signers: async () => [ada.who], records, chain: nothingMade }),
      'RED WHEN: a deposit is made with no secret the company holds, so nobody could name it again').rejects.toThrow(/no nonce secret yet/);
    await expect(startVaultNonceSecretOnThisDevice(VAULT, ada.me, [], records, new Set(['made'])),
      'RED WHEN: a vault that already holds money and has lost its secret is given a new one, and every earlier deposit loses its name')
      .rejects.toThrow(/already made coins for this vault/);
    expect(await records('nonce-secret').versions(VAULT)).toEqual([]);
    await startVaultNonceSecretOnThisDevice(VAULT, ada.me, [], records, new Set());
    await expect(startVaultNonceSecretOnThisDevice(VAULT, ada.me, [], records, new Set())).rejects.toThrow(/already has a nonce secret/);
  });
});
