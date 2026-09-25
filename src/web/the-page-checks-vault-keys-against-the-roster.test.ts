/**
 * **THE PAGE ACCEPTS NO COMMITTEE KEY AND NO RECORDS KEY THE ROSTER IT OPENED
 * DOES NOT NAME.** The page's own vault routes, `vaultServiceFor`, over a
 * stand-in for the service's answers and a real roster: each signer's keys
 * signed with their own roster signing key.
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { signVaultKeys } from '../core/vault-keys.js';
import type { Account } from '../core/types.js';
import { vaultServiceFor } from './vault-page-doors.js';

const k = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const r = (n: number) => n.toString(16).padStart(2, '0').repeat(32) as Hex;
const ADA = newSigningKeypair();
const BO = newSigningKeypair();
const entry = (id: string, pair: { publicKey: Hex; secret: Hex }, n: number) => ({
  id, userId: id, name: id, status: 'active', signingPublicKey: pair.publicKey,
  vaultKeys: signVaultKeys('acc_1', id, { committeeKey: k(n), recordsKey: r(n + 0x10) }, pair.secret),
});
const roster = { id: 'acc_1', signers: [entry('ada', ADA, 1), entry('bo', BO, 2)] } as unknown as Account;
const VAULT = 'ab'.repeat(32) as Hex;

const serviceAnswering = (answers: Record<string, unknown>) => vaultServiceFor(async (path) => {
  const found = Object.entries(answers).find(([suffix]) => path.endsWith(suffix));
  if (!found) throw new Error(`nothing answers ${path}`);
  return found[1];
}, 'acc_1', async () => roster);

describe('A COMMITTEE THE SERVICE REPORTS', () => {
  it('is accepted when it is exactly the keys the roster names', async () => {
    const keys = { committee: { committee: [k(1), k(2)], threshold: 2 }, why: null, readers: [r(0x11), r(0x12)] };
    expect(await serviceAnswering({ '/vault-keys': keys }).keys()).toEqual(keys);
  });

  it('IS REFUSED BEFORE A VAULT IS BUILT FOR IT WHEN IT CARRIES A KEY THE ROSTER DOES NOT NAME', async () => {
    /* RED WHEN: `keys()` hands the service's committee on without asking the roster - a vault is then built for keys the service chose. */
    await expect(serviceAnswering({
      '/vault-keys': { committee: { committee: [k(1), k(9)], threshold: 2 }, why: null, readers: [r(0x11), r(0x12)] },
    }).keys()).rejects.toThrow(/roster does not name.*Nothing was built or sent/u);
  });

  it('A VAULT THE SERVICE READS AS HELD BY ITS COMMITTEE IS READ AS NOT HELD WHEN THE CHAIN\'S KEYS ARE NOT THE ROSTER\'S', async () => {
    const held = {
      vault: VAULT, onChain: true, heldByCommittee: true, fundable: true, why: null,
      committee: { committee: [k(1), k(2)], threshold: 2 },
      authority: { committee: [k(1), k(9)], threshold: 2, counter: '1', shape: 'committee' },
    };
    const view = await serviceAnswering({ [`/vaults/${VAULT}/chain`]: held }).chain(VAULT);
    /* RED WHEN: the page believes the service's word that the vault is held - a pool is then opened and money put in a vault another key can change. */
    expect(view).toMatchObject({ heldByCommittee: false, fundable: false, committee: null });
    expect(view.why).toMatch(/roster does not name/u);
    const honest = await serviceAnswering({
      [`/vaults/${VAULT}/chain`]: { ...held, authority: { ...held.authority, committee: [k(2), k(1)] } },
    }).chain(VAULT);
    expect(honest.heldByCommittee).toBe(true);
  });
});

describe('THE COMMITTEE A NEW VAULT IS HANDED TO', () => {
  it('IS TAKEN AWAY WHEN IT CARRIES A KEY THE ROSTER DOES NOT NAME, SO THE VAULT IS NOT HANDED TO IT', async () => {
    const owed = {
      vault: VAULT, onChain: true, heldByCommittee: false, fundable: false, why: null,
      committee: { committee: [k(1), k(9)], threshold: 2 },
      authority: { committee: [k(5)], threshold: 1, counter: '0', shape: 'one-key' },
    };
    const view = await serviceAnswering({ [`/vaults/${VAULT}/chain`]: owed }).chain(VAULT);
    /* RED WHEN: the committee the service offers for the handover is passed on unchecked - the vault is then handed to it. */
    expect(view.committee).toBeNull();
    expect(view.why).toMatch(/roster does not name/u);
    const honest = await serviceAnswering({
      [`/vaults/${VAULT}/chain`]: { ...owed, committee: { committee: [k(1), k(2)], threshold: 2 } },
    }).chain(VAULT);
    expect(honest.committee).toEqual({ committee: [k(1), k(2)], threshold: 2 });
  });
});

describe('A RECORDS KEY THE SERVICE REPORTS', () => {
  it('IS REFUSED BEFORE THE VAULT\'S SECRET IS WRAPPED TO IT WHEN THE ROSTER DOES NOT NAME IT', async () => {
    /* RED WHEN: the readers are taken on the service's word - the vault's secret is then wrapped to a key the service holds. */
    await expect(serviceAnswering({
      '/vault-keys': { committee: { committee: [k(1), k(2)], threshold: 2 }, why: null, readers: [r(0x11), r(0x77)] },
    }).keys()).rejects.toThrow(/1 records key\(s\) the company's own roster does not name/u);
  });
});
