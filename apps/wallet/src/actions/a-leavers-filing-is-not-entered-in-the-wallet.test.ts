import { describe, expect, it, vi } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';

/*
 * **WHAT A SEAT WHOSE REMOVAL IS APPROVED FILES IS NOT ENTERED IN THE COMPANY'S RECORDS FROM ITS OWN WALLET.** Every
 * act's entries go through one door (`enteredFor`), which reads who is leaving once for the act: a removal of this
 * seat approved on the chain at the seat bar stops the entry before it is sent; a removal only raised stops nobody; a
 * read that cannot be made refuses with what clears it; a proposal this wallet cannot open is passed over. The listing
 * and the opening of the company's proposals stand in here; the reads and the door are the wallet's own.
 */

const t = vi.hoisted(() => ({ opens: 'removal' as 'removal' | 'fails', opened: 0 }));
vi.mock('../../../../packages/web-shared/src/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-page-doors.js')>()),
  listedHere: (_dir: unknown, _kind: unknown, served: unknown) => served,
}));
vi.mock('../../../../packages/web-shared/src/run-rebuilt-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/run-rebuilt-here.js')>()),
  standingOnChainHere: async (_records: unknown, listed: unknown) => listed,
}));
vi.mock('../../../../packages/web-shared/src/round-opened-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/round-opened-here.js')>()),
  openTheRoundHere: async (...a: unknown[]) => {
    t.opened += 1;
    if (t.opens === 'fails') throw new Error('this proposal is sealed under a company key this wallet does not hold');
    /* The removal's filer is judged on the directory the read is given, as the real opening judges it: a raiser whose records key is not attested there is refused. */
    const here = await (a[5] as { directory: () => Promise<{ another?: ReadonlySet<string> }> }).directory();
    if (here.another?.has(RAISER)) throw new Error('This device does not believe the company\'s record of this proposal (it is signed by a seat whose own wallet has not attested the records key its directory entry names). Do not act on it.');
    return { chainId: 'c1'.repeat(32), governance: { kind: 'remove-signer', leaf: LEAF } };
  },
}));

const { enteredFor } = await import('./company-reach.js');
const { leavingForTheAnchor } = await import('./leaving-read-in-the-wallet.js');
const { FiledNotEntered } = await import('../../../../packages/web-shared/src/record-entered-here.js');
const { RosterNotBelieved } = await import('../../../../packages/web-shared/src/roster-here.js');

const LEAF = 'e1'.repeat(32);
const RAISER = 'e2'.repeat(32);
const SECRET = '01'.repeat(32) as Hex;
const MINE = signingPublicKeyOf(SECRET).toLowerCase();
const ENTRY = { store: 'company', kind: 'person', id: 'per_1', version: 1, digest: 'ab'.repeat(32) } as const;

/** A company of two seats, this one at `LEAF`; its removal holds `approvals`, and the seat bar is `bar` (absent: unread). */
const companyOf = (o: { readonly approvals: number; readonly bar?: number; readonly roster?: () => Promise<unknown>; readonly notAttested?: true }) => {
  const sent: string[] = [];
  const api = async (path: string, init?: RequestInit) => {
    if (path === '/api/accounts/acc_1/proposals') return [{ id: 'prp_9', accountId: 'acc_1', status: 'open' }];
    if (init?.method === 'POST') sent.push(path);
    return null;
  };
  const directory = async () => ({
    dir: { seats: [{ seat: LEAF, signingKey: MINE, retired: null }, { seat: 'e2'.repeat(32), signingKey: 'ff'.repeat(32), retired: null }] },
    holders: { seats: [LEAF, 'e2'.repeat(32)], ...(o.bar === undefined ? {} : { seatBar: o.bar }) },
    records: { history: new Map(), notYetAnchored: [] },
    another: new Set(o.notAttested === true ? [RAISER] : []),
  });
  const r = {
    accountId: 'acc_1', label: drawCompanyLabel(), account: 'c0'.repeat(32), api,
    seat: { signerId: 's1', signingSecret: SECRET, wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) },
    companyKeys: { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32) },
    judges: {
      directoryHereFor: (...a: unknown[]) => async () => { await (a[4] as () => Promise<unknown>)(); return directory(); },
      leavesFor: () => async () => [],
    },
    roster: o.roster ?? (async () => ({ signers: [] })),
    builder: { roundsOnChain: async () => ({ ['c1'.repeat(32)]: { held: 'open', approvals: o.approvals, raisedAt: 1 } }) },
    chain: { indexer: {} },
  } as never;
  return { r, api, sent };
};

describe('A SIGNER ON THEIR WAY OUT ENTERS NOTHING MORE FROM THEIR OWN WALLET', () => {
  it('a removal of this seat approved at the seat bar stops the entry before it is sent', async () => {
    t.opens = 'removal';
    const c = companyOf({ approvals: 2, bar: 2 });
    const entered = enteredFor(c.r).enter([ENTRY]);
    /* RED WHEN: a seat whose removal is approved still enters what it files, so a staying device may anchor it. */
    await expect(entered).rejects.toBeInstanceOf(FiledNotEntered);
    await expect(enteredFor(c.r).enter([ENTRY])).rejects.toThrow(/removal of this signer's seat is approved/u);
    /* RED WHEN: the entry of a leaver's filing still reaches the service. */
    expect(c.sent).toEqual([]);
  });

  it('a removal only raised, short of the seat bar, stops nobody', async () => {
    t.opens = 'removal';
    const c = companyOf({ approvals: 1, bar: 2 });
    await enteredFor(c.r).enter([ENTRY]);
    /* RED WHEN: a removal one signer raised and nobody approved stops the seat it names from entering anything. */
    expect(c.sent).toEqual(['/api/accounts/acc_1/manifest/entries']);
  });

  it('who is leaving read without the seat bar refuses the entry and says to read the chain again, sending nothing', async () => {
    t.opens = 'removal';
    const c = companyOf({ approvals: 1 });
    /* RED WHEN: an unread seat bar is read as every raised removal approved, or as nobody leaving. */
    await expect(enteredFor(c.r).enter([ENTRY])).rejects.toThrow(/Read the chain again and do this again/u);
    expect(c.sent).toEqual([]);
  });

  it('a proposal this wallet cannot open stops no entry once the seat bar is read', async () => {
    t.opens = 'fails';
    const c = companyOf({ approvals: 2, bar: 2 });
    await enteredFor(c.r).enter([ENTRY]);
    /* RED WHEN: one proposal nobody here can open holds back every entry of every act in this wallet. */
    expect(c.sent).toEqual(['/api/accounts/acc_1/manifest/entries']);
  });

  it('a roster this seat filed and has not yet entered is entered: its own entry is never held up by the read it would answer', async () => {
    t.opens = 'removal';
    const c = companyOf({ approvals: 1, bar: 2, roster: async () => { throw new RosterNotBelieved('no entry in the company\'s records names it'); } });
    await enteredFor(c.r).enter([ENTRY]);
    /* RED WHEN: a roster filed and not yet entered can never be entered, because reading who is leaving needs the roster believed first. */
    expect(c.sent).toEqual(['/api/accounts/acc_1/manifest/entries']);
  });

  it('a read of who is leaving that fails for any other reason refuses the entry with what clears it, sending nothing', async () => {
    t.opens = 'removal';
    const c = companyOf({ approvals: 1, bar: 2, roster: async () => { throw new Error('the service did not answer'); } });
    /* RED WHEN: a failed read reaches the act as a bare error, so the page cannot say the record was filed and what to do. */
    await expect(enteredFor(c.r).enter([ENTRY])).rejects.toBeInstanceOf(FiledNotEntered);
    expect(c.sent).toEqual([]);
  });

  it('a removal approved at the seat bar stops the leaver even while the raiser\'s records key is not attested to this wallet', async () => {
    t.opens = 'removal';
    const c = companyOf({ approvals: 2, bar: 2, notAttested: true, roster: async () => { throw new RosterNotBelieved('a seat the chain holds has no entry'); } });
    /* RED WHEN: a wallet that does not believe the roster reads an approved removal it can open as one it cannot, and lets the leaver enter. */
    await expect(enteredFor(c.r).enter([ENTRY])).rejects.toThrow(/removal of this signer's seat is approved/u);
    expect(c.sent).toEqual([]);
  });

  it('a read refused for want of who is leaving promises entry only to a seat that is not among the leavers', async () => {
    t.opens = 'removal';
    const c = companyOf({ approvals: 1 });
    /* RED WHEN: the refusal promises the entry on a second read even to a seat whose own removal is approved. */
    await expect(enteredFor(c.r).enter([ENTRY])).rejects.toThrow(/unless your own seat is among those leaving/u);
  });

  it('who is leaving is read once for each reach of the company, however many entries the act makes', async () => {
    t.opens = 'removal';
    const c = companyOf({ approvals: 1, bar: 2 });
    t.opened = 0;
    await enteredFor(c.r).enter([ENTRY]);
    await enteredFor(c.r).enter([ENTRY]);
    /* RED WHEN: every entry of one act reads and opens every open proposal again. */
    expect(t.opened).toBe(1);
  });
});

describe('THE ANCHOR READS WHO IS LEAVING ON THE WALLET\'S OWN READS', () => {
  it('names the approved leaver with its boundary, and when it cannot read who is leaving binds nobody new and says so', async () => {
    t.opens = 'removal';
    const approved = companyOf({ approvals: 2, bar: 2 });
    const unread: string[] = [];
    /* RED WHEN: the anchor in the wallet is not told of an approved removal, so it anchors what the leaver files after it. */
    expect([...(await leavingForTheAnchor(approved.r, approved.api as never, '11'.repeat(32), (why) => unread.push(why))()).keys()]).toEqual([MINE]);
    const notRead = companyOf({ approvals: 2 });
    expect((await leavingForTheAnchor(notRead.r, notRead.api as never, '11'.repeat(32), (why) => unread.push(why))()).size).toBe(0);
    /* RED WHEN: who is leaving goes unread and the act still reads as done in full. */
    expect(unread).toEqual([expect.stringMatching(/seat bar|approvals a change of who is seated needs/u)]);
  });

  it('a proposal it cannot open is passed over for the anchor and said, so the upkeep never reads as done over it', async () => {
    t.opens = 'fails';
    const c = companyOf({ approvals: 2, bar: 2 });
    const unread: string[] = [];
    expect((await leavingForTheAnchor(c.r, c.api as never, '11'.repeat(32), (why) => unread.push(why))()).size).toBe(0);
    /* RED WHEN: the anchor binds over a removal it could not read and the upkeep says nothing of it. */
    expect(unread).toEqual([expect.stringMatching(/proposal prp_9 did not open on this device/u)]);
  });
});
