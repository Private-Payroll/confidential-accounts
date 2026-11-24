// @vitest-environment jsdom
/*
 * Every action panel a company is read from reads what it is pinned to read, and the same at every size of the company: each
 * panel the page can draw on its own is drawn twice on a device that has checked the company before, the second drawing
 * counted and held to its pinned reads and to the words only that panel draws, then again after the company grows its people,
 * vendors, vaults and open proposals each by a number of its own. A panel the page hands the company's read is opened inside the screen that
 * draws it, as a person opens it, and a press on it is run (an action through the wallet's own
 * steps over the company, a change of the committee through a wallet that signs it); its opening and its press are each counted and
 * held the same way. A panel this harness does not draw on its own is named with why and with the screen that draws it, so none on the
 * inventory is passed over unsaid. Every answer to a count carries what the service holds and what was asked, and the kinds of record
 * a read of an opening asks grown are the first size's number, or one more for each one more of what the kind grows with; a press asks the first size's kinds. The branches of a page that the stand-ins' usual answers do not reach are counted the same way.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aCompanyOf, openPanel, SERVED_CHOICES, type ScreenCount } from './company-harness.test-support.js';
import { createElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { COMPANY_VIEW_INVENTORY } from 'vaults-web-shared/company-view-inventory.js';
import { differences, readsOf, type Reads } from './screen-counts.test-support.js';
import { PANEL_PINS, SCREEN_PANEL_PINS, SCREEN_PINS } from './screen-count-pins.test-support.js';
import { tableHeld, tableSource, type PinnedOpening } from './screen-pins-writer.test-support.js';
import type { Called } from './screen-carried.test-support.js';
import {
  branchesOn, DRAWS, founderOf, heldToTheRule, inItsScreenOn, NOT_READ, panelCountsOn, panelsOn, type Branch, type DrawnBy,
} from './panels-counted.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const OPENINGS = { timeout: 160_000 };
const PANELS_ABOUT = 'The action panels drawn ready on their own, each drawn twice on a device that has checked the company, the second drawing counted, at the company\'s first size.';
const OPENINGS_ABOUT = 'The action panels opened inside their screen, and pressed where the harness runs the press, at the company\'s first size.';
/* The company is grown once, by the first thing counted grown; a test run alone by its name grows it itself. */
let grown: Promise<void> | null = null;
const growOnce = (): Promise<void> => (grown ??= company.growTo({ people: 7, vendors: 3, vaults: 5, proposals: 3 }));
const FOUNDER = founderOf(company);
const PANELS = panelsOn(company);
const IN_ITS_SCREEN = inItsScreenOn(company);
const BRANCHES = branchesOn(company);
const { counted, countsInItsScreen, branchCount, askedAtTwice, pressAskedAtTwice } = panelCountsOn(company);

/*
 * What is known of the pressed reads of a panel opened inside its screen: `about` says what its pin is, and `high` names the reads that are
 * known to be high. A pin is a measurement, so these are budgets to bring down, not normal figures.
 */
const PRESS_NOTES: Readonly<Record<string, { readonly about: string; readonly high: readonly string[] }>> = Object.freeze({
  'change-threshold': {
    about: 'The pressed reads are a measurement, flat at the company grown, and several are high: one press reads the account, the directory, the newest versions and the proofs many times over. They are held where they are, as a budget to lower.',
    high: [
      'route GET /api/accounts/:record', 'route GET /api/accounts/:record/directory', 'route POST /api/accounts/:record/manifest/newest',
      'route POST /api/accounts/:record/manifest/tree/proofs', 'route POST /api/accounts/:record/records/read', 'onChain anchorsOnChain', 'indexer roundsOnChain',
    ],
  },
});

/* The panels not drawn here on their own, and why: each is still on the inventory, and is counted where it says, or what a press on it reads is owed. */
const NOT_DRAWN: Readonly<Record<string, { readonly why: string; readonly by: DrawnBy | null }>> = Object.freeze({
  admit: { why: 'it holds the words a person\'s panel says and draws nothing of its own', by: null },
  approve: { why: 'it is drawn on a proposal\'s row, with the row', by: { screen: 'proposals.tsx', component: 'Approve' } },
  withdraw: { why: 'it is drawn on a proposal\'s row, with the row', by: { screen: 'proposals.tsx', component: 'Withdraw' } },
  'pay-run': { why: 'it is drawn on a run\'s leg, and this company raises no runs', by: { screen: 'run.tsx', component: 'PayRun' } },
  'retry-run': { why: 'it is drawn on a run\'s leg, and this company raises no runs', by: { screen: 'run.tsx', component: 'RetryRun' } },
  'person-panel': { why: 'it is opened for a person\'s row, with the person\'s record, by a press on the people page', by: { screen: 'people.tsx', component: 'PersonPanel' } },
  'vendor-panel': { why: 'it is opened for a vendor\'s row, with the vendor\'s record, by a press on the vendors page', by: { screen: 'vendors.tsx', component: 'VendorPanel' } },
  'recovery-window': { why: 'it is drawn inside the recovery page, with its person', by: { screen: 'recovery.tsx', component: 'RecoveryWindowSection' } },
  'raise-run': {
    why: 'it is opened and pressed on a company of its own, in every-panel-reads-once-of-a-run.test.tsx: a run is drawn only when every person on the roster is admitted',
    by: { screen: 'payroll.tsx', component: 'RaiseRun' },
  },
});

const PANELS_COUNTED = COMPANY_VIEW_INVENTORY.filter((p) => p.kind === 'action panel' && p.reads === 'company').map((p) => p.name);
const sourceOf = (screen: string): string => readFileSync(resolve('apps/web/src/screens', screen), 'utf8');

describe('EVERY ACTION PANEL A COMPANY IS READ FROM READS WHAT IT IS PINNED TO READ, THE SAME AT EVERY SIZE OF THE COMPANY', OPENINGS, () => {
  const atN = new Map<string, Reads>();
  const panelCallsAtN = new Map<string, readonly Called[]>();
  /* What this run measured of each opening inside a screen, for the pins writer. */
  const openings = new Map<string, PinnedOpening>();
  let frame = '';
  const grow = growOnce;
  const own = (text: string): string => text.replace(frame, '');

  beforeAll(async () => {
    frame = (await openPanel(company, FOUNDER, createElement('div'))).text;
  }, 60_000);

  it('every panel on the inventory that reads a company is drawn here, or is named with why it is not and where it is drawn', () => {
    const named = [...Object.keys(PANELS), ...Object.keys(IN_ITS_SCREEN), ...Object.keys(NOT_DRAWN)];
    /* RED WHEN: a panel that reads a company is neither drawn here nor named as owed, so its reads are held by nothing. */
    expect(PANELS_COUNTED.filter((n) => !named.includes(n))).toEqual([]);
    /* RED WHEN: a panel named here is not one on the inventory, or is named twice. */
    expect(named.filter((n, i) => !PANELS_COUNTED.includes(n) || named.indexOf(n) !== i)).toEqual([]);
    /* RED WHEN: a panel drawn ready here has no pinned reads, or has pinned reads and is not drawn. */
    expect(Object.keys(PANEL_PINS).sort()).toEqual(Object.keys(PANELS).sort());
    expect(Object.keys(DRAWS).sort()).toEqual(Object.keys(PANELS).sort());
    /* RED WHEN: a panel opened in its screen has no pinned opening, or one pinned and not opened, or a press with no pinned reads. */
    expect(Object.keys(SCREEN_PANEL_PINS).sort()).toEqual(Object.keys(IN_ITS_SCREEN).sort());
    expect(Object.keys(SCREEN_PANEL_PINS).filter((n) => SCREEN_PANEL_PINS[n]!.pressed === undefined)).toEqual([]);
    /* RED WHEN: a read named as known high is not one the press is pinned to make, or a pin that names some says nothing of why. */
    expect(Object.entries(PRESS_NOTES).flatMap(([n, p]) => p.high.filter((r) => SCREEN_PANEL_PINS[n]?.pressed?.[r] === undefined).map((r) => `${n}: ${r}`))).toEqual([]);
    expect(Object.keys(PRESS_NOTES).filter((n) => !Object.hasOwn(SCREEN_PANEL_PINS, n))).toEqual([]);
  });

  it('every panel not drawn on its own here is drawn by the screen it names', () => {
    const claimed = [...Object.entries(IN_ITS_SCREEN).map(([n, c]) => [n, c.by] as const), ...Object.entries(NOT_DRAWN).map(([n, c]) => [n, c.by] as const)];
    /* RED WHEN: a panel is named as drawn by a screen whose source does not draw it, so its count is claimed to be carried by nothing. */
    expect(claimed.filter(([, by]) => by !== null && !sourceOf(by.screen).includes(`<${by.component}`)).map(([name]) => name)).toEqual([]);
  });

  for (const name of Object.keys(PANELS)) {
    it(`panel ${name} is drawn ready, and counted on the company at its first size`, async () => {
      const { reads, text, calls } = await counted(PANELS[name]!);
      atN.set(name, reads);
      panelCallsAtN.set(name, calls);
      /* RED WHEN: a panel reads differently at the first size than it did when pinned, more or fewer. */
      expect(reads).toEqual(PANEL_PINS[name]);
      /* RED WHEN: a panel draws nothing but the frame, or only the words it draws when it could not read, so its count holds nothing of the panel. */
      expect(own(text)).toContain(DRAWS[name]);
      expect(own(text).match(NOT_READ)).toBeNull();
      /* RED WHEN: an answer to this panel carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked or other than every version filed of a record read whole. */
      expect(heldToTheRule(name, { calls })).toEqual([]);
    });
  }

  const openedAtN = new Map<string, ScreenCount>();
  const pressedAtN = new Map<string, ScreenCount>();
  for (const name of Object.keys(IN_ITS_SCREEN)) {
    it(`panel ${name} is opened inside its screen, drawn ready, and counted on the company at its first size`, async () => {
      const c = IN_ITS_SCREEN[name]!;
      const { opened, pressed: pressedCount } = await countsInItsScreen(name);
      openedAtN.set(name, opened);
      openings.set(name, { opened: readsOf(opened), pressed: readsOf(pressedCount) });
      /* RED WHEN: the panel opened in its screen reads differently at the first size than it did when pinned, more or fewer. */
      expect(readsOf(opened)).toEqual(SCREEN_PANEL_PINS[name]?.opened);
      /* RED WHEN: the panel opened in its screen shows the words it shows when it could not read, or not the words only it draws. */
      expect(opened.text).toContain(c.draws);
      expect(opened.text.match(NOT_READ)).toBeNull();
      /* RED WHEN: an answer to the panel's opening or to a press on it carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked or other than every version filed of a record read whole. */
      expect(heldToTheRule(`${name} opening`, opened)).toEqual([]);
      expect(heldToTheRule(`${name} press`, pressedCount)).toEqual([]);
      pressedAtN.set(name, pressedCount);
      /* RED WHEN: a press on the panel reads differently at the first size than it did when pinned, more or fewer, in the page or in the wallet's steps. */
      expect(readsOf(pressedCount)).toEqual(SCREEN_PANEL_PINS[name]?.pressed);
    });
  }

  for (const name of Object.keys(PANELS)) {
    it(`panel ${name} reads the same at the company grown`, async () => {
      /* RED WHEN: the first size of this panel was not counted before it, so there is nothing to hold its growth to. */
      expect(atN.has(name), `panel ${name} is counted at its first size before it is counted grown`).toBe(true);
      await grow();
      /* RED WHEN: any route, wallet ask or chain, builder or indexer read of this panel grows with the company's people, vendors, vaults or proposals. */
      const now = await counted(PANELS[name]!);
      expect(differences(name, atN.get(name)!, now.reads, ['at the first size', 'grown'])).toEqual([]);
      /* RED WHEN: a read of this panel asks of one kind of record other than the same number it asked at the first size or one more for each one more of what its kind grows with (`PAGE_ASKED_GROWS_WITH`), or asks a kind it did not, at the company grown. */
      expect(askedAtTwice(name, { calls: panelCallsAtN.get(name)! }, now)).toEqual([]);
      /* RED WHEN: at the company grown, an answer to this panel carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
      expect(heldToTheRule(name, now)).toEqual([]);
    });
  }
  for (const name of Object.keys(IN_ITS_SCREEN)) {
    it(`panel ${name}, opened inside its screen and pressed, reads the same at the company grown`, async () => {
      /* RED WHEN: the first size of this panel was not counted before it, so there is nothing to hold its growth to. */
      expect(openedAtN.has(name), `panel ${name} is counted at its first size before it is counted grown`).toBe(true);
      await grow();
      const { opened, pressed: pressedCount } = await countsInItsScreen(name);
      /* RED WHEN: any route, wallet ask or chain, builder or indexer read of the panel's opening or of a press on it grows with the company's people, vendors, vaults or proposals. */
      expect(differences(name, readsOf(openedAtN.get(name)!), readsOf(opened), ['at the first size', 'grown'])).toEqual([]);
      expect(differences(`${name} press`, readsOf(pressedAtN.get(name)!), readsOf(pressedCount), ['at the first size', 'grown'])).toEqual([]);
      /* RED WHEN: a read of the panel's opening asks of one kind of record other than the same number it asked at the first size or one more for each one more of what its kind grows with (`PAGE_ASKED_GROWS_WITH`), or asks a kind it did not, at the company grown. */
      expect(askedAtTwice(`${name} opening`, openedAtN.get(name)!, opened)).toEqual([]);
      /* RED WHEN: a read of a press on the panel asks a kind of record at the company grown that it did not ask at the first size, or does not ask one it did. */
      expect(pressAskedAtTwice(`${name} press`, pressedAtN.get(name)!, pressedCount)).toEqual([]);
      /* RED WHEN: at the company grown, an answer to the panel's opening or to a press on it carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
      expect(heldToTheRule(`${name} opening`, opened)).toEqual([]);
      expect(heldToTheRule(`${name} press`, pressedCount)).toEqual([]);
    });
  }

  it('the pins of the panels this run measures are the ones the pins writer writes from it', () => {
    const tables = [
      { table: { name: 'PANEL_PINS', about: PANELS_ABOUT, of: 'reads', rows: Object.fromEntries(atN) } as const, every: Object.keys(PANELS) },
      { table: { name: 'SCREEN_PANEL_PINS', about: OPENINGS_ABOUT, of: 'openings', rows: Object.fromEntries(openings) } as const, every: Object.keys(IN_ITS_SCREEN) },
    ];
    /* RED WHEN: a pin of a panel counted here is not what this run measured, or the pins file was changed by hand away from what its writer writes. */
    for (const { table, every } of tables) expect(tableHeld(table, every.every((n) => Object.hasOwn(table.rows, n))), table.name).toBe(tableSource(table));
  });
});

/* Each answer other than the usual one that a stand-in can be turned to, as a branch names it. */
const TURNED = Object.entries(SERVED_CHOICES).flatMap(([k, choices]) => choices.slice(1).map((v) => `${k}=${v}`));
/* What a branch (`branchesOn`) is held to: the page's pinned reads with what the branch `differs` by. */
const expectedOf = (b: Branch): Reads => Object.fromEntries(Object.entries({ ...SCREEN_PINS[b.page], ...b.differs }).filter(([, n]) => n !== 0));

describe('EVERY BRANCH THE STAND-INS CAN TAKE IS COUNTED ON ITS PAGE, THE SAME AT EVERY SIZE OF THE COMPANY', OPENINGS, () => {
  const atN = new Map<string, Reads>();
  const callsAtN = new Map<string, readonly Called[]>();
  const grow = growOnce;

  it('every answer a stand-in can be turned to is taken by a branch counted here', () => {
    const turned = Object.values(BRANCHES).flatMap((b) => Object.entries(b.served).map(([k, v]) => `${k}=${String(v)}`));
    /* RED WHEN: a stand-in can be turned to an answer that no page here is counted under. */
    expect(TURNED.filter((t) => !turned.includes(t))).toEqual([]);
  });

  for (const name of Object.keys(BRANCHES)) {
    it(`${name}, is counted on the company at its first size`, async () => {
      const b = BRANCHES[name]!;
      const { reads, text, calls } = await branchCount(b);
      atN.set(name, reads);
      callsAtN.set(name, calls);
      /* RED WHEN: the page does not draw what only the branch draws, so the count is of the usual page. */
      expect(text).toMatch(b.shows);
      /* RED WHEN: the page reads differently under the branch than it did when pinned, more or fewer. */
      expect(reads).toEqual(expectedOf(b));
      /* RED WHEN: an answer to the page under the branch carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked. */
      expect(heldToTheRule(name, { calls })).toEqual([]);
    });
  }
  for (const name of Object.keys(BRANCHES)) {
    it(`${name}, reads the same at the company grown`, async () => {
      /* RED WHEN: the first size of this branch was not counted before it, so there is nothing to hold its growth to. */
      expect(atN.has(name), `${name} is counted at its first size before it is counted grown`).toBe(true);
      await grow();
      const { reads, text, calls } = await branchCount(BRANCHES[name]!);
      expect(text).toMatch(BRANCHES[name]!.shows);
      /* RED WHEN: any read of the page under the branch grows with the company's people, vendors, vaults or proposals. */
      expect(differences(name, atN.get(name)!, reads, ['at the first size', 'grown'])).toEqual([]);
      /* RED WHEN: a read of the page under the branch asks of one kind of record other than the same number it asked at the first size or one more for each one more of what its kind grows with (`PAGE_ASKED_GROWS_WITH`), or asks a kind it did not, at the company grown. */
      expect(askedAtTwice(name, { calls: callsAtN.get(name)! }, { calls })).toEqual([]);
      /* RED WHEN: at the company grown, an answer to the page under the branch carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
      expect(heldToTheRule(name, { calls })).toEqual([]);
    });
  }
});
