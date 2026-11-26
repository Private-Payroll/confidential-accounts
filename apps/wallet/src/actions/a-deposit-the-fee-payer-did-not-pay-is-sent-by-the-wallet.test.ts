import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { of } from 'rxjs';
import { DefaultForkSchedule } from '@midnightntwrk/wallet-sdk';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import { createTranslator } from '../../../../packages/ui/src/i18n/provider.js';
import { StepRefused, type StepContext } from './definition.js';
import { callOf, viewOverItsApi, stepOverItsCall } from './step-views.test-support.js';
import { pinnedIn } from './seats-the-words-make.test-support.js';

/*
 * **A DEPOSIT THE COMPANY'S FEE PAYER COULD NOT PAY FOR IS SENT BY THE WALLET, WITH THE FEE FROM THE PERSON'S OWN
 * DUST, ONLY ONCE THEY CONFIRM IT; WHEN THE WALLET SENDS NOTHING, THE PERSON IS TOLD WHEN THE VAULT TAKES A NEW
 * DEPOSIT FROM THIS DEVICE.** The service's word that it sent nothing never lets go of the deposit. The shared deposit
 * step is stood in, as in the deposit's own tests; the SDK's facade is stood in for the fee.
 */

const t = vi.hoisted(() => ({ run: null as null | ((doors: Record<string, any>, vault: string) => Promise<unknown>) }));
vi.mock('../../../../packages/web-shared/src/vault-private-deposit.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-private-deposit.js')>()),
  depositIntoCompanyVault: (doors: Record<string, any>, vault: string) => t.run!(doors, vault),
}));

const { privateDepositAction, depositDoorsFor } = await import('./private-deposit.js');
const { depositWalletFor } = await import('./deposit-sent-by-the-wallet.js');
const { serviceCallOver } = await import('./step-views.js');
const op = await import('../../../../packages/web-shared/src/vault-private-deposit.js');
const { timeShown } = await import('../../../../packages/web-shared/src/vault-step-reads.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
/* The saved keys hold only the company's pin: the steps here are handed their reach of the company. */
const PINNED_ONLY = { open: () => ({ read: () => pinnedIn({ accounts: {} }, LABEL, ACCOUNT) }), keep: async () => {} } as never;
const VAULT = 'de'.repeat(32);
const TOKEN = '9b'.repeat(32);
const NOW = 5_000_000;
const MINUTE = 60_000;
const SEND = `POST /api/accounts/acc_1/vaults/${VAULT}/deposit`;
const intent = (): ActIntent =>
  ({ name: 'private-deposit', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, vault: VAULT, token: TOKEN, amount: '1500000' } }) as ActIntent;

/** The paying account's doors, with a facade that pays a finished transaction's fee from its DUST, and what each was asked. */
const walletDoors = (did: string[]) => () => {
  const ready = { subscribe: (w: { next: (s: unknown) => void }) => { w.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } };
  const original = { intents: new Map([[1, { ttl: new Date(NOW + 80 * MINUTE) }]]) };
  const balancing = {
    guaranteedOffer: null, fallibleOffer: null,
    intents: new Map([[2, { actions: [], guaranteedUnshieldedOffer: null, fallibleUnshieldedOffer: null, dustActions: { spends: [{ vFee: 300n }], registrations: [] } }]]),
  };
  const facade = {
    dust: { state: ready }, state: () => of({ activeProtocolVersion: DefaultForkSchedule.v9 }),
    adoptTransaction: () => original,
    estimateTransactionFee: async () => 300n,
    balanceFinalizedTransaction: async (tx: unknown) => { did.push('fee balanced'); return { originalTransaction: tx, balancingTransaction: balancing }; },
    signRecipe: async (r: unknown) => r,
    finalizeRecipe: async () => ({}),
    submitTransaction: async () => { did.push('sent by the wallet'); return 'sub-1'; },
    revert: async () => { did.push('reverted'); },
  };
  return {
    ledger: async () => { throw new Error('not read here'); }, facade: async () => facade, dustKeys: () => ({}),
    signSegment: () => (() => {}) as never,
    ownFee: async () => { did.push('own DUST opened'); return facade; },
    stop: async () => { did.push('stopped'); },
  } as never;
};

const ctxWith = (answer: { status: number; body: unknown }, yes: boolean | null, did: string[], refuseAt?: number) => {
  let checked = 0;
  const asked: unknown[] = [];
  const told: Record<string, unknown> = {};
  const shown: unknown[] = [];
  const ctx = stepOverItsCall({
    intent: intent(), asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0 }, at: { step: 3, steps: 4 }, signal: new AbortController().signal,
    call: async (method: string, path: string) => { did.push(`${method} ${path}`); return answer; },
    tell: (o: Record<string, unknown>) => { Object.assign(told, o); },
    show: (w: unknown) => { shown.push(w); },
    /* The runner's door for a send this wallet makes itself; `refuseAt` names the check that finds the company changed. */
    sendStraight: async (send: (door: unknown) => Promise<unknown>, into: readonly { readonly vault: string }[] = []) => {
      const check = async () => {
        checked += 1;
        did.push(`checked ${into[0]?.vault === VAULT ? 'the vault' : 'no vault'}`);
        if (checked === refuseAt) throw Object.assign(new Error('another signer changed the company'), { thisSendNotSent: true });
      };
      await check();
      return send({ ready: check, handedOver: () => { did.push('counted as handed over'); } });
    },
    ...(yes === null ? {} : { confirmFee: async (lines: unknown) => { asked.push(lines); did.push('fee asked'); return yes; } }),
    keyring: PINNED_ONLY,
  }) as unknown as StepContext;
  return { ctx, asked, told, shown };
};

const reachOf = (ctx: StepContext) => viewOverItsApi({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32),
  seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) },
  api: serviceCallOver(callOf(ctx)), send: async () => ({ status: 404, body: {} }), holders: async () => ({ seats: [], adoptedVaults: [VAULT] }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null }), filingJudgeFor: () => async () => null },
  sealed: {}, companyKeys: {}, roster: async () => ({ id: 'acc_1', signers: [] }), builder: {},
  chain: { indexer: { indexerUri: 'https://i.example', indexerWsUri: 'wss://i.example' } },
} as never) as never;

const CHECKED = 'checked the vault';
const FEE_NOT_PAID = { status: 422, body: { nothingWasSent: true, error: 'the fee payer could not pay', code: 'fee-not-paid' } };
const NETWORK_REFUSED = { status: 422, body: { nothingWasSent: true, error: 'the node refused it', code: 'network-refused' } };

const sendWith = (answer: { status: number; body: unknown }, yes: boolean | null, refuseAt?: number) => {
  const did: string[] = [];
  const { ctx, asked, shown } = ctxWith(answer, yes, did, refuseAt);
  const reach = { chain: () => ({}) as never, builder: () => ({}) as never, now: () => NOW, pause: async () => {}, balance: walletDoors(did), kept: () => ({ inFlight: {} }) as never };
  const wallet = depositWalletFor(reach.balance, identity, 0, reach.now);
  const doors = depositDoorsFor(ctx, reachOf(ctx), reach, VAULT as never, { token: TOKEN as never, value: 1_500_000n }, wallet);
  return { did, asked, shown, wallet, send: () => doors.service.deposit(VAULT as never, 'AQID') };
};

describe('the fee payer could not pay: the wallet pays from the person\'s own DUST only after they confirm the fee', () => {
  it('confirmed: the wallet sends the deposit itself, counts it as handed over, and names the submission', async () => {
    const { did, asked, shown, send } = sendWith(FEE_NOT_PAID, true);
    /* RED WHEN: the deposit is sent with the person's DUST without asking, or the send is not counted as handed over. */
    expect(await send()).toEqual({ txRef: 'sub-1', transactionHash: null });
    /* RED WHEN: the deposit leaves this wallet without the company read again as the runner's door opens and again once the fee is confirmed, or is not counted as handed over. */
    expect(did).toEqual([SEND, CHECKED, 'own DUST opened', 'fee asked', CHECKED, 'fee balanced', 'counted as handed over', 'sent by the wallet']);
    expect(asked).toEqual([[
      { key: 'act.private-deposit.fee.service' },
      { key: 'act.private-deposit.fee.own', values: { fee: expect.any(String), specks: expect.stringMatching(/^300 SPECKs$/u) } },
      { key: 'act.private-deposit.fee.if-not', values: { until: timeShown(NOW + 80 * MINUTE) } },
    ]]);
    expect(shown).toEqual([{ key: 'act.fell-back.own-dust' }]);
  });

  it('declined: the wallet sends nothing, and the deposit stays on its way: the service\'s word is not taken', async () => {
    const { did, wallet, send } = sendWith(FEE_NOT_PAID, false);
    const failed = await send().catch((e: unknown) => e);
    /* RED WHEN: a "no" sends the deposit, or the refusal says nothing was sent, which lets go of the deposit on its way. */
    expect(did).not.toContain('sent by the wallet');
    expect((failed as { nothingWasSent?: unknown }).nothingWasSent).not.toBe(true);
    expect(wallet.unsent()?.why).toBe('declined');
  });

  it('the company changed while the fee was being confirmed: nothing is sent from the person\'s DUST, and nothing was sent', async () => {
    const { did, send } = sendWith(FEE_NOT_PAID, true, 2);
    const failed = await send().catch((e: unknown) => e);
    /* RED WHEN: a deposit leaves from the person's own DUST after another signer changed the company during the fee's confirmation. */
    expect(did).toEqual([SEND, CHECKED, 'own DUST opened', 'fee asked', CHECKED]);
    expect((failed as { thisSendNotSent?: unknown }).thisSendNotSent).toBe(true);
  });

  it('a window that cannot ask pays nothing', async () => {
    const { did, wallet, send } = sendWith(FEE_NOT_PAID, null);
    await send().catch(() => undefined);
    /* RED WHEN: with no one to confirm the fee, the wallet pays it anyway. */
    expect(did).not.toContain('fee balanced');
    expect(wallet.unsent()?.why).toBe('declined');
  });

  it('the network refused it: the wallet never sends it again', async () => {
    const { did, wallet, send } = sendWith(NETWORK_REFUSED, true);
    const failed = await send().catch((e: unknown) => e);
    /* RED WHEN: a deposit the network refused is sent again, or its refusal lets go of the deposit on its way. */
    expect(did).toEqual([SEND]);
    expect((failed as { nothingWasSent?: unknown }).nothingWasSent).not.toBe(true);
    expect(wallet.unsent()?.why).toBe('network-refused');
  });

  it('any other failure is a deposit that may still be sent, and the wallet pays nothing', async () => {
    const { did, wallet, send } = sendWith({ status: 502, body: { nothingWasSent: false, error: 'bad gateway' } }, true);
    const failed = await send().catch((e: unknown) => e);
    /* RED WHEN: a failure that may have reached the chain is answered by a second send from the wallet. */
    expect(did).toEqual([SEND]);
    expect((failed as Error).message).toMatch(/it may still be sent/u);
    expect(wallet.unsent()).toBeNull();
  });
});

describe('the step says when the vault takes a new deposit from this device, and stops the wallet it opened', () => {
  const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
  const t18 = createTranslator([{ tag: 'en', messages: en }] as never, 'en');

  for (const [answer, yes, why] of [[FEE_NOT_PAID, false, 'declined'], [NETWORK_REFUSED, true, 'network-refused']] as const) {
    it(`${why}: the refusal names the time and carries its reason`, async () => {
      const did: string[] = [];
      const { ctx, told } = ctxWith(answer, yes, did);
      t.run = async (doors, vault) => {
        /* The payment opens the paying account's wallet, then fails on this stand-in's ledger. */
        await doors.pay({ company: LABEL, account: ACCOUNT, vault, transaction: '' }).catch(() => undefined);
        try { await doors.service.deposit(VAULT, 'AQID'); } catch { throw new op.DepositNotYetSeen(VAULT as never, ''); }
      };
      const action = privateDepositAction({
        chain: () => ({}) as never, builder: () => ({}) as never, now: () => NOW, pause: async () => {}, balance: walletDoors(did),
        kept: () => ({ inFlight: {} }) as never, reachFor: async () => reachOf(ctx),
      } as never);
      let refused: unknown = null;
      for (const s of action.steps(intent()).filter((x) => !x.title.key.startsWith('act.upkeep.'))) await s.run(ctx).catch((x: unknown) => { refused = x; });
      /* RED WHEN: the person is told only that the deposit may be on its way, with no time the vault takes a new one. */
      expect(refused).toBeInstanceOf(StepRefused);
      expect((refused as StepRefused).code).toBe(why);
      const words = (refused as StepRefused).words;
      expect(words.key).toBe(`act.private-deposit.why.held.${why}`);
      const text = t18.t(words.key, { ...(words.values ?? {}) });
      expect(text).toContain(timeShown(NOW + 80 * MINUTE));
      expect(told).toEqual({ vault: VAULT, state: 'not-yet-seen' });
      /* RED WHEN: the wallet opened for the deposit is left running after the step. */
      expect(did.at(-1)).toBe('stopped');
    });
  }
});
