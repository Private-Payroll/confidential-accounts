/**
 * **A PUBLIC TOKEN PUT INTO A VAULT FROM THE PAGE, AS IT IS.** The page's second
 * source ends in the vault's public deposit, and the page's public step builds,
 * asks the wallet and sends exactly one public deposit of the token and amount
 * asked, recording nothing on this device, and says it is done only once the
 * chain at the wallet's indexer shows it. The service and the vault worker are
 * stood in; the step and the sources are the page's own, run through
 * `depositFromSource`. The same deposit over the real ledger,
 * the real wallet balancing and the service's own routes is watched in
 * `contracts/test/a-private-payment-from-the-page.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { StaticAssetRegistry, type Asset } from '../../../src/core/assets.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { MemorySealedPoolStore } from '../../../src/midnight/vault-pool.js';
import { newWrappingKeypair, type Hex } from '../../../src/core/crypto.js';
import {
  DEPOSIT_TIME_TO_LIVE_MS, PublicDepositNotYetSeen, depositIntoCompanyVault, depositPubliclyIntoCompanyVault, type DepositInFlight, type DepositsInFlight, type VaultChainView, type ServedVaultChain, type VaultService,
} from './vault-operation.js';
import { VaultAskFailed, type VaultBuilderClient } from './vault-worker-client.js';
import { ReadRanOutOfTime } from './read-bound.js';
import { inFlightInMemory, sealedOnThisDevice, type SealedInFlight } from './in-flight-on-this-device.js';
import { whyNotOnlyThisPublicDeposit } from './vault-builder.js';
import { vaultServiceFor } from './vault-page-doors.js';
import {
  depositFromSource, privateTokenFromTheWallet, publicTokenFromTheWallet, type DepositAsk, type PaidIn,
} from './deposit-source.js';
/** A test stand-in for what a chain read says: the device's view, the service's answer and the one knob the worker stand-in turns into `started`. */
type TestView = VaultChainView & ServedVaultChain & { readonly started?: boolean };

const VAULT = 'ab'.repeat(32) as VaultAddress;
/* The company's account, and the label it carries. */
const ACCOUNT = 'c0'.repeat(32) as AccountAddress;
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const PRIVATE_TOKEN = '5e'.repeat(32);
const PUBLIC_TOKEN = 'cd'.repeat(32);
/* A token with both forms is one token: the ledger names its notes and its public balance alike. */
const BOTH_TOKEN = '6e'.repeat(32);
const BOTH_PRIVATE = BOTH_TOKEN;
const BOTH_PUBLIC = BOTH_TOKEN;
/* The keys that hold the company's account: three signers, any two of whom act. Distinct, in the one order the product keeps them. */
const COMMITTEE_KEYS = [
  { tag: 'schnorr', value: '21'.repeat(32) }, { tag: 'schnorr', value: '22'.repeat(32) }, { tag: 'schnorr', value: '23'.repeat(32) },
];
const COMMITTEE_THRESHOLD = 2;
const PARAMS = btoa('midnight:ledger-parameters[v8]:stand-in');
/* The hash the chain at the wallet's indexer gives the deposit, and the one the service answers with: never the same. */
const CHAIN_HASH = 'c4'.repeat(32);
const WALLETS_INDEXER = { indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' };

/** A row for a token, named `symbol`, in the forms given: each form is the token itself or absent. */
const asset = (symbol: string, shielded: string | null, unshielded: string | null): Asset => ({
  code: (shielded ?? unshielded)!, symbol, name: symbol, decimals: 0,
  ledger: { shielded, unshielded } as Asset['ledger'], enabled: true, sortOrder: 1,
});
const REGISTRY = new StaticAssetRegistry([
  asset('PRV', PRIVATE_TOKEN, null), asset('PUB', null, PUBLIC_TOKEN), asset('BOTH', BOTH_PRIVATE, BOTH_PUBLIC),
]);

/** What the wallet answers when it paid exactly what was asked. */
const paid = (amount: string, token = PUBLIC_TOKEN) => async (ask: DepositAsk): Promise<PaidIn> =>
  ({ transaction: `${ask.transaction}+public-coins`, leaves: [{ token, amount, kind: 'unshielded' }] });

/** A stood-in service and worker, the page's doors, and every call to them written down. */
const setUp = (over: {
  view?: Partial<TestView>; send?: VaultService['depositPublicly']; noBuilder?: boolean;
  /* What the worker finds at the wallet's indexer on each look for the deposit, in turn; the last answer repeats. Absent: no way to look. */
  landed?: ReadonlyArray<{ transactionHash: string } | null | Error> | 'cannot look';
  /* The keys and threshold the vault's own state names, in place of the account's committee. */
  authority?: { committee: { tag: string; value: string }[]; threshold: number } | null;
} = {}) => {
  const log: string[] = [];
  const looks: unknown[] = [];
  const view = (): TestView => ({
    vault: VAULT, onChain: true, committee: null, heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [],
    ...over.view,
  });
  const refuse = async () => { log.push('a private step was asked'); throw new Error('a public deposit never asks this'); };
  const service: VaultService = {
    keys: refuse, deploy: refuse, handover: refuse, payout: refuse, merge: refuse, payoutPublicly: refuse,
    /* Asked of the vault, the service is never believed: the vault is read on this device, below. */
    chain: async () => { log.push('the service was asked for the vault'); throw new Error('a deposit never asks the service for the vault'); },
    /* Only a vault's start reads its block through the service. */
    payoutState: async () => { log.push('the service was asked for the block'); throw new Error('a deposit never asks the service for its block'); },
    deposit: async () => { log.push('sent to the private route'); return { txRef: 'no', transactionHash: null }; },
    depositPublicly: over.send ?? (async (_v, tx, money) => { log.push(`sent ${tx} ${money.token.slice(0, 2)} ${money.amount}`); return { txRef: 'r1', transactionHash: 'h1' }; }),
  };
  const builder = {
    /*
     * The vault as this device's worker reads it at the wallet's indexer: held by the very keys, at the very threshold,
     * that hold the account as the wallet reads it when the view says the committee holds it, by another committee when
     * it says not, started when money may go in. The product compares the two; this stand-in only supplies them. The read
     * of a real state is `vault-on-chain-here.test.ts`'s.
     */
    vaultOnChain: async (i: { vault: string; indexer: unknown }) => {
      log.push('read here');
      const v = view();
      return {
        onChain: v.onChain, state: v.state ?? '', notes: v.notes, notesFromThisBuild: true, everCreated: v.everCreated ?? [],
        authority: over.authority !== undefined ? over.authority
          : v.heldByCommittee === true ? { committee: COMMITTEE_KEYS.map((k) => ({ ...k })), threshold: COMMITTEE_THRESHOLD }
            : { committee: [{ tag: 'schnorr', value: '99'.repeat(32) }], threshold: 1 },
        account: ACCOUNT, started: v.started === true, circuits: null, accountCircuits: null,
      };
    },
    /* The block the deposit is built on, read here at the wallet's indexer. */
    chainAtOneBlock: async () => ({ blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: PARAMS, accountState: 'A' }),
    eventsOf: refuse, createdBy: refuse,
    deploy: refuse, handover: refuse, notesForPayment: refuse, paymentsFit: refuse, afterPayment: refuse, stepKept: refuse, confirmPayment: refuse,
    creatingTransaction: refuse, payout: refuse, payoutPublicly: refuse, governedCall: refuse, commitments: refuse, deposit: refuse,
    ...(over.noBuilder ? {} : {
      publicDeposit: async (i: { vault: string; token: string; amount: string; state: string; parameters: string }) => {
        log.push(`built ${i.vault.slice(0, 2)} ${i.token.slice(0, 2)} ${i.amount} ${i.parameters === PARAMS}`);
        return { tx: 'PROVEN' };
      },
    }),
    ...(over.landed === 'cannot look' ? {} : {
      /* The worker's look at the wallet's indexer for the transaction the wallet signed; the real one is `the-chain-shows-a-public-deposit.test.ts`'s. */
      publicDepositLanded: async (i: { vault: string; transaction: string; indexer: unknown }) => {
        looks.push(i);
        log.push('looked');
        const answers = over.landed ?? [{ transactionHash: CHAIN_HASH }];
        const a = answers[Math.min(looks.length - 1, answers.length - 1)];
        if (a instanceof Error) throw a;
        return a ?? null;
      },
    }),
  } as unknown as VaultBuilderClient;
  const kept = new Map<WireRecord, MemorySealedPoolStore>();
  const records = (r: WireRecord) => {
    log.push(`records ${r}`);
    return kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const wrapping = newWrappingKeypair();
  const inFlight = new Map<string, SealedInFlight>();
  const doors = {
    sleep: async () => {}, waitMs: 3, everyMs: 1, service, records,
    me: { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(9) },
    myRecordsKey: 'ff'.repeat(32) as Hex,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
    company: LABEL, account: ACCOUNT, builder,
    /* The indexer the wallet names. */
    indexer: async () => ({ indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' }),
    /* The wallet's read: the account has adopted the vault. */
    onChain: async (v: string) => ({
      holders: { committee: COMMITTEE_KEYS.map((k) => ({ ...k })), threshold: COMMITTEE_THRESHOLD, seats: [], approvals: 1, vaultThresholds: [], policyBar: null, seatBar: seatBarOf(1, null), adoptedVaults: [v], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }] },
    }),
    inFlight: sealedOnThisDevice<DepositInFlight>(inFlightInMemory(inFlight), { signerId: 'ada', wrappingSecret: wrapping.secret }, 'deposit') as DepositsInFlight,
  };
  return { log, doors, inFlight, looks };
};

describe('A PUBLIC DEPOSIT FROM THE PAGE', () => {
  it('A PUBLIC DEPOSIT INTO A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT, IS REFUSED BEFORE ANYTHING IS BUILT', async () => {
    const { log, doors } = setUp();
    const unadopted = {
      ...doors,
      onChain: async (v: string) => ({ ...(await doors.onChain(v)), holders: { ...(await doors.onChain(v)).holders, adoptedVaults: [] } }),
    };
    const source = publicTokenFromTheWallet(async (ask) => { log.push('wallet'); return paid('40')(ask); }, REGISTRY);
    /* RED WHEN: public money goes into a vault the service's rows name and the account never adopted. */
    await expect(depositFromSource(unadopted, VAULT, source, { code: PUBLIC_TOKEN, value: 40n })).rejects.toThrow(/not one your company's account has adopted/);
    expect(log.filter((l) => l !== 'read here')).toEqual([]);
  });

  it('THE PUBLIC SOURCE ENDS IN THE VAULT\'S PUBLIC DEPOSIT: THE ASSET\'S PUBLIC TOKEN AND THE AMOUNT ASKED, BUILT, PAID BY THE WALLET AND SENT, AND NOTHING KEPT ON THIS DEVICE', async () => {
    const { log, doors, inFlight } = setUp();
    const asked: unknown[] = [];
    const source = publicTokenFromTheWallet(async (ask) => { asked.push(ask); log.push('wallet'); return paid('40')(ask); }, REGISTRY);
    const done = await depositFromSource(doors, VAULT, source, { code: PUBLIC_TOKEN, value: 40n });
    /* RED WHEN: the public source goes down the private step, is built with another token, amount or vault, or is sent anywhere but the public route. */
    expect(log).toEqual(['read here', `built ab ${PUBLIC_TOKEN.slice(0, 2)} 40 true`, 'wallet', `sent PROVEN+public-coins ${PUBLIC_TOKEN.slice(0, 2)} 40`, 'looked']);
    expect(done).toEqual({ txRef: 'r1', transactionHash: CHAIN_HASH, token: PUBLIC_TOKEN, value: 40n });
    /* RED WHEN: the wallet is handed anything beyond the company, its account, the vault and the proven deposit. */
    expect(asked).toEqual([{ company: LABEL, account: ACCOUNT, vault: VAULT, transaction: 'PROVEN' }]);
    /* RED WHEN: a public deposit keeps a record in this browser, as a private one must. */
    expect(inFlight.size).toBe(0);
  });

  it('AN ASSET WITH BOTH FORMS GOES IN PUBLICLY OR PRIVATELY, AS ASKED, AS ITS ONE TOKEN', async () => {
    const pub = setUp();
    await depositFromSource(pub.doors, VAULT, publicTokenFromTheWallet(paid('7', BOTH_PUBLIC), REGISTRY), { code: BOTH_TOKEN, value: 7n });
    /* RED WHEN: the public source takes the asset's private token. */
    expect(pub.log).toContain(`built ab ${BOTH_PUBLIC.slice(0, 2)} 7 true`);
    expect(publicTokenFromTheWallet(paid('7'), REGISTRY).money({ code: BOTH_TOKEN, value: 7n })).toEqual({ token: BOTH_PUBLIC, value: 7n });
    expect(privateTokenFromTheWallet(paid('7'), REGISTRY).money({ code: BOTH_TOKEN, value: 7n })).toEqual({ token: BOTH_PRIVATE, value: 7n });
  });

  it('AN ASSET WITH NO PUBLIC FORM, OR AN AMOUNT OF NOTHING, IS REFUSED BEFORE ANYTHING IS BUILT OR ASKED', async () => {
    for (const [why, brought] of [
      ['an asset with no public form', { code: PRIVATE_TOKEN, value: 40n }],
      ['an amount of nothing', { code: PUBLIC_TOKEN, value: 0n }],
    ] as const) {
      const { log, doors } = setUp();
      const source = publicTokenFromTheWallet(async (ask) => { log.push('wallet'); return paid('40')(ask); }, REGISTRY);
      const e = await depositFromSource(doors, VAULT, source, brought).catch((x: Error) => x);
      /* RED WHEN: the source's own check is gone, and the registry's refusal, worded for a payment, reaches the screen. */
      expect((e as Error).message, why).toMatch(brought.value === 0n ? /^an amount of nothing is not a deposit/ : /^PRV cannot be put into a vault publicly\. Nothing was sent\. Put it in privately instead\.$/);
      expect((e as Error).message, why).not.toMatch(/pa(id|y)(ment| out)/i);
      expect(log, why).toEqual([]);
    }
  });

  it('A VAULT THAT TAKES NO MONEY, OR A PAGE THAT CANNOT BUILD, SEND OR WATCH FOR A PUBLIC DEPOSIT, BUILDS NOTHING AND ASKS THE WALLET FOR NOTHING', async () => {
    for (const [why, over, says] of [
      ['not started', { view: { started: false } }, /^this vault has not been started/],
      ['no public build in the worker', { noBuilder: true }, /cannot build a public deposit/],
      /* RED WHEN: a public deposit is started on a page that has no way to see it arrive on the chain. */
      ['no way to watch the chain for it', { landed: 'cannot look' }, /^this page cannot watch the chain for a public deposit, so nothing was built or sent\. No money moved\./],
    ] as const) {
      const { log, doors } = setUp(over as never);
      const source = publicTokenFromTheWallet(async (ask) => { log.push('wallet'); return paid('40')(ask); }, REGISTRY);
      /* RED WHEN: the vault's state is asked after the wallet, or the step builds for a vault that takes no money. */
      await expect(depositFromSource(doors, VAULT, source, { code: PUBLIC_TOKEN, value: 40n }), why).rejects.toThrow(says);
      expect(log.filter((l) => l !== 'read here'), why).toEqual([]);
    }
    const { log, doors } = setUp();
    const withoutTheRoute = { ...doors, service: { ...doors.service, depositPublicly: undefined } };
    await expect(depositFromSource(withoutTheRoute, VAULT, publicTokenFromTheWallet(paid('40'), REGISTRY), { code: PUBLIC_TOKEN, value: 40n }))
      .rejects.toThrow(/cannot send a public deposit/);
    expect(log).toEqual([]);
  });

  it('A PUBLIC DEPOSIT GOES INTO A VAULT PINNED TO THE ACCOUNT WHATEVER COMMITTEE HOLDS IT: ANOTHER KEY, ORDER OR THRESHOLD THAN THE ACCOUNT\'S, OR NONE', async () => {
    const [a, b, c] = COMMITTEE_KEYS as [typeof COMMITTEE_KEYS[0], typeof COMMITTEE_KEYS[0], typeof COMMITTEE_KEYS[0]];
    const other = { tag: 'schnorr', value: '24'.repeat(32) };
    const mine = (threshold = COMMITTEE_THRESHOLD, committee = [a, b, c]) => ({ committee: committee.map((k) => ({ ...k })), threshold });
    for (const [why, authority] of [
      ['one key swapped for another', mine(COMMITTEE_THRESHOLD, [a, b, other])],
      /* A signature on a committee names its key by position, so the same keys in another order are another committee. */
      ['the same keys in another order', mine(COMMITTEE_THRESHOLD, [b, a, c])],
      ['one key short', mine(COMMITTEE_THRESHOLD, [a, b])],
      ['one key more', mine(COMMITTEE_THRESHOLD, [a, b, c, other])],
      ['a higher threshold over the same keys', mine(COMMITTEE_THRESHOLD + 1)],
      ['a lower threshold over the same keys', mine(COMMITTEE_THRESHOLD - 1)],
      ['the same keys under another tag', mine(COMMITTEE_THRESHOLD, [a, b, { ...c, tag: 'other' }])],
      ['no keys at all', mine(COMMITTEE_THRESHOLD, [])],
      ['no authority in the state', null],
    ] as const) {
      const { log, doors } = setUp({ authority });
      /* RED WHEN: a public deposit reads who holds the vault - a committee change the service leaves half done would then stop every deposit. */
      await depositFromSource(doors, VAULT, publicTokenFromTheWallet(paid('40'), REGISTRY), { code: PUBLIC_TOKEN, value: 40n });
      expect(log.some((l) => l.startsWith('sent PROVEN')), why).toBe(true);
    }
    const { log, doors } = setUp({ authority: mine() });
    await depositFromSource(doors, VAULT, publicTokenFromTheWallet(paid('40'), REGISTRY), { code: PUBLIC_TOKEN, value: 40n });
    expect(log.some((l) => l.startsWith('sent PROVEN'))).toBe(true);
  });

  it('A WALLET ANSWER THAT NAMES ANYTHING BUT THIS TOKEN AND THIS AMOUNT, PUBLICLY, IS NOT SENT', async () => {
    for (const [why, leaves] of [
      ['another amount', [{ token: PUBLIC_TOKEN, amount: '41', kind: 'unshielded' }]],
      ['another token', [{ token: PRIVATE_TOKEN, amount: '40', kind: 'unshielded' }]],
      ['private money', [{ token: PUBLIC_TOKEN, amount: '40', kind: 'shielded' }]],
      ['two things', [{ token: PUBLIC_TOKEN, amount: '40', kind: 'unshielded' }, { token: PUBLIC_TOKEN, amount: '1', kind: 'unshielded' }]],
      ['nothing', []],
    ] as const) {
      const { log, doors } = setUp();
      const source = publicTokenFromTheWallet(async (ask) => ({ transaction: `${ask.transaction}+coins`, leaves }), REGISTRY);
      /* RED WHEN: the page sends whatever the wallet finished without reading what the wallet says left it. */
      await expect(depositFromSource(doors, VAULT, source, { code: PUBLIC_TOKEN, value: 40n }), why)
        .rejects.toThrow(/^your wallet prepared a payment for something other than this public deposit, so this page did not send it and no money moved\. You can put money in again now\.$/);
      expect(log.some((l) => l.startsWith('sent')), why).toBe(false);
    }
  });

  it('A SEND THE SERVICE REFUSED SAYS NO MONEY MOVED; A SEND THAT MAY HAVE GONE SAYS DO NOT PUT IT IN AGAIN', async () => {
    const refused = setUp({ send: async () => { throw Object.assign(new Error('not exactly this. Nothing was sent.'), { nothingWasSent: true }); } });
    await expect(depositFromSource(refused.doors, VAULT, publicTokenFromTheWallet(paid('40'), REGISTRY), { code: PUBLIC_TOKEN, value: 40n }))
      .rejects.toThrow(/^the public deposit was not sent, so no money has moved yet\. Your wallet already signed it, and until .+ anyone can still send it\. If they do, the money goes into this vault and nowhere else\. Do not put the same money in again before .+, or the vault may receive it twice\. The service said: not exactly this\. Nothing was sent\.$/);
    const lost = setUp({ send: async () => { throw new Error('the connection closed'); } });
    const e = await depositFromSource({ ...lost.doors, clock: () => 1_000 }, VAULT, publicTokenFromTheWallet(paid('40'), REGISTRY), { code: PUBLIC_TOKEN, value: 40n })
      .catch((x: Error) => x);
    /* RED WHEN: the time before which nobody should put the money in again is shorter than the deposit can live. */
    expect((e as PublicDepositNotYetSeen).until).toBe(1_000 + DEPOSIT_TIME_TO_LIVE_MS);
    /* RED WHEN: a send whose outcome is unknown is reported as a deposit that did not happen. */
    expect(e).toBeInstanceOf(PublicDepositNotYetSeen);
    expect((e as Error).message).toMatch(/Do not put the same money in again before .+\. If it has not arrived by then, it never will\./);
    expect((e as Error).message).not.toMatch(/no money (has )?moved/);
    expect((e as Error).message).toMatch(/"Check my last deposit" finds only private deposits/);
  });

  it('THE PRIVATE SOURCE STILL ENDS IN THE PRIVATE STEP, AND NEVER IN THE PUBLIC ONE', async () => {
    const { log, doors } = setUp();
    /* The private step's first own asks are to the pool; a stand-in that refuses them shows it was taken. */
    await depositFromSource(doors, VAULT, privateTokenFromTheWallet(paid('40'), REGISTRY), { code: PRIVATE_TOKEN, value: 40n }).catch(() => null);
    /* RED WHEN: the dispatcher sends a private source down the public step. */
    expect(log.some((l) => l.startsWith('built ab'))).toBe(false);
    expect(log.some((l) => l.startsWith('sent PROVEN'))).toBe(false);
  });
});

describe('THE WORKER BUILDS ONLY THE PUBLIC DEPOSIT ASKED FOR', () => {
  const effects = (over: Record<string, unknown> = {}) => ({
    claimedNullifiers: [], claimedShieldedReceives: [], claimedShieldedSpends: [], claimedContractCalls: [],
    shieldedMints: new Map(), unshieldedMints: new Map(), unshieldedOutputs: new Map(), claimedUnshieldedSpends: new Map(),
    unshieldedInputs: new Map([[{ tag: 'unshielded', raw: PUBLIC_TOKEN }, 40n]]),
    ...over,
  });
  const tx = (call: Record<string, unknown> = {}, intent: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
    intents: new Map([[7, {
      actions: [{ address: VAULT, entryPoint: 'depositUnshielded', guaranteedTranscript: { effects: effects() }, ...call }],
      ...intent,
    }]]),
    ...top,
  });
  const expect40 = { vault: VAULT, token: PUBLIC_TOKEN, amount: 40n };

  it('TAKES ONE CALL TO THIS VAULT\'S PUBLIC DEPOSIT ASKING FOR EXACTLY THIS TOKEN AND AMOUNT', () => {
    expect(whyNotOnlyThisPublicDeposit(tx(), expect40)).toBeNull();
    expect(whyNotOnlyThisPublicDeposit(tx({ entryPoint: new TextEncoder().encode('depositUnshielded') }), expect40)).toBeNull();
  });

  it('REFUSES ANYTHING ELSE, EACH FOR ITS OWN REASON', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['another vault', tx({ address: 'ee'.repeat(32) }), /does not call this vault's public deposit/],
      ['the private deposit', tx({ entryPoint: 'deposit' }), /does not call this vault's public deposit/],
      ['another amount', tx({ guaranteedTranscript: { effects: effects({ unshieldedInputs: new Map([[{ tag: 'unshielded', raw: PUBLIC_TOKEN }, 41n]]) }) } }), /exactly the token and amount/],
      ['another token', tx({ guaranteedTranscript: { effects: effects({ unshieldedInputs: new Map([[{ tag: 'unshielded', raw: PRIVATE_TOKEN }, 40n]]) }) } }), /exactly the token and amount/],
      ['two tokens', tx({ guaranteedTranscript: { effects: effects({ unshieldedInputs: new Map([[{ tag: 'unshielded', raw: PUBLIC_TOKEN }, 40n], [{ tag: 'unshielded', raw: PRIVATE_TOKEN }, 1n]]) }) } }), /exactly the token and amount/],
      ['money paid out', tx({ guaranteedTranscript: { effects: effects({ unshieldedOutputs: new Map([[{ tag: 'unshielded', raw: PUBLIC_TOKEN }, 1n]]) }) } }), /more than public money/],
      ['a coin received', tx({ guaranteedTranscript: { effects: effects({ claimedShieldedReceives: ['c'] }) } }), /more than public money/],
      ['another contract called', tx({ guaranteedTranscript: { effects: effects({ claimedContractCalls: [[0n, 'x', 'y', 0n]] }) } }), /more than public money/],
      ['nothing readable', tx({ guaranteedTranscript: { effects: null } }), /could not be read/],
      ['two calls', { intents: new Map([[7, { actions: [tx().intents.get(7)!.actions[0], tx().intents.get(7)!.actions[0]] }]]) }, /not one call/],
      ['a private coin', tx({}, {}, { guaranteedOffer: { outputs: [1] } }), /private money as well/],
      ['a private coin in a fallible part', tx({}, {}, { fallibleOffer: new Map([[1, { outputs: [1] }]]) }), /private money as well/],
      ['a public coin claimed for someone', tx({ guaranteedTranscript: { effects: effects({ claimedUnshieldedSpends: new Map([[['t', 'a'], 1n]]) }) } }), /more than public money/],
      ['public money of its own', tx({}, { guaranteedUnshieldedOffer: { inputs: [], outputs: [1] } }), /public money of its own/],
    ];
    for (const [why, t, says] of cases) {
      /* RED WHEN: the worker proves a public deposit that asks for anything but this token and amount into this vault. */
      expect(whyNotOnlyThisPublicDeposit(t, expect40), why).toMatch(says);
    }
  });
});

describe('THE PAGE ASKS THE SERVICE FOR A PUBLIC DEPOSIT ON ITS OWN ROUTE', () => {
  it('POSTS THE FINISHED DEPOSIT WITH THE TOKEN AND AMOUNT IT ASKED FOR, AND A REFUSAL IS MARKED AS SENDING NOTHING', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    let answer: () => Promise<unknown> = async () => ({ txRef: 'r1', transactionHash: null });
    const api = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      return answer();
    };
    const service = vaultServiceFor(api as never, 'acc_1', async () => { throw new Error('no roster is read'); });
    await service.depositPublicly!(VAULT, 'FINISHED', { token: PUBLIC_TOKEN as Hex, amount: '40' });
    /* RED WHEN: a public deposit is posted to the private deposit's route, or without the token and amount it asked for. */
    expect(calls).toEqual([{ path: `/api/accounts/acc_1/vaults/${VAULT}/public-deposit`, body: { tx: 'FINISHED', token: PUBLIC_TOKEN, amount: '40' } }]);
    answer = async () => { throw new Error('this is not exactly this. Nothing was sent.'); };
    const e = await service.depositPublicly!(VAULT, 'FINISHED', { token: PUBLIC_TOKEN as Hex, amount: '40' }).catch((x: unknown) => x);
    /* RED WHEN: the service's refusal reaches the page unmarked, so the page would say the money may have moved. */
    expect((e as { nothingWasSent?: unknown }).nothingWasSent).toBe(true);
  });
});

describe('A PUBLIC DEPOSIT IS DONE ONLY WHEN THE CHAIN AT THE WALLET\'S INDEXER SHOWS IT', () => {
  const put = (doors: ReturnType<typeof setUp>['doors'], stages?: string[]) => depositPubliclyIntoCompanyVault({
    ...doors,
    pay: async (ask: unknown) => paid('40')(ask as DepositAsk),
    ...(stages === undefined ? {} : { progress: (s: string) => { stages.push(s); } }),
  } as never, VAULT, { token: PUBLIC_TOKEN as Hex, value: 40n });

  it('WAITS FOR THE TRANSACTION THE WALLET SIGNED, LOOKED FOR AT THE WALLET\'S INDEXER, AND REPORTS THE CHAIN\'S HASH OF IT, NOT THE SERVICE\'S', async () => {
    const { doors, looks } = setUp({ landed: [null, null, { transactionHash: CHAIN_HASH }] });
    const done = await put(doors);
    /* RED WHEN: the page says a public deposit is done on the service's answer alone, before the chain shows it. */
    expect(looks).toHaveLength(3);
    /* RED WHEN: the page looks for anything but the very transaction the wallet signed, or looks anywhere but the indexer the wallet names. */
    for (const look of looks) expect(look).toEqual({ vault: VAULT, transaction: 'PROVEN+public-coins', indexer: WALLETS_INDEXER });
    /* RED WHEN: the hash the service answered with is reported as the deposit's. */
    expect(done.transactionHash).toBe(CHAIN_HASH);
  });

  it('A DEPOSIT THE CHAIN HAS NOT SHOWN BY THE END OF THE WAIT IS NOT DONE: IT SAYS IT MAY HAVE BEEN SENT, AND UNTIL WHEN', async () => {
    for (const [why, landed, says] of [
      ['the chain never shows it', [null], null],
      ['every read runs out of time', [new ReadRanOutOfTime('The network (public-deposit-landed)')], /did not answer within/],
      ['the worker is too slow every time', [new VaultAskFailed('public-deposit-landed', 'took-too-long', 'the worker said nothing')], /the worker said nothing/],
      ['the worker stops every time', [new VaultAskFailed('public-deposit-landed', 'stopped', 'the worker stopped')], /the worker stopped/],
      ['the indexer cannot be read every time', [new VaultAskFailed('public-deposit-landed', 'answered', 'the indexer answered HTTP 503', { name: 'NoteIndexUnreadable' })], /HTTP 503/],
    ] as const) {
      const { doors, looks } = setUp({ landed });
      const stages: string[] = [];
      const e = await put({ ...doors, clock: () => 5_000 } as never, stages).catch((x: unknown) => x);
      /* RED WHEN: a public deposit the chain never showed is reported done, or ends in a failure that reads as nothing sent. */
      expect(e, why).toBeInstanceOf(PublicDepositNotYetSeen);
      expect((e as PublicDepositNotYetSeen).until, why).toBe(5_000 + DEPOSIT_TIME_TO_LIVE_MS);
      expect(stages, why).not.toContain('done');
      /* RED WHEN: a read that may come right if asked again ends the wait early instead of being asked until the wait is over. */
      expect(looks.length, why).toBe(3);
      /* RED WHEN: the last reason the page could not see the deposit is dropped, so support cannot tell a slow indexer from a page that could not look. */
      if (says === null) expect((e as Error).message, why).not.toMatch(/Details for support/);
      else expect((e as Error).message, why).toMatch(new RegExp(`Details for support: .*${says.source}`, 'u'));
    }
  });

  it('A LOOK THAT CAN NEVER SUCCEED ENDS THE WAIT AT ONCE, NOT DONE, AND SAYS WHY', async () => {
    const cases = [
      ['the wallet names no indexer', [{ transactionHash: CHAIN_HASH }], true, 0, /your wallet did not say which indexer it reads the chain through/],
      ['the indexer refuses the question', [new VaultAskFailed('public-deposit-landed', 'answered', 'the indexer will not take this question', { name: 'NoteIndexUnaskable' })], false, 1, /will not take this question/],
      ['the signed deposit cannot be read, or names no identifier', [new VaultAskFailed('public-deposit-landed', 'answered', 'the deposit your wallet signed names no identifier')], false, 1, /names no identifier/],
    ] as const;
    for (const [why, landed, noIndexerOnceSent, looked, says] of cases) {
      const { doors, looks, log } = setUp({ landed: [...landed] });
      /* The wallet names its indexer while the vault is read and the deposit built, and names none once it is sent. */
      const indexer = noIndexerOnceSent
        ? async () => (log.some((l) => l.startsWith('sent')) ? null : doors.indexer())
        : doors.indexer;
      const stages: string[] = [];
      const e = await put({ ...doors, indexer, clock: () => 5_000 } as never, stages).catch((x: unknown) => x);
      /* RED WHEN: a deposit the page could not look for is reported done, or as one that was never sent. */
      expect(e, why).toBeInstanceOf(PublicDepositNotYetSeen);
      expect(stages, why).not.toContain('done');
      /* RED WHEN: a look that answers the same way every time is asked again until the wait runs out. */
      expect(looks.length, why).toBe(looked);
      /* RED WHEN: the person and support are not told why the page could not look. */
      expect((e as Error).message, why).toMatch(new RegExp(`Details for support: .*${says.source}`, 'u'));
    }
  });

  it('SAYS EACH STEP AS IT STARTS, IN ORDER, CHECKING THE VAULT BEFORE IT IS READ', async () => {
    const pub = setUp();
    const stages: string[] = [];
    const say = (s: string) => { stages.push(s); pub.log.push(`stage ${s}`); };
    await depositPubliclyIntoCompanyVault({ ...pub.doors, pay: async (ask: unknown) => paid('40')(ask as DepositAsk), progress: say } as never,
      VAULT, { token: PUBLIC_TOKEN as Hex, value: 40n });
    /* RED WHEN: a public deposit's steps are said out of order, or one the page lists is never said. */
    expect(stages).toEqual(['checking the vault', 'building the deposit', 'asking your wallet', 'sending the deposit', 'waiting for the chain', 'done']);
    /* RED WHEN: the vault is read before the person is told it is being checked. */
    expect(pub.log.slice(0, 2)).toEqual(['stage checking the vault', 'read here']);
    expect(pub.log.indexOf('stage waiting for the chain')).toBeLessThan(pub.log.indexOf('looked'));

    const priv = setUp();
    /* The private deposit stops at its pool here, after the vault is checked; only its first step is watched. */
    await depositIntoCompanyVault({ ...priv.doors, progress: (s: string) => { priv.log.push(`stage ${s}`); } } as never,
      VAULT as never, { token: PRIVATE_TOKEN, value: 40n } as never).catch(() => null);
    /* RED WHEN: a private deposit reads the vault before saying it is checking it. */
    expect(priv.log.slice(0, 2)).toEqual(['stage checking the vault', 'read here']);
  });
});
