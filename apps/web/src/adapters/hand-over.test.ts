// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSigningKeypair, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { signVaultKeys } from '../../../../src/core/vault-keys.js';

/*
 * HANDING A COMPANY OVER THROUGH THE ADAPTERS. The keyring and the service are
 * stood in for; the checks the shared code makes before anything is sent run
 * as they are, against a roster made to agree or not.
 */
const K = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const SIGNER = newSigningKeypair();
const kr = vi.hoisted(() => ({
  calls: [] as { path: string; method: string; body: unknown }[],
  answers: {} as Record<string, unknown>,
  keys: { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' } as Record<string, string> | null,
  roster: null as unknown, walletKey: null as unknown, signed: null as unknown, opened: 0, user: 'u1', seat: false,
  /** When set, what the shared check answers, in place of its own answer. */
  check: undefined as undefined | null | { code: string; why: string },
  /* The seat this device's own key material makes, and every seat the account was asked to sign for. */
  ownSeat: '5a'.repeat(32), walletAsked: [] as string[], released: 0,
  /* Whether the account is held by the committee that lists this person's key, as the wallet read it. */
  accountHeld: true,
  /* This person's signed directory entries kept with their keys until the directory takes them, by company. */
  owed: {} as Record<string, { person: string; signed: unknown }>,
}));
vi.mock('./vault-builder.js', () => ({ theVaultBuilder: async () => ({ ownSeat: async () => kr.ownSeat }) }));
vi.mock('vaults-web-shared/committee-change-on-device.js', async (real) => {
  const shared = await real<typeof import('vaults-web-shared/committee-change-on-device.js')>();
  return { ...shared, committeeChangeRefusal: (...a: Parameters<typeof shared.committeeChangeRefusal>) => (kr.check === undefined ? shared.committeeChangeRefusal(...a) : kr.check) };
});
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: kr.user }),
  forgetLocally: () => {},
  resumeSession: async () => null,
  canOpenCompanies: () => kr.opened > 0,
  openKeysWithWallet: async () => { kr.opened += 1; },
  reopenSavedKeys: async () => {},
  keysFor: () => kr.keys,
  pendingSeatsFor: () => (kr.seat ? [{ accountId: 'c1' }] : []),
  finishPendingSeat: async () => { if (!kr.seat) return false; kr.seat = false; kr.keys = { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' }; return true; },
  viewingKeyFor: () => 'vk',
  openAccount: () => kr.roster,
  companyKeysForVaults: async () => {
    kr.released += 1;
    return { companyKey: '11'.repeat(32), committeeKey: kr.walletKey, company: 'co_' + 'a1'.repeat(32), account: 'a0'.repeat(32) };
  },
  /* The account signs this person's records key for the seat the page names; what it signs is the identity library's to test. */
  recordsKeyFromTheWallet: async (_origin: string, ask: { seat: string; signingKey?: string }) => (kr.walletAsked.push(ask.seat), {
    committeeKey: kr.walletKey, statement: { recordsKey: '33'.repeat(32), seat: ask.seat, signature: '44'.repeat(64) },
    seats: { committee: kr.accountHeld ? [kr.walletKey] : [{ tag: 'schnorr', value: '77'.repeat(32) }], threshold: 1, seats: [ask.seat] },
    /* The directory entry the same press signs, when the page names its filing key. */
    entry: ask.signingKey === undefined ? null : { signingKey: ask.signingKey, wrappingKey: '33'.repeat(32), seat: ask.seat, signature: '55'.repeat(64) },
  }),
  signCommitteeChangeFromTheWallet: async () => kr.signed,
  oweDirectoryEntry: async (id: string, owed: { person: string; signed: unknown }) => { kr.owed[id] = owed; },
  directoryEntryOwed: (id: string) => ({ read: () => kr.owed[id] ?? null, settle: async () => { delete kr.owed[id]; } }),
  api: async (path: string, opts?: RequestInit) => {
    kr.calls.push({ path, method: String(opts?.method ?? 'GET'), body: opts?.body === undefined ? undefined : JSON.parse(String(opts.body)) });
    if (!(path in kr.answers)) throw new Error(`no answer for ${path}`);
    /* A list is answered one item a request, the last kept for every request after. */
    const a = kr.answers[path];
    if (a instanceof Error) throw a;
    return Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
  },
}));
vi.mock('vaults-web-shared/vault-page-doors.js', () => ({
  giveVaultKeys: async (_api: unknown, id: string, keys: unknown) => { kr.calls.push({ path: `give ${id}`, method: 'PUT', body: keys }); },
  /* The directory takes an entry only while the account is held by a committee listing this person's key; until then it stays owed. */
  fileTheOwedDirectoryEntry: async (_api: unknown, id: string, owed: { read(): { person: string; signed: unknown } | null; settle(): Promise<void> }) => {
    const o = owed.read();
    if (o === null) return 'nothing-owed';
    if (!kr.accountHeld) return { notYet: 'not on the committee' };
    kr.calls.push({ path: `entry ${id} ${o.person}`, method: 'PUT', body: o.signed });
    await owed.settle();
    return 'filed';
  },
}));

/** A roster naming signer `s1` with committee key `mine`, and the company's committee as the keys given. */
const rosterWith = (mine: { tag: string; value: string }) => ({ id: 'c1', signers: [{
  id: 's1', userId: 'u1', name: 'Priya', status: 'active', signingPublicKey: SIGNER.publicKey, leafCommitment: '5a'.repeat(32),
  vaultKeys: signVaultKeys('c1', 's1', { committeeKey: mine, recordsKey: K(0x40).value as Hex }, SIGNER.secret),
}] });

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return { acts: await import('./hand-over.js'), state: await import('./handover-state.js') };
}

const AUTHORITY = (over: Record<string, unknown> = {}) => ({
  company: { address: 'a', threshold: 1, signerCount: 1 }, committee: { committee: [K(1)], threshold: 1 }, why: null, everySignerNeeded: null,
  contracts: [{ contract: 'account', address: 'a', read: 'read', seats: [], threshold: 1, changes: '0', shape: 'one-key', heldByTheCompany: false }],
  handover: { possible: true, why: null }, change: { possible: false, why: 'x' }, ...over,
});

beforeEach(() => { kr.owed = {}; kr.accountHeld = true; kr.ownSeat = '5a'.repeat(32); kr.walletAsked = []; kr.released = 0; kr.check = undefined; kr.seat = false; kr.user = 'u1'; kr.calls = []; kr.answers = {}; kr.keys = { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' }; kr.opened = 0; kr.walletKey = K(1); kr.roster = null; kr.signed = null; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('where a company stands, from the shape of the service\'s answer', () => {
  /* RED WHEN: a state is read wrongly from the answer: a company held taken for one to hand over, a change owed missed, or one signer who can approve alone let through as ready. */
  it('reads each state from the answer alone', async () => {
    const { state } = await load();
    const f = state.handoverFrom;
    const account = (o: Record<string, unknown>) => [{ ...AUTHORITY().contracts[0], ...o }];
    expect(f(AUTHORITY({ company: null }) as never, null)).toEqual({ of: 'not-on-chain' });
    expect(f(AUTHORITY({ committee: null, handover: { possible: false } }) as never, null)).toEqual({ of: 'vault-keys-missing', signers: 1 });
    expect(f(AUTHORITY() as never, null)).toEqual({ of: 'ready', everySignerNeeded: false, signers: 1 });
    expect(f(AUTHORITY({ everySignerNeeded: 'x' }) as never, null)).toEqual({ of: 'ready', everySignerNeeded: true, signers: 1 });
    expect(f(AUTHORITY({ contracts: account({ heldByTheCompany: true }), handover: { possible: false } }) as never, null)).toEqual({ of: 'held' });
    expect(f(AUTHORITY({ change: { possible: true }, contracts: account({ changes: '1', shape: 'committee' }), handover: { possible: false } }) as never, { contracts: [{ signedSeats: [0], required: 2 }] }))
      .toEqual({ of: 'change-owed', signed: [{ have: 1, required: 2 }] });
    expect(f(AUTHORITY({ company: { threshold: 1, signerCount: 3 }, handover: { possible: false } }) as never, null)).toEqual({ of: 'too-few-approvals', signers: 3, needed: 1 });
    /* Two of three must approve: enough, so a handover not offered is waiting, not too few approvals. */
    expect(f(AUTHORITY({ company: { threshold: 2, signerCount: 3 }, handover: { possible: false } }) as never, null)).toEqual({ of: 'waiting' });
    expect(f(AUTHORITY({ handover: { possible: false } }) as never, null)).toEqual({ of: 'waiting' });
    expect(f(AUTHORITY({ contracts: account({ read: 'unreadable' }), handover: { possible: false } }) as never, null)).toEqual({ of: 'unreadable' });
    expect(f(AUTHORITY({ contracts: account({ changes: '2', shape: 'committee' }), handover: { possible: false } }) as never, null)).toEqual({ of: 'held-by-other-keys' });
  });

  /*
   * RED WHEN: a failure to read is not told apart by its kind: a service not
   * reached, a service that refused, a person signed out, somebody else signed
   * in, or an answer of a shape this does not know, each said as another (all
   * as unreachable, say); or the two failures that are the person's are said as
   * the company's state.
   */
  it('says each failure to read as what it is', async () => {
    const { state } = await load();
    const { AnotherPersonError, AuthError } = await import('vaults-web-shared/keyring.js');
    const cases: [unknown, string][] = [
      [new TypeError('fetch failed'), 'unreachable'],
      [new Error('the chain could not be read'), 'unreadable'],
      [new AuthError('not signed in'), 'not-signed-in'],
      [new AnotherPersonError('someone else'), 'another-person'],
      [{ company: { threshold: 1, signerCount: 1 }, change: null }, 'unreadable'],
      [null, 'unreadable'],
    ];
    for (const [answer, of] of cases) {
      kr.answers['/api/accounts/c1/authority'] = answer;
      expect(await state.readHandover('u1', 'c1'), String(answer)).toEqual({ of });
    }
    delete kr.answers['/api/accounts/c1/authority'];
    kr.user = 'somebody else';
    expect(await state.readHandover('u1', 'c1')).toEqual({ of: 'not-signed-in' });
  });
});

describe('handing it over', () => {
  /* RED WHEN: the service is asked to install any committee but the one this device checked (one read again after the check, say), or is asked at all when the roster does not name the committee. */
  it('sends exactly the committee checked against the roster, and nothing when the roster does not agree', async () => {
    const { acts } = await load();
    const authority = AUTHORITY();
    /* Read again after the check, the service would name another committee: what is sent must be the one checked. */
    kr.answers['/api/accounts/c1/authority'] = [authority, AUTHORITY({ committee: { committee: [K(9)], threshold: 1 } })];
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/authority/handover'] = { txRef: 't' };
    kr.roster = rosterWith(K(1));
    expect(await acts.handOver('u1', 'c1')).toEqual({ of: 'done' });
    const sent = kr.calls.filter((c) => c.method === 'POST');
    expect(sent).toEqual([{ path: '/api/accounts/c1/authority/handover', method: 'POST', body: { committee: authority.committee } }]);
    kr.calls = [];
    kr.answers['/api/accounts/c1/authority'] = authority;
    kr.roster = rosterWith(K(2));
    kr.walletKey = K(2);
    expect(await acts.handOver('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-disagrees' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  /* RED WHEN: the company is handed over although the key this person's account gives is not the one their own roster entry carries. */
  it('sends nothing when this person\'s account gives a key their roster entry does not carry', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1/authority'] = AUTHORITY();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = rosterWith(K(1));
    kr.walletKey = K(2);
    expect(await acts.handOver('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-disagrees' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  /* RED WHEN: this person's keys for the company are missing and something is sent anyway, or the keys saved for them are not opened with their account first. */
  it('opens the saved keys first, and refuses when they hold none for the company', async () => {
    const { acts } = await load();
    kr.keys = null;
    expect(await acts.handOver('u1', 'c1')).toEqual({ of: 'refused', why: 'no-keys-here' });
    expect(kr.opened).toBe(1);
    expect(kr.calls).toEqual([]);
  });

  /* RED WHEN: a seat this device left unfinished is not finished before this person's keys for the company are read, so the handover is refused on the one device holding them. */
  it('finishes a seat this device left unfinished, and then acts', async () => {
    const { acts } = await load();
    kr.keys = null; kr.seat = true;
    kr.answers['/api/accounts/c1'] = {};
    /* The roster names this person's seat, which their account signs their records key for. */
    kr.roster = rosterWith(K(1));
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.seat).toBe(false);
  });

  /* RED WHEN: vault keys are given with no seat for the account to sign the records key for, or anything is sent then. */
  it('gives no vault keys when the roster names no seat for this person', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = { ...rosterWith(K(1)), signers: rosterWith(K(1)).signers.map((x) => ({ ...x, leafCommitment: null })) };
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'refused', why: 'no-seat' });
    /* RED WHEN: the account is asked to release the company's keys before the seat is checked on this device. */
    expect(kr.released).toBe(0);
    expect(kr.calls.filter((c) => c.path.startsWith('give'))).toEqual([]);
    expect(kr.walletAsked).toEqual([]);
  });

  /* RED WHEN: the account is asked to sign for a seat the records name that this device's own key does not make. */
  it('gives no vault keys, and asks the account to sign nothing, when the records name a seat this device\'s key does not make', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = rosterWith(K(1));
    kr.ownSeat = '6b'.repeat(32);
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'refused', why: 'not-your-seat' });
    /* RED WHEN: the account is asked to release the company's keys before the seat is checked on this device. */
    expect(kr.released).toBe(0);
    expect(kr.walletAsked).toEqual([]);
    expect(kr.calls.filter((c) => c.path.startsWith('give'))).toEqual([]);
    kr.ownSeat = '5a'.repeat(32);
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.walletAsked).toEqual(['5a'.repeat(32)]);
  });

  /* RED WHEN: the vault keys given are not this person's own, from their own entry, with the key their account gives. */
  it('gives this person\'s own vault keys', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = rosterWith(K(1));
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.at(-2)).toEqual({ path: 'give c1', method: 'PUT', body: {
      committeeKey: K(1), companyKey: '11'.repeat(32), signingSecret: 'aa'.repeat(32), signerId: 's1', viewingKey: 'vk',
      /* RED WHEN: the keys are given without the account's statement for the seat this person holds. */
      recordsKey: { recordsKey: '33'.repeat(32), seat: '5a'.repeat(32), signature: '44'.repeat(64) },
    } });
    /* RED WHEN: this person's directory entry, signed by their account in the same press for their own filing key, is not filed after the keys are given. */
    expect(kr.calls.at(-1)).toEqual({ path: 'entry c1 u1', method: 'PUT', body: {
      committeeKey: K(1),
      entry: { signingKey: signingPublicKeyOf('aa'.repeat(32)), wrappingKey: '33'.repeat(32), seat: '5a'.repeat(32), signature: '55'.repeat(64) },
    } });
  });

  it('gives the keys before the account is its committee\'s, keeps the directory entry, and files it on the next way in with no press', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = rosterWith(K(1));
    kr.accountHeld = false;
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.filter((c) => c.path.startsWith('give'))).toHaveLength(1);
    /* RED WHEN: an entry the directory will not take yet stops the press, or the press does not hand it to be kept (what the shared step keeps is its own test's, `seat-directory-route.test.ts`). */
    expect(kr.calls.filter((c) => c.path.startsWith('entry'))).toEqual([]);
    expect(kr.owed.c1?.person).toBe('u1');
    kr.accountHeld = true;
    const asked = kr.walletAsked.length;
    const { keysOnTheWayIn } = await import('./keyring-person.js');
    await keysOnTheWayIn('c1', async () => ({}) as never);
    /* RED WHEN: once the account is held, the entry waits for another press rather than being filed on the way in. */
    expect(kr.calls.filter((c) => c.path.startsWith('entry'))).toHaveLength(1);
    expect(kr.walletAsked.length).toBe(asked);
    /* RED WHEN: a filed entry is kept owed, and filed again on every way in. */
    expect(kr.owed.c1).toBeUndefined();
    await keysOnTheWayIn('c1', async () => ({}) as never);
    expect(kr.calls.filter((c) => c.path.startsWith('entry'))).toHaveLength(1);
  });
});

describe('signing a change', () => {
  const OWED = {
    company: 'a0'.repeat(32), label: 'co_' + 'a1'.repeat(32), to: { committee: [K(1)], threshold: 1 }, why: null, notChangeable: [],
    contracts: [{ contract: 'account', address: 'a0'.repeat(32), counter: '3', now: { committee: [K(1), K(9)], threshold: 2 }, signedSeats: [] as number[], required: 2 }],
  };

  /* RED WHEN: a change this person has already signed is asked of their account again, or said as a failure rather than nothing to sign. */
  it('says there is nothing to sign, and asks the account nothing, when this person has signed', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/committee-change'] = { ...OWED, contracts: [{ ...OWED.contracts[0], signedSeats: [0] }] };
    kr.roster = rosterWith(K(1));
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'nothing-to-sign' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  /* RED WHEN: "nothing to sign" is told from a refusal by the check's sentence rather than its code. */
  it('reads the check\'s code, never its sentence', async () => {
    const { acts } = await load();
    const { COMMITTEE_CHANGE_REFUSAL, nothingForMe } = await import('vaults-web-shared/committee-change-on-device.js');
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/committee-change'] = OWED;
    kr.roster = rosterWith(K(1));
    const signed = { ...OWED, contracts: [{ ...OWED.contracts[0]!, signedSeats: [0] }] } as never;
    kr.check = { code: COMMITTEE_CHANGE_REFUSAL.nothingToSign, why: 'words no sentence of the check has ever been' };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'nothing-to-sign' });
    kr.check = { code: COMMITTEE_CHANGE_REFUSAL.refused, why: nothingForMe(signed, K(1)) };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-disagrees' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  /* RED WHEN: a change is signed and sent when the roster does not name the committee to install, or the signatures the account gave are not what is sent. */
  it('sends the account\'s signatures, and nothing when the roster does not agree', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/committee-change'] = OWED;
    kr.answers['/api/accounts/c1/committee-change/signatures'] = { results: [] };
    kr.roster = rosterWith(K(1));
    kr.signed = { signer: K(1), signatures: [{ address: 'a', counter: '3', seat: 0, signature: K(7) }] };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([{ path: '/api/accounts/c1/committee-change/signatures', method: 'POST',
      body: { to: OWED.to, signatures: [{ address: 'a', counter: '3', seat: 0, signature: K(7) }] } }]);
    for (const [roster, wallet] of [[K(5), K(1)], [K(1), K(2)]] as const) {
      kr.calls = [];
      kr.roster = rosterWith(roster);
      kr.walletKey = wallet;
      expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-disagrees' });
      expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
    }
  });
});
