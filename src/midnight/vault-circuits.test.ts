import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { Contract as VaultContract, ledger as vaultLedger, pureCircuits } from '../../contracts/managed-vault/contract/index.js';
import { VAULT_CIRCUITS } from './vault-contract.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { circuitsNotThisBuilds, startingLedgerFrom, vaultBornHeldRefusal, type VaultStartingLedger } from './vault-circuits.js';
import type { Committee } from './vault-committee.js';
import { keyFileAround, operationHolding } from '../testing/an-operation-holding.js';

/* A vault's state as its compiled constructor makes it, read through its own compiled ledger. */
const noWitnesses = { noteToSpend: () => { throw new Error('none'); }, nonceSecret: () => { throw new Error('none'); } };
const ACCOUNT = 'c0'.repeat(32);
const constructed = async () => {
  const { currentContractState } = await new VaultContract(noWitnesses as never).initialState(
    createConstructorContext({} as never, '0'.repeat(64)), { bytes: Buffer.from(ACCOUNT, 'hex') } as never);
  return vaultLedger((currentContractState as unknown as { data: never }).data);
};

const vk = (n: number) => L.signatureVerifyingKey(L.signingKeyFromBip340(new Uint8Array(32).fill(n)));
const holders: Committee = { committee: [vk(1), vk(2)].sort((a, b) => (a.value < b.value ? -1 : 1)), threshold: 2 };
const KEY = keyFileAround('a vault circuit');
/* A deploy held by the company's committee from its first transaction, every circuit this build's, no money. */
const deployed = {
  maintenanceAuthority: { committee: holders.committee, threshold: holders.threshold, counter: 0n },
  operations: () => [...VAULT_CIRCUITS],
  operation: () => operationHolding(KEY),
};
const fresh: VaultStartingLedger = {
  account: ACCOUNT, notes: 0n, unshieldedTokens: 0n, payments: 0n, nonceCommitment: '00'.repeat(32),
  splitJournal: 0n, secretCopies: 0n, reserved: 0n, retired: false, started: false,
};
const expecting = (start: VaultStartingLedger) => ({
  account: ACCOUNT, holders, verifierKeys: new Map(VAULT_CIRCUITS.map((c) => [c, KEY] as const)), startingLedgerOf: () => start,
});

describe('A VAULT\'S OWN RETIRED MARK, READ OFF ITS LEDGER', () => {
  it('reads the mark the vault\'s constructor leaves unset, and one set, as the field holds it', async () => {
    const ledger = await constructed();
    expect(startingLedgerFrom(ledger, pureCircuits.copiesWrittenKey()).retired).toBe(false);
    /* RED WHEN: the mark is not read off the vault's own `retired` field, so a retired vault reads as one taking deposits. */
    const marked = new Proxy(ledger, { get: (t, k) => (k === 'retired' ? true : Reflect.get(t, k)) });
    expect(startingLedgerFrom(marked, pureCircuits.copiesWrittenKey()).retired).toBe(true);
  });

  it('REFUSES A DEPLOY THAT STARTS MARKED RETIRED, AND READS ONE THAT DOES NOT AS A NEW VAULT', () => {
    expect(vaultBornHeldRefusal(deployed, expecting(fresh), 'a vault this company holds')).toBeNull();
    /* RED WHEN: a deploy that starts marked retired is read as a new vault: it would never take the money it is made for. */
    expect(vaultBornHeldRefusal(deployed, expecting({ ...fresh, retired: true }), 'a vault this company holds'))
      .toMatch(/starts marked retired/);
  });
});

describe('A VAULT CIRCUIT THAT HIDES A SECOND KEY IN ITS OTHER SLOT', () => {
  const HIDDEN = keyFileAround('a key nobody compiled', 'older');
  const hiding = (circuit: string) => ({
    ...deployed,
    operation: (name: string) => (name === circuit ? operationHolding(HIDDEN, KEY) : operationHolding(KEY)),
  });
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('IS REFUSED OVER BYTES, AS THE SERVICE READS A DEPLOY, AND OVER DIGESTS, AS A DEVICE READS THE CHAIN, AND NAMED', () => {
    /* RED WHEN: a vault's circuits are judged by the one key the ledger's own reading shows, so the other slot pays out unchecked. */
    expect(vaultBornHeldRefusal(hiding('payout'), expecting(fresh), 'a vault this company holds'))
      .toMatch(/its 'payout' circuit is not the one this service's build compiled/);
    const digests = Object.fromEntries(VAULT_CIRCUITS.map((c) => [c, hex(sha256(KEY))]));
    expect(circuitsNotThisBuilds(deployed, digests, sha256, 'no', 'the vault\'s')).toBeNull();
    expect(circuitsNotThisBuilds(hiding('deposit'), digests, sha256, 'no', 'the vault\'s')).toMatchObject({ circuit: 'deposit' });
    /* A circuit whose keys cannot be read is refused and named, never passed. */
    const unreadable = { ...deployed, operation: (name: string) => (name === 'payout' ? { verifierKey: KEY } : operationHolding(KEY)) };
    expect(circuitsNotThisBuilds(unreadable, digests, sha256, 'no', 'the vault\'s')).toMatchObject({ circuit: 'payout' });
  });
});
