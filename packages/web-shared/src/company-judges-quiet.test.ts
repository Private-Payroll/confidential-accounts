import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SealedAccount } from '../../../src/core/types.js';

/*
 * A PAGE LOAD READS A COMPANY WITHOUT ASKING THE WALLET. A company that has changed its key has a filing in its directory
 * that this seat holds a copy of the new key in, and the copy opens only with the key the wallet releases. A read made for
 * a page opening must not open the wallet's window for it; an action (a press) still may.
 */
const t = vi.hoisted(() => ({
  asked: 0,
  held: null as string | null,
  keyDoors: [] as Array<{ doors: { askTheWallet: () => Promise<string | null> }; options: unknown }>,
  notOpened: [] as number[],
}));
vi.mock('./company-key-here.js', async (real) => ({
  ...(await real<typeof import('./company-key-here.js')>()),
  companyKeyHere: async (doors: { askTheWallet: () => Promise<string | null> }, _released: unknown, options: unknown = {}) => {
    t.keyDoors.push({ doors, options });
    return { epoch: 0, key: 'aa'.repeat(32), newest: 1, notOpened: t.notOpened };
  },
}));

const { companyJudges } = await import('./company-judges.js');
const { CompanyKeyNotOpened } = await import('./company-key-here.js');
const { RosterNotBelieved } = await import('./roster-here.js');

const CO = 'acc_changed';
const sealed = { id: CO, companyLabel: `co_${'a7'.repeat(32)}`, contractAddress: 'b7'.repeat(32), wrappedKeys: [] } as unknown as SealedAccount;
const rotation = { version: 1, change: { kind: 'rotate', epoch: 1, keyCheck: 'cc'.repeat(32), wraps: [], previous: 'dd', waiting: [] } };

const judges = (open: (keys: (rec: SealedAccount) => Promise<unknown>) => Promise<unknown> = async () => null) => companyJudges({
  api: async () => ({ filings: [rotation] }),
  holders: async () => ({}) as never,
  indexer: async () => null,
  builder: async () => ({}) as never,
  keysFor: () => ({ signerId: 's1', signingPublicKey: 'ab'.repeat(32) }),
  servedKeyFor: () => 'ee'.repeat(32) as never,
  released: () => t.held as never,
  askReleased: async () => { t.asked += 1; return null; },
  treeKept: () => ({}) as never,
  openAccount: (_rec: unknown, _h: unknown, _a: unknown, _l: unknown, keys?: (rec: SealedAccount) => Promise<unknown>) => open(keys!) as never,
  seatsAdmittedFor: async () => new Set(),
  noAccount: () => { throw new Error('no account'); },
} as never);

beforeEach(() => { t.asked = 0; t.held = null; t.keyDoors.length = 0; t.notOpened = []; });

describe('A COMPANY WHOSE KEY WAS CHANGED, READ FOR A PAGE', () => {
  it('A QUIET READ NEVER ASKS THE WALLET: NOT FOR THE FILINGS\' KEYS, NOT FOR THE COMPANY\'S KEY', async () => {
    await judges().companyKeysFor(CO, sealed, { signingPublicKey: 'ab'.repeat(32) as never }, 'not-opened');
    const { doors, options } = t.keyDoors[0]!;
    /* RED WHEN: a page load opens the wallet's window to read a company whose key was changed. */
    expect(await doors.askTheWallet()).toBeNull();
    expect(t.asked).toBe(0);
    expect(options).toEqual({ unreleased: 'not-opened' });
  });

  it('A KEY THE WALLET RELEASED ON THIS VISIT IS STILL USED BY A QUIET READ, WITHOUT ASKING', async () => {
    t.held = 'ff'.repeat(32);
    await judges().companyKeysFor(CO, sealed, { signingPublicKey: 'ab'.repeat(32) as never }, 'not-opened');
    expect(t.keyDoors[0]!.doors).toHaveProperty('released');
    expect((t.keyDoors[0]!.doors as unknown as { released: () => unknown }).released()).toBe(t.held);
    expect(t.asked).toBe(0);
  });

  it('A PRESS KEEPS ASKING THE WALLET: THE DEFAULT READ ASKS ONCE FOR THE FILINGS\' KEYS AND ONCE FOR THE COMPANY\'S KEY', async () => {
    await judges().companyKeysFor(CO, sealed, { signingPublicKey: 'ab'.repeat(32) as never });
    const { doors, options } = t.keyDoors[0]!;
    await doors.askTheWallet();
    await doors.askTheWallet();
    /* RED WHEN: an action no longer asks the wallet for the company's key, or asks it twice. */
    expect(t.asked).toBe(1);
    expect(options).toEqual({});
  });
});

describe('A COMPANY THAT CANNOT BE OPENED BECAUSE A COPY OF ITS KEY IS NOT OPENED YET', () => {
  it('IS TOLD AS `CompanyKeyNotOpened`, NOT AS WHATEVER THE MISSING KEY BROKE', async () => {
    t.notOpened = [1];
    const quiet = judges(async (keys) => { await keys(sealed); throw new CompanyKeyNotOpened(); });
    /* RED WHEN: a company whose key is not opened is shown as unreadable, with nothing to say what to do. */
    await expect(quiet.openedQuietlyHere(sealed)).rejects.toBeInstanceOf(CompanyKeyNotOpened);
    expect(t.asked).toBe(0);
  });

  it('IS TOLD ALSO WHEN `CompanyKeyNotOpened` IS THE CAUSE OF WHAT THE OPENING THREW', async () => {
    t.notOpened = [1];
    const quiet = judges(async (keys) => { await keys(sealed); throw new Error('the directory could not be read', { cause: new CompanyKeyNotOpened() }); });
    /* RED WHEN: a company whose key is not opened is shown as unreadable when the opening wrapped the typed refusal. */
    await expect(quiet.openedQuietlyHere(sealed)).rejects.toBeInstanceOf(CompanyKeyNotOpened);
  });

  it('IS TOLD AS ITSELF WHEN A ROSTER THE DEVICE DOES NOT BELIEVE BROKE THE READ, WHATEVER COPY IS LEFT UNOPENED', async () => {
    t.notOpened = [1];
    const alarm = new RosterNotBelieved('the roster is not believed');
    const quiet = judges(async (keys) => { await keys(sealed); throw alarm; });
    /* RED WHEN: the alarm that a company's roster is not believed is shown as "not opened yet" because some epoch was left unopened. */
    await expect(quiet.openedQuietlyHere(sealed)).rejects.toBe(alarm);
  });

  it('IS TOLD AS WHAT BROKE WHEN NO COPY IS LEFT UNOPENED', async () => {
    const quiet = judges(async (keys) => { await keys(sealed); throw new Error('the roster is not believed'); });
    await expect(quiet.openedQuietlyHere(sealed)).rejects.toThrow('the roster is not believed');
  });
});
