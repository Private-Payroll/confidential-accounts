/**
 * **WHO MAY READ AND FILE A VAULT'S RECORDS, AS THE CHAIN AND THE ROSTERS SAY.**
 * The chain reader is run against the vault's real compiled contract: a state
 * made by its own constructor, read back through its own ledger.
 */
import { describe, it, expect } from 'vitest';
import { createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import {
  signersOfTheVaultsCompany, vaultAccountFromTheIndexer, openedOnFirstUse, type CompanyRoster, type VaultAccountReader,
} from './vault-records-authority.js';
import { MemorySealedPoolStore, sealPool } from '../midnight/vault-pool.js';
import { newWrappingKeypair } from '../core/crypto.js';
import { fromHex } from '../core/crypto.js';

const VAULT = 'ab'.repeat(32);
const COMPANY = 'c0'.repeat(32);
const FILER = 'f1'.repeat(32);
const companies: CompanyRoster[] = [
  { id: 'acc_one', contractAddress: COMPANY, memberUserIds: ['ada', 'bo'] },
  { id: 'acc_two', contractAddress: 'd0'.repeat(32), memberUserIds: ['eve'] },
  { id: 'acc_old', contractAddress: null, memberUserIds: ['eve'] },
];
const pinnedTo = (account: string | null): VaultAccountReader => async (v) => (v === VAULT ? account : null);
const may = (accountOf: VaultAccountReader, list = companies) => signersOfTheVaultsCompany({ accountOf, companies: () => list });

describe('who may touch a vault\'s records', () => {
  it('A SIGNER OF THE COMPANY THE VAULT IS PINNED TO MAY READ AND FILE, and nobody else may', async () => {
    const m = may(pinnedTo(COMPANY));
    expect(await m('ada', VAULT, 'pool', 'read'), 'RED WHEN: a signer of the vault\'s company is refused').toBe(true);
    expect(await m('bo', VAULT, 'deposit-journal', 'file', FILER)).toBe(true);
    expect(await m('eve', VAULT, 'pool', 'read'), 'RED WHEN: a signer of another company reads this vault\'s records').toBe(false);
    expect(await m('eve', VAULT, 'pool', 'file', FILER), 'RED WHEN: a signer of another company files for this vault').toBe(false);
    expect(await m('', VAULT, 'pool', 'read')).toBe(false);
  });

  it('A FILING WITH NO CHECKED SIGNER IS REFUSED, whoever sends it', async () => {
    const m = may(pinnedTo(COMPANY));
    expect(await m('ada', VAULT, 'pool', 'file'), 'RED WHEN: an unsigned filing is let through').toBe(false);
    expect(await m('ada', VAULT, 'pool', 'file', 'zz' as never)).toBe(false);
  });

  it('REFUSES a vault the chain does not know, an address no company has, and an address two companies claim', async () => {
    expect(await may(pinnedTo(COMPANY))('ada', 'cd'.repeat(32), 'pool', 'read'), 'RED WHEN: a vault the chain does not know is answered for').toBe(false);
    expect(await may(pinnedTo('e0'.repeat(32)))('ada', VAULT, 'pool', 'read'), 'RED WHEN: a vault pinned to nobody here is let in').toBe(false);
    const twice = [...companies, { id: 'acc_dup', contractAddress: COMPANY.toUpperCase(), memberUserIds: ['mal'] }];
    expect(await may(pinnedTo(COMPANY), twice)('ada', VAULT, 'pool', 'read'), 'RED WHEN: a store that disagrees with itself lets anybody in').toBe(false);
    expect(await may(pinnedTo(COMPANY))('ada', VAULT.toUpperCase(), 'pool', 'read')).toBe(false);
  });

  it('matches the pinned address in any spelling the chain gives, and THROWS for an answer that is not one', async () => {
    expect(await may(pinnedTo(`0x${COMPANY.toUpperCase()}`))('ada', VAULT, 'pool', 'read')).toBe(true);
    await expect(may(pinnedTo('nonsense'))('ada', VAULT, 'pool', 'read'),
      'RED WHEN: a chain answer that is not an address is read as "nobody may"').rejects.toThrow(/not an address/);
    const down: VaultAccountReader = async () => { throw new Error('the indexer is not answering'); };
    await expect(may(down)('ada', VAULT, 'pool', 'read'), 'RED WHEN: a chain that cannot be read is answered as a refusal').rejects.toThrow(/not answering/);
  });
});

describe('the vault\'s pinned account, read from the chain', () => {
  it('IS THE ACCOUNT THE VAULT\'S OWN CONSTRUCTOR PINNED, read through its own ledger', async () => {
    const { Contract } = await import('../../contracts/managed-vault/contract/index.js');
    const vault = new Contract({ noteToSpend: () => { throw new Error('unused'); } } as never);
    const init = await (vault as any).initialState(createConstructorContext({}, '0'.repeat(64)), { bytes: fromHex(COMPANY) });
    const address = sampleContractAddress();
    const read = vaultAccountFromTheIndexer({
      queryContractState: async (a) => (a === address ? { data: init.currentContractState.data } : null),
    });
    expect(await read(address as never), 'RED WHEN: the account is read from anywhere but the vault\'s own ledger').toBe(COMPANY);
    expect(await read('cd'.repeat(32)), 'RED WHEN: a contract the indexer does not have is answered as some account').toBeNull();
  });

  it('THROWS for a state that is not a vault\'s, and for an account that is not thirty-two bytes', async () => {
    const broken = vaultAccountFromTheIndexer({ queryContractState: async () => ({ data: {} }) },
      () => { throw new Error('not a vault'); });
    await expect(broken(VAULT), 'RED WHEN: an unreadable state is answered as no vault').rejects.toThrow(/could not be read as a vault/);
    const short = vaultAccountFromTheIndexer({ queryContractState: async () => ({ data: {} }) },
      () => ({ account: { bytes: new Uint8Array(31) } }));
    await expect(short(VAULT)).rejects.toThrow(/not thirty-two bytes/);
  });
});

describe('the database\'s records, opened on first use', () => {
  it('OPENS ONCE, NOT AT START, and a failed open refuses that request and is tried again on the next', async () => {
    let opens = 0;
    let failNext = true;
    const kept = new MemorySealedPoolStore();
    const lazy = openedOnFirstUse(async () => {
      opens += 1;
      if (failNext) { failNext = false; throw new Error('the database is not answering'); }
      return { of: () => kept };
    });
    expect(opens, 'RED WHEN: the store is opened when the server starts, so a database that is down stops the server').toBe(0);
    await expect(lazy.of('pool').get(VAULT), 'RED WHEN: a store that could not be opened answers as empty').rejects.toThrow(/not answering/);
    const k = newWrappingKeypair();
    await lazy.of('pool').put(VAULT, sealPool(VAULT, { notes: [] }, [{ id: 'a', wrappingPublicKey: k.publicKey }], 1));
    expect(await lazy.of('pool').at!(VAULT, 1)).not.toBeNull();
    expect((await lazy.of('pool').versions(VAULT)).length).toBe(1);
    expect(opens, 'RED WHEN: a failed open is kept, or a good one is repeated').toBe(2);
  });
});
