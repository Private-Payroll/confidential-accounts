import { describe, it, expect } from 'vitest';
import {
  approveOnDevice, governedCallServiceFor, nothingWasSentBy, raiseRetryOnDevice, raiseRunOnDevice, SentAndNotYetSeen,
  sendRaiseFromDevice, sendRetryFromDevice,
  type GovernedCallService, type LegPaymentsOnTheWire, type RaiseDoors, type RaiseOrderOnTheWire, type RetryOrderOnTheWire,
  type RoundOnThePage,
} from './governed-call-on-device.js';
import { deviceVaultHoldings, type PoolNote } from './device-vault-holdings.js';
import { paymentsFitNotes } from './vault-builder.js';
import { registryWithTestPrivateForms, testPrivateToken } from '../testing/assets.js';
import type { Hex } from '../core/crypto.js';
import { SEED_ASSETS, StaticAssetRegistry } from '../core/assets.js';
import { DEVICE_RAISE_VERSION, paymentsCheckedDigest } from '../core/device-raise.js';
import { opensAs } from '../testing/sealed-records.js';

/* The page's side, over a service and a worker that write down what they were asked, in order. */
const material = { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) };
/* The vault's private money, as this device's pool records it and the chain holds it. */
const TOKEN = testPrivateToken('GBP') as Hex;
const note = (n: number, value: bigint): PoolNote => ({
  nonce: n.toString(16).padStart(64, '0') as Hex, token: TOKEN, value, createdIn: 'ee'.repeat(32) as Hex,
});
const committed = (n: PoolNote) => `c${n.nonce.slice(1)}`;
const LEG: LegPaymentsOnTheWire = {
  asset: 'GBP', payments: [0, 1, 2].map(() => ({ kind: 'shielded', token: TOKEN, amount: '10000' })),
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

const aDevice = (over: Partial<GovernedCallService> & {
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
  const service: GovernedCallService = {
    legPayments: async (runId, body) => { checks += 1; log.push(`leg-payments ${runId} ${JSON.stringify(body)}`); return LEG; },
    raiseRun: async (runId, body) => { log.push(`raise ${runId} ${JSON.stringify(body)}`); return { proposal: round(), order: ORDER }; },
    raiseOrder: async (runId) => { log.push(`order ${runId}`); return ORDER; },
    sendRaise: async (runId, body) => {
      log.push(`send-raise ${runId} ${body.tx} ${body.version} ${body.checked}`); return round({ txRef: 't1' });
    },
    retryPayments: async (runId, body) => {
      checks += 1; log.push(`retry-payments ${runId} ${JSON.stringify(body)}`);
      return { asset: LEG.asset, payments: body.indices.map((i) => LEG.payments[i]!) };
    },
    raiseRetry: async (runId, body) => {
      log.push(`retry ${runId} ${JSON.stringify(body)}`);
      return {
        proposal: round({ id: 'prp_r' }),
        order: { ...RETRY_ORDER, indices: body.indices, paymentsChecked: paymentsCheckedDigest(body.indices.map((i) => LEG.payments[i]!)) },
      };
    },
    retryOrder: async (runId, body) => { log.push(`retry-order ${runId} ${body.proposalId}`); return RETRY_ORDER; },
    sendRetry: async (runId, body) => {
      log.push(`send-retry ${runId} ${body.proposalId} ${body.tx} ${body.version} ${body.checked}`); return round({ id: 'prp_r', txRef: 't2' });
    },
    callState: async (id) => { log.push(`state ${id}`); return { account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }; },
    approve: async (id, body) => { log.push(`approve ${id} ${body.signature} ${body.tx}`); return round(); },
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
    service, holdings, assets: registryWithTestPrivateForms(),
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
  it('writes the proposal down first, reads the chain, builds with this signer\'s material, sends, and waits until the chain holds it', async () => {
    const d = aDevice({ standings: [round({ txRef: 't1' }), round({ txRef: 't1', raisedAt: 'now' })] });
    const done = await raiseRunOnDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP', vault: '99'.repeat(32), opensAt: '1', closesAt: '2' });
    expect(done.raisedAt).toBe('now');
    /* RED WHEN: the order changes - above all, a build or a send before the proposal is written down. */
    expect(d.log).toEqual([
      'stage checking-the-vault',
      'leg-payments run_1 {"viewingKey":"vk","asset":"GBP"}',
      `vault read ${'99'.repeat(32)}`, `vault read ${'99'.repeat(32)}`,
      'stage writing-down',
      `raise run_1 {"viewingKey":"vk","vault":"${'99'.repeat(32)}","opensAt":"1","closesAt":"2","asset":"GBP","onDevice":true,`
        + `"version":${DEVICE_RAISE_VERSION},"checked":"${CHECKED}"}`,
      /* RED WHEN: the vault is not checked again right before the send, after the proposal is written down. */
      'stage checking-the-vault',
      'leg-payments run_1 {"viewingKey":"vk","asset":"GBP"}',
      `vault read ${'99'.repeat(32)}`, `vault read ${'99'.repeat(32)}`,
      'stage reading-the-chain', 'state acc_1',
      'stage building', `build propose for ${'ac'.repeat(32)} on AS`,
      'stage sending', `send-raise run_1 TX-propose ${DEVICE_RAISE_VERSION} ${CHECKED}`,
      'stage waiting-for-the-chain', 'standing prp_1', 'standing prp_1',
    ]);
  });

  it('A PROPOSAL THE CHAIN ALREADY HOLDS IS NOT BUILT OR SENT AGAIN', async () => {
    const d = aDevice({ raiseRun: async () => ({ proposal: round({ raisedAt: 'then' }), order: null }) });
    const done = await raiseRunOnDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', vault: 'v', opensAt: '1', closesAt: '2' });
    expect(done.raisedAt).toBe('then');
    /* RED WHEN: a null order is built from anyway. */
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('send'))).toEqual([]);
  });

  it('A BUILD THAT FAILS SENDS NOTHING, and the proposal written down can be sent again as itself', async () => {
    const d = aDevice({ buildFails: new Error('you are not a signer') });
    await expect(raiseRunOnDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', vault: '99'.repeat(32), opensAt: '1', closesAt: '2' }))
      .rejects.toThrow('you are not a signer');
    expect(d.log.filter((l) => l.startsWith('send'))).toEqual([]);
    const again = aDevice({ standings: [round({ raisedAt: 'now' })] });
    await sendRaiseFromDevice(again.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP' });
    /* RED WHEN: sending again asks for anything but the proposal already written down and what its vault can pay. */
    expect(again.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'order run_1', 'leg-payments run_1 {"viewingKey":"vk","asset":"GBP"}',
      `vault read ${'99'.repeat(32)}`, `vault read ${'99'.repeat(32)}`,
      'state acc_1', `build propose for ${'ac'.repeat(32)} on AS`,
      `send-raise run_1 TX-propose ${DEVICE_RAISE_VERSION} ${CHECKED}`, 'standing prp_1',
    ]);
  });

  it('WHAT THE SERVICE HANDS OVER IS BUILT ONLY IF IT IS A RAISE OF THE PROPOSAL IT NAMES, WITH THE VAULT AND WINDOW CHOSEN HERE', async () => {
    const chosen = { runId: 'run_1', viewingKey: 'vk', vault: '99'.repeat(32), opensAt: '1', closesAt: '2' };
    for (const [why, order] of [
      ['an approval handed over as a raise', { ...ORDER, order: { circuit: 'approve', proposal: 'dd'.repeat(32) } }],
      ['a raise of another proposal', { ...ORDER, order: { ...ORDER.order, proposal: 'dd'.repeat(32) } }],
      ['another vault', { ...ORDER, order: { ...ORDER.order, run: { ...ORDER.order.run, vault: '98'.repeat(32) } } }],
      ['another window', { ...ORDER, order: { ...ORDER.order, run: { ...ORDER.order.run, closesAt: '3' } } }],
    ] as const) {
      const d = aDevice({ raiseRun: async () => ({ proposal: round(), order: order as unknown as RaiseOrderOnTheWire }) });
      /* RED WHEN: the device builds what it is handed without asking whether it is what the person chose. */
      await expect(raiseRunOnDevice(d.doors, chosen), why).rejects.toThrow(/Nothing was built or sent/u);
      expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('send')), why).toEqual([]);
    }
    /* RED WHEN: sending a written-down proposal again builds an approval of it, named exactly as the proposal. */
    const resend = aDevice({ raiseOrder: async () => ({ ...ORDER, order: { circuit: 'approve', proposal: ORDER.chainId } as never }) });
    await expect(sendRaiseFromDevice(resend.doors, { runId: 'run_1', viewingKey: 'vk' })).rejects.toThrow(/not the proposal it wrote down/u);
    expect(resend.log.filter((l) => l.startsWith('build') || l.startsWith('send'))).toEqual([]);
    /* The vault is compared however it is spelled. */
    const ok = aDevice({ standings: [round({ raisedAt: 'now' })] });
    await raiseRunOnDevice(ok.doors, { ...chosen, vault: '99'.repeat(32).toUpperCase() });
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
  it('reads the standing first, builds the approval for the proposal\'s chain identity, sends it with the signature, and waits for one more', async () => {
    const counted = (n: number) => round({ raisedAt: 'x', approvalRound: { state: 'short', approvals: n } });
    const d = aDevice({ standings: [counted(1), counted(1), counted(2)] });
    const done = await approveOnDevice(d.doors, { round: round(), signerId: 'sgn_1', signature: 'SIG', viewingKey: 'vk' });
    expect(done.approvalRound?.approvals).toBe(2);
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'standing prp_1', 'state acc_1', `build approve for ${'ac'.repeat(32)} on AS`, 'approve prp_1 SIG TX-approve',
      /* RED WHEN: the wait stops at a count the chain already had before this approval. */
      'standing prp_1', 'standing prp_1',
    ]);
  });

  it('AN APPROVAL IS BUILT ONLY FOR THE PROPOSAL THE PERSON WAS SHOWN', async () => {
    const d = aDevice({ standings: [round({ chainId: 'dd'.repeat(32) })] });
    /* RED WHEN: the device proves an approval of whatever id the service names now. */
    await expect(approveOnDevice(d.doors, { round: round(), signerId: 's', signature: 'S', viewingKey: 'vk' }))
      .rejects.toThrow(/another proposal than the one shown here/u);
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('approve'))).toEqual([]);
  });

  it('a proposal the chain now calls approved ends the wait, and one that never counts it is sent and not seen', async () => {
    const d = aDevice({ standings: [round(), round({ status: 'approved' })] });
    expect((await approveOnDevice(d.doors, { round: round(), signerId: 's', signature: 'S', viewingKey: 'vk' })).status).toBe('approved');
    const never = aDevice({ standings: [round()] });
    await expect(approveOnDevice(never.doors, { round: round(), signerId: 's', signature: 'S', viewingKey: 'vk' }))
      .rejects.toBeInstanceOf(SentAndNotYetSeen);
  });

  it('A SERVICE REFUSAL KEEPS ITS OWN MARK OF WHETHER ANYTHING WAS SENT', async () => {
    const calls: string[] = [];
    const api = async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`);
      if (path.endsWith('/approve')) throw new Error('signature does not match. Nothing was sent.');
      if (path.endsWith('/raise-send')) throw new Error('the node dropped the connection');
      return {};
    };
    const service = governedCallServiceFor(api);
    /* RED WHEN: the mark is dropped - a refusal then reads as maybe sent, and a failure at the send as nothing sent. */
    expect(nothingWasSentBy(await service.approve('p 1', { signerId: 's', signature: 'S', viewingKey: 'vk', tx: 'T' }).catch((e) => e))).toBe(true);
    expect(nothingWasSentBy(await service.sendRaise('r1', {
      viewingKey: 'vk', tx: 'T', version: DEVICE_RAISE_VERSION, checked: 'ab'.repeat(32),
    }).catch((e) => e))).toBe(false);
    await service.callState('acc 1');
    await service.standing('p 1', { viewingKey: 'vk' });
    /* RED WHEN: a key travels in an address rather than a body, or an id is not escaped. */
    expect(calls).toEqual([
      'POST /api/proposals/p%201/approve {"signerId":"s","signature":"S","viewingKey":"vk","tx":"T"}',
      `POST /api/runs/r1/raise-send {"viewingKey":"vk","tx":"T","version":${DEVICE_RAISE_VERSION},"checked":"${'ab'.repeat(32)}"}`,
      'GET /api/accounts/acc%201/call-state ',
      'POST /api/proposals/p%201/standing {"viewingKey":"vk"}',
    ]);
  });
});

describe('THE VAULT\'S PRIVATE MONEY IS ASKED ON THIS DEVICE BEFORE THE COMPANY IS ASKED TO WRITE A RAISE DOWN', () => {
  const RAISE = { runId: 'run_1', viewingKey: 'vk', asset: 'GBP', vault: '99'.repeat(32), opensAt: '1', closesAt: '2' };
  const serviceCalls = (log: string[]) => log.filter((l) => /^(raise|order|send|state|approve|standing) /u.test(l));

  it('1. A RUN THE POOL CANNOT PAY IS REFUSED HERE, AND THE COMPANY IS NEVER ASKED TO RAISE IT', async () => {
    const short = aDevice({ pool: [note(1, 15_000n)] });
    const refused = await raiseRunOnDevice(short.doors, RAISE).catch((e) => e);
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
      legPayments: async () => ({ asset: 'GBP', payments: [0, 1].map(() => ({ kind: 'shielded', token: TOKEN, amount: '15000' })) }),
    });
    const unfit = await raiseRunOnDevice(split.doors, RAISE).catch((e) => e);
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
      const refused = await raiseRunOnDevice(d.doors, RAISE).catch((e) => e);
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
        return { asset: 'NIGHT', payments: [{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }] };
      },
      raiseRun: async () => ({ proposal: round(), order: orderPaying([{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }]) }),
    });
    /* RED WHEN: this device asks itself about public money it cannot read - every run with a public payee is then refused here. */
    expect((await raiseRunOnDevice(d.doors, { ...RAISE, asset: 'NIGHT' })).raisedAt).toBe('now');
    expect(d.log.filter((l) => l.startsWith('vault read'))).toEqual([]);
    /* RED WHEN: the device check is skipped outright, before the write-down or before the send. */
    expect(asked).toEqual(Array(2).fill('run_1 {"viewingKey":"vk","asset":"NIGHT"}'));
    expect(d.log[0]).toBe('stage checking-the-vault');
  });

  it('THE PRIVATE HALF OF A RUN THAT ALSO PAYS PUBLICLY IS STILL ASKED HERE', async () => {
    const mixed = aDevice({
      pool: [note(1, 5_000n)],
      legPayments: async () => ({ asset: 'GBP', payments: [
        { kind: 'shielded', token: TOKEN, amount: '10000' },
        { kind: 'unshielded', token: 'ab'.repeat(32), amount: '5' },
      ] }),
    });
    /* GBP given a public token too, so one payment on the leg can be public. */
    const both = new StaticAssetRegistry(SEED_ASSETS.map((a) => (a.code === 'GBP'
      ? { ...a, ledger: { shielded: TOKEN, unshielded: 'ab'.repeat(32) } } : a)));
    const refused = await raiseRunOnDevice({ ...mixed.doors, assets: both }, RAISE).catch((e) => e);
    /* RED WHEN: a leg with any public payment skips the device check - its private half is then checked nowhere. */
    expect(refused?.why).toBe('short');
    expect(refused?.form).toBe('shielded');
    expect(serviceCalls(mixed.log)).toEqual([]);
  });

  it('WHAT THE COMPANY SAYS THE LEG PAYS IS CHECKED FOR BEING THIS LEG, AND FOR A SHAPE THIS DEVICE CAN READ', async () => {
    for (const [why, answer] of [
      /* A leg the device could pass on its own terms, so only the asset being another's refuses it. */
      ['another asset\'s leg', { asset: 'NIGHT', payments: [{ kind: 'unshielded', token: '0'.repeat(64), amount: '5' }] }],
      ['a kind that is neither private nor public', { asset: 'GBP', payments: [{ kind: 'Shielded', token: TOKEN, amount: '10000' }] }],
      ['an amount that is not a whole number', { asset: 'GBP', payments: [{ kind: 'shielded', token: TOKEN, amount: '1e4' }] }],
    ] as const) {
      const d = aDevice({ legPayments: async () => answer as LegPaymentsOnTheWire });
      /* RED WHEN: the device checks payments other than the leg being raised, or skips one it cannot read. */
      await expect(raiseRunOnDevice(d.doors, RAISE), why).rejects.toThrow(/Nothing was raised and no fee was spent/u);
      expect(serviceCalls(d.log), why).toEqual([]);
    }
  });

  it('A FAILURE TO ASK IS NOT SAID AS MONEY SHORT', async () => {
    const d = aDevice({ fitFails: new Error('the part of this page that builds vault transactions did not start.') });
    const refused = await raiseRunOnDevice(d.doors, RAISE).catch((e) => e);
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
      legPayments: async (runId, body) => { bodies.push(JSON.stringify({ runId, ...body })); return LEG; },
      raiseRun: async (runId, body) => { bodies.push(JSON.stringify({ runId, ...body })); return { proposal: round(), order: ORDER }; },
      raiseOrder: async (runId, body) => { bodies.push(JSON.stringify({ runId, ...body })); return ORDER; },
      sendRaise: async (runId, body) => { bodies.push(JSON.stringify({ runId, ...body })); return round({ txRef: 't1' }); },
      callState: async (id) => { bodies.push(id); return { account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }; },
      standing: async (id, body) => { bodies.push(JSON.stringify({ id, ...body })); return round({ raisedAt: 'now' }); },
    });
    await raiseRunOnDevice(d.doors, RAISE);
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
    /* And the raise itself carries exactly what it did before this device read its pool. */
    expect(Object.keys(JSON.parse(bodies[1]!)).sort()).toEqual(
      ['asset', 'checked', 'closesAt', 'onDevice', 'opensAt', 'runId', 'vault', 'version', 'viewingKey']);
    /* And the send carries only the version and the digest beside the proven transaction. */
    const sendBody = bodies.map((b) => JSON.parse(b.startsWith('{') ? b : '{}')).find((b) => 'tx' in b);
    expect(Object.keys(sendBody).sort()).toEqual(['asset', 'checked', 'runId', 'tx', 'version', 'viewingKey']);
    expect(vaultReads).toEqual(Array(4).fill(`vault read ${'99'.repeat(32)}`));
  });

  it('asks the company for what the leg pays over its own route, with the viewing key in the body', async () => {
    const calls: string[] = [];
    const service = governedCallServiceFor(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`);
      return LEG;
    });
    await service.legPayments('r 1', { viewingKey: 'vk', asset: 'GBP' });
    /* RED WHEN: the key travels in an address, or the run id is not escaped. */
    expect(calls).toEqual(['POST /api/runs/r%201/leg-payments {"viewingKey":"vk","asset":"GBP"}']);
  });
});

describe('EVERY SEND IS CHECKED AGAINST THE VAULT ON THIS DEVICE FIRST, AND SAYS WHICH PAGE CHECKED WHAT', () => {
  const RAISE = { runId: 'run_1', viewingKey: 'vk', asset: 'GBP', vault: '99'.repeat(32), opensAt: '1', closesAt: '2' };
  const builtOrSent = (log: string[]) => log.filter((l) => /^(state|build|send-raise) /u.test(l));

  it('4. A SEND AGAIN OF A WRITTEN-DOWN PROPOSAL CHECKS THE VAULT FIRST, AND A VAULT THAT CAN NO LONGER PAY IS REFUSED BEFORE ANYTHING IS BUILT OR SENT', async () => {
    const d = aDevice({ pool: [note(1, 29_999n)] });
    const refused = await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP' }).catch((e) => e);
    /* RED WHEN: a send again goes out on the check made when the proposal was written down, days before. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(builtOrSent(d.log)).toEqual([]);
    /* The vault asked about is the one the written-down proposal names, and it is asked before the chain is read. */
    expect(d.log.filter((l) => !l.startsWith('stage')).slice(0, 2)).toEqual(['order run_1', 'leg-payments run_1 {"viewingKey":"vk","asset":"GBP"}']);
    expect(d.log).toContain(`vault read ${ORDER.order.run.vault}`);
    expect(d.log).toContain('stage checking-the-vault');
  });

  it('4b. A FIRST SEND IS CHECKED AGAIN AFTER THE PROPOSAL IS WRITTEN DOWN, SO A VAULT EMPTIED IN BETWEEN SENDS NOTHING', async () => {
    const d = aDevice({ poolAtCheck: [PLENTY, [note(1, 100n)]] });
    const refused = await raiseRunOnDevice(d.doors, RAISE).catch((e) => e);
    /* RED WHEN: the first send rides on the check made before the write-down. */
    expect(refused?.why).toBe('short');
    expect(d.log.filter((l) => l.startsWith('raise '))).toHaveLength(1);
    expect(builtOrSent(d.log)).toEqual([]);
  });

  it('4c. THE SEND NAMES THIS PAGE\'S VERSION AND THE DIGEST OF EXACTLY WHAT THIS CHECK WAS HANDED', async () => {
    /* A private payment and a public one, so the kind of each is part of what is digested at this call site. */
    const other: LegPaymentsOnTheWire = { asset: 'GBP', payments: [
      { kind: 'shielded', token: TOKEN, amount: '12345' }, { kind: 'unshielded', token: 'ab'.repeat(32), amount: '5' },
    ] };
    const both = new StaticAssetRegistry(SEED_ASSETS.map((a) => (a.code === 'GBP'
      ? { ...a, ledger: { shielded: TOKEN, unshielded: 'ab'.repeat(32) } } : a)));
    const bodies: Array<{ version: number; checked: string }> = [];
    const d = aDevice({
      standings: [round({ raisedAt: 'now' })],
      legPayments: async () => other,
      raiseOrder: async () => orderPaying(other.payments),
      sendRaise: async (_r, body) => { bodies.push(body); return round({ txRef: 't1' }); },
    });
    await sendRaiseFromDevice({ ...d.doors, assets: both }, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP' });
    /* RED WHEN: the send carries no version, a stale one, or a digest of anything but the payments this check was handed - kind included. */
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.version).toBe(DEVICE_RAISE_VERSION);
    expect(bodies[0]!.checked).toBe(paymentsCheckedDigest([{ kind: 'shielded', token: TOKEN, amount: '12345' }, { kind: 'unshielded', token: 'ab'.repeat(32), amount: '5' }]));
    expect(bodies[0]!.checked).not.toBe(CHECKED);
  });
});

describe('A STOPPED RUN IS RETRIED FROM THIS DEVICE, WITH THE VAULT CHECKED FOR EXACTLY THE RETRY', () => {
  const RETRY = { runId: 'run_1', viewingKey: 'vk', asset: 'GBP', indices: [1, 2], vault: '99'.repeat(32), opensAt: '1', closesAt: '2' };
  /* The digest of the retry's two payments, which is not the digest of the leg's three. */
  const RETRY_CHECKED = paymentsCheckedDigest(LEG.payments.slice(1));
  const serviceCalls = (log: string[]) => log.filter((l) => /^(retry|retry-order|send-retry|state|build|standing) /u.test(l));

  it('checks the vault for the retry\'s payments, has it written down with the version and that digest, checks again, builds and sends it', async () => {
    const d = aDevice({ standings: [round({ id: 'prp_r', raisedAt: 'now' })] });
    const done = await raiseRetryOnDevice(d.doors, RETRY);
    expect(done.raisedAt).toBe('now');
    expect(RETRY_CHECKED).not.toBe(CHECKED);
    /* RED WHEN: the order changes - above all, a retry written down or sent before the vault is checked for it on this device. */
    expect(d.log).toEqual([
      'stage checking-the-vault',
      'retry-payments run_1 {"viewingKey":"vk","asset":"GBP","indices":[1,2]}',
      `vault read ${'99'.repeat(32)}`, `vault read ${'99'.repeat(32)}`,
      'stage writing-down',
      `retry run_1 {"viewingKey":"vk","asset":"GBP","indices":[1,2],"vault":"${'99'.repeat(32)}","opensAt":"1","closesAt":"2",`
        + `"onDevice":true,"version":${DEVICE_RAISE_VERSION},"checked":"${RETRY_CHECKED}"}`,
      /* RED WHEN: the send rides on the check made before the retry was written down. */
      'stage checking-the-vault',
      'retry-payments run_1 {"viewingKey":"vk","asset":"GBP","indices":[1,2]}',
      `vault read ${'99'.repeat(32)}`, `vault read ${'99'.repeat(32)}`,
      'stage reading-the-chain', 'state acc_1',
      'stage building', `build propose for ${'ac'.repeat(32)} on AS`,
      'stage sending', `send-retry run_1 prp_r TX-propose ${DEVICE_RAISE_VERSION} ${RETRY_CHECKED}`,
      'stage waiting-for-the-chain', 'standing prp_r',
    ]);
    /* RED WHEN: the leg's payments are checked instead of the retry's. */
    expect(d.log.filter((l) => l.startsWith('leg-payments'))).toEqual([]);
  });

  it('4. A RETRY THE VAULT CANNOT PAY IS REFUSED ON THIS DEVICE BEFORE THE COMPANY IS ASKED ANYTHING', async () => {
    /* Enough for one of the two people this retry pays, and not for both. */
    const short = aDevice({ pool: [note(1, 15_000n)] });
    const refused = await raiseRetryOnDevice(short.doors, RETRY).catch((e) => e);
    /* RED WHEN: the device check is skipped for a retry, or runs after the company writes the retry down. */
    expect(refused?.name).toBe('VaultCannotPayThisProposal');
    expect(refused?.why).toBe('short');
    expect(refused?.asked).toBe(20_000n);
    expect(String(refused?.message)).toMatch(/Nothing was raised and no fee was spent\./u);
    expect(serviceCalls(short.log)).toEqual([]);

    /* A vault emptied between the write-down and the send sends nothing. */
    const emptied = aDevice({ poolAtCheck: [PLENTY, [note(1, 100n)]] });
    const late = await raiseRetryOnDevice(emptied.doors, RETRY).catch((e) => e);
    /* RED WHEN: the send of a retry goes out on the check made before it was written down. */
    expect(late?.why).toBe('short');
    expect(emptied.log.filter((l) => l.startsWith('retry '))).toHaveLength(1);
    expect(emptied.log.filter((l) => /^(state|build|send-retry) /u.test(l))).toEqual([]);
  });

  it('A RETRY SENT AGAIN IS CHECKED AGAINST THE VAULT FOR THE PEOPLE IT WAS WRITTEN DOWN WITH', async () => {
    const d = aDevice({ standings: [round({ id: 'prp_r', raisedAt: 'now' })] });
    await sendRetryFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP', proposalId: 'prp_r' });
    /* RED WHEN: sending a retry again checks anything but the people the written-down retry pays. */
    expect(d.log.filter((l) => !l.startsWith('stage') && !l.startsWith('vault read'))).toEqual([
      'retry-order run_1 prp_r', 'retry-payments run_1 {"viewingKey":"vk","asset":"GBP","indices":[1,2]}',
      'state acc_1', `build propose for ${'ac'.repeat(32)} on AS`,
      `send-retry run_1 prp_r TX-propose ${DEVICE_RAISE_VERSION} ${RETRY_CHECKED}`, 'standing prp_r',
    ]);
  });

  it('A RETRY IS BUILT ONLY IF WHAT THE COMPANY WROTE DOWN PAYS THE PEOPLE, THE VAULT AND THE WINDOW CHOSEN HERE', async () => {
    for (const [why, order] of [
      ['other people', { ...RETRY_ORDER, indices: [0, 1] }],
      ['one more person', { ...RETRY_ORDER, indices: [0, 1, 2] }],
      ['another vault', { ...RETRY_ORDER, order: { ...RETRY_ORDER.order, run: { ...RETRY_ORDER.order.run, vault: '98'.repeat(32) } } }],
      ['another window', { ...RETRY_ORDER, order: { ...RETRY_ORDER.order, run: { ...RETRY_ORDER.order.run, opensAt: '0' } } }],
      ['a raise of another proposal', { ...RETRY_ORDER, order: { ...RETRY_ORDER.order, proposal: 'dd'.repeat(32) } }],
    ] as const) {
      const d = aDevice({ raiseRetry: async () => ({ proposal: round(), order: order as RetryOrderOnTheWire }) });
      /* RED WHEN: the device builds a retry of whoever the company names rather than who was chosen here. */
      await expect(raiseRetryOnDevice(d.doors, RETRY), why).rejects.toThrow(/Nothing was built or sent/u);
      expect(d.log.filter((l) => /^(build|send)/u.test(l)), why).toEqual([]);
    }
  });

  it('6. NOTHING A RETRY FROM THIS DEVICE SENDS THE COMPANY CARRIES A NOTE, THE POOL OR A BALANCE', async () => {
    const d = aDevice({ standings: [round({ id: 'prp_r', raisedAt: 'now' })] });
    await raiseRetryOnDevice(d.doors, RETRY);
    const toTheCompany = d.log.filter((l) => /^(retry|retry-payments|retry-order|send-retry|standing) /u.test(l)).join('\n');
    /* RED WHEN: a retry's request gains a note, the pool, a balance or the vault's holdings. */
    for (const n of PLENTY) {
      expect(toTheCompany).not.toContain(n.nonce);
      expect(toTheCompany).not.toContain(n.value.toString());
    }
    expect(toTheCompany).not.toMatch(/nonce|pool|balance|held|notes/u);
  });
});
