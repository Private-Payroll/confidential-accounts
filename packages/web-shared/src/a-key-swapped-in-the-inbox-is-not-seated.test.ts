/**
 * **A KEY PUT IN THE COMPANY'S INBOX BY ANYBODY BUT THE INVITED PERSON IS
 * REFUSED BY EVERY SIGNER'S DEVICE, BY NAME, BEFORE ANYTHING IS PROVED.**
 *
 * A person waiting for a seat is read from the company's inbox, and the inbox
 * is sealed to a public key: whoever can write to the store can seal a new
 * entry to it without holding the viewing key. What is written here is exactly
 * that writer: it holds the stored record and nothing else, replaces what the
 * invited person sent, and every reading a device makes of the seat - to raise
 * it, to approve it, to carry it out - is asked what it does with it.
 *
 * The honest entry is read first, through the same doors, so a refusal below is
 * a refusal of the swap and not of every seat.
 */
import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLedger } from '../../../src/core/ledger.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';
import { FileStore } from '../../../src/core/store-file.js';
import { AccountService, approvalMessage } from '../../../src/core/account.js';
import { newBlinding, newSigningKeypair, newWrappingKeypair, sign, unwrapKey, type Hex } from '../../../src/core/crypto.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import { sealToInbox } from '../../../src/core/sealed-records.js';
import { storedSignerLeaf } from '../../../src/core/signer-leaf.js';
import { newSeatInvitation, proveSeatKeys, SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import type { PendingSignerPayload } from '../../../src/core/types.js';
import type { GovernedCallOrder, OpenedRound } from './governed-call-builder.js';
import {
  approveOnDevice, openTheRoundHere, seatSignerOnDevice, type GovernedCallDoors, type GovernedCallService,
} from './governed-call-on-device.js';

const scope = MidnightCommitments.allVaults();
const keysOf = () => {
  const s = newSigningKeypair();
  const w = newWrappingKeypair();
  return {
    signingPublicKey: s.publicKey, wrappingPublicKey: w.publicKey,
    leafCommitment: storedSignerLeaf({ signingSecret: s.secret, blinding: newBlinding(), scope }, MidnightCommitments),
  };
};

const ledger = new SimulatedLedger(MidnightCommitments);
const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-swapped-')), 'db.json'));
const accounts = new AccountService(store, ledger, MidnightCommitments);
/* Two signers, so two devices each read the seat for themselves. */
const created = await accounts.create('Swapped', [{ name: 'Ada', role: 'admin' }, { name: 'Bo', role: 'approver' }], 1, undefined, drawCompanyLabel());
const company = created.account.id;
const viewingKey = created.viewingKey;
const [ada, bo] = created.secrets as [typeof created.secrets[0], typeof created.secrets[0]];

/* Dana is invited, and accepts on her own device with the proof her link let it make. */
const invite = accounts.inviteSigner(company, 'Dana', 'dana@swapped.example', 'approver');
const dana = keysOf();
const danaProof = proveSeatKeys(newSeatInvitation(viewingKey, company, 'Dana', 'approver'), dana);
const waiting = accounts.acceptSignerInvite(invite.token, 'usr_dana', dana.signingPublicKey, dana.wrappingPublicKey,
  dana.leafCommitment, danaProof);
const seatRound = await accounts.seatRound(company, viewingKey, waiting.id, ada.signerId);
const honestRecord = structuredClone(store.getAccount(company)!);

/** A writer with the stored record and nothing else: it seals a new entry to the inbox's public key. */
const swapInTheInbox = (payload: Partial<PendingSignerPayload>) => {
  const rec = structuredClone(honestRecord);
  const box = rec.pendingSigners.find((p) => p.id === waiting.id)!;
  box.sealed = sealToInbox({ name: 'Dana', role: 'approver', ...payload }, rec.inboxPublicKey);
  store.putAccount(rec);
};
const putBack = () => store.putAccount(structuredClone(honestRecord));

const service = (built: unknown[] = []): GovernedCallService => ({
  sealedProposals: async (id: string) => store.listProposals(id),
  sealedAccount: async (id: string) => store.getAccount(id),
  /* Open when the approval is asked for, approved once one has been built and sent. */
  standing: async () => ({ id: seatRound.id, chainId: seatRound.chainId, status: built.length ? 'approved' : 'open' }),
  callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
  approve: async () => ({ id: seatRound.id, chainId: seatRound.chainId, status: 'approved' }),
} as unknown as GovernedCallService);

/** One signer's device. Whatever it builds - and so proves - is written down. */
const aDevice = (built: Array<{ order: GovernedCallOrder; opened: OpenedRound }>): GovernedCallDoors => ({
  service: service(built),
  builder: { governedCall: async ({ order, opened }) => { built.push({ order, opened }); return { tx: 'TX' }; } },
  material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
  accountId: company, sleep: async () => {}, waitMs: 2, everyMs: 1,
});
const shown = { id: seatRound.id, chainId: seatRound.chainId, status: 'open', summary: seatRound.summary };

/** Every reading of the seat a device makes: to raise it, to approve it, to carry it out. */
const everyReading = async (signerId: string) => {
  const built: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
  const outcomes = await Promise.allSettled([
    openTheRoundHere(service(), company, seatRound.id, viewingKey, true),
    openTheRoundHere(service(), company, seatRound.id, viewingKey, false),
    approveOnDevice(aDevice(built), { round: shown, signerId, signature: 'SIG', viewingKey }),
  ]);
  return { outcomes, built };
};

describe('A KEY THAT DID NOT COME FROM THE INVITED PERSON IS NOT SEATED', () => {
  it('the honest entry is read by every device, and its leaf is the one Dana sent', async () => {
    putBack();
    for (const signer of [ada, bo]) {
      const { outcomes, built } = await everyReading(signer.signerId);
      /* RED WHEN: the check refuses an honest invitation - nobody could then be seated at all. */
      expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      expect((outcomes[0] as PromiseFulfilledResult<OpenedRound>).value.governance)
        .toEqual({ kind: 'add-signer', leaf: dana.leafCommitment });
      expect(built).toHaveLength(1);
    }
  });

  it.each([
    ['keys of the writer\'s own, with no proof', () => ({ ...keysOf() })],
    ['keys of the writer\'s own, beside the proof Dana made', () => ({ ...keysOf(), seatProof: danaProof })],
    ['Dana\'s signing key and leaf, with the writer\'s own wrapping key', () => ({
      ...dana, wrappingPublicKey: newWrappingKeypair().publicKey, seatProof: danaProof })],
    ['Dana\'s own keys and proof, with her role raised to admin', () => ({ ...dana, role: 'admin' as const, seatProof: danaProof })],
    ['Dana\'s signing key, wrapping key and proof, with the writer\'s own leaf', () => ({
      ...dana, leafCommitment: keysOf().leafCommitment, seatProof: danaProof })],
    ['the writer\'s own signing key beside Dana\'s wrapping key, leaf and proof', () => ({
      ...dana, signingPublicKey: keysOf().signingPublicKey, seatProof: danaProof })],
    ['Dana\'s own keys and proof, under another name', () => ({ ...dana, name: 'Mallory', seatProof: danaProof })],
    ['Dana\'s own keys and proof, with the nonce of another invitation', () => ({
      ...dana, seatProof: { nonce: newSeatInvitation(viewingKey, company, 'Dana', 'approver').nonce, proof: danaProof.proof } })],
    ['keys with a proof made under a key the writer chose', () => {
      const k = keysOf();
      return { ...k, seatProof: proveSeatKeys(newSeatInvitation('ab'.repeat(32), company, 'Dana', 'approver'), k) };
    }],
  ] as Array<[string, () => Partial<PendingSignerPayload>]>)('%s: refused on every device, by name, and nothing is proved', async (_what, swapped) => {
    swapInTheInbox(swapped());
    try {
      for (const signer of [ada, bo]) {
        const { outcomes, built } = await everyReading(signer.signerId);
        /* RED WHEN: any reading of the seat takes a key the invited person's link did not prove. */
        for (const o of outcomes) {
          expect(o.status).toBe('rejected');
          expect((o as PromiseRejectedResult).reason).toBeInstanceOf(SeatKeyNotFromTheInvitee);
          expect((o as PromiseRejectedResult).reason.name).toBe('SeatKeyNotFromTheInvitee');
        }
        /* RED WHEN: the refusal comes after a call was built - the swapped key would then have been proved. */
        expect(built).toEqual([]);
      }
    } finally {
      putBack();
    }
  });

  it('a device that raises the seat, and a device that carries it out, each refuse the swapped key before building', async () => {
    const swapped = keysOf();
    swapInTheInbox(swapped);
    try {
      const salt = accounts.governanceAsked(seatRound.id, viewingKey).proposalSalt;
      const asked = { governance: { kind: 'add-signer' as const, leaf: swapped.leafCommitment }, proposalSalt: salt };
      const half = { assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: salt, changeAmount: '0',
        changeBatchDigest: '77'.repeat(32) };
      const toRaise = {
        proposal: { id: seatRound.id, chainId: seatRound.chainId, status: 'open', approvals: [] }, asked,
        order: { proposalId: seatRound.id, chainId: seatRound.chainId,
          order: { circuit: 'propose', governance: asked.governance, half, proposal: seatRound.chainId } },
      };
      const toCarry = {
        proposal: { id: seatRound.id, chainId: seatRound.chainId, status: 'approved', approvals: [{ signerId: ada.signerId }] },
        asked, order: null,
      };
      for (const [what, round] of [['raise', toRaise], ['carry out', toCarry]] as const) {
        const built: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
        const doors = aDevice(built);
        Object.assign(doors.service, {
          seatRound: async () => round,
          seatOrder: async () => ({ order: { circuit: 'amendSigner', leaf: swapped.leafCommitment, proposal: seatRound.chainId,
            proposalSalt: salt } }),
          sendGovernance: async () => { throw new Error('a raise was sent'); },
          seat: async () => { throw new Error('a seat was sent'); },
        });
        const out = seatSignerOnDevice(doors, {
          viewingKey, signerId: ada.signerId, sign: () => 'SIG', seat: { signerId: waiting.id, leaf: swapped.leafCommitment } });
        /* RED WHEN: the device that raises, or the one that carries out, builds before it has checked the key. */
        await expect(out, what).rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
        expect(built, what).toEqual([]);
      }
    } finally {
      putBack();
    }
  });

  it('a copy of an honest entry beside it is refused: one person\'s keys are not two seats', async () => {
    const rec = structuredClone(honestRecord);
    const original = rec.pendingSigners.find((p) => p.id === waiting.id)!;
    rec.pendingSigners.push({ ...original, id: 'sgn_copy', userId: 'usr_copy' });
    store.putAccount(rec);
    try {
      /* RED WHEN: the same keys waiting twice are each read as a person to seat. */
      await expect(openTheRoundHere(service(), company, seatRound.id, viewingKey, true))
        .rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    } finally {
      putBack();
    }
  });
});

/* ── AND THE RECORD: WHAT IS WRITTEN DOWN WHEN THE SEAT IS, AFTER EVERY DEVICE HAS LOOKED ── */

/**
 * A second company, where each test swaps the inbox AFTER the devices would
 * have checked it, just before the service writes the seat down and wraps the
 * viewing key to the wrapping key it finds. The writer is the same one: the
 * stored record and nothing else.
 */
const recorded = async () => {
  const made = await accounts.create('Recorded', [{ name: 'Ada', role: 'admin' }], 1, undefined, drawCompanyLabel());
  const at = made.account.id;
  const adaHere = made.secrets[0]!;
  const adaRef = { signerId: adaHere.signerId, leaf: made.account.signers[0]!.leafCommitment as Hex };
  const accept = (name: string) => {
    const s = newSigningKeypair();
    const w = newWrappingKeypair();
    const keys = {
      signingPublicKey: s.publicKey, wrappingPublicKey: w.publicKey,
      leafCommitment: storedSignerLeaf({ signingSecret: s.secret, blinding: newBlinding(), scope }, MidnightCommitments),
    };
    const inv = accounts.inviteSigner(at, name, `${name}@recorded.example`, 'approver');
    const seat = accounts.acceptSignerInvite(inv.token, `usr_${name}`, keys.signingPublicKey, keys.wrappingPublicKey,
      keys.leafCommitment, proveSeatKeys(newSeatInvitation(made.viewingKey, at, name, 'approver'), keys));
    return { ...keys, wrappingSecret: w.secret, id: seat.id };
  };
  const dana = accept('Dana');
  const eve = accept('Eve');
  const honest = structuredClone(store.getAccount(at)!);
  /** Dana's box, replaced: by a new entry sealed to the public key, or by a copy of Eve's box as it stands. */
  const swap = (payload: Partial<PendingSignerPayload> | 'eve') => {
    const rec = structuredClone(honest);
    const box = rec.pendingSigners.find((p) => p.id === dana.id)!;
    box.sealed = payload === 'eve'
      ? structuredClone(rec.pendingSigners.find((p) => p.id === eve.id)!.sealed)
      : sealToInbox({ name: 'Dana', role: 'approver', ...payload }, rec.inboxPublicKey);
    store.putAccount(rec);
  };
  const restore = () => store.putAccount(structuredClone(honest));
  const wrapped = () => store.getAccount(at)!.wrappedKeys.length;
  return { made, at, adaHere, adaRef, dana, eve, swap, restore, wrapped };
};

const swapsKeepingDanasLeaf = (dana: { leafCommitment: Hex }) => [
  ['the writer\'s own keys with Dana\'s leaf and no proof', {
    ...keysOf(), leafCommitment: dana.leafCommitment }],
  ['the writer\'s own wrapping key beside Dana\'s signing key, leaf and proof', 'keep-proof'],
] as const;

describe('THE SERVICE WRITES DOWN ONLY THE KEYS THE INVITED PERSON PROVED', () => {
  it('a grant on an approved round refuses a key swapped in after the approvals, and wraps the viewing key to nobody', async () => {
    const r = await recorded();
    const round = await accounts.proposeSigner(r.at, r.made.viewingKey, r.dana.id, r.adaHere.signerId);
    await accounts.approve(round.id, r.adaHere.signerId, sign(approvalMessage(round), r.adaHere.signingSecret), r.made.viewingKey);
    const before = r.wrapped();
    for (const [what, payload] of swapsKeepingDanasLeaf(r.dana)) {
      r.swap(payload === 'keep-proof'
        ? { signingPublicKey: r.dana.signingPublicKey, wrappingPublicKey: newWrappingKeypair().publicKey,
          leafCommitment: r.dana.leafCommitment,
          seatProof: proveSeatKeys(newSeatInvitation(r.made.viewingKey, r.at, 'Dana', 'approver'), r.dana) }
        : payload);
      /* RED WHEN: the record's half of a seat trusts the inbox - the viewing key is then wrapped to the writer. */
      await expect(accounts.grantAccess(r.at, r.made.viewingKey, r.dana.id), what).rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
      expect(r.wrapped(), what).toBe(before);
    }
    r.restore();
    /* The honest entry is then written down, and its wrapped key opens with Dana's own secret. */
    const done = await accounts.grantAccess(r.at, r.made.viewingKey, r.dana.id);
    const hers = done.wrappedKeys.find((k) => k.signerId === r.dana.id)!;
    /* RED WHEN: the check refuses an honest grant. */
    expect(unwrapKey(hers, r.dana.wrappingSecret)).toBe(r.made.viewingKey);
  });

  /** Dana's seat raised on the record and approved on the simulated chain, as devices would have left it. */
  const approvedOnTheChain = async (r: Awaited<ReturnType<typeof recorded>>) => {
    const p = await accounts.seatRound(r.at, r.made.viewingKey, r.dana.id, r.adaHere.signerId);
    const salt = accounts.seatOrderOf(r.at, r.made.viewingKey, r.dana.id).proposalSalt;
    await ledger.propose(r.at, MidnightCommitments.signerAddPayload(r.dana.leafCommitment),
      { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt }, r.adaRef, MidnightCommitments.noVault());
    await ledger.approve(r.at, p.chainId as Hex, r.adaRef);
    return p;
  };

  it('a seat the chain already holds is written down only for the keys proved for it', async () => {
    const r = await recorded();
    const p = await approvedOnTheChain(r);
    /* The chain seats Dana's leaf; the record has not been written yet. */
    await ledger.addSigner(r.at, r.dana.leafCommitment, p.chainId as Hex, r.adaRef);
    const before = r.wrapped();
    r.swap({ ...keysOf(), leafCommitment: r.dana.leafCommitment });
    /* RED WHEN: a seat the chain holds is written down for keys nobody proved. */
    await expect(accounts.seatRound(r.at, r.made.viewingKey, r.dana.id, r.adaHere.signerId))
      .rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    expect(r.wrapped()).toBe(before);
    r.restore();
    /* The proposal was closed when the chain was seen to carry it, so this answers that the seat is now written down. */
    await expect(accounts.seatRound(r.at, r.made.viewingKey, r.dana.id, r.adaHere.signerId))
      .rejects.toThrow(/now written on the company's record/u);
    const hers = store.getAccount(r.at)!.wrappedKeys.find((k) => k.signerId === r.dana.id)!;
    /* RED WHEN: the honest seat the chain holds is not written down. */
    expect(unwrapKey(hers, r.dana.wrappingSecret)).toBe(r.made.viewingKey);
  });

  it('a copy of a proved entry beside it, under another id, is not written down as a second seat', async () => {
    const r = await recorded();
    const p = await approvedOnTheChain(r);
    await ledger.addSigner(r.at, r.dana.leafCommitment, p.chainId as Hex, r.adaRef);
    /* Dana's own entry, copied beside itself under an id and a sign-in the writer chose. */
    const rec = structuredClone(store.getAccount(r.at)!);
    const hersBox = rec.pendingSigners.find((x) => x.id === r.dana.id)!;
    rec.pendingSigners.push({ ...structuredClone(hersBox), id: 'sgn_copy', userId: 'usr_copy' });
    store.putAccount(rec);
    const before = r.wrapped();
    /* RED WHEN: the service writes down the copy, and one person's keys hold two seats on the record. */
    await expect(accounts.seatRound(r.at, r.made.viewingKey, 'sgn_copy', r.adaHere.signerId))
      .rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    expect(r.wrapped()).toBe(before);
    expect(store.getAccount(r.at)!.memberUserIds).not.toContain('usr_copy');
  });

  it('another person\'s proved keys, swapped in while the seat is on its way, are not written down against Dana\'s leaf', async () => {
    const r = await recorded();
    const p = await approvedOnTheChain(r);
    /* The device's call reaches the chain, which seats Dana's leaf; while it is on its way the inbox is swapped. */
    Object.assign(ledger, {
      submitProvenCall: async (accountId: string, bytes: Uint8Array) => {
        const call = JSON.parse(Buffer.from(bytes).toString('utf8')) as { leaf: Hex; proposal: Hex };
        await ledger.addSigner(accountId, call.leaf, call.proposal, r.adaRef);
        r.swap('eve');
        return { ref: 'tx', at: new Date().toISOString() };
      },
    });
    const before = r.wrapped();
    const tx = new Uint8Array(Buffer.from(JSON.stringify({ leaf: r.dana.leafCommitment, proposal: p.chainId })));
    /* RED WHEN: the record writes down whoever is in the box once the chain answers, rather than the person it seated. */
    await expect(accounts.seatFromDevice(r.at, r.made.viewingKey, r.dana.id, tx, r.adaHere.signerId))
      .rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    expect(r.wrapped()).toBe(before);
  });
});

