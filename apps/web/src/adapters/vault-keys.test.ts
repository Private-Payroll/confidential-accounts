// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * GIVING A SIGNER'S VAULT KEYS THROUGH THE ADAPTER. The keyring, the wallet and the service are stood in for, and
 * every call that reaches them is written down in order; the order in which this signer's entry is filed and the
 * keys offered, what the offer carries, what the wallet is asked, and what a refused fold or an entry the directory
 * will not take yet does to the press are the adapter's own. Filing an entry, offering and folding are the shared
 * code's own tests' (`seat-directory-route.test.ts`, `vault-keys-are-offered-and-folded.test.ts`).
 */
const K = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const SEAT = '5a'.repeat(32);
const kr = vi.hoisted(() => ({
  /* Every filing, offer and fold, in the order the adapter made them. */
  log: [] as string[],
  offered: [] as unknown[],
  walletAsked: [] as unknown[],
  released: 0,
  /* This person's signed directory entries kept with their keys until the directory takes them, by company. */
  owed: {} as Record<string, { person: string; signed: unknown }>,
  /* What the directory answers to this person's owed entry: takes it, or says why not yet. */
  filing: 'filed' as 'filed' | { notYet: string } | { waitingForItsInvitation: string },
  /* Why folding the open offers into the roster fails, as the service's refusal of an unbelieved seat would. */
  foldFails: null as string | null,
  /* Another member has filed a claim on this person's seat first: the service keeps an offer only for a person whose own entry is filed. */
  squatted: false,
  user: 'u1' as string | null,
  keys: { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' } as Record<string, string> | null,
}));
vi.mock('./vault-builder.js', () => ({ theVaultBuilder: async () => ({ ownSeat: async () => '5a'.repeat(32) }) }));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => (kr.user === null ? null : { id: kr.user }),
  canOpenCompanies: () => true,
  reopenSavedKeys: async () => {},
  pendingSeatsFor: () => [],
  keysFor: () => kr.keys,
  viewingKeyFor: () => 'vk',
  companyKeysForVaults: async () => {
    kr.released += 1;
    return { companyKey: '11'.repeat(32), committeeKey: K(1), company: `co_${'a1'.repeat(32)}`, account: 'a0'.repeat(32) };
  },
  /* The wallet signs this person's records key for the seat the page names; what it signs is the identity library's to test. */
  recordsKeyFromTheWallet: async (_origin: string, ask: { seat: string; signingKey?: string }) => {
    kr.walletAsked.push(ask);
    return {
      committeeKey: K(1), statement: { recordsKey: '33'.repeat(32), seat: ask.seat, signature: '44'.repeat(64) },
      seats: { committee: [K(1)], threshold: 1, seats: [ask.seat] },
      entry: ask.signingKey === undefined ? null : { signingKey: ask.signingKey, wrappingKey: '33'.repeat(32), seat: ask.seat, signature: '55'.repeat(64) },
    };
  },
  holdersFromTheWallet: async () => ({ holders: { committee: [K(1)], threshold: 1, seats: [SEAT], approvals: 1, founding: SEAT }, indexer: null }),
  oweDirectoryEntry: async (id: string, owed: { person: string; signed: unknown }) => { kr.owed[id] = owed; },
  directoryEntryOwed: (id: string) => ({ read: () => kr.owed[id] ?? null, settle: async () => { delete kr.owed[id]; } }),
  api: async (path: string) => {
    if (path === '/api/accounts/c1/proposals') return [];
    throw new Error(`no answer for ${path}`);
  },
}));
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
  /* The company's keys as its directory gives them (`companyKeysFor`), stood in for by the one key of a company never changed. */
  companyKeysFor: async () => ({ epoch: 0, newest: 0, key: 'vk', keyAt: () => 'vk', sealing: () => ({ key: 'vk', epoch: 0 }) }),
}));
vi.mock('vaults-web-shared/roster-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/roster-here.js')>()),
  offerVaultKeysHere: async (_api: unknown, id: string, keys: unknown) => {
    if (kr.squatted && !kr.log.includes(`entry filed ${id} ${kr.user}`)) {
      throw Object.assign(new Error('the company\'s directory holds no entry of yours for this seat'), { status: 403 });
    }
    kr.log.push(`offer ${id}`);
    kr.offered.push(keys);
  },
  foldOffersHere: async (d: { accountId: string }) => {
    kr.log.push(`fold ${d.accountId}`);
    if (kr.foldFails !== null) throw new Error(kr.foldFails);
    return { folded: [], refused: [{ seat: SEAT, why: 'the offer is refused: it is not an offer of vault keys' }] };
  },
}));
vi.mock('vaults-web-shared/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-page-doors.js')>()),
  /* The directory's answer to an owed entry: it takes it, or it is not yet (what the shared step keeps is `seat-directory-route.test.ts`'s). */
  fileTheOwedDirectoryEntry: async (_api: unknown, id: string, owed: { read(): { person: string; signed: unknown } | null; settle(): Promise<void> }) => {
    const o = owed.read();
    if (o === null) return 'nothing-owed';
    if (kr.filing !== 'filed') return kr.filing;
    kr.log.push(`entry filed ${id} ${o.person}`);
    await owed.settle();
    return 'filed';
  },
}));

const VIEWING = { epoch: 0, newest: 0, key: 'vk', keyAt: () => 'vk', sealing: () => ({ key: 'vk', epoch: 0 }) } as never;
const ROSTER = async () => ({ signers: [{ id: 's1', status: 'active', leafCommitment: SEAT }] }) as never;
const SIGNER = { signerId: 's1', signingSecret: 'aa'.repeat(32) as never, blinding: 'cc'.repeat(32) as never };
const ENTRY = (signingKey: string) => ({ signingKey, wrappingKey: '33'.repeat(32), seat: SEAT, signature: '55'.repeat(64) });

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./vault-keys.js');
}
beforeEach(() => {
  kr.log = []; kr.offered = []; kr.walletAsked = []; kr.released = 0; kr.owed = {}; kr.filing = 'filed'; kr.foldFails = null;
  kr.squatted = false; kr.user = 'u1'; kr.keys = { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' };
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('giving a signer\'s vault keys', () => {
  /* RED WHEN: the keys are offered before this signer's own directory entry is filed: a claim another member filed on the seat first then refuses the offer at every press. */
  it('files this signer\'s own entry before offering the keys, so a claim filed first on their seat does not keep them out', async () => {
    const m = await load();
    kr.squatted = true;
    expect((await m.giveTheVaultKeys('c1', SIGNER, VIEWING, ROSTER)).of).toBe('done');
    expect(kr.log).toEqual(['entry filed c1 u1', 'offer c1', 'fold c1']);
  });

  /* RED WHEN: the entry of the seat that invited this signer is not handed to the wallet's records-key ask, or one under a key the wallet cannot check is. */
  it('hands the wallet the entry of the seat that invited this signer, and only under a key it checks', async () => {
    const m = await load();
    const statement = { account: 'a0'.repeat(32), signingKey: '2b'.repeat(32), wrappingKey: '2c'.repeat(32), seat: '2d'.repeat(32), signature: '2e'.repeat(64) };
    /* The inviter's own seat's opening travels with its entry, and nothing of any other seat. */
    const opening = { publicKey: '2f'.repeat(32), scope: '30'.repeat(32), blinding: '31'.repeat(32), walletKey: K(3), salt: '32'.repeat(32) };
    const invitedBy = { committeeKey: K(3), statement, opening } as never;
    expect((await m.giveTheVaultKeys('c1', { ...SIGNER, invitedBy }, VIEWING, ROSTER)).of).toBe('done');
    expect((kr.walletAsked[0] as { invitedBy?: unknown }).invitedBy).toEqual({ committeeKey: K(3), statement, opening });
    kr.walletAsked = [];
    const unchecked = { committeeKey: { tag: 'ecdsa', value: K(3).value }, statement, opening } as never;
    expect((await m.giveTheVaultKeys('c1', { ...SIGNER, invitedBy: unchecked }, VIEWING, ROSTER)).of).toBe('done');
    expect((kr.walletAsked[0] as { invitedBy?: unknown }).invitedBy).toBeUndefined();
    /* RED WHEN: the wallet is asked to sign for the seat the roster names rather than the one this device's own key makes, or for a filing key that is not this signer's. */
    expect((kr.walletAsked[0] as { seat: string }).seat).toBe(SEAT);
  });

  /* RED WHEN: the offer is made without this signer's own keys, the wallet's statement and the entry it signed, or sealed under anything but the company's keys its directory gives. */
  it('offers this signer\'s own keys, with the wallet\'s statement and entry, sealed under the company\'s keys', async () => {
    const m = await load();
    const done = await m.giveTheVaultKeys('c1', SIGNER, VIEWING, ROSTER);
    expect(done.of).toBe('done');
    expect(kr.offered).toHaveLength(1);
    const offer = kr.offered[0] as { viewingKey: unknown } & Record<string, unknown>;
    const filingKey = (kr.walletAsked[0] as { signingKey: string }).signingKey;
    expect({ ...offer, viewingKey: undefined }).toEqual({
      signerId: 's1', signingSecret: 'aa'.repeat(32), companyKey: '11'.repeat(32), committeeKey: K(1),
      recordsKey: { recordsKey: '33'.repeat(32), seat: SEAT, signature: '44'.repeat(64) }, entry: ENTRY(filingKey), viewingKey: undefined,
    });
    /* RED WHEN: the offer is sealed under another key than the company's, which the directory gives. */
    expect(offer.viewingKey).toBe(VIEWING);
  });

  /* RED WHEN: a refused fold stops the press or is thrown to the page, or a fold that refuses one offer is said as a failure: the offer stays open and the press is still done. */
  it('is done when the fold of the open offers is refused, and when it refuses one offer', async () => {
    const m = await load();
    expect((await m.giveTheVaultKeys('c1', SIGNER, VIEWING, ROSTER)).of).toBe('done');
    kr.foldFails = 'your seat is not on the company\'s committee';
    kr.log = [];
    expect((await m.giveTheVaultKeys('c1', SIGNER, VIEWING, ROSTER)).of).toBe('done');
    expect(kr.log).toEqual(['entry filed c1 u1', 'offer c1', 'fold c1']);
  });

  /* RED WHEN: the keys are offered, or folded, while this signer's entry is not in the directory: it says which kind of wait it is, and the entry stays kept for the next way in. */
  it('refuses, by kind, and offers nothing while the directory has not taken this signer\'s entry', async () => {
    const m = await load();
    kr.filing = { notYet: 'not on the committee' };
    expect(await m.giveTheVaultKeys('c1', SIGNER, VIEWING, ROSTER)).toEqual({ of: 'refused', why: 'entry-not-filed' });
    expect(kr.log).toEqual([]);
    kr.filing = { waitingForItsInvitation: 'waiting for the invitation' };
    expect(await m.giveTheVaultKeys('c1', SIGNER, VIEWING, ROSTER)).toEqual({ of: 'refused', why: 'entry-waits-for-its-invitation' });
    expect(kr.log).toEqual([]);
    expect(kr.offered).toEqual([]);
  });

  /* RED WHEN: an entry the directory will not take yet is not kept owed, or is not filed on the next way into the company with no press, or is filed again on every way in after. */
  it('keeps the entry owed, files it on the next way in with no press, and then gives the keys', async () => {
    const m = await load();
    kr.filing = { notYet: 'not on the committee' };
    expect((await m.giveTheVaultKeys('c1', SIGNER, VIEWING, ROSTER)).of).toBe('refused');
    expect(kr.owed.c1?.person).toBe('u1');
    expect(kr.owed.c1?.signed).toEqual({ committeeKey: K(1), entry: ENTRY((kr.walletAsked[0] as { signingKey: string }).signingKey) });
    kr.filing = 'filed';
    const asked = kr.walletAsked.length;
    const { keysOnTheWayIn } = await import('./keyring-person.js');
    await keysOnTheWayIn('c1', async () => ({}) as never);
    expect(kr.log).toEqual(['entry filed c1 u1']);
    expect(kr.walletAsked.length).toBe(asked);
    expect(kr.owed.c1).toBeUndefined();
    await keysOnTheWayIn('c1', async () => ({}) as never);
    expect(kr.log).toEqual(['entry filed c1 u1']);
    expect((await m.giveTheVaultKeys('c1', SIGNER, VIEWING, ROSTER)).of).toBe('done');
    expect(kr.offered).toHaveLength(1);
  });
});

describe('an entry already on file, whatever the keys on this device hold', () => {
  const owed = (entry: ReturnType<typeof ENTRY>) => {
    const kept = { person: 'u1', company: 'co', signed: { committeeKey: K(1), entry }, settled: false };
    return {
      kept,
      door: { read: () => (kept.settled ? null : kept as never), settle: async () => { kept.settled = true; } },
    };
  };
  const filingsWith = (entry: ReturnType<typeof ENTRY>) => async () => ({ filings: [{ company: 'c1', version: 1, change: { kind: 'claim', entry: { statement: entry } } }] });

  /* RED WHEN: a signer whose entry is already in the company's directory is told it is not filed, on every press, because the keys on this device hold no opening of their seat; or an entry that is not on file is taken for one that is. */
  it('says an entry already filed is there before it asks for the seat\'s opening, and an entry not filed is not yet', async () => {
    const { fileTheOwedDirectoryEntry } = await vi.importActual<typeof import('vaults-web-shared/vault-page-doors.js')>('vaults-web-shared/vault-page-doors.js');
    const entry = ENTRY('ab'.repeat(32));
    const keys = async () => null;
    const founding = async () => null;
    const filed = owed(entry);
    expect(await fileTheOwedDirectoryEntry(filingsWith(entry) as never, 'c1', filed.door, keys, founding)).toBe('already-there');
    expect(filed.kept.settled).toBe(true);
    const other = owed(entry);
    const answer = await fileTheOwedDirectoryEntry(filingsWith(ENTRY('cd'.repeat(32))) as never, 'c1', other.door, keys, founding);
    expect(answer).toMatchObject({ notYet: expect.stringMatching(/holds no opening of its seat/u) });
    expect(other.kept.settled).toBe(false);
  });
});
