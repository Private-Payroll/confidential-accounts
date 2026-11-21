// @vitest-environment jsdom
/*
 * The count harness counts every read an opening makes, and fails an opening it cannot count whole: a read that waits on an
 * answer, or on a chain, builder or indexer ask, holds the opening open; an opening that never goes quiet fails; a read that
 * starts after the opening was counted fails the next opening; and a call to an address that is not the company's service is
 * counted and refused. Each opening here draws a small panel that reads on a script.
 */
import { createElement, useEffect, useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { aCompanyOf, openPanel, type CompanyOpened, type ScreenCount } from './company-harness.test-support.js';

const { theVaultBuilder } = await import('../adapters/vault-builder.js');

const company = aCompanyOf({ people: 1 });
const FOUNDER = company.seats()[0]!.person;
const RUNS = 'route GET /api/accounts/:record/runs';
const NAMED = 'GET /api/accounts/:record/runs';

/* What the frame the panel is drawn in reads on its own, counted on a device that has checked the company before. */
let frame: ScreenCount;
beforeAll(async () => {
  await openPanel(company, FOUNDER, createElement('div'));
  frame = await openPanel(company, FOUNDER, createElement('div'));
}, 60_000);
/** The frame's counts with `more` added to each read named. */
const plus = (was: Readonly<Record<string, number>>, more: Readonly<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = { ...was };
  for (const [k, n] of Object.entries(more)) out[k] = (out[k] ?? 0) + n;
  return out;
};

const after = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readRuns = (of: CompanyOpened) => (): Promise<unknown> => fetch(`/api/accounts/${of.fields.record}/runs`);
const askTheIndexer = async (): Promise<unknown> => (await theVaultBuilder()).vaultsOnChain({ vaults: [] } as never);

/* A panel that runs each step of its script in turn, and says how it ended; its timers are never cancelled, as a page's that leak are not. */
const Reading = ({ script }: { readonly script: readonly (() => Promise<unknown>)[] }) => {
  const [said, setSaid] = useState('reading');
  useEffect(() => {
    void (async () => { for (const step of script) await step(); setSaid('read it all'); })().catch((e: unknown) => setSaid(`refused: ${(e as Error).message}`));
  }, []);
  return createElement('p', null, said);
};
/* A panel that reads the service every 300 ms for as long as it is drawn. */
const Polling = () => {
  useEffect(() => { const timer = setInterval(() => { void readRuns(company)(); }, 300); return () => clearInterval(timer); }, []);
  return createElement('p', null, 'polling');
};
const panelReading = (...script: readonly (() => Promise<unknown>)[]) => createElement(Reading, { script });

describe('THE COUNT HARNESS COUNTS EVERY READ OF AN OPENING, OR FAILS THE OPENING', { timeout: 60_000 }, () => {
  it('a read that starts after the opening was counted fails the next opening, naming the read', async () => {
    await openPanel(company, FOUNDER, panelReading(() => after(1_500), readRuns(company)));
    await after(1_200);
    /* RED WHEN: a read that started after its opening was counted is in no count and fails nothing, so a pin passes while that read grows. */
    await expect(openPanel(company, FOUNDER, createElement('div'))).rejects.toThrow(`started after its opening was counted, so it is in no count: ${RUNS}`);
  });

  it('an ask of a chain, builder or indexer door holds the opening open as a read of the service does', async () => {
    const opened = await openPanel(company, FOUNDER, panelReading(readRuns(company), () => after(600), askTheIndexer, () => after(600), readRuns(company)));
    /* RED WHEN: the activity that holds an opening open is the service's reads and the wallet's asks alone, so a read that follows a door's ask is not counted. */
    expect(opened.routes).toEqual(plus(frame.routes, { [NAMED]: 2 }));
    expect(opened.asks).toEqual(plus(frame.asks, { 'indexer vaultsOnChain': 1 }));
    expect(opened.text).toContain('read it all');
  });

  it('a read waiting for its answer holds the opening open, so the read that follows the answer is counted', async () => {
    const slow: CompanyOpened = { ...company, call: (person) => async (method, path, body) => { await after(1_300); return company.call(person)(method, path, body); } };
    const opened = await openPanel(slow, FOUNDER, panelReading(readRuns(slow), readRuns(slow)));
    /* RED WHEN: an opening is held open only by the time since a read started, so a read answered after that time closes it and the next read is lost. */
    expect(opened.routes).toEqual(plus(frame.routes, { [NAMED]: 2 }));
  });

  it('an opening whose reads never go quiet fails, and is not counted as it stands', async () => {
    const forever = createElement(Polling);
    /* RED WHEN: an opening that is still reading when its time is up is handed back counted as far as it got. */
    await expect(openPanel(company, FOUNDER, forever, 2_000)).rejects.toThrow('not quiet after 2000 ms');
  });

  it('a call to an address that is not the company\'s service is counted and refused', async () => {
    const opened = await openPanel(company, FOUNDER, panelReading(() => fetch('https://example.org/data')));
    /* RED WHEN: a call to another address is fetched as it is and counted nowhere. */
    expect(opened.routes).toEqual(plus(frame.routes, { 'GET https://example.org/data (not the service)': 1 }));
    expect(opened.text).toContain('refused: the page fetched https://example.org/data, which is not the company\'s service');
  });
});
