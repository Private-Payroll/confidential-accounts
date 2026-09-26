/**
 * **A SIGNER'S DEVICE PROVES WHAT IT READ ITSELF.**
 *
 * Two halves. The builder, with the contract's pure functions stood in for by
 * hashes, is handed a record the device read and an order the service sent,
 * and every value that differs is refused by name before anything is built.
 * And the page's reading of the company's own records, run over records a real
 * `AccountService` wrote, with the viewing key, and nothing the service says
 * about them taken on trust. The one value the device takes from the service,
 * the account's asset blinding, is pinned as exactly that.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGovernedCall, NotWhatThisDeviceOpened, RecordDoesNotAddUp, refuseWhatThisDeviceDidNotOpen,
  type GovernedCallDeps, type GovernedCallOrder, type GovernanceOnTheWire, type OpenedRound,
} from './governed-call-builder.js';
import {
  approveOnDevice, NotOpenedOnThisDevice, openTheRoundHere, type GovernedCallDoors, type GovernedCallService,
} from './governed-call-on-device.js';
import { SimulatedLedger } from '../core/ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { FileStore } from '../core/store-file.js';
import { AccountService } from '../core/account.js';
import { newSigningKeypair, newWrappingKeypair, newBlinding, type Hex } from '../core/crypto.js';
import { storedSignerLeaf } from '../core/signer-leaf.js';
import { sealedProposalFor } from '../testing/sealed-records.js';

/* ── the builder, over stand-ins for the contract's pure functions ─────────── */

const sha = (...parts: Array<Uint8Array | bigint>) => Uint8Array.from(createHash('sha256')
  .update(Buffer.concat(parts.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : Buffer.from(p.toString()))))).digest());
const accountPure = {
  runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint) => sha(root, payees, opensAt, closesAt),
  proposalIdOf: (payload: Uint8Array, vault: Uint8Array, salt: Uint8Array) => sha(payload, vault, salt),
  signerAddPayload: (leaf: Uint8Array) => sha(Buffer.from('seat'), leaf),
  setThresholdPayload: (t: bigint) => sha(Buffer.from('threshold'), t),
  noVault: () => new Uint8Array(32).fill(0xfe),
};
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ACCOUNT = 'c0'.repeat(32);
const material = { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) };
const chain = { accountState: new Uint8Array([1]), parameters: new Uint8Array([2]) };

const SALT = '66'.repeat(32);
const LEAF = 'ab'.repeat(32);
const run = { root: '88'.repeat(32), payees: '3', opensAt: '100', closesAt: '200', vault: '99'.repeat(32) };
const half = { assetId: '44'.repeat(32), changeAmount: '30000', changeBatchDigest: '77'.repeat(32) };
const BLINDING = '55'.repeat(32);
const record = (digest: Uint8Array, vault: Uint8Array, salt = SALT) => ({
  chainId: hex(accountPure.proposalIdOf(digest, vault, bytes(salt))), digest: hex(digest), vault: hex(vault), salt, summary: 'the round',
});
const payloadOf = (g: GovernanceOnTheWire) => (g.kind === 'add-signer'
  ? accountPure.signerAddPayload(bytes(g.leaf)) : accountPure.setThresholdPayload(BigInt(g.threshold)));

const seat = { kind: 'add-signer', leaf: LEAF } as const;
const three = { kind: 'threshold', threshold: '3' } as const;
/* What the device opened: the company's own records of a run, a seat and a threshold change. */
const RUN: OpenedRound = {
  ...record(accountPure.runPayload(bytes(run.root), 3n, 100n, 200n), bytes(run.vault)), half,
};
const SEAT: OpenedRound = { ...record(payloadOf(seat), accountPure.noVault()), governance: seat, half: { ...half, changeAmount: '0' } };
const THREE: OpenedRound = { ...record(payloadOf(three), accountPure.noVault()), governance: three, half: { ...half, changeAmount: '0' } };

/* And what an honest service hands over for each. */
const raiseRun: GovernedCallOrder = { circuit: 'propose', run, half: { ...half, assetBlinding: BLINDING, proposalSalt: SALT }, proposal: RUN.chainId };
const approveRun: GovernedCallOrder = { circuit: 'approve', proposal: RUN.chainId };
const raiseSeat: GovernedCallOrder = {
  circuit: 'propose', governance: seat, half: { ...half, assetBlinding: BLINDING, changeAmount: '0', proposalSalt: SALT }, proposal: SEAT.chainId,
};
const approveSeat: GovernedCallOrder = { circuit: 'approve', proposal: SEAT.chainId, of: { governance: seat, proposalSalt: SALT } };
const seatIt: GovernedCallOrder = { circuit: 'amendSigner', leaf: LEAF, proposal: SEAT.chainId, proposalSalt: SALT };
const setIt: GovernedCallOrder = { circuit: 'setThreshold', threshold: '3', proposal: THREE.chainId, proposalSalt: SALT };

const depsWith = (log: string[]): GovernedCallDeps => ({
  ledger: {
    ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk', clear: () => {} }) },
    ZswapChainState: class { },
    LedgerParameters: { deserialize: (b: Uint8Array) => ({ parameters: [...b] }) },
  },
  runtimeState: { deserialize: (b: Uint8Array) => ({ state: [...b] }) },
  contracts: {
    createUnprovenCallTxFromInitialStates: async (_zk: unknown, options: any) => {
      log.push(`built ${options.circuitId}`);
      const r = options.initialPrivateState;
      if (options.circuitId === 'propose') log.push(`with blinding ${Buffer.from(r.assetBlinding).toString('hex').slice(0, 4)} salt ${Buffer.from(r.proposalSalt).toString('hex').slice(0, 4)}`);
      return { private: { nextPrivateState: options.initialPrivateState, unprovenTx: 'U' } };
    },
  },
  accountCompiled: 'COMPILED', accountZkConfig: 'ZK', accountPure,
  prove: async () => { log.push('proved'); return { serialize: () => new Uint8Array([9]) }; },
  random: (n) => new Uint8Array(n).fill(7),
});

const OTHER = 'ee'.repeat(32);
/* What each value is called in the sentence the person reads. */
const SAYS: Record<string, string> = {
  'proposal identity': 'proposal', salt: 'proposal', vault: 'proposal', leaf: 'person being given access',
  threshold: 'number of approvals required', run: 'payroll run', 'run vault': 'account this run pays from',
  asset: 'currency', amount: 'amount', 'payments digest': 'list of payments',
};
const noHalf = (o: OpenedRound): OpenedRound => { const { half: _h, ...r } = o; return r; };

describe('THE BUILDER PROVES ONLY WHAT THIS DEVICE READ', () => {
  it('4. an honest service is built for every call a device makes: raise, approve, seat and threshold', async () => {
    for (const [order, opened] of [
      [raiseRun, RUN], [approveRun, noHalf(RUN)], [raiseSeat, SEAT], [approveSeat, noHalf(SEAT)], [seatIt, noHalf(SEAT)],
      [setIt, noHalf(THREE)],
    ] as Array<[GovernedCallOrder, OpenedRound]>) {
      const log: string[] = [];
      /* RED WHEN: the check refuses a call whose every value is the company's own - an honest company then cannot act. */
      await buildGovernedCall(depsWith(log), { account: ACCOUNT, order, material, chain, opened });
      expect(log.filter((l) => !l.startsWith('with')), order.circuit).toEqual([`built ${order.circuit}`, 'proved']);
    }
  });

  it('A RAISE IS PROVED WITH THE SALT READ HERE AND THE BLINDING THE SERVICE SENT, AND NO OTHER', async () => {
    const log: string[] = [];
    await buildGovernedCall(depsWith(log), { account: ACCOUNT, order: raiseRun, material, chain, opened: RUN });
    /* RED WHEN: the blinding stops being the service's, or the salt stops being the sealed one - either is then undocumented. */
    expect(log).toContain('with blinding 5555 salt 6666');
  });

  it.each([
    ['proposal identity', 'approve', { ...approveRun, proposal: OTHER }, noHalf(RUN)],
    ['proposal identity', 'amendSigner', { ...seatIt, proposal: OTHER }, noHalf(SEAT)],
    ['salt', 'propose', { ...raiseRun, half: { ...raiseRun.half, proposalSalt: OTHER } }, RUN],
    ['salt', 'amendSigner', { ...seatIt, proposalSalt: OTHER }, noHalf(SEAT)],
    ['salt', 'setThreshold', { ...setIt, proposalSalt: OTHER }, noHalf(THREE)],
    ['salt', 'approve', { ...approveSeat, of: { governance: seat, proposalSalt: OTHER } }, noHalf(SEAT)],
    ['leaf', 'amendSigner', { ...seatIt, leaf: OTHER }, noHalf(SEAT)],
    ['leaf', 'approve', { ...approveSeat, of: { governance: { kind: 'add-signer', leaf: OTHER }, proposalSalt: SALT } }, noHalf(SEAT)],
    ['leaf', 'propose', { ...raiseSeat, governance: { kind: 'add-signer', leaf: OTHER } }, SEAT],
    /* A seat record naming a leaf its own payload is not for, and a service agreeing with it. */
    ['leaf', 'amendSigner', { ...seatIt, leaf: OTHER }, { ...noHalf(SEAT), governance: { kind: 'add-signer', leaf: OTHER } }],
    /* A seat record whose identity is made with a vault, which no governance round names. */
    ['vault', 'amendSigner', { ...seatIt, proposal: record(payloadOf(seat), bytes(OTHER)).chainId },
      { ...record(payloadOf(seat), bytes(OTHER)), governance: seat }],
    /* A payroll record handed over as a seat, to carry out and to approve. */
    ['leaf', 'amendSigner', { ...seatIt, proposal: RUN.chainId }, noHalf(RUN)],
    ['leaf', 'approve', { ...approveSeat, proposal: RUN.chainId }, noHalf(RUN)],
    ['threshold', 'setThreshold', { ...setIt, threshold: '2' }, noHalf(THREE)],
    ['run', 'propose', { ...raiseRun, run: { ...run, root: OTHER } }, RUN],
    ['run vault', 'propose', { ...raiseRun, run: { ...run, vault: OTHER } }, RUN],
    ['asset', 'propose', { ...raiseRun, half: { ...raiseRun.half, assetId: OTHER } }, RUN],
    ['amount', 'propose', { ...raiseRun, half: { ...raiseRun.half, changeAmount: '30001' } }, RUN],
    ['payments digest', 'propose', { ...raiseRun, half: { ...raiseRun.half, changeBatchDigest: OTHER } }, RUN],
  ] as Array<[string, string, GovernedCallOrder, OpenedRound]>)(
    '2. the %s the service sent for %s is refused by name, before anything is built', async (value, circuit, order, opened) => {
      const log: string[] = [];
      const refused = await buildGovernedCall(depsWith(log), { account: ACCOUNT, order, material, chain, opened }).catch((e) => e);
      /* RED WHEN: this value reaches a proof without being the one the company's own records hold, or is refused unnamed. */
      expect(refused).toBeInstanceOf(NotWhatThisDeviceOpened);
      expect(refused.value).toBe(value);
      expect(refused.message).toMatch(new RegExp(`^the ${SAYS[value]} the service sent to this device does not match the `
        + 'company\'s own record of this proposal, which this device read itself\\. Nothing was built or sent\\.', 'u'));
      expect(log).toEqual([]);
    });

  it.each([
    [approveRun, noHalf(RUN), 'do not approve it'],
    [raiseRun, RUN, 'do not send it'],
    [seatIt, noHalf(SEAT), 'do not grant this access'],
    [setIt, noHalf(THREE), 'do not make this change'],
  ] as Array<[GovernedCallOrder, OpenedRound, string]>)('a record whose own parts do not make its identity is refused as not adding up (%#)', async (order, opened, words) => {
    const log: string[] = [];
    const refused = await buildGovernedCall(depsWith(log), {
      account: ACCOUNT, order, material, chain, opened: { ...opened, salt: OTHER },
    }).catch((e) => e);
    /* RED WHEN: a record that disagrees with itself is proved, or blamed on a value the service sent, or says the wrong thing not to do. */
    expect(refused).toBeInstanceOf(RecordDoesNotAddUp);
    expect(refused.message).toMatch(new RegExp(`^the company's record of this proposal does not add up, so this device will not act on it\\. `
      + `Nothing was built or sent\\. Reload the page and try again\\. If it happens again, ${words}\\.$`, 'u'));
    expect(log).toEqual([]);
  });

  it('the refusal says what not to do for the call it refused', async () => {
    for (const [order, opened, words] of [
      [{ ...approveRun, proposal: OTHER }, noHalf(RUN), 'do not approve it'],
      [{ ...raiseRun, half: { ...raiseRun.half, proposalSalt: OTHER } }, RUN, 'do not send it'],
      [{ ...seatIt, leaf: OTHER }, noHalf(SEAT), 'do not grant this access'],
      [{ ...setIt, threshold: '2' }, noHalf(THREE), 'do not make this change'],
    ] as Array<[GovernedCallOrder, OpenedRound, string]>) {
      const refused = await buildGovernedCall(depsWith([]), { account: ACCOUNT, order, material, chain, opened }).catch((e) => e);
      /* RED WHEN: a person carrying out a seat is told not to approve something they are not approving. */
      expect(refused.message, order.circuit).toMatch(new RegExp(`If it happens again, ${words}\\.$`, 'u'));
    }
  });

  it('A CALL WITH NOTHING READ ON THIS DEVICE IS NOT BUILT, AND A RAISE WITHOUT THE CHANGE SEALED IN ITS RECORD IS NOT EITHER', async () => {
    const log: string[] = [];
    /* RED WHEN: a device builds a call it has not checked against the company's own records. */
    await expect(buildGovernedCall(depsWith(log), { account: ACCOUNT, order: approveRun, material, chain, opened: undefined as never }))
      .rejects.toThrow(/could not read the company's record of this proposal/u);
    await expect(buildGovernedCall(depsWith(log), { account: ACCOUNT, order: raiseRun, material, chain, opened: noHalf(RUN) }))
      .rejects.toThrow(/could not read the change sealed in the company's record/u);
    expect(log).toEqual([]);
  });

  it('THE CHECK ITSELF IS THE BUILDER\'S, SO A STAND-IN BUILDER CAN ASK IT', () => {
    expect(() => refuseWhatThisDeviceDidNotOpen({ accountPure }, seatIt, SEAT)).not.toThrow();
    expect(() => refuseWhatThisDeviceDidNotOpen({ accountPure }, { ...seatIt, proposalSalt: OTHER }, SEAT)).toThrow(NotWhatThisDeviceOpened);
  });
});

/* ── the page's reading, over records a real service wrote ─────────────────── */

const ledger = new SimulatedLedger(MidnightCommitments);
const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-opened-')), 'db.json'));
const accounts = new AccountService(store, ledger, MidnightCommitments);
const created = await accounts.create('Opened', [{ name: 'Ada', role: 'admin' }, { name: 'Bo', role: 'approver' }], 1);
const company = created.account.id;
const viewingKey = created.viewingKey;
const ada = created.secrets[0]!;
const late = { ...newSigningKeypair(), wrapping: newWrappingKeypair(), blinding: newBlinding() };
const lateLeaf = storedSignerLeaf({ signingSecret: late.secret, blinding: late.blinding, scope: MidnightCommitments.allVaults() }, MidnightCommitments);
const invite = accounts.inviteSigner(company, 'Late', 'late@opened.example', 'approver');
const lateSeat = accounts.acceptSignerInvite(invite.token, 'usr_late', late.publicKey, late.wrapping.publicKey, lateLeaf);
const seatRound = await accounts.seatRound(company, viewingKey, lateSeat.id, ada.signerId);
const thresholdRound = await accounts.thresholdRound(company, viewingKey, 2, ada.signerId);

/** The company's records, served as they are stored - the service a device reads them through - with any extra given. */
const honest = (extra: ReturnType<typeof sealedProposalFor>[] = []): GovernedCallService => ({
  sealedProposals: async (id: string) => [...store.listProposals(id), ...extra],
  sealedAccount: async (id: string) => accounts.require(id),
} as unknown as GovernedCallService);
const aRecord = (id: string, over: Partial<Parameters<typeof sealedProposalFor>[2]> = {}, forCompany = company) =>
  sealedProposalFor(forCompany, viewingKey, { id, chainId: 'cc'.repeat(32), salt: SALT, ...over });

describe('THE PAGE READS THE COMPANY\'S OWN RECORDS WITH THE VIEWING KEY', () => {
  it('1. a seat for a person accepted after the company was created is read here: the salt sealed in it, their leaf, and the change it commits to', async () => {
    const opened = await openTheRoundHere(honest(), company, seatRound.id, viewingKey, true);
    const asked = accounts.governanceAsked(seatRound.id, viewingKey);
    const served = (await accounts.governanceOrderOf(seatRound.id, viewingKey)).half;
    /* RED WHEN: any of these is not the company's own - the device then proves a value it did not read. */
    expect(opened.chainId).toBe(seatRound.chainId);
    expect(opened.salt).toBe(asked.proposalSalt);
    expect(opened.governance).toEqual({ kind: 'add-signer', leaf: lateLeaf });
    expect(opened.vault).toBe(MidnightCommitments.noVault());
    expect(opened.summary).toBe(seatRound.summary);
    /* The whole account half but the blinding, as the service reads it for a raise, read here from the sealed change. */
    const { assetBlinding: _b, proposalSalt: _s, ...rest } = served;
    expect(opened.half).toEqual(rest);
    /* The same identity the contract's own function makes from what was read. */
    expect(MidnightCommitments.proposalId(opened.digest as Hex, opened.salt as Hex, opened.vault as Hex)).toBe(opened.chainId);
    /* An approval reads no account half. */
    expect((await openTheRoundHere(honest(), company, seatRound.id, viewingKey, false)).half).toBeUndefined();
  });

  it('a threshold change is read with the threshold it sets', async () => {
    const opened = await openTheRoundHere(honest(), company, thresholdRound.id, viewingKey, false);
    /* RED WHEN: the threshold is read from anywhere but the proposal's own sealed payload. */
    expect(opened.governance).toEqual({ kind: 'threshold', threshold: '2' });
    expect(opened.salt).toBe(accounts.governanceAsked(thresholdRound.id, viewingKey).proposalSalt);
  });

  it.each([
    ['a kind this page does not act on', 'prp_x', [aRecord('prp_x', { kind: 'remove-signer', payload: { __change: undefined, signerId: 's' } })],
      /none of those, so it cannot be approved from this device yet\. Leave it unapproved\./u],
    ['a record with no salt sealed in it', 'prp_x', [aRecord('prp_x', { payload: { __change: undefined } })],
      /record is incomplete, so this device cannot check it\. Withdraw the proposal and raise it again\./u],
    ['a seat for somebody not on the roster', 'prp_x', [aRecord('prp_x', { kind: 'add-signer', payload: { signerId: 'sgn_nobody' } })],
      /not on the company's list of signers\. Withdraw this proposal, then grant access again\./u],
    ['a threshold change that names no threshold', 'prp_x', [aRecord('prp_x', { kind: 'set-threshold' })],
      /does not say how many approvals it requires/u],
    ['a record another company wrote, in this company\'s list', 'prp_x', [aRecord('prp_x', {}, 'acc_other')],
      /hold no proposal by that name/u],
    ['a record nobody wrote', 'prp_nobody', [], /hold no proposal by that name/u],
  ] as Array<[string, string, ReturnType<typeof sealedProposalFor>[], RegExp]>)(
    'is not built from: %s', async (_what, id, extra, says) => {
      const refused = await openTheRoundHere(honest(extra), company, id, viewingKey, false).catch((e) => e);
      /* RED WHEN: a device falls back to the service's word, or proves from a record it could not check. */
      expect(refused).toBeInstanceOf(NotOpenedOnThisDevice);
      expect(refused.message).toMatch(says);
      expect(refused.message).toMatch(/Nothing was built or sent\.$/u);
    });

  it('is not built from a record this company\'s key does not open, or when the page cannot read the records at all', async () => {
    await expect(openTheRoundHere(honest(), company, seatRound.id, 'ab'.repeat(32), false))
      .rejects.toThrow(/^This device cannot read the company's record of this proposal/u);
    await expect(openTheRoundHere({ ...honest(), sealedProposals: undefined } as GovernedCallService, company, seatRound.id, viewingKey, false))
      .rejects.toThrow(/^This page cannot read the company's records/u);
    await expect(openTheRoundHere({ ...honest(), sealedAccount: undefined } as GovernedCallService, company, seatRound.id, viewingKey, false))
      .rejects.toThrow(/^This page cannot read the company's list of signers/u);
  });
});

describe('3. WHAT THE PERSON IS SHOWN AND WHAT THE DEVICE PROVES COME FROM THE SAME RECORD', () => {
  const doorsOver = (built: Array<{ order: GovernedCallOrder; opened: OpenedRound }>): GovernedCallDoors => ({
    service: {
      ...honest(),
      /* Open when the approval is asked for, approved once it is sent. */
      standing: async () => ({ id: seatRound.id, chainId: seatRound.chainId, status: built.length ? 'approved' : 'open' }),
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
      approve: async () => ({ id: seatRound.id, chainId: seatRound.chainId, status: 'approved' }),
    } as unknown as GovernedCallService,
    builder: { governedCall: async ({ order, opened }) => { built.push({ order, opened }); return { tx: 'TX' }; } },
    material, accountId: company, sleep: async () => {}, waitMs: 2, everyMs: 1,
  });
  const shown = { id: seatRound.id, chainId: seatRound.chainId, status: 'open', summary: seatRound.summary };

  it('the approval is proved for the identity of the record read here, and that record says what the page showed', async () => {
    const built: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
    await approveOnDevice(doorsOver(built), { round: shown, signerId: ada.signerId, signature: 'SIG', viewingKey });
    expect(built).toHaveLength(1);
    /* RED WHEN: the identity proved, or the summary shown, is anything but the one record's this device read. */
    expect(built[0]!.order).toEqual({ circuit: 'approve', proposal: built[0]!.opened.chainId });
    expect(built[0]!.opened.summary).toBe(shown.summary);
  });

  it.each([
    ['another summary', { summary: 'Pay the contractor' }, /says something different from what this page shows/u],
    ['another identity', { chainId: 'ee'.repeat(32) }, /does not match the proposal on this page/u],
  ] as Array<[string, object, RegExp]>)('a page that showed %s than the record this device reads is not built', async (_what, over, says) => {
    const built: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
    const round = { ...shown, ...over };
    const doors = doorsOver(built);
    /* The service's own answer agrees with the page, so only the record read here can catch it. */
    (doors.service as any).standing = async () => round;
    /* RED WHEN: a device approves a record other than the one whose words the person read. */
    await expect(approveOnDevice(doors, { round, signerId: ada.signerId, signature: 'SIG', viewingKey })).rejects.toThrow(says);
    expect(built).toEqual([]);
  });
});
