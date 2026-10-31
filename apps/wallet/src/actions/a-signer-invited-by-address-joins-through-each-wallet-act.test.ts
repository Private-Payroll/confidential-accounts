/*
 * A signer invited by address joins through each wallet's own acts, in order, every act taking what the one before it
 * left. The inviting seat's wallet invites by address and raises the proposal; another seat's wallet approves it as
 * the page shows it; the invitee's wallet takes the seat with its own proof and asks to be admitted; a seat's wallet
 * finishes adding them; the new signer's wallet answers its first records-key ask, carrying the inviting seat's signed
 * entry; and a seat's upkeep gives the new seat each vault's secret, which the new signer opens with their own records
 * key. At the end every wallet's device believes the new signer seated with the role and rights agreed. The company's
 * service is the in-memory one; the chain, the proofs and the wallets' unlocking are stood in.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { x25519 } from '@noble/curves/ed25519.js';
import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { addressFor } from 'midnight-identity';
import { identityFromSecret, newSecret, type Identity } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import type { ActIntent } from 'midnight-identity/profile/request';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import { acceptanceProofOf, invitationIdOf, newInvitationToken, openOffer, type SignerOffer } from '../../../../src/core/invitation.js';
import { fromHex, signingPublicKeyOf, toHex, unwrapKey, wrapKey, type Hex } from '../../../../src/core/crypto.js';
import { seatBlinding } from '../../../../src/core/seat-opening.js';
import { storedSignerLeaf } from '../../../../src/core/signer-leaf.js';
import { addSignerByAddressIn } from '../../../../src/core/proposal-filing.js';
import type { SealedProposal } from '../../../../src/core/types.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { theNetwork } from '../../../../src/midnight/network.js';
import { openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../../src/midnight/company-nonce-secret.js';
import { vaultRecordsRoutes, VAULT_RECORD_BODY_LIMIT } from '../../../../src/server/vault-records-route.js';
import { recordsReaderOf } from '../../../../packages/web-shared/src/deposit-on-device.js';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { InvitedSeatOnTheWire, VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { anchorFunctions, anchorSentInATest } from '../../../../src/testing/record-tree-double.js';
import { pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { acmeChain, acmeReads, ORIGIN, vaultRecords } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, ADDRESS, BO, chains, CO, committeeKeyOfLeaf, companyNow, deviceOf, directoryOf, events, KEY, LABEL, sendAs, store, theChain,
  theInviteeTakesTheSeatHere, type Seat,
} from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import type { CompanyChain } from './company-reach.js';
import { companyKeyOf, companyReachFor, keptReach } from './company-reach.js';
import { StepRefused, type ActionDefinition, type StepContext } from './definition.js';
import { inviteAction } from './invite.js';
import { approveSignerAction } from './approve-signer.js';
import { seatInvitedAction } from './seat-invited.js';
import { admitSignerAction } from './admit-signer.js';
import { giveVaultKeysAction } from './give-vault-keys.js';
import { rebuildDoorsIn, upkeepSteps } from './upkeep.js';

aCompanyWhoseSignersChange();

const NETWORK = theNetwork();
const VAULT = 'fb'.repeat(32);
const VAULTS = [VAULT, 'fc'.repeat(32)] as const;
const ALL = MidnightCommitments.allVaults().toLowerCase() as Hex;
const why = (key: string) => ({ key });

/* ---- the wallets: each person's own keys, their saved keys and the company their wallet pinned ---- */

interface Wallet {
  readonly person: string;
  readonly identity: Identity;
  readonly secret: ReturnType<typeof newSecret>;
  kept: Keyring;
  readonly pins: Map<string, { account: string; created: boolean; from?: 'created' | 'invited' }>;
}
const walletWith = (person: string, fill: number, kept: Keyring = { accounts: {} }): Wallet => {
  const secret = new Uint8Array(32).fill(fill) as ReturnType<typeof newSecret>;
  return { person, identity: identityFromSecret(secret), secret, kept, pins: new Map() };
};
const wrappingPublicKeyOf = (secret: Hex): Hex => toHex(x25519.getPublicKey(fromHex(secret))) as Hex;
/* A seated signer's saved keys for the company, at the seat the company already holds. */
const seatedWallet = (s: Seat, wrappingFill: number): Wallet => walletWith(s.person, s.n, {
  accounts: {
    [CO]: {
      signerId: `sgn_${s.person}`, signingSecret: s.signingSecret as Hex, wrappingSecret: toHex(new Uint8Array(32).fill(wrappingFill)) as Hex,
      blinding: s.opening.blinding as Hex, scope: s.opening.scope as Hex, opening: s.opening as never,
    },
  },
});
const ada = seatedWallet(ADA, 41);
const bo = seatedWallet(BO, 42);
const dee = walletWith('dee', 81);
const DEES_ADDRESS = addressFor(dee.identity.moneyAt(0).zswap, NETWORK as never).bech32;
const DEES_COIN_KEY = String(checkShieldedAddress(DEES_ADDRESS, NETWORK as never).coinPublicKey).toLowerCase() as Hex;
const coinSecretOf = (w: Wallet): Hex => {
  const keys = ZswapSecretKeys.fromSeed(w.identity.moneyAt(0).zswap);
  const raw = keys.coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
  return toHex(raw.slice(raw.length - 32)) as Hex;
};
/* A second person, invited by the raising seat once the company asks one approval to add a signer. */
const eve = walletWith('eve', 82);
const EVES_ADDRESS = addressFor(eve.identity.moneyAt(0).zswap, NETWORK as never).bech32;
const coinKeyOf = (w: Wallet): Hex => String(checkShieldedAddress(addressFor(w.identity.moneyAt(0).zswap, NETWORK as never).bech32, NETWORK as never).coinPublicKey).toLowerCase() as Hex;
/* Dee's own seat n for the company at `scope`, as only her wallet can make it. */
const deesSeat = (n: number, scope: Hex) => {
  const keys = seatKeysFor(dee.identity, LABEL, n);
  const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(dee.identity, LABEL).value).toLowerCase() };
  const signingSecret = toHex(keys.signingSecret).toLowerCase() as Hex;
  const blinding = String(seatBlinding(walletKey, toHex(keys.salt))).toLowerCase() as Hex;
  return { signingSecret, leaf: storedSignerLeaf({ signingSecret, blinding, scope }, MidnightCommitments).toLowerCase() as Hex, walletKey };
};

/* ---- the chain, as the company's other tests stand it in, read through the wallet's own reach ---- */

const chain: CompanyChain = {
  holders: async () => ({ ...(await acmeReads.holders()), adoptedVaults: [...VAULTS] }) as never,
  callState: async () => ({ blockHash: 'b', accountState: acmeChain.head(), parameters: 'PP' }),
  roles: async (_a, _l, keys) => keys.map((key) => ({ key, value: null })) as never,
  indexer: { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' },
};

/*
 * What the invitee's proof hands the chain, checked as the account checks it: the proof is made with the coin key of
 * the address the wallet holds; the proposal is the one the invitation's address, rights and salt make; and the seat
 * is the one its material makes at those rights. The chain then seats the wallet whose coin key it is.
 */
const { identityOfAChange } = await import('../../../../packages/web-shared/src/governed-call-builder.js');
const seatsProved: InvitedSeatOnTheWire[] = [];
const seatProofOf = async (input: InvitedSeatOnTheWire): Promise<string> => {
  seatsProved.push(input);
  const invitee = [dee, eve].find((w) => coinSecretOf(w).toLowerCase() === input.invite.coinSecretKey.toLowerCase());
  if (invitee === undefined) throw new Error('the proof was built with a coin key the address does not hold');
  const address = MidnightCommitments.inviteAddressOf(coinKeyOf(invitee), input.invite.addressSalt as Hex).toLowerCase();
  const scope = input.material.scope.toLowerCase();
  const made = identityOfAChange({ accountPure: pureCircuits as never }, { kind: 'add-signer', address, scope } as never, input.proposalSalt);
  if (String(made.chainId).toLowerCase() !== input.proposal.toLowerCase()) throw new Error('the proposal named is not the one this address, rights and salt make');
  const leaf = storedSignerLeaf(input.material as never, MidnightCommitments).toLowerCase();
  committeeKeyOfLeaf.set(leaf, committeeKeyFor(invitee.identity, LABEL) as never);
  return Buffer.from(JSON.stringify({ proposal: input.proposal, address, leaf })).toString('base64');
};

/* The leaf each seated signer's saved keys stand for; any other seat's leaf is the one its own material makes. */
const SEATED = new Map<string, string>([[ADA.signingSecret.toLowerCase(), ADA.seat], [BO.signingSecret.toLowerCase(), BO.seat]]);
const builderOf = (s: Seat | null): VaultBuilderClient => ({
  ...(s === null ? {} : deviceOf(s).builder),
  ...anchorFunctions,
  anchor: anchorSentInATest,
  ownSeat: async (m: { signingSecret: string; blinding: string; scope: string }) =>
    SEATED.get(m.signingSecret.toLowerCase()) ?? storedSignerLeaf(m as never, MidnightCommitments).toLowerCase(),
  anchorsOnChain: async () => acmeChain.read(),
  invitedSeats: async ({ proposals }: { proposals: readonly string[] }) => acmeReads.invitedSeats(proposals),
  roundsOnChain: async ({ chainIds }: { chainIds: readonly string[] }) => theChain(chainIds),
  companyWide: async () => toHex(pureCircuits.companyWide()).toLowerCase(),
  vouchedRunIdentity: async () => null,
  seatInvited: seatProofOf,
}) as unknown as VaultBuilderClient;

/* ---- the page: it carries each ask to the service, and hands a proven transaction to the chain ---- */

let vaultBase = '';
const seatsSent: Array<{ path: string; acceptance: string }> = [];
const callAs = (person: string) => async (method: 'GET' | 'PUT' | 'POST', path: string, body?: string): Promise<{ status: number; body: unknown }> => {
  if (method === 'POST' && /^\/api\/invites\/[^/]+\/seat$/u.test(path)) {
    const { acceptance, tx } = JSON.parse(body!) as { acceptance: string; tx: string };
    seatsSent.push({ path, acceptance });
    const { proposal, address, leaf } = JSON.parse(Buffer.from(tx, 'base64').toString('utf8')) as { proposal: string; address: string; leaf: string };
    try {
      theInviteeTakesTheSeatHere(proposal, address, leaf);
    } catch (e) {
      return { status: 409, body: { error: (e as Error).message } };
    }
    return { status: 200, body: { sent: true } };
  }
  if (method === 'POST' && path === `/api/accounts/${CO}/proven`) {
    const { previous, batch, held, tag } = JSON.parse((JSON.parse(body!) as { tx: string }).tx) as { previous: Hex; batch: Hex; held: never; tag: Hex };
    try {
      acmeChain.move(previous, batch, held, tag);
    } catch (e) {
      return { status: 409, body: { error: (e as Error).message } };
    }
    events.push('anchored');
    return { status: 200, body: {} };
  }
  if (path.startsWith('/api/vaults/')) {
    const r = await fetch(vaultBase + path, {
      method, ...(body === undefined ? {} : { body }), headers: { 'content-type': 'application/json', 'x-test-person': person },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  return sendAs(person)(path, { method, ...(body === undefined ? {} : { body }) } as never);
};

const ctxOf = (w: Wallet, intent: ActIntent, step: number, steps: number, told: Record<string, string | number>): StepContext => ({
  intent, asker: { origin: ORIGIN, name: 'Payroll', rdns: 'example.payroll' }, person: w.person,
  held: {
    identity: w.identity, secret: w.secret, account: 0,
    wallet: {
      drewTheLabel: () => false,
      pinnedFor: (label: string) => w.pins.get(label) ?? null,
      pin: async (label: string, account: string, from?: 'created' | 'invited') => { w.pins.set(label, { account, created: false, from }); },
    },
  },
  at: { step, steps } as never, signal: new AbortController().signal,
  relay: async () => { throw new Error('nothing in joining a signer is relayed by the page'); },
  call: callAs(w.person),
  tell: (o) => { Object.assign(told, o); },
  show: () => {},
  keyring: { open: () => ({ read: () => w.kept }) as never, keep: async (change) => { w.kept = change(w.kept); } },
}) as StepContext;

/* Runs every step of the act as the wallet runs it, one after the other, and gives back what the act told the page. */
const run = async (def: ActionDefinition, w: Wallet, name: string, fields: Record<string, string>): Promise<Record<string, string | number>> => {
  const intent = { name, fields } as unknown as ActIntent;
  const told: Record<string, string | number> = {};
  const refused = await def.check(intent, ctxOf(w, intent, 0, 0, told).held);
  if (refused !== null) throw new Error(`the ${name} act refused before it ran: ${refused.key}`);
  const steps = def.steps(intent);
  for (const [i, s] of steps.entries()) {
    if (s.notNeeded?.(told) === true) continue;
    try {
      await s.run(ctxOf(w, intent, i + 1, steps.length, told));
    } catch (e) {
      if (e instanceof StepRefused) throw new Error(`the ${name} act stopped at step ${i + 1}: ${e.words.key} ${JSON.stringify(e.words.values ?? {})}`);
      throw e;
    }
  }
  return told;
};

const COMMITMENTS = async () => MidnightCommitments as never;
const NO_PAUSE = async () => {};
const ACTS = {
  invite: inviteAction({ chain: () => chain, builder: () => builderOf(ADA), now: () => Date.now(), pause: NO_PAUSE, network: NETWORK as never, commitments: COMMITMENTS, waitMs: 40, everyMs: 1 }),
  approve: approveSignerAction({ chain: () => chain, builder: () => builderOf(BO), pause: NO_PAUSE, commitments: COMMITMENTS, waitMs: 40, everyMs: 1 }),
  seat: seatInvitedAction({
    chain: () => chain, builder: () => builderOf(null), network: NETWORK, commitments: COMMITMENTS, payKeyWrapKeyOf: async () => pureCircuits.payKeyWrapKeyOf as never,
  }),
  admit: admitSignerAction({ chain: () => chain, builder: () => builderOf(BO), pause: NO_PAUSE, commitments: COMMITMENTS }),
  approveByTheRaiser: approveSignerAction({ chain: () => chain, builder: () => builderOf(ADA), pause: NO_PAUSE, commitments: COMMITMENTS, waitMs: 40, everyMs: 1 }),
  admitByTheRaiser: admitSignerAction({ chain: () => chain, builder: () => builderOf(ADA), pause: NO_PAUSE, commitments: COMMITMENTS }),
  give: giveVaultKeysAction({ chain: () => chain, builder: () => builderOf(null), now: () => Date.now() }),
};
const companyFields = { record: CO, company: LABEL, account: ADDRESS as string };

/* The company's key as each wallet derives it for this company, which the records keys its seats attest are made from. */
const companyKeyHeldBy = (w: Wallet): Hex => companyKeyOf({ held: { identity: w.identity, secret: w.secret }, asker: { origin: ORIGIN, name: 'Payroll', rdns: 'example.payroll' } } as never, LABEL, ADDRESS);

let vaultServer: ReturnType<express.Express['listen']>;
beforeAll(async () => {
  /* The service holds the company's viewing key wrapped to each seated signer's saved wrapping key. */
  const account = store.getAccount(CO)!;
  store.putAccount({
    ...account,
    wrappedKeys: [ada, bo].map((w) => ({ signerId: w.kept.accounts[CO]!.signerId, ...wrapKey(KEY, wrappingPublicKeyOf(w.kept.accounts[CO]!.wrappingSecret)) })),
  } as never);
  /* The vault records are the service's own routes over the company's in-memory store. */
  const app = express();
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') (req as { userId?: string }).userId = p; next(); });
  app.use(express.json({ limit: VAULT_RECORD_BODY_LIMIT }));
  app.use(vaultRecordsRoutes({ records: vaultRecords, mayTouch: async (person) => store.getAccount(CO)?.memberUserIds.includes(person) ?? false }));
  await new Promise<void>((resolve) => { vaultServer = app.listen(0, '127.0.0.1', () => resolve()); });
  vaultBase = `http://127.0.0.1:${(vaultServer.address() as AddressInfo).port}`;
  /* Each vault's nonce secret, filed by the inviting seat's wallet and sealed to its own records key alone. */
  const intent = { name: 'invite', fields: companyFields } as unknown as ActIntent;
  const ctx = ctxOf(ada, intent, 1, 1, {});
  const r = await keptReach((c) => companyReachFor(c, chain, builderOf(ADA), why)).at(ctx);
  const doors = rebuildDoorsIn(ctx, r, r.api, r.send, {});
  for (const v of VAULTS) await doors.records('nonce-secret').put(v, startNonceSecret(v, [recordsReaderOf(fromHex(companyKeyHeldBy(ada)))]));
}, 120_000);
afterAll(() => new Promise<void>((resolve) => { vaultServer.close(() => resolve()); }));

const hexOf = (x: string | Uint8Array): string => (typeof x === 'string' ? x : toHex(x)).toLowerCase();
/* The records key a wallet attests for this company: the public half of the key its company key makes. */
const recordsKeyOf = (w: Wallet): string => hexOf(recordsKeypairFrom(fromHex(companyKeyHeldBy(w))).publicKey);

describe('A SIGNER INVITED BY ADDRESS JOINS THROUGH EACH WALLET ACT, EACH TAKING WHAT THE ONE BEFORE IT LEFT', () => {
  const TOKEN = newInvitationToken();
  const ID = invitationIdOf(TOKEN);
  let offer: SignerOffer;
  let inviter: unknown;
  let proposal: SealedProposal;
  let signerId: string;
  let leaf: Hex;

  it('the inviting seat\'s wallet invites a signer by address and raises the proposal its kept invitation names', async () => {
    const told = await run(ACTS.invite, ada, 'invite', { ...companyFields, token: TOKEN, kind: 'signer', personName: 'dee', role: 'approver', address: DEES_ADDRESS });
    expect(told.state).toBe('filed');
    const kept = ada.kept.seatInvitationsKept?.[ID];
    expect(kept).toBeDefined();
    offer = kept!.offer.offer.for as SignerOffer;
    inviter = kept!.offer.offer.inviter;
    proposal = (store.listProposals(CO) as SealedProposal[]).find((p) => String(p.chainId).toLowerCase() === offer.invited.terms.proposal!.toLowerCase())!;
    /* RED WHEN: the proposal raised is not the one the invitation names. */
    expect(proposal).toBeDefined();
    /* RED WHEN: the offer the link opens is not the one the inviting wallet kept. */
    const served = await sendAs(null)(`/api/invites/${ID}/offer`, { method: 'GET' });
    expect(openOffer((served.body as { offer: never }).offer, TOKEN).offer.for).toEqual(offer);
    /* RED WHEN: the invitation commits to an address the invitee's coin key does not make, or names other rights or another role. */
    expect(offer.invited.terms.invite!.address.toLowerCase()).toBe(MidnightCommitments.inviteAddressOf(DEES_COIN_KEY, offer.invited.terms.invite!.salt).toLowerCase());
    expect(offer.invited.terms.invite!.scope.toLowerCase()).toBe(ALL);
    expect(offer.invited.terms.role).toBe('approver');
    /* RED WHEN: the offer carries an inviting entry for another seat than the one that invited. */
    expect((kept!.offer.offer.inviter as { statement: { seat: string } }).statement.seat).toBe(ADA.seat);
    expect(events).toContain('chain propose');
  });

  /* RED WHEN: the raising seat's own approval, which its raise already counted, is sent again or told as given, or refused as the wallet not approving. */
  it('the raising seat\'s own approval is refused as already counted, and nothing is sent', async () => {
    const shown = addSignerByAddressIn(proposal as never, CO, KEY as never)!;
    const before = events.length;
    await expect(run(ACTS.approveByTheRaiser, ada, 'approve-signer', {
      ...companyFields, proposal: proposal.id, personName: 'dee', role: shown.invited.terms.role, address: shown.invited.terms.invite!.address,
      scope: shown.invited.terms.invite!.scope, coinKey: shown.coinPublicKey!,
    })).rejects.toThrow(/the approve-signer act stopped at step 3: act\.approve-signer\.why\.already-counted /u);
    expect(events.slice(before)).not.toContain('chain approve');
  });

  it('another seat\'s wallet approves the proposal as the page reads it from the proposal, and the chain holds the approval', async () => {
    const shown = addSignerByAddressIn(proposal as never, CO, KEY as never)!;
    /* RED WHEN: the proposal carries a coin key other than the one of the address typed, or rights other than the invitation's. */
    expect(shown.coinPublicKey).toBe(DEES_COIN_KEY);
    expect(shown.invited).toEqual(offer.invited);
    const before = events.length;
    const told = await run(ACTS.approve, bo, 'approve-signer', {
      ...companyFields, proposal: proposal.id, personName: 'dee', role: shown.invited.terms.role, address: shown.invited.terms.invite!.address,
      scope: shown.invited.terms.invite!.scope, coinKey: shown.coinPublicKey!,
    });
    expect(told.state).toBe('waiting-for-the-invitee');
    /* RED WHEN: the approving wallet says it approved and the chain holds no approval from it. */
    expect(events.slice(before)).toContain('chain approve');
  });

  it('the invitee\'s wallet takes the seat with its own proof at the proposal its invitation names, and asks to be admitted', async () => {
    await run(ACTS.seat, dee, 'seat-invited', { ...companyFields, token: TOKEN });
    leaf = deesSeat(0, ALL).leaf;
    /* RED WHEN: the proof is built for another proposal, salt, address or seat than the invitation and the raise name. */
    expect(seatsProved.at(-1)).toMatchObject({
      proposal: offer.invited.terms.proposal!.toLowerCase(), proposalSalt: offer.byAddress!.proposalSalt, invite: { addressSalt: offer.invited.terms.invite!.salt },
    });
    expect(storedSignerLeaf(seatsProved.at(-1)!.material as never, MidnightCommitments).toLowerCase()).toBe(leaf);
    /* RED WHEN: the seat is sent with an acceptance the link's token does not make. */
    expect(seatsSent.at(-1)).toEqual({ path: `/api/invites/${ID}/seat`, acceptance: acceptanceProofOf(TOKEN) });
    /* RED WHEN: the chain does not hold the seat at the leaf the wallet's own seat makes, under the proposal. */
    expect(await acmeReads.invitedSeats([offer.invited.terms.proposal!])).toEqual({ [offer.invited.terms.proposal!.toLowerCase()]: leaf });
    const saved = dee.kept.accounts[CO]!;
    signerId = saved.signerId;
    /* RED WHEN: the wallet keeps the seat under an id the service did not give the request, or without the seat, invitation and inviter it joined by. */
    expect(store.getAccount(CO)!.pendingSigners.map((p) => p.id)).toContain(signerId);
    expect(saved).toMatchObject({ seat: 0, invited: offer.invited, scope: ALL });
    expect((saved.invitedBy as { statement: { seat: string } }).statement.seat).toBe(ADA.seat);
    /* RED WHEN: the wallet keeps an inviting entry other than the signed one the invitation's offer carried. */
    expect(saved.invitedBy).toEqual(inviter);
  });

  /* RED WHEN: an approval of a proposal the invitee's seat already carried out is refused as the wallet not approving, with no word that Finish adding is next. */
  it('an approval asked after the invitee took the seat is refused as carried out, and nothing is sent', async () => {
    const shown = addSignerByAddressIn(proposal as never, CO, KEY as never)!;
    const before = events.length;
    await expect(run(ACTS.approveByTheRaiser, ada, 'approve-signer', {
      ...companyFields, proposal: proposal.id, personName: 'dee', role: shown.invited.terms.role, address: shown.invited.terms.invite!.address,
      scope: shown.invited.terms.invite!.scope, coinKey: shown.coinPublicKey!,
    })).rejects.toThrow(/the approve-signer act stopped at step 3: act\.approve-signer\.why\.carried-out /u);
    expect(events.length).toBe(before);
  });

  it('a seat\'s wallet finishes adding the signer at the seat the chain holds, with the role and coin key the proposal carries', async () => {
    const told = await run(ACTS.admit, bo, 'admit-signer', { ...companyFields, signer: signerId, personName: 'dee' });
    expect(told.state).toBe('admitted');
    /* RED WHEN: the roster admits the signer at another seat, id, role or coin key than the chain, the request and the proposal hold. */
    expect(companyNow().signers.find((x) => x.id === signerId)).toMatchObject({
      status: 'active', leafCommitment: leaf, role: 'approver', coinPublicKey: DEES_COIN_KEY, name: 'dee',
    });
    /* RED WHEN: the company's key is wrapped for the new seat to a key its own saved wrapping secret does not open. */
    const wrapped = store.getAccount(CO)!.wrappedKeys.find((w) => w.signerId === signerId);
    expect(wrapped).toBeDefined();
    expect(unwrapKey(wrapped as never, dee.kept.accounts[CO]!.wrappingSecret)).toBe(KEY);
  });

  it('the new signer\'s first records-key ask carries the inviting seat\'s entry, and their own entry and records key reach the company', async () => {
    /* RED WHEN: the new signer's wallet asks for its records key without the inviting seat's signed entry, and so refuses. */
    await run(ACTS.give, dee, 'give-vault-keys', companyFields);
    /* RED WHEN: the wallet keeps the company as its account other than as the one it was invited to by a seat it checked. */
    expect(dee.pins.get(LABEL)).toMatchObject({ account: ADDRESS, from: 'invited' });
    expect(dee.kept.directoryEntriesOwed?.[CO]).toBeUndefined();
    const signing = signingPublicKeyOf(dee.kept.accounts[CO]!.signingSecret).toLowerCase();
    /* RED WHEN: the entry filed for the new seat names another seat, filing key or records key than the wallet's own. */
    const claim = store.directoryFilingsOf(CO).map((f) => f.change).find((c) => c.kind === 'claim' && c.entry.statement.seat.toLowerCase() === leaf);
    expect(claim).toMatchObject({ entry: { person: 'dee', statement: { signingKey: signing, wrappingKey: recordsKeyOf(dee) } } });
    /* RED WHEN: the roster carries vault keys for the new seat at another seat or records key. */
    expect(companyNow().signers.find((x) => x.id === signerId)).toMatchObject({
      vaultKeys: { recordsKey: recordsKeyOf(dee), recordsKeySeat: leaf }, directoryEntry: { statement: { seat: leaf, signingKey: signing } },
    });
  });

  it('the upkeep of the inviting seat\'s next act gives the new seat each vault\'s secret, which the new signer opens with their own records key', async () => {
    const intent = { name: 'invite', fields: companyFields } as unknown as ActIntent;
    const read = keptReach((c) => companyReachFor(c, chain, builderOf(ADA), why));
    const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
    const told: Record<string, string | number> = {};
    await upkeep.first.run(ctxOf(ada, intent, 1, 2, told));
    await upkeep.last.run(ctxOf(ada, intent, 2, 2, told));
    /* RED WHEN: the inviting seat's device does not believe the new seat's entry, with the role the invitation gave it and the records key it attested. */
    const seen = (await directoryOf(ADA)()).dir.seats.find((d) => d.seat.toLowerCase() === leaf);
    expect(seen).toMatchObject({ person: 'dee', role: 'approver', wrappingKey: recordsKeyOf(dee) });
    for (const v of VAULTS) {
      const filed = (await vaultRecords.of('nonce-secret').get(v))!;
      const adas = openNonceSecrets(filed as never, v, recordsKeypairFrom(fromHex(companyKeyHeldBy(ada)))).secrets;
      /* RED WHEN: a vault's secret is not given to the new seat, or the secret the new signer opens with their own records key is not that vault's. */
      expect(openNonceSecrets(filed as never, v, recordsKeypairFrom(fromHex(companyKeyHeldBy(dee)))).secrets, v).toEqual(adas);
    }
  });

  it('every wallet\'s device, the new signer\'s own among them, believes the roster with the new signer seated at the role and rights agreed', async () => {
    const intent = { name: 'give-vault-keys', fields: companyFields } as unknown as ActIntent;
    for (const [w, s] of [[ada, ADA], [bo, BO], [dee, null]] as const) {
      const r = await keptReach((c) => companyReachFor(c, chain, builderOf(s), why)).at(ctxOf(w, intent, 1, 1, {}));
      const roster = await r.roster();
      /* RED WHEN: a device does not believe the new signer active at the seat the chain holds, with the role approved and the coin key of the address invited. */
      expect(roster.signers.find((x) => x.id === signerId), w.person).toMatchObject({
        status: 'active', leafCommitment: leaf, role: 'approver', coinPublicKey: DEES_COIN_KEY,
      });
      const here = await r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster)();
      /* RED WHEN: a device does not believe the new seat's entry, with the role agreed and the records key the new signer attested. */
      expect(here.dir.seats.find((d) => d.seat.toLowerCase() === leaf), w.person).toMatchObject({ person: 'dee', role: 'approver', wrappingKey: recordsKeyOf(dee) });
    }
    /* RED WHEN: the new signer's seat is not the one their own wallet makes at the rights the invitation gave. */
    expect(dee.kept.accounts[CO]).toMatchObject({ scope: ALL, invited: { terms: { role: 'approver', invite: { scope: ALL } } } });
    expect(deesSeat(0, dee.kept.accounts[CO]!.scope as Hex).leaf).toBe(leaf);
  });
});

describe('AT ONE APPROVAL TO ADD A SIGNER, THE RAISING SEAT FINISHES ADDING THE PERSON IT INVITED', () => {
  const TOKEN = newInvitationToken();
  let proposal: SealedProposal;
  let shown: NonNullable<ReturnType<typeof addSignerByAddressIn>>;

  it('the raising seat invites a second person by address once the company asks one approval, and its raise is the approval', async () => {
    const h = chains.get(CO)!;
    chains.set(CO, { ...h, approvals: 1, seatBar: 1 });
    await run(ACTS.invite, ada, 'invite', { ...companyFields, token: TOKEN, kind: 'signer', personName: 'eve', role: 'approver', address: EVES_ADDRESS });
    const offer = ada.kept.seatInvitationsKept?.[invitationIdOf(TOKEN)]!.offer.offer.for as SignerOffer;
    proposal = (store.listProposals(CO) as SealedProposal[]).find((p) => String(p.chainId).toLowerCase() === offer.invited.terms.proposal!.toLowerCase())!;
    shown = addSignerByAddressIn(proposal as never, CO, KEY as never)!;
    expect(shown.coinPublicKey).toBe(coinKeyOf(eve));
  });

  /* RED WHEN: after the invitee's own wallet took the seat at one approval, the raising seat is told to approve again, or cannot finish adding them. */
  it('the invitee takes the seat; the raiser\'s approval is refused as carried out, and the raiser finishes adding them', async () => {
    await run(ACTS.seat, eve, 'seat-invited', { ...companyFields, token: TOKEN });
    const signer = eve.kept.accounts[CO]!.signerId;
    expect(store.getAccount(CO)!.pendingSigners.map((p) => p.id)).toContain(signer);
    await expect(run(ACTS.approveByTheRaiser, ada, 'approve-signer', {
      ...companyFields, proposal: proposal.id, personName: 'eve', role: shown.invited.terms.role, address: shown.invited.terms.invite!.address,
      scope: shown.invited.terms.invite!.scope, coinKey: shown.coinPublicKey!,
    })).rejects.toThrow(/act\.approve-signer\.why\.carried-out/u);
    const told = await run(ACTS.admitByTheRaiser, ada, 'admit-signer', { ...companyFields, signer, personName: 'eve' });
    expect(told.state).toBe('admitted');
    expect(companyNow().signers.find((x) => x.id === signer)).toMatchObject({ status: 'active', role: 'approver', coinPublicKey: coinKeyOf(eve), name: 'eve' });
  });

  it('the admitted signer gives their keys, their own act cannot give them a vault\'s secret, and the raising seat\'s next act does', async () => {
    await run(ACTS.give, eve, 'give-vault-keys', companyFields);
    const leaf = String(companyNow().signers.find((x) => x.id === eve.kept.accounts[CO]!.signerId)!.leafCommitment).toLowerCase();
    /* RED WHEN: the admitted signer's give-vault-keys files no directory entry for their own seat. */
    const claims = () => store.directoryFilingsOf(CO).map((f) => f.change).filter((c) => c.kind === 'claim');
    expect(claims().filter((c) => c.entry.statement.seat.toLowerCase() === leaf)).toHaveLength(1);
    const opens = (w: Wallet, v: string): unknown => {
      try {
        return openNonceSecrets((vaultRecordsSeen.get(v) ?? null) as never, v, recordsKeypairFrom(fromHex(companyKeyHeldBy(w)))).secrets;
      } catch {
        return null;
      }
    };
    const vaultRecordsSeen = new Map<string, unknown>();
    for (const v of VAULTS) vaultRecordsSeen.set(v, await vaultRecords.of('nonce-secret').get(v));
    /* RED WHEN: a signer's own act, from a seat that holds no vault's secret, is said to have given themselves one. */
    for (const v of VAULTS) expect(opens(eve, v), v).toBeNull();
    const intent = { name: 'invite', fields: companyFields } as unknown as ActIntent;
    const read = keptReach((c) => companyReachFor(c, chain, builderOf(ADA), why));
    const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
    const told: Record<string, string | number> = {};
    await upkeep.first.run(ctxOf(ada, intent, 1, 2, told));
    await upkeep.last.run(ctxOf(ada, intent, 2, 2, told));
    for (const v of VAULTS) vaultRecordsSeen.set(v, await vaultRecords.of('nonce-secret').get(v));
    for (const v of VAULTS) {
      /* RED WHEN: the upkeep of the raising seat's next act, after the new signer gave their keys, does not give them each vault's secret. */
      expect(opens(eve, v), v).toEqual(opens(ada, v));
    }
  });
});
