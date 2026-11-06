/**
 * **A SERVICE THAT GIVES NO ANSWER AT ALL IS GONE AROUND ON THE CHAIN, AND A CALL THAT MAY HAVE REACHED IT IS LOOKED
 * FOR ON THE CHAIN BEFORE IT IS SENT AGAIN.**
 *
 * The person's wallet is a stand-in that logs what it reads and sends, and reads a call by the words written into
 * it; whether a call is already on the chain is a stand-in for the wallet's own indexer. Our service and the
 * company's own service are stand-ins that answer, refuse, or give no answer at all.
 */
import { describe, it, expect } from 'vitest';
import { OUR_SERVICE, type CompanyService } from '../../../../src/midnight/company-service-record.js';
import { handedOver, notThroughOurService, ServiceNotReached, serviceNotReached } from '../../../../packages/web-shared/src/hand-over.js';
import { governedCallServiceFor, nothingWasSentBy } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { vaultServiceFor } from '../../../../packages/web-shared/src/vault-page-doors.js';
import WORDS from '../locales/en.json';
import { apiOver, handOverFor } from './company-reach.js';
import { FELL_ORDER, fellBackLine, type FellBack } from './fall-back-line.js';
import type { StepContext } from './definition.js';

const ACCOUNT = 'ac'.repeat(32);
const OWN: CompanyService = { service: 'own', at: 'https://relay.example.com' };
const NONE: CompanyService = { service: 'none' };
const APPROVE = { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' } as const;

const anAct = (shown: unknown[]) => ({
  intent: { name: 'approve-proposal', fields: {} }, held: { identity: {} as never, account: 0 }, signal: new AbortController().signal,
  show: (words: unknown) => { shown.push(words); },
}) as unknown as Pick<StepContext, 'intent' | 'held' | 'signal' | 'show'>;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const CALL = b64({ circuit: 'approve', to: ACCOUNT });
const intentOf = (actions: readonly unknown[]) =>
  ({ actions, guaranteedUnshieldedOffer: undefined, fallibleUnshieldedOffer: undefined, dustActions: undefined });
/**
 * This wallet's ledger: a call read by its words, naming one identifier the chain would index it by, kept whatever
 * fee is added. Every call it is asked to read is written down in `read`.
 */
const ledgerReading = (read: string[]) => async () => ({
  Transaction: {
    deserialize: (_s: 'signature', _p: 'proof', _b: 'pre-binding' | 'binding', raw: Uint8Array) => {
      read.push(Buffer.from(raw).toString('base64'));
      const t = JSON.parse(Buffer.from(raw).toString()) as { circuit: string; to: string; fee?: true };
      const intents = new Map<number, unknown>([[1, intentOf([{ address: t.to, entryPoint: t.circuit, toString: () => `${t.to}:${t.circuit}` }])]]);
      if (t.fee === true) intents.set(2, { ...intentOf([]), dustActions: { spends: [1], registrations: [] } });
      return {
        guaranteedOffer: undefined, fallibleOffer: undefined, intents, imbalances: () => new Map(),
        identifiers: () => [`id:${t.to}:${t.circuit}`], serialize: () => raw,
      };
    },
  },
}) as never;

interface World {
  /** What the wallet's own read of the chain answers, in turn; the last answer holds after. */
  readonly onChain?: readonly (boolean | 'unreadable')[];
  /** Whether the network refuses what the wallet hands it. */
  readonly refusesTheSend?: boolean;
  /** Whether the person's wallet pays the fee from its own DUST. */
  readonly ownDust?: boolean;
  /** How the company's own service answers a finished call. */
  readonly ownService?: 'takes' | 'unreached' | 'answers-500';
  /** Every call the wallet's ledger was asked to read, in turn. */
  readonly read?: string[];
}

/* The person's wallet: it logs what it reads and sends; the chain read and the network answer as the world says. */
const aChain = (log: unknown[], w: World = {}) => {
  let reads = 0;
  return {
    ownWallet: () => ({
      ledger: ledgerReading(w.read ?? []), keys: () => ({}) as never, signSegment: () => ({}) as never,
      landed: async (ids: readonly string[]) => {
        log.push(`read the chain for ${ids.join(',')}`);
        const answers = w.onChain ?? [false];
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        if (answer === 'unreadable') throw new Error('the indexer did not answer');
        return answer === true;
      },
      facade: async () => ({
        dust: { state: { subscribe: (s: { next: (x: unknown) => void }) => { s.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } } },
        balanceUnboundTransaction: async (call: unknown) => {
          if (w.ownDust !== true) throw new Error('no fee is paid from this wallet');
          log.push('own DUST');
          return { baseTransaction: call, balancingTransaction: { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[2, { ...intentOf([]), dustActions: { spends: [1], registrations: [] } }]]) } };
        },
        signRecipe: async (r: unknown) => r,
        finalizeRecipe: async (r: { baseTransaction: unknown }) => ({ ...(r.baseTransaction as object), identifiers: () => [`id:${ACCOUNT}:approve`], serialize: () => Buffer.from(CALL, 'base64') }),
        submitTransaction: async () => {
          /* A stand-in for the ledger refusing a second copy of one call, which `one-call-lands-once-on-the-ledger.test.ts` pins on the ledger itself. */
          if (w.refusesTheSend === true) { log.push('the network refused it'); throw new Error('replay protection has been violated: IntentAlreadyExists'); }
          log.push('sent to the chain');
        },
        revert: async () => undefined,
      }) as never,
    }),
    fetch: (async (url: string) => {
      log.push(`handed to ${url}`);
      if (w.ownService === 'unreached') throw new TypeError('Failed to fetch');
      return new Response('{}', { status: w.ownService === 'answers-500' ? 500 : 200 });
    }) as typeof fetch,
  };
};
/* Our fee sponsorship: hands the call back with one DUST spend added. */
const sponsorship = (log: unknown[]) => async (tx: string) => {
  log.push('sponsored');
  return { tx: b64({ ...JSON.parse(Buffer.from(tx, 'base64').toString()), fee: true }) };
};
/* Our fee sponsorship giving no answer at all. */
const sponsorshipUnreached = (log: unknown[]) => async () => {
  log.push('sponsorship gave no answer');
  throw new ServiceNotReached('the company\'s service could not be reached', false);
};

/** Hands one call over: what our service was asked, what the step got back, and what refused it. */
const handing = async (over: ReturnType<typeof handOverFor>, viaService: () => Promise<string> = async () => 'relayed by our service') => {
  let asked = 0;
  const e = await handedOver(over, {
    tx: CALL, call: APPROVE,
    viaService: async () => { asked += 1; return viaService(); }, after: async () => 'read from our service\'s record',
  }).then((got) => ({ got }), (x: unknown) => ({ refused: (x as Error).message, nothingWasSent: (x as { nothingWasSent?: unknown }).nothingWasSent }));
  return { asked, ...e };
};
const unreached = (nothingWasSent: boolean) => async (): Promise<string> => {
  throw new ServiceNotReached('the company\'s service could not be reached', nothingWasSent);
};

describe('OUR SERVICE CANNOT BE REACHED, AND NOTHING WAS HANDED OVER', () => {
  it('the call goes straight to the chain once, without reading the chain first, and the window says why in one line', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const over = handOverFor(anAct(shown), aChain(log), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
    const got = await handing(over, unreached(true));
    /* RED WHEN: a service that took nothing because it could not be reached stops a call the chain can take. */
    expect(got).toEqual({ asked: 1, got: 'read from our service\'s record' });
    /* RED WHEN: the call is sent more than once, or not straight to the chain. */
    expect(log).toEqual(['sponsored', 'sent to the chain']);
    /* RED WHEN: the window does not say the service could not be reached, or says it in more than one line. */
    expect(shown).toEqual([{ key: 'act.fell-back.unreached' }]);
    expect(notThroughOurService(over)).toBe(true);
  });

  it('with fee sponsorship unreachable too, the person\'s own DUST pays, and the one line says both', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const over = handOverFor(anAct(shown), aChain(log, { ownDust: true }), { choice: OUR_SERVICE }, Date.now, sponsorshipUnreached(log));
    const got = await handing(over, unreached(true));
    /* RED WHEN: a sponsorship that gave no answer refuses the call instead of the person's own DUST paying for it. */
    expect(got).toEqual({ asked: 1, got: 'read from our service\'s record' });
    expect(log).toEqual(['sponsorship gave no answer', 'own DUST', 'sent to the chain']);
    /* RED WHEN: the line does not say the fee came from the person's own DUST. */
    expect(shown.at(-1)).toEqual({ key: 'act.fell-back.unreached-own-dust' });
  });
});

describe('THE CALL WENT OUT TO OUR SERVICE AND NO ANSWER CAME BACK', () => {
  it('found on the chain: it is not sent again, and is reported as sent', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const over = handOverFor(anAct(shown), aChain(log, { onChain: [true] }), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
    const got = await handing(over, unreached(false));
    /* RED WHEN: a call the service took, which is on the chain, is sent again or reported as not sent. */
    expect(got).toEqual({ asked: 1, got: 'read from our service\'s record' });
    expect(log).toEqual([`read the chain for id:${ACCOUNT}:approve`]);
    /* RED WHEN: the window says the call went another way, when it went through our service. */
    expect(shown).toEqual([]);
    expect(notThroughOurService(over)).toBe(false);
  });

  it('not on the chain: it goes straight to the chain once, after the chain was read', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const over = handOverFor(anAct(shown), aChain(log, { onChain: [false] }), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
    const got = await handing(over, unreached(false));
    /* RED WHEN: a call that may have reached the service is sent without the chain being read first, or not sent at all. */
    expect(got).toEqual({ asked: 1, got: 'read from our service\'s record' });
    expect(log).toEqual([`read the chain for id:${ACCOUNT}:approve`, 'sponsored', 'sent to the chain']);
    expect(shown).toEqual([{ key: 'act.fell-back.unreached' }]);
  });

  it('landing meanwhile: the network refuses the second, the chain is read again, and it is reported as sent', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const over = handOverFor(anAct(shown), aChain(log, { onChain: [false, true], refusesTheSend: true }), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
    const got = await handing(over, unreached(false));
    /* RED WHEN: a call that landed while the wallet sent it again is reported as failed or as not sent. */
    expect(got).toEqual({ asked: 1, got: 'read from our service\'s record' });
    expect(log).toEqual([`read the chain for id:${ACCOUNT}:approve`, 'sponsored', 'the network refused it', `read the chain for id:${ACCOUNT}:approve`]);
  });

  it('the chain cannot be read: nothing is sent again, and the words say not to send it again', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const over = handOverFor(anAct(shown), aChain(log, { onChain: ['unreadable'] }), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
    const got = await handing(over, unreached(false));
    /* RED WHEN: a call that may have reached the service is sent blind when the chain cannot be read. */
    expect(log).toEqual([`read the chain for id:${ACCOUNT}:approve`]);
    expect(got).toMatchObject({ asked: 1, refused: expect.stringMatching(/may have reached the company's service.*Do not send it again/su), nothingWasSent: false });
    expect(shown).toEqual([]);
  });
});

describe('A SERVICE THAT ANSWERS DECIDES', () => {
  it('a deliberate refusal is shown and never sent around, nor the chain read', async () => {
    for (const answer of [
      Object.assign(new Error('this proposal was already approved. Nothing was sent.'), { status: 409, nothingWasSent: true }),
      Object.assign(new Error('the network refused this transaction'), { status: 422, code: 'network-refused', nothingWasSent: true }),
      Object.assign(new Error('the node did not answer'), { status: 502, nothingWasSent: false }),
    ]) {
      const log: unknown[] = [];
      const shown: unknown[] = [];
      const over = handOverFor(anAct(shown), aChain(log), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
      const got = await handing(over, async () => { throw answer; });
      /* RED WHEN: a call our service answered for is sent another way, or the chain is read to second-guess it. */
      expect(got, answer.message).toMatchObject({ asked: 1, refused: answer.message });
      expect(log, answer.message).toEqual([]);
      expect(shown, answer.message).toEqual([]);
    }
  });

  it('the filed choice still decides: ours relays, none sends straight, and the company\'s own takes it', async () => {
    const ours: unknown[] = [];
    /* RED WHEN: a company that chose ours has its call sent anywhere else while ours answers. */
    expect(await handing(handOverFor(anAct([]), aChain(ours), { choice: OUR_SERVICE }, Date.now, sponsorship(ours)))).toEqual({ asked: 1, got: 'relayed by our service' });
    expect(ours).toEqual([]);
    const none: unknown[] = [];
    /* RED WHEN: a company that chose no service has its call relayed. */
    expect(await handing(handOverFor(anAct([]), aChain(none), { choice: NONE }, Date.now, sponsorship(none)))).toEqual({ asked: 0, got: 'read from our service\'s record' });
    expect(none).toEqual(['sponsored', 'sent to the chain']);
    const own: unknown[] = [];
    const shown: unknown[] = [];
    /* RED WHEN: a company that chose its own service has its call sent anywhere else while that service answers. */
    expect(await handing(handOverFor(anAct(shown), aChain(own, { ownService: 'takes' }), { choice: OWN }, Date.now, sponsorship(own)))).toEqual({ asked: 0, got: 'read from our service\'s record' });
    expect(own).toEqual(['sponsored', 'handed to https://relay.example.com/relay']);
    expect(shown).toEqual([]);
  });

  it('the company\'s own service answering with a failure is never gone around', async () => {
    const log: unknown[] = [];
    const got = await handing(handOverFor(anAct([]), aChain(log, { ownService: 'answers-500' }), { choice: OWN }, Date.now, sponsorship(log)));
    /* RED WHEN: a call the company's own service answered for is sent straight to the chain as well. */
    expect(got).toMatchObject({ asked: 0, refused: expect.stringMatching(/answered 500; the call may have reached it/u) });
    expect(log).toEqual(['sponsored', 'handed to https://relay.example.com/relay']);
  });
});

describe('THE COMPANY\'S OWN SERVICE GIVES NO ANSWER AT ALL', () => {
  it('not on the chain: the same finished call goes from the wallet to the network once, said in one line', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const got = await handing(handOverFor(anAct(shown), aChain(log, { ownService: 'unreached', onChain: [false] }), { choice: OWN }, Date.now, sponsorship(log)));
    /* RED WHEN: the company's own service giving no answer stops a call the chain can take, or it is sent without the chain read first. */
    expect(got).toEqual({ asked: 0, got: 'read from our service\'s record' });
    expect(log).toEqual(['sponsored', 'handed to https://relay.example.com/relay', `read the chain for id:${ACCOUNT}:approve`, 'sent to the chain']);
    expect(shown).toEqual([{ key: 'act.fell-back.unreached' }]);
  });

  it('on the chain: it is not sent again', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const got = await handing(handOverFor(anAct(shown), aChain(log, { ownService: 'unreached', onChain: [true] }), { choice: OWN }, Date.now, sponsorship(log)));
    /* RED WHEN: a call the company's own service took, which is on the chain, is sent again. */
    expect(got).toEqual({ asked: 0, got: 'read from our service\'s record' });
    expect(log).toEqual(['sponsored', 'handed to https://relay.example.com/relay', `read the chain for id:${ACCOUNT}:approve`]);
    expect(shown).toEqual([]);
  });
});

describe('THE CALL SENT AROUND IS THE VERY CALL THAT WAS PROVEN', () => {
  it('the wallet reads, looks for and sends the call it handed our service, never another built in its place', async () => {
    const log: unknown[] = [];
    const read: string[] = [];
    const over = handOverFor(anAct([]), aChain(log, { onChain: [false], read }), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
    const got = await handing(over, unreached(false));
    /* RED WHEN: the call sent straight to the chain is anything but the one handed to our service, or is built again. */
    expect(got).toEqual({ asked: 1, got: 'read from our service\'s record' });
    /* The wallet reads the call to look for it, then to send it; the only other call it reads is that call with its fee added. */
    const SPONSORED = b64({ circuit: 'approve', to: ACCOUNT, fee: true });
    expect(read.filter((x) => x === CALL)).toHaveLength(2);
    expect(read.filter((x) => x !== CALL && x !== SPONSORED)).toEqual([]);
  });
});

describe('A SERVICE THAT GIVES NO ANSWER IS SEEN AS THAT THROUGH EVERY ROUTE A MONEY CALL TAKES', () => {
  /* The service's routes as the window reaches them: every call goes out through the page, which heard nothing back. */
  const silent = apiOver({ call: async () => { throw new ServiceNotReached('the company\'s service could not be reached', false); } });
  const roster = async () => ({ signers: [] }) as never;
  it('approve, send, file, carry, charge, cancel, payout, merge and deposit each carry the mark through', async () => {
    const governed = governedCallServiceFor(silent);
    const vaults = vaultServiceFor(silent, 'acc_1', roster);
    const calls: [string, () => Promise<unknown>][] = [
      ['approve', () => governed.approve('p1', { tx: CALL } as never)],
      ['send', () => governed.send('p1', { tx: CALL } as never)],
      ['file', () => governed.file!('acc_1', { tx: CALL } as never)],
      ['carry', () => governed.carry!('p1', { tx: CALL } as never)],
      ['charge', () => governed.charge!('p1', { tx: CALL } as never)],
      ['cancel', () => governed.cancel!('p1', { tx: CALL } as never)],
      ['payout', () => vaults.payout!('ab'.repeat(32), CALL)],
      ['merge', () => vaults.merge!('ab'.repeat(32), CALL)],
      ['deposit', () => vaults.depositPublicly!('ab'.repeat(32), CALL)],
    ];
    for (const [name, call] of calls) {
      const e = await call().then(() => null, (x: unknown) => x);
      /* RED WHEN: a money call's route drops the mark, so a service that gave no answer is never gone around. */
      expect(serviceNotReached(e), name).toBe(true);
      expect((e as { nothingWasSent?: unknown }).nothingWasSent, name).toBe(false);
    }
  });

  it('an approval through the routes is looked for on the chain and, absent, sent straight', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const over = handOverFor(anAct(shown), aChain(log, { onChain: [false] }), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
    const e = await handedOver(over, {
      tx: CALL, call: APPROVE, viaService: () => governedCallServiceFor(silent).approve('p1', { tx: CALL } as never), after: async () => 'kept' as never,
    }).then((x) => x, (x: unknown) => x);
    /* RED WHEN: an approval our service gave no answer to stops instead of being read for and sent straight. */
    expect(e).toBe('kept');
    expect(log).toEqual([`read the chain for id:${ACCOUNT}:approve`, 'sponsored', 'sent to the chain']);
    expect(shown).toEqual([{ key: 'act.fell-back.unreached' }]);
  });

  it('a call that got no answer is never read as nothing sent by a step that handed anything over', () => {
    /* RED WHEN: a read with no answer after a hand-over lets the step say nothing was sent. */
    expect(nothingWasSentBy(new ServiceNotReached('the company\'s service could not be reached', true))).toBe(false);
    expect(nothingWasSentBy(Object.assign(new Error('this proposal was already approved. Nothing was sent.'), { nothingWasSent: true }))).toBe(true);
  });
});

describe('THE ONE PLAIN LINE', () => {
  it('every mix of reasons a window can fall back for has its line, in words', () => {
    const subsets = <T>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((all, x) => [...all, ...all.map((s) => [...s, x])], [[]]).filter((s) => s.length > 0);
    const mixes: FellBack[][] = [
      ...subsets<FellBack>(['chain', 'unreached', 'own-dust']),
      ...subsets<FellBack>(['unread', 'own-dust']).filter((s) => s.includes('unread')),
    ];
    for (const mix of mixes) {
      const key = fellBackLine(new Set(mix));
      /* RED WHEN: a mix of reasons leaves the window saying less than happened, a fee from the person's own DUST included. */
      expect(key, mix.join(',')).toBeDefined();
      expect((WORDS as Record<string, string>)[key!], mix.join(',')).toEqual(expect.any(String));
    }
    expect(FELL_ORDER).toEqual(['chain', 'unread', 'unreached', 'own-dust']);
  });

  it('one window, one call our service could not take and one it gave no answer to: the line says both', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const over = handOverFor(anAct(shown), aChain(log, { ownDust: true }), { choice: OUR_SERVICE }, Date.now, sponsorshipUnreached(log));
    await handing(over, async () => { throw Object.assign(new Error('this deployment does not send transactions'), { status: 503, nothingWasSent: true }); });
    await handing(over, unreached(true));
    /* RED WHEN: the second fallback leaves the first one's line, or the own DUST that paid goes unsaid. */
    expect(shown.at(-1)).toEqual({ key: 'act.fell-back.chain-unreached-own-dust' });
  });

  it('nothing is said to have gone straight to the chain when it did not go', async () => {
    for (const viaService of [unreached(true), unreached(false), async (): Promise<string> => { throw Object.assign(new Error('the service answered 503'), { status: 503, nothingWasSent: true }); }]) {
      const log: unknown[] = [];
      const shown: unknown[] = [];
      /* The sponsorship gave no answer and the person's wallet has no DUST, so the straight send is refused. */
      const over = handOverFor(anAct(shown), aChain(log, { onChain: [false] }), { choice: OUR_SERVICE }, Date.now, sponsorshipUnreached(log));
      const got = await handing(over, viaService);
      /* RED WHEN: the window says the call went straight to the chain when the wallet sent nothing. */
      expect(got).toMatchObject({ refused: expect.any(String) });
      expect(log).not.toContain('sent to the chain');
      expect(shown).toEqual([]);
    }
  });
});
