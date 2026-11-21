import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SealedAccount } from '../../../src/core/types.js';
import type { viewingKeyFor } from './keyring.js';

/*
 * A PAGE LOAD READS A COMPANY WITHOUT ASKING THE WALLET. A company that has changed its key has a filing in its directory
 * that this seat holds a copy of the new key in, and the copy opens only with the key the wallet releases. A read made for
 * a page opening must not open the wallet's window for it; an action (a press) still may.
 */
const t = vi.hoisted(() => ({
  asked: 0,
  held: null as string | null,
  keyDoors: [] as Array<{ doors: { askTheWallet: () => Promise<string | null>; revoked?: () => Promise<number | null> }; options: unknown }>,
  notOpened: [] as number[],
}));
vi.mock('./company-key-here.js', async (real) => ({
  ...(await real<typeof import('./company-key-here.js')>()),
  companyKeyHere: async (doors: { askTheWallet: () => Promise<string | null>; revoked?: () => Promise<number | null> }, _released: unknown, options: unknown = {}) => {
    t.keyDoors.push({ doors, options });
    return { epoch: 0, key: 'aa'.repeat(32), newest: 1, notOpened: t.notOpened };
  },
}));

/* The read grants as a seat's device judges them: the key epoch a taking-away was filed at, and what it was asked with. */
const g = vi.hoisted(() => ({ revokedAt: null as number | null, asked: [] as Array<{ accountId: string; versions: () => Promise<unknown>; released: () => Promise<unknown> }> }));
vi.mock('./purpose-wraps.js', async (real) => ({
  ...(await real<typeof import('./purpose-wraps.js')>()),
  revokedAtHere: async (doors: { accountId: string; versions: () => Promise<unknown>; released: () => Promise<unknown> }) => { g.asked.push(doors); return g.revokedAt; },
}));

const { companyJudges } = await import('./company-judges.js');
const { CompanyKeyNotOpened } = await import('./company-key-here.js');
const { RosterNotBelieved } = await import('./roster-here.js');
const { companyViewFor } = await import('./company-view.js');
const { serviceSource } = await import('./records-source.js');

const CO = 'acc_changed';
const sealed = { id: CO, companyLabel: `co_${'a7'.repeat(32)}`, contractAddress: 'b7'.repeat(32), wrappedKeys: [] } as unknown as SealedAccount;
const rotation = { version: 1, change: { kind: 'rotate', epoch: 1, keyCheck: 'cc'.repeat(32), wraps: [], previous: 'dd', waiting: [] } };

const judges = (open: (keys: (rec: SealedAccount) => Promise<unknown>) => Promise<unknown> = async () => null, filings: readonly unknown[] = [rotation], more: object = {}) => companyJudges({
  /* A fresh view for each read, so each read asks the service in memory as it stands. */
  view: () => companyViewFor(serviceSource(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/manifest/newest')) return { versions: JSON.parse(String(init?.body)).records.map(() => 0) };
    if (path.endsWith('/records/read')) return { records: JSON.parse(String(init?.body)).records.map(() => ({ versions: [] })) };
    return { filings };
  }, CO), {
    holders: async () => ({ seats: [], approvals: 1, adoptedVaults: [], threshold: 1, committee: [], vaultThresholds: [], policyBar: null }) as never,
    onChain: async () => ({}) as never, builder: { anchorHeads: async () => ({}) as never },
  }, async () => ({}) as never),
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
  ...more,
} as never);

beforeEach(() => { t.asked = 0; t.held = null; t.keyDoors.length = 0; t.notOpened = []; g.revokedAt = null; g.asked.length = 0; });

describe('THE COMPANY\'S KEY AS EVERY DEVICE FINDS IT KNOWS A READ GRANT TAKEN AWAY', () => {
  it('ITS DOORS READ THE GRANTS THE SERVICE SERVES FOR THIS COMPANY, WITH THE KEY THE WALLET RELEASED, AND ANSWER THE EPOCH A TAKING-AWAY WAS FILED AT', async () => {
    t.held = 'ff'.repeat(32);
    g.revokedAt = 0;
    await judges().companyKeysFor(CO, sealed, { signingPublicKey: 'ab'.repeat(32) as never }, 'not-opened');
    const { doors } = t.keyDoors[0]!;
    /* RED WHEN: the company key every device seals with is found with no read of the grants, so it seals on after a taking-away. */
    expect(await doors.revoked?.()).toBe(0);
    expect(g.asked[0]!.accountId).toBe(CO);
    expect(await g.asked[0]!.released()).toBe(t.held);
    expect(await g.asked[0]!.versions()).toEqual([]);
  });

  it('A PRESS ON A COMPANY WHOSE KEY NEVER CHANGED ASKS THE WALLET FOR THE KEY THE GRANTS OPEN WITH; A QUIET READ DOES NOT, AND PAUSES WITHOUT IT', async () => {
    await judges(undefined, []).companyKeysFor(CO, sealed, { signingPublicKey: 'ab'.repeat(32) as never });
    await t.keyDoors[0]!.doors.revoked?.();
    /* RED WHEN: sealing is asked on a company whose key never changed and the grants are judged with no released key, read as nothing taken away. */
    await g.asked[0]!.released();
    expect(t.asked).toBe(1);
    await judges(undefined, []).companyKeysFor(CO, sealed, { signingPublicKey: 'ab'.repeat(32) as never }, 'not-opened');
    await t.keyDoors[1]!.doors.revoked?.();
    expect(await g.asked[1]!.released()).toBeNull();
    expect(t.asked).toBe(1);
  });
});

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

describe('A JUDGE ASKED ABOUT ANOTHER ACCOUNT THAN THE ONE ITS VIEW READS IS REFUSED', () => {
  it('answers who holds the account its view reads, and refuses any other', async () => {
    let asked: ((company: never, account: never) => Promise<unknown>) | null = null;
    const ofTheView = { seats: [], approvals: 1, adoptedVaults: [], threshold: 1, committee: [], vaultThresholds: [], policyBar: null, account: sealed.contractAddress };
    const j = companyJudges({
      view: () => companyViewFor(serviceSource(async (path: string, init?: RequestInit) => {
        if (path.endsWith('/manifest/newest')) return { versions: JSON.parse(String(init?.body)).records.map(() => 0) };
        return { filings: [] };
      }, CO), { holders: async () => ofTheView as never, onChain: async () => ({}) as never, builder: { anchorHeads: async () => ({}) as never } }, async () => ({}) as never),
      holders: async () => ({}) as never, indexer: async () => null, builder: async () => ({}) as never,
      keysFor: () => null, servedKeyFor: () => 'ee'.repeat(32) as never, released: () => null, askReleased: async () => null,
      treeKept: () => ({}) as never, openAccount: async () => null,
      seatsAdmittedFor: async (_rec: unknown, holders: typeof asked) => { asked = holders; return new Set(); },
      noAccount: () => { throw new Error('no account'); },
    } as never);
    await j.seatsAdmittedOn(sealed);
    await expect(asked!(sealed.companyLabel as never, sealed.contractAddress as never)).resolves.toMatchObject({ account: sealed.contractAddress });
    /* RED WHEN: a judge asked about one account is answered with who holds another, the one its view reads. */
    await expect(asked!(sealed.companyLabel as never, 'c8'.repeat(32) as never)).rejects.toThrow(/a judge asked about account/u);
  });
});

describe('A SEAT AN INVITATION TOOK IS ASKED OF THE CHAIN ONCE FOR A READ OF THE COMPANY, AND AGAIN AFTER ANY WRITE', () => {
  it('KEEPS THE ANSWER AMONG THE VIEW\'S READS OF THE CHAIN, SO A WRITE OF ANY KIND FORGETS IT', async () => {
    let asked = 0;
    const view = companyViewFor(serviceSource(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET' && !(init as { read?: boolean } | undefined)?.read) return { ok: true };
      if (path.endsWith('/manifest/newest')) return { versions: JSON.parse(String(init?.body)).records.map(() => 0) };
      if (path.endsWith('/records/read')) return { records: JSON.parse(String(init?.body)).records.map(() => ({ versions: [] })) };
      return { filings: [] };
    }, CO), {
      holders: async () => ({ seats: [], approvals: 1, adoptedVaults: [], threshold: 1, committee: [], vaultThresholds: [], policyBar: null }) as never,
      onChain: async () => ({}) as never, builder: { anchorHeads: async () => ({}) as never },
    }, async () => ({}) as never);
    const j = judges(undefined, undefined, {
      view: () => view,
      indexer: async () => ({ indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' }),
      builder: async () => ({ invitedSeats: async (i: { proposals: readonly string[] }) => { asked += 1; return Object.fromEntries(i.proposals.map((p) => [p, null])); } }),
    });
    const read = j.invitedSeatsFor(sealed.companyLabel as never, sealed.contractAddress as never, CO);
    await read(['p1']);
    await read(['p1']);
    expect(asked).toBe(1);
    await view.write([{ to: 'vault-record', vault: 'v1', record: 'pool', version: 1, body: {} }] as never);
    await read(['p1']);
    /* RED WHEN: a proposal read as having taken no seat is still served after a write, so a seat just taken reads as not taken. */
    expect(asked).toBe(2);
  });
});

describe('THE COMPANY KEY SERVED TO A SEAT IS ASKED OF A SEALED ACCOUNT AS IT IS TYPED', () => {
  it('takes the wrapped keys as wrapped keys, and nothing else', () => {
    const served: Parameters<typeof companyJudges>[0]['servedKeyFor'] = () => 'ee'.repeat(32) as never;
    /* RED WHEN: the key is asked of anything with an id, its wrapped keys unchecked, so a wrong shape reaches the unwrapping untyped. */
    // @ts-expect-error a number is not a key wrapped to a seat
    expect(served({ id: 'c1', wrappedKeys: [1] })).toBe('ee'.repeat(32));
    /* RED WHEN: the page's own served key takes anything with an id, its wrapped keys unchecked. */
    // @ts-expect-error a number is not a key wrapped to a seat
    const onThePage: Parameters<typeof viewingKeyFor>[0] = { id: 'c1', wrappedKeys: [1] };
    expect(onThePage.id).toBe('c1');
  });
});
