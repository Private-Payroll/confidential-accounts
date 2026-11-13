// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/*
 * THE VAULT-KEY OFFERS THIS DEVICE CAN OPEN, AND AN ENTRY ALREADY ON FILE. The shared opening step is stood in for by
 * a verdict per seat; filing an entry is the shared code's own (`seat-directory-route.test.ts`).
 */
const K = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const SEAT = '5a'.repeat(32);
const kr = vi.hoisted(() => ({
  /* What the shared opening step answers for the offer of each seat. */
  verdicts: {} as Record<string, unknown>,
}));
vi.mock('vaults-web-shared/vault-keys-offer-opened.js', () => ({
  /* The shared step, stood in for by a verdict per seat: the opened offer, or the text of why it is refused. */
  vaultKeysOfferOpened: (_id: string, kept: { seat: string }) => kr.verdicts[kept.seat.toLowerCase()] ?? 'it is not an offer of vault keys',
}));

const VIEWING = { epoch: 0, newest: 0, key: 'vk', keyAt: () => 'vk', sealing: () => ({ key: 'vk', epoch: 0 }) } as never;
const ENTRY = (signingKey: string) => ({ signingKey, wrappingKey: '33'.repeat(32), seat: SEAT, signature: '55'.repeat(64) });

async function load() {
  vi.resetModules();
  return import('./vault-keys.js');
}

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

describe('the offers readiness counts', () => {
  /* RED WHEN: readiness opens and checks an offer by steps of its own, so it can count an offer the fold's step refuses, or leave out one it takes. */
  it('counts exactly the offers the shared opening step opens, by seat, and none it refuses', async () => {
    const m = await load();
    const good = { keys: 'k' };
    kr.verdicts = { aa: good };
    const open = m.offersOpenHere('c1', { offers: [{ seat: 'AA' }, { seat: 'bb' }, { seat: 'cc' }] }, VIEWING, 'co' as never, 'ac' as never);
    expect([...open.keys()]).toEqual(['aa']);
    expect(open.get('aa')).toBe(good);
    kr.verdicts = {};
  });
});
