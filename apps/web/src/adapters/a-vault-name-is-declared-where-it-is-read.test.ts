import { describe, expect, it, vi } from 'vitest';
import { VAULT_INFO_KIND } from '../../../../src/midnight/vault-info-record.js';
import { readVaultName } from './company-vaults-read.js';
import type { PageView } from './filing-judge.js';
import { PROVEN } from './view-asks.js';

/* Nobody is signed in, so a name read answers at its first await: what is checked here is what it asked of the view before that. */
vi.mock('./keyring-person.js', () => ({ keyringFor: async () => false, keysOnTheWayIn: async () => null }));

const viewWithDeclared = () => {
  const declared: unknown[] = [];
  const view = {
    company: 'c1',
    declare: (asks: unknown) => {
      declared.push(asks);
    }
  } as unknown as PageView;
  return { view, declared };
};
const infoOf = (vault: string) => ({ store: PROVEN.company, kind: VAULT_INFO_KIND, id: vault.toLowerCase() });

describe('A VAULT NAME IS DECLARED ON THE VIEW WHERE IT IS READ', () => {
  /* RED WHEN: a name's record is named to the view after the read's first await, or not at all, so a name drawn on its own asks a proof of its own. */
  it("names the vault's info record to the view before the read awaits anything", async () => {
    const { view, declared } = viewWithDeclared();
    const read = readVaultName('u1', view, 'AB'.repeat(32));
    expect(declared).toEqual([{ records: [infoOf('ab'.repeat(32))] }]);
    expect(await read).toBeNull();
  });

  /* RED WHEN: the names drawn in one turn are not all declared before the first of them asks its proof, so each is proven apart. */
  it('declares every name drawn in one turn before any of them is proven', async () => {
    const { view, declared } = viewWithDeclared();
    const reads = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)].map((vault) => readVaultName('u1', view, vault));
    expect(declared).toEqual(['aa', 'bb', 'cc'].map((b) => ({ records: [infoOf(b.repeat(32))] })));
    await Promise.all(reads);
  });
});
