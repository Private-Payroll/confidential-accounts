import { describe, expect, it, vi } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import { MemorySealedPoolStore } from '../../../src/midnight/vault-pool.js';

/*
 * **A SEAT THAT MAY NOT FILE A VAULT'S RECORDS FILES NOTHING AGAIN OF WHAT A SIGNER WHO LEFT FILED.** When a vault's notes
 * are read on a device (`vaultNotesHere`), the versions a leaving signer filed that the chain vouches for are filed again
 * first, and only by a seat whose role files all three of the vault's records: a viewer, a retired seat or a seat this
 * device does not believe files none and says so. The filing again is stood in, so whether it is asked can be seen.
 */

const t = vi.hoisted(() => ({ filedAgain: 0 }));
vi.mock('./deposit-on-device.js', async (real) => ({
  ...(await real<typeof import('./deposit-on-device.js')>()),
  fileThePoolTheChainHolds: async () => { t.filedAgain += 1; return { answer: 'nothing-to-file', said: [], journals: [] }; },
}));

const { vaultNotesHere } = await import('./vault-operation.js');

const VAULT = 'd8'.repeat(32) as Hex;
const view = { onChain: true, state: '', notes: [], notesFromThisBuild: true, everCreated: [], account: 'c0'.repeat(32), started: true, nonceCommitment: '5c'.repeat(32), splitJournal: [], vault: VAULT };
const doors = (seat: (() => Promise<{ role: string | null; retired: unknown } | null>) | undefined) => ({
  account: 'c0'.repeat(32), onChain: async () => ({ holders: { adoptedVaults: [VAULT] } }), indexer: async () => ({}),
  builder: { vaultOnChain: async () => view, commitments: async () => ({ output: '', held: '00' }), creatingTransaction: async () => ({ state: 'refused' }), eventsOf: async () => [], createdBy: async () => null },
  me: { signerId: 'bo', wrappingSecret: '02'.repeat(32), companyKey: new Uint8Array(32).fill(7) },
  records: () => new MemorySealedPoolStore(), signers: async () => [],
  ...(seat === undefined ? {} : { seatHere: seat }),
}) as never;

describe('WHAT A SIGNER WHO LEFT FILED IS FILED AGAIN ONLY BY A SEAT THAT MAY FILE THE VAULT\'S RECORDS', () => {
  it('a viewer, a retired seat, a seat this device does not believe and a read with no seat file nothing again and say so; an admin does', async () => {
    const seats = [async () => ({ role: 'viewer', retired: null }), async () => ({ role: 'admin', retired: { at: 3 } }), async () => null, undefined];
    for (const seat of seats) {
      const here = await vaultNotesHere(doors(seat), VAULT, view as never);
      /* RED WHEN: a seat whose role files no vault record, or that is retired or not believed, files a leaver's versions again. */
      expect(here.said.join(' ')).toMatch(/what a seat that left filed is not filed again from here/);
    }
    expect(t.filedAgain).toBe(0);
    await vaultNotesHere(doors(async () => ({ role: 'admin', retired: null })), VAULT, view as never);
    /* RED WHEN: a seat that may file every record of the vault never files a leaver's versions again. */
    expect(t.filedAgain).toBe(1);
  });
});
