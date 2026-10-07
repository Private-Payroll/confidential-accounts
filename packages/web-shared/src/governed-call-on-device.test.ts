import { describe, it, expect } from 'vitest';
import {
  approveOnDevice, governedCallServiceFor, nothingWasSentBy, SentAndNotYetSeen,
  sendRaiseFromDevice, sendRetryFromDevice, withdrawOnDevice,
  type GovernedCallService, type LegPaymentsOnTheWire, type MadeHereDoors, type RaiseDoors, type RaiseOrderOnTheWire,
  type RetryOrderOnTheWire, type RoundOnThePage,
} from './governed-call-on-device.js';
import type { LedgerForm } from '../../../src/core/assets.js';
import { deviceVaultHoldings, type PoolNote } from './device-vault-holdings.js';
import { paymentsFitNotes } from './vault-builder.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../src/testing/assets.js';
import type { Hex } from '../../../src/core/crypto.js';
import { DEVICE_RAISE_VERSION, WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED, paymentsCheckedDigest } from '../../../src/core/device-raise.js';
import { opensAs } from '../../../src/testing/sealed-records.js';

/* The page's side, over a service and a worker that write down what they were asked, in order. */
const material = { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) };
/* The vault's private money, as this device's pool records it and the chain holds it. */
/* A token with both forms, which the fixture registry holds beside the product's own: what each leg here pays. */
const TOKEN = TEST_TOKEN as Hex;
const note = (n: number, value: bigint): PoolNote => ({
  nonce: n.toString(16).padStart(64, '0') as Hex, token: TOKEN, value, createdIn: 'ee'.repeat(32) as Hex,
});
const committed = (n: PoolNote) => `c${n.nonce.slice(1)}`;
const LEG: LegPaymentsOnTheWire = {
  asset: TOKEN, payments: [0, 1, 2].map(() => ({ kind: 'shielded', token: TOKEN, amount: '10000' })),
};
const PLENTY = [note(1, 1_000_000n)];
/* The digest of LEG's payments, as the service computes it over what it raises or sends. */
const CHECKED = paymentsCheckedDigest(LEG.payments);

const ORDER: RaiseOrderOnTheWire = {
  proposalId: 'prp_1', chainId: 'cc'.repeat(32),
  order: {
    circuit: 'propose',
    run: { root: '88'.repeat(32), payees: '3', opensAt: '1', closesAt: '2', vault: '99'.repeat(32) },
    half: { assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: '66'.repeat(32), changeAmount: '1', changeBatchDigest: '77'.repeat(32) },
    proposal: 'cc'.repeat(32),
  },
  paymentsChecked: CHECKED,
};
/* The proposal written down for another set of payments than LEG's: its count of payees and its digest follow them. */
const orderPaying = (payments: LegPaymentsOnTheWire['payments']): RaiseOrderOnTheWire => ({
  ...ORDER, order: { ...ORDER.order, run: { ...ORDER.order.run, payees: String(payments.length) } },
  paymentsChecked: paymentsCheckedDigest(payments),
});
/* A retry of the leg's second and third people, written down and not yet sent. */
const RETRY_ORDER: RetryOrderOnTheWire = {
  ...ORDER, proposalId: 'prp_r', chainId: 'cd'.repeat(32),
  order: { ...ORDER.order, run: { ...ORDER.order.run, payees: '2' }, proposal: 'cd'.repeat(32) },
  indices: [1, 2],
  paymentsChecked: paymentsCheckedDigest(LEG.payments.slice(1)),
};
const round = (over: Partial<RoundOnThePage> = {}): RoundOnThePage => ({ id: 'prp_1', chainId: 'cc'.repeat(32), status: 'open', ...over });

/**
 * What this device makes a raise or a retry from, as fakes that log what they were asked in the shape the service's
 * routes once were. What is made from real records is the subject of `a-raise-is-made-from-the-companys-records.test.ts`.
 */
interface Leg { viewingKey: string; asset?: string; form?: LedgerForm }
interface MadeOver {
  legPayments?: (runId: string, body: Leg) => Promise<LegPaymentsOnTheWire>;
  raiseOrder?: (runId: string, body: Leg) => Promise<RaiseOrderOnTheWire>;
  retryPayments?: (runId: string, body: Leg & { indices: number[] }) => Promise<LegPaymentsOnTheWire>;
  retryOrder?: (runId: string, body: Leg & { proposalId: string }) => Promise<RetryOrderOnTheWire>;
}

const aDevice = (over: Partial<GovernedCallService> & MadeOver & {
  standings?: RoundOnThePage[]; buildFails?: Error;
  pool?: PoolNote[]; chainNotes?: string[]; fitFails?: Error;
  /** The pool as each check finds it, first check first; the last one stands for every later check. */
  poolAtCheck?: PoolNote[][];
} = {}) => {
  const log: string[] = [];
  const standings = [...(over.standings ?? [])];
  let checks = 0;
  const poolNow = (): PoolNote[] => (over.poolAtCheck
    ? over.poolAtCheck[Math.min(checks, over.poolAtCheck.length) - 1] ?? over.poolAtCheck[0]!
    : over.pool ?? PLENTY);
  const asked: Required<MadeOver> = {
    legPayments: async (runId, body) => { checks += 1; log.push(`made leg-payments ${runId} ${JSON.stringify(body)}`); return LEG; },
    raiseOrder: async (runId) => { log.push(`made order ${runId}`); return ORDER; },
    retryPayments: async (runId, body) => {
      checks += 1; log.push(`made retry-payments ${runId} ${JSON.stringify(body)}`);
      return { asset: LEG.asset, payments: body.indices.map((i) => LEG.payments[i]!) };
    },
    retryOrder: async (runId, body) => { log.push(`made retry-order ${runId} ${body.proposalId}`); return RETRY_ORDER; },
    ...Object.fromEntries((['legPayments', 'raiseOrder', 'retryPayments', 'retryOrder'] as const)
      .filter((k) => over[k] !== undefined).map((k) => [k, over[k]])),
  };
  const made: MadeHereDoors = {
    legPayments: (runId, viewingKey, which) => asked.legPayments(runId, { viewingKey, ...which }),
    raiseOrder: (runId, viewingKey, which) => asked.raiseOrder(runId, { viewingKey, ...which }),
    retryPayments: (runId, viewingKey, indices, which) => asked.retryPayments(runId, { viewingKey, ...which, indices: [...indices] }),
    retryOrder: (runId, viewingKey, proposalId, which) => asked.retryOrder(runId, { viewingKey, ...which, proposalId }),
  };
  const service: GovernedCallService = {
    send: async (id, body) => { log.push(`send ${id} ${body.tx} ${body.version}`); return round({ id, txRef: 't1' }); },
    callState: async (id) => { log.push(`state ${id}`); return { account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }; },
    approve: async (id, body) => { log.push(`approve ${id} ${body.tx}`); return round(); },
    cancel: async (id, body) => { log.push(`cancel ${id} ${JSON.stringify(body)}`); return round({ status: 'cancelled' }); },
    standing: async (id) => { log.push(`standing ${id}`); return standings.shift() ?? round(); },
    ...over,
  };
  const holdings = deviceVaultHoldings({
    chain: async (vault) => { log.push(`vault read ${vault}`); return { onChain: true, notesFromThisBuild: true, notes: over.chainNotes ?? poolNow().map(committed) }; },
    pool: async () => poolNow(),
    heldCommitmentOf: async (_vault, n) => committed(n),
    paymentsFit: async (notes, payments) => {
      if (over.fitFails) throw over.fitFails;
      return paymentsFitNotes({
        notes: notes.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value.toString(), createdIn: n.createdIn! })),
        payments: payments.map((p) => ({ token: p.token, amount: p.amount.toString() })),
      });
    },
  });
  const doors: RaiseDoors = {
    service, holdings, made, assets: registryWithTestPrivateForms(),
    builder: {
      governedCall: async (input) => {
        log.push(`build ${input.order.circuit} for ${input.account} on ${input.chain.accountState}`);
        if (JSON.stringify(input.material) !== JSON.stringify(material)) throw new Error('not this signer\'s material');
        if (over.buildFails) throw over.buildFails;
        return { tx: `TX-${input.order.circuit}` };
      },
    },
    material, accountId: 'acc_1',
    /* What the device opens is the subject of `the-device-proves-what-it-opened.test.ts`; here each proposal opens as itself. */
    opens: opensAs({ prp_1: 'cc'.repeat(32), prp_r: 'cd'.repeat(32) }),
    progress: (s) => log.push(`stage ${s}`),
    sleep: async () => {}, waitMs: 3, everyMs: 1,
  };
  return { log, doors };
};

describe('RAISING A LEG FROM THIS DEVICE', () => {
  it('A PROPOSAL WRITTEN DOWN AND NOT YET SENT IS SENT AGAIN AS ITSELF', async () => {
    const again = aDevice({ standings: [round({ raisedAt: 'now' })] });
    await sendRaiseFromDevice(again.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN });
    /* RED WHEN: sending again asks for anything but the proposal already written down and what its vault can pay. */
    expect(again.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'made order run_1', `made leg-payments run_1 {"viewingKey":"vk","asset":"${TOKEN}"}`,
      `vault read ${'99'.repeat(32)}`, `vault read ${'99'.repeat(32)}`,
      'state acc_1', `build propose for ${'ac'.repeat(32)} on AS`,
      `send prp_1 TX-propose ${DEVICE_RAISE_VERSION}`, 'standing prp_1',
    ]);
  });

  it('WHAT IS MADE HERE IS SENT AGAIN ONLY IF IT IS A RAISE OF THE PROPOSAL IT NAMES', async () => {
    /* RED WHEN: sending a written-down proposal again builds an approval of it, named exactly as the proposal. */
    const resend = aDevice({ raiseOrder: async () => ({ ...ORDER, order: { circuit: 'approve', proposal: ORDER.chainId } as never }) });
    await expect(sendRaiseFromDevice(resend.doors, { runId: 'run_1', viewingKey: 'vk' })).rejects.toThrow(/not the proposal it wrote down/u);
    expect(resend.log.filter((l) => l.startsWith('build') || l.startsWith('send'))).toEqual([]);
  });

  it('A SEND THE CHAIN DOES NOT SHOW IN TIME IS SAID AS SENT AND NOT SEEN, NOT AS A FAILURE TO SEND', async () => {
    const d = aDevice();
    const late = await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk' }).catch((e) => e);
    /* RED WHEN: a proposal that was sent is reported as not sent - a person then sends it again. */
    expect(late).toBeInstanceOf(SentAndNotYetSeen);
    expect(late.message).toMatch(/was sent and the chain has not shown it yet\. Do not send it again/u);
    expect(nothingWasSentBy(late)).toBe(false);
  });
});

describe('APPROVING FROM THIS DEVICE', () => {
  it('reads the standing first, builds the approval for the proposal\'s chain identity, sends only the proven call, and waits for the chain to count one more', async () => {
    const counted = (n: number) => round({ raisedAt: 'x', approvalCount: n });
    const d = aDevice({ standings: [counted(1), counted(1), counted(2)] });
    const done = await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    expect(done.approvalCount).toBe(2);
    /* RED WHEN: the approval carries anything beside the proven call - a signer id, a signature or a key. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'standing prp_1', 'state acc_1', `build approve for ${'ac'.repeat(32)} on AS`, 'approve prp_1 TX-approve',
      /* RED WHEN: the wait stops at a count the chain already had before this approval. */
      'standing prp_1', 'standing prp_1',
    ]);
  });

  it('AN APPROVAL IS BUILT ONLY FOR THE PROPOSAL THE PERSON WAS SHOWN', async () => {
    const d = aDevice({ standings: [round({ chainId: 'dd'.repeat(32) })] });
    /* RED WHEN: the device proves an approval of whatever id the service names now. */
    await expect(approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' }))
      .rejects.toThrow(/another proposal than the one shown here/u);
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('approve'))).toEqual([]);
  });

  it('a count past one more ends the wait, a status the service names does not, and one the chain never counts is sent and not seen', async () => {
    const d = aDevice({ standings: [round({ approvalCount: 1 }), round({ approvalCount: 3 })] });
    /* RED WHEN: another signer's approval landing in the same block keeps this device waiting for an exact count. */
    expect((await approveOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).approvalCount).toBe(3);
    /* RED WHEN: the wait ends on a status the service writes rather than on the chain's count. */
    const named = aDevice({ standings: [round({ approvalCount: 1 }), round({ approvalCount: 1, status: 'approved' })] });
    await expect(approveOnDevice(named.doors, { round: round(), viewingKey: 'vk' })).rejects.toBeInstanceOf(SentAndNotYetSeen);
    const never = aDevice({ standings: [round()] });
    await expect(approveOnDevice(never.doors, { round: round(), viewingKey: 'vk' }))
      .rejects.toBeInstanceOf(SentAndNotYetSeen);
  });

  it('A SERVICE REFUSAL KEEPS ITS OWN MARK OF WHETHER ANYTHING WAS SENT', async () => {
    const calls: string[] = [];
    const api = async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`);
      if (path.endsWith('/approve')) throw new Error('this seat may not approve. Nothing was sent.');
      if (path.endsWith('/send')) throw new Error('the node dropped the connection');
      return {};
    };
    const service = governedCallServiceFor(api);
    /* RED WHEN: the mark is dropped - a refusal then reads as maybe sent, and a failure at the send as nothing sent. */
    expect(nothingWasSentBy(await service.approve('p 1', { tx: 'T' }).catch((e) => e))).toBe(true);
    expect(nothingWasSentBy(await service.send('p 1', { tx: 'T', version: DEVICE_RAISE_VERSION }).catch((e) => e))).toBe(false);
    await service.callState('acc 1');
    await service.standing('p 1');
    await service.cancel!('p 1', {});
    await service.cancel!('p 1', { tx: 'T' });
    await service.carry!('p 1', { tx: 'T', circuit: 'setThreshold' });
    /* RED WHEN: a relay names a route the service no longer has, carries a key or a signature, or an id is not escaped. */
    expect(calls).toEqual([
      'POST /api/proposals/p%201/approve {"tx":"T"}',
      `POST /api/proposals/p%201/send {"tx":"T","version":${DEVICE_RAISE_VERSION}}`,
      'GET /api/accounts/acc%201/call-state ',
      'POST /api/proposals/p%201/standing {}',
      'POST /api/proposals/p%201/cancel {}',
      'POST /api/proposals/p%201/cancel {"tx":"T"}',
      'POST /api/proposals/p%201/carry {"tx":"T","circuit":"setThreshold"}',
    ]);
    expect(calls.join('\n')).not.toMatch(/viewingKey|signature|signerId/u);
  });
});

describe('THE VAULT\'S PRIVATE MONEY IS ASKED ON THIS DEVICE BEFORE A RAISE WRITTEN DOWN IS SENT', () => {
  /* A leg's raise written down and not yet sent; a first raise is checked the same way where it is made (`run-raised-here.ts`). */
  const RAISE = { runId: 'run_1', viewingKey: 'vk', asset: TOKEN };
  const serviceCalls = (log: string[]) => log.filter((l) => /^(raise|send|state|approve|standing) /u.test(l));

  it('1. A RUN THE POOL CANNOT PAY IS REFUSED HERE, AND NOTHING IS BUILT OR SENT', async () => {
    const short = aDevice({ pool: [note(1, 15_000n)] });
    const refused = await sendRaiseFromDevice(short.doors, RAISE).catch((e) => e);
    /* RED WHEN: the device check is gone, or runs after the raise - the company then writes down a run the vault cannot pay. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(refused?.held).toBe(15_000n);
    expect(refused?.asked).toBe(30_000n);
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(serviceCalls(short.log)).toEqual([]);

    /* Enough in total, and no single note can make the second payment: a question about notes, not a sum. */
    const split = aDevice({
      pool: [note(1, 20_000n), note(2, 10_000n)],
      legPayments: async () => ({ asset: TOKEN, payments: [0, 1].map(() => ({ kind: 'shielded', token: TOKEN, amount: '15000' })) }),
      raiseOrder: async () => orderPaying([0, 1].map(() => ({ kind: 'shielded', token: TOKEN, amount: '15000' }))),
    });
    const unfit = await sendRaiseFromDevice(split.doors, RAISE).catch((e) => e);
    /* RED WHEN: the notes are not walked payment by payment - the run is raised and stops halfway on payday. */
    expect(unfit?.why).toBe('does-not-fit');
    expect(String(unfit?.message)).toMatch(/payment 2 of 2 cannot be made out of this vault/u);
    expect(serviceCalls(split.log)).toEqual([]);
  });

  it('2. A POOL THAT DISAGREES WITH THE CHAIN IS NAMED AS A DISAGREEMENT, NEVER READ AS A BALANCE', async () => {
    for (const [why, chainNotes] of [
      ['a recorded note the chain does not hold', ['c' + 'f'.repeat(63)]],
      ['a note the chain holds that the pool does not record', [committed(PLENTY[0]!), 'c' + 'f'.repeat(63)]],
    ] as const) {
      const d = aDevice({ chainNotes: [...chainNotes] });
      const refused = await sendRaiseFromDevice(d.doors, RAISE).catch((e) => e);
      /* RED WHEN: the pool is summed without being compared with the chain, in either direction. */
      expect(refused?.why, why).toBe('contradicted');
      expect(String(refused?.message), why).toMatch(/disagrees with the chain/u);
      expect(serviceCalls(d.log), why).toEqual([]);
    }
  });

  it('A PUBLIC PAYMENT IS LEFT TO THE COMPANY, WHICH CAN READ PUBLIC MONEY, AND NOT REFUSED HERE', async () => {
    const asked: string[] = [];
    const d = aDevice({
      standings: [round({ raisedAt: 'now' })],
      legPayments: async (runId, body) => {
        asked.push(`${runId} ${JSON.stringify(body)}`);
        return { asset: '0'.repeat(64), payments: [{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }] };
      },
      raiseOrder: async () => orderPaying([{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }]),
    });
    /* RED WHEN: this device asks itself about public money it cannot read - every run with a public payee is then refused here. */
    expect((await sendRaiseFromDevice(d.doors, { ...RAISE, asset: '0'.repeat(64) })).raisedAt).toBe('now');
    expect(d.log.filter((l) => l.startsWith('vault read'))).toEqual([]);
    /* RED WHEN: the device check is skipped outright before the send. */
    expect(asked).toEqual([`run_1 {"viewingKey":"vk","asset":"${'0'.repeat(64)}"}`]);
    expect(d.log.indexOf('stage checking-the-vault')).toBeLessThan(d.log.indexOf('stage building'));
  });

  it('THE PRIVATE HALF OF A RUN THAT ALSO PAYS PUBLICLY IS STILL ASKED HERE', async () => {
    /* A run paying TOKEN both ways is two legs side by side; raising its private leg names the token and the form. */
    const asked: string[] = [];
    const mixed = aDevice({
      pool: [note(1, 5_000n)],
      legPayments: async (runId, body) => {
        asked.push(`${runId} ${JSON.stringify(body)}`);
        return { asset: TOKEN, form: 'shielded', payments: [{ kind: 'shielded', token: TOKEN, amount: '10000' }] };
      },
      raiseOrder: async () => orderPaying([{ kind: 'shielded', token: TOKEN, amount: '10000' }]),
    });
    const refused = await sendRaiseFromDevice(mixed.doors, { ...RAISE, form: 'shielded' }).catch((e) => e);
    /* RED WHEN: a leg with any public payment skips the device check - its private half is then checked nowhere. */
    expect(refused?.why).toBe('short');
    expect(refused?.form).toBe('shielded');
    expect(serviceCalls(mixed.log)).toEqual([]);
    /* RED WHEN the form is not sent beside the token, so the company cannot tell which of the run's two legs is raised. */
    expect(asked).toEqual([`run_1 {"viewingKey":"vk","asset":"${TOKEN}","form":"shielded"}`]);
  });

  it('WHAT THE COMPANY SAYS THE LEG PAYS IS CHECKED FOR BEING THIS LEG, AND FOR A SHAPE THIS DEVICE CAN READ', async () => {
    for (const [why, answer, says] of [
      /* A leg the device could pass on its own terms, so only the asset being another's refuses it. */
      ['another asset\'s leg', { asset: '0'.repeat(64), payments: [{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }] }, /Nothing was sent for approval and no fee was spent\.$/u],
      ['a kind that is neither private nor public', { asset: TOKEN, payments: [{ kind: 'Shielded', token: TOKEN, amount: '10000' }] }, /Nothing was raised and no fee was spent/u],
      ['an amount that is not a whole number', { asset: TOKEN, payments: [{ kind: 'shielded', token: TOKEN, amount: '1e4' }] }, /Nothing was raised and no fee was spent/u],
    ] as const) {
      const d = aDevice({ legPayments: async () => answer as LegPaymentsOnTheWire });
      /* RED WHEN: the device checks payments other than the leg being raised, or skips one it cannot read. */
      await expect(sendRaiseFromDevice(d.doors, RAISE), why).rejects.toThrow(says);
      expect(serviceCalls(d.log), why).toEqual([]);
    }
    /* RED WHEN the private leg of a run is checked with the public leg's payments, or the refusal names a token rather than its symbol. */
    const otherForm = aDevice({ legPayments: async () => ({ asset: TOKEN, form: 'unshielded', payments: [{ kind: 'unshielded', token: TOKEN, amount: '5' }] }) });
    const refused = await sendRaiseFromDevice(otherForm.doors, { ...RAISE, form: 'shielded' }).catch((e) => e);
    /* RED WHEN the refusal stops saying in plain words which payments came back, which were asked for, and that nothing was sent or spent (ruled copy fix, 1 Oct). */
    expect(String(refused?.message)).toBe('The service returned the public tPAY payments when the private tPAY payments were asked for. '
      + 'Nothing was sent for approval and no fee was spent.');
    expect(serviceCalls(otherForm.log)).toEqual([]);
  });

  it('A FAILURE TO ASK IS NOT SAID AS MONEY SHORT', async () => {
    const d = aDevice({ fitFails: new Error('the part of this page that builds vault transactions did not start.') });
    const refused = await sendRaiseFromDevice(d.doors, RAISE).catch((e) => e);
    /* RED WHEN: any error from the walk becomes "deposit more" - a person then moves money to fix a page that did not load. */
    expect(refused?.why).toBe('failed');
    expect(String(refused?.message)).not.toMatch(/Deposit/u);
    expect(serviceCalls(d.log)).toEqual([]);
  });

  it('6. NOTHING THIS DEVICE SENDS THE COMPANY CARRIES A NOTE, THE POOL OR A BALANCE', async () => {
    /* Values that appear nowhere but in this vault's pool, so any of them reaching a body is a leak. */
    const secretNotes = [note(0xabc, 987_654_321n), note(0xdef, 123_456_789n)];
    const bodies: string[] = [];
    const d = aDevice({
      pool: secretNotes,
      standings: [round({ raisedAt: 'now' })],
      send: async (id, body) => { bodies.push(JSON.stringify({ id, ...body })); return round({ txRef: 't1' }); },
      callState: async (id) => { bodies.push(id); return { account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }; },
      standing: async (id) => { bodies.push(JSON.stringify({ id })); return round({ raisedAt: 'now' }); },
    });
    await sendRaiseFromDevice(d.doors, RAISE);
    const vaultReads = d.log.filter((l) => l.startsWith('vault read'));
    const sent = [...bodies, ...vaultReads].join('\n');
    /* RED WHEN: a note, its nonce, its value, the pool's total or anything the pool holds reaches the company. */
    for (const n of secretNotes) {
      expect(sent).not.toContain(n.nonce);
      expect(sent).not.toContain(n.nonce.replace(/^0+/u, ''));
      expect(sent).not.toContain(n.value.toString());
      expect(sent).not.toContain(committed(n));
    }
    expect(sent).not.toContain((987_654_321n + 123_456_789n).toString());
    expect(sent).not.toMatch(/notes|nonce|pool|balance|held/u);
    /* And the send carries only the version beside the proven transaction: no key, and nothing the vault was checked with. */
    const sendBody = bodies.map((b) => JSON.parse(b.startsWith('{') ? b : '{}')).find((b) => 'tx' in b);
    expect(Object.keys(sendBody).sort()).toEqual(['id', 'tx', 'version']);
    expect(vaultReads).toEqual(Array(2).fill(`vault read ${'99'.repeat(32)}`));
  });

  it('A PAGE THAT CAN READ NEITHER THE COMPANY\'S RECORDS NOR WHAT IS MADE FROM THEM BUILDS NOTHING', async () => {
    const d = aDevice();
    const { made: _m, ...unread } = d.doors;
    /* RED WHEN: a raise is built or sent from anything but what this device made from the company's records. */
    await expect(sendRaiseFromDevice(unread, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN })).rejects.toThrow(/cannot read the company's records/u);
    expect(d.log.filter((l) => /^(build|send)/u.test(l))).toEqual([]);
  });

  it('ASKS THE COMPANY FOR NOTHING A RAISE, A RETRY OR A SEAT IS BUILT FROM: THOSE ARE MADE HERE', () => {
    const service = governedCallServiceFor(async () => ({})) as unknown as Record<string, unknown>;
    /* RED WHEN: the page asks the company's service again for a leg's payments, a written-down order, or what carries out a seat. */
    for (const gone of ['legPayments', 'raiseOrder', 'retryPayments', 'retryOrder', 'seatOrder', 'thresholdOrder']) {
      expect(service[gone], gone).toBeUndefined();
    }
  });
});

describe('EVERY SEND IS CHECKED AGAINST THE VAULT ON THIS DEVICE FIRST, AND SAYS WHICH PAGE CHECKED WHAT', () => {
  const builtOrSent = (log: string[]) => log.filter((l) => /^(state|build|send) /u.test(l));

  it('4. A SEND AGAIN OF A WRITTEN-DOWN PROPOSAL CHECKS THE VAULT FIRST, AND A VAULT THAT CAN NO LONGER PAY IS REFUSED BEFORE ANYTHING IS BUILT OR SENT', async () => {
    const d = aDevice({ pool: [note(1, 29_999n)] });
    const refused = await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN }).catch((e) => e);
    /* RED WHEN: a send again goes out on the check made when the proposal was written down, days before. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(builtOrSent(d.log)).toEqual([]);
    /* The vault asked about is the one the written-down proposal names, and it is asked before the chain is read. */
    expect(d.log.filter((l) => !l.startsWith('stage')).slice(0, 2)).toEqual(['made order run_1', `made leg-payments run_1 {"viewingKey":"vk","asset":"${TOKEN}"}`]);
    expect(d.log).toContain(`vault read ${ORDER.order.run.vault}`);
    expect(d.log).toContain('stage checking-the-vault');
  });

  it('4c. THE SEND NAMES THIS PAGE\'S VERSION, AND GOES ONLY WHEN THE PROPOSAL WRITTEN DOWN PAYS EXACTLY WHAT THIS CHECK WAS HANDED', async () => {
    /* A public leg of the same token and amount as a private one, so the kind is part of what is compared at this call site. */
    const other: LegPaymentsOnTheWire = { asset: TOKEN, form: 'unshielded', payments: [{ kind: 'unshielded', token: TOKEN, amount: '12345' }] };
    const bodies: Array<{ tx: string; version: number }> = [];
    const d = aDevice({
      standings: [round({ raisedAt: 'now' })],
      legPayments: async () => other,
      raiseOrder: async () => orderPaying(other.payments),
      send: async (_id, body) => { bodies.push(body); return round({ txRef: 't1' }); },
    });
    await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN, form: 'unshielded' });
    /* RED WHEN: the send carries no version, or a stale one. */
    expect(bodies).toEqual([{ tx: 'TX-propose', version: DEVICE_RAISE_VERSION }]);
    /* RED WHEN: a proposal written down for the same amounts of the other kind is sent on this check. */
    const kindSwapped = aDevice({
      legPayments: async () => other,
      raiseOrder: async () => orderPaying([{ kind: 'shielded', token: TOKEN, amount: '12345' }]),
    });
    await expect(sendRaiseFromDevice(kindSwapped.doors, { runId: 'run_1', viewingKey: 'vk', asset: TOKEN, form: 'unshielded' }))
      .rejects.toThrow(WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED);
    expect(builtOrSent(kindSwapped.log)).toEqual([]);
  });
});

describe('A RETRY WRITTEN DOWN IS SENT FROM THIS DEVICE, WITH THE VAULT CHECKED FOR EXACTLY THE RETRY', () => {
  /* A retry's first raise is made where it is raised (`run-raised-here.ts`); what is sent again is checked here the same way. */
  const RETRY = { runId: 'run_1', viewingKey: 'vk', asset: TOKEN, proposalId: 'prp_r' };
  const serviceCalls = (log: string[]) => log.filter((l) => /^(retry|send|state|build|standing) /u.test(l));

  it('4. A RETRY THE VAULT CANNOT PAY IS REFUSED ON THIS DEVICE BEFORE ANYTHING IS BUILT OR SENT', async () => {
    /* Enough for one of the two people this retry pays, and not for both. */
    const short = aDevice({ pool: [note(1, 15_000n)] });
    const refused = await sendRetryFromDevice(short.doors, RETRY).catch((e) => e);
    /* RED WHEN: the device check is skipped for a retry sent again. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(refused?.asked).toBe(20_000n);
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(serviceCalls(short.log)).toEqual([]);
  });

  it('A RETRY SENT AGAIN IS CHECKED AGAINST THE VAULT FOR THE PEOPLE IT WAS WRITTEN DOWN WITH', async () => {
    const d = aDevice({ standings: [round({ id: 'prp_r', raisedAt: 'now' })] });
    await sendRetryFromDevice(d.doors, RETRY);
    /* RED WHEN: sending a retry again checks anything but the people the written-down retry pays. */
    expect(d.log.filter((l) => !l.startsWith('stage') && !l.startsWith('vault read'))).toEqual([
      'made retry-order run_1 prp_r', `made retry-payments run_1 {"viewingKey":"vk","asset":"${TOKEN}","indices":[1,2]}`,
      'state acc_1', `build propose for ${'ac'.repeat(32)} on AS`,
      `send prp_r TX-propose ${DEVICE_RAISE_VERSION}`, 'standing prp_r',
    ]);
    /* RED WHEN: the leg's payments are checked instead of the retry's. */
    expect(d.log.filter((l) => l.startsWith('made leg-payments'))).toEqual([]);
  });

  it('6. NOTHING A RETRY SENT FROM THIS DEVICE CARRIES TO THE COMPANY IS A NOTE, THE POOL OR A BALANCE', async () => {
    const d = aDevice({ standings: [round({ id: 'prp_r', raisedAt: 'now' })] });
    await sendRetryFromDevice(d.doors, RETRY);
    const toTheCompany = d.log.filter((l) => /^(retry|send|standing) /u.test(l)).join('\n');
    /* RED WHEN: a retry's request gains a note, the pool, a balance or the vault's holdings. */
    for (const n of PLENTY) {
      expect(toTheCompany).not.toContain(n.nonce);
      expect(toTheCompany).not.toContain(n.value.toString());
    }
    expect(toTheCompany).not.toMatch(/nonce|pool|balance|held|notes/u);
  });
});

describe('WITHDRAWING A PROPOSAL FROM THIS DEVICE', () => {
  it('one only written down is withdrawn with no call, and nothing is built', async () => {
    const d = aDevice({ standings: [round()] });
    expect((await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).status).toBe('cancelled');
    /* RED WHEN: a proposal the chain never held is withdrawn by a proven call, or not withdrawn at all. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual(['standing prp_1', 'cancel prp_1 {}']);
  });

  it('one the chain holds is withdrawn by the cancel call this device proves for the proposal it opened', async () => {
    const d = aDevice({ standings: [round({ raisedAt: 'then', txRef: 't1' })] });
    await withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' });
    /* RED WHEN: the withdrawal of a held proposal is sent with no proven call, or proves anything but a cancel. */
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'standing prp_1', 'state acc_1', `build cancel for ${'ac'.repeat(32)} on AS`, 'cancel prp_1 {"tx":"TX-cancel"}',
    ]);
  });

  it('a proposal the company now names differently is not withdrawn, and a page with no withdrawal says so', async () => {
    const d = aDevice({ standings: [round({ chainId: 'dd'.repeat(32), raisedAt: 'then' })] });
    /* RED WHEN: the device withdraws whatever the service names now under the id the page showed. */
    await expect(withdrawOnDevice(d.doors, { round: round(), viewingKey: 'vk' })).rejects.toThrow(/another proposal than the one shown here/u);
    expect(d.log.filter((l) => /^(build|cancel)/u.test(l))).toEqual([]);
    const old = aDevice();
    const { cancel: _c, ...noCancel } = old.doors.service;
    /* RED WHEN: a page without the relay sends a withdrawal some other way. */
    await expect(withdrawOnDevice({ ...old.doors, service: noCancel }, { round: round(), viewingKey: 'vk' }))
      .rejects.toThrow(/cannot withdraw proposals/u);
  });
});
