/**
 * **A DEPOSIT'S COIN CHOSEN ON THE DEVICE**, against in-memory stores. The same
 * journey over the real route, with a rebuild and a spend, is
 * `contracts/test/a-deposit-made-on-the-device.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  depositCoinOnThisDevice, startVaultNonceSecretAgainOnThisDevice, startVaultNonceSecretOnThisDevice, recordsReaderOf,
  type DeviceSigner, type DeviceRecords,
} from './deposit-on-device.js';
import { MemorySealedPoolStore, SealedNotePool, type PoolSigner } from '../../../src/midnight/vault-pool.js';
import {
  openNonceSecrets, recordsKeypairFrom, rotateNonceSecret, currentDepositNonceKey, startNonceSecret, startNonceSecretAgain,
} from '../../../src/midnight/company-nonce-secret.js';
import { depositNonceAt, DepositCoinAlreadyMade } from '../../../src/midnight/deposit-nonce.js';
import { newWrappingKeypair, type Hex } from '../../../src/core/crypto.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';

const VAULT = 'ab'.repeat(32) as Hex;
const TOKEN = 'aa'.repeat(32) as Hex;
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
const nothingMade = { everCreated: new Set<string>(), outputCommitmentOf: () => 'none', heldNow: () => false, secretIsTheVaults: () => true };

describe('a deposit\'s coin, chosen on the device', () => {
  it('IS DERIVED FROM THE VAULT\'S CURRENT EPOCH AT THE FIRST FREE SLOT, by any signer, and filed as a sealed line', async () => {
    const ada = person('ada', 1); const bo = person('bo', 2);
    const { records, kept } = storesFor();
    await startVaultNonceSecretOnThisDevice(VAULT, ada.me, [recordsReaderOf(bo.me.companyKey)], records, new Set());
    await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: ada.me.wrappingSecret }, async () => [ada.who, bo.who]).create(VAULT, { notes: [] });
    const signers = async () => [ada.who, bo.who];
    const made = { ...nothingMade, everCreated: new Set(['x', 'y']) };
    const byBo = await depositCoinOnThisDevice({ vault: VAULT, money: { token: TOKEN, value: 70n }, me: bo.me, signers, records, chain: made });
    const secrets = openNonceSecrets((await kept.get('nonce-secret')!.get(VAULT))!, VAULT, recordsKeypairFrom(ada.me.companyKey));
    /* Two outputs of other money: neither is this money's coin, so the lowest slot is free. */
    expect(byBo.slot, 'RED WHEN: the slot is taken from the vault\'s output count rather than the lowest free slot').toBe(1);
    expect(byBo.coin.nonce, 'RED WHEN: a signer\'s deposit is not derived from the company\'s secret, so only they could name it')
      .toBe(depositNonceAt(currentDepositNonceKey(secrets), { token: TOKEN, value: 70n }, 1));
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
    const got = await depositCoinOnThisDevice({ vault: VAULT, money: { token: TOKEN, value: 9n }, me: ada.me, signers: async () => [ada.who, bo.who], records, chain: nothingMade });
    expect(got.epoch, 'RED WHEN: a deposit is made under an epoch a signer who left knows').toBe(2);
    await expect(depositCoinOnThisDevice({ vault: VAULT, money: { token: TOKEN, value: 9n }, me: bo.me, signers: async () => [ada.who, bo.who], records, chain: nothingMade }),
      'RED WHEN: a signer who left deposits under the epoch before they left').rejects.toThrow(/no copy is wrapped/);
    await expect(depositCoinOnThisDevice({
      vault: VAULT, money: { token: TOKEN, value: 9n }, me: ada.me, signers: async () => [ada.who, bo.who], records,
      chain: { ...nothingMade, heldNow: () => true },
    }), 'RED WHEN: a coin the vault holds is made again').rejects.toBeInstanceOf(DepositCoinAlreadyMade);
  });

  it('REFUSES a deposit into a vault with no nonce secret, and a second secret for a vault that has one', async () => {
    const ada = person('ada', 1);
    const { records } = storesFor();
    await expect(depositCoinOnThisDevice({ vault: VAULT, money: { token: TOKEN, value: 9n }, me: ada.me, signers: async () => [ada.who], records, chain: nothingMade }),
      'RED WHEN: a deposit is made with no secret the company holds, so nobody could name it again').rejects.toThrow(/no nonce secret yet/);
    await expect(startVaultNonceSecretOnThisDevice(VAULT, ada.me, [], records, new Set(['made'])),
      'RED WHEN: a vault that already holds money and has lost its secret is given a new one, and every earlier deposit loses its name')
      .rejects.toThrow(/already made coins for this vault/);
    expect(await records('nonce-secret').versions(VAULT)).toEqual([]);
    await startVaultNonceSecretOnThisDevice(VAULT, ada.me, [], records, new Set());
    await expect(startVaultNonceSecretOnThisDevice(VAULT, ada.me, [], records, new Set())).rejects.toThrow(/already has a nonce secret/);
  });

  it('HANDS BACK THE RECORD IT MADE, so the device that made the secret builds on that and not on what is read back', async () => {
    const ada = person('ada', 1);
    const { records } = storesFor();
    const made = await startVaultNonceSecretOnThisDevice(VAULT, ada.me, [], records, new Set());
    /* RED WHEN: what is handed back is not the record filed. */
    expect(made).toEqual(await records('nonce-secret').get(VAULT));
  });

  it('A FRESH FIRST SECRET IS FILED AS THE NEXT VERSION, ONLY OVER THE VERSION READ, AND NEVER FOR A VAULT WITH MONEY', async () => {
    const ada = person('ada', 1); const bo = person('bo', 2);
    const { records } = storesFor();
    const first = await startVaultNonceSecretOnThisDevice(VAULT, ada.me, [recordsReaderOf(bo.me.companyKey)], records, new Set());
    const opened = (r: Awaited<typeof first>, who = ada) => openNonceSecrets(r, VAULT, recordsKeypairFrom(who.me.companyKey));
    /* RED WHEN: a vault the chain has made coins for has its secret replaced, and its deposits lose their names. */
    await expect(startVaultNonceSecretAgainOnThisDevice(VAULT, bo.me, [recordsReaderOf(ada.me.companyKey)], records, new Set(['made']), first))
      .rejects.toThrow(/already made coins for this vault/);
    const again = await startVaultNonceSecretAgainOnThisDevice(VAULT, bo.me, [recordsReaderOf(ada.me.companyKey)], records, new Set(), first);
    /* RED WHEN: the fresh secret is the one before, or is not the newest version, or is not one epoch, or misses a signer. */
    expect(again.version).toBe(2);
    expect(await records('nonce-secret').get(VAULT)).toEqual(again);
    expect(opened(again).secrets).toHaveLength(1);
    expect(opened(again).secrets[0]).not.toBe(opened(first).secrets[0]);
    expect(opened(again, bo).secrets).toEqual(opened(again).secrets);
    /* RED WHEN: a fresh secret is anything but newly random - worked out from the vault or the record before, say. */
    const twice = [0, 1].map(() => opened(startNonceSecretAgain(first, VAULT, [recordsReaderOf(ada.me.companyKey)])).secrets[0]);
    expect(twice[0]).not.toBe(twice[1]);
    /* RED WHEN: a fresh secret is filed over a version the device did not read - somebody filed another since. */
    await expect(startVaultNonceSecretAgainOnThisDevice(VAULT, bo.me, [], records, new Set(), first))
      .rejects.toThrow(/another secret was filed for this vault/);
    expect((await records('nonce-secret').versions(VAULT))).toHaveLength(2);
    /* RED WHEN: a record of another vault is taken as the one a fresh secret follows. */
    const other = storesFor();
    const elsewhere = await startVaultNonceSecretOnThisDevice('cd'.repeat(32) as Hex, ada.me, [], other.records, new Set());
    await other.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(ada.me.companyKey)]));
    await expect(startVaultNonceSecretAgainOnThisDevice(VAULT, ada.me, [], other.records, new Set(), { ...elsewhere, version: 1 }))
      .rejects.toThrow(/is not this vault's, so nothing is written/);
  });

  it('REFUSES A DEPOSIT UNDER A SECRET THE VAULT DOES NOT HOLD, before a coin is chosen or a line is filed', async () => {
    const ada = person('ada', 1);
    const { records, kept } = storesFor();
    await startVaultNonceSecretOnThisDevice(VAULT, ada.me, [], records, new Set());
    const asked: string[] = [];
    /* RED WHEN: a deposit is made under the secret the records hold without asking whether the vault holds it. */
    await expect(depositCoinOnThisDevice({
      vault: VAULT, money: { token: TOKEN, value: 9n }, me: ada.me, signers: async () => [ada.who], records,
      chain: { ...nothingMade, secretIsTheVaults: (secret) => { asked.push(secret); return false; } },
    })).rejects.toThrow(/not the one the vault holds on the chain/);
    expect(asked).toEqual(openNonceSecrets((await records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(ada.me.companyKey)).secrets);
    expect(kept.get('deposit-journal')?.versions(VAULT) === undefined || (await kept.get('deposit-journal')!.versions(VAULT)).length === 0).toBe(true);
  });
});
