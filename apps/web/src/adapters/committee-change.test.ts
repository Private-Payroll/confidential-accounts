// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSigningKeypair, type Hex } from '../../../../src/core/crypto.js';
import { signVaultKeys } from '../../../../src/core/vault-keys.js';

/*
 * THE COMMITTEE CHANGE AND WHERE A COMPANY STANDS, THROUGH THE ADAPTERS. The keyring and the service are
 * stood in for; the checks the shared code makes before anything is sent run
 * as they are, against a roster made to agree or not.
 */
const K = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const SIGNER = newSigningKeypair();
const kr = vi.hoisted(() => ({
  calls: [] as { path: string; method: string; body: unknown }[],
  answers: {} as Record<string, unknown>,
  keys: { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' } as Record<string, string> | null,
  roster: null as unknown, walletKey: null as unknown, signed: null as unknown, opened: 0, user: 'u1',
  /** When set, what the shared check answers, in place of its own answer. */
  check: undefined as undefined | null | { code: string; why: string },
  /** When set, why folding the open offers into the roster fails, as the service's refusal of an unbelieved seat would. */
  foldFails: null as string | null,
  /** The account's committee and threshold as this person's wallet reads them off the chain. */
  chainCommittee: null as { tag: string; value: string }[] | null,
  chainThreshold: 1,
}));
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
  pendingSeatsFor: () => [],
  viewingKeyFor: () => 'vk',
  openAccount: () => kr.roster,
  companyKeysForVaults: async () => ({ companyKey: '11'.repeat(32), committeeKey: kr.walletKey, company: 'co_' + 'a1'.repeat(32), account: 'a0'.repeat(32) }),
  signCommitteeChangeFromTheWallet: async () => kr.signed,
  holdersFromTheWallet: async () => ({ holders: { committee: kr.chainCommittee ?? [K(1)], threshold: kr.chainThreshold } }),
  api: async (path: string, opts?: RequestInit) => {
    kr.calls.push({ path, method: String(opts?.method ?? 'GET'), body: opts?.body === undefined ? undefined : JSON.parse(String(opts.body)) });
    if (!(path in kr.answers)) throw new Error(`no answer for ${path}`);
    /* A list is answered one item a request, the last kept for every request after. */
    const a = kr.answers[path];
    if (a instanceof Error) throw a;
    return Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
  },
}));
/* Offering and folding vault keys are their own tests' (`vault-keys-are-offered-and-folded.test.ts`); here each is written down, so a test can see that signing the change never calls either. */
vi.mock('vaults-web-shared/roster-here.js', () => ({
  offerVaultKeysHere: async (_api: unknown, id: string, keys: unknown) => { kr.calls.push({ path: `offer ${id}`, method: 'PUT', body: keys }); },
  foldOffersHere: async (d: { accountId: string }) => {
    kr.calls.push({ path: `fold ${d.accountId}`, method: 'FOLD', body: undefined });
    if (kr.foldFails !== null) throw new Error(kr.foldFails);
    return { folded: [], refused: [] };
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
  return { acts: await import('./committee-change.js'), state: await import('./handover-state.js') };
}

const AUTHORITY = (over: Record<string, unknown> = {}) => ({
  company: { address: 'a', label: null }, committee: { committee: [K(1)], threshold: 1 }, why: null,
  contracts: [{ contract: 'account', address: 'a', read: 'read', seats: [], threshold: 1, changes: '0', shape: 'one-key', heldByTheCompany: false }],
  change: { possible: false, why: 'x' }, ...over,
});

beforeEach(() => { kr.chainCommittee = null; kr.chainThreshold = 1; kr.foldFails = null; kr.check = undefined; kr.user = 'u1'; kr.calls = []; kr.answers = {}; kr.keys = { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' }; kr.opened = 0; kr.walletKey = K(1); kr.roster = null; kr.signed = null; });
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

describe('what the committee change offers', () => {
  /* RED WHEN: a press hands the company's account over again - no target for one exists, and any member could name their own key - or this adapter offers anything but signing the change. */
  it('offers no press that hands the company\'s account over, and gives no vault keys', async () => {
    const { acts } = await load();
    expect(Object.keys(acts).sort()).toEqual(['signChange']);
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
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'committee-disagrees' });
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
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'committee-disagrees' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
    /* RED WHEN: the threshold is taken from anywhere but the chain: the chain holds the service's one key at two. */
    kr.calls = [];
    kr.chainCommittee = [K(1)];
    kr.chainThreshold = 2;
    expect(await acts.signChange('u1', 'c1')).toEqual({ of: 'refused', why: 'committee-disagrees' });
    expect(kr.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
