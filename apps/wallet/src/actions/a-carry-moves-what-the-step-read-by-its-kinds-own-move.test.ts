import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { ActEnded, ActingChannel, CalledOver, StepAt } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { treeKeptInMemory } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { NO_OWN_CHAIN_READS } from './step-views.test-support.js';
import type { ReadHere } from '../../../../packages/web-shared/src/records-as-anchored.js';
import { runAction } from './run.js';
import type { ActionDefinition, Held, StepContext } from './definition.js';
import type { CompanyReach } from './company-reach.js';
import { CARRIED_BY, thresholdSet, type MovingKind } from './holders-moved-here.js';
import { SentStraightNotRecorded } from '../../../../packages/web-shared/src/hand-over.js';
import {
  approving,
  carryStep,
  isChainOnly,
  proposalKinds,
  type CarryOut,
  type ProposalKind
} from './proposal-kinds.js';

vi.mock('midnight-identity/profile/act-intents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity/profile/act-intents')>();
  return {
    ...actual,
    ACT_INTENTS: Object.freeze({
      'carry-it': {
        fields: { company: 'record' },
        relays: [],
        calls: [
          { method: 'GET', path: '/api/accounts/:company/directory' },
          { method: 'POST', path: '/api/accounts/:company/manifest/newest', reads: true },
          { method: 'POST', path: '/api/proposals/:proposal/carry', sends: true },
          { method: 'POST', path: '/api/proposals/:proposal/closed' }
        ]
      }
    })
  };
});

/*
 * **A CARRY MOVES WHAT THE STEP READ BY ITS KIND'S OWN MOVE, BY WHICHEVER WAY IT GOES.** The one carry step declares the
 * move its kind names (one table, holders-moved-here.ts) for the carry written through the view and, when the service
 * took nothing of it, for the same call sent straight to the chain: what the step writes after it is checked against
 * the company moved by exactly that. A call that moves who holds the company and is not the kind's own carry is never
 * sent straight from a carry.
 */

const START = 1_755_000_000_000;
const ACCOUNT = 'c0'.repeat(32);
const held = { identity: {}, secret: new Uint8Array(32) } as unknown as Held;
const request: ActRequest = {
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'act',
  requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'A test.',
  nonce: 'n1',
  expiresAt: START + 20 * 60_000,
  hearsProgress: true,
  intent: { name: 'carry-it' as never, fields: { company: 'acc_1', proposal: 'prp_1', threshold: '2' } }
} as ActRequest;

/** The company on the chain as this test moves it, every call the page was handed, and how the service answers a carry. */
const aCompany = () => {
  const chain = {
    seats: ['aa', 'bb'],
    approvals: 1,
    adoptedVaults: [],
    threshold: 1,
    committee: [{ tag: 'schnorr', value: '11' }],
    vaultThresholds: [],
    policyBar: null
  };
  const posted: string[] = [];
  const ended: ActEnded[] = [];
  const service = { takesTheCarry: false };
  const answer = (path: string, body?: string): CalledOver => {
    if (path.endsWith('/directory')) return { of: 'answered', status: 200, body: { filings: [] } };
    if (path.endsWith('/manifest/newest'))
      return {
        of: 'answered',
        status: 200,
        body: { versions: (JSON.parse(body!) as { records: unknown[] }).records.map(() => 0) }
      };
    if (path.endsWith('/carry') && !service.takesTheCarry)
      return { of: 'answered', status: 503, body: { nothingWasSent: true, error: 'the service could not send it' } };
    return { of: 'answered', status: 200, body: {} };
  };
  const channel = {
    step: () => true,
    relay: async () => 'relayed',
    call: async (_at: StepAt, method: string, path: string, body?: string) => {
      posted.push(`${method} ${path}`);
      return answer(path, body);
    },
    answer: (a: unknown) => {
      ended.push(a as ActEnded);
      return true;
    }
  } as unknown as ActingChannel;
  const holders = async () => ({ ...chain, seats: [...chain.seats] }) as unknown as AccountHoldersRead;
  const viewOf = (ctx: StepContext) =>
    ctx.viewFor(
      'acc_1',
      {
        holders,
        onChain: async () => ({}) as never,
        builder: { anchorHeads: async () => ({}) as never },
        pause: async () => undefined,
        kept: () => treeKeptInMemory(),
        directory: async () => {
          throw new Error('no directory is read here');
        },
        chain: NO_OWN_CHAIN_READS
      },
      async () => ({}) as ReadHere
    );
  /* The company as the carry step reads it: the proposal at its bar, and the step's own door straight to the chain. */
  const read = {
    at: async (ctx: StepContext) =>
      ({
        account: ACCOUNT,
        chain: { indexer: 'http://indexer' },
        holders,
        builder: { roundsOnChain: async () => ({ ch_1: { held: 'open', approvals: 2, needed: 2 } }) },
        stepView: viewOf(ctx),
        straight: ctx.sendStraight
      }) as unknown as CompanyReach,
    renew: () => undefined
  };
  return { chain, posted, ended, channel, service, read };
};

const kindOf = (carries?: ProposalKind['carries']): ProposalKind => ({
  fields: [],
  changesTheCompany: true,
  shown: async () => [],
  check: () => null,
  opened: async () => ({ id: 'prp_1', chainId: 'ch_1' }),
  needed: () => 2,
  approve: async () => undefined,
  stateAt: () => null,
  why: (stop) => ({ key: `act.carry-it.why.${stop}` }),
  ...(carries === undefined ? {} : { carries })
});

/* The kind's carry as the shared code sends it: through the view first, straight to the chain when the service took nothing, then its close written. */
const carriedAs =
  (circuit: string, chainMoves: () => void): CarryOut =>
  async (_ctx, r) => {
    const view = (
      r as unknown as {
        stepView: { current(): { holders(): Promise<unknown>; write(w: unknown[]): Promise<unknown> } };
      }
    ).stepView;
    await view.current().holders();
    const sent = await view
      .current()
      .write([{ to: 'proposal', id: 'prp_1', act: 'carry', body: {} }])
      .then(
        () => true,
        () => false
      );
    if (!sent) {
      const straight = (r as unknown as { straight: StepContext['sendStraight'] }).straight;
      await straight(
        async (door) => {
          door.handedOver();
        },
        [],
        [{ circuit, contract: ACCOUNT.toUpperCase() }]
      );
    }
    chainMoves();
    await view.current().write([{ to: 'proposal', id: 'prp_1', act: 'closed', body: {} }]);
  };

const go = (c: ReturnType<typeof aCompany>, kind: ProposalKind, carryOut: CarryOut) => {
  const here = { ...approving(), round: { id: 'prp_1', chainId: 'ch_1' } };
  return runAction({
    definition: {
      headline: 'ask.act.headline',
      shown: async () => [],
      checks: [],
      check: async () => null,
      steps: () => [carryStep(kind, request.intent, c.read, here, { key: 'ask.act.headline' }, carryOut)]
    } as ActionDefinition,
    request,
    channel: c.channel,
    held,
    stop: new AbortController().signal,
    now: () => Date.now()
  });
};

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a carry moves what the step read by its kind's own move, by whichever way it goes", () => {
  const threshold = kindOf(() => ({ kind: 'threshold', move: thresholdSet(2) }));

  it("writes the close after a carry the service took, the company moved by the kind's move and by nothing more", async () => {
    for (const to of [2, 3]) {
      const c = aCompany();
      c.service.takesTheCarry = true;
      await go(
        c,
        threshold,
        carriedAs('setThreshold', () => {
          c.chain.approvals = to;
        })
      );
      /* RED WHEN: the carry step declares no move for the carry written through the view, or a change beyond it passes. */
      expect(c.posted.includes('POST /api/proposals/prp_1/closed'), String(to)).toBe(to === 2);
      expect(c.ended[0], String(to)).toMatchObject(to === 2 ? { ended: 'done' } : { ended: 'stopped' });
    }
  });

  it('writes the close after a carry the service took nothing of and the wallet sent straight to the chain', async () => {
    for (const to of [2, 3]) {
      const c = aCompany();
      await go(
        c,
        threshold,
        carriedAs('setThreshold', () => {
          c.chain.approvals = to;
        })
      );
      expect(c.posted).toContain('POST /api/proposals/prp_1/carry');
      /* RED WHEN: the service's refusal drops the move, so the carry the wallet sent itself is taken for another signer's change. */
      expect(c.posted.includes('POST /api/proposals/prp_1/closed'), String(to)).toBe(to === 2);
      expect(c.ended[0], String(to)).toMatchObject(to === 2 ? { ended: 'done' } : { ended: 'stopped' });
    }
  });

  it('sends no call that moves who holds the company straight from a carry whose kind does not carry it out by that call', async () => {
    for (const kind of [kindOf(), threshold]) {
      const c = aCompany();
      const straight: string[] = [];
      const carryOut: CarryOut = async (_ctx, r) => {
        await (r as unknown as { straight: StepContext['sendStraight'] }).straight(
          async (door) => {
            door.handedOver();
            straight.push('sent');
          },
          [],
          [{ circuit: 'setPolicyBar', contract: ACCOUNT }]
        );
      };
      await go(c, kind, carryOut);
      /* RED WHEN: a carry sends straight to the chain a call no table entry of its kind declares a move for. */
      expect(straight).toEqual([]);
      expect(c.ended[0]).toMatchObject({ ended: 'stopped' });
    }
  });

  it('moves what the step read once for a carry sent straight to the chain, though its close is written on the same proposal after it', async () => {
    const c = aCompany();
    let applied = 0;
    const counted = kindOf(() => ({
      kind: 'threshold',
      move: (h) => {
        applied += 1;
        return thresholdSet(2)(h);
      }
    }));
    /* The company's hand-over goes straight to the chain: the service is never asked to carry it. */
    const straightOnly: CarryOut = async (_ctx, r) => {
      const view = (
        r as unknown as {
          stepView: { current(): { holders(): Promise<unknown>; write(w: unknown[]): Promise<unknown> } };
        }
      ).stepView;
      await view.current().holders();
      await (r as unknown as { straight: StepContext['sendStraight'] }).straight(
        async (door) => {
          door.handedOver();
        },
        [],
        [{ circuit: 'setThreshold', contract: ACCOUNT }]
      );
      c.chain.approvals = 2;
      await view.current().write([{ to: 'proposal', id: 'prp_1', act: 'closed', body: {} }]);
    };
    await go(c, counted, straightOnly);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
    /* RED WHEN: the close written on the proposal after a straight carry takes the carry's move again. */
    expect(applied).toBe(1);
  });

  it('says a carry that may be on the chain may have been sent, never that it was not carried', async () => {
    const c = aCompany();
    const onTheChain: CarryOut = async () => {
      throw new SentStraightNotRecorded('the service did not answer', 'on-chain');
    };
    await go(
      c,
      kindOf(() => ({ kind: 'threshold', move: thresholdSet(2) })),
      onTheChain
    );
    /* RED WHEN: a carry the chain may hold, which the wallet did not hand over itself, is said as not carried out. */
    expect(c.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.carry-it.why.may-be-sent' });
  });

  it('names, for each kind the table lists, the move of that kind and no other, and no move for any other kind', () => {
    const VAULT = 'ab'.repeat(32);
    const fields: Readonly<Record<MovingKind, Record<string, string>>> = {
      threshold: { threshold: '2' },
      'vault-threshold': { threshold: '2', vault: VAULT },
      removal: { leaf: 'cd'.repeat(32), threshold: '0' },
      'spending-policy': { vault: VAULT },
      'policy-bar': { bar: '2' },
      'adopt-vault': { vault: VAULT },
      'retire-vault': { vault: VAULT }
    };
    const round = {
      id: 'prp_1',
      chainId: 'ch_1',
      read: { asset: 'a', chainId: 'ch_1', opening: { terms: { bands: [{ approvals: '2' }] } } }
    };
    const kinds = proposalKinds({} as never);
    for (const [name, kind] of Object.entries(kinds)) {
      if (isChainOnly(kind)) continue;
      const listed = name in CARRIED_BY;
      /* RED WHEN: a kind the table lists carries out with no move named, or names another kind's, or a kind it does not list names one. */
      expect(kind.carries !== undefined, name).toBe(listed);
      if (listed)
        expect(
          kind.carries!({ name: 'approve-proposal' as never, fields: fields[name as MovingKind] }, round).kind,
          name
        ).toBe(name);
    }
  });
});
