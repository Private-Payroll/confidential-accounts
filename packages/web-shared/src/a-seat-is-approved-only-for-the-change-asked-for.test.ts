/**
 * **A DEVICE RAISES, APPROVES AND CARRIES OUT A GOVERNANCE CHANGE ONLY FOR THE
 * CHANGE THE PERSON ASKED FOR.** The page's own module, `governOnDevice`, over
 * a service that answers what a test tells it to and a builder that writes
 * down every call it is asked for. The builder's own check that an approval's
 * proposal is the one its change and salt make is in `governed-call-builder.test.ts`;
 * the whole flow over the served routes is in
 * `src/server/a-company-seats-its-signers-from-a-device.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { canonical, newSigningKeypair, newSymmetricKey, seal } from '../../../src/core/crypto.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { approverRosterFrom, EVERY_RIGHT } from '../../../src/core/vault-approvers.js';
import type { SealedProposal } from '../../../src/core/types.js';
import {
  changeThresholdOnDevice, changeVaultThresholdOnDevice, governOnDevice, type GovernanceDoors, type RoundOnThePage,
} from './governed-call-on-device.js';
import type { GovernanceOnTheWire, GovernedCallOrder, OpenedRound } from './governed-call-builder.js';

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
 * the account's threshold. Every call asked of the service or the builder is
 * written down in `log`.
 */
const aDevice = (o: {
  held?: Array<{ id: string; opened: OpenedRound; raised?: boolean; count?: number }>;
  bar?: number; alreadyApproved?: boolean; refuseAt?: number;
} = {}) => {
  const log: string[] = [];
  const rounds = new Map<string, RoundOnThePage & { opened: OpenedRound }>();
  for (const h of o.held ?? []) {
    rounds.set(h.id, { id: h.id, chainId: h.opened.chainId, status: 'open', approvalCount: h.count ?? 0, opened: h.opened,
      ...(h.raised ? { raisedAt: 'then' } : {}) });
  }
  const page = (id: string): RoundOnThePage => { const { opened: _o, ...r } = rounds.get(id)!; return r; };
  let checks = 0;
  const doors: GovernanceDoors = {
    service: {
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
      sealedProposals: async () => [...rounds.values()].map((r) => ({
        id: r.id, accountId: ACC, status: r.status, chainId: r.chainId, approvalCount: r.approvalCount ?? 0, createdAt: '2026-10-01',
        ...(r.raisedAt ? { raisedAt: r.raisedAt } : {}),
      }) as unknown as SealedProposal),
      file: async (_acc, body) => {
        log.push(`file ${body.proposal.chainId === ID ? 'ID' : body.proposal.chainId}`);
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
      bars: async () => ({ threshold: o.bar ?? 1, vaultThresholds: [] }),
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
    opens: async (id) => rounds.get(id)!.opened,
    records: {
      directory: async () => ({
        dir: { company: ACC, version: 1, seats: [{ seat: SEAT, person: 'ada', signingKey: founder.publicKey, wrappingKey: 'ab'.repeat(32), committeeKey: COMMITTEE, role: 'admin', retired: null }] },
        holders: { committee: [COMMITTEE], seats: [SEAT], approvals: 1, adoptedVaults: [], founding: SEAT, foundingCommittee: [COMMITTEE], account: 'ac'.repeat(32) },
        another: new Set(),
      }) as never,
      people: async () => { throw new Error('no person here'); },
      state: async (id) => (id === '0' ? STATE : null),
      runs: async () => [],
    },
    filing: { seat: SEAT, keyEpoch: 0, salt: () => SALT, newId: () => 'prp_newproposal1' },
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
  };
  return { doors, log, rounds };
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
      'vault check 2',
      `build approve of={"governance":{"kind":"threshold","threshold":"3"},"proposalSalt":"${SALT}"}`,
      'approve prp_newproposal1',
      'vault check 3',
      `build setThreshold {"threshold":"3","proposal":"ID","proposalSalt":"${SALT}"}`,
      'carry prp_newproposal1 setThreshold',
    ]);
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
