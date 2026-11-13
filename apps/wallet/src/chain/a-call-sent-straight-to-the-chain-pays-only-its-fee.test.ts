/**
 * **A CALL SENT WITHOUT OUR SERVICE SUBMITTING IT HAS ONLY ITS FEE PAID: BY OUR FEE SPONSORSHIP, OR BY THE PERSON'S
 * OWN DUST WHEN SPONSORSHIP CANNOT PAY.**
 *
 * The person's own wallet is a stand-in that reads a proven call as the one call its words name, adds one DUST spend
 * to pay for it and logs what it sends. The sponsorship is a stand-in that hands the call back with what its words
 * add. Which way an act's calls go is the company's choice, read by `handOverFor`.
 */
import { describe, it, expect } from 'vitest';
import { straightFromTheOwnWallet, type FeeAndSubmit, type OwnWalletDoors } from './sent-straight-to-the-chain.js';
import { handOverFor, handOverMarked } from '../actions/company-reach.js';
import { handedOver, NotHandedOver } from '../../../../packages/web-shared/src/hand-over.js';
import type { StepContext } from '../actions/definition.js';

const ACCOUNT = 'ac'.repeat(32);
const VAULT = 'fa'.repeat(32);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const intentOf = (actions: readonly unknown[], over: Record<string, unknown> = {}) =>
  ({ actions, guaranteedUnshieldedOffer: undefined, fallibleUnshieldedOffer: undefined, dustActions: undefined, ...over });

/** The person's own wallet: the proven call read as the one call to `to` its words name; each send and undo logged. */
const aWallet = (log: string[], made?: ReadonlyMap<string, unknown>): OwnWalletDoors => ({
  ledger: async () => ({
    Transaction: {
      deserialize: (_s: 'signature', _p: 'proof', _b: 'pre-binding' | 'binding', raw: Uint8Array) => {
        if (made?.has(Buffer.from(raw).toString())) return made.get(Buffer.from(raw).toString());
        const t = JSON.parse(Buffer.from(raw).toString()) as {
          circuit?: string; to?: string; proof?: string; ttl?: number; calls?: Array<{ circuit: string; to: string }>;
          /* How the call was bound: the same as it was proven unless a sponsorship bound it again. */
          bound?: string;
          /* What a sponsorship added: a segment spending DUST, and anything else it slipped in. */
          fee?: { spends: number; calls?: Array<{ circuit: string; to: string }>; registrations?: number };
        };
        const calls = t.calls ?? [{ circuit: t.circuit!, to: t.to! }];
        /* Each call written out whole, its proof included, as the ledger writes a contract call. */
        const call = (c: { circuit: string; to: string }) => ({ address: c.to, entryPoint: c.circuit, toString: () => `${c.to}:${c.circuit}:${t.proof ?? 'proof'}` });
        const intents = new Map<number, unknown>([[1, intentOf(calls.map(call), { ttl: new Date(t.ttl ?? 1) })]]);
        if (t.fee !== undefined) {
          intents.set(2, intentOf((t.fee.calls ?? []).map((c) => ({ address: c.to, entryPoint: c.circuit })), {
            dustActions: { spends: Array.from({ length: t.fee.spends }, () => 1), registrations: Array.from({ length: t.fee.registrations ?? 0 }, () => 1) },
          }));
        }
        /* The identifiers the ledger would give it: the call's own, as it was bound, and the fee's when one was added. */
        const identifiers = () => [`id:${calls.map((c) => `${c.to}:${c.circuit}`).join(',')}:${t.proof ?? 'proof'}:${t.bound ?? 'as proven'}`, ...(t.fee === undefined ? [] : ['id:fee'])];
        return { guaranteedOffer: undefined, fallibleOffer: undefined, intents, imbalances: () => new Map(), identifiers };
      },
    },
  }) as never,
  keys: () => ({ shieldedSecretKeys: 'shielded', dustSecretKey: 'dust' }),
  signSegment: () => (async () => 'signed') as never,
  facade: async () => ({
    dust: { state: { subscribe: (w: { next: (s: unknown) => void }) => { w.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } } } as never,
    balanceUnboundTransaction: async (call: never, _k: unknown, options: { tokenKindsToBalance: string[] }) => {
      log.push(`fee in ${options.tokenKindsToBalance.join(',')}`);
      return { baseTransaction: call, balancingTransaction: { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, intentOf([], { dustActions: { spends: [1], registrations: [] } })]]) } };
    },
    signRecipe: async (r: never) => r,
    finalizeRecipe: async (r: never) => r,
    submitTransaction: async (tx: { intents?: Map<number, unknown> }) => { log.push(tx.intents?.has(2) === true && log.includes('sponsored') ? 'sent as sponsored' : 'sent'); },
    revert: async () => { log.push('fee undone'); },
  }),
  stop: async () => { log.push('stopped'); },
});

const anAct = (fields: Record<string, string>, account: number | null = 0) => ({
  intent: { name: 'approve-proposal', fields }, held: { identity: {} as never, ...(account === null ? {} : { account }) },
  signal: new AbortController().signal,
}) as unknown as Pick<StepContext, 'intent' | 'held' | 'signal'>;

describe('A CALL SENT STRAIGHT TO THE CHAIN', () => {
  it('one call to the contract the step names is paid for in DUST alone and sent, and the wallet is stopped after it', async () => {
    const log: string[] = [];
    await straightFromTheOwnWallet(() => aWallet(log), Date.now, () => true)(b64({ circuit: 'approve', to: ACCOUNT }), {
      kind: 'account-call', contract: ACCOUNT, circuit: 'approve',
    });
    /* RED WHEN: the wallet pays in anything but DUST, sends nothing, or is left running. */
    expect(log).toEqual(['fee in dust', 'sent', 'stopped']);
  });

  it('a call to another contract, another circuit or a vault named as the account is refused before anything is paid, and says nothing was sent', async () => {
    for (const [tx, call] of [
      [{ circuit: 'approve', to: VAULT }, { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' }],
      [{ circuit: 'cancel', to: ACCOUNT }, { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' }],
      [{ circuit: 'writeSecretCopy', to: ACCOUNT }, { kind: 'vault-copy', contract: VAULT, circuit: 'writeSecretCopy' }],
    ] as const) {
      const log: string[] = [];
      const e = await straightFromTheOwnWallet(() => aWallet(log), Date.now, () => true)(b64(tx), call).then(() => null, (x: unknown) => x);
      /* RED WHEN: the person's wallet pays for, or sends, a call that is not the one the step makes. */
      expect((e as { nothingWasSent?: unknown }).nothingWasSent).toBe(true);
      expect(log).toEqual(['stopped']);
    }
  });
});

describe('A VAULT\'S RETIRE SENT STRAIGHT TO THE CHAIN', () => {
  const RETIRE = { kind: 'vault-retire', contract: VAULT, circuit: 'retire', account: ACCOUNT } as const;
  it('is paid for in DUST alone only as this vault\'s retire asking this company\'s account, and refused before anything is paid otherwise', async () => {
    const sent = async (calls: Array<{ circuit: string; to: string }>) => {
      const log: string[] = [];
      const e = await straightFromTheOwnWallet(() => aWallet(log), Date.now, () => true)(b64({ calls }), RETIRE).then(() => null, (x: unknown) => x);
      return { log, e };
    };
    expect((await sent([{ circuit: 'retire', to: VAULT }, { circuit: 'retireVault', to: ACCOUNT }])).log).toEqual(['fee in dust', 'sent', 'stopped']);
    /* RED WHEN: the person's wallet pays for the account's retire without the vault's own, which is what refuses a vault holding money. */
    const alone = await sent([{ circuit: 'retireVault', to: ACCOUNT }]);
    expect((alone.e as { nothingWasSent?: unknown }).nothingWasSent).toBe(true);
    expect(alone.log).toEqual(['stopped']);
  });
});

describe('A PUBLIC TOKEN TAKEN OFF A VAULT\'S LIST, SENT STRAIGHT TO THE CHAIN', () => {
  const FORGET = { kind: 'vault-forget', contract: VAULT, circuit: 'forgetUnshielded' } as const;
  it('is paid for in DUST alone only as one forgetUnshielded call to this vault, and refused before anything is paid otherwise', async () => {
    const sent = async (calls: Array<{ circuit: string; to: string }>) => {
      const log: string[] = [];
      const e = await straightFromTheOwnWallet(() => aWallet(log), Date.now, () => true)(b64({ calls }), FORGET).then(() => null, (x: unknown) => x);
      return { log, e };
    };
    expect((await sent([{ circuit: 'forgetUnshielded', to: VAULT }])).log).toEqual(['fee in dust', 'sent', 'stopped']);
    /* RED WHEN: the person's wallet pays for another call of the vault, or one riding beside the forget, as a token taken off its list. */
    for (const calls of [[{ circuit: 'payoutUnshielded', to: VAULT }], [{ circuit: 'forgetUnshielded', to: VAULT }, { circuit: 'retire', to: VAULT }]]) {
      const other = await sent(calls);
      expect((other.e as { nothingWasSent?: unknown }).nothingWasSent).toBe(true);
      expect(other.log).toEqual(['stopped']);
    }
  });
});

describe('THE FEE IS OUR SPONSORSHIP\'S, AND THE PERSON\'S OWN DUST ONLY WHEN SPONSORSHIP CANNOT PAY', () => {
  const CALL = { circuit: 'approve', to: ACCOUNT };
  const APPROVE = { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' } as const;
  /* A sponsorship that hands the call back with `added` as what it put in, logging that it was asked. */
  const sponsorship = (log: string[], added: Record<string, unknown> = { fee: { spends: 1 } }): FeeAndSubmit['sponsor'] => async (tx) => {
    log.push('sponsored');
    return { tx: b64({ ...JSON.parse(Buffer.from(tx, 'base64').toString()), ...added }), done: async () => { log.push('done'); } };
  };
  const send = async (way: (log: string[]) => FeeAndSubmit, tx: unknown = CALL) => {
    const log: string[] = [];
    const told: string[] = [];
    const w = way(log);
    const e = await straightFromTheOwnWallet(() => aWallet(log), Date.now, () => true, { over: false }, { ...w, ownDustPaid: () => told.push('own DUST') })(b64(tx), APPROVE)
      .then(() => null, (x: unknown) => x as { message: string; nothingWasSent?: unknown });
    return { log, told, e };
  };

  it('the sponsorship pays the fee: the wallet adds nothing, sends the call it handed back, and nothing is said', async () => {
    const { log, told, e } = await send((log) => ({ sponsor: sponsorship(log) }));
    /* RED WHEN: a call sent straight to the chain is paid from the person's DUST while sponsorship can pay. */
    expect(e).toBeNull();
    expect(log).toEqual(['sponsored', 'sent as sponsored', 'done', 'stopped']);
    expect(told).toEqual([]);
  });

  it('sponsorship that is down leaves the person\'s own DUST to pay, and says so once', async () => {
    for (const down of [
      { status: 503, nothingWasSent: true }, { status: 502, nothingWasSent: true }, { status: 504, nothingWasSent: true },
      { status: 422, code: 'fee-not-paid', nothingWasSent: true },
    ]) {
      const { log, told, e } = await send(() => ({ sponsor: async () => { throw Object.assign(new Error('the fee payer did not pay this fee'), down); } }));
      /* RED WHEN: a call is not sent when sponsorship is down and the person holds DUST, or the window does not say who paid. */
      expect(e, JSON.stringify(down)).toBeNull();
      expect(log).toEqual(['fee in dust', 'sent', 'stopped']);
      expect(told).toEqual(['own DUST']);
    }
  });

  it('a refusal from sponsorship is shown as a refusal, in its words, and the person\'s DUST pays nothing', async () => {
    for (const refused of [
      { status: 409, nothingWasSent: true }, { status: 401 }, { status: 422, code: 'network-refused', nothingWasSent: true }, {},
    ]) {
      const { log, told, e } = await send(() => ({
        sponsor: async () => { throw Object.assign(new Error('this service pays no fee for a payment out of this vault'), refused); },
      }));
      /* RED WHEN: a refusal the service made on purpose is undone by paying from the person's own DUST. */
      expect(e?.nothingWasSent, JSON.stringify(refused)).toBe(true);
      expect(e?.message).toMatch(/fee sponsorship refused this call \(this service pays no fee for a payment out of this vault\)/u);
      expect(log).toEqual(['stopped']);
      expect(told).toEqual([]);
    }
  });

  it('a call handed back that the wallet will not send is said done, so it holds nothing for anyone', async () => {
    const stopped = await (async () => {
      const log: string[] = [];
      const e = await straightFromTheOwnWallet(() => aWallet(log), Date.now, () => false, { over: false }, { sponsor: sponsorship(log) })(b64(CALL), APPROVE)
        .then(() => null, (x: unknown) => x as { nothingWasSent?: unknown });
      return { log, e };
    })();
    /* RED WHEN: a window stopped after the sponsorship paid leaves its booking held, stalling sponsorship. */
    expect(stopped.e?.nothingWasSent).toBe(true);
    expect(stopped.log).toEqual(['sponsored', 'done', 'stopped']);
    const refused = await send((log) => ({ sponsor: sponsorship(log, { circuit: 'cancel' }) }));
    /* RED WHEN: a handed-back call the wallet refused leaves its booking held. */
    expect(refused.log).toEqual(['sponsored', 'done', 'stopped']);
  });

  it('another call of the same shape, or the same call with another deadline, handed back in its place is refused', async () => {
    for (const added of [{ proof: 'another proof', fee: { spends: 1 } }, { ttl: 2, fee: { spends: 1 } }]) {
      const { log, e } = await send((log) => ({ sponsor: sponsorship(log, added) }));
      /* RED WHEN: the wallet submits a different call to the same contract and circuit, or one made to expire, as this one. */
      expect(e?.message, JSON.stringify(added)).toMatch(/not the call with only its fee/u);
      expect(log).toEqual(['sponsored', 'done', 'stopped']);
    }
  });

  it('the same call bound again, so the chain would not know it by what this wallet holds, handed back is refused', async () => {
    const { log, e } = await send((log) => ({ sponsor: sponsorship(log, { bound: 'bound again', fee: { spends: 1 } }) }));
    /* RED WHEN: the wallet submits a call whose identifiers are not the ones it would later look for on the chain. */
    expect(e?.message).toMatch(/not the call with only its fee: it changes how the call is bound/u);
    expect(e?.nothingWasSent).toBe(true);
    expect(log).toEqual(['sponsored', 'done', 'stopped']);
  });

  it('what the sponsorship hands back with more than the fee is refused whole: nothing sent, nothing paid from the person\'s DUST', async () => {
    for (const added of [
      { fee: { spends: 1, calls: [{ circuit: 'propose', to: ACCOUNT }] } },
      { fee: { spends: 1, registrations: 1 } },
      { fee: { spends: 0 } },
      { circuit: 'cancel' },
      { to: VAULT, fee: { spends: 1 } },
    ]) {
      const { log, told, e } = await send((log) => ({ sponsor: sponsorship(log, added) }));
      /* RED WHEN: the wallet submits what the sponsorship changed beyond the fee, or pays for it again from the person's DUST. */
      expect(e?.nothingWasSent, JSON.stringify(added)).toBe(true);
      expect(e?.message, JSON.stringify(added)).toMatch(/not the call with only its fee/u);
      expect(log, JSON.stringify(added)).toEqual(['sponsored', 'done', 'stopped']);
      expect(told).toEqual([]);
    }
  });

  it('a call that is not the step\'s is refused before the sponsorship is asked', async () => {
    const { log, e } = await send((log) => ({ sponsor: sponsorship(log) }), { circuit: 'cancel', to: ACCOUNT });
    /* RED WHEN: our sponsorship is asked to pay for a call the step does not make. */
    expect(e?.nothingWasSent).toBe(true);
    expect(log).toEqual(['stopped']);
  });

  it('a call whose fee is paid goes to whoever submits it, finished, and once handed over a failure is never said as not sent', async () => {
    const handed: string[] = [];
    const { log, e } = await send((log) => ({ sponsor: sponsorship(log), submit: async (finished) => { handed.push(finished); } }));
    /* RED WHEN: the company's own service is handed anything but the call with its fee paid, or the wallet also sends it. */
    expect(e).toBeNull();
    expect(handed).toEqual([b64({ ...CALL, fee: { spends: 1 } })]);
    expect(log).toEqual(['sponsored', 'done', 'stopped']);
    const failed = await send((log) => ({ sponsor: sponsorship(log), submit: async () => { throw new Error('the company\'s own service did not answer'); } }));
    /* RED WHEN: a call that may have reached the company's own service is said as not sent, so it is sent again. */
    expect(failed.e?.nothingWasSent).not.toBe(true);
  });
});

describe('THE ACT IS TOLD OF EVERY CALL THIS WALLET HANDS OVER ITSELF', () => {
  const CALL = { circuit: 'approve', to: ACCOUNT };
  const APPROVE = { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' } as const;
  const sponsored: FeeAndSubmit['sponsor'] = async (tx) => ({ tx: b64({ ...JSON.parse(Buffer.from(tx, 'base64').toString()), fee: { spends: 1 } }) });
  const down: FeeAndSubmit['sponsor'] = async () => { throw Object.assign(new Error('the fee payer did not pay this fee'), { status: 503, nothingWasSent: true }); };
  const toldFor = async (way: FeeAndSubmit, tx: unknown = CALL): Promise<number> => {
    let told = 0;
    await straightFromTheOwnWallet(() => aWallet([]), Date.now, () => true, { over: false }, { ...way, handedOver: () => { told += 1; } })(b64(tx), APPROVE)
      .catch(() => undefined);
    return told;
  };

  it('once for a call paid from the person\'s DUST, once sponsored, once handed to the company\'s own service, and never for one refused before', async () => {
    /* RED WHEN: a call the wallet sent itself on any way is not told to the act, so a stop after it says nothing left the wallet. */
    expect(await toldFor({})).toBe(1);
    expect(await toldFor({ sponsor: down })).toBe(1);
    expect(await toldFor({ sponsor: sponsored })).toBe(1);
    expect(await toldFor({ sponsor: sponsored, submit: async () => undefined })).toBe(1);
    expect(await toldFor({ sponsor: sponsored, submit: async () => { throw new Error('the company\'s own service did not answer'); } })).toBe(1);
    /* RED WHEN: a call refused before anything was paid or sent is told to the act as handed over. */
    expect(await toldFor({ sponsor: sponsored }, { circuit: 'cancel', to: ACCOUNT })).toBe(0);
  });
});

describe('WHICH WAY AN ACT\'S CALLS GO', () => {
  const wallet = (log: string[]) => ({ ownWallet: () => aWallet(log) });

  it('the company\'s choice decides, never what the act names', () => {
    for (const fields of [{}, { path: 'service' }, { path: 'chain' }] as Record<string, string>[]) {
      /* RED WHEN: a page naming a way in the act sends a company's calls anywhere but where the company chose. */
      expect(handOverFor(anAct(fields), wallet([])).path).toBe('service');
      expect(handOverFor(anAct(fields), wallet([]), { choice: { service: 'none' } }).path).toBe('chain');
    }
  });

  it('with no wallet reached for the account, a call that is not ours to submit is not sent, and nothing falls back to our service', async () => {
    const over = handOverFor(anAct({}, null), wallet([]), { choice: { service: 'none' } });
    let relayed = false;
    const e = await handedOver(over, {
      tx: 'T', call: { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' },
      viaService: async () => { relayed = true; }, after: async () => undefined,
    }).then(() => null, (x: unknown) => x);
    /* RED WHEN: a call for the chain path is relayed by our service when no wallet can send it. */
    expect(e).toBeInstanceOf(NotHandedOver);
    expect(relayed).toBe(false);
  });

  it('a later call through the same hand-over that fails before it is handed over undoes its own fee and says nothing was sent', async () => {
    const log: string[] = [];
    let opened = 0;
    const secondCannotSign = {
      ownWallet: () => {
        const w = aWallet(log);
        return {
          ...w,
          facade: async () => {
            const f = await w.facade();
            opened += 1;
            const n = opened;
            return { ...f, signRecipe: async (r: never) => { if (n === 2) throw new Error('the wallet could not sign'); return r; } };
          },
        };
      },
    };
    const over = handOverFor(anAct({}), secondCannotSign, { choice: { service: 'none' } });
    const call = { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' } as const;
    await over.toChain!(b64({ circuit: 'approve', to: ACCOUNT }), call);
    const e = await over.toChain!(b64({ circuit: 'approve', to: ACCOUNT }), call).then(() => null, (x: unknown) => x as { nothingWasSent?: unknown });
    /* RED WHEN: a call refused before its hand-over keeps the fee it booked, or is said as perhaps sent, because an earlier call was handed over. */
    expect(e?.nothingWasSent).toBe(true);
    expect(log.filter((l) => l === 'fee undone')).toHaveLength(1);
  });

  it('the step is told a call may have been sent only once the wallet handed it over, never after a refusal before', async () => {
    const log: string[] = [];
    const over = handOverFor(anAct({}), wallet(log), { choice: { service: 'none' } });
    const refused = { over: false };
    await handOverMarked(over, refused).toChain!(b64({ circuit: 'cancel', to: ACCOUNT }), { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' })
      .catch(() => undefined);
    /* RED WHEN: a call the wallet refused before paying anything is said to the person as maybe sent. */
    expect(refused.over).toBe(false);
    const sent = { over: false };
    await handOverMarked(over, sent).toChain!(b64({ circuit: 'approve', to: ACCOUNT }), { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' });
    /* RED WHEN: a call the wallet sent is said to the person as not sent, so it is sent again. */
    expect(sent.over).toBe(true);
    const fellBack = { over: false };
    await handOverMarked(handOverFor(anAct({}), wallet([])), fellBack).fallback!.toChain(b64({ circuit: 'approve', to: ACCOUNT }), { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' });
    /* RED WHEN: a call that fell back from our service to the chain is said as not sent. */
    expect(fellBack.over).toBe(true);
  });
});

describe('A VAULT\'S START SENT STRAIGHT TO THE CHAIN IS HELD TO WHAT THE SERVICE WOULD RELAY', () => {
  const send = async (tx: unknown, call: Parameters<ReturnType<typeof straightFromTheOwnWallet>>[1]) => {
    const log: string[] = [];
    const e = await straightFromTheOwnWallet(() => aWallet(log), Date.now, () => true)(b64(tx), call).then(() => null, (x: unknown) => x);
    return { log, refused: e === null ? null : String((e as Error).message) };
  };
  const SECRET = { kind: 'vault-secret', contract: VAULT, circuit: 'setNonceSecret', account: ACCOUNT } as const;
  const COPY = { kind: 'vault-copy', contract: VAULT, circuit: 'writeSecretCopy' } as const;

  it('a first secret set with the account\'s approval of it, and one sealed copy written to the vault, are paid for and sent', async () => {
    /* RED WHEN: the vault's first secret, or a sealed copy of it, cannot be sent straight to the chain. */
    expect((await send({ calls: [{ to: ACCOUNT, circuit: 'approveVaultChange' }, { to: VAULT, circuit: 'setNonceSecret' }] }, SECRET)).log)
      .toEqual(['fee in dust', 'sent', 'stopped']);
    expect((await send({ circuit: 'writeSecretCopy', to: VAULT }, COPY)).log).toEqual(['fee in dust', 'sent', 'stopped']);
  });

  it('a secret set without the account\'s approval, a copy to another contract, or a vault call naming no account is refused before anything is paid', async () => {
    for (const [tx, call] of [
      [{ circuit: 'setNonceSecret', to: VAULT }, SECRET],
      [{ calls: [{ to: ACCOUNT, circuit: 'approveVaultChange' }, { to: ACCOUNT, circuit: 'setNonceSecret' }] }, SECRET],
      [{ circuit: 'writeSecretCopy', to: ACCOUNT }, COPY],
      [{ calls: [{ to: VAULT, circuit: 'writeSecretCopy' }, { to: VAULT, circuit: 'writeSecretCopy' }] }, COPY],
      [{ calls: [{ to: ACCOUNT, circuit: 'approveVaultChange' }, { to: VAULT, circuit: 'setNonceSecret' }] }, { ...SECRET, account: undefined }],
    ] as const) {
      const { log, refused } = await send(tx, call as never);
      /* RED WHEN: the person's wallet pays for a vault's start that the service would refuse to relay. */
      expect(refused, JSON.stringify(tx)).not.toBeNull();
      expect(log).toEqual(['stopped']);
    }
  });
});

/*
 * A payment, a merge and a public payment out of the vault, shaped as the ledger reads them, with the ledger's own
 * field names: the shapes the service's own checks are held to in `vault-submission.test.ts`.
 */
describe('A PAYMENT OUT OF THE VAULT SENT STRAIGHT TO THE CHAIN IS HELD TO WHAT THE SERVICE WOULD RELAY, AND THE WALLET PAYS ONLY ITS FEE', () => {
  const OTHER = 'ee'.repeat(32);
  const fee = () => new Map<unknown, bigint>([[{ tag: 'dust' }, -5n], [{ tag: 'shielded', raw: 'ab' }, 0n]]);
  const payout = (o: { actions?: unknown[]; inputs?: unknown[] } = {}) => ({
    intents: new Map([[1, { actions: o.actions ?? [{ address: ACCOUNT, entryPoint: 'recordPaymentFromVault' }, { address: VAULT, entryPoint: 'payout' }] }]]),
    guaranteedOffer: { inputs: o.inputs ?? [{ contractAddress: VAULT }], outputs: [{ contractAddress: undefined }, { contractAddress: VAULT }], transients: [] },
    fallibleOffer: undefined, imbalances: fee,
  });
  const merge = (o: { inputs?: unknown[] } = {}) => ({
    intents: new Map([[1, { actions: [{ address: VAULT, entryPoint: 'mergeNotes' }] }]]),
    guaranteedOffer: { inputs: o.inputs ?? [{ contractAddress: VAULT }, { contractAddress: VAULT }], outputs: [{ contractAddress: VAULT }], transients: [] },
    fallibleOffer: undefined, imbalances: fee,
  });
  const publicPayout = (o: { actions?: unknown[] } = {}) => ({
    intents: new Map([[1, {
      actions: o.actions ?? [{ address: ACCOUNT, entryPoint: 'recordPaymentFromVault' }, { address: VAULT, entryPoint: 'payoutUnshielded' }],
      guaranteedUnshieldedOffer: { inputs: [], outputs: [{ owner: 'c3'.repeat(32), type: 'a8'.repeat(32), value: 250n }], signatures: [] },
    }]]),
    guaranteedOffer: undefined, fallibleOffer: undefined,
    imbalances: () => new Map<unknown, bigint>([[{ tag: 'dust' }, -5n], [{ tag: 'unshielded' }, 0n]]),
  });
  const PAYOUT = { kind: 'payout', contract: VAULT, circuit: 'payout', account: ACCOUNT } as const;
  const MERGE = { kind: 'merge', contract: VAULT, circuit: 'merge', account: ACCOUNT } as const;
  const PUBLIC = { kind: 'public-payout', contract: VAULT, circuit: 'payoutUnshielded', account: ACCOUNT } as const;
  const send = async (tx: unknown, call: Parameters<ReturnType<typeof straightFromTheOwnWallet>>[1]) => {
    const log: string[] = [];
    const e = await straightFromTheOwnWallet(() => aWallet(log, new Map([[JSON.stringify('T'), tx]])), Date.now, () => true)(b64('T'), call).then(() => null, (x: unknown) => x);
    return { log, refused: e === null ? null : e as { message: string; nothingWasSent?: unknown } };
  };

  it('a payment, a merge and a public payment of the vault\'s own coins, asking the company\'s account where the service asks it, are paid for in DUST alone and sent', async () => {
    for (const [tx, call] of [[payout(), PAYOUT], [merge(), MERGE], [publicPayout(), PUBLIC]] as const) {
      /* RED WHEN: a payment out of the vault the service would relay cannot be sent straight to the chain, or the wallet pays it in anything but DUST. */
      const got = await send(tx, call);
      expect(got.refused?.message ?? null, call.kind).toBeNull();
      expect(got.log, call.kind).toEqual(['fee in dust', 'sent', 'stopped']);
    }
  });

  it('one spending another\'s coin, not asking the company\'s account, of the wrong kind, or naming no account is refused before anything is paid', async () => {
    for (const [tx, call] of [
      [payout({ inputs: [{ contractAddress: OTHER }] }), PAYOUT],
      [payout({ actions: [{ address: OTHER, entryPoint: 'recordPaymentFromVault' }, { address: VAULT, entryPoint: 'payout' }] }), PAYOUT],
      [payout(), { ...PAYOUT, account: undefined }],
      [merge({ inputs: [{ contractAddress: VAULT }] }), MERGE],
      [merge({ inputs: [{ contractAddress: VAULT }, { contractAddress: OTHER }] }), MERGE],
      [publicPayout({ actions: [{ address: ACCOUNT, entryPoint: 'recordPaymentFromVault' }, { address: OTHER, entryPoint: 'payoutUnshielded' }] }), PUBLIC],
      [publicPayout(), PAYOUT],
      [payout(), PUBLIC],
    ] as const) {
      const { log, refused } = await send(tx, call as never);
      /* RED WHEN: the person's wallet pays for, or sends, a payment out of the vault the service would refuse to relay. */
      expect(refused?.nothingWasSent, call.kind).toBe(true);
      expect(log).toEqual(['stopped']);
    }
  });
});

describe('A CALL THE WALLET COULD NOT GET READY IS SAID AS NOT SENT', () => {
  it('a wallet whose ledger, DUST, signing or finishing fails before the call is handed over sends nothing, undoes any fee, and says so', async () => {
    const tx = b64({ circuit: 'approve', to: ACCOUNT });
    const call = { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' } as const;
    const failing = (log: string[], where: 'ledger' | 'facade' | 'sign' | 'finish'): OwnWalletDoors => {
      const w = aWallet(log);
      const fail = async (): Promise<never> => { throw new Error(`the wallet's ${where} failed`); };
      if (where === 'ledger') return { ...w, ledger: fail };
      if (where === 'facade') return { ...w, facade: fail };
      return {
        ...w,
        facade: async () => ({ ...(await w.facade()), ...(where === 'sign' ? { signRecipe: fail } : { finalizeRecipe: fail }) }),
      };
    };
    for (const where of ['ledger', 'facade', 'sign', 'finish'] as const) {
      const log: string[] = [];
      const e = await straightFromTheOwnWallet(() => failing(log, where), Date.now, () => true)(tx, call).then(() => null, (x: unknown) => x);
      /* RED WHEN: a call that never reached the network is said as maybe sent, so its payment is held as on its way. */
      expect((e as { nothingWasSent?: unknown } | null)?.nothingWasSent, where).toBe(true);
      expect(log, where).not.toContain('sent');
      /* RED WHEN: a fee added before signing failed is left booked in the person's wallet. */
      if (where === 'sign' || where === 'finish') expect(log, where).toContain('fee undone');
    }
  });
});
