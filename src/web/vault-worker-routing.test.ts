import { describe, it, expect } from 'vitest';
import { accountCircuitsBeside, networkCircuitsBeside } from './vault-worker-entry.js';
import type { ArtefactSource } from './key-material.js';
import { ACCOUNT_CIRCUITS_A_VAULT_CALLS, VAULT_CIRCUITS } from '../midnight/vault-contract.js';

/*
 * Which of the served folders a location a prover asks for is fetched from. A
 * payment out proves the vault's `payout` and the account's `recordPayment`,
 * and the SDK names each by its contract, circuit and key hash.
 */
const source = (name: string, log: string[]): ArtefactSource => ({
  lookupKey: async (l) => { log.push(`${name} key ${l}`); return undefined; },
  getParams: async (k) => { log.push(`${name} params ${k}`); return new Uint8Array(); },
  artefact: async (kind, l) => { log.push(`${name} ${kind} ${l}`); return new Uint8Array(); },
});
const at = (circuit: string, address = 'ab'.repeat(32)) => `contract:${address}/${circuit}?vk=${'0f'.repeat(32)}`;

describe('WHERE A PAYMENT OUT\'S PROVING MATERIAL IS FETCHED FROM', () => {
  it('the account\'s recordPayment from the account\'s folder, the vault\'s own and the network\'s where they always were', async () => {
    /* RED WHEN: the account's circuits are not routed apart - recordPayment is then asked of the vault's folder, which has none. */
    const log: string[] = [];
    const routed = networkCircuitsBeside(accountCircuitsBeside(source('vault', log), source('account', log)), source('network', log));
    await routed.lookupKey(at('recordPayment', 'c0'.repeat(32)));
    await routed.lookupKey(at('payout'));
    await routed.artefact('ir', at('recordPayment', 'c0'.repeat(32)));
    await routed.lookupKey('midnight/zswap/spend');
    await routed.getParams(14);
    expect(log.map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual([
      'account key', 'vault key', 'account ir', 'network key', 'vault params',
    ]);
  });

  it('NO VAULT CIRCUIT SHARES A NAME WITH AN ACCOUNT CIRCUIT A VAULT CALLS, which is what routing by name rests on', () => {
    /* RED WHEN: a vault circuit is named like one of these - its proof would then be made with the account's key. */
    expect(ACCOUNT_CIRCUITS_A_VAULT_CALLS).toEqual(['recordPayment']);
    expect((VAULT_CIRCUITS as readonly string[]).filter((c) => ACCOUNT_CIRCUITS_A_VAULT_CALLS.includes(c))).toEqual([]);
  });
});
