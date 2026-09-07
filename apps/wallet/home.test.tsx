// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { identityFromSecret, newSecret, splitSecret } from 'midnight-identity';
import type { Placement } from 'midnight-identity';
import { saveArrival, saveCreation, saveSecuredSetup } from './storage.js';
import { forgetOpenWallet } from './wallets-held.js';
import { loadPendingSends, writePendingSend } from './pending.js';
import type { PendingDraft } from './pending.js';
import { Home, PendingSendsCard } from './screens/home.js';
import { BalanceEnginesContext } from './balance-context.js';
import type { BalanceEngine } from './balance.js';

/*
 * THE ONE CALL SITE THAT DECIDES THE TICK. `loadSecuredSetup(secret)`
 * (fingerprint-checked) and `securedSetupOnRecord()` (deliberately not) are
 * one import apart, and until this file, only a comment said which one the
 * home screen uses. These tests render the real screen: swap the reader, or
 * hardcode a record, and the foreign-record test fails.
 */

/* jsdom is its own realm: Node's `Buffer` global fails the crypto libraries'
 * `instanceof Uint8Array` checks under it, because their `Uint8Array` is
 * jsdom's. The npm `buffer` polyfill — the exact one `ensureBuffer` installs
 * in a real browser — subclasses whatever realm loads it, so under
 * jsdom it is the consistent choice. The trailing slash forces the package
 * over the builtin. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOTICE = /If you lose this device, the money in this wallet is gone/;
const TICK = /Account secured/;

const PLACEMENTS: readonly Placement[] = [
  { label: 'My Google account', holder: 'google:me' },
  { label: 'Printed card', holder: 'paper' },
  { label: 'Old laptop', holder: 'device:old' },
];

const VERIFICATION = { 'google:me': 'never', paper: null, 'device:old': 'never' } as const;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* The open compartment is module state and outlives a test. */
  forgetOpenWallet();
});

/* The unmount-after-every-test hook that used to be here is now in
 * `packages/identity/src/test-setup.ts`, where it closes the same hole in every file rather than
 * in this one. Nothing about this file depends on it being local. */

describe('the home screen and the standing notice — §7.7', () => {
  it('shows the notice when nothing is on record', () => {
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.queryByText(TICK)).toBeNull();
  });

  it('shows the notice against a record cut from a DIFFERENT secret', async () => {
    /* The stale-record story: this browser held account B once; account A is
     * unlocked now. B's proof of backup must not become A's. */
    const mine = newSecret();
    const other = newSecret();
    await saveSecuredSetup(other, await splitSecret(other, PLACEMENTS, 2), VERIFICATION);
    render(<Home identity={identityFromSecret(mine)} secret={mine} />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.queryByText(TICK)).toBeNull();
  });

  it('shows the tick for a record proved against the unlocked secret', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), {
      'google:me': Date.now(), paper: null, 'device:old': 'never',
    });
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByText(TICK)).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
    /* §7.12's per-piece truth, in TWO sentences now: paper can never
     * be asked; the device could be and has not been. Different facts,
     * different words, neither reading as fine. */
    expect(screen.getAllByText(/unknown — can’t be checked/)).toHaveLength(1);
    expect(screen.getAllByText(/not yet checked/)).toHaveLength(1);
  });

  it('renders the notice — not a blank page — over a garbage record', () => {
    const secret = newSecret();
    localStorage.setItem('midnight-identity:secured', JSON.stringify({
      fingerprint: 'xx', threshold: 2, pieces: [null], rebuiltAt: 1,
    }));
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  /*
   * SAME ASSERTIONS, ONE STEP FURTHER IN. The design makes Receive
   * a popup, so the two address blocks are behind it instead of sitting on the
   * screen. Nothing about what is asserted changed: the same `data-addr`
   * blocks, the same `.net` prefixes, the same TWO `.end` fragments each — the
   * the both-ends rule and the two kinds. The dialog is portalled to
   * `document.body`, so the query is off `document` rather than `container`.
   */
  it('shows both ends of BOTH addresses — two kinds', () => {
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    fireEvent.click(screen.getByText('Receive'));
    const shielded = document.querySelector('[data-addr="shielded"] .address-short');
    expect(shielded?.querySelector('.net')?.textContent).toMatch(/^mn_shield-addr_stagenet1$/);
    expect(shielded?.querySelectorAll('.end')).toHaveLength(2);
    const unshielded = document.querySelector('[data-addr="unshielded"] .address-short');
    expect(unshielded?.querySelector('.net')?.textContent).toMatch(/^mn_addr_stagenet1$/);
    expect(unshielded?.querySelectorAll('.end')).toHaveLength(2);
  });
});

describe('the third state, and the partial map — §7.15', () => {
  it('just recovered with no record: says it does not know, never that the money is gone', () => {
    /* The person on this screen proved their pieces work seconds ago. §7.7's
     * notice is untrue on arrival, and a false warning that sells more
     * pieces is worse than no warning. */
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} justRecovered />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByText(TICK)).toBeNull();
    expect(screen.getByText(/just put back from its pieces/)).toBeTruthy();
    expect(screen.getByText(/cannot tell you whether the account is secured/)).toBeTruthy();
  });

  it('an ARRIVED account: says the answer lives on the other machine, durably — §7.15', () => {
    /* Pairing proves the other machine had the account, nothing about
     * pieces. §7.7's notice — "your account exists only in this browser" —
     * would be plainly false; the tick would be a guess. Third state, and
     * DURABLE: the fact is read from storage, so it survives a reload. */
    const secret = newSecret();
    saveArrival(secret);
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByText(TICK)).toBeNull();
    expect(screen.getByText(/arrived from another device on/)).toBeTruthy();
    expect(screen.getByText(/This browser cannot tell, and does not\s+guess/)).toBeTruthy();
  });

  it("a FOREIGN arrival record borrows nobody's history — the notice stands", () => {
    /* The same discipline on the arrival fact: it names its account by
     * fingerprint and is null for any other. */
    saveArrival(newSecret());
    const mine = newSecret();
    render(<Home identity={identityFromSecret(mine)} secret={mine} />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.queryByText(/arrived from another device/)).toBeNull();
  });

  it('a PARTIAL record says these are the pieces you used, and that others may exist', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), {
      'google:me': Date.now(), paper: Date.now(), 'device:old': Date.now(),
    }, { partial: true });
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByText(TICK)).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByText(/put back from 3\s+pieces fetched from where they were placed/))
      .toBeTruthy();
    expect(screen.getByText(/there may be others this browser does not\s+know about/))
      .toBeTruthy();
    /* And a partial map never claims the wizard's evidence. */
    expect(screen.queryByText(/read back from\s+its card/)).toBeNull();
  });
});

describe('a foreign superseded set is a different account’s map', () => {
  it('splits history from a kept stranger’s map, and says whose is whose', async () => {
    /* The scenario: B was here, A was recovered over it, A was
     * then secured — folding B's record into `superseded`. B's pieces do not
     * open A, and saying otherwise invites destroying the pieces of the
     * account this browser just deleted.
     *
     * **THE SEQUENCE THAT MADE THIS RECORD CANNOT HAPPEN AGAIN, AND THE
     * RECORD IT MADE IS STILL ON DISK.** A recovery now lands in a compartment
     * of its own, so it never folds a stranger's map into its own record; but
     * every browser that did this before this change still holds one, and the
     * screen must go on telling the person whose pieces are whose. So the
     * record is BUILT here exactly as the old writer left it, rather than
     * produced by two writes the new writer would refuse — which is the
     * honest fixture for a record that predates a change. */
    const strangers = newSecret();
    await saveSecuredSetup(strangers, await splitSecret(strangers, PLACEMENTS, 2), VERIFICATION);
    const strangersRecord = JSON.parse(
      localStorage.getItem('midnight-identity:secured') as string) as {
        fingerprint: string; threshold: number; pieces: unknown[]; rebuiltAt: number;
      };
    localStorage.clear();

    const mine = newSecret();
    const MY_PLACES: readonly Placement[] = [
      { label: 'My iCloud', holder: 'icloud:me' },
      { label: 'Printed', holder: 'paper' },
    ];
    await saveSecuredSetup(mine, await splitSecret(mine, MY_PLACES, 2), {
      'icloud:me': 'never', paper: null,
    });
    const mineRecord = JSON.parse(
      localStorage.getItem('midnight-identity:secured') as string) as Record<string, unknown>;
    mineRecord['superseded'] = [{
      fingerprint: strangersRecord.fingerprint,
      threshold: strangersRecord.threshold,
      pieces: strangersRecord.pieces,
      rebuiltAt: strangersRecord.rebuiltAt,
      supersededAt: Date.now(),
    }];
    localStorage.setItem('midnight-identity:secured', JSON.stringify(mineRecord));

    render(<Home identity={identityFromSecret(mine)} secret={mine} />);
    expect(screen.getByText(TICK)).toBeTruthy();
    /* Not "an earlier set of this account's" — a different account's. */
    expect(screen.queryByText(/earlier set was replaced/)).toBeNull();
    expect(screen.getByText(/A different account’s piece list is also on file/)).toBeTruthy();
    expect(screen.getByText(/belong to an\s+account that was on this browser before/))
      .toBeTruthy();
    /* Kept, named by label — destroying a map is never ours to do. */
    expect(screen.getByText(/My Google account/)).toBeTruthy();
  });

  it('a replaced set of the SAME account still reads as its own history', async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION);
    const AGAIN: readonly Placement[] = [
      { label: 'My iCloud', holder: 'icloud:me' },
      { label: 'Printed again', holder: 'paper' },
    ];
    await saveSecuredSetup(secret, await splitSecret(secret, AGAIN, 2), {
      'icloud:me': 'never', paper: null,
    });
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByText(/One earlier set was replaced — its pieces still work/))
      .toBeTruthy();
    expect(screen.queryByText(/A different account’s piece list is also on file/)).toBeNull();
  });
});

describe('THE CARRIED QUESTION — a pending send lives on the home screen', () => {
  const pendingDraft = (over: Partial<PendingDraft> = {}): PendingDraft => ({
    identifiers: ['idA'],
    account: 0,
    kind: 'unshielded' as const,
    recipientBech32: 'mn_addr_stagenet1someoneelsewhoiswaiting',
    stars: 25_000_000n,
    feeSpecks: 681_461_485_385_268n,
    ttlAt: Date.now() + 60 * 60 * 1000,
    ...over,
  });

  it('renders nothing when nothing is pending — most days this card does not exist', () => {
    const secret = newSecret();
    const { container } = render(<PendingSendsCard secret={secret} resolution={{
      status: async () => { throw new Error('must not be asked'); }, now: Date.now,
    }}
    />);
    expect(container.textContent).toBe('');
  });

  it('an unresolved payment is carried, watched, and warns against sending again', () => {
    const secret = newSecret();
    writePendingSend(secret, pendingDraft());
    render(<PendingSendsCard secret={secret} resolution={{
      status: async () => ({ found: false }), now: Date.now,
    }}
    />);
    expect(screen.getByText(/A payment is still confirming\./u)).toBeTruthy();
    expect(screen.getByText(/25 tNIGHT/u)).toBeTruthy();
    expect(screen.getByText(/Do not send this payment\s*again/u)).toBeTruthy();
    expect(screen.getByText(/watching the chain/u)).toBeTruthy();
  });

  it('resolves itself on mount — nobody pressing anything — and the answer stays until dismissed', async () => {
    const secret = newSecret();
    writePendingSend(secret, pendingDraft());
    render(<PendingSendsCard secret={secret} resolution={{
      status: async () => ({ found: true, status: 'SUCCESS' }), now: Date.now,
    }}
    />);
    /* The resolution runs in the mount effect; the answer replaces the warning. */
    expect(await screen.findByText(/That payment went through\./u)).toBeTruthy();
    expect(screen.queryByText(/still confirming/iu)).toBeNull();
    /* Seen and dismissed — the record's work is done. */
    fireEvent.click(screen.getByText('Understood'));
    expect(screen.queryByText(/went through/u)).toBeNull();
    expect(loadPendingSends(secret)).toEqual([]);
  });

  it('a chain answer of FAILURE is said as failed, in the stored reason\'s words', async () => {
    const secret = newSecret();
    writePendingSend(secret, pendingDraft());
    render(<PendingSendsCard secret={secret} resolution={{
      status: async () => ({ found: true, status: 'FAILURE' }), now: Date.now,
    }}
    />);
    expect(await screen.findByText(/A payment did not go through\./u)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/FAILURE/u);
  });

  it('another account\'s pending payment is not carried here', () => {
    const mine = newSecret();
    const theirs = newSecret();
    writePendingSend(theirs, pendingDraft());
    const { container } = render(<PendingSendsCard secret={mine} resolution={{
      status: async () => { throw new Error('must not be asked'); }, now: Date.now,
    }}
    />);
    expect(container.textContent).toBe('');
  });

  it('the Home screen itself carries the card', () => {
    const secret = newSecret();
    writePendingSend(secret, pendingDraft());
    /* No resolution prop on Home — but with the indexer unreachable from a
     * test, resolution silently resolves nothing; the card still shows. */
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByText(/A payment is still confirming\./u)).toBeTruthy();
  });
});

/*
 * ============================================================================
 * WHAT HOME IS NOW. Six claims, and each one is a decision that would be
 * silently undone rather than visibly broken.
 * ============================================================================
 */

describe('the order Home reads in, and the two rules inside it', () => {
  it('the backup alert sits ABOVE the balance, and vanishes entirely once secured', async () => {
    /* THE RULE: *"the one thing that can cost everything, so it sits
     * first — and it disappears entirely once the account is secured, so it
     * never permanently pushes the balance down."* Order is the claim, so the
     * test reads document order rather than only presence. */
    const secret = newSecret();
    const { container } = render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    const alert = screen.getByText(NOTICE);
    const hero = container.querySelector('[data-hero]')!;
    /* DOCUMENT_POSITION_FOLLOWING: the hero comes after the alert. */
    expect(alert.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    cleanup();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION);
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    /* Not merely hidden — gone, so nothing is pushing the balance down. */
    expect(document.querySelector('[data-hero]')).not.toBeNull();
  });

  it('SEND IS A LINK AND NEVER A POPUP — one surface approves anything that moves money', () => {
    /* The interface's first standing rule. Every confirmation row
     * in the sequence lives on the approval surface, and
     * a modal is exactly where a second approval path gets built by accident.
     * So: an anchor to the send SCREEN, and pressing it opens no dialog. */
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    const send = screen.getByText('Send').closest('a');
    expect(send?.getAttribute('href')).toBe('#/send');
    fireEvent.click(send!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Receive IS a popup, and it moves nothing — no form, no approval, no way to spend', () => {
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    fireEvent.click(screen.getByText('Receive'));
    const panel = document.querySelector('[role="dialog"]')!;
    expect(panel).not.toBeNull();
    /* Display only: nothing to type an amount into, nothing to submit, and no
     * link out of it — a receive panel that could reach the send screen would
     * be a second door to the approval surface. */
    expect(panel.querySelectorAll('form')).toHaveLength(0);
    expect(panel.querySelectorAll('input')).toHaveLength(0);
    expect(panel.querySelectorAll('a[href]')).toHaveLength(0);
    /* And both payable addresses are in it. */
    expect(panel.querySelector('[data-addr="unshielded"]')).not.toBeNull();
    expect(panel.querySelector('[data-addr="shielded"]')).not.toBeNull();
  });

  /*
   * **THE FORBIDDEN WORD *soon* IS NO LONGER FORBIDDEN, AND THAT IS SAID OUT
   * LOUD RATHER THAN EDITED IN QUIETLY.** The rule is that a test may never
   * be updated to assert something different — except where the change's own
   * design orders the thing the assertion described to stop being the case.
   * This change settles *Coming soon* against *Not built yet* in favour of the
   * first, everywhere a planned feature is named, so a panel that must not
   * contain the word *soon* is asserting the losing side of a decision that
   * has been taken.
   *
   * **EVERY OTHER TERM IN THE PATTERN SURVIVES, WORD FOR WORD, AND THAT IS THE
   * PART THAT WAS EVER LOAD-BEARING.** *Soon* is a temperature; `Q3`, *next
   * month* and `2026` are promises, and it is a promise that makes a sentence
   * stop being true in a year. Both positive assertions are untouched, and the
   * body of the panel still says outright that there is no date and that this
   * screen will not invent one — which is the guard, not the adjective.
   */
  it('Earn ships as a deliberate “coming soon”, and commits to no date', () => {
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    fireEvent.click(screen.getByText('Earn'));
    const panel = document.querySelector('[role="dialog"]')!;
    expect(panel.textContent).toMatch(/staking and yield/);
    expect(panel.textContent).toMatch(/no date for it/);
    expect(panel.textContent).not.toMatch(
      /shortly|coming (?:up|next)|\bQ[1-4]\b|next (?:month|week|year|release)|20\d\d/i);
  });

  it('every “view all” is a LINK TO A PLACE, never an inline drawer', () => {
    /* The rule that makes the change additive: build them as
     * drawers now and converting them to routes later is a rewrite.
     *
     * THE AFFORDANCE IS A CHEVRON IN THE CARD HEADER NOW, so the
     * selector reads the accessible name instead of the visible words. THE
     * ASSERTION IS THE ONE THAT WAS HERE: it is an anchor, and its `href` is
     * `#/activity`. The chevron would satisfy a weaker test — *"something in
     * the header goes to Activity"* — as a button that set the hash, which is
     * exactly the drawer this test exists to refuse, so `closest('a')` stays. */
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByLabelText('View all activity').closest('a')?.getAttribute('href'))
      .toBe('#/activity');
    expect(screen.getByText('Contacts').closest('a')?.getAttribute('href'))
      .toBe('#/address-book');
  });

  it('recent activity says it has not ASKED — never that there are no payments', () => {
    /* The same discipline moved from a balance to a list: *"nothing here yet"*
     * and *"we could not ask"* are different sentences, and only one of them is
     * true while nothing reads history. A home screen printing "no payments"
     * would be making a claim about money out of a feature that is not built. */
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByText(/Payment history is not read on this screen yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing above is a statement that no payments exist/))
      .toBeTruthy();
  });
});

/*
 * ============================================================================
 * WHEN THIS BROWSER GOT THIS ACCOUNT. One sentence, one
 * browser, and never a count.
 * ============================================================================
 */
describe('the device card says the one true thing, and never a roster', () => {
  const COUNT = /\b(devices?|other machines?|and possibly others|\d+\s+devices?)\b/i;

  it('an account CREATED here says so, dated, in one sentence', () => {
    const secret = newSecret();
    saveCreation(secret);
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    const card = screen.getByLabelText('When this browser got this account');
    expect(card.textContent).toMatch(/^Created in this browser on \S/);
    /* This wallet cannot know how many devices hold
     * this account and MUST NOT APPEAR TO — *"a device list is exactly the
     * component that makes a person assume revocation exists"*, and
     * there is no revocation anywhere in this codebase. So: no count, no
     * roster, no hedge that implies one. */
    expect(card.textContent).not.toMatch(COUNT);
  });

  it('an account PAIRED here says LINKED — never created, because it was not', () => {
    const secret = newSecret();
    saveArrival(secret);
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    const card = screen.getByLabelText('When this browser got this account');
    expect(card.textContent).toMatch(/^Linked on \S/);
    expect(card.textContent).not.toMatch(/[Cc]reated/);
    expect(card.textContent).not.toMatch(COUNT);
  });

  it('a RECOVERED account — no record either way — says NOTHING rather than a wrong date', () => {
    /* The card is a local convenience and is allowed to be absent. A recovery
     * writes neither record (`recover.test.tsx`), so this is the state every
     * recovered browser is in, and the honest answer is silence: the account
     * is older than this machine and nothing here knows by how much. */
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.queryByLabelText('When this browser got this account')).toBeNull();
  });

  it("a FOREIGN creation record borrows nobody's history — the same rule as arrival", () => {
    saveCreation(newSecret());
    const mine = newSecret();
    render(<Home identity={identityFromSecret(mine)} secret={mine} />);
    expect(screen.queryByLabelText('When this browser got this account')).toBeNull();
  });

  it('a damaged record shows nothing, never a guess — a read does not repair in place', () => {
    localStorage.setItem('midnight-identity:created', '{not json');
    const mine = newSecret();
    render(<Home identity={identityFromSecret(mine)} secret={mine} />);
    expect(screen.queryByLabelText('When this browser got this account')).toBeNull();
    /* And the damage is left where it is: this read repairs nothing. */
    expect(localStorage.getItem('midnight-identity:created')).toBe('{not json');
  });

  it('created AND linked is still ONE sentence — created wins, as the older fact', () => {
    /* Reachable by pairing an account back onto the browser it began on. Two
     * true sentences is still an enumeration, which is what the rule forbids. */
    const secret = newSecret();
    saveCreation(secret);
    saveArrival(secret);
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    const card = screen.getByLabelText('When this browser got this account');
    expect(card.textContent).toMatch(/^Created in this browser on \S/);
    expect(card.textContent).not.toMatch(/Linked on/);
  });
});

describe('naming is what creates an account', () => {
  it('the pencil offers to NAME an unnamed slot and to RENAME a named one', () => {
    /* Mechanically the ten slots always exist, but
     * to a person a slot with no name and no history is not an account — so
     * naming is the act of creation, and the control has to say which act it
     * is about to perform. */
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    expect(screen.getByLabelText('Name this wallet')).toBeTruthy();
    expect(screen.queryByLabelText('Rename this wallet')).toBeNull();

    fireEvent.click(screen.getByLabelText('Name this wallet'));
    fireEvent.change(screen.getByLabelText('A name for the main wallet'), {
      target: { value: 'Everything' },
    });
    fireEvent.click(screen.getByText('Save the name'));

    expect(screen.getByLabelText('Rename this wallet')).toBeTruthy();
    expect(screen.queryByLabelText('Name this wallet')).toBeNull();
  });
});

describe('the private balance line is honest about the mechanism', () => {
  it('says money sent privately appears there, and that nothing can send it yet', () => {
    /* It will read zero for a long time, because this ledger
     * has no shield door and shielded value is minted by contracts. The
     * sentence has to be honest about that without implying money may arrive
     * that cannot — **zero is a true answer to it.** */
    const secret = newSecret();
    const engine: BalanceEngine = (_identity, _account, tell) => {
      tell({ name: 'synced', night: 0n, asOf: Date.now() });
      return () => {};
    };
    const inert: BalanceEngine = () => () => {};
    render(
      <BalanceEnginesContext.Provider value={{ shielded: engine, unshielded: inert, dust: inert }}>
        <Home identity={identityFromSecret(secret)} secret={secret} />
      </BalanceEnginesContext.Provider>,
    );
    fireEvent.click(screen.getByText('Check the balance'));
    const line = document.querySelector('[data-kind="shielded"]')!;
    expect(line.querySelector('.balance-big')?.textContent).toContain('0');
    expect(line.textContent).toMatch(/Money sent to you privately appears here/);
    expect(line.textContent).toMatch(/minted by a contract/);
    /* It must not promise arrivals. */
    expect(line.textContent).not.toMatch(/will arrive|on its way|check back/i);
  });
});
