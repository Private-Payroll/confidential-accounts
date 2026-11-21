// @vitest-environment jsdom
/*
 * Every action panel a company is read from reads what it is pinned to read, and the same at every size of the company: each
 * panel the page can draw on its own is drawn twice on a device that has checked the company before, the second drawing
 * counted and held to its pinned reads and to the words only that panel draws, then again after the company grows to twice
 * its people, vendors, vaults and open proposals. A panel this harness does not draw ready on its own is named with why and
 * with the screen that draws it, so no panel on the inventory is passed over unsaid. A press on a panel's button is not run
 * here: the harness answers no ask of the wallet, so what a press reads is counted nowhere and is owed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { COMPANY_VIEW_INVENTORY } from 'vaults-web-shared/company-view-inventory.js';
import { ChangeThreshold } from '../actions/change-threshold.js';
import { CommitteeChange } from '../actions/committee-change.js';
import { CreateVault } from '../actions/create-vault.js';
import { Deposit } from '../actions/deposit.js';
import { InvitePeople } from '../actions/invite.js';
import { OneOffPayment } from '../actions/one-off.js';
import { RaiseRun } from '../actions/raise-run.js';
import { RetireVault } from '../actions/retire-vault.js';
import { Signers } from '../actions/signers.js';
import { aCompanyOf, openPanel } from './company-harness.test-support.js';
import { differences, readsOf, type Reads } from './screen-counts.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const OPENINGS = { timeout: 160_000 };
const FOUNDER = company.seats()[0]!.person;

/* What the screen that shows a step hands it: where to lead the person, and what to do when it changed something, here nothing. */
const STEP_PROPS = { leadTo: () => {}, onChanged: () => {} };

/* Each panel the harness draws ready on its own, by its name on the inventory, with the properties it is given. */
const PANELS: Readonly<Record<string, () => ReactElement>> = {
  deposit: () => createElement(Deposit, { company: company.fields.record, vault: company.vaults()[0]!, ...STEP_PROPS }),
  invite: () => createElement(InvitePeople, {}),
  'one-off': () => createElement(OneOffPayment, { vault: company.vaults()[0]! }),
  'retire-vault': () => createElement(RetireVault, { vault: company.vaults()[0]! }),
  signers: () => createElement(Signers, {}),
};

/* What each of those panels reads when it is drawn on a device that has checked the company before, on the company at its first size. */
const THE_COMPANY_AND_ITS_NEWEST: Reads = {
  'route GET /api/accounts/:record': 1, 'route GET /api/accounts/:record/directory': 1, 'route POST /api/accounts/:record/manifest/newest': 1,
};
const PANEL_PINS: Readonly<Record<string, Reads>> = Object.freeze({
  deposit: THE_COMPANY_AND_ITS_NEWEST, invite: THE_COMPANY_AND_ITS_NEWEST, 'one-off': THE_COMPANY_AND_ITS_NEWEST,
  'retire-vault': THE_COMPANY_AND_ITS_NEWEST, signers: THE_COMPANY_AND_ITS_NEWEST,
});

/* The words each of those panels draws and the frame it is drawn in does not. */
const DRAWS: Readonly<Record<string, string>> = Object.freeze({
  deposit: 'Ways to put money in', invite: 'Invite', 'one-off': 'Propose payment', 'retire-vault': 'Retiring takes this vault off your company\'s list.', signers: 'Add from code',
});

/* The words a panel draws when it could not read what it needs, which a panel drawn ready does not. */
const NOT_READ = /could not be (read|loaded|checked)|did not finish|not finished being created|not set up|Checking who holds|has no vault to pay from yet/u;

/** The screen that draws a panel, by its file and the panel's name in it, so a claim of where a panel is drawn is read from the screen. */
interface DrawnBy { readonly screen: string; readonly component: string }

/* The panels drawn on their own here that show their not-read state, and why: each is still on the inventory, and its count is owed. */
const NOT_READY: Readonly<Record<string, { readonly why: string; readonly by: DrawnBy }>> = Object.freeze({
  'change-threshold': { why: 'drawn on its own it says the approvals could not be read, since the screen that draws it hands it the company\'s read', by: { screen: 'vault.tsx', component: 'ChangeThreshold' } },
  'committee-change': { why: 'drawn on its own it is still checking who holds the rules, since the screen that draws it hands it the company\'s read', by: { screen: 'super-admins.tsx', component: 'CommitteeChange' } },
  'create-vault': { why: 'drawn on its own it says the company is not finished being created, since the screen that draws it hands it the company\'s read', by: { screen: 'vaults.tsx', component: 'CreateVault' } },
  'raise-run': { why: 'drawn on its own it finds no vault to pay from, since the screen that draws it hands it the company\'s read', by: { screen: 'payroll.tsx', component: 'RaiseRun' } },
});

/* The panels not drawn here on their own, and why: each is still on the inventory, and what a press on it reads is owed. */
const NOT_DRAWN: Readonly<Record<string, { readonly why: string; readonly by: DrawnBy | null }>> = Object.freeze({
  admit: { why: 'it holds the words a person\'s panel says and draws nothing of its own', by: null },
  approve: { why: 'it is drawn on a proposal\'s row, with the row', by: { screen: 'proposals.tsx', component: 'Approve' } },
  withdraw: { why: 'it is drawn on a proposal\'s row, with the row', by: { screen: 'proposals.tsx', component: 'Withdraw' } },
  'pay-run': { why: 'it is drawn on a run\'s leg, and this company raises no runs', by: { screen: 'run.tsx', component: 'PayRun' } },
  'retry-run': { why: 'it is drawn on a run\'s leg, and this company raises no runs', by: { screen: 'run.tsx', component: 'RetryRun' } },
  'person-panel': { why: 'it is opened for a person\'s row, with the person\'s record, by a press on the people page', by: { screen: 'people.tsx', component: 'PersonPanel' } },
  'vendor-panel': { why: 'it is opened for a vendor\'s row, with the vendor\'s record, by a press on the vendors page', by: { screen: 'vendors.tsx', component: 'VendorPanel' } },
  'recovery-window': { why: 'it is drawn inside the recovery page, with its person', by: { screen: 'recovery.tsx', component: 'RecoveryWindowSection' } },
});

const PANELS_COUNTED = COMPANY_VIEW_INVENTORY.filter((p) => p.kind === 'action panel' && p.reads === 'company').map((p) => p.name);
const sourceOf = (screen: string): string => readFileSync(resolve('apps/web/src/screens', screen), 'utf8');
const counted = async (element: () => ReactElement): Promise<{ reads: Reads; text: string }> => {
  await openPanel(company, FOUNDER, element());
  const c = await openPanel(company, FOUNDER, element());
  return { reads: readsOf(c), text: c.text };
};

describe('EVERY ACTION PANEL A COMPANY IS READ FROM READS WHAT IT IS PINNED TO READ, THE SAME AT EVERY SIZE OF THE COMPANY', OPENINGS, () => {
  const atN = new Map<string, Reads>();
  let frame = '';
  /* The company is grown once, by the first panel counted at twice its size; a panel run alone by its name grows it itself. */
  let grown: Promise<void> | null = null;
  const grow = (): Promise<void> => (grown ??= company.growTo({ people: 6, vendors: 4, vaults: 4, proposals: 2 }));
  const own = (text: string): string => text.replace(frame, '');

  beforeAll(async () => {
    frame = (await openPanel(company, FOUNDER, createElement('div'))).text;
  }, 60_000);

  it('every panel on the inventory that reads a company is drawn here, or is named with why it is not and where it is drawn', () => {
    const named = [...Object.keys(PANELS), ...Object.keys(NOT_READY), ...Object.keys(NOT_DRAWN)];
    /* RED WHEN: a panel that reads a company is neither drawn here nor named as owed, so its reads are held by nothing. */
    expect(PANELS_COUNTED.filter((n) => !named.includes(n))).toEqual([]);
    /* RED WHEN: a panel named here is not one on the inventory, or is named twice. */
    expect(named.filter((n, i) => !PANELS_COUNTED.includes(n) || named.indexOf(n) !== i)).toEqual([]);
    /* RED WHEN: a panel drawn ready here has no pinned reads, or has pinned reads and is not drawn. */
    expect(Object.keys(PANEL_PINS).sort()).toEqual(Object.keys(PANELS).sort());
    expect(Object.keys(DRAWS).sort()).toEqual(Object.keys(PANELS).sort());
  });

  it('every panel not drawn ready here is drawn by the screen it names', () => {
    const claimed = [...Object.entries(NOT_READY).map(([n, c]) => [n, c.by] as const), ...Object.entries(NOT_DRAWN).map(([n, c]) => [n, c.by] as const)];
    /* RED WHEN: a panel is named as drawn by a screen whose source does not draw it, so its count is claimed to be carried by nothing. */
    expect(claimed.filter(([, by]) => by !== null && !sourceOf(by.screen).includes(`<${by.component}`)).map(([name]) => name)).toEqual([]);
  });

  for (const name of Object.keys(PANELS)) {
    it(`panel ${name} is drawn ready, and counted on the company at its first size`, async () => {
      const { reads, text } = await counted(PANELS[name]!);
      atN.set(name, reads);
      /* RED WHEN: a panel reads differently at the first size than it did when pinned, more or fewer. */
      expect(reads).toEqual(PANEL_PINS[name]);
      /* RED WHEN: a panel draws nothing but the frame, or only the words it draws when it could not read, so its count holds nothing of the panel. */
      expect(own(text)).toContain(DRAWS[name]);
      expect(own(text).match(NOT_READ)).toBeNull();
    });
  }

  for (const [name, claim] of Object.entries(NOT_READY)) {
    it(`panel ${name} is still drawn not read on its own: ${claim.why}`, async () => {
      /* RED WHEN: a panel named as not drawn ready is drawn ready, and is still named here. */
      expect(own((await counted(PANELS_NOT_READY[name]!)).text)).toMatch(NOT_READ);
    });
  }

  for (const name of Object.keys(PANELS)) {
    it(`panel ${name} reads the same at twice the company's records`, async () => {
      /* RED WHEN: the first size of this panel was not counted before it, so there is nothing to hold its growth to. */
      expect(atN.has(name), `panel ${name} is counted at its first size before it is counted at twice it`).toBe(true);
      await grow();
      /* RED WHEN: any route, wallet ask or chain, builder or indexer read of this panel grows with the company's people, vendors, vaults or proposals. */
      expect(differences(name, atN.get(name)!, (await counted(PANELS[name]!)).reads, ['at the first size', 'at twice it'])).toEqual([]);
    });
  }
});

/* The panels that are drawn not read, as the screens that draw them give them. */
const PANELS_NOT_READY: Readonly<Record<string, () => ReactElement>> = {
  'change-threshold': () => createElement(ChangeThreshold, {}),
  'committee-change': () => createElement(CommitteeChange, {}),
  'create-vault': () => createElement(CreateVault, STEP_PROPS),
  'raise-run': () => createElement(RaiseRun, {}),
};
