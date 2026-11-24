// @vitest-environment jsdom
/*
 * The harness that counts what a screen reads is itself checked here: the company it opens the screen on holds the
 * open proposals asked for; every call the screen makes reaches the service once and is counted under its route, and
 * the wallet's asks and the chain, builder and indexer reads are counted too; and a first opening on a device new to
 * the company is counted apart from the openings after it. One screen is counted at two sizes of the same company,
 * and what it reads is pinned: the same at both sizes, each route once for the opening and the wallet asked once. The
 * Vaults screen and the home page are counted at both sizes too, and must read the same at each: every vault's tile on
 * the home page says what its vault holds, and the tiles' money is read in the same reads on four vaults as on two.
 */
import { describe, expect, it } from 'vitest';
import { aCompanyOf, openScreen, pageRouteOf, type ScreenCount } from './company-harness.test-support.js';
import { ENGLISH } from '../english.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const OPENINGS = { timeout: 170_000 };
/* The company's founding seat, whose page every screen here is opened on, and the company's own id. */
const FOUNDER = company.seats()[0]!.person;
const CO = company.fields.record;
const total = (counted: Readonly<Record<string, number>>): number => Object.values(counted).reduce((a, b) => a + b, 0);
const readsOf = (c: ScreenCount) => ({ routes: c.routes, wallet: c.wallet, asks: c.asks });
const people = (n: number): string[] => Array.from({ length: n }, (_, i) => `Person ${i}`);
const shows = (c: ScreenCount, names: readonly string[]): string[] => names.filter((name) => !c.text.includes(name));
/* The People screen opened by the founding seat's page, the second time on its device at this size: the first opening checks what is new. */
const peopleScreenOpened = async (): Promise<ScreenCount> => {
  await openScreen(company, FOUNDER, 'people');
  return openScreen(company, FOUNDER, 'people');
};

const R = '/api/accounts/:record';
/* The reads a vault's tile makes for its money: its vault records, their newest versions and proofs, and its state on the chain. */
const TILE_READS = [`POST ${R}/vault-records/read`, `POST ${R}/manifest/newest`, `POST ${R}/manifest/tree/proofs`, 'indexer vaultOnChain', 'indexer vaultsOnChain'];
/*
 * What the People screen reads, measured on this company at three people, two vendors, two vaults and one open
 * proposal, and again at twice of each: every route once for the opening (the newest versions and the records read by
 * name in the turns they are asked), and the person's wallet asked who holds the company once. The builder is asked
 * nothing about seats or proposals: a device that has checked the company before already holds what each opening and
 * each invitation's proposal make, and the chain is asked once which seats the invitations took.
 */
const PEOPLE = {
  routes: {
    [`GET ${R}`]: 1, [`GET ${R}/directory`]: 1, [`GET ${R}/manifest/tree/pending`]: 1, [`POST ${R}/manifest/tree/proofs`]: 1,
    [`POST ${R}/manifest/newest`]: 4, [`POST ${R}/records/read`]: 2, [`POST ${R}/handovers`]: 1, [`GET ${R}/runs`]: 1, [`GET ${R}/people`]: 1,
    [`GET ${R}/vaults`]: 1, [`GET ${R}/invites`]: 1, [`GET ${R}/proposals`]: 1,
  },
  wallet: { holders: 1 },
  asks: {
    'indexer invitedSeats': 1, 'onChain anchorsOnChain': 1, 'indexer roundsOnChain': 1,
  },
};
/*
 * The other screens counted, opened twice at each size, the second opening counted: the Vaults screen, and the home
 * page, whose set-up steps read the company's creation, the person's wallet with it, apart from the page's view. Each
 * draws a tile for every vault the company adopted, with what the vault holds.
 */
const SCREENS = ['vaults', 'home'] as const;
/* How often each screen asks the person's wallet who holds the company in one opening. */
const HOLDERS_ASKED: Readonly<Record<(typeof SCREENS)[number], number>> = { vaults: 1, home: 2 };
const opened = async (id: (typeof SCREENS)[number]): Promise<ScreenCount> => {
  await openScreen(company, FOUNDER, id);
  return openScreen(company, FOUNDER, id);
};

describe('A SCREEN OPENED ON A COMPANY OF A CHOSEN SIZE HAS EVERY READ IT MAKES COUNTED', OPENINGS, () => {
  let atN: ScreenCount;
  const others = new Map<string, ScreenCount>();
  const grown = new Map<string, ScreenCount>();

  it('a call is named by the route an action declares for it, or by its path with each record written as an id', () => {
    /* RED WHEN: a call to a declared route is named by its path, so the same read of two records counts as two routes. */
    expect(pageRouteOf('GET', `/api/accounts/${CO}/records/person/p1/versions`, CO)).toBe(`GET ${R}/records/:kind/:id/versions`);
    /* RED WHEN: a call no action declares is named by the record it reads, or not said to be undeclared. */
    expect(pageRouteOf('GET', `/api/accounts/${CO}/nothing/ab12`, CO)).toBe('GET /api/accounts/:id/nothing/:id (no action declares it)');
  });

  it('the company holds the open proposals asked for', () => {
    /* RED WHEN: the company is made without the open proposal asked for. */
    expect(company.openProposals()).toBe(1);
  });

  it('every call a screen makes reaches the service once and is counted under its route, and every other read is counted', async () => {
    const before = company.served();
    const first = await openScreen(company, FOUNDER, 'people');
    /* RED WHEN: the screen is not drawn, or drawn without the records it reads, so its count is of nothing. */
    expect([first.screen, shows(first, people(3))]).toEqual(['people', []]);
    /* RED WHEN: a call the screen makes is not counted, or is counted without reaching the service. */
    expect(total(first.routes)).toBe(company.served() - before);
    /* RED WHEN: the wallet's asks, or the chain, builder or indexer reads, are made without being counted against the opening. */
    expect(Math.min(total(first.wallet), first.doors.onChain, first.doors.builder, first.doors.indexer)).toBeGreaterThan(0);
  });

  it('an opening on a device that has checked the company before reads the same each time, apart from its first', async () => {
    atN = await openScreen(company, FOUNDER, 'people');
    const again = await openScreen(company, FOUNDER, 'people');
    /* RED WHEN: two openings of the same screen on the same company read differently, so no count of one can be pinned. */
    expect(readsOf(again)).toEqual(readsOf(atN));
    /* RED WHEN: the screen reads anything a second time in one opening, or asks the wallet more than once: the pin is one of each. */
    expect(readsOf(atN)).toEqual(PEOPLE);
    for (const id of SCREENS) others.set(id, await opened(id));
  });

  it('the company grows to twice the records, and no screen reads more', async () => {
    await company.growTo({ people: 6, vendors: 4, vaults: 4, proposals: 2 });
    /* RED WHEN: growing the company raises no second open proposal, so the second count runs on the first size. */
    expect(company.openProposals()).toBe(2);
    const at2N = await peopleScreenOpened();
    expect(shows(at2N, people(6))).toEqual([]);
    /* RED WHEN: any route, wallet ask or chain, builder or indexer read of the People screen grows with the people, vendors, vaults or proposals. */
    expect(readsOf(at2N)).toEqual(PEOPLE);
    /* Every screen is counted at twice the size first, so a screen that reads more does not leave the next uncounted. */
    for (const id of SCREENS) grown.set(id, await opened(id));
    for (const id of SCREENS) {
      const at2N = grown.get(id)!;
      /* RED WHEN: a read of this screen grows with the company's records: one more request, wallet ask or door read at twice the size. */
      expect({ screen: id, ...readsOf(at2N) }).toEqual({ screen: id, ...readsOf(others.get(id)!) });
      /* RED WHEN: the screen asks the person's wallet who holds the company more often in one opening than it is pinned to. */
      expect(others.get(id)!.wallet).toEqual({ holders: HOLDERS_ASKED[id] });
    }
  });

  it('the home page reads every vault tile\'s money in the reads of one opening, on four vaults as on two', () => {
    const tileReads = (c: ScreenCount) => Object.fromEntries(TILE_READS.map((read) => [read, c.routes[read] ?? c.asks[read] ?? 0]));
    const told = (c: ScreenCount) => c.text.split(ENGLISH['vaults.money.none']!).length - 1;
    /* RED WHEN: a tile does not say what its vault holds once its money is read: this company's vaults hold none of the tokens shown. */
    expect([told(others.get('home')!), told(grown.get('home')!)]).toEqual([2, 4]);
    /* RED WHEN: a vault's tile reads its own money apart from the others': its records, their newest versions and proofs, or its state on the chain, so the home page reads more with more vaults. */
    expect(tileReads(grown.get('home')!)).toEqual(tileReads(others.get('home')!));
  });
});
