/**
 * **THE PAGE ACCEPTS NO RECORDS KEY THE ROSTER IT OPENED DOES NOT NAME, AND
 * JUDGES NO COMMITTEE BY THE ROSTER.** The committee is the super admins' keys,
 * the company's own choice, so a key no signer holds is as good as any. The
 * page's own vault routes, `vaultServiceFor`, over a stand-in for the
 * service's answers and a real roster: each signer's keys signed with their
 * own roster signing key.
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair, type Hex } from '../../../src/core/crypto.js';
import { signVaultKeys } from '../../../src/core/vault-keys.js';
import type { Account } from '../../../src/core/types.js';
import { vaultServiceFor } from './vault-page-doors.js';

const k = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const r = (n: number) => n.toString(16).padStart(2, '0').repeat(32) as Hex;
const ADA = newSigningKeypair();
const BO = newSigningKeypair();
const entry = (id: string, pair: { publicKey: Hex; secret: Hex }, n: number) => ({
  id, userId: id, name: id, status: 'active', signingPublicKey: pair.publicKey,
  vaultKeys: signVaultKeys('acc_1', id, { committeeKey: k(n), recordsKey: r(n + 0x10) }, pair.secret),
});
const roster = { id: 'acc_1', signers: [entry('ada', ADA, 1), entry('bo', BO, 2)], notBelieved: [] as string[] } as unknown as Account & { readonly notBelieved: readonly string[] };
const VAULT = 'ab'.repeat(32) as Hex;

const serviceAnswering = (answers: Record<string, unknown>) => vaultServiceFor(async (path) => {
  const found = Object.entries(answers).find(([suffix]) => path.endsWith(suffix));
  if (!found) throw new Error(`nothing answers ${path}`);
  return found[1];
}, 'acc_1', async () => roster);

describe('A COMMITTEE THE SERVICE REPORTS', () => {
  it('is taken as it is, a key no roster entry names among its keys', async () => {
    /* RED WHEN: `keys()` compares the committee with the roster's keys - a company whose super admins hold a key no signer does could then build no vault. */
    const keys = { committee: { committee: [k(1), k(9)], threshold: 2 }, why: null, readers: [r(0x11), r(0x12)] };
    expect(await serviceAnswering({ '/vault-keys': keys }).keys()).toEqual(keys);
  });

  it('A VAULT HELD BY A COMMITTEE WITH A KEY NO ROSTER ENTRY NAMES IS READ AS IT IS SERVED, AND ITS SET-UP FINISHES', async () => {
    const held = {
      vault: VAULT, onChain: true, heldByCommittee: true, fundable: true, why: null,
      committee: { committee: [k(1), k(9)], threshold: 2 },
      authority: { committee: [k(1), k(9)], threshold: 2, counter: '1', shape: 'committee' },
    };
    /* RED WHEN: the page reads such a vault as not held - its set-up then never finishes. */
    expect(await serviceAnswering({ [`/vaults/${VAULT}/chain`]: held }).chain(VAULT)).toEqual(held);
  });
});

describe('THE COMMITTEE A NEW VAULT IS HANDED TO', () => {
  it('IS THE ONE OFFERED, A KEY NO ROSTER ENTRY NAMES AMONG ITS KEYS', async () => {
    const owed = {
      vault: VAULT, onChain: true, heldByCommittee: false, fundable: false, why: null,
      committee: { committee: [k(1), k(9)], threshold: 2 },
      authority: { committee: [k(5)], threshold: 1, counter: '0', shape: 'one-key' },
    };
    /* RED WHEN: the committee offered for the handover is taken away for a key no signer holds - the vault is then never handed over. */
    expect((await serviceAnswering({ [`/vaults/${VAULT}/chain`]: owed }).chain(VAULT)).committee).toEqual({ committee: [k(1), k(9)], threshold: 2 });
  });
});

describe('A RECORDS KEY THE SERVICE REPORTS', () => {
  it('IS REFUSED BEFORE THE VAULT\'S SECRET IS WRAPPED TO IT WHEN THE ROSTER DOES NOT NAME IT', async () => {
    /* RED WHEN: the readers are taken on the service's word - the vault's secret is then wrapped to a key the service holds. */
    await expect(serviceAnswering({
      '/vault-keys': { committee: { committee: [k(1), k(2)], threshold: 2 }, why: null, readers: [r(0x11), r(0x77)] },
    }).keys()).rejects.toThrow(/1 records key\(s\) the company's own roster does not name/u);
  });

  it('IS REFUSED WHEN THE SERVICE LEAVES OUT A RECORDS KEY THE ROSTER NAMES, WHATEVER IT SAYS OF THE COMMITTEE', async () => {
    /* RED WHEN: only a stranger's key is refused and a missing one is not - a signer is then left out of the vault's
     * readers and cannot read its records. */
    await expect(serviceAnswering({
      '/vault-keys': { committee: { committee: [k(1), k(2)], threshold: 2 }, why: null, readers: [r(0x11)] },
    }).keys()).rejects.toThrow(/left 1 records key the company's own roster names out of the vault/u);
    /* RED WHEN: the signers' check of the readers is turned off by the service reporting no committee - the super
     * admins' side would then decide whom a vault's secret is wrapped to. */
    const noCommittee = { committee: null, why: 'no committee holds this company\'s account yet', readers: [] };
    await expect(serviceAnswering({ '/vault-keys': noCommittee }).keys()).rejects.toThrow(/left 2 records keys the company's own roster names out of the vault/u);
    const whole = { committee: null, why: 'no committee holds this company\'s account yet', readers: [r(0x11), r(0x12)] };
    await expect(serviceAnswering({ '/vault-keys': whole }).keys()).resolves.toEqual(whole);
  });
});
