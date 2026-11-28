// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readsAreStale, STALE } from 'vaults-web-shared/company-reads-stale.js';
import type { PageView } from '../adapters/filing-judge.js';
import { VIEWS } from '../pages.js';
import { SessionProvider } from '../session.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';

/*
 * THE FRAME OPENS ONE VIEW OF THE SHOWN COMPANY FOR EACH OPENING OF A PAGE, HANDS IT DOWN, AND ENDS IT. What is checked
 * is when the view handed down ends and whether another is opened: the page going away, the wallet releasing the
 * company's key, an action in the wallet having run on the company, and the sign-in ending.
 */
const state = vi.hoisted(() => ({ released: new Set<(accountId: string) => void>(), reads: [] as unknown[] }));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  watchCompanyKeyReleased: (watch: (accountId: string) => void) => {
    state.released.add(watch);
    return () => {
      state.released.delete(watch);
    };
  }
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async (_person: string, view: unknown) => {
    state.reads.push(view);
    return { of: 'open', id: 'c-1', name: 'Northwind', signers: [] };
  }
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => Object.assign(new Map<string, string>(), { whyNot: new Map<string, string>() })
}));

const { CompanyRecordsProvider, useCompanyView } = await import('./company-records.js');

/* Every view the frame handed down, in order, null where it handed none. */
const handed: (PageView | null)[] = [];
function Tile() {
  const view = useCompanyView();
  if (handed.at(-1) !== view) handed.push(view);
  return null;
}
const sessionOf = (person: string) => ({
  person: { id: person, name: 'Priya' },
  companies: [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1 }],
  company: 'c-1',
  chooseCompany: vi.fn(),
  viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(),
  preferences: DEFAULT_PREFERENCES,
  choose: vi.fn(),
  signOut: vi.fn(),
  mac: true,
  companiesChanged: vi.fn(async () => {})
});
const frame = (person = 'u1') => (
  <SessionProvider session={sessionOf(person) as never}>
    <CompanyRecordsProvider>
      <Tile />
    </CompanyRecordsProvider>
  </SessionProvider>
);
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};
const opened = (): PageView[] => handed.filter((v): v is PageView => v !== null);
/* The frame loads the code that opens a view the first time it needs it, so the first view is waited for. */
const viewsOpened = async (views: number) => {
  await vi.waitFor(
    () => {
      expect(opened().length).toBe(views);
    },
    { timeout: 20_000 }
  );
  await settle();
};
const release = async (company: string) => {
  await act(async () => {
    for (const told of [...state.released]) told(company);
  });
  await settle();
};
const stale = async (company: string | null, signedIn: boolean) => {
  await act(async () => {
    readsAreStale({ company, why: signedIn ? STALE.actedInTheWallet : STALE.signInEnded, signedIn });
  });
  await settle();
};

beforeEach(() => {
  handed.length = 0;
  state.reads = [];
});
afterEach(() => {
  cleanup();
});

describe('one view for each opening of a page', () => {
  it('hands the tiles the view it read the company through, and ends it when the page goes away', async () => {
    const drawn = render(frame());
    await viewsOpened(1);
    const [view] = opened();
    /* RED WHEN: the frame reads the company through one view and hands the tiles another, so the company is read twice. */
    expect([opened().length, state.reads, view!.company, view!.ended]).toEqual([1, [view], 'c-1', null]);
    drawn.unmount();
    /* RED WHEN: a view outlives the opening it was made for, with the company's keys it opened. */
    expect(view!.ended).toBe('the page moved on');
  });

  it("ends the view when the wallet releases this company's key, and opens another; another company's key ends nothing", async () => {
    render(frame());
    await viewsOpened(1);
    const [first] = opened();
    await release('c-2');
    /* RED WHEN: a key released for another company ends this company's view. */
    expect([first!.ended, opened().length]).toEqual([null, 1]);
    await release('c-1');
    /* RED WHEN: what was read without the company's key is still served once the wallet released it, or the page is left with no view. */
    expect([first!.ended, opened().length, opened()[1]!.ended]).toEqual([
      "the wallet released the company's key",
      2,
      null
    ]);
  });

  it('ends the view once an action in the wallet ran on this company, and opens another; an action on another company ends nothing', async () => {
    render(frame());
    await viewsOpened(1);
    const [first] = opened();
    await stale('c-2', true);
    /* RED WHEN: an action on another company ends this company's view. */
    expect([first!.ended, opened().length]).toEqual([null, 1]);
    await stale('c-1', true);
    /* RED WHEN: the page reads on through the view it opened before the action changed the company, or the view is ended twice and the one opened after it with it. */
    expect([first!.ended, opened().length, opened()[1]!.ended, state.reads.length]).toEqual([
      STALE.actedInTheWallet,
      2,
      null,
      2
    ]);
  });

  it('ends the view when the sign-in ends, hands the tiles none, and opens no other until somebody is signed in', async () => {
    const drawn = render(frame());
    await viewsOpened(1);
    const [first] = opened();
    await stale(null, false);
    /* RED WHEN: a sign-in that ended leaves a view open, or the frame opens another and reads as nobody, which the service refuses, which ends the sign-in again. */
    expect([first!.ended, opened().length, handed.at(-1), state.reads.length]).toEqual([STALE.signInEnded, 1, null, 1]);
    drawn.rerender(frame('u2'));
    await settle();
    /* RED WHEN: the next person signed in is handed the view of the person before, or none. */
    expect([opened().length, opened()[1]!.ended, opened()[1] === first]).toEqual([2, null, false]);
  });
});
