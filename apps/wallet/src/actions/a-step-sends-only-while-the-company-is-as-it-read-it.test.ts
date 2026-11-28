import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { ActEnded, ActingChannel, CalledOver, Relayed, StepAt } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { treeKeptInMemory } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { NO_OWN_CHAIN_READS } from './step-views.test-support.js';
import type { ReadHere } from '../../../../packages/web-shared/src/records-as-anchored.js';
import { runAction } from './run.js';
import { StepRefused, type ActionDefinition, type ActionStep, type Held, type StepContext } from './definition.js';
import { adopted } from './holders-moved-here.js';
import { adoptionSends } from './vault-doors-here.js';

vi.mock('midnight-identity/profile/act-intents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity/profile/act-intents')>();
  return {
    ...actual,
    ACT_INTENTS: Object.freeze({
      'put-in': {
        fields: { company: 'record' },
        relays: ['deposit'],
        calls: [
          { method: 'GET', path: '/api/accounts/:company' },
          { method: 'GET', path: '/api/accounts/:company/directory' },
          { method: 'POST', path: '/api/accounts/:company/manifest/newest', reads: true },
          { method: 'POST', path: '/api/accounts/:company/vaults/:vault/deposit', sends: true },
          { method: 'POST', path: '/api/accounts/:company/vaults/:vault/public-deposit', sends: true },
          { method: 'POST', path: '/api/proposals/:proposal/carry', sends: true },
          { method: 'POST', path: '/api/accounts/:company/vaults/:vault/start/account', sends: true },
          { method: 'POST', path: '/api/accounts/:company/creation/pay-key', sends: true }
        ]
      }
    })
  };
});

/*
 * **A STEP SENDS ONLY WHILE THE COMPANY IS AS ITS VIEW READ IT.** The runner gives each step one view of its company and
 * passes every send of the step through one gate: before a relay, a call that carries a transaction, or a send the
 * wallet makes itself, the step's view reads the company again, and a change by another signer sends nothing and stops
 * the action, saying so, even when the step caught the refusal and carried on. A send into a vault is refused when the
 * company's account no longer adopts it, which a deposit's own contract does not check. A second send in the step is
 * checked against what the step read before its first, the step's own sends moving nothing the check compares.
 */

const START = 1_755_000_000_000;
const VAULT = 'ab'.repeat(32);
const held = { identity: {}, secret: new Uint8Array(32) } as unknown as Held;
const request: ActRequest = {
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'act',
  requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'A test.',
  nonce: 'n1',
  expiresAt: START + 20 * 60_000,
  hearsProgress: true,
  intent: { name: 'put-in' as never, fields: { company: 'acc_1' } }
} as ActRequest;

/** The company on the chain, as this test moves it, and every call and relay the page was handed. */
const aCompany = () => {
  const chain = {
    seats: ['aa'],
    approvals: 1,
    adoptedVaults: [VAULT],
    threshold: 1,
    committee: [{ tag: 'schnorr', value: '11' }],
    vaultThresholds: [],
    policyBar: null
  };
  const posted: string[] = [];
  const ended: ActEnded[] = [];
  const feeNotPaid = { on: false };
  const startTaken = { on: false };
  /* The indexer showing the chain only after `waits` more waits of the check: then the seats become `to`. */
  const lag: { waits: number; to: string[] | null } = { waits: 0, to: null };
  const pause = async (): Promise<void> => {
    lag.waits -= 1;
    if (lag.waits === 0 && lag.to !== null) chain.seats = lag.to;
  };
  const answer = (path: string, body?: string): CalledOver => {
    if (path.endsWith('/directory')) return { of: 'answered', status: 200, body: { filings: [] } };
    if (path.endsWith('/manifest/newest'))
      return {
        of: 'answered',
        status: 200,
        body: { versions: (JSON.parse(body!) as { records: unknown[] }).records.map(() => 0) }
      };
    if (path.endsWith('/start/account') && !startTaken.on)
      return { of: 'answered', status: 502, body: { nothingWasSent: true, error: 'the service is not available' } };
    if ((path.endsWith('/deposit') || path.endsWith('/creation/pay-key')) && feeNotPaid.on)
      return {
        of: 'answered',
        status: 422,
        body: { nothingWasSent: true, code: 'fee-not-paid', error: 'the fee payer could not pay' }
      };
    return { of: 'answered', status: 200, body: {} };
  };
  const channel = {
    step: () => true,
    relay: async (_at: StepAt, tx: string): Promise<Relayed> => {
      posted.push(`relay ${tx}`);
      return 'relayed';
    },
    call: async (_at: StepAt, method: string, path: string, body?: string) => {
      posted.push(`${method} ${path}`);
      return answer(path, body);
    },
    answer: (a: unknown) => {
      ended.push(a as ActEnded);
      return true;
    }
  } as unknown as ActingChannel;
  const viewOf = (ctx: StepContext) =>
    ctx.viewFor(
      'acc_1',
      {
        holders: async () =>
          ({
            ...chain,
            seats: [...chain.seats],
            adoptedVaults: [...chain.adoptedVaults]
          }) as unknown as AccountHoldersRead,
        onChain: async () => ({}) as never,
        builder: { anchorHeads: async () => ({}) as never },
        pause,
        kept: () => treeKeptInMemory(),
        directory: async () => {
          throw new Error('no directory is read here');
        },
        chain: NO_OWN_CHAIN_READS
      },
      async () => ({}) as ReadHere
    );
  return { chain, posted, ended, channel, viewOf, feeNotPaid, startTaken, lag };
};

const go = (channel: ActingChannel, steps: readonly ActionStep[]) =>
  runAction({
    definition: {
      headline: 'ask.act.headline',
      shown: async () => [],
      checks: [],
      check: async () => null,
      steps: () => steps
    } as ActionDefinition,
    request,
    channel,
    held,
    stop: new AbortController().signal,
    now: () => Date.now()
  });
const stepThat = (run: (c: StepContext) => Promise<void>): ActionStep => ({ title: { key: 'ask.act.headline' }, run });
const DEPOSIT = `POST /api/accounts/acc_1/vaults/${VAULT}/deposit`;
/** A deposit into the vault, as a step writes it through its view. */
const DEPOSITED = { to: 'vault-send' as const, tx: 'AA', calls: [{ act: 'deposit' as const, vault: VAULT }] };
/* A send the step asks by name and not through a view, which the runner checks at its gate: the company's pay key filed. */
const PAY_KEY_PATH = '/api/accounts/acc_1/creation/pay-key';
const PAY_KEY = `POST ${PAY_KEY_PATH}`;
const payKeySent = (ctx: StepContext) => ctx.creation.payKey('acc_1', {});

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a send into a vault goes only while the company's account adopts it", () => {
  it('hands over no transaction one of whose calls deposits into a vault another of its calls retires', async () => {
    const c = aCompany();
    const sent: string[] = [];
    await go(c.channel, [
      stepThat(async (ctx) => {
        await c.viewOf(ctx).current().holders();
        ctx.movesWhoHolds([{ circuit: 'retireVault', contract: 'cd0' }], (h) => ({
          ...h,
          adoptedVaults: h.adoptedVaults.filter((v) => v !== VAULT)
        }));
        await ctx.sendStraight(
          async (door) => {
            door.handedOver();
            sent.push('sent by the wallet');
          },
          [{ vault: VAULT }],
          [{ circuit: 'retireVault', contract: 'Cd0' }]
        );
      })
    ]);
    /* RED WHEN: a deposit is checked only against the account as read, so public money goes into a vault the same transaction retires. */
    expect(sent).toEqual([]);
    expect(c.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.reach.why.vault-not-adopted' });
  });

  it('checks every vault a transaction deposits into, not its first alone', async () => {
    const c = aCompany();
    const sent: string[] = [];
    await go(c.channel, [
      stepThat(async (ctx) => {
        await c.viewOf(ctx).current().holders();
        await ctx.sendStraight(
          async (door) => {
            door.handedOver();
            sent.push('sent by the wallet');
          },
          [{ vault: VAULT }, { vault: 'cd'.repeat(32) }]
        );
      })
    ]);
    /* RED WHEN: the gate checks one deposit of a transaction of several. */
    expect(sent).toEqual([]);
    expect(c.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.reach.why.vault-not-adopted' });
  });

  it('hands the deposit over after reading the company again in its turn, when nothing moved', async () => {
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        const view = c.viewOf(ctx).current();
        await view.holders();
        await view.write([DEPOSITED]);
      })
    ]);
    /* RED WHEN: the deposit leaves without the company read again just before it, or is checked twice for one send. */
    expect(c.posted.filter((p) => p.endsWith('/directory'))).toHaveLength(2);
    expect(c.posted.at(-2)).toBe('POST /api/accounts/acc_1/manifest/newest');
    expect(c.posted.at(-1)).toBe(DEPOSIT);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });

  it('sends nothing into a vault the company let go of since the step read it, and says so', async () => {
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        const view = c.viewOf(ctx).current();
        await view.holders();
        c.chain.adoptedVaults = [];
        await view.write([DEPOSITED]).catch(() => undefined);
      })
    ]);
    /* RED WHEN: money goes into a vault the company's account no longer adopts, since the deposit's contract does not check it. */
    expect(c.posted).not.toContain(DEPOSIT);
    expect(c.ended[0]).toMatchObject({
      ended: 'stopped',
      why: 'check-failed',
      refused: 'act.reach.why.company-changed'
    });
  });

  it('sends nothing into a vault the company never adopted, though nothing moved since the step read it', async () => {
    const c = aCompany();
    c.chain.adoptedVaults = ['cd'.repeat(32)];
    await go(c.channel, [
      stepThat(async (ctx) => {
        const view = c.viewOf(ctx).current();
        await view.holders();
        await view.write([DEPOSITED]).catch(() => undefined);
      })
    ]);
    /* RED WHEN: the vault a deposit goes into is not checked against the vaults the account adopts now. */
    expect(c.posted).not.toContain(DEPOSIT);
    expect(c.ended[0]).toMatchObject({
      ended: 'stopped',
      why: 'check-failed',
      refused: 'act.reach.why.vault-not-adopted'
    });
  });

  it('checks a deposit into a vault written through a view the step had not read yet, as that view first reads the company', async () => {
    const c = aCompany();
    c.chain.adoptedVaults = ['cd'.repeat(32)];
    await go(c.channel, [
      stepThat(async (ctx) => {
        await c
          .viewOf(ctx)
          .current()
          .write([DEPOSITED])
          .catch(() => undefined);
      })
    ]);
    /* RED WHEN: a step that read nothing of the company before sends money into a vault unchecked. */
    expect(c.posted).not.toContain(DEPOSIT);
    expect(c.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.reach.why.vault-not-adopted' });
  });
});

describe('a change by another signer stops the step before anything is sent', () => {
  it('relays nothing once a seat moved, and stops even when the step caught the refusal and carried on', async () => {
    const c = aCompany();
    let caught: unknown = null;
    await go(c.channel, [
      stepThat(async (ctx) => {
        await c.viewOf(ctx).current().holders();
        c.chain.seats = ['aa', 'bb'];
        await ctx.relay('AAAA').catch((e: unknown) => {
          caught = e;
        });
        await payKeySent(ctx).catch(() => undefined);
      })
    ]);
    /* RED WHEN: a transaction is handed over after another signer changed who holds the company. */
    expect(c.posted).not.toContain('relay AAAA');
    expect((caught as { nothingWasSent?: unknown } | null)?.nothingWasSent).toBe(true);
    /* RED WHEN: a step that swallows the refusal carries on, or the action ends saying anything but the change. */
    expect(c.posted.filter((p) => p === PAY_KEY)).toEqual([]);
    expect(c.ended[0]).toMatchObject({
      ended: 'stopped',
      why: 'check-failed',
      refused: 'act.reach.why.company-changed'
    });
  });

  it('stops the action when a write through the view found the change, whatever the step did with it', async () => {
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        const view = c.viewOf(ctx).current();
        await view.holders();
        c.chain.approvals = 2;
        await view.stillAsRead().catch(() => undefined);
      })
    ]);
    /* RED WHEN: a step that caught the change its view found ends as done. */
    expect(c.ended[0]).toMatchObject({
      ended: 'stopped',
      why: 'check-failed',
      refused: 'act.reach.why.company-changed'
    });
  });
});

describe('a send the step says moves who holds the company moves what the step read by exactly that', () => {
  const twoDeposits = (c: ReturnType<typeof aCompany>, sentTo: string, after: readonly string[]) =>
    stepThat(async (ctx) => {
      await c.viewOf(ctx).current().holders();
      ctx.movesWhoHolds([{ path: sentTo }], (h) => ({ ...h, seats: [...h.seats, 'bb'] }));
      await payKeySent(ctx);
      c.chain.seats = [...after];
      await payKeySent(ctx);
    });

  it('sends the next call once the chain moved as declared, and stops it when it moved by anything more', async () => {
    for (const after of [['aa', 'bb'], ['aa', 'bb', 'cc'], ['aa']]) {
      const c = aCompany();
      await go(c.channel, [twoDeposits(c, PAY_KEY_PATH, after)]);
      const asDeclared = after.length === 2;
      /* RED WHEN: the step's own declared move is taken for another signer's change, or a change beyond it, or none, goes unchecked. */
      expect(
        c.posted.filter((p) => p === PAY_KEY),
        after.join()
      ).toHaveLength(asDeclared ? 2 : 1);
      expect(c.ended[0], after.join()).toMatchObject(
        asDeclared ? { ended: 'done' } : { ended: 'stopped', refused: 'act.reach.why.company-changed-after-sending' }
      );
    }
  });

  it('waits for an indexer that shows its own declared move late, and sends the next call once it shows it', async () => {
    const c = aCompany();
    c.lag.waits = 3;
    c.lag.to = ['aa', 'bb'];
    await go(c.channel, [twoDeposits(c, PAY_KEY_PATH, ['aa'])]);
    /* RED WHEN: an indexer behind the step's own confirmed send stops the step as if another signer changed the company. */
    expect(c.posted.filter((p) => p === PAY_KEY)).toHaveLength(2);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });

  it('moves nothing for a send to another path than the one the step declared', async () => {
    const c = aCompany();
    await go(c.channel, [twoDeposits(c, '/api/proposals/prp_1/carry', ['aa', 'bb'])]);
    /* RED WHEN: a move declared for one send is applied to another, so a seat another signer added passes the check. */
    expect(c.posted.filter((p) => p === PAY_KEY)).toHaveLength(1);
    expect(c.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.reach.why.company-changed-after-sending' });
  });
});

describe("a send the step's view writes itself is checked once, by the view, and held to the same rules", () => {
  const deposit = { to: 'vault-send' as const, tx: 'AA', calls: [{ act: 'deposit' as const, vault: VAULT }] };
  it('hands a deposit written through the view over after one read of the company, not two', async () => {
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        const held = c.viewOf(ctx);
        const view = held.current();
        await view.holders();
        await view.write([deposit]);
        /* RED WHEN: a send into a vault through the view leaves the view as it was, where the same send through the runner ends it. */
        expect(held.current()).not.toBe(view);
      })
    ]);
    /* RED WHEN: a deposit written through the view is checked by the runner's gate as well as by the view, or by neither. */
    expect(c.posted.filter((p) => p.endsWith('/directory'))).toHaveLength(2);
    expect(c.posted.at(-1)).toBe(DEPOSIT);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });
  it('ends only the view a deposit was written through, and leaves another view of the step as it was', async () => {
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        const one = c.viewOf(ctx);
        const other = c.viewOf(ctx);
        const before = other.current();
        await one.current().holders();
        await before.holders();
        const wrote = one.current();
        await wrote.write([deposit]);
        /* RED WHEN: a send into a vault through one view leaves that view open, or ends another view the step holds. */
        expect(wrote.endedAs).toBe('sent');
        expect(other.current()).toBe(before);
        expect(before.ended).toBeNull();
      })
    ]);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });
  it('writes no deposit into a vault the account does not adopt, and stops the action though the step caught it', async () => {
    const c = aCompany();
    c.chain.adoptedVaults = ['cd'.repeat(32)];
    let caught: unknown = null;
    await go(c.channel, [
      stepThat(async (ctx) => {
        const view = c.viewOf(ctx).current();
        await view.holders();
        await view.write([deposit]).catch((e: unknown) => {
          caught = e;
        });
      })
    ]);
    /* RED WHEN: a deposit written through the view goes into a vault the company's account does not adopt. */
    expect(c.posted).not.toContain(DEPOSIT);
    expect((caught as { nothingWasSent?: unknown } | null)?.nothingWasSent).toBe(true);
    /* RED WHEN: a step that swallowed the refusal ends as done, or says anything but the vault let go. */
    expect(c.ended[0]).toMatchObject({
      ended: 'stopped',
      why: 'check-failed',
      refused: 'act.reach.why.vault-not-adopted'
    });
  });
  it("sends the deposit from the person's own DUST after the service refused the view's write, checked against the reading before it", async () => {
    const c = aCompany();
    c.feeNotPaid.on = true;
    const sent: string[] = [];
    await go(c.channel, [
      stepThat(async (ctx) => {
        const held = c.viewOf(ctx);
        await held.current().holders();
        await held
          .current()
          .write([deposit])
          .catch(() => undefined);
        await ctx.sendStraight(
          async (door) => {
            await door.ready();
            door.handedOver();
            sent.push('sent by the wallet');
          },
          [{ vault: VAULT }]
        );
      })
    ]);
    /* RED WHEN: the own-DUST send after a refused write finds no view to check the vault against and is refused. */
    expect(sent).toEqual(['sent by the wallet']);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });
  it('checks a send around a refused write against the reading taken before it, and stops it when a seat moved', async () => {
    const c = aCompany();
    c.feeNotPaid.on = true;
    const sent: string[] = [];
    await go(c.channel, [
      stepThat(async (ctx) => {
        const held = c.viewOf(ctx);
        await held.current().holders();
        await held
          .current()
          .write([deposit])
          .catch(() => undefined);
        c.chain.seats = ['aa', 'bb'];
        await ctx
          .sendStraight(async (door) => {
            door.handedOver();
            sent.push('sent by the wallet');
          })
          .catch(() => undefined);
      })
    ]);
    /* RED WHEN: a send that goes around a failed write leaves on no check, so another signer's change since the step read the company is missed. */
    expect(sent).toEqual([]);
    expect(c.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.reach.why.company-changed-after-sending' });
  });
  it('holds a public deposit to the vaults the account adopts', async () => {
    const c = aCompany();
    c.chain.adoptedVaults = ['cd'.repeat(32)];
    await go(c.channel, [
      stepThat(async (ctx) => {
        const view = c.viewOf(ctx).current();
        await view.holders();
        await view.write([{ ...deposit, calls: [{ act: 'public-deposit', vault: VAULT }] }]).catch(() => undefined);
      })
    ]);
    /* RED WHEN: public money goes into a vault the company's account does not adopt, which the vault's own contract does not check. */
    expect(c.posted.filter((p) => p.endsWith('/public-deposit'))).toEqual([]);
    expect(c.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.reach.why.vault-not-adopted' });
  });
  it('moves what the step read by a declared move written through the view, and by nothing more', async () => {
    for (const after of [
      ['aa', 'bb'],
      ['aa', 'bb', 'cc']
    ]) {
      const c = aCompany();
      await go(c.channel, [
        stepThat(async (ctx) => {
          const held = c.viewOf(ctx);
          await held.current().holders();
          ctx.movesWhoHolds([{ proposal: 'prp_1' }], (h) => ({ ...h, seats: [...h.seats, 'bb'] }));
          await held.current().write([{ to: 'proposal', id: 'prp_1', act: 'carry', body: {} }]);
          c.chain.seats = [...after];
          await held.current().write([deposit]);
        })
      ]);
      const asDeclared = after.length === 2;
      /* RED WHEN: a declared move written through the view is taken for another signer's change, or a change beyond it passes. */
      expect(
        c.posted.filter((p) => p === DEPOSIT),
        after.join()
      ).toHaveLength(asDeclared ? 1 : 0);
      expect(c.ended[0], after.join()).toMatchObject(
        asDeclared ? { ended: 'done' } : { ended: 'stopped', refused: 'act.reach.why.company-changed-after-sending' }
      );
    }
  });
  it('gives a declared move only to its own send: not to another send first, nor after its own went nowhere', async () => {
    for (const first of ['straight', 'refused'] as const) {
      const c = aCompany();
      await go(c.channel, [
        stepThat(async (ctx) => {
          await c.viewOf(ctx).current().holders();
          ctx.movesWhoHolds([{ path: PAY_KEY_PATH }], (h) => ({ ...h, seats: [...h.seats, 'bb'] }));
          if (first === 'straight')
            await ctx.sendStraight(async (door) => {
              door.handedOver();
            });
          else {
            c.feeNotPaid.on = true;
            await payKeySent(ctx);
            c.feeNotPaid.on = false;
            await payKeySent(ctx);
          }
          c.chain.seats = ['aa', 'bb'];
          await ctx.relay('AAAA').catch(() => undefined);
        })
      ]);
      /* RED WHEN: a move declared for one send is taken by another send, or outlives its own send that went nowhere, so another signer's seat passes. */
      expect(c.posted, first).not.toContain('relay AAAA');
      expect(c.ended[0], first).toMatchObject({
        ended: 'stopped',
        refused: 'act.reach.why.company-changed-after-sending'
      });
    }
  });
  it('adopts a new vault straight on the chain after the service took nothing of it, and goes on without blaming another signer', async () => {
    const NEW = 'ef'.repeat(32);
    const ACCOUNT = 'c0'.repeat(32);
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        const held = c.viewOf(ctx);
        await held.current().holders();
        ctx.movesWhoHolds(adoptionSends(ACCOUNT, NEW), adopted(NEW));
        await expect(
          held.current().write([{ to: 'vault-start', vault: NEW, step: 'account', body: {} }])
        ).rejects.toMatchObject({ status: 502, nothingWasSent: true });
        await ctx.sendStraight(
          async (door) => {
            door.handedOver();
          },
          [],
          [{ circuit: 'adopt', contract: ACCOUNT.toUpperCase() }]
        );
        c.chain.adoptedVaults = [...c.chain.adoptedVaults, NEW];
        await payKeySent(ctx);
      })
    ]);
    /* RED WHEN: the service's refusal drops the adoption's move from the chain's own adopt too, so the adoption is read as another signer's change. */
    expect(c.posted.filter((p) => p === PAY_KEY)).toHaveLength(1);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });
  it("adopts a new vault through the service's start written through the view, and goes on without blaming another signer", async () => {
    const NEW = 'ef'.repeat(32);
    const ACCOUNT = 'c0'.repeat(32);
    const c = aCompany();
    c.startTaken.on = true;
    await go(c.channel, [
      stepThat(async (ctx) => {
        const held = c.viewOf(ctx);
        await held.current().holders();
        ctx.movesWhoHolds(adoptionSends(ACCOUNT, NEW), adopted(NEW));
        await held.current().write([{ to: 'vault-start', vault: NEW, step: 'account', body: {} }]);
        c.chain.adoptedVaults = [...c.chain.adoptedVaults, NEW];
        await payKeySent(ctx);
      })
    ]);
    /* RED WHEN: the adoption the view wrote through the service is not taken as the step's own move, so it is read as another signer's change. */
    expect(c.posted).toContain(`POST /api/accounts/acc_1/vaults/${NEW}/start/account`);
    expect(c.posted.filter((p) => p === PAY_KEY)).toHaveLength(1);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });
  it('moves what the step read by a declared move the wallet sent straight to the chain', async () => {
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        await c.viewOf(ctx).current().holders();
        ctx.movesWhoHolds([{ proposal: 'prp_1' }, { circuit: 'seatInvited', contract: 'cd0' }], (h) => ({
          ...h,
          seats: [...h.seats, 'bb']
        }));
        await ctx.sendStraight(
          async (door) => {
            door.handedOver();
          },
          [],
          [{ circuit: 'seatInvited', contract: 'Cd0' }]
        );
        c.chain.seats = ['aa', 'bb'];
        await payKeySent(ctx);
      })
    ]);
    /* RED WHEN: a declared move handed straight to the chain is taken for another signer's change. */
    expect(c.posted.filter((p) => p === PAY_KEY)).toHaveLength(1);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });
  it('moves what the step read by every move declared for the calls of one transaction, in order', async () => {
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        await c.viewOf(ctx).current().holders();
        ctx.movesWhoHolds([{ circuit: 'seatInvited', contract: 'cd0' }], (h) => ({ ...h, seats: [...h.seats, 'bb'] }));
        ctx.movesWhoHolds([{ circuit: 'setThreshold', contract: 'cd0' }], (h) => ({
          ...h,
          threshold: h.threshold + 1
        }));
        await ctx.sendStraight(
          async (door) => {
            door.handedOver();
          },
          [],
          [
            { circuit: 'seatInvited', contract: 'Cd0' },
            { circuit: 'setThreshold', contract: 'Cd0' }
          ]
        );
        Object.assign(c.chain, { seats: ['aa', 'bb'], threshold: 2 });
        await payKeySent(ctx);
      })
    ]);
    /* RED WHEN: one transaction of two calls moves the reading by one of them, and the next send is stopped as another signer's change. */
    expect(c.posted.filter((p) => p === PAY_KEY)).toHaveLength(1);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });
});
describe('every send of a step is checked against what the step read, its own sends moving nothing', () => {
  it('stops a second relay when a seat moved after the first, and says what was sent stands', async () => {
    for (const between of [false, true]) {
      const c = aCompany();
      await go(c.channel, [
        stepThat(async (ctx) => {
          const held = c.viewOf(ctx);
          await held.current().holders();
          await ctx.relay('AAAA');
          c.chain.seats = ['aa', 'bb'];
          if (between) await held.current().holders();
          await ctx.relay('BBBB');
        })
      ]);
      /* RED WHEN: a second send in one step goes unchecked, or is checked against a reading taken after the first send. */
      expect(
        c.posted.filter((p) => p.startsWith('relay')),
        String(between)
      ).toEqual(['relay AAAA']);
      /* RED WHEN: a step that already handed a payment over ends saying nothing was sent, so a partly paid run reads as unpaid. */
      expect(c.ended[0], String(between)).toMatchObject({
        ended: 'stopped',
        why: 'check-failed',
        relayed: 1,
        refused: 'act.reach.why.company-changed-after-sending'
      });
    }
  });

  it("keeps the step's own words for what it sent when the gate stops it after a send, and the gate's before any", async () => {
    for (const first of [true, false]) {
      const c = aCompany();
      await go(c.channel, [
        stepThat(async (ctx) => {
          await c.viewOf(ctx).current().holders();
          if (first) await ctx.relay('AAAA');
          c.chain.seats = ['aa', 'bb'];
          await ctx.relay('BBBB').catch(() => {
            throw new StepRefused({ key: 'act.pay-run.why.may-be-sent' });
          });
        })
      ]);
      /* RED WHEN: a run that paid a leg and was then stopped at the gate ends saying nothing was sent, so the page reads it as unpaid. */
      expect(c.ended[0], String(first)).toMatchObject({
        ended: 'stopped',
        refused: first ? 'act.pay-run.why.may-be-sent' : 'act.reach.why.company-changed'
      });
    }
  });

  it('sends a second relay when nothing moved since the step read the company', async () => {
    const c = aCompany();
    await go(c.channel, [
      stepThat(async (ctx) => {
        await c.viewOf(ctx).current().holders();
        await ctx.relay('AAAA');
        await ctx.relay('BBBB');
      })
    ]);
    /* RED WHEN: the step's own send is taken for another signer's change, and its next send refused. */
    expect(c.posted.filter((p) => p.startsWith('relay'))).toEqual(['relay AAAA', 'relay BBBB']);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });

  it("pays the deposit from the person's own DUST after the service took nothing, through the runner's door", async () => {
    const c = aCompany();
    c.feeNotPaid.on = true;
    const sent: string[] = [];
    await go(c.channel, [
      stepThat(async (ctx) => {
        const held = c.viewOf(ctx);
        await held.current().holders();
        await held
          .current()
          .write([DEPOSITED])
          .catch(() => undefined);
        await ctx.sendStraight(
          async (door) => {
            await door.ready();
            door.handedOver();
            sent.push('sent by the wallet');
          },
          [{ vault: VAULT }]
        );
      })
    ]);
    /* RED WHEN: a deposit the service took nothing of ends the step's read, so its own-DUST send is refused as a vault let go. */
    expect(sent).toEqual(['sent by the wallet']);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });

  it('ends every view a step opened when the step ends, so the next step reads the company itself', async () => {
    const c = aCompany();
    let first: ReturnType<ReturnType<typeof c.viewOf>['current']> | null = null;
    await go(c.channel, [
      stepThat(async (ctx) => {
        first = c.viewOf(ctx).current();
        await first.holders();
      }),
      stepThat(async () => {
        /* RED WHEN: a view read in one step still answers in the next. */
        expect(first!.ended).not.toBeNull();
      })
    ]);
    expect(c.ended[0]).toMatchObject({ ended: 'done' });
  });
});
