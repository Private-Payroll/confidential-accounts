/**
 * **A PUBLIC TOKEN PUT INTO A VAULT FROM THE PAGE, AS IT IS.** The page's second
 * source ends in the vault's public deposit through the same dispatcher as the
 * private source, and the page's public step builds, asks the wallet and sends
 * exactly one public deposit of the token and amount asked, recording nothing
 * on this device. The service and the vault worker are stood in; the step and
 * the dispatcher are the page's own. The same deposit over the real ledger,
 * the real wallet balancing and the service's own routes is watched in
 * `contracts/test/a-private-payment-from-the-page.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { StaticAssetRegistry, type Asset } from '../core/assets.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import { MemorySealedPoolStore } from '../midnight/vault-pool.js';
import { newWrappingKeypair, type Hex } from '../core/crypto.js';
import {
  DEPOSIT_TIME_TO_LIVE_MS, PublicDepositNotYetSeen, type DepositInFlight, type DepositsInFlight, type VaultChainView, type VaultService,
} from './vault-operation.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { inFlightInMemory, sealedOnThisDevice, type SealedInFlight } from './in-flight-on-this-device.js';
import { whyNotOnlyThisPublicDeposit } from './vault-builder.js';
import { vaultServiceFor } from './vault-page-doors.js';
import {
  depositFromSource, depositKindFor, privateTokenFromTheWallet, publicTokenFromTheWallet, sourceFor, type DepositAsk, type PaidIn,
} from './deposit-source.js';

const VAULT = 'ab'.repeat(32) as Hex;
const ACCOUNT = 'c0'.repeat(32) as Hex;
const PRIVATE_TOKEN = '5e'.repeat(32);
const PUBLIC_TOKEN = 'cd'.repeat(32);
const BOTH_PRIVATE = '6e'.repeat(32);
const BOTH_PUBLIC = 'de'.repeat(32);
const PARAMS = btoa('midnight:ledger-parameters[v8]:stand-in');

const asset = (code: string, shielded: string | null, unshielded: string | null): Asset => ({
  code, name: code, kind: 'token', decimals: 0, chain: 'midnight',
  ledger: { shielded, unshielded } as Asset['ledger'], enabled: true, sortOrder: 1,
});
const REGISTRY = new StaticAssetRegistry([
  asset('PRV', PRIVATE_TOKEN, null), asset('PUB', null, PUBLIC_TOKEN), asset('BOTH', BOTH_PRIVATE, BOTH_PUBLIC),
]);

/** What the wallet answers when it paid exactly what was asked. */
const paid = (amount: string, token = PUBLIC_TOKEN) => async (ask: DepositAsk): Promise<PaidIn> =>
  ({ transaction: `${ask.transaction}+public-coins`, leaves: [{ token, amount, kind: 'unshielded' }] });

/** A stood-in service and worker, the page's doors, and every call to them written down. */
const setUp = (over: { view?: Partial<VaultChainView>; send?: VaultService['depositPublicly']; noBuilder?: boolean } = {}) => {
  const log: string[] = [];
  const view = (): VaultChainView => ({
    vault: VAULT, onChain: true, committee: null, heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [],
    ...over.view,
  });
  const refuse = async () => { log.push('a private step was asked'); throw new Error('a public deposit never asks this'); };
  const service: VaultService = {
    keys: refuse, deploy: refuse, handover: refuse, events: refuse, createdBy: refuse, payout: refuse, payoutPublicly: refuse,
    chain: async () => { log.push('chain'); return view(); },
    payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: PARAMS, accountState: 'A' }),
    deposit: async () => { log.push('sent to the private route'); return { txRef: 'no', transactionHash: null }; },
    depositPublicly: over.send ?? (async (_v, tx, money) => { log.push(`sent ${tx} ${money.token.slice(0, 2)} ${money.amount}`); return { txRef: 'r1', transactionHash: 'h1' }; }),
  };
  const builder = {
    deploy: refuse, handover: refuse, chooseNote: refuse, paymentsFit: refuse, afterPayment: refuse, confirmPayment: refuse,
    creatingTransaction: refuse, payout: refuse, payoutPublicly: refuse, governedCall: refuse, commitments: refuse, deposit: refuse,
    ...(over.noBuilder ? {} : {
      publicDeposit: async (i: { vault: string; token: string; amount: string; state: string; parameters: string }) => {
        log.push(`built ${i.vault.slice(0, 2)} ${i.token.slice(0, 2)} ${i.amount} ${i.parameters === PARAMS}`);
        return { tx: 'PROVEN' };
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
    company: ACCOUNT, builder,
    inFlight: sealedOnThisDevice<DepositInFlight>(inFlightInMemory(inFlight), { signerId: 'ada', wrappingSecret: wrapping.secret }, 'deposit') as DepositsInFlight,
  };
  return { log, doors, inFlight };
};

describe('A PUBLIC DEPOSIT FROM THE PAGE', () => {
  it('THE PUBLIC SOURCE ENDS IN THE VAULT\'S PUBLIC DEPOSIT: THE ASSET\'S PUBLIC TOKEN AND THE AMOUNT ASKED, BUILT, PAID BY THE WALLET AND SENT, AND NOTHING KEPT ON THIS DEVICE', async () => {
    const { log, doors, inFlight } = setUp();
    const asked: unknown[] = [];
    const source = publicTokenFromTheWallet(async (ask) => { asked.push(ask); log.push('wallet'); return paid('40')(ask); }, REGISTRY);
    const done = await depositFromSource(doors, VAULT, source, { code: 'PUB', value: 40n });
    /* RED WHEN: the public source goes down the private step, is built with another token, amount or vault, or is sent anywhere but the public route. */
    expect(log).toEqual(['chain', `built ab ${PUBLIC_TOKEN.slice(0, 2)} 40 true`, 'wallet', `sent PROVEN+public-coins ${PUBLIC_TOKEN.slice(0, 2)} 40`]);
    expect(done).toEqual({ txRef: 'r1', transactionHash: 'h1', token: PUBLIC_TOKEN, value: 40n });
    /* RED WHEN: the wallet is handed anything beyond the company, the vault and the proven deposit. */
    expect(asked).toEqual([{ company: ACCOUNT, vault: VAULT, transaction: 'PROVEN' }]);
    /* RED WHEN: a public deposit keeps a record in this browser, as a private one must. */
    expect(inFlight.size).toBe(0);
  });

  it('AN ASSET WITH BOTH FORMS GOES IN PUBLICLY AS ITS PUBLIC TOKEN, AND PRIVATELY AS ITS PRIVATE ONE', async () => {
    const pub = setUp();
    await depositFromSource(pub.doors, VAULT, publicTokenFromTheWallet(paid('7', BOTH_PUBLIC), REGISTRY), { code: 'BOTH', value: 7n });
    /* RED WHEN: the public source takes the asset's private token. */
    expect(pub.log).toContain(`built ab ${BOTH_PUBLIC.slice(0, 2)} 7 true`);
    expect(publicTokenFromTheWallet(paid('7'), REGISTRY).money({ code: 'BOTH', value: 7n })).toEqual({ token: BOTH_PUBLIC, value: 7n });
    expect(privateTokenFromTheWallet(paid('7'), REGISTRY).money({ code: 'BOTH', value: 7n })).toEqual({ token: BOTH_PRIVATE, value: 7n });
  });

  it('AN ASSET WITH NO PUBLIC FORM, OR AN AMOUNT OF NOTHING, IS REFUSED BEFORE ANYTHING IS BUILT OR ASKED', async () => {
    for (const [why, brought] of [
      ['an asset with no public form', { code: 'PRV', value: 40n }],
      ['an amount of nothing', { code: 'PUB', value: 0n }],
    ] as const) {
      const { log, doors } = setUp();
      const source = publicTokenFromTheWallet(async (ask) => { log.push('wallet'); return paid('40')(ask); }, REGISTRY);
      const e = await depositFromSource(doors, VAULT, source, brought).catch((x: Error) => x);
      /* RED WHEN: the source's own check is gone, and the registry's refusal, worded for a payment, reaches the screen. */
      expect((e as Error).message, why).toMatch(brought.value === 0n ? /^an amount of nothing is not a deposit/ : /^PRV has no public form on Midnight, so it cannot go into a vault from your wallet's public balance\. Nothing was built or sent\. Put it in privately instead\.$/);
      expect((e as Error).message, why).not.toMatch(/pa(id|y)(ment| out)/i);
      expect(log, why).toEqual([]);
    }
  });

  it('A VAULT THAT TAKES NO MONEY, OR A PAGE THAT CANNOT BUILD OR SEND A PUBLIC DEPOSIT, BUILDS NOTHING AND ASKS THE WALLET FOR NOTHING', async () => {
    for (const [why, over, says] of [
      ['not held by the committee', { view: { heldByCommittee: false, why: 'held by other keys' } }, /^held by other keys$/],
      ['the account not handed over', { view: { fundable: false, why: 'the account is not held yet' } }, /^the account is not held yet$/],
      ['no public build in the worker', { noBuilder: true }, /cannot build a public deposit/],
    ] as const) {
      const { log, doors } = setUp(over as never);
      const source = publicTokenFromTheWallet(async (ask) => { log.push('wallet'); return paid('40')(ask); }, REGISTRY);
      /* RED WHEN: the vault's state is asked after the wallet, or the step builds for a vault that takes no money. */
      await expect(depositFromSource(doors, VAULT, source, { code: 'PUB', value: 40n }), why).rejects.toThrow(says);
      expect(log.filter((l) => l !== 'chain'), why).toEqual([]);
    }
    const { log, doors } = setUp();
    const withoutTheRoute = { ...doors, service: { ...doors.service, depositPublicly: undefined } };
    await expect(depositFromSource(withoutTheRoute, VAULT, publicTokenFromTheWallet(paid('40'), REGISTRY), { code: 'PUB', value: 40n }))
      .rejects.toThrow(/cannot send a public deposit/);
    expect(log).toEqual([]);
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
      await expect(depositFromSource(doors, VAULT, source, { code: 'PUB', value: 40n }), why)
        .rejects.toThrow(/^your wallet prepared a payment for something other than this public deposit, so this page did not send it and no money moved\. You can put money in again now\.$/);
      expect(log.some((l) => l.startsWith('sent')), why).toBe(false);
    }
  });

  it('A SEND THE SERVICE REFUSED SAYS NO MONEY MOVED; A SEND THAT MAY HAVE GONE SAYS DO NOT PUT IT IN AGAIN', async () => {
    const refused = setUp({ send: async () => { throw Object.assign(new Error('not exactly this. Nothing was sent.'), { nothingWasSent: true }); } });
    await expect(depositFromSource(refused.doors, VAULT, publicTokenFromTheWallet(paid('40'), REGISTRY), { code: 'PUB', value: 40n }))
      .rejects.toThrow(/^the public deposit was not sent, so no money has moved yet\. Your wallet already signed it, and until .+ anyone can still send it\. If they do, the money goes into this vault and nowhere else\. Do not put the same money in again before .+, or the vault may receive it twice\. The service said: not exactly this\. Nothing was sent\.$/);
    const lost = setUp({ send: async () => { throw new Error('the connection closed'); } });
    const e = await depositFromSource({ ...lost.doors, clock: () => 1_000 }, VAULT, publicTokenFromTheWallet(paid('40'), REGISTRY), { code: 'PUB', value: 40n })
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
    await depositFromSource(doors, VAULT, privateTokenFromTheWallet(paid('40'), REGISTRY), { code: 'PRV', value: 40n }).catch(() => null);
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

describe('THE WAY AN ASSET GOES IN, AS THE PAGE CHOOSES IT', () => {
  it('AN ASSET WITH BOTH FORMS GOES IN THE WAY ASKED; AN ASSET WITH ONE GOES IN ONLY THAT WAY, AND SAYS WHY THE OTHER IS CLOSED', () => {
    /* RED WHEN: the page's choice sends an asset another way than the one asked, while that way is open. */
    expect(depositKindFor('BOTH', 'private', REGISTRY)).toEqual({ goesIn: 'private', whyNot: { private: null, public: null } });
    expect(depositKindFor('BOTH', 'public', REGISTRY)).toEqual({ goesIn: 'public', whyNot: { private: null, public: null } });
    /* RED WHEN: an asset with only a public form is put in privately, or a private-only one publicly, or the reason is lost. */
    const onlyPublic = depositKindFor('PUB', 'private', REGISTRY);
    expect(onlyPublic.goesIn).toBe('public');
    expect(onlyPublic.whyNot.private).toMatch(/^PUB has no private form on Midnight/);
    expect(onlyPublic.whyNot.public).toBeNull();
    const onlyPrivate = depositKindFor('PRV', 'public', REGISTRY);
    expect(onlyPrivate.goesIn).toBe('private');
    expect(onlyPrivate.whyNot.public).toMatch(/^PRV has no public form on Midnight/);
  });

  it('THE SOURCE FOR A WAY IS THAT WAY\'S SOURCE, AND NO OTHER', () => {
    /* RED WHEN: choosing "Privately" builds the public source, or the reverse. */
    expect(sourceFor('private', paid('1'), REGISTRY).endsIn).toBe('private-deposit');
    expect(sourceFor('public', paid('1'), REGISTRY).endsIn).toBe('public-deposit');
    expect(sourceFor('public', paid('1'), REGISTRY).money({ code: 'BOTH', value: 1n }).token).toBe(BOTH_PUBLIC);
    expect(sourceFor('private', paid('1'), REGISTRY).money({ code: 'BOTH', value: 1n }).token).toBe(BOTH_PRIVATE);
  });
});
