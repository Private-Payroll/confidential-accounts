/**
 * **A DEVICE RAISES, APPROVES AND CARRIES OUT A GOVERNANCE CHANGE ONLY FOR THE
 * CHANGE THE PERSON ASKED FOR.** The page's own module, `governOnDevice`, over
 * a service that answers what a test tells it to and a builder that writes
 * down every call it is asked for. The builder's own check that an approval's
 * proposal is the one its change and salt make is in `governed-call-builder.test.ts`;
 * the whole flow over the served routes is in
 * `src/server/a-company-seats-its-signers-from-a-device.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { canonical, newSigningKeypair, newSymmetricKey, seal } from '../../../src/core/crypto.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { approverRosterFrom, EVERY_RIGHT } from '../../../src/core/vault-approvers.js';
import type { SealedProposal } from '../../../src/core/types.js';
import {
  changeThresholdOnDevice, changeVaultThresholdOnDevice, governOnDevice, type GovernanceDoors, type RoundOnThePage,
} from './governed-call-on-device.js';
import type { GovernanceOnTheWire, GovernedCallOrder, OpenedRound } from './governed-call-builder.js';
import { FiledNotEntered } from './record-entered-here.js';
import { directoryNotYetAnchored } from './vault-page-doors.js';
import { signProposalFiling, type SignedProposalFiling } from '../../../src/core/proposal-filing.js';
import { heldEntering } from '../../../src/testing/record-tree-double.js';
import type { RoundOnChain } from './governed-call-builder.js';
import { RecordWithheld } from './http-sealed-pool-store.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';

/*
 * What each proposal opens as on this device stands in for the company's records here, through the module that opens
 * it; what is opened from real records is the subject of `the-device-proves-what-it-opened.test.ts`.
 */
const seams = vi.hoisted(() => ({ opens: undefined as unknown as (proposalId: string) => Promise<OpenedRound> }));
vi.mock('./round-opened-here.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./round-opened-here.js')>()),
  openTheRoundHere: (_s: unknown, _a: string, proposalId: string) => seams.opens(proposalId),
}));

const ACC = 'acc_1';
const KEY = newSymmetricKey();
const ID = 'aa'.repeat(32);
const SALT = 'cd'.repeat(32);
const VAULT = 'b1'.repeat(32);
const BLINDING = '55'.repeat(32);
const founder = newSigningKeypair();
const SEAT = '41'.repeat(32);
const COMMITTEE = { tag: 'schnorr', value: '7a'.repeat(32) };
/* The state the founding seat signed, which every raise's asset blinding is read from. */
const STATE = signedFoundingState(ACC, {
  keyEpoch: 0, sealed: seal(canonical({ state: {}, blinding: { assetBlinding: BLINDING, payRecordKey: 'ab'.repeat(32) } }), KEY),
}, founder.secret);

const THREE: GovernanceOnTheWire = { kind: 'threshold', threshold: '3' };

/**
 * A device over a service holding `held` - proposals already written down, as
 * this device opens them - and counting approvals as the chain would. `bar` is
 * the account's threshold, as the person's own wallet reads it with no policy
 * bar stored. Every call asked of the service or the builder is written down
 * in `log`.
 */
/** The filing key of a seat of the company's, under no removal, that raised what this file holds as already raised. */
const ANOTHER_SEAT = 'a7'.repeat(32);

const aDevice = (o: {
  /** `served` is the status the service writes for it, whatever the chain holds. */
  held?: Array<{ id: string; opened: OpenedRound; raised?: boolean; count?: number; served?: 'cancelled' }>;
  bar?: number; alreadyApproved?: boolean; refuseAt?: number;
  /** How many times the company's records refuse an entry before they keep one. */
  refuseEntries?: number;
  /** Proposals the company's records name, entered by the founding seat, whether or not the service lists them. */
  named?: readonly string[];
  /** How many versions of the company's directory are filed and not yet anchored; none unless a test says. */
  waiting?: number;
  /** Whether this device may anchor the company's records itself, which anchors every version waiting. */
  anchors?: boolean;
  /** The versions among those waiting that the directory's replay refused. */
  refused?: readonly number[];
  /** The approvals the account requires now; one unless a test says. */
  approvals?: number;
} = {}) => {
  const log: string[] = [];
  let waiting = o.waiting ?? 0;
  const rounds = new Map<string, RoundOnThePage & { opened: OpenedRound }>();
  /* Each proposal as it was written down, signed by the seat that wrote it: what the company serves back. */
  const filings = new Map<string, SignedProposalFiling>();
  let refusals = o.refuseEntries ?? 0;
  for (const h of o.held ?? []) {
    rounds.set(h.id, { id: h.id, chainId: h.opened.chainId, status: h.served ?? 'open', approvalCount: h.count ?? 0, opened: h.opened,
      ...(h.raised ? { raisedAt: 'then' } : {}) });
  }
  const page = (id: string): RoundOnThePage => { const { opened: _o, ...r } = rounds.get(id)!; return r; };
  let checks = 0;
  /* Each proposal whose entry the company's records keep. */
  const entered = new Set<string>();
  /*
   * As a device opens a proposal from the company's records: one this device wrote down whose entry was never kept is
   * refused, as the real opener refuses a proposal no entry names (`judgeIn`, round-opened-here.ts).
   */
  seams.opens = async (id) => {
    if (filings.has(id) && !entered.has(id)) throw new Error('no entry in the company\'s records names it');
    /* Who raised it, as the opener believes it: the seat that signed its filing, or another seat of the company's. */
    return { filedBy: filings.get(id)?.filedBy.publicKey ?? ANOTHER_SEAT, ...rounds.get(id)!.opened };
  };
  const doors: GovernanceDoors = {
    service: {
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
      sealedProposals: async () => [...rounds.values()].map((r) => ({
        ...(filings.get(r.id) ?? { createdAt: '2026-10-01' }),
        id: r.id, accountId: ACC, status: r.status, chainId: r.chainId, approvalCount: r.approvalCount ?? 0,
        ...(r.raisedAt ? { raisedAt: r.raisedAt } : {}),
      }) as unknown as SealedProposal),
      file: async (_acc, body) => {
        log.push(`file ${body.proposal.chainId === ID ? 'ID' : body.proposal.chainId}`);
        filings.set(body.proposal.id, body.proposal);
        rounds.set(body.proposal.id, { id: body.proposal.id, chainId: body.proposal.chainId, status: 'open', approvalCount: 0, raisedAt: 'now',
          opened: { chainId: ID, digest: '', vault: '', salt: SALT, summary: '', governance: THREE } });
        return page(body.proposal.id);
      },
      send: async (id) => { log.push(`send ${id}`); rounds.set(id, { ...rounds.get(id)!, raisedAt: 'now' }); return page(id); },
      approve: async (id) => {
        log.push(`approve ${id}`);
        const r = rounds.get(id)!;
        rounds.set(id, { ...r, approvalCount: (r.approvalCount ?? 0) + 1 });
        return page(id);
      },
      standing: async (id) => page(id),
      carry: async (id, body) => { log.push(`carry ${id} ${body.circuit}`); rounds.set(id, { ...rounds.get(id)!, status: 'executed' }); return page(id); },
    },
    builder: {
      governedCall: async ({ order }) => {
        log.push(`build ${describe_(order)}`);
        if (order.circuit === 'approve' && o.alreadyApproved) {
          throw Object.assign(new Error('you have already approved this proposal'), { name: 'CallNotBuilt' });
        }
        return { tx: `TX-${order.circuit}` };
      },
      proposalIdentity: async () => ({ digest: 'dd'.repeat(32), chainId: ID, noVault: '00'.repeat(32) }),
    },
    material: { signingSecret: founder.secret, blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: ACC,
    records: {
      directory: async () => {
        const believed = {
          /* The directory's versions past the newest the anchor holds, which holds none: each one filed and not yet anchored. */
          dir: { company: ACC, version: waiting, seats: [{ seat: SEAT, person: 'ada', signingKey: founder.publicKey, wrappingKey: 'ab'.repeat(32), committeeKey: COMMITTEE, role: 'admin' as const, retired: null }] },
          holders: {
            committee: [COMMITTEE], seats: [SEAT], approvals: o.approvals ?? o.bar ?? 1, vaultThresholds: [], policyBar: null,
            seatBar: o.approvals ?? o.bar ?? 1, adoptedVaults: [], account: 'ac'.repeat(32),
          },
          another: new Set<string>(),
          refusedAt: new Set(o.refused ?? []),
        };
        return {
          ...believed,
          records: await heldEntering(ACC, (o.named ?? []).map((id) => ({
            entry: { store: 'proposal' as const, kind: 'proposal', id, version: 1, digest: 'ab'.repeat(32) }, signingSecret: founder.secret,
          })), { seat: SEAT, signingSecret: founder.secret, records: [STATE], committee: [COMMITTEE] }, believed as never),
        } as never;
      },
      people: async () => { throw new Error('no person here'); },
      state: async (id) => (id === '0' ? STATE : null),
      runs: async () => [],
      roundIdentity: pureCircuits,
      payments: { paidOnceOf: () => { throw new Error('no payment here'); }, paidMovementOf: () => { throw new Error('no payment here'); }, read: async () => { throw new Error('no payment here'); } },
      policy: async () => { throw new Error('no payroll here'); },
      /* The test's chain, as the person's own wallet reads it: a round this double sent is held, with the approvals it counted, until carried out. */
      roundsOnChain: async (ids) => Object.fromEntries(ids.map((id) => {
        const r = [...rounds.values()].find((x) => x.chainId.toLowerCase() === id.toLowerCase());
        const round: RoundOnChain = r?.raisedAt === undefined ? { held: 'never', approvals: 0 }
          : r.status === 'executed' ? { held: 'closed', approvals: 0, raisedAt: 1, txRef: id, closedBy: ['setThreshold'] }
            : { held: 'open', approvals: r.approvalCount ?? 0, raisedAt: 1, txRef: id };
        return [id.toLowerCase(), round];
      })),
    },
    filing: {
      seat: SEAT, keyEpoch: 0, salt: () => SALT, newId: () => 'prp_newproposal1',
      /* The one filing call, as the log reads it: which record, at which version. */
      entered: {
        enter: async (filed) => {
          if (refusals > 0) {
            refusals -= 1;
            log.push('entry refused');
            throw new FiledNotEntered('the service could not read the chain');
          }
          for (const f of filed) if ('id' in f && f.store === 'proposal') entered.add(f.id);
          log.push(`entered ${filed.map((f) => ('id' in f ? `${f.store} ${f.id} ${f.version}` : f.store)).join(',')}`);
        },
      },
    },
    approvers: async () => {
      checks += 1;
      log.push(`vault check ${checks}`);
      if (o.refuseAt === checks) {
        /* A company where the change asked for would leave its company-wide runs short. */
        return approverRosterFrom({ threshold: 1, vaultThresholds: [], seated: [{ leaf: 'e1', rights: EVERY_RIGHT }], adoptedVaults: [], companyWide: 'cc'.repeat(32) });
      }
      return approverRosterFrom({ threshold: 1, vaultThresholds: [], seated: [1, 2, 3, 4].map((n) => ({ leaf: `e${n}` })), adoptedVaults: [], companyWide: 'cc'.repeat(32) });
    },
    vaultName: () => 'company-wide runs',
    sleep: async () => {}, waitMs: 3, everyMs: 1,
    ...(o.anchors ? { anchorDirectory: async () => { log.push('anchor the records'); waiting = 0; } } : {}),
  };
  return { doors, log, rounds, filings, entered };
};
/* What each call was built for, short enough to read in a list. */
function describe_(order: GovernedCallOrder): string {
  const o = order as Record<string, unknown>;
  if (order.circuit === 'propose') return `propose ${JSON.stringify(o.governance)} salt=${(o.half as { proposalSalt: string }).proposalSalt === SALT ? 'SALT' : 'other'} blinding=${(o.half as { assetBlinding: string }).assetBlinding === BLINDING ? 'founding' : 'other'}`;
  if (order.circuit === 'approve') return `approve of=${JSON.stringify(o.of)}`;
  return `${order.circuit} ${JSON.stringify({ ...o, circuit: undefined, proposal: o.proposal === ID ? 'ID' : o.proposal })}`;
}

describe('A GOVERNANCE CHANGE, FROM THIS DEVICE', () => {
  it('writes a new proposal down, raises it with the founding state\'s blinding, approves it bound to its change and salt, and carries it out', async () => {
    const d = aDevice();
    const out = await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 });
    expect(out.state).toBe('done');
    /* RED WHEN: the order changes, a call is built for another change or salt, or the vault is not checked before each step. */
    expect(d.log).toEqual([
      'vault check 1',
      `build propose {"kind":"threshold","threshold":"3"} salt=SALT blinding=founding`,
      'file ID',
      /* RED WHEN: a proposal written down from a device is not entered in the company's records once the service has it. */
      'entered proposal prp_newproposal1 1',
      'vault check 2',
      `build approve of={"governance":{"kind":"threshold","threshold":"3"},"proposalSalt":"${SALT}"}`,
      'approve prp_newproposal1',
      'vault check 3',
      `build setThreshold {"threshold":"3","proposal":"ID","proposalSalt":"${SALT}"}`,
      'carry prp_newproposal1 setThreshold',
    ]);
  });

  it('A PROPOSAL THE COMPANY\'S RECORDS NAME AND THE SERVICE LEAVES OUT OF ITS LIST: NOTHING IS WRITTEN DOWN OR RAISED, AND IT IS SAID AS WITHHELD', async () => {
    const d = aDevice({ named: ['prp_heldbutgone1'] });
    /* RED WHEN: the change's proposal the service withholds is read as none held, and a second proposal is written down for it. */
    await expect(changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 })).rejects.toBeInstanceOf(RecordWithheld);
    expect(d.log.filter((l) => !l.startsWith('vault check'))).toEqual([]);
  });

  it('A PROPOSAL ALREADY HELD FOR THIS CHANGE IS USED, AND ONE HELD FOR ANOTHER CHANGE IS LEFT ALONE', async () => {
    const other: OpenedRound = { chainId: 'ef'.repeat(32), digest: '', vault: '', salt: 'ee'.repeat(32), summary: '', governance: { kind: 'threshold', threshold: '2' } };
    const same: OpenedRound = { chainId: ID, digest: '', vault: '', salt: SALT, summary: '', governance: THREE };
    const d = aDevice({ held: [{ id: 'prp_other', opened: other, raised: true }, { id: 'prp_same', opened: same }], bar: 2 });
    const out = await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 });
    /* RED WHEN: a device files a second proposal beside the one the company holds for the same change, or approves another change. */
    expect(out.state).toBe('waiting-for-approvals');
    expect(d.log.filter((l) => !l.startsWith('vault check'))).toEqual([
      `build propose {"kind":"threshold","threshold":"3"} salt=SALT blinding=founding`, 'send prp_same',
      `build approve of={"governance":{"kind":"threshold","threshold":"3"},"proposalSalt":"${SALT}"}`, 'approve prp_same',
    ]);
  });

  it('A PROPOSAL THE CHAIN HOLDS FOR THIS CHANGE IS USED THOUGH THE SERVICE WRITES IT WITHDRAWN', async () => {
    const same: OpenedRound = { chainId: ID, digest: '', vault: '', salt: SALT, summary: '', governance: THREE };
    const d = aDevice({ held: [{ id: 'prp_same', opened: same, raised: true, count: 1, served: 'cancelled' }], bar: 3 });
    await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 });
    /* RED WHEN: where the proposal stands is read from the service's plain fields - a second proposal is written down beside the live one. */
    expect(d.log.filter((l) => !l.startsWith('vault check'))).toEqual([
      `build approve of={"governance":{"kind":"threshold","threshold":"3"},"proposalSalt":"${SALT}"}`, 'approve prp_same',
    ]);
  });

  it('A PROPOSAL STILL SHORT OF APPROVALS IS LEFT FOR THE OTHERS, AND ONE THIS SIGNER APPROVED ALREADY IS NOT APPROVED AGAIN', async () => {
    const same: OpenedRound = { chainId: ID, digest: '', vault: '', salt: SALT, summary: '', governance: THREE };
    const short = aDevice({ held: [{ id: 'prp_same', opened: same, raised: true, count: 1 }], bar: 3, alreadyApproved: true });
    /* RED WHEN: "you have already approved this" is said as a failure, or a proposal short of approvals is carried out. */
    expect((await changeThresholdOnDevice(short.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 })).state).toBe('waiting-for-approvals');
    expect(short.log.filter((l) => /^(approve|carry|send|file)/u.test(l))).toEqual([]);
    /* And one the chain counts enough approvals for is carried out without another. */
    const met = aDevice({ held: [{ id: 'prp_same', opened: same, raised: true, count: 2 }], bar: 2 });
    expect((await changeThresholdOnDevice(met.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 })).state).toBe('done');
    expect(met.log.filter((l) => /^(approve|carry)/u.test(l))).toEqual(['carry prp_same setThreshold']);
  });

  it('A VAULT\'S THRESHOLD IS CARRIED OUT BY THE CALL THAT CHANGES THAT VAULT, MADE FROM THE PROPOSAL AS THIS DEVICE OPENED IT', async () => {
    const change: GovernanceOnTheWire = { kind: 'vault-threshold', vault: VAULT, threshold: '2' };
    const held: OpenedRound = { chainId: ID, digest: '', vault: '', salt: SALT, summary: '', governance: change };
    const d = aDevice({ held: [{ id: 'prp_v', opened: held, raised: true, count: 1 }] });
    expect((await changeVaultThresholdOnDevice(d.doors, { viewingKey: KEY, vault: VAULT, newThreshold: 2, seated: 4 })).state).toBe('done');
    /* RED WHEN: an approved vault threshold cannot be carried out from a device, or is carried out for another vault or number. */
    expect(d.log.filter((l) => /^(build|carry)/u.test(l))).toEqual([
      `build setVaultThreshold {"vault":"${VAULT}","threshold":"2","proposal":"ID","proposalSalt":"${SALT}"}`, 'carry prp_v setVaultThreshold',
    ]);
    /* A vault's approvals are refused before anything is asked when no seated signers could give them. */
    await expect(changeVaultThresholdOnDevice(aDevice().doors, { viewingKey: KEY, vault: VAULT, newThreshold: 5, seated: 4 }))
      .rejects.toThrow(/cannot need more approvals than the 4 signers/u);
  });

  it('A PROPOSAL WHOSE ENTRY IS REFUSED ONCE: THE PERSON IS TOLD TO MAKE THE CHANGE AGAIN, AND THE SECOND ATTEMPT ENTERS IT AND RAISES NOTHING TWICE', async () => {
    const d = aDevice({ refuseEntries: 1 });
    const said = await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 }).then(() => null, (e: unknown) => e);
    /* RED WHEN: the person is told to reload and do it again in words that do not say the proposal is already raised, or what enters it. */
    expect(said).toBeInstanceOf(FiledNotEntered);
    expect((said as Error).message).toMatch(/The proposal is written down and raised\. Make this change again from this page: this device finds the proposal it wrote down and enters it, and nothing is raised twice\./u);
    expect(d.log.filter((l) => /^(file|entry|entered)/u.test(l))).toEqual(['file ID', 'entry refused']);
    d.log.length = 0;
    const out = await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 });
    expect(out.state).toBe('done');
    /* RED WHEN: a second attempt resumes the proposal without entering it - it is never anchored, and no other device believes it. */
    expect(d.log.filter((l) => !l.startsWith('vault check') && !l.startsWith('build'))).toEqual([
      'entered proposal prp_newproposal1 1', 'approve prp_newproposal1', 'carry prp_newproposal1 setThreshold',
    ]);
  });

  it('AN ENTRY REFUSED AGAIN ON THE SECOND ATTEMPT IS SAID AGAIN, AND NOTHING IS WRITTEN DOWN OR RAISED A SECOND TIME', async () => {
    const d = aDevice({ refuseEntries: 2 });
    await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 }).catch(() => undefined);
    d.log.length = 0;
    const said = await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 }).then(() => null, (e: unknown) => e);
    /* RED WHEN: a proposal this device cannot open because its entry is still not kept is passed over, and a second one is written down and raised. */
    expect(d.log.filter((l) => /^(file|send|entry|entered)/u.test(l))).toEqual(['entry refused']);
    expect((said as Error).message).toMatch(/Make this change again from this page/u);
  });

  it('A PROPOSAL ANOTHER SEAT WROTE DOWN IS NOT ENTERED FROM THIS DEVICE: IT IS ITS OWN FILER\'S TO ENTER', async () => {
    const same: OpenedRound = { chainId: ID, digest: '', vault: '', salt: SALT, summary: '', governance: THREE };
    const d = aDevice({ held: [{ id: 'prp_same', opened: same, raised: true }] });
    /* Bo's device wrote it down, signed by Bo's seat. */
    d.filings.set('prp_same', signProposalFiling(ACC, {
      id: 'prp_same', digest: 'dd'.repeat(32) as never, chainId: ID as never, keyEpoch: 0, createdAt: '2026-10-01', sealed: { iv: '', tag: '', body: '' },
    }, newSigningKeypair().secret));
    /* And entered by Bo's device. */
    d.entered.add('prp_same');
    expect((await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 })).state).toBe('done');
    /* RED WHEN: a device enters a proposal it did not file - the service refuses it, and the change stops on a refusal it cannot fix. */
    expect(d.log.filter((l) => l.startsWith('entered'))).toEqual([]);
  });

  it('A PROPOSAL ANOTHER SEAT WROTE DOWN AND NEVER ENTERED IS NOT ENTERED FROM THIS DEVICE EITHER, THOUGH IT CANNOT BE OPENED', async () => {
    const same: OpenedRound = { chainId: ID, digest: '', vault: '', salt: SALT, summary: '', governance: THREE };
    const d = aDevice({ held: [{ id: 'prp_sameBoSeat01', opened: same, raised: true }] });
    d.filings.set('prp_sameBoSeat01', signProposalFiling(ACC, {
      id: 'prp_sameBoSeat01', digest: 'dd'.repeat(32) as never, chainId: ID as never, keyEpoch: 0, createdAt: '2026-10-01', sealed: { iv: '', tag: '', body: '' },
    }, newSigningKeypair().secret));
    await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 }).catch(() => undefined);
    /* RED WHEN: a device enters a proposal another seat filed because it could not open it - the anchor would vouch for what the service made up. */
    expect(d.log.filter((l) => l.includes('prp_sameBoSeat01') && l.startsWith('entered'))).toEqual([]);
  });

  it('THE VAULT CHECK AND THE CALLER\'S OWN CHECK ARE MADE AGAIN BEFORE THE APPROVAL AND BEFORE THE CARRYING OUT, AND EITHER STOPS IT', async () => {
    /* The company as it stands when this device comes to approve: the change would now leave a vault short. */
    const atApproval = aDevice({ refuseAt: 2 });
    await expect(changeThresholdOnDevice(atApproval.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 })).rejects.toThrow(/unable to pay/u);
    /* RED WHEN: an approval goes out on the vault check made when the proposal was written down. */
    expect(atApproval.log.filter((l) => /^(approve|carry)/u.test(l))).toEqual([]);
    const atCarry = aDevice({ refuseAt: 3 });
    await expect(changeThresholdOnDevice(atCarry.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 })).rejects.toThrow(/unable to pay/u);
    /* RED WHEN: the carrying out goes out on the check made before the approval. */
    expect(atCarry.log.filter((l) => /^carry/u.test(l))).toEqual([]);
    /* The caller's own check - a seat's, that the person waiting is still the one asked for - is asked at each step too. */
    const asked: string[] = [];
    let n = 0;
    const d = aDevice();
    await expect(governOnDevice(d.doors, {
      viewingKey: KEY, change: THREE, summary: 'three', body: { newThreshold: 3 },
      before: async () => { n += 1; asked.push(`before ${n}`); if (n === 3) throw new Error('the person waiting changed'); },
    })).rejects.toThrow('the person waiting changed');
    /* RED WHEN: the caller's check is skipped before the carrying out. */
    expect(asked).toEqual(['before 1', 'before 2', 'before 3']);
    expect(d.log.filter((l) => /^carry/u.test(l))).toEqual([]);
  });
});

describe('A RISE OF THE ACCOUNT\'S THRESHOLD AND THE COMPANY\'S DIRECTORY', () => {
  it('A RISE IS REFUSED, WITH NOTHING BUILT, WHILE A DIRECTORY CHANGE IS FILED AND NOT YET ANCHORED', async () => {
    const d = aDevice({ waiting: 1 });
    /* RED WHEN: the threshold rises while a directory change waits for the anchor, which would then count it at the higher threshold. */
    await expect(changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 }))
      .rejects.toThrow(/version 1 of the company's directory is filed and not yet anchored/u);
    expect(d.log.filter((l) => l.startsWith('build'))).toEqual([]);
  });

  it('A DEVICE THAT MAY ANCHOR ANCHORS THE WAITING CHANGES FIRST, THEN RAISES; A LOWER THRESHOLD WAITS FOR NOTHING', async () => {
    const d = aDevice({ waiting: 2, anchors: true });
    expect((await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 })).state).toBe('done');
    /* RED WHEN: the device raises without anchoring what waits first. */
    expect(d.log.slice(0, 3)).toEqual(['vault check 1', 'anchor the records', `build propose {"kind":"threshold","threshold":"3"} salt=SALT blinding=founding`]);
    const same = aDevice({ waiting: 1 });
    /* RED WHEN: a threshold that does not rise is held back by the directory. */
    expect((await changeThresholdOnDevice(same.doors, { viewingKey: KEY, newThreshold: 1, seated: 4 })).state).toBe('done');
    const lower = aDevice({ waiting: 1, approvals: 3 });
    /* RED WHEN: a threshold lowered from three to two is held back by a directory change waiting for the anchor. It is raised and
     * approved here, and waits for the others: the account's threshold of three, as the wallet reads it, carries it out. */
    expect((await changeThresholdOnDevice(lower.doors, { viewingKey: KEY, newThreshold: 2, seated: 4 })).state).toBe('waiting-for-approvals');
    expect(lower.log).not.toContain('anchor the records');
  });

  it('VERSIONS THE DIRECTORY REFUSED HOLD NO RISE BACK, SO A SERVICE FILING THEM CANNOT KEEP THE THRESHOLD WHERE IT IS', async () => {
    const d = aDevice({ waiting: 2, refused: [1, 2] });
    /* RED WHEN: a version the replay refused is counted as waiting for the anchor. */
    expect((await changeThresholdOnDevice(d.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 })).state).toBe('done');
    const one = aDevice({ waiting: 2, refused: [1] });
    await expect(changeThresholdOnDevice(one.doors, { viewingKey: KEY, newThreshold: 3, seated: 4 }))
      .rejects.toThrow(/version 2 of the company's directory is filed and not yet anchored/u);
  });

  it('WHAT WAITS FOR THE ANCHOR IS EVERY APPLIED VERSION ABOVE THE NEWEST ANCHORED, NEVER ONE PASSED OVER BELOW IT', () => {
    const anchoredAt = (versions: number[]) => ({ directory: new Map(versions.map((v) => [v, { digest: 'ab'.repeat(32) }])) }) as never;
    /* RED WHEN: how many versions the anchor holds is taken for the newest it holds, so version 2, passed over, is waited for. */
    expect(directoryNotYetAnchored({ dir: { version: 4 } as never, records: anchoredAt([1, 3]) })).toEqual([4]);
    expect(directoryNotYetAnchored({ dir: { version: 4 } as never, records: anchoredAt([1, 3]), refusedAt: new Set([4]) })).toEqual([]);
    expect(directoryNotYetAnchored({ dir: { version: 2 } as never, records: anchoredAt([]) })).toEqual([1, 2]);
  });
});
