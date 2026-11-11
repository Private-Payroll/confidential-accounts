/**
 * **THE ROLES THAT FILE A KIND ARE THE ONES THE ONE ROLE LIST GIVES, AND THE REFUSAL NAMES THEM.**
 */
import { describe, expect, it } from 'vitest';
import { mayFileHere, seatThatMayFileHere } from './may-file-here.js';
import { seatRefusalIn } from './vault-start-steps.js';
import { newSigningKeypair, type Hex } from '../../../src/core/crypto.js';
import type { DirectoryHere } from './vault-page-doors.js';

const aDirectoryOf = (role: string | null, signingKey = 'ab'.repeat(32)): DirectoryHere => ({
  dir: { seats: [{ seat: 's1', person: 'p', signingKey, wrappingKey: 'cd'.repeat(32), role, retired: null }] },
  another: new Set<string>(),
  holders: { seats: ['s1'] },
} as unknown as DirectoryHere);

describe('THE ROLES THAT FILE A KIND', () => {
  it('the refusal names exactly the roles the one role list lets file the kind', async () => {
    const asked = (kind: Parameters<typeof mayFileHere>[2]) => mayFileHere(async () => aDirectoryOf('limited'), 'ab'.repeat(32), kind);
    /* RED WHEN: a role that may not file a person's or a vendor's record is named as one that may, or the one that may is left out. */
    expect((await asked('person'))?.says).toMatch(/\(admin\) must make this change/u);
    expect((await asked('vendor'))?.says).toMatch(/\(admin\) must make this change/u);
    expect((await asked('proposal'))?.says).toMatch(/\(admin, approver, initiator\) must make this change/u);
  });

  it('a seat is told why it may not, naming the roles that may', async () => {
    const key = 'ab'.repeat(32);
    /* RED WHEN: a limited seat is allowed a person's record, or is refused without being told which roles file it. */
    const limited = await mayFileHere(async () => aDirectoryOf('limited'), key.toUpperCase(), 'person');
    expect(limited).toMatchObject({ why: 'role', says: expect.stringMatching(/limited.*person records.*\(admin\) must make this change/u) });
    /* RED WHEN: a seat whose role files the kind is refused. */
    expect(await mayFileHere(async () => aDirectoryOf('admin'), key, 'person')).toBeNull();
    /* RED WHEN: a seat in no directory entry is allowed. */
    expect(await mayFileHere(async () => aDirectoryOf('admin'), 'ee'.repeat(32), 'person')).toMatchObject({ why: 'no-seat' });
  });

  it('the page\'s filings, a vault\'s start and the records a seat files all ask the one check, each in its own words', async () => {
    const mine = newSigningKeypair();
    const stranger = newSigningKeypair();
    for (const [role, by] of [['initiator', mine], ['limited', mine], ['admin', mine], ['admin', stranger]] as const) {
      const here = aDirectoryOf(role, mine.publicKey);
      const one = await mayFileHere(async () => here, by.publicKey, 'proposal');
      const page = seatThatMayFileHere(here, by.publicKey, 'proposal', 'its role');
      const start = seatRefusalIn({ signingSecret: by.secret as Hex }, here);
      /* RED WHEN: the three callers judge a seat apart, so one lets a seat raise what another refuses. */
      expect([typeof page === 'string', start !== null]).toEqual([one !== null, one !== null]);
      expect(page === 'its role').toBe(one?.why === 'role');
    }
  });
});
