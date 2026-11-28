// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';
import { untilShown } from '../page-shown.test-support.js';

/*
 * THE SUPER ADMINS PAGE, drawn over its adapter's answers: who holds the company as the chain shows it, the person's own
 * key, the change kept on the service and the press each key may make, the refusals said by name, and the same page
 * opened from a link by a super admin with no seat. Settings > Super admins also draws the hand-over that was on Signers.
 */
const st = vi.hoisted(() => ({
  read: null as unknown,
  raised: [] as unknown[],
  joined: [] as unknown[],
  approved: [] as unknown[],
  answer: null as unknown,
  reaches: [] as unknown[],
  named: { label: `co_${'c0'.repeat(32)}`, company: 'b2'.repeat(32) } as unknown,
  signed: [] as string[],
  /* The openings of the page's view: each `reload` opens another, as the page's frame does; `signedOn` is the opening each signing was handed. */
  opened: 0,
  reopened: new Set<() => void>(),
  signedOn: [] as number[],
  viewOpened: new Map<unknown, number>()
}));
/* The page's own view and judges, with only what follows stood in for. */
/* The page's own judges and view, kept as one module across each load of the code under test, so a view a test opens is the one it reads. */
vi.mock('../adapters/filing-judge.js', async (real) => ({
  ...(await real<typeof import('../adapters/filing-judge.js')>())
}));
vi.mock('../records/company-records.js', async (real) => {
  const { useSyncExternalStore } = await import('react');
  const { useTheViewOfTheTest, aViewOf } = await import('../adapters/page-view.test-support.js');
  const watch = (f: () => void) => {
    st.reopened.add(f);
    return () => {
      st.reopened.delete(f);
    };
  };
  const openings = new Map<string, unknown>();
  const useCompanyView = () => {
    const opened = useSyncExternalStore(watch, () => st.opened);
    const first = useTheViewOfTheTest();
    if (first === null || opened === 0) {
      st.viewOpened.set(first, 0);
      return first;
    }
    const key = `${first.company}/${opened}`;
    const view = openings.get(key) ?? aViewOf(first.company);
    openings.set(key, view);
    st.viewOpened.set(view, opened);
    return view as typeof first;
  };
  const reload = () => {
    st.opened += 1;
    for (const f of st.reopened) f();
  };
  return {
    ...(await real<typeof import('../records/company-records.js')>()),
    useCompanyView,
    useCompanyRecords: () => ({ reload })
  };
});
/* Who holds the company, as the signer's own wallet reads it for the screen's view. */
vi.mock('vaults-web-shared/wallet-asks.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-asks.js')>()),
  holdersFromTheWallet: async () => ({
    holders: {
      committee: [],
      threshold: 1,
      seats: [],
      approvals: 1,
      adoptedVaults: [],
      vaultThresholds: [],
      policyBar: null
    },
    indexer: null
  })
}));
vi.mock('../adapters/super-admins.js', async (real) => ({
  ...(await real<typeof import('../adapters/super-admins.js')>()),
  readSuperAdmins: async (reach: unknown) => {
    st.reaches.push(reach);
    return st.read;
  },
  raiseChange: async (...ask: unknown[]) => {
    st.raised.push(ask);
    return st.answer;
  },
  joinChange: async (...ask: unknown[]) => {
    st.joined.push(ask);
    return st.answer;
  },
  approveChange: async (...ask: unknown[]) => {
    st.approved.push(ask);
    return st.answer;
  },
  notYetAdopted: async (_id: string, listed: readonly string[]) =>
    listed.includes('d2'.repeat(32)) ? [] : ['d2'.repeat(32)]
}));
vi.mock('vaults-web-shared/service-transport.js', async (real) =>
  (await import('../adapters/service-in-memory.test-support.js')).withTheView({
    ...(await real<typeof import('vaults-web-shared/service-transport.js')>()),
    /* The company's record as the service keeps it: its label and its account on the chain, as `st.named` names them. */
    api: async (path: string) => {
      if (path.endsWith('/directory')) return { filings: [] };
      const { label, company } = st.named as { label?: unknown; company?: unknown };
      return { companyLabel: label, contractAddress: company };
    }
  })
);
vi.mock('../adapters/handover-state.js', async (real) => ({
  ...(await real<typeof import('../adapters/handover-state.js')>()),
  readHandover: async () => ({ of: 'change-owed', signed: [{ have: 0, required: 1 }] })
}));
vi.mock('../adapters/committee-change.js', async (real) => ({
  ...(await real<typeof import('../adapters/committee-change.js')>()),
  signChange: async (person: string, view: { company: string }) => {
    st.signed.push(`${person}/${view.company}`);
    st.signedOn.push(st.viewOpened.get(view) ?? -1);
    return { of: 'done' };
  }
}));

const { SuperAdmins, SuperAdminsByLink } = await import('./super-admins.js');
const { SessionProvider } = await import('../session.js');
const { CurrentPageProvider } = await import('../router.js');
const { HANDOVER } = await import('../adapters/handover-state.js');

const LANGUAGES = languagesFrom({ './locales/en.json': ENGLISH });
const LABEL = `co_${'c0'.repeat(32)}`;
const ACCOUNT = 'b2'.repeat(32);
const [A, B, C] = ['a1', 'b1', 'c1'].map((x) => ({ tag: 'schnorr', value: x.repeat(32) })) as [
  { tag: string; value: string },
  { tag: string; value: string },
  { tag: string; value: string }
];
const session = () => ({
  person: { id: 'u1', name: 'Priya' },
  companies: [],
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
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 5));
  });
};
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const press = async (s: string) => {
  fireEvent.click(q(s)!);
  await settle();
};
const readOf = (over: Record<string, unknown> = {}) => ({
  of: 'read',
  committee: [
    { key: A, mine: true },
    { key: B, mine: false }
  ],
  threshold: 2,
  warning: null,
  mine: A,
  iAmOne: true,
  changes: [],
  contracts: [ACCOUNT],
  ...over
});
const changeOf = (over: Record<string, unknown> = {}) => ({
  chainId: 'ee'.repeat(32),
  raisedBy: A,
  raisedByMine: true,
  committee: [A, B, C],
  threshold: 2,
  warning: null,
  joining: [{ key: C, signed: false, mine: false }],
  ...over
});

const byLink = async (params: Record<string, string> = { id: 'c-1', label: LABEL, account: ACCOUNT }) => {
  render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}>
        <CurrentPageProvider id="superAdminsByLink" params={params}>
          <SuperAdminsByLink />
        </CurrentPageProvider>
      </SessionProvider>
    </KitProvider>
  );
  await settle();
};
const inSettings = async () => {
  render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}>
        <SuperAdmins />
      </SessionProvider>
    </KitProvider>
  );
  await untilShown(() => q('[data-super-admins="read"]'), 'the super admins read');
};

beforeEach(() => {
  st.read = readOf();
  st.raised = [];
  st.joined = [];
  st.approved = [];
  st.reaches = [];
  st.signed = [];
  st.signedOn = [];
  st.answer = { of: 'done', sent: false, held: null };
});
afterEach(cleanup);

describe('A SUPER ADMIN WITH NO SEAT, FROM A LINK', () => {
  it("reads the company the link names with the person's own key, and shows the keys holding it and theirs", async () => {
    await byLink();
    /* RED WHEN: the link page reads without the person's signed request, or for another company than the link names. */
    expect(st.reaches.at(-1)).toEqual({
      company: { accountId: 'c-1', label: LABEL, account: ACCOUNT },
      asSuperAdmin: true
    });
    expect(q('[data-held]')!.textContent).toContain('(your key)');
    expect(q('[data-my-key]')).not.toBeNull();
    /* RED WHEN: a super admin with no seat is not told a vault the account does not list yet is left out, and who can see it. */
    expect(q('[data-not-adopted-unseen]')).not.toBeNull();
  });

  it('RAISES A CHANGE FROM THE PAGE: the keys kept, the keys added and the number that must sign', async () => {
    await byLink();
    fireEvent.click(q(`[data-keep="${B.value}"]`)!);
    fireEvent.change(q('[data-add-keys]')!, { target: { value: C.value } });
    fireEvent.change(q('[data-threshold]')!, { target: { value: '1' } });
    await press('[data-action="raise"]');
    /* RED WHEN: the change raised is not the one the form shows, or is raised against anything but the committee the chain holds. */
    expect(st.raised.at(-1)).toEqual([
      expect.objectContaining({ asSuperAdmin: true }),
      { committee: [A, C], threshold: 1 },
      { committee: [A, B], threshold: 2 }
    ]);
    expect(q('[data-acted="kept"]')).not.toBeNull();
  });

  it('APPROVES A KEPT CHANGE ONLY ONCE EVERY JOINING KEY HAS SIGNED', async () => {
    st.read = readOf({ changes: [changeOf()] });
    await byLink();
    /* RED WHEN: a super admin can sign for a contract while a key the change adds has not signed it. */
    expect((q('[data-action="approve"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-joins-waiting]')).not.toBeNull();
    cleanup();
    st.read = readOf({ changes: [changeOf({ joining: [{ key: C, signed: true, mine: false }] })] });
    st.answer = { of: 'done', sent: true, held: null };
    await byLink();
    await press('[data-action="approve"]');
    expect(st.approved).toHaveLength(1);
    expect(q('[data-acted="sent"]')).not.toBeNull();
  });

  it('LISTS EVERY CHANGE KEPT AT THE COUNTER WITH WHO RAISED IT, AND APPROVES THE ONE THE PERSON PICKS', async () => {
    const later = changeOf({
      chainId: 'ff'.repeat(32),
      raisedBy: B,
      raisedByMine: false,
      committee: [A, B],
      threshold: 1,
      joining: []
    });
    st.read = readOf({ changes: [changeOf({ raisedBy: C, raisedByMine: false }), later] });
    st.answer = { of: 'done', sent: true, held: null };
    await byLink();
    /* RED WHEN: a change raised later at the counter is hidden behind the first, or does not say who raised it. */
    const listed = [...document.body.querySelectorAll('[data-kept-change]')];
    expect(listed.map((x) => x.getAttribute('data-kept-change'))).toEqual(['ee'.repeat(32), 'ff'.repeat(32)]);
    expect(listed[1]!.querySelector('[data-raised-by]')!.textContent).toContain(B.value.slice(0, 12));
    fireEvent.click(listed[1]!.querySelector('[data-action="approve"]')!);
    await settle();
    expect(st.approved.at(-1)).toEqual([expect.objectContaining({ asSuperAdmin: true }), later]);
  });

  it('says why an approved change has not finished, when it is not only short of signatures', async () => {
    st.read = readOf({ changes: [changeOf({ joining: [] })] });
    st.answer = { of: 'done', sent: false, held: 'a contract was changed by another change first' };
    await byLink();
    await press('[data-action="approve"]');
    /* RED WHEN: a change spent, unsent or left for another device is told as waiting for signatures. */
    expect(q('[data-acted="held"]')!.textContent).toContain('a contract was changed by another change first');
  });

  it('a joining key with no seat signs the change, and is offered nothing else', async () => {
    st.read = readOf({
      committee: [
        { key: A, mine: false },
        { key: B, mine: false }
      ],
      mine: C,
      iAmOne: false,
      changes: [changeOf({ joining: [{ key: C, signed: false, mine: true }], raisedByMine: false })]
    });
    await byLink();
    await press('[data-action="join"]');
    expect(st.joined.at(-1)).toEqual([expect.objectContaining({ asSuperAdmin: true }), 'ee'.repeat(32)]);
    /* RED WHEN: a key not on the committee is offered a raise or an approval. */
    expect([q('[data-raise]'), q('[data-action="approve"]')]).toEqual([null, null]);
  });

  it('SAYS EACH REFUSAL BY NAME, WITH WHAT CLEARS IT', async () => {
    st.answer = { of: 'refused', why: 'raiser-leaves' };
    await byLink();
    fireEvent.click(q(`[data-keep="${A.value}"]`)!);
    await press('[data-action="raise"]');
    /* RED WHEN: a change that takes the raiser's own key off is refused without saying another super admin raises it. */
    expect(q('[data-super-admins-refused="raiser-leaves"]')!.textContent).toMatch(/Another super admin raises it/);
  });

  it('warns where the last key is shown, and says what losing every key costs where the role is given', async () => {
    st.read = readOf({ committee: [{ key: A, mine: true }], threshold: 1, warning: 'one-left' });
    await byLink();
    /* RED WHEN: a company held by one key is not warned, or the raise form does not say what losing every key costs. */
    expect(q('[data-super-admins-warning="one-left"]')).not.toBeNull();
    expect(q('[data-every-key-lost]')!.textContent).toMatch(
      /nobody can ever change who holds the company's contracts again/
    );
    /* RED WHEN: where super admins are chosen, the page lets the number read as one the network holds every super admin to. */
    expect(q('[data-any-one-can]')!.textContent).toMatch(
      /any one super admin, with their own software, can change the company's contracts alone/
    );
    expect(q('[data-held]')!.textContent).toMatch(/any one of them can change it alone/);
  });

  it('says plainly when the link names no company, and reads nothing', async () => {
    await byLink({ id: 'c-1', label: 'not-a-label', account: ACCOUNT });
    expect(q('[data-super-admins="no-link"]')).not.toBeNull();
    expect(st.reaches).toEqual([]);
  });
});

describe('SETTINGS > SUPER ADMINS', () => {
  it('reads as a member until the person uses their key, and gives the link a super admin with no seat opens', async () => {
    st.read = readOf({
      mine: null,
      iAmOne: false,
      committee: [
        { key: A, mine: false },
        { key: B, mine: false }
      ]
    });
    await inSettings();
    expect(st.reaches.at(-1)).toEqual({
      company: { accountId: 'c-1', label: LABEL, account: ACCOUNT },
      asSuperAdmin: false
    });
    expect((q('[data-super-admin-link] input') as HTMLInputElement).value).toBe(
      `${window.location.origin}/super-admins/c-1/${LABEL}/${ACCOUNT}`
    );
    await press('[data-action="use-my-key"]');
    expect(st.reaches.at(-1)).toMatchObject({ asSuperAdmin: true });
    /* RED WHEN: a vault the company created that the account does not list is not named to a signer, so it is moved by no change unseen. */
    expect((await untilShown(() => q('[data-not-adopted]'), 'the vaults not yet adopted')).textContent).toContain(
      'd2'.repeat(6)
    );
  });

  it('DRAWS THE HAND-OVER OF A VAULT LEFT BEHIND, AND SIGNS IT FROM HERE AFTER THE CONFIRMATION', async () => {
    await inSettings();
    const handOver = await untilShown(
      () => q(`[data-hand-over] [data-state="${HANDOVER.changeOwed}"]`),
      'the hand-over owed'
    );
    expect(handOver).not.toBeNull();
    await press('[data-action="sign-change"]');
    /* RED WHEN: the committee change is not on the Super admins page, or signs before the confirmation. */
    expect(st.signed).toEqual([]);
    fireEvent.click(
      [...document.body.querySelectorAll('button')].find(
        (b) =>
          /Confirm|Continue|Open/.test(b.textContent ?? '') && b.closest('[data-action="committee-change"]') !== null
      )!
    );
    await settle();
    expect(st.signed).toEqual(['u1/c-1']);
  });

  it('SIGNS THE HAND-OVER ON A FRESH READ OF WHO HOLDS THE COMPANY, ONCE AN APPROVAL HERE SENT THE CHANGE', async () => {
    st.read = readOf({ changes: [changeOf({ joining: [{ key: C, signed: true, mine: false }] })] });
    st.answer = { of: 'done', sent: false, held: null, sentAny: true };
    await inSettings();
    const before = st.opened;
    await press('[data-action="approve"]');
    await untilShown(() => q(`[data-hand-over] [data-state="${HANDOVER.changeOwed}"]`), 'the hand-over owed');
    await press('[data-action="sign-change"]');
    fireEvent.click(
      [...document.body.querySelectorAll('button')].find(
        (b) =>
          /Confirm|Continue|Open/.test(b.textContent ?? '') && b.closest('[data-action="committee-change"]') !== null
      )!
    );
    await settle();
    /* RED WHEN: the page keeps the opening that read who held the company before the change was sent, so the hand-over is refused as another signer's change. */
    expect(st.signedOn).toEqual([before + 1]);
    cleanup();
    st.answer = { of: 'done', sent: false, held: null, sentAny: false };
    await inSettings();
    const still = st.opened;
    await press('[data-action="approve"]');
    /* RED WHEN: an approval that sent nothing ends the opening anyway, and the page reads everything again for nothing. */
    expect(st.opened).toBe(still);
  });
});
