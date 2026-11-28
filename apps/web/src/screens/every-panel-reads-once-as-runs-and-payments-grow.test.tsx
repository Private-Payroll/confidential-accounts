// @vitest-environment jsdom
/*
 * Every action panel a company is read from, every panel opened inside its screen and pressed there, and every branch of a page
 * the stand-ins' usual answers do not reach, reads the same however many runs, paid runs, one-off payments and spending
 * policies the company holds: each is counted on a company with a run raised and paid, a one-off payment open and a spending
 * policy set, the second of two openings on a device that has checked the company before, then again after the company holds
 * more of each, each by a number of its own. Every read counts the same at both; each kind of record a read of a panel, an
 * opening or a branch asks is asked the same number of times or one more for each one more of what the kind grows with, as
 * its page holds it (`PAGE_ASKED_GROWS_WITH`); a press asks the first size's kinds; every answer carries what the service holds
 * and what was asked. The panels and branches are the ones every-panel-reads-once.test.tsx counts as the company's people,
 * vendors, vaults and proposals grow.
 */
import { createElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { aCompanyOf, openPanel, type ScreenCount } from './company-harness.test-support.js';
import { differences, MONEY_FIRST, MONEY_GROWN, readsOf, type Reads } from './screen-counts.test-support.js';
import type { Called } from './screen-carried.test-support.js';
import {
  branchesOn,
  DRAWS,
  founderOf,
  heldToTheRule,
  inItsScreenOn,
  NOT_READ,
  panelCountsOn,
  panelsOn
} from './panels-counted.test-support.js';

const company = aCompanyOf(MONEY_FIRST);
const OPENINGS = { timeout: 160_000 };
const LABELS = ['at the first size', 'grown'] as const;
const PANELS = panelsOn(company);
const IN_ITS_SCREEN = inItsScreenOn(company);
const BRANCHES = branchesOn(company);
const { counted, countsInItsScreen, branchCount, askedAtTwice, pressAskedAtTwice } = panelCountsOn(company);
/* The company grows its money once, by the first thing counted grown; a test run alone by its name grows it itself. */
let grown: Promise<void> | null = null;
const grow = (): Promise<void> => (grown ??= company.growTo(MONEY_GROWN));

describe(
  'EVERY ACTION PANEL AND BRANCH READS THE SAME HOWEVER MANY RUNS, PAID RUNS, ONE-OFF PAYMENTS AND SPENDING POLICIES THE COMPANY HOLDS',
  OPENINGS,
  () => {
    const panelsAtN = new Map<string, { readonly reads: Reads; readonly calls: readonly Called[] }>();
    const openedAtN = new Map<string, ScreenCount>();
    const pressedAtN = new Map<string, ScreenCount>();
    const branchesAtN = new Map<string, { readonly reads: Reads; readonly calls: readonly Called[] }>();
    let frame = '';
    const own = (text: string): string => text.replace(frame, '');

    beforeAll(async () => {
      frame = (await openPanel(company, founderOf(company), createElement('div'))).text;
    }, 60_000);

    for (const name of Object.keys(PANELS)) {
      it(`panel ${name} is drawn ready, and counted on the company at its first size`, async () => {
        const { reads, text, calls } = await counted(PANELS[name]!);
        panelsAtN.set(name, { reads, calls });
        /* RED WHEN: the panel draws nothing but the frame, or only the words it draws when it could not read, so its count holds nothing of the panel. */
        expect(own(text)).toContain(DRAWS[name]);
        expect(own(text).match(NOT_READ)).toBeNull();
        /* RED WHEN: an answer to this panel carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked. */
        expect(heldToTheRule(name, { calls })).toEqual([]);
      });
    }
    for (const name of Object.keys(IN_ITS_SCREEN)) {
      it(`panel ${name} is opened inside its screen and pressed, and counted on the company at its first size`, async () => {
        const { opened, pressed } = await countsInItsScreen(name);
        openedAtN.set(name, opened);
        pressedAtN.set(name, pressed);
        /* RED WHEN: the panel opened in its screen shows the words it shows when it could not read, or not the words only it draws. */
        expect(opened.text).toContain(IN_ITS_SCREEN[name]!.draws);
        expect(opened.text.match(NOT_READ)).toBeNull();
        /* RED WHEN: an answer to the panel's opening or to a press on it carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
        expect(heldToTheRule(`${name} opening`, opened)).toEqual([]);
        expect(heldToTheRule(`${name} press`, pressed)).toEqual([]);
      });
    }
    for (const name of Object.keys(BRANCHES)) {
      it(`branch ${name}, is counted on the company at its first size`, async () => {
        const { reads, text, calls } = await branchCount(BRANCHES[name]!);
        branchesAtN.set(name, { reads, calls });
        /* RED WHEN: the page does not draw what only the branch draws, so the count is of the usual page. */
        expect(text).toMatch(BRANCHES[name]!.shows);
        /* RED WHEN: an answer to the page under the branch carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
        expect(heldToTheRule(name, { calls })).toEqual([]);
      });
    }

    for (const name of Object.keys(PANELS)) {
      it(`panel ${name} reads the same with more runs, paid runs, one-off payments and spending policies`, async () => {
        /* RED WHEN: the first size of this panel was not counted before it, so there is nothing to hold its growth to. */
        expect(panelsAtN.has(name), `panel ${name} is counted at its first size before it is counted grown`).toBe(true);
        await grow();
        const was = panelsAtN.get(name)!;
        const now = await counted(PANELS[name]!);
        /* RED WHEN: any route, wallet ask or chain, builder or indexer read of this panel grows with the company's runs, paid runs, one-off payments or spending policies. */
        expect(differences(name, was.reads, now.reads, LABELS)).toEqual([]);
        /* RED WHEN: a read of this panel asks of one kind of record other than the same number or one more for each one more of what its kind grows with, or asks a kind it did not. */
        expect(askedAtTwice(name, was, now)).toEqual([]);
        /* RED WHEN: grown, an answer to this panel carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
        expect(heldToTheRule(name, now)).toEqual([]);
      });
    }
    for (const name of Object.keys(IN_ITS_SCREEN)) {
      it(`panel ${name}, opened inside its screen and pressed, reads the same with more runs, paid runs, one-off payments and spending policies`, async () => {
        /* RED WHEN: the first size of this panel was not counted before it, so there is nothing to hold its growth to. */
        expect(openedAtN.has(name), `panel ${name} is counted at its first size before it is counted grown`).toBe(true);
        await grow();
        const { opened, pressed } = await countsInItsScreen(name);
        const page = IN_ITS_SCREEN[name]!.page;
        /* RED WHEN: any route, wallet ask or chain, builder or indexer read of the panel's opening or of a press on it grows with the company's money. */
        expect(differences(`${name} opening`, readsOf(openedAtN.get(name)!), readsOf(opened), LABELS)).toEqual([]);
        expect(differences(`${name} press`, readsOf(pressedAtN.get(name)!), readsOf(pressed), LABELS)).toEqual([]);
        /* RED WHEN: a read of the panel's opening asks of one kind of record other than the same number or one more for each one more of what its kind grows with on its page, or asks a kind it did not. */
        expect(askedAtTwice(`${name} opening`, openedAtN.get(name)!, opened, page)).toEqual([]);
        /* RED WHEN: a read of a press on the panel asks a kind of record at the company grown that it did not ask at the first size, or does not ask one it did. */
        expect(pressAskedAtTwice(`${name} press`, pressedAtN.get(name)!, pressed)).toEqual([]);
        /* RED WHEN: grown, an answer to the panel's opening or to a press on it carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
        expect(heldToTheRule(`${name} opening`, opened)).toEqual([]);
        expect(heldToTheRule(`${name} press`, pressed)).toEqual([]);
      });
    }
    for (const name of Object.keys(BRANCHES)) {
      it(`branch ${name}, reads the same with more runs, paid runs, one-off payments and spending policies`, async () => {
        /* RED WHEN: the first size of this branch was not counted before it, so there is nothing to hold its growth to. */
        expect(branchesAtN.has(name), `${name} is counted at its first size before it is counted grown`).toBe(true);
        await grow();
        const b = BRANCHES[name]!;
        const was = branchesAtN.get(name)!;
        const now = await branchCount(b);
        expect(now.text).toMatch(b.shows);
        /* RED WHEN: any read of the page under the branch grows with the company's runs, paid runs, one-off payments or spending policies. */
        expect(differences(name, was.reads, now.reads, LABELS)).toEqual([]);
        /* RED WHEN: a read of the page under the branch asks of one kind of record other than the same number or one more for each one more of what its kind grows with on its page, or asks a kind it did not. */
        expect(askedAtTwice(name, was, now, b.page)).toEqual([]);
        /* RED WHEN: grown, an answer to the page under the branch carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked. */
        expect(heldToTheRule(name, now)).toEqual([]);
      });
    }
  }
);
