// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetRegistry } from '../../../../src/core/assets.js';
import type {
  AmountRefusal, AmountToPutIn, DepositKind, DepositMethod, DepositNow, DepositPick, DepositStep, LastDepositChecked, PutMoneyIn,
} from './deposit.js';

/*
 * PUTTING MONEY INTO A VAULT FROM A SCREEN, THROUGH THE ADAPTER. The person's
 * wallet, the service, the seat this device holds and the vault's two deposit
 * steps are stood in for; the amount, what each deposit is given, the one
 * holders ask its own reads of the vault share, the deposit kept in this tab
 * and what its end says are the adapter's own, as they run.
 */
const VAULT = 'ab'.repeat(32);
const OTHER_VAULT = 'cd'.repeat(32);
const LABEL = `co_${'c1'.repeat(32)}`;
const ACCOUNT = 'c0'.repeat(32);
const TDUST = 'c1'.repeat(32);
const PUB = 'c2'.repeat(32);
const COMPANY_KEY = '11'.repeat(32);
const INDEXER = { indexerUri: 'https://indexer.wallet.example/api/v3/graphql', indexerWsUri: 'wss://indexer.wallet.example/api/v3/graphql/ws' };
const HOLDERS = { committee: [], threshold: 1, seats: [], approvals: 1, adoptedVaults: [VAULT], founding: null, account: ACCOUNT };
const HASH = 'ee'.repeat(32);
/** The hash the service answers with: never what the chain shows. */
const SERVICE_HASH = 'ff'.repeat(32);

type Doors = Record<string, unknown> & {
  progress: (stage: string) => void; indexer: () => Promise<unknown>; onChain: (v: string) => Promise<unknown>;
  pay: (ask: unknown) => Promise<unknown>;
};
const st = vi.hoisted(() => ({
  signedIn: true,
  companyKey: null as string | null,
  released: 0,
  holdersAsked: 0,
  holdersFail: 0,
  paid: [] as unknown[],
  runs: [] as Array<{ kind: 'private' | 'public'; doors: Doors; vault: string; money: { token: string; value: bigint } }>,
  privateRun: null as null | ((doors: Doors, vault: string, money: { token: string; value: bigint }) => Promise<unknown>),
  publicRun: null as null | ((doors: Doors, vault: string, money: { token: string; value: bigint }) => Promise<unknown>),
  check: null as null | ((doors: Doors, vault: string) => Promise<unknown>),
  seat: null as null | ((personId: string, companyId: string, release?: () => Promise<unknown>) => Promise<unknown>),
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  holdersFromTheWallet: async () => {
    st.holdersAsked += 1;
    if (st.holdersFail > 0) { st.holdersFail -= 1; throw new Error('the wallet did not answer'); }
    return { holders: HOLDERS, vault: null, indexer: INDEXER };
  },
  payIntoAVaultFromTheWallet: async (_origin: string, ask: unknown) => { st.paid.push(ask); return { transaction: 'cGFpZA==', leaves: [] }; },
  companyKeyReleasedFor: () => st.companyKey,
  companyKeysForVaults: async () => { st.released += 1; st.companyKey = COMPANY_KEY; return { companyKey: COMPANY_KEY }; },
  api: async (path: string) => {
    if (path === '/api/accounts/c1') return { id: 'c1', companyLabel: LABEL, contractAddress: ACCOUNT };
    throw new Error(`no answer for ${path}`);
  },
}));
vi.mock('./keyring-person.js', () => ({ keyringFor: async () => st.signedIn }));
vi.mock('./vault-builder.js', () => ({ theVaultBuilder: async () => ({ isTheBuilder: true }) }));
vi.mock('vaults-web-shared/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-page-doors.js')>()),
  browserInFlightRecords: () => ({ isThisBrowser: true }),
  browserDepositsInFlight: (opener: unknown) => ({ isDepositsInFlight: true, opener }),
  vaultServiceFor: (_api: unknown, companyId: string) => ({ isTheService: true, companyId }),
}));
vi.mock('vaults-web-shared/vault-coins-kept-here.js', () => ({ coinsKeptOnThisDevice: (_r: unknown, opener: unknown) => ({ isCoinsKept: true, opener }) }));
vi.mock('./vault-private-money.js', () => ({ seatAndRecordsHere: (...a: [string, string, (() => Promise<unknown>)?]) => st.seat!(...a) }));
vi.mock('vaults-web-shared/vault-operation.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-operation.js')>()),
  depositIntoCompanyVault: (doors: Doors, vault: string, money: { token: string; value: bigint }) => {
    st.runs.push({ kind: 'private', doors, vault, money });
    return st.privateRun!(doors, vault, money);
  },
  depositPubliclyIntoCompanyVault: (doors: Doors, vault: string, money: { token: string; value: bigint }) => {
    st.runs.push({ kind: 'public', doors, vault, money });
    return st.publicRun!(doors, vault, money);
  },
  checkWhatThisBrowserDeposited: (doors: Doors, vault: string) => st.check!(doors, vault),
  checkWhatThisBrowserSent: async () => { throw new Error('a payment this browser kept was read'); },
}));

/** The seat this device holds for the company: what a private deposit is given is built from it. */
const SIGNERS = async () => [];
const HERE = {
  sealed: {}, company: LABEL, account: ACCOUNT, opened: { id: 'c1', signers: [], notBelieved: [] }, builder: { isTheBuilder: true },
  companyKey: COMPANY_KEY, signingSecret: 'aa'.repeat(32), mine: { signerId: 'seat-1', wrappingSecret: '22'.repeat(32) },
  directory: async () => ({}), readers: { signers: SIGNERS }, records: () => ({}),
};

const asset = (symbol: string, decimals: number, shielded: string | null, unshielded: string | null): Asset => ({
  code: (shielded ?? unshielded)!, symbol, name: symbol, decimals, ledger: { shielded, unshielded }, enabled: true, sortOrder: symbol.length,
});
const registryOf = (list: Asset[]): AssetRegistry => ({
  all: () => list, enabled: () => list, find: (c) => list.find((a) => a.code === c) ?? null, require: (c) => list.find((a) => a.code === c)!,
});
/** A private token with six decimals, and a public-only one with two. */
const REG = registryOf([asset('TDUST', 6, TDUST, null), asset('PUB', 2, null, PUB)]);
const PRIVATE_TDUST: DepositPick = { code: TDUST, kind: 'private' };
const PUBLIC_PUB: DepositPick = { code: PUB, kind: 'public' };

const aTurn = () => new Promise((r) => { setTimeout(r, 0); });
const flush = async () => { await aTurn(); await aTurn(); await aTurn(); };

/** A private deposit as the shared step runs one: each stage reported, the wallet's holders and indexer read at every read, the wallet paying. */
const aPrivateDeposit = (answer: Record<string, unknown> = { txRef: 'r1', transactionHash: SERVICE_HASH, note: { createdIn: HASH } }) =>
  async (doors: Doors, vault: string): Promise<unknown> => {
    for (const stage of ['checking the vault', 'choosing the coin', 'building the deposit', 'asking your wallet']) {
      doors.progress(stage);
      await doors.indexer();
      await doors.onChain(vault);
    }
    await doors.pay({ vault });
    doors.progress('sending the deposit');
    doors.progress('recording the deposit');
    await Promise.all(Array.from({ length: 5 }, () => doors.indexer()));
    doors.progress('done');
    return answer;
  };
const aPublicDeposit = () => async (doors: Doors, vault: string, money: { token: string; value: bigint }): Promise<unknown> => {
  for (const stage of ['checking the vault', 'building the deposit', 'asking your wallet']) {
    doors.progress(stage);
    await doors.indexer();
    await doors.onChain(vault);
  }
  await doors.pay({ vault });
  doors.progress('sending the deposit');
  doors.progress('waiting for the chain');
  doors.progress('done');
  return { txRef: 'r2', transactionHash: HASH, token: money.token, value: money.value };
};

async function load() {
  vi.resetModules();
  return { m: await import('./deposit.js'), op: await import('vaults-web-shared/vault-operation.js') };
}
/* The adapter and the shared code under it take seconds to compile the first time; that is spent here, not in the first test's time. Each test still loads them afresh. */
beforeAll(async () => { await load(); }, 120_000);
beforeEach(() => {
  st.signedIn = true; st.companyKey = COMPANY_KEY; st.released = 0; st.holdersAsked = 0; st.holdersFail = 0; st.paid = []; st.runs = [];
  st.privateRun = aPrivateDeposit(); st.publicRun = aPublicDeposit(); st.check = null;
  st.seat = async (_p, _c, release) => {
    if (st.companyKey === null && release !== undefined) await release();
    return HERE;
  };
});
afterEach(() => { vi.useRealTimers(); });

describe('the amount a person types', () => {
  it('is put in in the token\'s smallest units only when it is a plain amount above nothing and within what is held', async () => {
    const { m } = await load();
    const HELD = 5_000_000n;
    const answerOf = (typed: string, held: bigint | null, pick: DepositPick) => {
      const answer: AmountToPutIn = m.amountToPutIn(typed, pick, held, REG);
      return answer.of === m.PUT_IN.refused ? answer.why : answer.units;
    };
    const rows: Array<[string, AmountRefusal | bigint, string, (bigint | null)?, DepositPick?]> = [
      ['', 'empty', 'nothing typed is taken as an amount'],
      ['   ', 'empty', 'spaces alone are taken as an amount'],
      ['abc', 'not-a-number', 'words are taken as an amount'],
      ['1e3', 'not-a-number', 'a number written as a power of ten is taken as an amount'],
      ['+1', 'not-a-number', 'a sign other than minus is taken as an amount'],
      ['.', 'not-a-number', 'a point alone is taken as an amount'],
      ['-1', 'negative', 'a negative amount is put in, or refused for the wrong reason'],
      ['0', 'zero', 'an amount of nothing is put in'],
      ['0.000', 'zero', 'an amount of nothing written with decimals is put in'],
      ['1.0000001', 'too-many-decimals', 'an amount finer than the token\'s smallest unit is rounded and put in'],
      ['1,000', 'group-separator', 'a comma between digits is read as grouping, or as a decimal point, and put in'],
      ['1 000', 'group-separator', 'a space between digits is read as grouping and put in'],
      ['1\'000', 'group-separator', 'an apostrophe between digits is read as grouping and put in'],
      ['1.000.000', 'group-separator', 'points used to group digits are read as an amount'],
      ['5.000001', 'above-held', 'more than the wallet said is held is put in'],
      ['1', 'held-not-known', 'an amount is put in when the wallet did not say what is held', null],
      ['1', 'token-not-known', 'a token the app does not name is put in', HELD, { code: 'c9'.repeat(32), kind: 'private' }],
      ['1', 'no-private-form', 'a token with no private form is put in privately, or turned into a public deposit', HELD, { code: PUB, kind: 'private' }],
      ['1', 'no-public-form', 'a token with no public form is put in publicly', HELD, { code: TDUST, kind: 'public' }],
      ['1', 'token-not-known', 'a way of putting money in that is neither private nor public is taken', HELD, { code: TDUST, kind: 'sideways' as never }],
      ['1.5', 1_500_000n, 'a plain amount is not turned into the token\'s smallest units exactly'],
      ['1.500000000', 1_500_000n, 'trailing zeros past the token\'s decimals refuse a plain amount'],
      ['.5', 500_000n, 'an amount below one written without its leading zero is refused'],
      [' 5 ', 5_000_000n, 'all of what is held, typed with spaces around it, is refused'],
    ];
    for (const [typed, want, redWhen, held = HELD, pick = PRIVATE_TDUST] of rows) {
      expect(answerOf(typed, held, pick), `RED WHEN: ${redWhen} (${JSON.stringify(typed)})`).toEqual(want);
    }
  });

  it('makes the amount a screen shows from the registry\'s decimals and symbol, private for a private row and public for a public one', async () => {
    const { m } = await load();
    const { visibilityOf, formatTokenAmount } = await import('vaults-ui/format/token-amount');
    const priv = m.amountToPutIn('1.25', PRIVATE_TDUST, 5_000_000n, REG);
    const pub = m.amountToPutIn('0.07', PUBLIC_PUB, 100n, REG);
    if (priv.of !== m.PUT_IN.amount || pub.of !== m.PUT_IN.amount) throw new Error('both are amounts');
    /* RED WHEN: a private row's amount is shown as public, or with another token's decimals or symbol. */
    expect([visibilityOf(priv.amount), priv.amount.symbol, formatTokenAmount(priv.amount, 'en')]).toEqual(['private', 'TDUST', '1.25']);
    /* RED WHEN: a public row's amount is shown as private, or with another token's decimals or symbol. */
    expect([visibilityOf(pub.amount), pub.amount.symbol, formatTokenAmount(pub.amount, 'en'), pub.units]).toEqual(['public', 'PUB', '0.07', 7n]);
  });

  it('takes Max as exactly what the wallet said is held, and nothing when nothing is held or the wallet did not say', async () => {
    const { m } = await load();
    const held = 1_234_567_891_234_567n;
    const max = m.amountToPutIn(m.MAX, PRIVATE_TDUST, held, REG);
    /* RED WHEN: Max puts in anything but all of what is held, to the smallest unit. */
    expect(max.of === m.PUT_IN.amount ? max.units : max.why).toBe(held);
    /* RED WHEN: Max with nothing held, or with a balance the wallet did not say, is put in. */
    expect(m.amountToPutIn(m.MAX, PRIVATE_TDUST, 0n, REG)).toEqual({ of: 'refused', why: 'zero' });
    expect(m.amountToPutIn(m.MAX, PUBLIC_PUB, null, REG)).toEqual({ of: 'refused', why: 'held-not-known' });
    /* RED WHEN: the deposit started from Max is given anything but all of what is held. */
    const r = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, m.MAX, held, REG);
    if (r.of !== m.PUT_IN.started) throw new Error('it starts');
    await r.ended;
    expect(st.runs.map((x) => x.money)).toEqual([{ token: TDUST, value: held }]);
  });
});

describe('a deposit\'s own reads of the vault ask the wallet who holds it once', () => {
  it('reads the vault and the indexer of a private deposit on one ask of the person\'s wallet for who holds the vault, and asks again for the next deposit', async () => {
    const { m } = await load();
    const r = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1.5', 5_000_000n, REG);
    if (r.of !== m.PUT_IN.started) throw new Error('it starts');
    expect(await r.ended).toMatchObject({ of: 'done', chainTransaction: HASH });
    /*
     * RED WHEN: one deposit's reads of the vault and of the indexer ask the wallet who holds the vault more than once, each ask a hidden wallet window.
     * The seat and the company records a private deposit opens ask the wallet on their own, and are stood in here, so their asks are not counted.
     */
    expect(st.holdersAsked).toBe(1);
    /* RED WHEN: the vault is read at any indexer but the one the person's wallet named, or its holders taken from anywhere else. */
    expect(await st.runs[0]!.doors.indexer()).toEqual(INDEXER);
    expect(await st.runs[0]!.doors.onChain(VAULT)).toEqual({ holders: HOLDERS });
    /* RED WHEN: who the vault's signers are is kept rather than read afresh each time the deposit asks. */
    expect(st.runs[0]!.doors.signers).toBe(SIGNERS);
    const again = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    if (again.of !== m.PUT_IN.started) throw new Error('it starts');
    await again.ended;
    /* RED WHEN: the wallet's answer for one deposit is kept and used by the next. */
    expect(st.holdersAsked).toBe(2);
  });

  it('asks the wallet again after an ask that failed, and never keeps the failure', async () => {
    const { m } = await load();
    st.holdersFail = 1;
    st.privateRun = async (doors) => {
      await doors.indexer().catch(() => null);
      const indexer = await doors.indexer();
      await doors.onChain(VAULT);
      return { txRef: 'r', transactionHash: SERVICE_HASH, note: { createdIn: HASH }, indexer };
    };
    const r = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    if (r.of !== m.PUT_IN.started) throw new Error('it starts');
    /* RED WHEN: a failed answer from the wallet is kept, so the deposit fails every read after it; or a good answer is asked again. */
    expect(await r.ended).toMatchObject({ of: 'done' });
    expect(st.holdersAsked).toBe(2);
  });
});

describe('the way money goes in is the row the person picked', () => {
  it('never deposits a private pick publicly, and gives a public deposit only what a public deposit needs', async () => {
    const { m } = await load();
    /* RED WHEN: a private pick of a token with no private form is put in publicly, or anything at all is started. */
    expect(m.putMoneyIn('u1', 'c1', VAULT, { code: PUB, kind: m.DEPOSIT_KIND.private }, '1', 500n, REG)).toEqual({ of: 'refused', why: m.AMOUNT_REFUSAL.noPrivateForm });
    expect([st.runs, st.paid]).toEqual([[], []]);
    const priv = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    if (priv.of !== m.PUT_IN.started) throw new Error('it starts');
    await priv.ended;
    /* RED WHEN: a private pick is put in by the public deposit, or of another token. */
    expect(st.runs.map((x) => [x.kind, x.money])).toEqual([['private', { token: TDUST, value: 1_000_000n }]]);
    /* RED WHEN: a private deposit is not given this signer's seat, this browser's keeping and the person's own wallet. */
    expect(st.runs[0]!.doors).toMatchObject({
      company: LABEL, account: ACCOUNT, me: HERE.mine, records: HERE.records, builder: HERE.builder,
      inFlight: { isDepositsInFlight: true, opener: HERE.mine }, kept: { isCoinsKept: true, opener: HERE.mine },
      service: { isTheService: true, companyId: 'c1' },
    });
    m.putAwayEndedDeposit(VAULT);
    const pub = m.putMoneyIn('u1', 'c1', VAULT, PUBLIC_PUB, '2.5', 1_000n, REG);
    if (pub.of !== m.PUT_IN.started) throw new Error('it starts');
    expect(await pub.ended).toMatchObject({ of: 'done', kind: 'public', chainTransaction: HASH });
    /* RED WHEN: a public pick is put in privately, or of another token or amount. */
    expect(st.runs.slice(1).map((x) => [x.kind, x.money])).toEqual([['public', { token: PUB, value: 250n }]]);
    /* RED WHEN: the public deposit is handed this signer's seat, records or keeping as well as what a public deposit needs. */
    expect(Object.keys(st.runs[1]!.doors).sort()).toEqual(['account', 'builder', 'company', 'indexer', 'onChain', 'pay', 'progress', 'service', 'sleep']);
    /* RED WHEN: a public deposit's reads of the vault and of the indexer ask the wallet who holds the vault more than once. */
    expect(st.holdersAsked).toBe(2);
  });
});

describe('a deposit runs in this tab, whatever the screen does', () => {
  it('keeps running when the panel closes, and keeps its result until it is put away', async () => {
    const { m } = await load();
    let finish: () => void = () => {};
    st.privateRun = async (doors) => {
      doors.progress('checking the vault');
      doors.progress('building the deposit');
      await new Promise<void>((r) => { finish = r; });
      doors.progress('sending the deposit');
      return { txRef: 'r', transactionHash: SERVICE_HASH, note: { createdIn: HASH } };
    };
    const seen: Array<string | undefined> = [];
    const stop = m.watchDeposit(VAULT, () => { seen.push(m.depositNow(VAULT)?.of); });
    const r = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    if (r.of !== m.PUT_IN.started) throw new Error('it starts');
    await flush();
    /* RED WHEN: a running deposit is not shown at the step it is on, as step n of the kind's steps. */
    expect(m.depositNow(VAULT)).toMatchObject({ of: m.DEPOSITED.running, step: m.DEPOSIT_STEP.provingTheDeposit, n: 3, steps: { length: 6 } });
    /* The panel closes: its watcher goes. */
    stop();
    m.putAwayEndedDeposit(VAULT);
    /* RED WHEN: closing the panel, or putting away while it runs, stops or forgets a deposit that is running. */
    expect(m.depositNow(VAULT)?.of).toBe('running');
    finish();
    await r.ended;
    /* RED WHEN: a deposit that ended while no panel watched loses its result. */
    expect(m.depositNow(VAULT)).toMatchObject({ of: 'done', chainTransaction: HASH });
    expect(m.depositNow(VAULT)).toBe(m.depositNow(VAULT));
    /* RED WHEN: a panel that closed is still told of the deposit. */
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x === 'running')).toBe(true);
    /* RED WHEN: another vault's page shows this vault's deposit. */
    expect(m.depositNow(OTHER_VAULT)).toBeNull();
    m.putAwayEndedDeposit(VAULT);
    /* RED WHEN: a result read and put away stays. */
    expect(m.depositNow(VAULT)).toBeNull();
  });

  it('sends nothing for a second press while a deposit into the vault runs', async () => {
    const { m } = await load();
    let finish: () => void = () => {};
    st.privateRun = async (doors) => {
      doors.progress('checking the vault');
      await new Promise<void>((r) => { finish = r; });
      await doors.pay({ vault: VAULT });
      doors.progress('sending the deposit');
      return { txRef: 'r', transactionHash: SERVICE_HASH, note: { createdIn: HASH } };
    };
    const first: PutMoneyIn = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    /* RED WHEN: a second press while the first runs starts another deposit, asks the wallet or sends anything. */
    expect(m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG)).toEqual({ of: 'already-running' });
    expect(m.putMoneyIn('u1', 'c1', VAULT, PUBLIC_PUB, '1', 500n, REG)).toEqual({ of: 'already-running' });
    await flush();
    finish();
    if (first.of !== m.PUT_IN.started) throw new Error('it starts');
    await first.ended;
    expect([st.runs.length, st.paid.length]).toEqual([1, 1]);
    /* RED WHEN: a deposit into another vault waits on this one, or a press after this one ended sends nothing. */
    st.privateRun = aPrivateDeposit();
    expect(m.putMoneyIn('u1', 'c1', OTHER_VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG).of).toBe('started');
    expect(m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG).of).toBe('started');
    await flush();
  });
});

describe('the steps a deposit shows', () => {
  it('lists one step for each stage the deposit reports, in order, each with its usual time or none', async () => {
    const { m } = await load();
    /* RED WHEN: a private deposit's steps are not the six it runs through, in order. */
    expect(m.depositSteps('private', true)).toEqual(['checking-the-vault', 'choosing-the-coin', 'proving-the-deposit', 'paying-in-your-wallet', 'sending', 'waiting-for-the-chain']);
    /* RED WHEN: a public deposit's steps are not the five it runs through, in order. */
    expect(m.depositSteps('public', true)).toEqual(['checking-the-vault', 'proving-the-deposit', 'paying-in-your-wallet', 'sending', 'waiting-for-the-chain']);
    /* RED WHEN: a tab with no company key does not name the wallet window that opens the company's records before anything else. */
    expect(m.depositSteps('private', false)).toEqual(['opening-the-company-records', ...m.depositSteps('private', true)]);
    expect(m.depositSteps('public', false)).toEqual(m.depositSteps('public', true));
    /* RED WHEN: a step has no usual time entry, or a usual time is shown that was not measured. */
    for (const kind of ['private', 'public'] as const satisfies readonly DepositKind[]) {
      for (const s of m.depositSteps(kind, false)) expect(m.usualSecondsOf(kind, s), `${kind} ${s}`).toBe(s === 'proving-the-deposit' ? (kind === 'private' ? 125 : 2) : null);
    }
    /* RED WHEN: the one way money can be put in today is not listed, or lists a kind it cannot bring. */
    expect(m.DEPOSIT_METHODS).toEqual([{ id: 'from-your-wallet', kinds: ['private', 'public'] }]);
    expect(m.DEPOSIT_METHODS.map((x): DepositMethod => x.id)).toEqual(['from-your-wallet']);
  });

  it('moves through the steps as the deposit reports its stages, a private one waiting for the chain while it records itself', async () => {
    const { m } = await load();
    for (const [pick, want] of [
      [PRIVATE_TDUST, [[1, 'checking-the-vault'], [2, 'choosing-the-coin'], [3, 'proving-the-deposit'], [4, 'paying-in-your-wallet'], [5, 'sending'], [6, 'waiting-for-the-chain']]],
      [PUBLIC_PUB, [[1, 'checking-the-vault'], [2, 'proving-the-deposit'], [3, 'paying-in-your-wallet'], [4, 'sending'], [5, 'waiting-for-the-chain']]],
    ] as const) {
      const steps: Array<[number, DepositStep]> = [];
      const stop = m.watchDeposit(VAULT, () => {
        const now = m.depositNow(VAULT);
        if (now?.of === 'running' && steps.at(-1)?.[1] !== now.step) steps.push([now.n, now.step]);
      });
      const r = m.putMoneyIn('u1', 'c1', VAULT, pick, '1', 5_000_000n, REG);
      if (r.of !== m.PUT_IN.started) throw new Error('it starts');
      await r.ended;
      stop();
      m.putAwayEndedDeposit(VAULT);
      /* RED WHEN: a stage the deposit reports is not shown as its step, or a step is shown out of order or with the wrong number. */
      expect(steps, pick.kind).toEqual(want);
    }
  });

  it('names the company records window first in a tab that holds no company key, and asks the wallet to release it', async () => {
    const { m } = await load();
    st.companyKey = null;
    /* RED WHEN: whether this tab holds the company key is said wrongly, so the window opens unnamed or is named for nothing. */
    expect(m.companyKeyHeldHere('c1')).toBe(false);
    const firsts: Array<[number, string]> = [];
    m.watchDeposit(VAULT, () => { const now = m.depositNow(VAULT); if (now?.of === 'running' && firsts.length === 0) firsts.push([now.n, now.step]); });
    const r = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    if (r.of !== m.PUT_IN.started) throw new Error('it starts');
    expect(await r.ended).toMatchObject({ of: 'done' });
    /* RED WHEN: a private deposit in a tab with no company key does not name the window first, or does not ask the wallet to release the key. */
    expect(firsts).toEqual([[1, 'opening-the-company-records']]);
    expect(st.released).toBe(1);
    expect(m.companyKeyHeldHere('c1')).toBe(true);
  });
});

describe('how a deposit ended, and whether anything may have been sent', () => {
  it('shows the transaction the chain shows made a private deposit, never the service\'s answer, and none while the chain cannot name it', async () => {
    const { m } = await load();
    const r = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    if (r.of !== m.PUT_IN.started) throw new Error('it starts');
    /* RED WHEN: a private deposit's done state shows the hash the service answered with as what the chain shows. */
    expect(await r.ended).toMatchObject({ of: 'done', chainTransaction: HASH, notYetSpendable: false });
    m.putAwayEndedDeposit(VAULT);
    st.privateRun = aPrivateDeposit({ txRef: 'r1', transactionHash: SERVICE_HASH, note: {}, notYetSpendable: 'the chain cannot say yet' });
    const unnamed = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    if (unnamed.of !== m.PUT_IN.started) throw new Error('it starts');
    /* RED WHEN: a deposit whose note the chain holds and whose transaction it cannot name yet shows any transaction, or is said to be payable out. */
    expect(await unnamed.ended).toMatchObject({ of: 'done', chainTransaction: null, notYetSpendable: true });
  });

  it('says something may have been sent only when the deposit was sent or may have been', async () => {
    const { m, op } = await load();
    const at = (stages: string[], e: unknown) => async (doors: Doors) => { for (const s of stages) doors.progress(s); throw e; };
    const SENDING = ['checking the vault', 'building the deposit', 'asking your wallet', 'sending the deposit'];
    const cases: Array<[string, 'private' | 'public', (doors: Doors) => Promise<unknown>, boolean, string]> = [
      ['refused before the send', 'private', at(['checking the vault'], new Error('this vault is not adopted')), false, 'a refusal before anything was sent sends the person to check a deposit that never left'],
      ['the wallet declined', 'private', at(['checking the vault', 'asking your wallet'], new Error('declined')), false, 'the wallet declining to pay is said to have sent money'],
      ['another tab', 'private', at(['checking the vault'], new op.DepositStartedElsewhere(VAULT)), false, 'a deposit stopped for another tab is said to have sent money'],
      ['an earlier one on its way', 'private', at([], new op.DepositStillInFlight(VAULT, 'r0', 1)), false, 'a deposit held back for an earlier one is said to have sent money'],
      ['not sent', 'private', at(SENDING, new op.DepositNotSent(VAULT, 'refused')), false, 'a deposit the service says it did not send is said to have sent money'],
      ['not yet seen', 'private', at(SENDING, new op.DepositNotYetSeen(VAULT, 'r1')), true, 'a deposit sent and not yet seen lets the person try again without checking'],
      ['not yet seen, its stage unsaid', 'private', at([], new op.DepositNotYetSeen(VAULT, '')), true, 'a deposit that may have been sent is said to have sent nothing because its stage was not reported'],
      ['an earlier deposit landed and not recorded, found before sending', 'private', at(['checking the vault'], new op.DepositLandedNotYetRecorded(VAULT, 'r0')), true, 'an earlier deposit found in the vault and not yet recorded, before this one is sent, lets the person try again without checking'],
      ['public not yet seen, its stage unsaid', 'public', at([], new op.PublicDepositNotYetSeen(VAULT, 1)), true, 'a public deposit that may still arrive is said to have sent nothing because its stage was not reported'],
      ['landed not recorded', 'private', at(SENDING, new op.DepositLandedNotYetRecorded(VAULT, 'r1')), true, 'a deposit in the vault and not yet recorded lets the person try again without checking'],
      ['failed after the send', 'private', at(SENDING, new Error('the vault\'s record could not be saved')), true, 'a failure after the send is said to have sent nothing'],
      ['public not yet seen', 'public', at(SENDING, new op.PublicDepositNotYetSeen(VAULT, 1, new Error('the indexer did not answer'))), true, 'a public deposit that may still arrive lets the person try again'],
      ['public refused before the send', 'public', at(['checking the vault'], new Error('this vault is not adopted')), false, 'a public refusal before the send is said to have sent money'],
    ];
    for (const [name, kind, run, maybe, redWhen] of cases) {
      if (kind === 'private') st.privateRun = run; else st.publicRun = run;
      const r = m.putMoneyIn('u1', 'c1', VAULT, kind === 'private' ? PRIVATE_TDUST : PUBLIC_PUB, '1', 5_000_000n, REG);
      if (r.of !== m.PUT_IN.started) throw new Error('it starts');
      const end: DepositNow = await r.ended;
      expect(end.of === 'failed' ? end.mayHaveBeenSent : end.of, `RED WHEN: ${redWhen} (${name})`).toBe(maybe);
      /* RED WHEN: a private deposit hands on a time until which it can still arrive, which only a public deposit has. */
      if (kind === 'private') expect(end, name).not.toHaveProperty('until');
      m.putAwayEndedDeposit(VAULT);
    }
  });

  it('hands on the shared code\'s own reasons, causes and all, and a code for a screen to word', async () => {
    const { m, op } = await load();
    st.publicRun = async (doors) => { doors.progress('sending the deposit'); throw new op.PublicDepositNotYetSeen(VAULT, 1, new Error('the indexer did not answer')); };
    const r = m.putMoneyIn('u1', 'c1', VAULT, PUBLIC_PUB, '1', 500n, REG);
    if (r.of !== m.PUT_IN.started) throw new Error('it starts');
    const end = await r.ended;
    if (end.of !== 'failed') throw new Error('it fails');
    /* RED WHEN: the reasons for support lose the error's own words or what caused it. */
    expect(end.reasons).toEqual([expect.stringMatching(/^the public deposit may have been sent/), 'the indexer did not answer']);
    expect(end.refusal).toBe('did-not-finish');
    /* RED WHEN: a public deposit that may have been sent does not hand on the time until which it can still arrive, so a screen cannot say when it is safe to put the same money in again. */
    expect(end.until).toBe(1);
    m.putAwayEndedDeposit(VAULT);
    st.publicRun = async (doors) => { doors.progress('sending the deposit'); throw new Error('the public deposit was not sent, so no money has moved yet. Your wallet already signed it.'); };
    const signed = m.putMoneyIn('u1', 'c1', VAULT, PUBLIC_PUB, '1', 500n, REG);
    if (signed.of !== m.PUT_IN.started) throw new Error('it starts');
    const signedEnd = await signed.ended;
    if (signedEnd.of !== 'failed') throw new Error('it fails');
    /* RED WHEN: a public deposit the wallet signed and the service did not send hands on no time until which it can still be sent by anyone, or a time that is not the transaction's time to live from when it was sent. */
    expect(signedEnd.until).toBeGreaterThan(Date.now() + 74 * 60_000);
    expect(signedEnd.until).toBeLessThanOrEqual(Date.now() + 75 * 60_000);
    m.putAwayEndedDeposit(VAULT);
    /* RED WHEN: a seat this device cannot use starts a deposit, or ends it as anything but nothing sent with its own code. */
    st.seat = async () => 'no-keys-here';
    const s = m.putMoneyIn('u1', 'c1', VAULT, PRIVATE_TDUST, '1', 5_000_000n, REG);
    if (s.of !== m.PUT_IN.started) throw new Error('it starts');
    expect(await s.ended).toMatchObject({ of: 'failed', mayHaveBeenSent: false, refusal: 'no-keys-here', reasons: [] });
    expect(st.runs.filter((x) => x.kind === 'private')).toEqual([]);
    m.putAwayEndedDeposit(VAULT);
    /* RED WHEN: a public deposit starts for somebody not signed in. */
    st.signedIn = false;
    const p = m.putMoneyIn('u1', 'c1', VAULT, PUBLIC_PUB, '1', 500n, REG);
    if (p.of !== m.PUT_IN.started) throw new Error('it starts');
    expect(await p.ended).toMatchObject({ of: 'failed', mayHaveBeenSent: false, refusal: 'not-signed-in' });
    expect(st.runs.filter((x) => x.kind === 'public')).toHaveLength(2);
  });
});

describe('check my last deposit', () => {
  it('checks this browser\'s private deposits only, and hands a screen what it found as codes', async () => {
    const { m } = await load();
    const given: Doors[] = [];
    st.check = async (doors) => { given.push(doors); return { deposit: { state: 'still-on-its-way', until: 1234 }, named: 1, unnamed: 2 }; };
    const found: LastDepositChecked = await m.checkMyLastDeposit('u1', 'c1', VAULT);
    /* RED WHEN: the check reads or settles a payment, or is not a check of deposits alone. */
    expect(found).toMatchObject({ of: m.CHECKED.checked, deposit: 'still-on-its-way', until: 1234, notYetSpendable: false, named: 1, unnamed: 2 });
    expect(given).toHaveLength(1);
    expect('payments' in given[0]!).toBe(false);
    /* RED WHEN: what was found is not also given in the shared code's own sentence, for support. */
    expect(found.of === 'checked' ? found.forSupport : '').toMatch(/has not reached the vault yet/);
    st.check = async () => ({ deposit: { state: 'recorded', note: {}, notYetSpendable: 'the chain cannot say yet' }, named: 0, unnamed: 0 });
    /* RED WHEN: a deposit recorded that cannot be paid out yet is said to be spendable. */
    expect(await m.checkMyLastDeposit('u1', 'c1', VAULT)).toMatchObject({ of: 'checked', deposit: 'recorded', until: null, notYetSpendable: true });
    /* RED WHEN: a check that cannot run says anything but why, as a code and the reasons for support. */
    st.check = async () => { throw new Error('the chain does not show this vault'); };
    expect(await m.checkMyLastDeposit('u1', 'c1', VAULT)).toEqual({ of: 'refused', why: 'did-not-finish', reasons: ['the chain does not show this vault'] });
    st.seat = async () => 'not-signed-in';
    expect(await m.checkMyLastDeposit('u1', 'c1', VAULT)).toEqual({ of: 'refused', why: 'not-signed-in', reasons: [] });
  });

  it('asks the wallet to release the company key in a tab that holds none, so the check works in a fresh tab', async () => {
    const { m } = await load();
    st.companyKey = null;
    st.seat = async (_p, _c, release) => {
      if (st.companyKey === null && release !== undefined) await release();
      return st.companyKey === null ? 'no-keys-here' : HERE;
    };
    st.check = async () => ({ deposit: { state: 'none' }, named: 0, unnamed: 0 });
    /* RED WHEN: Check my last deposit in a tab with no company key refuses instead of opening the company's records in the wallet. */
    expect(await m.checkMyLastDeposit('u1', 'c1', VAULT)).toMatchObject({ of: 'checked', deposit: 'none' });
    expect(st.released).toBe(1);
  });
});
