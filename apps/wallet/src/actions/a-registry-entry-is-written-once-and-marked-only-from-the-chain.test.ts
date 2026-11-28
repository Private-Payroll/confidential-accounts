import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
import { companyLabelOf } from 'midnight-identity/profile/company-label';
import { openEntry, sealEntry, tagAt } from 'midnight-identity/profile/private-registry';
import type { ChainCall, HandOver } from '../../../../packages/web-shared/src/hand-over.js';
import type { Keyring, RegistryMark } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { AccountBuilding } from '../chain/account-builder-client.js';
import {
  registryEntryOwed,
  registryEntryWritten,
  SENT_HOLDS_MS,
  type RegistryWriteDoors,
  type SeatToEnter
} from './registry-entry.js';

/*
 * **ONE SIGNER SEAT'S ENTRY IN THE PRIVATE REGISTRY**: owed only for the pinned account and a seat seated now; written
 * at the lowest of this person's tags nobody holds; marked written only when a read of the registry finds it; and a
 * write handed over and not yet found holds a second one back for a day.
 */

const identity = identityFromSecret(new Uint8Array(32).fill(5));
const NET = 'preprod' as const;
const REGISTRY = '5e'.repeat(32);
const LABEL = companyLabelOf(new Uint8Array(32).fill(0xc1));
const NOW = Date.parse('2026-11-25T12:00:00Z');
const seat = (mark?: RegistryMark): SeatToEnter => ({
  accountId: 'acc_1',
  label: LABEL,
  account: 'a1'.repeat(32),
  n: 0,
  scope: 'b2'.repeat(32),
  leaf: 'c3'.repeat(32),
  ...(mark === undefined ? {} : { mark })
});
const valueAt = (i: number, over: Partial<SeatToEnter> = {}) => {
  const s = { ...seat(), ...over };
  return sealEntry(identity, NET, i, { label: s.label, account: s.account, n: s.n, scope: s.scope });
};

/** A registry holding `held` at the person's tags of those indexes, a builder over it, a hand-over and saved keys, all recorded. */
const world = (
  held: Record<number, Uint8Array>,
  way: { readonly sendFails?: boolean; readonly mayHaveSent?: boolean; readonly hangs?: boolean } = {}
) => {
  const byTag = new Map(Object.entries(held).map(([i, v]) => [tagAt(identity, NET, Number(i)), v]));
  const sent: Array<{ tx: string; call: ChainCall }> = [];
  const built: Array<{ tag: string; value: string }> = [];
  let k = {
    accounts: { acc_1: { signerId: 's', signingSecret: '', wrappingSecret: '', blinding: '', scope: 'b2'.repeat(32) } }
  } as unknown as Keyring;
  const build = (async (ask: { ask: string; tags?: string[]; tag?: string; value?: string }) => {
    if (ask.ask === 'registry-values')
      return { values: ask.tags!.map((t) => (byTag.has(t) ? base64.encode(byTag.get(t)!) : null)) };
    built.push({ tag: ask.tag!, value: ask.value! });
    return { tx: 'VFg=' };
  }) as unknown as AccountBuilding;
  const handOver: HandOver = {
    path: 'chain',
    toChain: async (tx, call) => {
      if (way.sendFails === true) throw Object.assign(new Error('the fee could not be paid'), { nothingWasSent: true });
      sent.push({ tx, call });
      if (way.mayHaveSent === true) throw new Error('the network did not answer');
      if (way.hangs === true) await new Promise<void>(() => undefined);
    }
  };
  const doors: RegistryWriteDoors = {
    identity,
    network: NET,
    registries: [REGISTRY],
    read: async () => ({ registryState: 'cw==', parameters: 'cA==' }),
    build,
    handOver,
    keyring: {
      open: () => {
        throw new Error('not opened here');
      },
      keep: async (change) => {
        k = change(k);
      }
    },
    now: () => NOW
  };
  return { doors, sent, built, mark: () => k.accounts['acc_1']?.registry };
};

describe('WHEN AN ENTRY IS OWED', () => {
  it('only for the pinned account, a seat seated now, and no entry found written for that leaf', () => {
    const leaf = 'c3'.repeat(32);
    const pin = { pinned: 'a1'.repeat(32), page: 'a1'.repeat(32) };
    /* RED WHEN: an entry is owed with no pin, or for an account other than the pinned one. */
    expect(registryEntryOwed({ leaf }, { pinned: null, page: pin.page }, [leaf])).toBe(false);
    expect(registryEntryOwed({ leaf }, { pinned: 'ff'.repeat(32), page: pin.page }, [leaf])).toBe(false);
    /* RED WHEN: a seat the chain no longer seats is owed an entry. */
    expect(registryEntryOwed({ leaf }, pin, ['dd'.repeat(32)])).toBe(false);
    expect(registryEntryOwed({ leaf }, pin, [leaf])).toBe(true);
    /* RED WHEN: a seat whose entry was found written is owed it again, or a note of a send alone counts as written. */
    expect(registryEntryOwed({ leaf, mark: { leaf, written: true } }, pin, [leaf])).toBe(false);
    expect(registryEntryOwed({ leaf, mark: { leaf, sent: { index: 0, at: 'then' } } }, pin, [leaf])).toBe(true);
    /* RED WHEN: a mark made for another leaf of the seat counts for this one. */
    expect(registryEntryOwed({ leaf, mark: { leaf: 'ee'.repeat(32), written: true } }, pin, [leaf])).toBe(true);
  });
});

describe('THE WRITE', () => {
  it("is sent once, at the lowest free tag, as one put to the network's registry, holding this seat's entry", async () => {
    const w = world({});
    /* RED WHEN: the write goes anywhere but the lowest free tag, or is not one put to the registry. */
    expect(await registryEntryWritten(w.doors, seat())).toEqual({ of: 'sent', index: 0 });
    expect(w.sent).toEqual([{ tx: 'VFg=', call: { kind: 'registry-put', contract: REGISTRY, circuit: 'put' } }]);
    expect(w.built.map((b) => b.tag)).toEqual([tagAt(identity, NET, 0)]);
    /* RED WHEN: what is written is not this seat's entry, sealed for that tag. */
    expect(openEntry(identity, NET, 0, base64.decode(w.built[0]!.value))).toMatchObject({
      label: LABEL,
      account: 'a1'.repeat(32),
      n: 0,
      scope: 'b2'.repeat(32)
    });
  });

  it('a tag taken first by anyone sends the write to the next', async () => {
    const w = world({ 0: new Uint8Array(288).fill(9), 1: valueAt(1, { account: 'f0'.repeat(32) }) });
    /* RED WHEN: a front-run tag, or this person's entry for another company, is written over or read as this seat's. */
    expect(await registryEntryWritten(w.doors, seat())).toEqual({ of: 'sent', index: 2 });
    expect(w.built.map((b) => b.tag)).toEqual([tagAt(identity, NET, 2)]);
  });
});

describe('THE MARK COMES ONLY FROM THE CHAIN', () => {
  it('a hand-over that succeeded sets no written mark, only the note of the send', async () => {
    const w = world({});
    await registryEntryWritten(w.doors, seat());
    /* RED WHEN: the hand-over's own answer marks the entry written. */
    expect(w.mark()).toEqual({ leaf: 'c3'.repeat(32), sent: { index: 0, at: new Date(NOW).toISOString() } });
  });

  it("a read finding the entry under this person's words for this account and seat sets the mark, and sends nothing", async () => {
    const w = world({ 0: new Uint8Array(288).fill(1), 1: valueAt(1) });
    /* RED WHEN: an entry found on the chain is written again, or not marked. */
    expect(await registryEntryWritten(w.doors, seat())).toEqual({ of: 'found' });
    expect(w.sent).toEqual([]);
    expect(w.mark()).toEqual({ leaf: 'c3'.repeat(32), written: true });
  });

  it('an entry opening to another account or another seat sets no mark', async () => {
    for (const other of [{ account: 'f0'.repeat(32) }, { n: 3 }, { scope: 'b3'.repeat(32) }]) {
      const w = world({ 0: valueAt(0, other) });
      /* RED WHEN: an entry naming another account or seat is taken as this seat's. */
      expect(await registryEntryWritten(w.doors, seat()), JSON.stringify(other)).toEqual({ of: 'sent', index: 1 });
      expect(w.mark()?.written).toBeUndefined();
    }
  });
});

describe('A WRITE HANDED OVER AND NOT YET FOUND', () => {
  it('holds a second write back, and stops holding it once a day old', async () => {
    const leaf = 'c3'.repeat(32);
    const fresh = world({});
    /* RED WHEN: a write sent an hour ago is sent again before a read finds it. */
    expect(
      await registryEntryWritten(
        fresh.doors,
        seat({ leaf, sent: { index: 0, at: new Date(NOW - 60 * 60_000).toISOString() } })
      )
    ).toEqual({ of: 'held', index: 0 });
    expect(fresh.sent).toEqual([]);
    const old = world({});
    /* RED WHEN: a note a day old still holds the write back for ever. */
    expect(
      await registryEntryWritten(
        old.doors,
        seat({ leaf, sent: { index: 0, at: new Date(NOW - SENT_HOLDS_MS).toISOString() } })
      )
    ).toEqual({ of: 'sent', index: 0 });
  });

  it('the note is kept before the write leaves: a write let go after its hand-over still holds the next one back', async () => {
    const w = world({}, { hangs: true });
    void registryEntryWritten(w.doors, seat());
    await new Promise((r) => setTimeout(r, 20));
    /* RED WHEN: the note is kept only after the hand-over answers, so a write stopped after it leaves none. */
    expect(w.mark()).toEqual({ leaf: 'c3'.repeat(32), sent: { index: 0, at: new Date(NOW).toISOString() } });
    const next = world({});
    /* RED WHEN: the next action within the day sends a second write past that note. */
    expect(await registryEntryWritten(next.doors, seat(w.mark()))).toEqual({ of: 'held', index: 0 });
    expect(next.sent).toEqual([]);
  });

  it('a write that may have gone keeps its note', async () => {
    const w = world({}, { mayHaveSent: true });
    expect(await registryEntryWritten(w.doors, seat())).toEqual({ of: 'owed', why: 'the network did not answer' });
    /* RED WHEN: a write that may be on its way gives its note back, so the next action sends a second. */
    expect(w.mark()?.sent?.index).toBe(0);
  });

  it('a write that fails is owed again, and refuses nothing', async () => {
    const w = world({}, { sendFails: true });
    /* RED WHEN: a failed write throws, or a write that says nothing was sent keeps a note that holds the next one back. */
    expect(await registryEntryWritten(w.doors, seat())).toEqual({ of: 'owed', why: 'the fee could not be paid' });
    expect(w.mark()).toBeUndefined();
  });
});
