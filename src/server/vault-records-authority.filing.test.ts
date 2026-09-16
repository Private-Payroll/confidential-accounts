import { describe, expect, it } from 'vitest';
import { NotAVaultsState, signersOfTheVaultsCompany, vaultAccountFromTheIndexer } from './vault-records-authority.js';

/*
 * A filing is bound to the key its filer gave. Only that one question is asked
 * here; the rest of who may file is `vault-records-authority.test.ts`'s.
 */
const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'cd'.repeat(32);
const MINE = '11'.repeat(32);
const THEIRS = '22'.repeat(32);
const companies = () => [{ id: 'acc_1', contractAddress: ACCOUNT, memberUserIds: ['ada', 'bo'] }];
const accountOf = async () => ACCOUNT;

describe('A FILING IS FROM THE KEY ITS FILER GAVE', () => {
  const given: Record<string, string> = { ada: MINE, bo: THEIRS };
  const may = signersOfTheVaultsCompany({
    accountOf, companies, filingKeyOf: (company, person) => (company === 'acc_1' ? given[person] ?? null : null),
  });

  it('files under the key the person gave, in any spelling', async () => {
    expect(await may('ada', VAULT, 'pool', 'file', MINE)).toBe(true);
    expect(await may('ada', VAULT, 'pool', 'file', MINE.toUpperCase() as never)).toBe(true);
  });

  it('REFUSES a filing signed with another member\'s key, or with a key nobody gave', async () => {
    expect(await may('ada', VAULT, 'pool', 'file', THEIRS)).toBe(false);
    expect(await may('ada', VAULT, 'nonce-secret', 'file', '33'.repeat(32))).toBe(false);
  });

  it('REFUSES a member who has given no filing key at all, and still lets them read', async () => {
    const none = signersOfTheVaultsCompany({ accountOf, companies, filingKeyOf: () => null });
    expect(await none('ada', VAULT, 'pool', 'file', MINE)).toBe(false);
    expect(await none('ada', VAULT, 'pool', 'read')).toBe(true);
  });

  it('a non-member is refused whatever key they sign with', async () => {
    expect(await may('carol', VAULT, 'pool', 'file', MINE)).toBe(false);
  });
});

describe('A SERVER THAT REACHES A CHAIN KEEPS VAULT RECORDS IN A DATABASE', () => {
  it('refuses to hold them in memory when it writes to a chain, and says why', async () => {
    const { whyVaultRecordsCannotBeKept } = await import('./vault-records-authority.js');
    expect(whyVaultRecordsCannotBeKept({ reachesAChain: true, database: false })).toMatch(/lost at the next restart/);
    expect(whyVaultRecordsCannotBeKept({ reachesAChain: true, database: true })).toBeNull();
    expect(whyVaultRecordsCannotBeKept({ reachesAChain: false, database: false })).toBeNull();
  });

  it('and the server asks that question before it listens, and stops on the answer', async () => {
    const { readFileSync } = await import('node:fs');
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const asked = index.indexOf('whyVaultRecordsCannotBeKept({ reachesAChain: startup.started && handed === null, database: recordsSql !== null })');
    const stopped = index.indexOf('process.exit(1)', asked);
    const listened = index.indexOf('app.listen(', asked);
    const serving = index.indexOf("if (process.env.SERVE !== '0') {");
    const mounted = index.indexOf('mountVaultRecords(app, {');
    expect(asked).toBeGreaterThan(serving);
    expect(serving).toBeGreaterThan(-1);
    expect(stopped).toBeGreaterThan(asked);
    expect(listened).toBeGreaterThan(stopped);
    expect(mounted).toBeGreaterThan(-1);
    /* And both vault mounts come before the general one-megabyte parser. */
    const general = index.indexOf("app.use(express.json({ limit: '1mb' }));");
    expect(mounted).toBeLessThan(general);
    expect(index.indexOf('app.use(companyVaultRoutes({')).toBeLessThan(general);
    expect(index.indexOf('app.use(companyVaultRoutes({')).toBeGreaterThan(-1);
  });
});

describe('A CONTRACT THAT IS NOT A VAULT IS REFUSED, NOT LEFT UNDECIDED', () => {
  it('a state the vault ledger cannot read grants nobody anything, and says so as a refusal', async () => {
    const notAVault = vaultAccountFromTheIndexer({ queryContractState: async () => ({ data: {} }) },
      () => { throw new Error('not this layout'); });
    await expect(notAVault(VAULT)).rejects.toBeInstanceOf(NotAVaultsState);
    const may = signersOfTheVaultsCompany({ accountOf: notAVault, companies });
    expect(await may('ada', VAULT, 'pool', 'read')).toBe(false);
  });

  it('and a chain that fails for any other reason is still undecided', async () => {
    const down = signersOfTheVaultsCompany({ accountOf: async () => { throw new Error('indexer down'); }, companies });
    await expect(down('ada', VAULT, 'pool', 'read')).rejects.toThrow(/indexer down/);
  });
});
