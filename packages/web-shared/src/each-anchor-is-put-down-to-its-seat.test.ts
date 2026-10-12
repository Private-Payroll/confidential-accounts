/**
 * **EACH SEAT FILES THE OPENING OF ITS OWN LEAF, AND A MEMBER'S DEVICE MAPS
 * EVERY TAG THE ACCOUNT WRITES TO ITS SEAT.** An opening is believed only
 * where the account's own `signerLeaf` over it is the seat's leaf, so the
 * service serving another seat's, or one that is no opening, maps nothing.
 * The one to read first is "A SEAT'S OWN OPENING".
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import { newSigningKeypair } from '../../../src/core/crypto.js';
import { openSeatOpening, sealSeatOpening } from '../../../src/core/seat-opening.js';
import { fromCompanyWire, toCompanyWire, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { anchorFunctions } from '../../../src/testing/record-tree-double.js';
import { ownOpeningFiled, tagSeatsHere, type SeatOpeningsDoors } from './seat-openings-here.js';
import type { Filed } from './record-entered-here.js';

const COMPANY = 'acct_openings';
const ACCOUNT = 'ac'.repeat(32);
const VIEWING = '5e'.repeat(32) as Hex;
const materialOf = (n: number) => ({
  signingSecret: newSigningKeypair().secret, blinding: n.toString(16).padStart(2, '0').repeat(32) as Hex, scope: '33'.repeat(32) as Hex,
});

/** The service's company records, kept in memory: a version filed under its kind and id, and the newest served. */
const aService = () => {
  const filed = new Map<string, SealedCompanyRecord[]>();
  const api = async (path: string, init?: RequestInit): Promise<any> => {
    const m = /\/records\/opening\/([0-9a-f]+)(?:\/(\d+))?$/u.exec(path);
    if (m === null) throw new Error(`no route ${path}`);
    const seat = m[1]!;
    if (init?.method === 'PUT') {
      const rec = fromCompanyWire(JSON.parse(String(init.body)), { company: COMPANY, kind: 'opening', id: seat }).sealed;
      filed.set(seat, [...(filed.get(seat) ?? []), rec]);
      return { kind: 'opening', id: seat };
    }
    const all = filed.get(seat) ?? [];
    return { kind: 'opening', id: seat, filed: all.length === 0 ? null : toCompanyWire(all[all.length - 1]!) };
  };
  const doors: SeatOpeningsDoors = { accountId: COMPANY, account: ACCOUNT, viewingKey: VIEWING, keyEpoch: 0, api, builder: anchorFunctions };
  return { filed, doors };
};

const leafOf = async (m: ReturnType<typeof materialOf>) => (await anchorFunctions.seatOpenings({ account: ACCOUNT, openings: [], own: m })).own!.leaf;

describe('EVERY TAG THE ACCOUNT WRITES, PUT DOWN TO ITS SEAT', () => {
  it('A SEAT\'S OWN OPENING: FILED ONCE UNDER ITS OWN LEAF, SEALED, ENTERED; THEN EVERY MEMBER MAPS ITS TAG TO IT', async () => {
    const { filed, doors } = aService();
    const m = materialOf(1);
    const entered: Filed[] = [];
    const own = { ...doors, material: m, entered: { enter: async (f: readonly Filed[]) => { entered.push(...f); } } };
    /* RED WHEN: a seat's device does not file its opening - its anchors could be put down to no seat. */
    expect(await ownOpeningFiled(own)).toBe(true);
    const seat = await leafOf(m);
    expect([...filed.keys()]).toEqual([seat]);
    /* RED WHEN: the opening is filed unsealed, or sealed under anything but the company's roster key. */
    expect(JSON.stringify(filed.get(seat)![0]!.sealed)).not.toContain(m.blinding);
    expect(openSeatOpening(filed.get(seat)![0]!, VIEWING)).toMatchObject({ scope: m.scope, blinding: m.blinding });
    /* RED WHEN: the opening is not entered in the company's records - it would never be anchored. */
    expect(entered).toHaveLength(1);
    /* RED WHEN: it is filed again while one that opens the seat's leaf is served. */
    expect(await ownOpeningFiled(own)).toBe(false);
    expect(filed.get(seat)).toHaveLength(1);
    /* RED WHEN: a member does not map the seat's tag, as the account's call works it out, to the seat. */
    const tag = await anchorFunctions.anchorTag({ account: ACCOUNT, material: m });
    expect([...(await tagSeatsHere(doors, [seat])).entries()]).toEqual([[tag, seat]]);
  });

  it('AN OPENING THAT DOES NOT OPEN ITS SEAT\'S LEAF, OR IS NO OPENING, MAPS NOTHING', async () => {
    const { filed, doors } = aService();
    const a = materialOf(1);
    const b = materialOf(2);
    await ownOpeningFiled({ ...doors, material: a, entered: { enter: async () => {} } });
    const seatA = await leafOf(a);
    const seatB = await leafOf(b);
    /* B's record holds A's opening. RED WHEN: an opening is believed for a seat whose leaf it does not open. */
    filed.set(seatB, [sealSeatOpening(COMPANY, seatB, openSeatOpening(filed.get(seatA)![0]!, VIEWING), 1, 0, VIEWING)]);
    expect([...(await tagSeatsHere(doors, [seatB])).values()]).toEqual([]);
    /* RED WHEN: an opening sealed under another company's key is read as this one's, or stops the read. */
    expect([...(await tagSeatsHere({ ...doors, viewingKey: '6e'.repeat(32) as Hex }, [seatA])).values()]).toEqual([]);
    /* RED WHEN: a seat with no opening served stops the read of the others. */
    expect([...(await tagSeatsHere(doors, ['77'.repeat(32), seatA])).values()]).toEqual([seatA]);
  });
});
