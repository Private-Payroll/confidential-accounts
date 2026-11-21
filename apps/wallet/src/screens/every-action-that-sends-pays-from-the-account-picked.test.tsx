// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '../testing/render.js';
import type { ReactNode } from 'react';

/*
 * EVERY ACTION THAT CAN SEND PAYS FROM THE ACCOUNT PICKED BEFORE THE PASSKEY, AND FROM NO OTHER. Driven from the
 * wallet's own list of actions, so an action added later is held here without editing this file: each action whose
 * route list can carry a transaction to the chain is asked as an ask that pays, runs only on the account picked for
 * it, and, when the wallet the passkey opened is not the one picked, runs nothing and says what to do. The account
 * open last never pays.
 */

/* What each run was handed to pay from: the run itself is replaced, so reaching it at all is what "it went on" means. */
const ran = vi.hoisted(() => ({ accounts: [] as Array<number | undefined>, pressOnceOpen: [] as Array<boolean | undefined> }));

vi.mock('../actions/runner-screen.js', () => ({
  ActionRunner: ({ account, pressOnceOpen, payingFrom }: {
    readonly account?: number; readonly pressOnceOpen?: boolean; readonly payingFrom?: ReactNode;
  }): ReactNode => {
    ran.accounts.push(account);
    ran.pressOnceOpen.push(pressOnceOpen);
    return <>{payingFrom}<p data-action-runs={String(account)} /></>;
  },
}));

import { ACT_INTENTS } from 'midnight-identity/profile/act-intents';
import type { IntentShape } from 'midnight-identity/profile/act-intents';
import type { Ask } from 'midnight-identity/profile/request';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import en from '../locales/en.json';
import { ACTIONS, SPENDING_DOORS, reachOf } from '../actions/registry.js';
import { OFFER_ORDER } from '../accounts/slot-choice.js';
import { SessionProvider } from '../session.js';
import { actView } from './approve-asked-views.js';
import { PaysFromAccount } from './approve-pays-from.js';
import { OFFERED, forgetPayingPick, keepPayingPick } from './paying-pick.js';
import { firstPickOf } from './approve-window-wallets.js';
import { emptyProfile } from 'midnight-identity/profile/model';
import type { Profile } from 'midnight-identity/profile/model';
import { MAIN_ACCOUNT } from '../accounts/subwallets.js';
import { PAYS_COINS, SENDS_NOTHING, isPayingAsk } from './approve-slot.js';

const ASKER = 'https://app.payroll.example';
const SECRET = newSecret();
const PICKED = 'fingerprint-of-the-wallet-picked';
const OTHER = 'fingerprint-of-another-wallet';
/* The account picked in the window before the passkey, and the account open last, which must never pay. */
const PICKED_ACCOUNT = 3;
const OPEN_LAST = 0;

/** Whether an action's own route list can carry a transaction to the chain: a route that sends, or a relay. */
const canSend = (shape: IntentShape): boolean =>
  (shape.relays?.length ?? 0) > 0 || (shape.calls ?? []).some((route) => route.sends === true);

const shapes = ACT_INTENTS as Readonly<Record<string, IntentShape>>;
const SENDING = Object.keys(ACTIONS).filter((name) => shapes[name] !== undefined && canSend(shapes[name]!));
/* A recovery lists no route, yet sends each of its calls straight to the chain from the person's own wallet. */
const PAYS_FROM_THE_PICK = [...SENDING, 'recovery'];

let asked = 0;
const askFor = (name: string): Extract<Ask, { kind: 'act' }> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'act',
  requester: { origin: ASKER, name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To run an action.',
  nonce: `${name}-${(asked += 1)}`,
  expiresAt: Date.now() + 600_000,
  hearsProgress: true,
  intent: { name, fields: {} },
} as unknown as Extract<Ask, { kind: 'act' }>);

const say = (key: string): string => (en as Record<string, string>)[key] ?? key;

/* The account this wallet keeps for the asking site: the slot its grant to that site names. */
const SITE_SLOT = 5;
const profileWithTheSite = (): Profile => ({
  ...emptyProfile(Date.now()),
  grants: [{ recipient: { origin: ASKER, name: 'Payroll', rdns: 'example.payroll' }, subwallet: SITE_SLOT, values: [], madeAt: 0, disclosures: [] }],
});

/** The opened approval screen for this ask, in the wallet whose fingerprint is `opened`, with the account open last. */
const screenFor = (
  request: Extract<Ask, { kind: 'act' }>, opened: string, profile: Profile | null = null, record: 'profile' | 'unopenable' = 'profile',
): ReactNode => actView({
  identity: identityFromSecret(SECRET), secret: SECRET, now: Date.now, framing: undefined, opened: { of: record },
  setChannelState: () => {}, channel: null, subwallet: OPEN_LAST, thisWallet: opened, profile, request,
  consent: { ok: true }, walletRecord: undefined, say, atOnce: false,
} as never);

const shown = (selector: string): Element | null => document.querySelector(selector);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  forgetPayingPick();
  ran.accounts = [];
  ran.pressOnceOpen = [];
});
afterEach(() => { cleanup(); });

describe('which actions pay from the account picked', () => {
  it('reads the routes of every action, and finds the payments and the upkeep among those that can send', () => {
    /* RED WHEN: the list of actions that can send is empty or misses a payment, so the cases below hold nothing. */
    expect(SENDING).toEqual(expect.arrayContaining(['pay-run', 'one-off-payment', 'private-deposit', 'give-vault-keys']));
  });

  it('holds every action to the pick but those named as sending nothing, none of which can send by its routes', () => {
    const notHeld = Object.keys(ACTIONS).filter((name) => !isPayingAsk(askFor(name)));
    /* RED WHEN: an action is let off the pick without being named as one that sends nothing. */
    expect(notHeld.sort()).toEqual([...SENDS_NOTHING].sort());
    /* RED WHEN: an action named as sending nothing has a route that sends or a relay. */
    expect([...SENDS_NOTHING].filter((name) => canSend(shapes[name]!))).toEqual([]);
    /* RED WHEN: an action this wallet has no shape for is let off the pick rather than held to it. */
    expect(isPayingAsk(askFor('an-action-added-later'))).toBe(true);
  });

  it.each(PAYS_FROM_THE_PICK)('%s is an ask that pays, so its account is picked before the passkey', (name) => {
    /* RED WHEN: an action that can send takes its paying account from the account open last or the one offered to
     * the page, rather than from the pick before the passkey. */
    expect(isPayingAsk(askFor(name))).toBe(true);
  });
});

describe('an action that can send, opened in a wallet that is not the one picked, sends nothing', () => {
  it.each(PAYS_FROM_THE_PICK)('%s is refused, says what to do, and does not run', (name) => {
    const request = askFor(name);
    keepPayingPick(request, { walletId: 'w-picked', fingerprint: PICKED, account: PICKED_ACCOUNT });
    render(<SessionProvider>{screenFor(request, OTHER)}</SessionProvider>);
    /* RED WHEN: the action runs in a wallet other than the one picked, from any account. */
    expect(ran.accounts).toEqual([]);
    expect(shown('[data-action-runs]')).toBeNull();
    /* RED WHEN: the refusal does not say nothing was sent, or does not name what resolves it. */
    const refusal = shown('[data-pays-from-refused]');
    expect(refusal?.getAttribute('data-pays-from-refused')).toBe('another-wallet');
    expect(document.body.textContent).toContain('Nothing was sent');
    expect(refusal?.textContent).toMatch(/Pick again/u);
    expect(refusal?.textContent).toMatch(/passkey of the wallet/u);
    expect(shown('[data-pick-again]')).not.toBeNull();
  });
});

describe('an action that can send, opened in the wallet picked, goes on from the account picked', () => {
  it.each(PAYS_FROM_THE_PICK)('%s runs from the account picked, not the account open last', (name) => {
    const request = askFor(name);
    keepPayingPick(request, { walletId: 'w-picked', fingerprint: PICKED, account: PICKED_ACCOUNT });
    render(<SessionProvider>{screenFor(request, PICKED)}</SessionProvider>);
    /* RED WHEN: the run is handed the account open last, or no account, rather than the one picked. */
    expect(ran.accounts).toEqual([PICKED_ACCOUNT]);
    expect(shown(`[data-action-runs="${PICKED_ACCOUNT}"]`)).not.toBeNull();
    expect(shown('[data-pays-from-refused]')).toBeNull();
    /* RED WHEN: an action that pays only a fee waits for a second press once open, or a deposit stops asking for one. */
    expect(ran.pressOnceOpen).toEqual([name === 'private-deposit']);
  });
});

describe('the words say what the account picked pays', () => {
  it('an action that pays only a network fee says so; a deposit says the coins come from the account', () => {
    /* No pick for either ask, so the open wallet lists its accounts with the words for what the pick pays. */
    render(<SessionProvider>{screenFor(askFor('pay-run'), PICKED, profileWithTheSite())}</SessionProvider>);
    /* RED WHEN: an action that sends only calls tells the person the coins come from the account they pick. */
    expect(document.body.textContent).toContain(say('ask.pays.choose-open-fee'));
    expect(document.body.textContent).not.toContain(say('ask.pays.choose-open'));
    cleanup();
    render(<SessionProvider>{screenFor(askFor('private-deposit'), PICKED)}</SessionProvider>);
    expect(document.body.textContent).toContain(say('ask.pays.choose-open'));
    cleanup();
    render(<SessionProvider><PaysFromAccount request={askFor('give-vault-keys')} how="before" secret={SECRET} account={PICKED_ACCOUNT} shared={[]} /></SessionProvider>);
    /* RED WHEN: the line naming the account picked says it pays more than a fee not covered for the person. */
    expect(shown('[data-pays-from-account]')?.textContent).toMatch(/^Any network fee not covered for you is paid from/u);
  });
});

describe('an action that pays only a fee keeps paying from the account kept for the site unless another is picked', () => {
  const feeOnly = PAYS_FROM_THE_PICK.filter((name) => name !== 'private-deposit');

  it('a coin payment\'s pick starts on the main account, as it always did', () => {
    /* RED WHEN: a deposit's pick before the passkey starts anywhere but the main account of the wallet that opens. */
    expect(firstPickOf(askFor('private-deposit'))).toBe(MAIN_ACCOUNT);
  });

  it.each(feeOnly)('%s starts on the account kept for the site, before the passkey and in an open wallet', (name) => {
    /* RED WHEN: a fee-only action's pick before the passkey starts on a fixed account rather than the site's own. */
    expect(firstPickOf(askFor(name))).toBe(OFFERED);
    const request = askFor(name);
    keepPayingPick(request, { walletId: 'w-picked', fingerprint: PICKED, account: OFFERED });
    render(<SessionProvider>{screenFor(request, PICKED, profileWithTheSite())}</SessionProvider>);
    /* RED WHEN: the pick left on the site's account runs from any account but the one kept for the site. */
    expect(ran.accounts).toEqual([SITE_SLOT]);
    cleanup();
    ran.accounts = [];
    render(<SessionProvider>{screenFor(askFor(name), PICKED, profileWithTheSite())}</SessionProvider>);
    /* RED WHEN: a wallet already open offers a fee-only action any account but the site's first. */
    expect((shown(`[data-pays-from-open="${SITE_SLOT}"]`) as HTMLInputElement | null)?.checked).toBe(true);
  });

  it('runs nothing while the account kept for the site is still being read', () => {
    const request = askFor('pay-run');
    keepPayingPick(request, { walletId: 'w-picked', fingerprint: PICKED, account: OFFERED });
    render(<SessionProvider>{screenFor(request, PICKED, null)}</SessionProvider>);
    /* RED WHEN: a fee-only action runs before the account kept for the site is known. */
    expect(ran.accounts).toEqual([]);
    expect(shown('[data-reading-offered]')).not.toBeNull();
  });
});

/** Which of the doors to the person's own accounts a reach holds anywhere inside it, read without calling anything. */
const doorsIn = (reach: unknown): string[] => {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (x: unknown): void => {
    if (x === null || (typeof x !== 'object' && typeof x !== 'function') || seen.has(x)) return;
    seen.add(x);
    for (const [door, f] of Object.entries(SPENDING_DOORS)) if (x === f) found.add(door);
    if (typeof x === 'object') for (const v of Object.values(x as object)) walk(v);
  };
  walk(reach);
  return [...found].sort();
};

describe('what each action is given to reach holds the two lists true', () => {
  it('an action named as sending nothing is given no door to the person\'s accounts', () => {
    /* RED WHEN: an action taken off the pick is given the person's own wallet, the chain that reaches it, or coins. */
    expect([...SENDS_NOTHING].map((name) => [name, doorsIn(reachOf(name))])).toEqual([...SENDS_NOTHING].map((name) => [name, []]));
    /* RED WHEN: the walk finds no door anywhere, so the check above would pass for anything. */
    expect(doorsIn(reachOf('pay-run'))).toContain('chain');
    expect(doorsIn(reachOf('recovery'))).toContain('ownWallet');
  });

  it('every action given the doors that move coins is named a coin payer, and no other is', () => {
    const coins = Object.keys(ACTIONS).filter((name) => doorsIn(reachOf(name)).includes('balance'));
    /* RED WHEN: an action that can move the person's coins is described as paying only a fee, and starts at once. */
    expect(coins.sort()).toEqual([...PAYS_COINS].sort());
    expect(coins).not.toEqual([]);
  });
});

/** A record in which every account has already been given to another site. */
const everyAccountGiven = (): Profile => ({
  ...emptyProfile(Date.now()),
  grants: OFFER_ORDER.map((subwallet) => ({
    recipient: { origin: 'https://other.example', name: 'Other', rdns: 'example.other' }, subwallet, values: [], madeAt: 0, disclosures: [],
  })),
});

describe('a fee-only action left on the account offered to the site says what that account is, and waits when it should', () => {
  const leftOnOffered = (): Extract<Ask, { kind: 'act' }> => {
    const request = askFor('pay-run');
    keepPayingPick(request, { walletId: 'w-picked', fingerprint: PICKED, account: OFFERED });
    return request;
  };

  it('on the site\'s own account it starts on the Approve before the passkey, and says it was not picked', () => {
    render(<SessionProvider>{screenFor(leftOnOffered(), PICKED, profileWithTheSite())}</SessionProvider>);
    /* RED WHEN: an act on the site's own account waits for a second press, or says the person picked the account. */
    expect(ran.pressOnceOpen).toEqual([false]);
    expect(shown('[data-pays-from-account]')?.textContent).toContain('as you did not pick one');
    expect(shown('[data-pays-from-record-unread]')).toBeNull();
  });

  it('on an account other sites were given it waits for a press, with the warning shown', () => {
    render(<SessionProvider>{screenFor(leftOnOffered(), PICKED, everyAccountGiven())}</SessionProvider>);
    /* RED WHEN: an act runs at once from an account another site holds, before the person has seen that it does. */
    expect(ran.pressOnceOpen).toEqual([true]);
    expect(shown('[data-pays-from-shared]')?.textContent).toContain('https://other.example');
  });

  it('when this wallet\'s record could not be read it waits for a press, and says why', () => {
    render(<SessionProvider>{screenFor(leftOnOffered(), PICKED, emptyProfile(Date.now()), 'unopenable')}</SessionProvider>);
    /* RED WHEN: an act runs at once from an account whose other sites could not be known. */
    expect(ran.pressOnceOpen).toEqual([true]);
    expect(shown('[data-pays-from-record-unread]')).not.toBeNull();
  });
});

describe('the line naming the account says how it was picked', () => {
  it('picked before the passkey says so; picked in a wallet already open says it was picked here', () => {
    const before = askFor('pay-run');
    keepPayingPick(before, { walletId: 'w-picked', fingerprint: PICKED, account: PICKED_ACCOUNT });
    render(<SessionProvider>{screenFor(before, PICKED, profileWithTheSite())}</SessionProvider>);
    /* RED WHEN: an account picked before the passkey is not said to have been. */
    expect(shown('[data-pays-from-account]')?.textContent).toContain('You picked it before your passkey.');
    cleanup();
    render(<SessionProvider>{screenFor(askFor('pay-run'), PICKED, profileWithTheSite())}</SessionProvider>);
    act(() => { fireEvent.click(shown('[data-pay-from-open]') as HTMLElement); });
    /* RED WHEN: an account picked in a wallet already open is said to have been picked before the passkey. */
    expect(shown('[data-pays-from-account]')?.textContent).toContain('You picked it here.');
    expect(shown('[data-pays-from-account]')?.textContent).not.toContain('before your passkey');
  });
});
