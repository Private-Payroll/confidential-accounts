// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE KEYRING BROUGHT TO THE PERSON, AND THEIR KEYS FOUND ON THE WAY INTO A
 * COMPANY. The keyring is stood in for, and records what it was asked, in
 * order.
 */
const kr = vi.hoisted(() => ({
  asked: [] as string[],
  keys: null as null | { signerId: string },
  canOpen: true,
  seats: [] as unknown[],
  finishes: null as null | { signerId: string },
  user: null as null | { id: string },
  resumedWith: [] as unknown[],
}));
vi.mock('vaults-web-shared/keyring.js', () => ({
  currentUser: () => kr.user,
  forgetLocally: () => { kr.asked.push('forget'); kr.user = null; },
  resumeSession: async (carried: unknown = null) => { kr.asked.push('resume'); kr.resumedWith.push(carried); kr.user = { id: 'u1' }; return kr.user; },
  canOpenCompanies: () => kr.canOpen,
  keysFor: (id: string) => { kr.asked.push(`keys ${id}`); return kr.keys; },
  reopenSavedKeys: async () => { kr.asked.push('reopen'); },
  pendingSeatsFor: (id: string) => { kr.asked.push(`seats ${id}`); return kr.seats; },
  finishPendingSeat: async (id: string, sealed: unknown) => {
    kr.asked.push(`finish ${id} ${JSON.stringify(sealed)}`);
    if (kr.finishes === null) return false;
    kr.keys = kr.finishes;
    return true;
  },
  /* No directory entry is owed here; one that is, is `hand-over`'s own test's. */
  directoryEntryOwed: () => ({ read: () => null, settle: async () => {} }),
  viewingKeyFor: (rec: { id: string }) => `viewing key of ${rec.id}`,
  api: async () => { throw new Error('nothing is asked of the service on the way in when no entry is owed'); },
}));
/* The roster followed on the way in, stood in for: what it was handed is written down. */
vi.mock('vaults-web-shared/roster-here.js', () => ({
  fileTheRosterFollowedHere: async (d: { accountId: string; viewingKey: string; signingSecret: string; label: string; account: string }) => {
    kr.asked.push(`follow the roster of ${d.accountId} as ${d.signingSecret} with ${d.viewingKey}, ${d.label}, ${d.account}`);
    return null;
  },
}));
vi.mock('./filing-judge.js', () => ({ rosterReadsFor: () => ({}) }));
/* The policies sealed on the way in, stood in for: what it was handed is written down, and it fails when told to. */
vi.mock('vaults-web-shared/spending-policy-here.js', () => ({
  sealPoliciesToNewSignersHere: async (d: { filingKey: string }) => {
    kr.asked.push(`seal the policies as ${d.filingKey}`);
    if (d.filingKey === 'fails') throw new Error('the store refused');
    return { sealed: [], refused: [] };
  },
}));
vi.mock('vaults-web-shared/record-entered-here.js', () => ({ recordsEnteredOver: () => ({}) }));
const { keyringFor, keysOnTheWayIn } = await import('./keyring-person.js');

beforeEach(() => {
  kr.asked = []; kr.keys = null; kr.canOpen = true; kr.seats = []; kr.finishes = null; kr.user = null; kr.resumedWith = [];
  window.sessionStorage.clear();
});

describe('keys found on the way into a company', () => {
  /*
   * RED WHEN: a seat this device published and did not finish saving is not
   * finished on the way into its company, or is finished only after the
   * company's keys were read, so the company says to open it elsewhere on the
   * one device that holds its keys.
   */
  it('finishes a seat this device left unfinished before the company\'s keys are read', async () => {
    kr.seats = [{ accountId: 'c1' }];
    kr.finishes = { signerId: 's1' };
    const sealed = { id: 'c1', wrappedKeys: [] };
    expect(await keysOnTheWayIn('c1', async () => { kr.asked.push('sealed'); return sealed as never; })).toEqual({ signerId: 's1' });
    /* The record is read again for the roster on the way in, as for any seat that holds keys. */
    expect(kr.asked).toEqual(['keys c1', 'reopen', 'seats c1', 'sealed', `finish c1 ${JSON.stringify(sealed)}`, 'keys c1', 'sealed']);
  });

  /* RED WHEN: with no keys and no seat to finish, the company's record is asked for anyway, or keys saved in another tab since are not read first. */
  it('asks for nothing more when there is no seat to finish and no keys', async () => {
    expect(await keysOnTheWayIn('c1', async () => { throw new Error('the record was asked for'); })).toBeNull();
    expect(kr.asked).toEqual(['keys c1', 'reopen', 'seats c1', 'keys c1']);
  });

  it('follows a roster version every device refuses, with this seat\'s keys, and a read that fails stops nothing', async () => {
    kr.keys = { signerId: 's1', signingSecret: 'ss1' } as never;
    const sealed = { id: 'c1', wrappedKeys: [], companyLabel: 'co_label', contractAddress: 'ac' };
    expect(await keysOnTheWayIn('c1', async () => { kr.asked.push('sealed'); return sealed as never; })).toEqual(kr.keys);
    /* RED WHEN: a company whose newest roster every device refuses is not followed on the way in, so it stays frozen with no door out. */
    expect(kr.asked).toEqual(['keys c1', 'seats c1', 'keys c1', 'sealed', 'follow the roster of c1 as ss1 with viewing key of c1, co_label, ac']);
    kr.asked = [];
    expect(await keysOnTheWayIn('c1', async () => { throw new Error('the record could not be read'); })).toEqual(kr.keys);
    expect(kr.asked).toEqual(['keys c1', 'seats c1', 'keys c1']);
  });

  /* RED WHEN: keys that are not open in this tab are read again anyway, which can only fail, so a company whose keys only need opening is refused instead of said to be locked. */
  it('reads nothing again while the keys are not open in this tab', async () => {
    kr.canOpen = false;
    expect(await keysOnTheWayIn('c1', async () => { throw new Error('the record was asked for'); })).toBeNull();
    expect(kr.asked).toEqual(['keys c1', 'seats c1', 'keys c1']);
  });
});

describe('spending policies sealed on the way into a company', () => {
  /* RED WHEN: a signer seated after a policy was set is never sealed into it on the way in, so they can never raise or approve a run from its vault. */
  it('seals every policy in force to the signers seated since, after the roster, and a failure stops nothing', async () => {
    kr.keys = { signerId: 's1', signingSecret: 'ss1' } as never;
    const sealed = { id: 'c1', wrappedKeys: [], companyLabel: 'co_label', contractAddress: 'ac' };
    const policies = async (keys: { signerId: string }) => ({ filingKey: `filing key of ${keys.signerId}` }) as never;
    expect(await keysOnTheWayIn('c1', async () => sealed as never, policies)).toEqual(kr.keys);
    expect(kr.asked.slice(-2)).toEqual(['follow the roster of c1 as ss1 with viewing key of c1, co_label, ac', 'seal the policies as filing key of s1']);
    kr.asked = [];
    expect(await keysOnTheWayIn('c1', async () => sealed as never, async () => ({ filingKey: 'fails' }) as never)).toEqual(kr.keys);
    expect(kr.asked.at(-1)).toBe('seal the policies as fails');
    kr.asked = [];
    /* Nothing to read the policies with: nothing is sealed, and the company opens as before. */
    expect(await keysOnTheWayIn('c1', async () => sealed as never, async () => null)).toEqual(kr.keys);
    expect(kr.asked.some((x) => x.startsWith('seal'))).toBe(false);
  });

  /* RED WHEN: a device holding no keys for the company tries to seal its policies. */
  it('seals nothing where this device holds no keys', async () => {
    expect(await keysOnTheWayIn('c1', async () => { throw new Error('the record was asked for'); }, async () => ({ filingKey: 'k' }) as never)).toBeNull();
    expect(kr.asked.some((x) => x.startsWith('seal'))).toBe(false);
  });
});

describe('the keyring brought to the person', () => {
  /* RED WHEN: a reloaded tab picks the sign-in up without handing back what was kept in it, or hands back something that is not what was kept. */
  it('hands back the sign-in kept in this tab', async () => {
    window.sessionStorage.setItem('private-vaults.signed-in-as', JSON.stringify({ personId: 'u1', address: 'mn_addr_a' }));
    expect(await keyringFor('u1')).toBe(true);
    expect(kr.resumedWith).toEqual([{ personId: 'u1', address: 'mn_addr_a' }]);
    kr.user = null; kr.resumedWith = [];
    window.sessionStorage.setItem('private-vaults.signed-in-as', '{"personId":"u1"}');
    await keyringFor('u1');
    expect(kr.resumedWith).toEqual([null]);
  });
});
