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
  /** When set, why folding the open offers into the roster fails, as the service's refusal of an unbelieved seat would. */
  foldFails: null as string | null,
  /* Another member has filed a claim on this person's seat first: the service keeps an offer only for a person whose own entry is filed. */
  squatted: false,
  /** The inviter the last records-key ask carried. */
  invitedBy: undefined as unknown,
  /** The account's committee and threshold as this person's wallet reads them off the chain. */
  chainCommittee: null as { tag: string; value: string }[] | null,
  chainThreshold: 1,
}));
vi.mock('./vault-builder.js', () => ({ theVaultBuilder: async () => ({ ownSeat: async () => kr.ownSeat }) }));
vi.mock('vaults-web-shared/committee-change-on-device.js', async (real) => {
  const shared = await real<typeof import('vaults-web-shared/committee-change-on-device.js')>();
  return { ...shared, committeeChangeRefusal: (...a: Parameters<typeof shared.committeeChangeRefusal>) => (kr.check === undefined ? shared.committeeChangeRefusal(...a) : kr.check) };
});
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
  /* The company's keys as its directory gives them (`companyKeysFor`), stood in for by the one key of a company never changed. */
  companyKeysFor: async () => ({ epoch: 0, newest: 0, key: 'vk', keyAt: () => 'vk', sealing: () => ({ key: 'vk', epoch: 0 }) }),
}));
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
  recordsKeyFromTheWallet: async (_origin: string, ask: { seat: string; signingKey?: string; invitedBy?: unknown }) => (kr.walletAsked.push(ask.seat), kr.invitedBy = ask.invitedBy, {
    committeeKey: kr.walletKey, statement: { recordsKey: '33'.repeat(32), seat: ask.seat, signature: '44'.repeat(64) },
    seats: { committee: kr.accountHeld ? [kr.walletKey] : [{ tag: 'schnorr', value: '77'.repeat(32) }], threshold: 1, seats: [ask.seat] },
    /* The directory entry the same press signs, when the page names its filing key. */
    entry: ask.signingKey === undefined ? null : { signingKey: ask.signingKey, wrappingKey: '33'.repeat(32), seat: ask.seat, signature: '55'.repeat(64) },
  }),
  signCommitteeChangeFromTheWallet: async () => kr.signed,
  holdersFromTheWallet: async () => ({ holders: { committee: kr.chainCommittee ?? [K(1)], threshold: kr.chainThreshold } }),
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
/* Offering and folding vault keys are their own tests' (`vault-keys-are-offered-and-folded.test.ts`); here each is written down. */
vi.mock('vaults-web-shared/roster-here.js', () => ({
  offerVaultKeysHere: async (_api: unknown, id: string, keys: unknown) => {
    if (kr.squatted && !kr.calls.some((c) => c.path === `entry ${id} ${kr.user}`)) {
      throw Object.assign(new Error('the company\'s directory holds no entry of yours for this seat'), { status: 403 });
    }
    kr.calls.push({ path: `offer ${id}`, method: 'PUT', body: keys });
  },
  foldOffersHere: async (d: { accountId: string }) => {
    kr.calls.push({ path: `fold ${d.accountId}`, method: 'FOLD', body: undefined });
    if (kr.foldFails !== null) throw new Error(kr.foldFails);
    return { folded: [], refused: [] };
  },
}));
vi.mock('vaults-web-shared/vault-page-doors.js', () => ({
  /* Who the page believes filed a record: the fold that would ask it is written down above, so it is never asked here. */
  directoryJudge: () => async () => () => null,
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
}], notBelieved: [] as string[] });

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return { acts: await import('./hand-over.js'), state: await import('./handover-state.js') };
}

const AUTHORITY = (over: Record<string, unknown> = {}) => ({
  company: { address: 'a', label: null }, committee: { committee: [K(1)], threshold: 1 }, why: null,
  contracts: [{ contract: 'account', address: 'a', read: 'read', seats: [], threshold: 1, changes: '0', shape: 'one-key', heldByTheCompany: false }],
  change: { possible: false, why: 'x' }, ...over,
});

beforeEach(() => { kr.squatted = false; kr.chainCommittee = null; kr.chainThreshold = 1; kr.foldFails = null; kr.owed = {}; kr.accountHeld = true; kr.ownSeat = '5a'.repeat(32); kr.walletAsked = []; kr.released = 0; kr.check = undefined; kr.seat = false; kr.user = 'u1'; kr.calls = []; kr.answers = {}; kr.keys = { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' }; kr.opened = 0; kr.walletKey = K(1); kr.roster = null; kr.signed = null; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('where a company stands, from the shape of the service\'s answer', () => {
  /* RED WHEN: a state is read wrongly from the answer: a company held taken for one not held, a change owed missed, or any state decided by the signers. */
  it('reads each state from the answer alone, and reads nothing of the signers', async () => {
    const { state } = await load();
    const f = state.handoverFrom;
    const account = (o: Record<string, unknown>) => [{ ...AUTHORITY().contracts[0], ...o }];
    expect(f(AUTHORITY({ company: null }) as never, null)).toEqual({ of: 'not-on-chain' });
    expect(f(AUTHORITY({ contracts: account({ heldByTheCompany: true }) }) as never, null)).toEqual({ of: 'held' });
    expect(f(AUTHORITY({ change: { possible: true }, contracts: account({ changes: '1', shape: 'committee' }) }) as never, { contracts: [{ signedIndexes: [0], required: 2 }] }))
      .toEqual({ of: 'change-owed', signed: [{ have: 1, required: 2 }] });
    expect(f(AUTHORITY({ contracts: account({ read: 'unreadable' }) }) as never, null)).toEqual({ of: 'unreadable' });
    expect(f(AUTHORITY({ contracts: account({ changes: '2', shape: 'committee' }) }) as never, null)).toEqual({ of: 'held-by-other-keys' });
    /* An account no committee holds - the service's temporary key, say - is held by other keys, whatever the signers are. */
    expect(f(AUTHORITY({ committee: null }) as never, null)).toEqual({ of: 'held-by-other-keys' });
    /* RED WHEN: the signers' count, threshold or a warning made from them changes the state. */
    const signersAside = { company: { address: 'a', threshold: 1, signerCount: 3 }, everySignerNeeded: 'x' };
    expect(f(AUTHORITY({ ...signersAside, contracts: account({ heldByTheCompany: true }) }) as never, null)).toEqual({ of: 'held' });
    expect(f(AUTHORITY(signersAside) as never, null)).toEqual({ of: 'held-by-other-keys' });
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
  /* RED WHEN: a press hands the company's account over again - no target for one exists, and any member could name their own key. */
  it('offers no press that hands the company\'s account over', async () => {
    const { acts } = await load();
    expect(Object.keys(acts).sort()).toEqual(['giveMyVaultKeys', 'signChange']);
  });

  /* RED WHEN: this person's keys for the company are missing and their vault keys are given anyway, or the keys saved for them are not opened with their account first. */
  it('opens the saved keys first before vault keys are given, and refuses when they hold none for the company', async () => {
    const { acts } = await load();
    kr.keys = null;
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'refused', why: 'no-keys-here' });
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
    expect(kr.calls.filter((c) => c.path.startsWith('offer'))).toEqual([]);
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
    expect(kr.calls.filter((c) => c.path.startsWith('offer'))).toEqual([]);
    kr.ownSeat = '5a'.repeat(32);
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.walletAsked).toEqual(['5a'.repeat(32)]);
  });

  /* RED WHEN: the keys are offered before this person's own directory entry is filed: a claim another member filed on the seat first then refuses the offer at every press. */
  it('files this person\'s own entry before offering the keys, so a claim filed first on their seat does not keep them out', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = rosterWith(K(1));
    kr.squatted = true;
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.filter((c) => c.path.startsWith('entry') || c.path.startsWith('offer')).map((c) => c.path)).toEqual(['entry c1 u1', 'offer c1']);
  });

  /* RED WHEN: the vault keys given are not this person's own, from their own entry, with the key their account gives. */
  it('gives this person\'s own vault keys', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = rosterWith(K(1));
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    const entry = { signingKey: signingPublicKeyOf('aa'.repeat(32)), wrappingKey: '33'.repeat(32), seat: '5a'.repeat(32), signature: '55'.repeat(64) };
    expect(kr.calls.slice(-3)).toEqual([
      /* RED WHEN: this person's directory entry, signed by their account in the same press for their own filing key, is not filed before the keys are offered, so a claim another member filed on this seat first keeps the offer out. */
      { path: 'entry c1 u1', method: 'PUT', body: { committeeKey: K(1), entry } },
      /* RED WHEN: the keys are offered without the account's statement for the seat this person holds, or without the entry it signed in the same press, which the service holds the offer's signature to. */
      { path: 'offer c1', method: 'PUT', body: {
        signerId: 's1', signingSecret: 'aa'.repeat(32), companyKey: '11'.repeat(32), committeeKey: K(1),
        recordsKey: { recordsKey: '33'.repeat(32), seat: '5a'.repeat(32), signature: '44'.repeat(64) }, entry,
        /* RED WHEN: the offer is not sealed under the company's keys its directory gives, so the service would hold this person's wallet key. */
        viewingKey: expect.objectContaining({ key: 'vk', epoch: 0 }),
      } },
      /* RED WHEN: the open offers are not folded from this device once its entry is filed, so its own keys wait for another seat. */
      { path: 'fold c1', method: 'FOLD', body: undefined },
    ]);
    /* A fold the service refuses - this seat not believed yet - leaves the offer open, and the press is still done. */
    kr.foldFails = 'your seat is not on the company\'s committee';
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
  });

  /* RED WHEN: the entry of the seat that invited this signer is not handed to their account's records-key ask, or one under a key the wallet cannot check is. */
  it('hands the account the entry of the seat that invited this signer, and only under a key it checks', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = rosterWith(K(1));
    const statement = { account: 'a0'.repeat(32), signingKey: '2b'.repeat(32), wrappingKey: '2c'.repeat(32), seat: '2d'.repeat(32), signature: '2e'.repeat(64) };
    /* The inviter's own seat's opening travels with its entry, and nothing of any other seat. */
    const opening = { publicKey: '2f'.repeat(32), scope: '30'.repeat(32), blinding: '31'.repeat(32), walletKey: K(3), salt: '32'.repeat(32) };
    kr.keys = { ...kr.keys!, invitedBy: { committeeKey: K(3), statement, opening } as never };
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    /* RED WHEN: the inviter's opening is not handed to the account with the entry, so the account cannot judge the inviter's seat. */
    expect(kr.invitedBy).toEqual({ committeeKey: K(3), statement, opening });
    kr.keys = { ...kr.keys!, invitedBy: { committeeKey: { tag: 'ecdsa', value: K(3).value }, statement, opening } as never };
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.invitedBy).toBeUndefined();
  });

  it('gives the keys before the account is its committee\'s, keeps the directory entry, and files it on the next way in with no press', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.roster = rosterWith(K(1));
    kr.accountHeld = false;
    expect(await acts.giveMyVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.filter((c) => c.path.startsWith('offer'))).toHaveLength(1);
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
    contracts: [{ contract: 'vault', address: 'b0'.repeat(32), counter: '3', now: { committee: [K(1), K(9)], threshold: 2 }, signedIndexes: [] as number[], required: 2 }],
  };

  /* RED WHEN: a change this person has already signed is asked of their account again, or said as a failure rather than nothing to sign. */
  it('says there is nothing to sign, and asks the account nothing, when this person has signed', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/committee-change'] = { ...OWED, contracts: [{ ...OWED.contracts[0], signedIndexes: [0] }] };
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
    const signed = { ...OWED, contracts: [{ ...OWED.contracts[0]!, signedIndexes: [0] }] } as never;
    kr.check = { code: COMMITTEE_CHANGE_REFUSAL.nothingToSign, why: 'words no sentence of the check has ever been' };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'nothing-to-sign' });
    kr.check = { code: COMMITTEE_CHANGE_REFUSAL.refused, why: nothingForMe(signed, K(1)) };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-disagrees' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  /* RED WHEN: the device stops asking the service to send a contract whose kept signatures reach its threshold - the service sends nothing on its own. */
  it('asks the service to send each contract whose kept signatures reach its threshold, and no other', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/committee-change'] = OWED;
    const VAULT_BEHIND = OWED.contracts[0]!.address;
    kr.answers['/api/accounts/c1/committee-change/signatures'] = { results: [{ address: VAULT_BEHIND, state: 'kept', have: 2, required: 2 }] };
    kr.answers['/api/accounts/c1/committee-change/send'] = { state: 'sent' };
    kr.roster = rosterWith(K(1));
    kr.signed = { signer: K(1), signatures: [{ address: VAULT_BEHIND, counter: '3', seat: 0, signature: K(7) }] };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
      ['/api/accounts/c1/committee-change/signatures', { to: OWED.to, signatures: [{ address: VAULT_BEHIND, counter: '3', index: 0, signature: K(7) }] }],
      ['/api/accounts/c1/committee-change/send', { address: VAULT_BEHIND, counter: '3', to: OWED.to }],
    ]);
  });

  /* RED WHEN: a change is signed and sent when the key this person's wallet gives holds no place on any contract behind, or the signatures the account gave are not what is sent. */
  it('sends the account\'s signatures, and nothing when the wallet\'s key holds no place on any contract behind', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/committee-change'] = OWED;
    kr.answers['/api/accounts/c1/committee-change/signatures'] = { results: [] };
    kr.roster = rosterWith(K(1));
    kr.signed = { signer: K(1), signatures: [{ address: 'a', counter: '3', seat: 0, signature: K(7) }] };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([{ path: '/api/accounts/c1/committee-change/signatures', method: 'POST',
      body: { to: OWED.to, signatures: [{ address: 'a', counter: '3', index: 0, signature: K(7) }] } }]);
    kr.calls = [];
    kr.walletKey = K(2);
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'nothing-to-sign' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  /* RED WHEN: the change reads this person's roster entry, their seat or their keys for the company: a super admin with none cannot sign. */
  it('a super admin with no seat, no roster entry and no keys for the company on this device signs the change', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1/committee-change'] = OWED;
    kr.answers['/api/accounts/c1/committee-change/signatures'] = { results: [] };
    kr.keys = null;
    kr.roster = null;
    kr.signed = { signer: K(1), signatures: [{ address: 'a', counter: '3', seat: 0, signature: K(7) }] };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([{ path: '/api/accounts/c1/committee-change/signatures', method: 'POST',
      body: { to: OWED.to, signatures: [{ address: 'a', counter: '3', index: 0, signature: K(7) }] } }]);
  });

  /* RED WHEN: the signers' open vault-key offers are folded on the way to the change, so one the fold cannot take stops the super admins signing. */
  it('a signer\'s vault-key offer the fold cannot take does not stop the super admins signing', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/committee-change'] = OWED;
    kr.answers['/api/accounts/c1/committee-change/signatures'] = { results: [] };
    kr.roster = rosterWith(K(1));
    kr.signed = { signer: K(1), signatures: [{ address: 'a', counter: '3', seat: 0, signature: K(7) }] };
    kr.foldFails = 'the offer did not verify';
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls.some((c) => c.method === 'FOLD')).toBe(false);
    expect(kr.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/accounts/c1/committee-change/signatures']);
  });

  /* RED WHEN: the committee a change installs is judged against anything but the one holding the account on the chain, as the wallet reads it: a threshold on the company's record or the roster is never read. */
  it('holds the change to the committee holding the account on the chain, as this person\'s wallet reads it, and to nothing on the company\'s record', async () => {
    const { acts } = await load();
    kr.answers['/api/accounts/c1'] = {};
    kr.answers['/api/accounts/c1/committee-change'] = OWED;
    kr.answers['/api/accounts/c1/committee-change/signatures'] = { results: [] };
    kr.signed = { signer: K(1), signatures: [{ address: 'a', counter: '3', seat: 0, signature: K(7) }] };
    /* The company's record still says 5 from before a change carried out on the chain; the chain says 1. */
    kr.roster = { ...rosterWith(K(1)), policy: { threshold: 5 } };
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'done' });
    /* And a service naming another committee than the chain's is refused, whatever the record says. */
    kr.calls = [];
    kr.roster = { ...rosterWith(K(1)), policy: { threshold: 1 } };
    kr.chainCommittee = [K(1), K(2)];
    kr.chainThreshold = 2;
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-disagrees' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
    /* RED WHEN: the threshold is taken from anywhere but the chain: the chain holds the service's one key at two. */
    kr.calls = [];
    kr.chainCommittee = [K(1)];
    kr.chainThreshold = 2;
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-disagrees' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
