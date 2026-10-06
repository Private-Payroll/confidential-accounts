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
  api: async () => { throw new Error('nothing is asked of the service on the way in when no entry is owed'); },
}));
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
    expect(kr.asked).toEqual(['keys c1', 'reopen', 'seats c1', 'sealed', `finish c1 ${JSON.stringify(sealed)}`, 'keys c1']);
  });

  /* RED WHEN: with no seat to finish, the company's record is asked for anyway, or keys saved in another tab since are not read first. */
  it('asks for nothing more when there is no seat to finish', async () => {
    expect(await keysOnTheWayIn('c1', async () => { throw new Error('the record was asked for'); })).toBeNull();
    expect(kr.asked).toEqual(['keys c1', 'reopen', 'seats c1', 'keys c1']);
    kr.asked = []; kr.keys = { signerId: 's1' };
    expect(await keysOnTheWayIn('c1', async () => { throw new Error('the record was asked for'); })).toEqual({ signerId: 's1' });
    expect(kr.asked).toEqual(['keys c1', 'seats c1', 'keys c1']);
  });

  /* RED WHEN: keys that are not open in this tab are read again anyway, which can only fail, so a company whose keys only need opening is refused instead of said to be locked. */
  it('reads nothing again while the keys are not open in this tab', async () => {
    kr.canOpen = false;
    expect(await keysOnTheWayIn('c1', async () => { throw new Error('the record was asked for'); })).toBeNull();
    expect(kr.asked).toEqual(['keys c1', 'seats c1', 'keys c1']);
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
