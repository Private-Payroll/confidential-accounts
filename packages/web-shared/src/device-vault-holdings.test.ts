import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import { deviceVaultHoldings, type ChainNotesView, type DeviceHoldingsDoors, type PoolNote } from './device-vault-holdings.js';

/*
 * WHAT A SIGNER'S DEVICE TELLS A SCREEN ABOUT A VAULT'S PRIVATE NOTES: the
 * sum of each token asked for, how many other tokens it holds, and which of
 * nothing held yet, a record the chain contradicts, and a read that could not
 * be made it found. The doors are stood in for; the comparison of the pool
 * with the chain is the product's own.
 */
const VAULT = 'ab'.repeat(32) as Hex;
const TOKEN = 'c1'.repeat(32);
const OTHER = 'c2'.repeat(32);
const STRANGE = 'c9'.repeat(32);
const note = (n: number, token: string, value: bigint): PoolNote => ({ nonce: String(n).padStart(2, '0').repeat(32) as Hex, token: token as Hex, value });
const commitment = (n: PoolNote) => `h${n.nonce.slice(0, 8)}`;
const holding = (notes: readonly PoolNote[]): ChainNotesView => ({ onChain: true, notesFromThisBuild: true, notes: notes.map(commitment) });

function doors(pool: readonly PoolNote[] | null, chain: ChainNotesView | Error, over: Partial<DeviceHoldingsDoors> = {}): DeviceHoldingsDoors {
  return {
    chain: async () => { if (chain instanceof Error) throw chain; return chain; },
    pool: async () => pool,
    heldCommitmentOf: async (_v, n) => commitment(n),
    paymentsFit: async () => ({ of: 'fits' }),
    ...over,
  } as DeviceHoldingsDoors;
}

describe('a vault\'s private notes, as a screen is told them', () => {
  const NOTES = [note(1, TOKEN, 100n), note(2, TOKEN, 50n), note(3, OTHER, 7n), note(4, STRANGE, 3n), note(5, STRANGE, 4n), note(6, 'ca'.repeat(32), 0n)];

  /* RED WHEN: a token asked for is not summed over all its notes, a token not asked for is added to one that was, a token asked for and not held is left out or not zero, or the other tokens are counted for each note, counted when they hold nothing, or not counted at all. */
  it('sums each token asked for and counts the other tokens it holds, one for each token', async () => {
    const answer = await deviceVaultHoldings(doors(NOTES, holding(NOTES))).privateNotes(VAULT, [OTHER, TOKEN, 'cd'.repeat(32)]);
    expect(answer).toEqual({ of: 'held', amounts: [7n, 150n, 0n], unrecognised: 1 });
  });

  /* RED WHEN: a vault whose pool was never opened, and whose chain holds no note, is read as a failure or as a sum of zero in each token; or one whose chain holds a note is read as nothing yet. */
  it('says nothing is held yet only when no pool was opened and the chain holds no note', async () => {
    const holdings = deviceVaultHoldings(doors(null, holding([])));
    expect(await holdings.privateNotes(VAULT, [TOKEN])).toEqual({ of: 'nothing-yet' });
    const notNothing = await deviceVaultHoldings(doors(null, holding([NOTES[0]!]))).privateNotes(VAULT, [TOKEN]);
    expect(notNothing).toMatchObject({ of: 'unreadable', because: 'record' });
  });

  /* RED WHEN: a payment's check or a balance asked of a vault with no pool reads it as holding zero, or throws instead of saying it could not be read. */
  it('never reads a vault with no pool as holding zero when a payment or a balance asks', async () => {
    const holdings = deviceVaultHoldings(doors(null, holding([])));
    expect((await holdings.held(VAULT, 'shielded', TOKEN)).of).toBe('unreadable');
    expect((await holdings.fits(VAULT, [{ payee: { kind: 'shielded' }, token: TOKEN, amount: 1n }])).of).toBe('unreadable');
  });

  /* RED WHEN: a pool that claims a note the chain does not hold is summed, or is told as a read that failed; or a chain that cannot be asked, shows no vault, or has a ledger of another shape is not told apart, or loses the failure that caused it. */
  it('tells a record the chain contradicts from a read that failed, and why the read failed', async () => {
    const claims = await deviceVaultHoldings(doors(NOTES, holding(NOTES.slice(1)))).privateNotes(VAULT, [TOKEN]);
    expect(claims.of).toBe('contradicted');
    const down = new Error('the indexer is down');
    const asked = await deviceVaultHoldings(doors(NOTES, down)).privateNotes(VAULT, [TOKEN]);
    expect(asked).toMatchObject({ of: 'unreadable', because: 'chain', cause: down });
    expect(await deviceVaultHoldings(doors(NOTES, { onChain: false })).privateNotes(VAULT, [TOKEN])).toMatchObject({ of: 'unreadable', because: 'chain' });
    expect(await deviceVaultHoldings(doors(NOTES, { ...holding(NOTES), notesFromThisBuild: false })).privateNotes(VAULT, [TOKEN])).toMatchObject({ of: 'unreadable', because: 'layout' });
  });

  /* RED WHEN: a payment's check of a vault whose record the chain contradicts hears that the vault could not be read, so a record that claims money the vault cannot spend is told as a slow chain; or hears that it fits. */
  it('tells a payment\'s check that a record the chain contradicts is contradicted, not unreadable', async () => {
    const holdings = deviceVaultHoldings(doors(NOTES, holding(NOTES.slice(1))));
    const asked = [{ payee: { kind: 'shielded' as const }, token: TOKEN, amount: 1n }];
    expect((await holdings.fits(VAULT, asked)).of).toBe('contradicted');
    expect((await holdings.held(VAULT, 'shielded', TOKEN)).of).toBe('contradicted');
  });

  /* RED WHEN: a pool that is there and cannot be opened is read as one never opened, or its failure is swallowed. */
  it('lets a pool that cannot be opened fail, rather than read it as never opened', async () => {
    const broken = deviceVaultHoldings(doors(null, holding([]), { pool: async () => { throw new Error('the key would not unwrap'); } }));
    await expect(broken.privateNotes(VAULT, [TOKEN])).rejects.toThrow('the key would not unwrap');
  });
});
