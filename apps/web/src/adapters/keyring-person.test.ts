// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE KEYRING BROUGHT TO THE PERSON, AND THEIR KEYS FOUND ON THE WAY INTO A
 * COMPANY. The keyring is stood in for, and records what it was asked, in
 * order. The way in signs and files nothing.
 */
const kr = vi.hoisted(() => ({
  asked: [] as string[],
  keys: null as null | { signerId: string; signingPublicKey: string },
  canOpen: true,
  user: null as null | { id: string },
  resumedWith: [] as unknown[],
}));
vi.mock('vaults-web-shared/keyring.js', () => ({
  currentUser: () => kr.user,
  forgetLocally: () => { kr.asked.push('forget'); kr.user = null; },
  resumeSession: async (carried: unknown = null) => { kr.asked.push('resume'); kr.resumedWith.push(carried); kr.user = { id: 'u1' }; return kr.user; },
  canOpenCompanies: () => kr.canOpen,
  seatHeldHere: (id: string) => { kr.asked.push(`seat ${id}`); return kr.keys; },
  api: async () => { throw new Error('nothing is asked of the service on the way into a company'); },
}));
const { keyringFor, keysOnTheWayIn } = await import('./keyring-person.js');

beforeEach(() => {
  kr.asked = []; kr.keys = null; kr.canOpen = true; kr.user = null; kr.resumedWith = [];
  window.sessionStorage.clear();
});

describe('keys found on the way into a company', () => {
  /* RED WHEN: the way into a company opens saved keys on the page, which only the wallet opens now. */
  it('reads the seat as the wallet read it for this tab, and opens nothing', async () => {
    expect(await keysOnTheWayIn('c1')).toBeNull();
    expect(kr.asked).toEqual(['seat c1']);
  });

  it('hands back the seat\'s public halves, and signs, files and asks the service for nothing on the way in', async () => {
    kr.keys = { signerId: 's1', signingPublicKey: 'a1'.repeat(32) };
    expect(await keysOnTheWayIn('c1')).toEqual({ signerId: 's1', signingPublicKey: 'a1'.repeat(32) });
    /* RED WHEN: opening a company files or signs on the page: an owed directory entry, a change of the company's key, a roster followed, a seat finished. */
    expect(kr.asked).toEqual(['seat c1']);
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const code = readFileSync(join(process.cwd(), 'apps/web/src/adapters/keyring-person.ts'), 'utf8');
    /* RED WHEN: the way into a company again reaches a door that signs: those run in a seat action's window in the person's wallet. */
    for (const door of ['fileTheOwedDirectoryEntry', 'rotateTheCompanyKeyHere', 'fileTheRosterFollowedHere', 'sealPoliciesToNewSignersHere', 'finishPendingSeat', 'recordsEnteredOver', 'reopenSavedKeys', 'signingSecret']) {
      expect(code, door).not.toContain(door);
    }
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
