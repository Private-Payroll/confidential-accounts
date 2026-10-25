import { describe, expect, it, vi, beforeEach } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **A PRIVATE DEPOSIT IS MADE WHOLE IN THE WALLET, AND NOTHING THE PAGE ANSWERS CAN MAKE IT LOSE TRACK OF ONE IT
 * BUILT.** The wallet builds, proves and pays the deposit and signs the records it files, from its own reads and its
 * saved keys; the page relays the one transaction and the filings. The shared deposit step is stood in here so each
 * door the wallet hands it can be tried: the payment is made only for the coin the wallet built, the deposit kept on
 * its way is kept in the wallet's own storage, and a page that says it sent nothing is never believed.
 */

const t = vi.hoisted(() => ({
  run: null as null | ((doors: Record<string, any>, vault: string, money: { token: string; value: bigint }) => Promise<unknown>),
  doors: null as null | Record<string, any>,
}));
vi.mock('../../../../packages/web-shared/src/vault-operation.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-operation.js')>()),
  depositIntoCompanyVault: (doors: Record<string, any>, vault: string, money: { token: string; value: bigint }) => { t.doors = doors; return t.run!(doors, vault, money); },
}));

const { privateDepositAction, depositDoorsFor } = await import('./private-deposit.js');
const op = await import('../../../../packages/web-shared/src/vault-operation.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const VAULT = 'de'.repeat(32);
const TOKEN = '9b'.repeat(32);
const LEAF = 'aa'.repeat(32);
const SEAT = { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) };
const intent = (fields: Record<string, string> = {}): ActIntent =>
  ({ name: 'private-deposit', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, vault: VAULT, token: TOKEN, amount: '1500000', ...fields } }) as ActIntent;

/** A transaction the ledger reads back as one call of the vault creating one coin of `value` of `token`, owing it. */
const builtTx = (value: bigint, token = TOKEN, to = VAULT) => ({
  intents: new Map([[1, { actions: [{ address: to, entryPoint: 'deposit' }] }]]),
  guaranteedOffer: { inputs: [], outputs: [{ contractAddress: to }], transients: [] },
  imbalances: (segment: number) => (segment === 0 ? new Map([[{ tag: 'shielded', raw: token }, -value]]) : new Map()),
});

const balance = (tx: unknown, paid: string[]) => (): never => ({
  ledger: async () => ({ Transaction: { deserialize: () => tx } }),
  facade: async () => ({
    shielded: { state: { subscribe: (o: { next: (s: unknown) => void }) => { o.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } } },
    balanceUnboundTransaction: async () => { paid.push('balanced'); return { recipe: true }; },
    signRecipe: async (r: unknown) => r,
    finalizeRecipe: async () => ({ serialize: () => new Uint8Array([1, 2, 3]) }),
    revert: async () => { paid.push('reverted'); },
  }),
  keys: () => ({ shieldedSecretKeys: {}, dustSecretKey: {} }),
  signSegment: () => (() => {}) as never,
  stop: async () => { paid.push('stopped'); },
}) as never;

const kept = () => {
  const claims: unknown[] = [];
  return { claims, inFlight: { isTheWallets: true, claim: async (_v: string, d: unknown) => { claims.push(d); return 'c1'; } }, coins: { isTheWalletsCoins: true } };
};

const ctxWith = (over: Partial<StepContext> & { answers?: Record<string, { status: number; body: unknown }> } = {}) => {
  const calls: string[] = [];
  const told: Record<string, unknown> = {};
  const ctx = {
    intent: intent(), asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0, wallet: { drewTheLabel: () => true, pinnedFor: () => null, pin: async () => {} } },
    at: { step: 2, steps: 2 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a deposit is sent through its call, never a bare relay'); },
    call: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return over.answers?.[`${method} ${path}`] ?? { status: 404, body: { error: 'none' } };
    },
    tell: (o: Record<string, unknown>) => { Object.assign(told, o); },
    keyring: null,
    ...over,
  } as unknown as StepContext;
  return { ctx, calls, told };
};

const reachOf = (over: Record<string, unknown> = {}) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: SEAT, leaf: LEAF, companyKey: '11'.repeat(32),
  /* A read kept for a later step is handed to it; this one reaches no page, so there is nothing to hand over. */
  stepTo: () => {},
  api: async (path: string, init?: RequestInit) => { throw Object.assign(new Error(`no answer for ${init?.method ?? 'GET'} ${path}`), { status: 404 }); },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: [LEAF], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [VAULT], account: ACCOUNT }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null }), filingJudgeFor: () => async () => null },
  sealed: {}, companyKeys: {} as never,
  roster: async () => ({ id: 'acc_1', signers: [] }),
  builder: { isTheWalletsBuilder: true },
  chain: { indexer: { indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' } },
  ...over,
}) as never;

const MONEY = { token: TOKEN as never, value: 1_500_000n };
beforeEach(() => { t.run = null; t.doors = null; });

describe('the window lists everything the deposit pays and files before the passkey', () => {
  it('names the amount, the token and the vault as the page asks for them, and every record the deposit may file', async () => {
    const action = privateDepositAction({ chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: () => ({}) as never });
    const shown = await action.shown(intent());
    const keys = shown.map((l) => [l.key, l.from]);
    /* RED WHEN: the amount and token, which only the page asks for, are shown as if this wallet had read them, or not shown before the passkey. */
    expect(shown.find((l) => l.key === 'act.private-deposit.shown.amount')).toEqual({ key: 'act.private-deposit.shown.amount', values: { amount: '1500000', token: TOKEN }, from: 'page' });
    /* RED WHEN: what the wallet pays with that amount is shown as the page's words or as a read. */
    expect(keys).toContainEqual(['act.private-deposit.shown.pays', 'action']);
    /* RED WHEN: the vault, which only the page names until the wallet reads it after the passkey, is shown as the wallet's. */
    expect(shown.find((l) => l.key === 'act.private-deposit.shown.vault')).toEqual({ key: 'act.private-deposit.shown.vault', values: { vault: VAULT }, from: 'page' });
    /* RED WHEN: a record the deposit may sign and file is left off the window. */
    for (const record of ['journal', 'pool', 'earlier', 'secret-again', 'manifest']) {
      expect(keys, record).toContainEqual([`act.private-deposit.shown.${record}`, 'action']);
    }
    /* RED WHEN: the deposit seals before the company's owed upkeep is done, or ends without anchoring what it filed. */
    const steps = action.steps(intent());
    expect(steps.map((s) => s.title.key)).toEqual([
      'act.private-deposit.step.seat', 'act.upkeep.step.first', 'act.private-deposit.step.deposit', 'act.upkeep.step.last',
    ]);
    /* RED WHEN: the upkeep the deposit may also do is not listed before the passkey, or is listed as the page's words or a read. */
    for (const line of ['may', 'entry', 'rotation', 'roster', 'vaults', 'anchor']) {
      expect(keys, line).toContainEqual([`act.upkeep.shown.${line}`, 'action']);
    }
  });

  it('refuses before anything is read an amount of nothing, or a wallet with no account chosen', async () => {
    const action = privateDepositAction({ chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: () => ({}) as never });
    const held = { identity, secret, account: 0, wallet: { drewTheLabel: () => true, pinnedFor: () => null, pin: async () => {} } };
    expect(await action.check(intent(), held as never)).toBeNull();
    /* RED WHEN: a deposit of nothing is built and paid. */
    expect((await action.check(intent({ amount: '0' }), held as never))?.key).toBe('act.private-deposit.why.nothing');
    /* RED WHEN: a deposit is paid from an account the person did not choose. */
    expect((await action.check(intent(), { ...held, account: undefined } as never))?.key).toBe('act.private-deposit.why.no-account');
  });
});

describe('the window says exactly what the wallet does, no more', () => {
  it('names the account the way the payment window does, and keeps the deposit on its way on this device only', async () => {
    const { readFileSync } = await import('node:fs');
    const words = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
    /* RED WHEN: the window promises a choice of account that a press made before the passkey, on a quiet account, never shows. */
    expect(words['act.private-deposit.shown.pays']).not.toMatch(/which you choose once/);
    expect(words['act.private-deposit.shown.pays']).toMatch(/this page has used before, or else of one no site has been given/);
    /* RED WHEN: the window says no other deposit is made anywhere, when the claim lives in this device's wallet storage only. */
    for (const key of ['act.private-deposit.shown.nothing-else', 'act.private-deposit.why.not-yet-seen', 'act.private-deposit.check.one-on-its-way']) {
      expect(words[key], key).toMatch(/on this device/);
    }
  });

  it('never reads, after a deposit that may still arrive, as advice to deposit again', async () => {
    const { readFileSync } = await import('node:fs');
    const words = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
    for (const key of ['act.private-deposit.why.not-yet-seen', 'act.private-deposit.why.landed-not-recorded']) {
      /* RED WHEN: the deposit's record is said to wait for the person's next deposit, which reads as a reason to make one. */
      expect(words[key], key).not.toMatch(/next deposit/);
      expect(words[key], key).toMatch(/The next action you take for this company in this wallet, on this device, records it; you do not need to deposit again/);
    }
    /* RED WHEN: pressing again after a stopped deposit is said to carry it on, when the page then makes a new deposit. */
    expect(words['act.private-deposit.over.continue']).toMatch(/makes a new deposit: before you do, press Check my last deposit/);
  });
});

describe('the deposit is paid only as the wallet built it, from its own account', () => {
  it('pays for the coin of the amount and token asked, into the vault asked, and nothing else', async () => {
    const { ctx } = ctxWith();
    const paid: string[] = [];
    const doors = depositDoorsFor(ctx, reachOf(), {
      chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: balance(builtTx(1_500_000n), paid), kept: () => kept() as never,
    }, VAULT as never, MONEY);
    const ask = { company: LABEL, account: ACCOUNT, vault: VAULT, transaction: 'AAAA' } as never;
    expect((await doors.pay(ask)).transaction).toBe('AQID');
    expect(paid).toEqual(['balanced', 'stopped']);
    /* RED WHEN: the wallet pays for a deposit of another amount, another token or into another vault than the one it showed. */
    for (const [tx, name] of [[builtTx(1_500_001n), 'amount'], [builtTx(1_500_000n, 'aa'.repeat(32)), 'token'], [builtTx(1_500_000n, TOKEN, 'ef'.repeat(32)), 'vault']] as const) {
      const other = depositDoorsFor(ctx, reachOf(), {
        chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: balance(tx, []), kept: () => kept() as never,
      }, VAULT as never, MONEY);
      await expect(other.pay(ask), name).rejects.toThrow();
    }
    /* RED WHEN: the wallet pays for an ask naming another company or vault than the one this action is on. */
    await expect(doors.pay({ ...(ask as object), vault: 'ef'.repeat(32) } as never)).rejects.toThrow();
  });

  it('keeps the deposit on its way and its coins in the wallet\'s own storage, and reads the chain through the wallet\'s own indexer', async () => {
    const { ctx } = ctxWith();
    const k = kept();
    const doors = depositDoorsFor(ctx, reachOf(), {
      chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: () => ({}) as never, kept: () => k as never,
    }, VAULT as never, MONEY);
    /* RED WHEN: the deposit's claim on its way is kept where the page keeps it, so a page that forgets it lets a second deposit be built. */
    expect(doors.inFlight).toBe(k.inFlight);
    expect(doors.kept).toBe(k.coins);
    expect(await doors.indexer()).toEqual({ indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' });
    expect((doors.builder as unknown as { isTheWalletsBuilder: boolean }).isTheWalletsBuilder).toBe(true);
    expect(await doors.onChain(VAULT as never)).toMatchObject({ holders: { seats: [LEAF] } });
    /* RED WHEN: a deposit reads the readers' keys from the service. */
    await expect(doors.service.keys()).rejects.toThrow(/reads no readers/);
  });
});

describe('a page that answers the send wrongly never makes the wallet let go of a deposit it built', () => {
  it('a send answered "nothing was sent" is still a deposit that may be on its way', async () => {
    const { ctx, calls } = ctxWith({ answers: { [`POST /api/accounts/acc_1/vaults/${VAULT}/deposit`]: { status: 500, body: { error: 'Nothing was sent: the network refused it.' } } } });
    const reach = reachOf({ api: (await import('./company-reach.js')).apiOver(ctx) });
    const doors = depositDoorsFor(ctx, reach, {
      chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: () => ({}) as never, kept: () => kept() as never,
    }, VAULT as never, MONEY);
    const failed = await doors.service.deposit(VAULT as never, 'AAAA').catch((e: unknown) => e);
    expect(calls).toEqual([`POST /api/accounts/acc_1/vaults/${VAULT}/deposit`]);
    /* RED WHEN: the page's word that it sent nothing is believed, so the claim is let go and a second deposit can be built while the page holds the first. */
    expect((failed as { nothingWasSent?: unknown }).nothingWasSent).not.toBe(true);
  });

  it('a send answered with a forged transaction name is kept as no name, and the chain is read for the deposit itself', async () => {
    const { ctx } = ctxWith({ answers: { [`POST /api/accounts/acc_1/vaults/${VAULT}/deposit`]: { status: 200, body: { txRef: 'x'.repeat(5000), transactionHash: 'not a hash' } } } });
    const reach = reachOf({ api: (await import('./company-reach.js')).apiOver(ctx) });
    const doors = depositDoorsFor(ctx, reach, {
      chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: () => ({}) as never, kept: () => kept() as never,
    }, VAULT as never, MONEY);
    /* RED WHEN: a forged answer is kept as the deposit's name, or stands for the chain's word. */
    expect(await doors.service.deposit(VAULT as never, 'AAAA')).toEqual({ txRef: '', transactionHash: null });
  });
});

/** The deposit's own steps, without the upkeep every seat action does, which has its own tests. */
const ownSteps = (action: ReturnType<typeof privateDepositAction>) => action.steps(intent()).filter((s) => !s.title.key.startsWith('act.upkeep.'));

describe('the deposit step tells the page only where it got to', () => {
  const run = async (body: typeof t.run, ctxOver: Partial<StepContext> = {}) => {
    t.run = body;
    const { ctx, told } = ctxWith(ctxOver);
    const action = privateDepositAction({
      chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: () => ({}) as never, kept: () => kept() as never,
      reachFor: async () => reachOf(),
    } as never);
    for (const s of ownSteps(action)) await s.run(ctx);
    return told;
  };

  it('a deposit recorded tells the vault, recorded, and the transaction the chain made it in', async () => {
    const told = await run(async () => ({ txRef: 'r', transactionHash: null, note: { nonce: '01'.repeat(32), token: TOKEN, value: 1n, createdIn: 'AB'.repeat(32) } }));
    /* RED WHEN: the page is told anything but the vault, where the deposit got to and the chain's transaction. */
    expect(told).toEqual({ vault: VAULT, state: 'recorded', created: 'ab'.repeat(32) });
  });

  it('a deposit not yet seen, or landed and not yet recorded, says so and refuses, so the page says it may have been sent', async () => {
    for (const [e, state] of [[new op.DepositNotYetSeen(VAULT as never, 'r1'), 'not-yet-seen'], [new op.DepositLandedNotYetRecorded(VAULT as never, 'r1'), 'landed-not-recorded']] as const) {
      const told = await run(async () => { throw e; }).catch((x: unknown) => x);
      /* RED WHEN: a deposit that may be on its way ends as though nothing was built. */
      expect(told, state).toBeInstanceOf(StepRefused);
    }
    let told: Record<string, unknown> = {};
    t.run = async () => { throw new op.DepositNotYetSeen(VAULT as never, 'r1'); };
    const { ctx, told: seen } = ctxWith();
    const action = privateDepositAction({
      chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, balance: () => ({}) as never, kept: () => kept() as never,
      reachFor: async () => reachOf(),
    } as never);
    for (const s of ownSteps(action)) await s.run(ctx).catch(() => undefined);
    told = seen;
    expect(told).toEqual({ vault: VAULT, state: 'not-yet-seen' });
  });
});
