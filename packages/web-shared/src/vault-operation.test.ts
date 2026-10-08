import { describe, it, expect } from 'vitest';
import { approverRosterFrom } from '../../../src/core/vault-approvers.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import {
  createCompanyVault, createCompanyVaultByHandover, depositIntoCompanyVault, openCompanyVaultPool, DepositNotYetSeen,
  DepositNotSent, DepositStillInFlight, DepositLandedNotYetRecorded, settleDepositInFlight, DEPOSIT_TIME_TO_LIVE_MS,
  payPrivatelyFromCompanyVault, PaymentNotYetSeen, PaymentNotAsBuilt, PaymentLandedUnrecorded,
  mergeNotesInCompanyVault, MergeNotYetSeen, MergeNotAsBuilt,
  payPubliclyFromCompanyVault, PublicPaymentNotYetSeen,
  type TemporaryKeys, type VaultChainView, type VaultService, type DepositInFlight, type SecretReaderSources,
  type PaymentInFlight, type PaymentsInFlight,
  checkWhatThisBrowserSent, sayWhatTheCheckFound, DepositStartedElsewhere, PaymentStillInFlight, PaymentStartedElsewhere,
  settlePaymentInFlight, VaultStartOwed, VaultNotTheCompanys, VaultNotReadHere, StepOvertaken, NotesMovedUnderAStep,
} from './vault-operation.js';
import type { Kept, KeptOnThisDevice } from './in-flight-on-this-device.js';
import { notesForPayment, confirmPayment, poolAfterPayment } from './vault-builder.js';
import { vaultNoteCommitment } from '../../../src/midnight/note-index.js';
import { SealedNotePool } from '../../../src/midnight/vault-pool.js';
import { PaymentJournalInStore } from '../../../src/midnight/vault-journal.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { vaultBuilderOver, type VaultBuilderClient, type VaultOnChainOnTheWire } from './vault-worker-client.js';
import type { EventOnTheWire } from './vault-builder.js';
import { MemorySealedPoolStore } from '../../../src/midnight/vault-pool.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { newWrappingKeypair } from '../../../src/core/crypto.js';
import { answerVaultAsk, creatingTransactionOfNote } from './vault-worker-entry.js';
import { mergedNoteOf, changeAfterSpending } from '../../../src/midnight/vault-recovery.js';
import { nonceCircuitsFrom } from '../../../src/midnight/vault-coin-nonces.js';

/** A coin as the worker answers it: every number as decimal digits. */
const wireOfCoin = (c: { nonce: string; token: string; value: bigint }) => ({ nonce: c.nonce, token: c.token, value: c.value.toString() });
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { openNonceSecrets, recordsKeypairFrom, currentDepositNonceKey, startNonceSecret, startNonceSecretAgain } from '../../../src/midnight/company-nonce-secret.js';
import { recordsReaderOf } from './deposit-on-device.js';
import { depositNonceAt, DepositCoinAlreadyMade } from '../../../src/midnight/deposit-nonce.js';
import { sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import { toHex } from '../../../src/core/crypto.js';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signRecordsKey } from 'midnight-identity/profile/records-key';

/**
 * Deposits or payments in flight, kept for the length of one test in the clear, one per vault, each changed only
 * under its claim. The sealing is `in-flight-on-this-device.test.ts`'s.
 */
let claims = 0;
const inFlightInMemory = <T,>(kept = new Map<string, Kept<T>>()): KeptOnThisDevice<T> => ({
  get: async (v) => kept.get(v) ?? null,
  claim: async (v, d) => {
    if (kept.has(v)) return null;
    claims += 1;
    kept.set(v, { ...d, claim: `claim-${claims}` });
    return `claim-${claims}`;
  },
  update: async (v, c, d) => { if (kept.get(v)?.claim === c) kept.set(v, { ...d, claim: c }); },
  forget: async (v, c) => { if (kept.get(v)?.claim === c) kept.delete(v); },
});

/*
 * The order a signer's device runs, with the service and the builder stood in.
 * The same order against the ledger's own state machine is
 * `contracts/test/a-company-vault-from-the-page.test.ts`.
 */
const VAULT = 'ab'.repeat(32);
/* The company's account, and the label it carries. */
const ACCOUNT = 'c0'.repeat(32) as AccountAddress;
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const committee = { committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1 };
/*
 * The company as a device counts it for the vault check, beside the pacing every operation takes: three seats with every
 * right and one approval needed, so no vault here is left short. The check is driven in
 * `src/core/a-vault-keeps-as-many-approvers-as-its-bar.test.ts` and `apps/web/src/adapters/create-vault.test.ts`.
 */
const nobodyShort = {
  approvers: async () => approverRosterFrom({
    threshold: 1, vaultThresholds: [], seated: ['e1', 'e2', 'e3'].map((leaf) => ({ leaf })), adoptedVaults: [], companyWide: 'cc'.repeat(32),
  }),
  vaultName: (v: string) => v,
};
const pacing = { sleep: async () => {}, waitMs: 3, everyMs: 1, ...nobodyShort };
/*
 * The vault's company account as the signer's own wallet reads it: an account that has adopted the vault. A test about
 * a vault that is not the company's hands its own.
 */
const walletReadsTheVault = {
  account: 'c0'.repeat(32) as AccountAddress,
  /* The indexer the wallet names, behind which stands the chain of the stand-in service made last (`serviceFrom`). */
  indexer: async () => ({ indexerUri: CURRENT_CHAIN, indexerWsUri: 'wss://indexer.current.example/ws' }),
  onChain: async (v: string) => ({
    holders: { committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1, seats: ['4a'.repeat(32)], approvals: 1, adoptedVaults: [v], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }] },
  }),
};
/* Stand-in ledger parameters: the header the ledger writes them under, and nothing a ledger could read. */
const PARAMS = btoa('midnight:ledger-parameters[v8]:stand-in');
const view = (over: Partial<VaultChainView>): VaultChainView => ({ vault: VAULT, onChain: true, committee, deployed: 'D', ...over });
/*
 * **THE VAULT AS THIS DEVICE'S WORKER READS IT, AT THE INDEXER THE WALLET NAMES.** Each stand-in service's chain is the
 * stand-in chain, and a door's `indexer` names it: the stand-in builder's `vaultOnChain` answers what that chain holds,
 * as the worker would read it - held by the company's committee when the view says so, by one other key when it says
 * not, and started when money may go in. The read of a real ledger state is `vault-on-chain-here.test.ts`'s.
 */
const chains = new Map<string, (vault: string) => Promise<VaultChainView>>();
/** The indexer a door names when a test gives none of its own: the chain of the stand-in service made last. */
const CURRENT_CHAIN = 'https://indexer.current.example/api/v3/graphql';
const indexerOf = (service: VaultService) => {
  const uri = `https://indexer-${chains.size + 1}.example/api/v3/graphql`;
  chains.set(uri, (v) => service.chain(v as never));
  behind.set(uri, behindOf.get(service) ?? nothingBehind(uri));
  return async () => ({ indexerUri: uri, indexerWsUri: `wss://indexer-${chains.size}.example/api/v3/graphql/ws` });
};
/*
 * **WHAT A STEP IS BUILT ON AND JUDGED BY, BEHIND EACH STAND-IN INDEXER**: one block's view, a transaction's events and
 * the vault's own history, as each stand-in service's chain holds them. The stand-in builder reads them at the indexer a
 * door names, as the worker does; a deposit or a payment never asks the service for any of the three. Only a vault's
 * start still reads its block through the service. The read of a real indexer's answers is `vault-on-chain-here.test.ts`'s.
 */
interface ChainBehind {
  payoutState(vault: string): Promise<{ vault: string; account: string; blockHash: string; vaultState: string; zswapState: string; parameters: string; accountState: string }>;
  events(vault: string, transactionHash: string): Promise<{ events: EventOnTheWire[] }>;
  createdBy(vault: string, commitment: string): Promise<{ transactionHash: string; events: EventOnTheWire[] } | null>;
}
const behind = new Map<string, ChainBehind>();
const behindOf = new WeakMap<VaultService, ChainBehind>();
const nothingBehind = (uri: string): ChainBehind => {
  const none = async (): Promise<never> => { throw new Error(`the stand-in has no chain behind ${uri}`); };
  return { payoutState: none, events: none, createdBy: none };
};
const behindAt = (i: { indexerUri: string }): ChainBehind => behind.get(i.indexerUri) ?? nothingBehind(i.indexerUri);
/** A service, and the indexer door that names its chain. */
const hereAndThere = (service: VaultService) => ({ service, indexer: indexerOf(service) });
/** The same doors with the service's own answer about the vault refused, and every time it is asked counted. */
const theServiceNeverAsked = <D extends { service: VaultService }>(d: D, asked: { n: number }): D =>
  ({ ...d, service: { ...d.service, chain: async () => { asked.n += 1; throw new Error('the service was asked what the vault holds'); } } });
const wireOf = (v: VaultChainView): VaultOnChainOnTheWire => (!v.onChain ? { onChain: false } : {
  onChain: true, state: v.state ?? '',
  ...(v.notes === undefined ? {} : { notes: v.notes }), notesFromThisBuild: v.notes !== undefined,
  ...(v.notesWhy === undefined ? {} : { notesWhy: v.notesWhy }),
  everCreated: v.everCreated ?? [],
  authority: v.heldByCommittee === true ? committee
    : v.authority ? { committee: v.authority.committee, threshold: v.authority.threshold }
      : v.heldByCommittee === false ? { committee: [{ tag: 'schnorr', value: '99'.repeat(32) }], threshold: 1 } : null,
  account: ACCOUNT,
  started: v.fundable === true,
});
const readOnTheDevice = async (i: { vault: string; indexer: { indexerUri: string } }): Promise<VaultOnChainOnTheWire> => {
  const chain = chains.get(i.indexer.indexerUri);
  if (chain === undefined) throw new Error(`the stand-in has no chain behind ${i.indexer.indexerUri}`);
  return wireOf(await chain(i.vault));
};
/* A pool opened outside a vault's start, where nobody is approved: there are no readers to check. */
const nothingToCheck = async (): Promise<void> => {};

const builder = (log: string[]): VaultBuilderClient => ({
  /* What a governance proposal is called, and the value a company-wide run names: no vault operation asks either. */
  proposalIdentity: async () => { throw new Error('a vault operation never names a governance proposal'); },
  companyWide: async () => { throw new Error('a vault operation never asks what a company-wide run names'); },
  /* The old temporary-key deploy and hand-over: creating a vault never asks for either. */
  deploy: async () => { log.push('build deploy'); return { vault: VAULT, temporaryKey: { tag: 'schnorr', value: '77'.repeat(32) }, tx: 'D' }; },
  handover: async (i) => { log.push(`build handover at ${i.counter}`); return { tx: 'H' }; },
  bornHeldVault: async (i) => {
    log.push(`build vault held by ${i.holders.committee.map((k) => k.value.slice(0, 2)).join(',')} at ${i.holders.threshold}`);
    return { vault: VAULT, tx: 'D' };
  },
  /* The stand-in reads every deploy as born held; a test about one that was not hands its own. */
  vaultAsDeployed: async (i) => {
    const at = (i.indexer as typeof i.indexer | null) === null ? 'no indexer' : i.indexer.indexerUri === CURRENT_CHAIN ? 'the wallet\'s indexer' : i.indexer.indexerUri;
    log.push(`read the deploy at ${at} against ${i.holders.committee.length} key(s)`);
    return { refusal: null };
  },
  deposit: async (i) => { log.push(`build deposit with ${i.parameters}`); return { tx: 'P' }; },
  commitments: async (i) => ({ output: 'aa'.repeat(32), held: i.coin.nonce === 'ee'.repeat(32) ? 'bb'.repeat(32) : `h${i.coin.nonce.slice(1)}` }),
  ownSeat: async () => { throw new Error('nothing here signs for a seat'); },
  /* The stand-in vault holds the secret the company's records hold; a test about one it does not hands its own. */
  secretIsTheVaults: async () => true,
  vaultOnChain: readOnTheDevice,
  chainAtOneBlock: async (i) => {
    log.push('read the block here');
    const at = await behindAt(i.indexer).payoutState(i.vault);
    return { blockHash: at.blockHash, vaultState: at.vaultState, zswapState: at.zswapState, parameters: at.parameters, accountState: at.accountState };
  },
  eventsOf: async (i) => {
    log.push(`read events of ${i.transactionHash.slice(0, 2)} here`);
    return [...(await behindAt(i.indexer).events(VAULT, i.transactionHash)).events];
  },
  createdBy: async (i) => behindAt(i.indexer).createdBy(i.vault, i.commitment),
  notesForPayment: async (i) => { log.push('choose'); return notesForPayment(i); },
  paymentsFit: async () => { throw new Error('a payment out never asks whether a run fits'); },
  afterPayment: async (i) => poolAfterPayment(i),
  /*
   * A merge keeps one coin worth every note it spent, a payment its change; the stand-in names each with a nonce of its
   * own. The real coins are the vault's, pinned below through the worker and in `vault-batch-and-merge.test.ts`.
   */
  stepKept: async (i) => {
    const held = [i.step.spent, ...(i.step.further ?? [])].reduce((t, n) => t + BigInt(n.value), 0n);
    if (i.step.merge === true) return { nonce: 'e7'.repeat(32), token: i.step.spent.token, value: held.toString() };
    const left = held - BigInt(i.step.amount);
    return left === 0n ? null : { nonce: 'e6'.repeat(32), token: i.step.spent.token, value: left.toString() };
  },
  confirmPayment: async (i) => confirmPayment(i),
  creatingTransaction: async (i) => creatingTransactionOfNote(i),
  payout: async (i) => {
    log.push(`build payout spending ${[i.note, ...(i.further ?? []).map((f) => f.note)].map((n) => n.nonce.slice(0, 2)).join('+')} with ${[i.events, ...(i.further ?? []).map((f) => f.events)].map((e) => e.length).join('+')} event(s) at ${i.chain.blockHash}`);
    const rest = [i.note, ...(i.further ?? []).map((f) => f.note)].reduce((t, n) => t + BigInt(n.value), 0n) - BigInt(i.payment.amount);
    return { tx: 'O', spent: i.note.nonce, change: rest === 0n ? null : { nonce: 'cc'.repeat(32), token: i.note.token, value: rest.toString() } };
  },
  /* A merge keeps one coin worth every note it spends; the stand-in names it as `stepKept` names a merge's coin. */
  mergeNotes: async (i) => {
    log.push(`build merge spending ${i.notes.map((n) => n.note.nonce.slice(0, 2)).join('+')} with ${i.notes.map((n) => n.events.length).join('+')} event(s) at ${i.chain.blockHash}`);
    const held = i.notes.reduce((t, n) => t + BigInt(n.note.value), 0n);
    return { tx: 'M', spent: i.notes.map((n) => n.note.nonce), kept: { nonce: 'e7'.repeat(32), token: i.notes[0]!.note.token, value: held.toString() } };
  },
  payoutPublicly: async (i) => {
    log.push(`build public payout of ${i.payment.amount} to ${i.payment.payee} at ${i.chain.blockHash}`);
    return { tx: 'U' };
  },
  /* No step of a start is raised here: the stand-in chain shows every one already done. */
  governedCall: async () => { throw new Error('a vault operation asked for a governed call'); },
  startStanding: async (i) => ({
    standing: {
      adopted: true,
      adoption: { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), open: false, approvals: 0, needed: 1, stale: false },
      ...(i.secret === undefined ? {} : { secret: { set: true, another: false, rootIsThisRuns: true, run: null, written: [true], started: true } }),
    },
    ...(i.secret === undefined ? {} : { run: { copies: [{ reader: '40'.repeat(32), parts: [], path: [] }] } as never }),
  }),
  setNonceSecret: async () => { throw new Error('a start set a secret the chain already holds'); },
  writeSecretCopy: async () => { throw new Error('a start wrote a copy the chain already holds'); },
});
/* Who holds the account and the vault, as a signer's own wallet reads them: a company of one, the vault held by it. */
const walletRead = (committeeKey: { tag: string; value: string }, vaultHeldBy: Array<{ tag: string; value: string }> = [committeeKey]) => ({
  committee: [committeeKey], threshold: 1, seats: ['4a'.repeat(32)],
  vault: { vault: VAULT, account: ACCOUNT, committee: vaultHeldBy, threshold: 1 },
});
/** What creating a vault is handed to start it: this signer, their records and their own three. */
const startDoors = () => {
  const wrapping = newWrappingKeypair();
  const s = new Map<WireRecord, MemorySealedPoolStore>();
  return {
    me: { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(4) },
    myRecordsKey: recordsKeypairFrom(new Uint8Array(32).fill(4)).publicKey,
    records: (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    /* Refuses every reader: a wallet that read nothing. A test that reaches the check hands its own. */
    secretReaders: { company: LABEL, committeeKey: committee.committee[0]!, read: async () => null, roster: async () => [] } as SecretReaderSources,
  };
};
/** A start whose chain already shows the secret set, so the company's records already hold it too. */
/** The newest secret a nonce-secret record holds, opened with `companyKey`. */
const newestSecretIn = (rec: Parameters<typeof openNonceSecrets>[0], companyKey: Uint8Array): string => {
  const opened = openNonceSecrets(rec, VAULT, recordsKeypairFrom(companyKey));
  return opened.secrets[opened.secrets.length - 1]!;
};
/**
 * The records as a device left them after filing a fresh secret it never set: version 1 is the one the vault holds,
 * version 2 is newer and the vault does not hold it. Answers the vault's secret.
 */
const anUnsetNewerSecret = async (records: (r: WireRecord) => MemorySealedPoolStore | { get: (v: string) => Promise<unknown>; put: (v: string, p: never) => Promise<unknown> }, companyKey: Uint8Array): Promise<string> => {
  const first = (await records('nonce-secret').get(VAULT)) as Parameters<typeof openNonceSecrets>[0];
  await records('nonce-secret').put(VAULT, startNonceSecretAgain(first, VAULT, [recordsReaderOf(companyKey)]) as never);
  return newestSecretIn(first, companyKey);
};
const filedAlready = async () => {
  const doors = startDoors();
  await doors.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(doors.me.companyKey)]));
  return doors;
};
const memoryKeys = (log: string[]) => {
  const held = new Map<string, { tag: string; value: string }>();
  const keys: TemporaryKeys = {
    put: async (v, k) => { log.push('key kept'); held.set(v, k); },
    get: async (v) => held.get(v) ?? null,
    forget: async (v) => { log.push('key forgotten'); held.delete(v); },
  };
  return { keys, held };
};
const serviceFrom = (views: VaultChainView[], log: string[], over: Partial<VaultService> & Partial<ChainBehind> = {}): VaultService => {
  let i = 0;
  /* The stand-in chain is what this service would have said; the device reads it there, never by asking the service. */
  chains.set(CURRENT_CHAIN, async () => views[Math.min(i++, views.length - 1)]!);
  const { events: eventsBehind, createdBy: createdByBehind, ...forTheService } = over;
  const chainBehind: ChainBehind = {
    payoutState: over.payoutState ?? (async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: PARAMS, accountState: 'A' })),
    events: eventsBehind ?? (async (_v, tx) => {
      const landed = paymentEvents.get(tx);
      if (landed) return { events: landed };
      if (tx === 'dd'.repeat(32)) throw new Error('the indexer does not hold this transaction yet');
      return { events: [{ transactionHash: tx, details: { tag: 'zswapOutput' } }] };
    }),
    /* The vault's history, searched by an output's commitment: the landed payments' events. */
    createdBy: createdByBehind ?? (async (_v, commitment) => {
      for (const [hash, events] of paymentEvents) {
        if (events.some((e) => e.details.tag === 'zswapOutput' && e.details.commitment === commitment && e.details.contract === VAULT)) {
          log.push(`found ${commitment.slice(0, 4)} in ${hash.slice(0, 2)}`);
          return { transactionHash: hash, events };
        }
      }
      return null;
    }),
  };
  behind.set(CURRENT_CHAIN, chainBehind);
  const service: VaultService = {
    keys: async () => ({ committee, why: null, readers: [] }),
    deploy: async () => { log.push('sent deploy'); return { vault: VAULT, txRef: 'd' }; },
    handover: async () => { log.push('sent handover'); return { txRef: 'h' }; },
    chain: async () => views[Math.min(i++, views.length - 1)]!,
    deposit: async () => { log.push('sent deposit'); return { txRef: 'p', transactionHash: 'ee'.repeat(32) }; },
    /* A vault's start, and nothing else, reads its block through the service. */
    payoutState: async (v) => {
      log.push('read the block');
      return chainBehind.payoutState(v);
    },
    payout: async () => { log.push('sent payout'); return { txRef: 'o', transactionHash: 'dd'.repeat(32) }; },
    merge: async () => { log.push('sent merge'); return { txRef: 'm', transactionHash: 'dc'.repeat(32) }; },
    payoutPublicly: async () => { log.push('sent public payout'); return { txRef: 'u', transactionHash: 'de'.repeat(32) }; },
    ...forTheService,
  };
  behindOf.set(service, chainBehind);
  return service;
};
/**
 * **A SERVICE THAT WOULD SERVE A LIE ABOUT THE BLOCK**: a block of its own and other parameters, counted every time it
 * is asked. A deposit or a payment that asks it either builds on the lie or is seen asking. The service has no events
 * or history to ask any more; that a step reads both here is what each test's own log of device reads shows.
 */
const aServiceThatLies = (service: VaultService, asked: string[]): VaultService => ({
  ...service,
  payoutState: async () => {
    asked.push('the block');
    return { vault: VAULT as never, account: 'ee'.repeat(32) as never, blockHash: 'LIE', vaultState: 'L', zswapState: 'L', parameters: btoa('midnight:ledger-parameters[v8]:a lie'), accountState: 'L' };
  },
});
/** The events a landed payment has, by its hash; a test fills this in when its payment lands. */
const paymentEvents = new Map<string, Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>>();
const eventsOfAPayment = async (hash: string, change: { nonce: string; token: string; value: bigint } | null, vault = VAULT) => [
  { transactionHash: hash, details: { tag: 'zswapInput' } },
  { transactionHash: hash, details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), mtIndex: '11' } },
  ...(change === null ? [] : [{
    transactionHash: hash,
    details: { tag: 'zswapOutput', commitment: await vaultNoteCommitment(change as never, vault as never), contract: vault, mtIndex: '12' },
  }]),
];
const oneKey = view({ authority: { committee: [{ tag: 'schnorr', value: '99'.repeat(32) }], threshold: 1, counter: '0', shape: 'one-key' }, heldByCommittee: false });
const held = view({ heldByCommittee: true, why: null });

describe('CREATING A VAULT', () => {
  const create = (doors: Awaited<ReturnType<typeof filedAlready>> | ReturnType<typeof startDoors>, service: VaultService, log: string[], over: Partial<Parameters<typeof createCompanyVault>[0]> = {}, resume?: string) =>
    createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service, builder: builder(log), keys: memoryKeys(log).keys, ...over }, resume as never);

  it('IS BUILT HELD BY THE COMPANY\'S COMMITTEE, SENT, READ AS IT WAS BORN, AND STARTED - WITH NO TEMPORARY KEY AND NO HAND-OVER', async () => {
    const log: string[] = [];
    const done = await create(await filedAlready(), serviceFrom([held], log), log);
    /* RED WHEN: the press ends before the chain shows the vault started. */
    expect(done).toEqual({ vault: VAULT, state: 'started' });
    /*
     * RED WHEN: a temporary key is made or kept, a hand-over is built or sent, the vault is held by anything but the
     * committee, or the start goes on before this device has read the vault as it was born.
     */
    expect(log).toEqual(['build vault held by 11 at 1', 'sent deploy', 'read the deploy at the wallet\'s indexer against 1 key(s)',
      /* The start reads both contracts at one block, before the adoption and again with the secret read back. */
      'read the block', 'read the block']);
  });

  /* RED WHEN: the vault carried on is whatever address the service answers the deploy with. */
  it('A DEPLOY ANSWERED WITH ANOTHER VAULT THAN THE ONE SENT IS NOT CARRIED ON WITH', async () => {
    const log: string[] = [];
    const service = serviceFrom([held], log, { deploy: async () => { log.push('sent deploy'); return { vault: 'ef'.repeat(32), txRef: 'd' }; } });
    const e = await create(await filedAlready(), service, log).catch((x) => x);
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect(e.vault).toBe(VAULT);
    expect(e.message).toMatch(/answered with another vault than the one this device sent/);
    expect(log.filter((l) => l.startsWith('read'))).toEqual([]);
  });

  it('NO COMMITTEE, NOTHING BUILT', async () => {
    const log: string[] = [];
    const service = serviceFrom([], log, { keys: async () => ({ committee: null, why: 'not everybody has given a key.', readers: [] }) });
    await expect(create(startDoors(), service, log)).rejects.toThrow('not everybody has given a key.');
    expect(log).toEqual([]);
  });

  it('NO VAULT WHILE THE COMPANY\'S ACCOUNT IS NOT HELD BY ITS CURRENT COMMITTEE, AS THE SIGNER\'S OWN WALLET READS IT', async () => {
    const log: string[] = [];
    const elsewhere = { onChain: async (v: string) => ({ holders: { ...(await walletReadsTheVault.onChain(v)).holders, committee: [{ tag: 'schnorr', value: '99'.repeat(32) }] } }) };
    /* RED WHEN: the committee a vault is born held by is taken from the service alone, without the account the vault is pinned to. */
    await expect(create(startDoors(), serviceFrom([], log), log, elsewhere)).rejects.toThrow(/not held by its current committee yet/);
    const lower = { onChain: async (v: string) => ({ holders: { ...(await walletReadsTheVault.onChain(v)).holders, threshold: 2 } }) };
    /* RED WHEN: the threshold is not compared. */
    await expect(create(startDoors(), serviceFrom([], log), log, lower)).rejects.toThrow(/not held by its current committee yet/);
    expect(log).toEqual([]);
  });

  it('NO VAULT HELD BY A COMMITTEE ANY ONE OF WHOSE KEYS COULD CHANGE IT ALONE', async () => {
    const log: string[] = [];
    const two = { committee: [{ tag: 'schnorr', value: '11'.repeat(32) }, { tag: 'schnorr', value: '22'.repeat(32) }], threshold: 1 };
    const service = serviceFrom([], log, { keys: async () => ({ committee: two, why: null, readers: [] }) });
    const wallet = { onChain: async (v: string) => ({ holders: { ...(await walletReadsTheVault.onChain(v)).holders, ...two } }) };
    /* RED WHEN: a vault is built for a committee one of whose keys could change its rules alone. */
    await expect(create(startDoors(), service, log, wallet)).rejects.toThrow(/could change them alone/);
    expect(log).toEqual([]);
  });

  it('A DEPLOY THAT MAY HAVE LANDED IS A FAILURE NAMING THE VAULT', async () => {
    const log: string[] = [];
    const service = serviceFrom([], log, { deploy: async () => { throw new Error('the node did not answer'); } });
    const e = await create(startDoors(), service, log).catch((x) => x);
    /* RED WHEN: a deploy that may have landed is lost, or reported as nothing sent. */
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect(e.vault).toBe(VAULT);
    expect(e.message).toMatch(/may have been sent \(the node did not answer\)/);
  });

  it('A DEPLOY REFUSED BEFORE IT WAS SENT SAYS WHY, AND NOTHING ELSE HAPPENS', async () => {
    const log: string[] = [];
    const service = serviceFrom([], log, {
      deploy: async () => { throw Object.assign(new Error('refused. Nothing was sent.'), { nothingWasSent: true }); },
    });
    await expect(create(startDoors(), service, log)).rejects.toThrow('refused. Nothing was sent.');
    expect(log).toEqual(['build vault held by 11 at 1']);
  });

  it('A VAULT THAT NEVER APPEARS, OR A CHAIN READ THAT THROWS, IS NEVER REPORTED CREATED, AND NAMES THE VAULT', async () => {
    const absent = await create(startDoors(), serviceFrom([view({ onChain: false })], []), []).catch((x) => x);
    expect(absent).toBeInstanceOf(VaultStartOwed);
    expect(absent.message).toMatch(/the chain has not shown it yet/);
    /* RED WHEN: a read of the chain that throws after the vault was sent escapes as a plain error that does not name the vault. */
    const asked = { n: 0 };
    const service = theServiceNeverAsked({ service: serviceFrom([], []) }, asked).service;
    chains.set(CURRENT_CHAIN, async () => { throw new Error('the indexer did not answer'); });
    const e = await create(startDoors(), service, []).catch((x) => x);
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect(e.vault).toBe(VAULT);
    expect(e.message).toMatch(/the chain could not be read for it on this device \(this device could not read the vault from the chain \(the indexer did not answer\)/);
    /* RED WHEN: the vault just sent is read from the service's answer rather than on this device. */
    expect(asked.n).toBe(0);
  });

  it('A VAULT NOT BORN HELD IS NEITHER ADOPTED NOR SET UP, AND ONE WHOSE DEPLOY CANNOT BE READ IS NOT EITHER', async () => {
    const log: string[] = [];
    const doors = await filedAlready();
    const notBorn = { ...builder(log), vaultAsDeployed: async () => ({ refusal: 'this is not a vault this company can use: held by other keys. Nothing was sent.' }) };
    /* RED WHEN: this device adopts or sets up a vault without reading it as it was born, or past what that read refused. */
    const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: notBorn, keys: memoryKeys(log).keys }, VAULT)
      .catch((x) => x);
    expect(e).toBeInstanceOf(VaultNotTheCompanys);
    expect(e.message).toBe('this is not a vault this company can use: held by other keys. This vault is not set up and no money is put '
      + 'into it; create a new vault. Nothing was sent.');
    /* RED WHEN: a vault is carried on with when this device cannot read its deploy itself, on anybody's word. */
    const { vaultAsDeployed: _cannot, ...cannotRead } = builder(log);
    const none = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: cannotRead, keys: memoryKeys(log).keys }, VAULT)
      .catch((x) => x);
    expect(none).toBeInstanceOf(VaultNotTheCompanys);
    expect(none.message).toMatch(/cannot read how this vault was created/);
    /* RED WHEN: the deploy is read somewhere other than the indexer the person's own wallet names, or anywhere when it names none. */
    const noIndexer = await create(doors, serviceFrom([held], log), log, { indexer: async () => null }, VAULT).catch((x) => x);
    expect(noIndexer).toBeInstanceOf(VaultStartOwed);
    expect(noIndexer.message).toMatch(/did not say which indexer it reads the chain through/);
    expect(log.filter((l) => l === 'read the block' || l.startsWith('read the deploy'))).toEqual([]);
    /* RED WHEN: a wallet that stops naming its indexer once the vault is seen has its deploy read anywhere else. */
    let seen = false;
    const seenThenSilent = { ...builder(log), vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => { seen = true; return readOnTheDevice(i); } };
    const indexer = async () => (seen ? null : walletReadsTheVault.indexer());
    const silent = await create(doors, serviceFrom([held], log), log, { builder: seenThenSilent, indexer }, VAULT).catch((x) => x);
    expect(silent).toBeInstanceOf(VaultStartOwed);
    expect(silent.message).toMatch(/did not say which indexer it reads the chain through, so this device cannot read how the vault was created/);
    expect(log.filter((l) => l.startsWith('read the deploy'))).toEqual([]);
  });

  it('a resume for a vault the chain shows started reads it as it was born and finishes without building anything', async () => {
    const log: string[] = [];
    await expect(create(await filedAlready(), serviceFrom([held], log), log, {}, VAULT)).resolves.toEqual({ vault: VAULT, state: 'started' });
    expect(log).toEqual(['read the deploy at the wallet\'s indexer against 1 key(s)', 'read the block', 'read the block']);
  });

  /*
   * **THE OLD HAND-OVER, KEPT UNUSED UNTIL IT IS REMOVED WITH THE REST OF IT.** Nothing creates a vault this way any
   * more; its own behaviour is pinned here so it is removed whole rather than left half-working. RED WHEN: the temporary
   * key is not kept before the deploy is sent, or is forgotten before the chain says the committee holds the vault.
   */
  it('THE OLD HAND-OVER PATH, UNUSED: keeps its temporary key before the deploy is sent, and forgets it once the committee holds the vault', async () => {
    const log: string[] = [];
    const { keys, held: kept } = memoryKeys(log);
    const done = await createCompanyVaultByHandover({ ...pacing, ...walletReadsTheVault, ...(await filedAlready()), account: ACCOUNT, service: serviceFrom([oneKey, held], log), builder: builder(log), keys });
    expect(done).toEqual({ vault: VAULT, state: 'started' });
    expect(log.slice(0, 6)).toEqual(['build deploy', 'key kept', 'sent deploy', 'build handover at 0', 'sent handover', 'key forgotten']);
    expect(kept.size).toBe(0);
  });

  it('A START REFUSES TO GO ON PAST ITS ADOPTION WITH A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT', async () => {
    const log: string[] = [];
    const doors = await filedAlready();
    const before = await doors.records('nonce-secret').versions(VAULT);
    const unadopted = { ...walletReadsTheVault, onChain: async (v: string) => ({ ...(await walletReadsTheVault.onChain(v)), holders: { ...(await walletReadsTheVault.onChain(v)).holders, adoptedVaults: [] } }) };
    const e = await createCompanyVault({ ...pacing, ...unadopted, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: builder(log), keys: memoryKeys(log).keys }, VAULT)
      .catch((x: Error) => x);
    /* RED WHEN: a start opens the pool or sets a secret for a vault the service's rows say was adopted and the account's own set does not hold. */
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect((e as Error).message).toMatch(/not one your company's account has adopted/);
    expect(await doors.records('nonce-secret').versions(VAULT)).toEqual(before);
  });

  it('THE CHAIN WINS IN A START: A NEWER SECRET THE VAULT NEVER TOOK IS PASSED OVER, AND THE ONE IT HOLDS IS FILED AGAIN AS THE NEWEST', async () => {
    const log: string[] = [];
    const doors = await filedAlready();
    const theVaults = await anUnsetNewerSecret(doors.records, doors.me.companyKey);
    const b = { ...builder(log), secretIsTheVaults: async (i: { secret: string }) => i.secret === theVaults };
    await expect(createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: b, keys: memoryKeys(log).keys }, VAULT))
      .resolves.toEqual({ vault: VAULT, state: 'started' });
    /* RED WHEN: a start ends with the records' newest secret one the vault does not hold, so every deposit and payment after it refuses. */
    const newest = (await doors.records('nonce-secret').get(VAULT))!;
    expect([newest.version, newestSecretIn(newest, doors.me.companyKey)]).toEqual([3, theVaults]);
  });

  /* RED WHEN: a start goes on with a signer the vault's filed secret is not wrapped to - their sealed copy would be missing. */
  it('a start stops, naming the vault, when a signer cannot open the filed secret', async () => {
    const log: string[] = [];
    const service = serviceFrom([held], log, { keys: async () => ({ committee, why: null, readers: ['5c'.repeat(32)] }) });
    const doors = startDoors();
    await doors.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(doors.me.companyKey)]));
    const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service, builder: builder(log), keys: memoryKeys(log).keys }, VAULT)
      .catch((x) => x);
    expect(e.name).toBe('VaultStartOwed');
    expect(e.vault).toBe(VAULT);
    expect(e.message).toMatch(/1 signer\(s\) cannot open the vault's filed secret/);
  });

  /*
   * The sealed copies a vault keeps are sealed to the records keys the service lists. Before this device raises or
   * approves the run that sets the first secret, its own key must be on that list and its own copy must open.
   */
  describe('THIS SIGNER\'S OWN COPY IS CHECKED BEFORE THE FIRST SECRET RUN IS RAISED OR APPROVED', () => {
    const unset = (copies: Array<{ reader: string; parts: string[]; path: never[] }>) => (log: string[]): VaultBuilderClient => ({
      ...builder(log),
      governedCall: async () => { log.push('built a governed call'); throw new Error('stand-in: nothing is proved here'); },
      startStanding: async (i) => ({
        standing: {
          adopted: true,
          adoption: { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), open: false, approvals: 0, needed: 1, stale: false },
          ...(i.secret === undefined ? {} : {
            secret: {
              set: false, another: false, rootIsThisRuns: true, written: [false], started: false,
              /* Another signer raised the run from this secret, so this device approves it rather than replacing the secret. */
              run: {
                proposal: 'b1'.repeat(32), payload: 'b2'.repeat(32), named: 'b3'.repeat(32), salt: 'b4'.repeat(32),
                open: true, approvals: 1, needed: 2, stale: false, opensAt: '1', closesAt: '2', inWindow: true,
              },
            },
          }),
        },
        ...(i.secret === undefined ? {} : { run: { root: 'b5'.repeat(32), payees: '1', asset: 'b6'.repeat(32), copies } as never }),
      }),
    });
    const press = async (
      readers: (mine: string) => string[], copiesOf: (mine: string, secret: string) => Array<{ reader: string; parts: string[]; path: never[] }>,
      over: { secretReaders?: SecretReaderSources; view?: VaultChainView } = {},
    ) => {
      const log: string[] = [];
      const doors = startDoors();
      const mine = recordsKeypairFrom(doors.me.companyKey);
      await doors.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(doors.me.companyKey), { publicKey: another }]));
      const secret = openNonceSecrets((await doors.records('nonce-secret').get(VAULT))!, VAULT, mine).secrets[0]!;
      const service = serviceFrom([over.view ?? held], log, { keys: async () => ({ committee, why: null, readers: readers(mine.publicKey) }) });
      const e = await createCompanyVault({
        ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service, builder: unset(copiesOf(mine.publicKey, secret))(log), keys: memoryKeys(log).keys,
        ...(over.secretReaders === undefined ? {} : { secretReaders: over.secretReaders }),
      }, VAULT).catch((x) => x);
      return { e, log };
    };
    /* Another signer the company's record of the secret is wrapped to. */
    const another = recordsKeypairFrom(new Uint8Array(32).fill(9)).publicKey;
    const sealed = (vault: string, secret: string, reader: string) =>
      sealSecretCopy({ vault, secret, reader }).map((p) => toHex(p));

    /* RED WHEN the press stops checking that the service's list of records keys holds this device's own. */
    it('a service list without this signer\'s own records key is refused by name, and nothing is raised', async () => {
      const { e, log } = await press(() => [another], (mine, secret) => [{ reader: mine, parts: sealed(VAULT, secret, mine), path: [] }]);
      expect(e.name).toBe('VaultStartOwed');
      expect(e.vault).toBe(VAULT);
      expect(e.message).toMatch(/does not have the key your own recovery words give/);
      expect(log).not.toContain('built a governed call');
    });

    /* RED WHEN the press stops checking that this signer's copy in the run opens with this signer's own records key. */
    it('a run whose copy for this signer does not open with this signer\'s own key is refused by name, and nothing is raised', async () => {
      const otherVault = 'cd'.repeat(32);
      const { e, log } = await press((mine) => [mine], (mine, secret) => [{ reader: mine, parts: sealed(otherVault, secret, mine), path: [] }]);
      expect(e.name).toBe('VaultStartOwed');
      expect(e.message).toMatch(/would keep for you does not open with the key your own recovery words give/);
      expect(log).not.toContain('built a governed call');
      const none = await press((mine) => [mine], () => [{ reader: '5c'.repeat(32), parts: [], path: [] }]);
      expect(none.e.message).toMatch(/would keep for you does not open/);
      expect(none.log).not.toContain('built a governed call');
    });

    it('a run whose copy for this signer opens with this signer\'s own key, and whose every reader checks out, goes on to approve the run', async () => {
      /* A company of one: this signer's wallet signed their records key, and the chain lists their committee key. */
      const identity = identityFromSecret(new Uint8Array(32).fill(1));
      const companyKey = startDoors().me.companyKey;
      const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
      const statement = signRecordsKey(identity, LABEL, ACCOUNT, companyKey, '4a'.repeat(32));
      const secretReaders = {
        company: LABEL, committeeKey, read: async () => walletRead(committeeKey),
        roster: async () => [{
          signerId: 'ada', userId: 'ada', name: 'Ada', filingKey: '00'.repeat(32) as never,
          keys: {
            committeeKey, recordsKey: statement.recordsKey as never,
            recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
          },
        }],
      };
      const heldByThem = view({ heldByCommittee: true, why: null, authority: { committee: [committeeKey], threshold: 1, counter: '1', shape: 'committee' } });
      const { e, log } = await press((mine) => [mine], (mine, secret) => [{ reader: mine, parts: sealed(VAULT, secret, mine), path: [] }], { secretReaders, view: heldByThem });
      expect(log).toContain('built a governed call');
      expect(e.name).toBe('VaultStartOwed');
      expect(e.message).toMatch(/approving its first secret could not be built/);
    });

    /*
     * The company's record of the nonce secret is wrapped to the keys the service lists. Before it is first filed,
     * those keys are checked as the run's are: a key slipped onto the list would otherwise open the secret.
     */
    describe('BEFORE A NONCE SECRET IS FIRST FILED, THE KEYS IT WOULD BE WRAPPED TO ARE CHECKED', () => {
      const companyOfOne = () => {
        const identity = identityFromSecret(new Uint8Array(32).fill(1));
        const companyKey = startDoors().me.companyKey;
        const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
        const statement = signRecordsKey(identity, LABEL, ACCOUNT, companyKey, '4a'.repeat(32));
        const secretReaders = {
          company: LABEL, committeeKey, read: async () => walletRead(committeeKey),
          roster: async () => [{
            signerId: 'ada', userId: 'ada', name: 'Ada', filingKey: '00'.repeat(32) as never,
            keys: {
              committeeKey, recordsKey: statement.recordsKey as never,
              recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
            },
          }],
        };
        const heldByThem = view({ heldByCommittee: true, why: null, authority: { committee: [committeeKey], threshold: 1, counter: '1', shape: 'committee' } });
        return { secretReaders, heldByThem };
      };
      const pressUnfiled = async (readers: (mine: string) => string[]) => {
        const log: string[] = [];
        const doors = startDoors();
        const mine = recordsKeypairFrom(doors.me.companyKey).publicKey;
        const { secretReaders, heldByThem } = companyOfOne();
        const service = serviceFrom([heldByThem], log, { keys: async () => ({ committee, why: null, readers: readers(mine) }) });
        const e = await createCompanyVault({
          ...pacing, ...walletReadsTheVault, ...doors, secretReaders, account: ACCOUNT, service, builder: unset([])(log), keys: memoryKeys(log).keys,
        }, VAULT).catch((x) => x);
        return { e, log, filed: await doors.records('nonce-secret').get(VAULT) };
      };

      /* RED WHEN the nonce secret is filed before the keys the service lists are checked. */
      it('a key the service slipped onto its list is refused, and no nonce secret is filed for it to open', async () => {
        const { e, log, filed } = await pressUnfiled((mine) => [mine, another]);
        expect(e.name).toBe('VaultStartOwed');
        expect(e.vault).toBe(VAULT);
        expect(e.stoppedAt).toBe('reader-not-a-signer');
        expect(filed).toBeNull();
        expect(log).not.toContain('built a governed call');
      });

      /* RED WHEN the check before filing refuses an honest list: the secret is then never filed and the start stops there. */
      it('an honest list is filed to, and the start goes on to its own copy', async () => {
        const { e, filed } = await pressUnfiled((mine) => [mine]);
        expect(filed).not.toBeNull();
        expect(e.name).toBe('VaultStartOwed');
        expect(e.message).toMatch(/would keep for you does not open/);
      });
    });
  });

});

describe('THE POOL AND A DEPOSIT', () => {
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(3) };
  const stores = () => {
    const s = new Map<WireRecord, MemorySealedPoolStore>();
    return (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const poolDoors = (service: VaultService, records = stores()) => ({
    ...pacing, ...walletReadsTheVault, service, indexer: indexerOf(service), builder: { vaultOnChain: readOnTheDevice }, me, myRecordsKey: 'ff'.repeat(32), records,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
  });

  /* RED WHEN: a nonce secret can be filed with no check of who it is wrapped to - the check made optional again. */
  it('A NONCE SECRET IS NEVER FILED WITHOUT THE CHECK OF WHO IT IS WRAPPED TO', async () => {
    const records = stores();
    const ready = view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] });
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([ready], []), records), VAULT, undefined as never)).rejects.toThrow();
    expect(await records('nonce-secret').get(VAULT)).toBeNull();
    /* RED WHEN: the pool is filed before the check, so the service's refusal of it speaks before the check's own words. */
    const refused = async () => { throw new Error('the readers were refused'); };
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([ready], []), records), VAULT, refused)).rejects.toThrow(/the readers were refused/);
    expect(await records('pool').get(VAULT)).toBeNull();
    expect(await records('nonce-secret').get(VAULT)).toBeNull();
    const seen: string[][] = [];
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], [], { keys: async () => ({ committee, why: null, readers: ['5c'.repeat(32)] }) }), records), VAULT,
      async (readers) => { seen.push([...readers]); });
    expect(seen).toEqual([['5c'.repeat(32)]]);
  });

  it('A POOL IS NOT OPENED FOR A VAULT THE COMMITTEE DOES NOT HOLD, NOR AN EMPTY ONE FOR A VAULT WITH MONEY', async () => {
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([oneKey], [])), VAULT, nothingToCheck)).rejects.toThrow();
    const records = stores();
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([view({ heldByCommittee: true, everCreated: ['01'] })], []), records), VAULT, nothingToCheck))
      .rejects.toThrow(/already put money in this vault and it has no pool/);
    expect(await records('pool').get(VAULT)).toBeNull();
  });

  it('A DEPOSIT INTO A VAULT THE COMMITTEE DOES NOT HOLD IS REFUSED BEFORE A COIN IS CHOSEN', async () => {
    const log: string[] = [];
    const records = stores();
    /* The chain has the vault and its state, so the only thing refusing is who holds it. */
    const stillOurs = view({ ...oneKey, state: 'AAAA', notes: [], everCreated: [] });
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([stillOurs], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 1n })).rejects.toThrow(/not held by the keys that hold your company's account, as the chain shows both/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });

  it('A DEPOSIT INTO A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT, IS REFUSED BEFORE A COIN IS CHOSEN', async () => {
    const log: string[] = [];
    const records = stores();
    const fundableView = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([fundableView], log), records), VAULT, nothingToCheck);
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([fundableView], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      onChain: async (v: string) => ({ ...(await walletReadsTheVault.onChain(v)), holders: { ...(await walletReadsTheVault.onChain(v)).holders, adoptedVaults: [] } }),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x: Error) => x);
    /* RED WHEN: money goes into a vault the service's rows name and the account never adopted. */
    expect((e as Error).message).toMatch(/not one your company's account has adopted/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });

  it('A VAULT THE COMMITTEE HOLDS TAKES NO MONEY WHILE IT IS NOT STARTED, OR WHILE THE COMPANY ACCOUNT IS NOT HELD BY THE SAME KEYS, AND THE WALLET IS NEVER ASKED TO PAY', async () => {
    /* RED WHEN: the `fundable` check in `depositIntoCompanyVault` is removed or moved after the coin is chosen -
     * the log then carries 'build deposit' and 'paid', and the journal holds a coin for a deposit that cannot land. */
    const log: string[] = [];
    const records = stores();
    const notStarted = view({ heldByCommittee: true, fundable: false, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([notStarted], log), records), VAULT, nothingToCheck);
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([notStarted], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n })).rejects.toThrow(/this vault has not been started/);
    /*
     * The company's account still held by the temporary key it was created with, as the signer's own wallet reads it:
     * the vault's committee is not the account's. RED WHEN: who holds the vault is not compared with who holds the
     * account - the vault reads as the committee's and the deposit goes on.
     */
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    const temporary = async (v: string) => ({ holders: { ...(await walletReadsTheVault.onChain(v)).holders, committee: [{ tag: 'schnorr', value: '77'.repeat(32) }] } });
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([ready], log), records), onChain: temporary, company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n })).rejects.toThrow(/not held by the keys that hold your company's account/);
    /* RED WHEN: the vault's threshold is not compared with the account's - one key could then pay out of a vault the account needs two for. */
    const two = async (v: string) => ({ holders: { ...(await walletReadsTheVault.onChain(v)).holders, threshold: 2 } });
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([ready], log), records), onChain: two, company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n })).rejects.toThrow(/not held by the keys that hold your company's account/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });

  it('A DEPOSIT IS BUILT ON THE PARAMETERS THIS DEVICE READ AT THE WALLET\'S INDEXER; WHAT THE SERVICE WOULD SERVE IS NEVER ASKED', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const doors = poolDoors(serviceFrom([ready], log), records);
    await depositIntoCompanyVault({
      ...doors, service: aServiceThatLies(doors.service, asked), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch(() => undefined);
    /* RED WHEN: the deposit's block, or the transaction it is looked for in, is asked of the service. */
    expect(asked).toEqual([]);
    /* RED WHEN: the deposit is built with any parameters but those this device read. */
    expect(log.filter((l) => l.startsWith('build'))).toEqual([`build deposit with ${PARAMS}`]);
  });

  it('A DEPOSIT THE CHAIN HAS NOT SHOWN IS NOT RECORDED IN THE POOL, AND SAYS IT MAY STILL LAND', async () => {
    const log: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([ready], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    /* RED WHEN: the deposit is built with anything but the parameters the block read served, or the block is not read. */
    expect(log).toEqual(['read the block here', `build deposit with ${PARAMS}`, 'paid', 'sent deposit']);
    expect((await records('pool').versions(VAULT)).length).toBe(1);
    expect(await records('deposit-journal').get(VAULT)).not.toBeNull();
  });

  it('A COIN THE LEDGER HAS ALREADY RECORDED IS REFUSED ON THE DEVICE, WITH THE FAST CHECK, BEFORE ANYTHING IS BUILT', async () => {
    /*
     * The vault's history holds the LEDGER'S OWN commitment (`vaultNoteCommitment`, the ledger's general code) of the
     * coin at each slot this deposit may use, and the device asks the worker's own `commitments`, which answers with the
     * vault's compiled commitment. So the refusal below is the fast check recognising what the ledger recorded.
     */
    const real = (log: string[]): VaultBuilderClient => ({
      ...builder(log),
      commitments: async (i) => {
        const a = await answerVaultAsk(async () => ({ vault: vaultModule }) as never, { id: 1, network: 'undeployed', ask: 'commitments', ...i });
        if (!a.ok || a.ask !== 'commitments') throw new Error('the worker did not answer the commitments');
        return { output: a.output, held: a.held };
      },
    });
    const money = { token: 'ab'.repeat(32) as never, value: 7n };
    const coinAt = async (records: ReturnType<typeof stores>, slot: number) => {
      const opened = openNonceSecrets((await records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(me.companyKey));
      const nonce = depositNonceAt(currentDepositNonceKey(opened), money, slot);
      return { nonce, token: money.token, value: money.value };
    };
    /* Three coins the chain made, at slots 1, 2 and 3, and the vault holds the coins at 4, 5 and 6 now: with three
     * outputs in the history, 6 is the last slot a deposit may use. */
    const records = stores();
    const empty = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([empty], []), records), VAULT, nothingToCheck);
    const madeAt = async (slots: number[]) => Promise.all(slots.map(async (n) => vaultNoteCommitment(await coinAt(records, n), VAULT as never)));
    const log: string[] = [];
    const heldAt = async (slots: number[]) => Promise.all(slots.map(async (n) => (await real([]).commitments({
      vault: VAULT, coin: { ...(await coinAt(records, n)), value: money.value.toString() },
    })).held));
    const taken = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: await heldAt([4, 5, 6]), everCreated: await madeAt([1, 2, 3]) });
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([taken], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: real(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, money).catch((x) => x);
    /* RED WHEN: the worker's `output` is not the ledger's commitment (the held one, say), or the history is not asked. */
    expect(e).toBeInstanceOf(DepositCoinAlreadyMade);
    expect(log, 'RED WHEN: a coin the ledger has recorded reaches the builder or the wallet').toEqual(['read the block here']);

    /* Two of the three taken: the deposit moves to the free slot and builds with that coin. */
    const log2: string[] = [];
    const built: string[] = [];
    const two = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [...await madeAt([1, 3]), 'f1'.repeat(32)] });
    await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([two], log2), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(),
      builder: { ...real(log2), deposit: async (i) => { built.push(i.coin.nonce); return { tx: 'P' }; } },
      pay: async () => ({ transaction: 'X', leaves: [] }),
    }, VAULT, money).catch(() => undefined);
    expect(built, 'RED WHEN: a slot whose coin the ledger recorded is used, or a free one is skipped').toEqual([(await coinAt(records, 2)).nonce]);
  });

  it('A DEPOSIT WHOSE CHAIN PARAMETERS CANNOT BE READ CHOOSES NO COIN, BUILDS NOTHING AND ASKS NO WALLET', async () => {
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    const COULD_NOT_READ = /^the chain's current parameters could not be read for this vault, so no coin was chosen and nothing was built or sent/;
    const ANSWERED_WRONGLY = /^the chain your wallet reads answered with something other than this vault's current parameters \(.+\), so no coin was chosen and nothing was built or sent/;
    const refusals: Array<[string, Partial<ChainBehind>]> = [
      ['the block cannot be read', { payoutState: async () => { throw new Error('the chain could not be read'); } }],
      ['the block names no parameters', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: '', accountState: 'A' }) }],
      ['the block\'s parameters are not parameters', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: btoa('not parameters at all, just bytes'), accountState: 'A' }) }],
      ['the block\'s parameters are not base64', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: '%%%%', accountState: 'A' }) }],
    ];
    for (const [why, over] of refusals) {
      const log: string[] = [];
      const records = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      /* RED WHEN: the parameters are read after the coin is chosen, or a failed or foreign read is let through -
       * the journal then holds a coin, and the log carries 'build deposit' or 'paid'. */
      const said = await depositIntoCompanyVault({
        ...poolDoors(serviceFrom([ready], log, over), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).then(() => 'it went ahead', (x: Error) => x.message);
      /* RED WHEN: a block that cannot be read is called an answer the service got wrong, or the other way round. */
      expect(said, why).toMatch(why === 'the block cannot be read' ? COULD_NOT_READ : ANSWERED_WRONGLY);
      /* RED WHEN: any of a deposit's own refusals is worded for a payment. */
      expect(said, why).not.toMatch(/paid out|payment/i);
      expect(log.filter((l) => l !== 'read the block here'), why).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), why).toBeNull();
    }
  });

  it('A DEPOSIT\'S REFUSAL CARRIES NONE OF THE PAYMENT ROUTE\'S WORDS WHEN THE BLOCK CANNOT BE READ', async () => {
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    /* What the route the block is read through answers when it refuses, word for word. */
    const routeSays = [
      'this company has no contract on the chain this service can read, so nothing can be paid out.',
      'this deployment reads no chain, so nothing can be paid out.',
      'the chain could not be read for this payment: the indexer is down',
    ];
    for (const said of routeSays) {
      const log: string[] = [];
      const records = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      const e = await depositIntoCompanyVault({
        ...poolDoors(serviceFrom([ready], log, { payoutState: async () => { throw new Error(said); } }), records),
        company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x: Error) => x);
      expect((e as Error).message, said).toMatch(/current parameters could not be read.*no coin was chosen/);
      /* RED WHEN: the route's own refusal is carried into the deposit's, so a deposit says nothing can be paid out. */
      expect((e as Error).message, said).not.toMatch(/paid out|payment/i);
      expect(log.filter((l) => l !== 'read the block here'), said).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), said).toBeNull();
    }
  });

  it('PARAMETERS OF A VERSION THIS PAGE DOES NOT BUILD WITH ARE REFUSED BEFORE A COIN\'S JOURNAL LINE IS FILED', async () => {
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    for (const other of ['v7', 'v9', 'v80', 'v']) {
      const log: string[] = [];
      const records = stores();
      const served = btoa(`midnight:ledger-parameters[${other}]:stand-in`);
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      const e = await depositIntoCompanyVault({
        ...poolDoors(serviceFrom([ready], log, {
          payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: served, accountState: 'A' }),
        }), records),
        company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x: Error) => x);
      /* RED WHEN: only the header's start is checked, so another version reaches the worker after the journal line is filed. */
      expect((e as Error).message, other).toMatch(/different ledger version from the one this page builds deposits with, so no coin was chosen, nothing was built or sent/);
      expect((e as Error).message, other).not.toMatch(/paid out|payment/i);
      expect(log.filter((l) => l !== 'read the block here'), other).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), other).toBeNull();
    }
  });
});

describe('A DEPOSIT THAT DOES NOT FINISH', () => {
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(5) };
  const MONEY = { token: 'ab'.repeat(32) as never, value: 7n };
  const HASH = 'e1'.repeat(32);
  type Coin = { nonce: string; token: string; value: string };
  /* Each commitment is over the whole coin, as the ledger's is: a coin read back with the wrong token or value matches nothing. */
  const outputOf = (c: Coin) => `out:${c.nonce}:${c.token}:${c.value}`;
  const heldOf = (c: Coin) => `held:${c.nonce}:${c.token}:${c.value}`;
  /** A chain this test moves by hand: what the vault holds, what it ever made, and each transaction's events. */
  const world = () => {
    const w = {
      notes: [] as string[], everCreated: [] as string[],
      events: new Map<string, Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>>(),
      sent: [] as string[], asked: [] as string[], built: [] as Coin[], eventReads: 0,
      depositAnswer: { txRef: 'p', transactionHash: HASH as string | null },
      sendFails: null as null | Error,
      lookups: 0, historyUnreadable: false,
    };
    const service = serviceFrom([], w.asked, {
      chain: async () => view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [...w.notes], everCreated: [...w.everCreated] }),
      deposit: async (_v, tx) => { if (w.sendFails) throw w.sendFails; w.sent.push(tx); return w.depositAnswer; },
      events: async (_v, tx) => {
        w.eventReads += 1;
        const e = w.events.get(tx);
        if (e === undefined) throw new Error('the indexer does not hold this transaction yet');
        return { events: e };
      },
      /* The vault's own history, newest first, searched by an output's commitment. */
      createdBy: async (_v, commitment) => {
        w.lookups += 1;
        if (w.historyUnreadable) throw new Error('the indexer could not list this vault\'s transactions');
        for (const [hash, events] of [...w.events].reverse()) {
          if (events.some((e) => e.details.tag === 'zswapOutput' && e.details.commitment === commitment && e.details.contract === VAULT)) {
            return { transactionHash: hash, events };
          }
        }
        return null;
      },
    });
    const b: VaultBuilderClient = {
      ...builder([]),
      deposit: async (i) => { w.built.push(i.coin); return { tx: `P${w.built.length}` }; },
      commitments: async (i) => ({ output: outputOf(i.coin), held: heldOf(i.coin) }),
    };
    /** The chain takes the deposit of `coin` in transaction `hash`. */
    const lands = (coin: Coin, hash = HASH) => {
      w.notes.push(heldOf(coin));
      w.everCreated.push(outputOf(coin));
      w.events.set(hash, [{ transactionHash: hash, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' } }]);
    };
    return { w, service, b, lands };
  };
  const stores = () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    return (r: WireRecord) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const setUp = async () => {
    const t = world();
    const records = stores();
    const kept = new Map<string, Kept<DepositInFlight>>();
    let now = 1_000_000;
    const doors = {
      ...pacing, ...walletReadsTheVault, service: t.service, indexer: indexerOf(t.service), me, myRecordsKey: 'ff'.repeat(32), records,
      signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
      company: LABEL, account: ACCOUNT, builder: t.b, inFlight: inFlightInMemory(kept), clock: () => now,
      pay: async (ask: { transaction: string }) => ({ transaction: `${ask.transaction}+coins`, leaves: [] }),
    };
    await openCompanyVaultPool(doors, VAULT, nothingToCheck);
    const pool = new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret },
      async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }]);
    return { ...t, doors, records, kept, pool, later: (ms: number) => { now += ms; } };
  };

  it('A DEPOSIT ON ITS WAY IS FOUND BY WHAT THIS DEVICE READ AT THE WALLET\'S INDEXER, BY ITS NAME OR BY ITS OUTPUT; THE SERVICE IS NEVER ASKED', async () => {
    for (const named of [HASH, null]) {
      const t = await setUp();
      t.w.depositAnswer = { txRef: 'p', transactionHash: named };
      const asked: string[] = [];
      const doors = { ...t.doors, service: aServiceThatLies(t.doors.service, asked) };
      await depositIntoCompanyVault(doors, VAULT, MONEY).catch(() => undefined);
      t.lands(t.w.built[0]!);
      const reads = [t.w.eventReads, t.w.lookups];
      expect(await settleDepositInFlight(doors, VAULT), String(named)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });
      /* RED WHEN: the transaction a deposit landed in is asked of the service, by its name or by its output. */
      expect(asked, String(named)).toEqual([]);
      /* RED WHEN: the deposit is recorded without the chain being read here - by name when the send named one, else by its output. */
      expect([t.w.eventReads - reads[0]! > 0, t.w.lookups - reads[1]! > 0], String(named)).toEqual(named === null ? [false, true] : [true, false]);
    }
  });

  it('A DEPOSIT THE WALLET FINISHED AND THE SERVICE REFUSED TO SEND SAYS NO MONEY MOVED, AND LEAVES NOTHING IN FLIGHT', async () => {
    const t = await setUp();
    t.w.sendFails = Object.assign(new Error('the fee payer would not take it'), { nothingWasSent: true });
    const e = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a refused send is reported as a deposit that may still land, or the page stops saying the wallet may hold coins. */
    expect(e).toBeInstanceOf(DepositNotSent);
    expect((e as Error).message).toMatch(/no money moved.*wallet may show part of its balance as held/);
    expect(t.kept.size, 'RED WHEN: a deposit that was never sent is kept in flight, so the next one is refused for nothing').toBe(0);
    const failing = await setUp();
    const walletSaidNo = await depositIntoCompanyVault({ ...failing.doors, pay: async () => { throw new Error('the person closed the wallet'); } }, VAULT, MONEY).catch((x) => x);
    expect((walletSaidNo as Error).message).toMatch(/closed the wallet/);
    expect(failing.kept.size, 'RED WHEN: a deposit the wallet never finished is kept in flight').toBe(0);
  });

  it('A SEND THAT MAY HAVE LANDED IS KEPT IN FLIGHT, BEFORE THE WALLET IS ASKED, AND SAYS THE MONEY MAY HAVE MOVED', async () => {
    const t = await setUp();
    let keptBeforeTheWallet = false;
    t.w.sendFails = new Error('the connection dropped');
    const e = await depositIntoCompanyVault({
      ...t.doors, pay: async (ask) => { keptBeforeTheWallet = t.kept.size === 1; return { transaction: `${ask.transaction}+coins`, leaves: [] }; },
    }, VAULT, MONEY).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    expect((e as Error).message).toMatch(/^the deposit may have been sent/);
    expect(keptBeforeTheWallet, 'RED WHEN: the record of the deposit is written after the wallet is asked, so a closed page loses it').toBe(true);
    expect([...t.kept.values()].map((d) => d.coin), 'RED WHEN: a send that may have landed is forgotten').toEqual([t.w.built[0]]);
  });

  it('A DEPOSIT, ITS WAIT AND ITS SETTLING READ THE VAULT ON THIS DEVICE, AND THE SERVICE IS NEVER ASKED WHAT THE VAULT HOLDS', async () => {
    const t = await setUp();
    const asked = { n: 0 };
    const doors = theServiceNeverAsked(t.doors, asked);
    /* RED WHEN: the deposit, or its wait for the note, reads the vault through the service's chain route. */
    await expect(depositIntoCompanyVault(doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    t.lands(t.w.built[0]!);
    /* RED WHEN: settling on its own reads the vault through the service's chain route. */
    expect(await settleDepositInFlight(doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });
    expect(asked.n).toBe(0);
  });

  it('A DEPOSIT INTO A VAULT PINNED TO ANOTHER ACCOUNT, OR WHOSE STATE NAMES NONE, IS REFUSED BEFORE A COIN IS CHOSEN', async () => {
    const t = await setUp();
    for (const account of ['dd'.repeat(32), null]) {
      const b = { ...t.b, vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => ({ ...(await t.b.vaultOnChain(i)), account }) as never };
      /* RED WHEN: the account the vault is pinned to is not compared with the company's - its money would be paid out on somebody else's approvals. */
      await expect(depositIntoCompanyVault({ ...t.doors, builder: b }, VAULT, MONEY)).rejects.toThrow(/not pinned to your company's account, or its state is not a vault's/);
    }
    expect([t.w.built.length, t.w.sent.length, t.kept.size]).toEqual([0, 0, 0]);
  });

  it('A READ OF THE VAULT THAT FAILS ONCE THE DEPOSIT IS SENT SAYS IT MAY HAVE LANDED, NEVER THAT NOTHING WAS SENT', async () => {
    const t = await setUp();
    let reads = 0;
    const b = {
      ...t.b,
      vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => {
        reads += 1;
        if (reads > 1) throw new Error('the indexer did not answer');
        return t.b.vaultOnChain(i);
      },
    };
    const e = await depositIntoCompanyVault({ ...t.doors, builder: b }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a read that fails while waiting for a sent deposit escapes as VaultNotReadHere, which says nothing was sent. */
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    expect([t.w.sent.length, t.kept.size], 'the deposit was sent and is kept on its way').toEqual([1, 1]);
  });

  it('WHAT THE SERVICE SAYS THE VAULT HOLDS IS NOT BELIEVED: A NOTE ONLY ITS ANSWER SHOWS IS NOT RECORDED', async () => {
    const t = await setUp();
    await expect(depositIntoCompanyVault(t.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    const coin = t.w.built[0]!;
    const lying = {
      ...t.doors,
      service: { ...t.service, chain: async () => view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [heldOf(coin)], everCreated: [outputOf(coin)] }) },
    };
    /* RED WHEN: settling believes the service's notes - a deposit the chain does not hold is recorded as the vault's. */
    await expect(settleDepositInFlight(lying, VAULT)).rejects.toBeInstanceOf(DepositStillInFlight);
    expect((await t.pool.load(VAULT)).notes).toEqual([]);
  });

  it('A WALLET THAT NAMES NO INDEXER, OR A READ THAT FAILS ON THIS DEVICE: REFUSED BY NAME, NOTHING CHOSEN, KEPT OR SENT, AND THE SERVICE NOT ASKED IN ITS PLACE', async () => {
    const t = await setUp();
    const asked = { n: 0 };
    const e = await depositIntoCompanyVault({ ...theServiceNeverAsked(t.doors, asked), indexer: async () => null }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a wallet that names no indexer falls back to the service's answer, or the refusal does not say what resolves it. */
    expect(e).toBeInstanceOf(VaultNotReadHere);
    expect((e as Error).message).toMatch(/^your wallet did not say which indexer .* Unlock your wallet for this company again, then try again\. The company's service is not asked in its place\. Nothing was sent\.$/);
    const unread = await depositIntoCompanyVault({
      ...theServiceNeverAsked(t.doors, asked), builder: { ...t.b, vaultOnChain: async () => { throw new Error('the indexer did not answer'); } },
    }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a read that failed on this device is answered from the service instead. */
    expect(unread).toBeInstanceOf(VaultNotReadHere);
    expect((unread as Error).message).toMatch(/could not read the vault from the chain \(the indexer did not answer\)/);
    expect([t.w.built.length, t.w.sent.length, t.kept.size, asked.n]).toEqual([0, 0, 0, 0]);
  });

  it('A DEPOSIT NOT YET SEEN IS FOUND WHEN IT LANDS: THE NEXT DEPOSIT RECORDS IT FIRST, UNDER ITS OWN TRANSACTION, AND THE POOL MATCHES THE CHAIN', async () => {
    const t = await setUp();
    const first = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    expect(first).toBeInstanceOf(DepositNotYetSeen);
    expect((await t.pool.load(VAULT)).notes, 'the note is not recorded before the chain holds it').toEqual([]);
    const firstCoin = t.w.built[0]!;
    t.lands(firstCoin);
    /* The same money again: its lowest slot is now the first deposit's, which is taken. */
    const second = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    const notes = (await t.pool.load(VAULT)).notes;
    /* RED WHEN: nothing looks for the earlier deposit again - the pool then never holds the note the chain does. */
    expect(notes.find((n) => n.nonce === firstCoin.nonce), 'RED WHEN: the earlier deposit is not recorded once it lands')
      .toMatchObject({ nonce: firstCoin.nonce, value: 7n, createdIn: HASH });
    expect(second, 'the second deposit then goes ahead, and is itself not yet seen').toBeInstanceOf(DepositNotYetSeen);
    expect(t.w.built, 'RED WHEN: the second deposit is not built').toHaveLength(2);
    expect(t.w.built[1]!.nonce, 'RED WHEN: the second deposit of the same money is built from the coin the first one made').not.toBe(firstCoin.nonce);
    /* The pool holds exactly what the chain holds of these deposits. */
    expect(notes.map((n) => heldOf({ nonce: n.nonce, token: n.token, value: n.value.toString() })).sort()).toEqual([...t.w.notes].sort());
  });

  it('AN EARLIER DEPOSIT THAT HAS LANDED IS RECORDED EVEN WHEN THIS ONE IS REFUSED FOR THE CHAIN\'S LEDGER VERSION', async () => {
    const t = await setUp();
    const first = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    expect(first).toBeInstanceOf(DepositNotYetSeen);
    const firstCoin = t.w.built[0]!;
    t.lands(firstCoin);
    const otherVersion = btoa('midnight:ledger-parameters[v9]:stand-in');
    const builder = { ...t.doors.builder, chainAtOneBlock: async () => ({ blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: otherVersion, accountState: 'A' }) };
    const second = await depositIntoCompanyVault({ ...t.doors, builder }, VAULT, MONEY).catch((x) => x);
    expect((second as Error).message).toMatch(/different ledger version/);
    /* RED WHEN: the ledger version is checked before the earlier deposit is settled, so a landed note waits for a page update. */
    expect((await t.pool.load(VAULT)).notes.find((n) => n.nonce === firstCoin.nonce), 'the landed deposit was not recorded')
      .toMatchObject({ nonce: firstCoin.nonce, value: 7n, createdIn: HASH });
    expect(t.w.built, 'the refused deposit was built').toHaveLength(1);
  });

  it('WHILE AN EARLIER DEPOSIT CAN STILL LAND, NO SECOND ONE IS BUILT; ONCE IT CAN NO LONGER LAND, IT IS LET GO', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    const before = (await t.records('deposit-journal').versions(VAULT)).length;
    const e = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a second deposit of the same money is built while the first is unresolved - the same coin, refused after its fee. */
    expect(e).toBeInstanceOf(DepositStillInFlight);
    expect(t.w.built, 'nothing is built for the second deposit').toHaveLength(1);
    expect((await t.records('deposit-journal').versions(VAULT)).length, 'no line is filed for it').toBe(before);
    t.later(DEPOSIT_TIME_TO_LIVE_MS - 1);
    await expect(settleDepositInFlight(t.doors, VAULT), 'RED WHEN: a deposit is let go before it can no longer land').rejects.toBeInstanceOf(DepositStillInFlight);
    t.later(2);
    expect(await settleDepositInFlight(t.doors, VAULT)).toEqual({ state: 'never-landed' });
    expect(t.kept.size).toBe(0);
    expect((await t.pool.load(VAULT)).notes, 'RED WHEN: a deposit that never landed is recorded').toEqual([]);
  });

  it('A FOLLOW-UP RECORDS ONLY WHAT THE VAULT HOLDS, AND ONLY UNDER A TRANSACTION WHOSE EVENTS SHOW IT', async () => {
    /* The chain made the coin and the vault's notes, read a moment apart, do not show it: nothing is recorded, and it is kept. */
    const apart = await setUp();
    await depositIntoCompanyVault(apart.doors, VAULT, MONEY).catch(() => undefined);
    apart.w.everCreated.push(outputOf(apart.w.built[0]!));
    apart.later(DEPOSIT_TIME_TO_LIVE_MS * 2);
    await expect(settleDepositInFlight(apart.doors, VAULT)).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await apart.pool.load(VAULT)).notes, 'RED WHEN: a note the vault\'s notes do not hold is recorded').toEqual([]);
    expect(apart.kept.size, 'RED WHEN: a deposit the chain made is forgotten before it is recorded, however long ago it was sent').toBe(1);
    apart.w.notes.push(heldOf(apart.w.built[0]!));
    apart.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: outputOf(apart.w.built[0]!), contract: VAULT, mtIndex: '4' } }]);
    expect(await settleDepositInFlight(apart.doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });

    /* The vault holds it and the transaction the service named shows some other coin: the note is recorded, with no transaction. */
    const other = await setUp();
    await depositIntoCompanyVault(other.doors, VAULT, MONEY).catch(() => undefined);
    other.w.notes.push(heldOf(other.w.built[0]!));
    other.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: 'ff'.repeat(32), contract: VAULT, mtIndex: '1' } }]);
    const settled = await settleDepositInFlight(other.doors, VAULT);
    expect(settled.state).toBe('recorded');
    const [note] = (await other.pool.load(VAULT)).notes;
    expect(note?.createdIn, 'RED WHEN: a transaction whose events do not show the note is recorded as its creator').toBeUndefined();
    expect((settled as { notYetSpendable?: string }).notYetSpendable, 'RED WHEN: a note that cannot be paid out yet is recorded silently')
      .toMatch(/does not show this deposit/);

    /* The service could not name the transaction and the vault's history does not list one yet: nothing is recorded, and it is kept. */
    const nameless = await setUp();
    nameless.w.depositAnswer = { txRef: 'p', transactionHash: null };
    const waited = await depositIntoCompanyVault({ ...nameless.doors, pay: async (ask) => {
      nameless.w.notes.push(heldOf(nameless.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY).catch((x) => x);
    expect(waited, 'RED WHEN: a note is recorded under a transaction nothing established').toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await nameless.pool.load(VAULT)).notes).toEqual([]);
    expect(nameless.kept.size).toBe(1);
  });

  it('A DEPOSIT WHOSE SEND GAVE NO HASH IS RECORDED UNDER ITS CREATING TRANSACTION ONCE IT LANDS, FOUND BY ITS OWN OUTPUT', async () => {
    const LANDED_IN = 'e7'.repeat(32);
    /* The service answered without a hash, and the vault's history lists the transaction by the time the note shows. */
    const nameless = await setUp();
    nameless.w.depositAnswer = { txRef: 'p', transactionHash: null };
    const done = await depositIntoCompanyVault({ ...nameless.doors, pay: async (ask) => {
      nameless.lands(nameless.w.built[0]!, LANDED_IN);
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY);
    /* RED WHEN: the page stops looking the transaction up by the deposit's output - the note is then recorded with none. */
    expect(done.note.createdIn, 'RED WHEN: a deposit with no hash from its send is recorded without its creating transaction').toBe(LANDED_IN);
    expect(done.notYetSpendable).toBeUndefined();
    expect(nameless.kept.size).toBe(0);

    /* The answer to the send was lost altogether and the page was closed; the next look from this browser records it. */
    const dropped = await setUp();
    dropped.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(dropped.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    dropped.lands(dropped.w.built[0]!, LANDED_IN);
    const settled = await settleDepositInFlight(dropped.doors, VAULT);
    expect(settled, 'RED WHEN: a deposit whose send outcome was unknown lands and is recorded with no creating transaction')
      .toMatchObject({ state: 'recorded', note: { createdIn: LANDED_IN } });
    expect((await dropped.pool.load(VAULT)).notes[0]?.createdIn).toBe(LANDED_IN);

    /* Another vault's output under the same commitment is not this deposit's: the vault worker refuses it, so it is not recorded under it. */
    const foreign = await setUp();
    foreign.w.sendFails = new Error('the connection dropped');
    await depositIntoCompanyVault(foreign.doors, VAULT, MONEY).catch(() => undefined);
    const coin = foreign.w.built[0]!;
    foreign.w.notes.push(heldOf(coin));
    foreign.w.everCreated.push(outputOf(coin));
    foreign.w.events.set(LANDED_IN, [
      { transactionHash: LANDED_IN, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' } },
      { transactionHash: LANDED_IN, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: 'ee'.repeat(32), mtIndex: '5' } },
    ]);
    const refused = await settleDepositInFlight(foreign.doors, VAULT);
    expect((await foreign.pool.load(VAULT)).notes[0]?.createdIn,
      'RED WHEN: the page records a transaction the vault worker did not establish').toBeUndefined();
    expect((refused as { notYetSpendable?: string }).notYetSpendable).toMatch(/does not show this deposit/);
  });

  it('A DEPOSIT THE VAULT HOLDS WHOSE TRANSACTION CANNOT BE READ YET IS NOT RECORDED UNTIL IT CAN BE, OR UNTIL ITS TIME TO LIVE HAS PASSED', async () => {
    const t = await setUp();
    const e = await depositIntoCompanyVault({ ...t.doors, pay: async (ask) => {
      /* The note lands at once, and the indexer has not got the transaction's events. */
      t.w.notes.push(heldOf(t.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: the note is recorded with the service's hash before the chain's events confirm it. */
    expect(e).toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await t.pool.load(VAULT)).notes).toEqual([]);
    expect(t.kept.size, 'RED WHEN: it is forgotten while its note is unrecorded').toBe(1);
    await expect(settleDepositInFlight(t.doors, VAULT)).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
    /* Past its time to live, with the events still unreadable: recorded without a transaction, rather than blocking every later deposit. */
    t.later(DEPOSIT_TIME_TO_LIVE_MS + 1);
    const gaveUp = await settleDepositInFlight(t.doors, VAULT);
    expect(gaveUp, 'RED WHEN: a note the vault holds is kept waiting for ever on a transaction nobody can read')
      .toMatchObject({ state: 'recorded', notYetSpendable: expect.stringMatching(/could not read the transfer/) });
    expect((await t.pool.load(VAULT)).notes[0]?.createdIn).toBeUndefined();
    expect(t.kept.size).toBe(0);

    /* And when the events do come in time, the note is recorded under its own transaction. */
    const u = await setUp();
    await depositIntoCompanyVault({ ...u.doors, pay: async (ask) => {
      u.w.notes.push(heldOf(u.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY).catch(() => undefined);
    u.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: outputOf(u.w.built[0]!), contract: VAULT, mtIndex: '4' } }]);
    expect(await settleDepositInFlight(u.doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });
    expect(u.kept.size).toBe(0);
  });

  it('EVENTS THE VAULT WORKER CANNOT JUDGE, OR CANNOT JUDGE YET, LEAVE THE DEPOSIT UNRECORDED UNTIL THEY CAN BE, OR UNTIL ITS TIME TO LIVE HAS PASSED', async () => {
    const judges: Array<VaultBuilderClient['creatingTransaction']> = [
      async () => { throw new Error('the part of this page that builds vault transactions stopped'); },
      async () => ({ state: 'unreadable' }),
    ];
    for (const judge of judges) {
      const t = await setUp();
      t.b.creatingTransaction = judge;
      await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
      t.lands(t.w.built[0]!);
      await expect(settleDepositInFlight(t.doors, VAULT),
        'RED WHEN: a deposit whose events were not judged is recorded, or reported as never showing it').rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
      expect((await t.pool.load(VAULT)).notes).toEqual([]);
      expect(t.kept.size).toBe(1);
      t.later(DEPOSIT_TIME_TO_LIVE_MS + 1);
      expect(await settleDepositInFlight(t.doors, VAULT), 'RED WHEN: an unjudged transaction is given the words of a refused one')
        .toMatchObject({ state: 'recorded', notYetSpendable: expect.stringMatching(/could not read the transfer/) });
    }
  });

  it('EVENTS SERVED UNDER ANOTHER TRANSACTION\'S HASH DO NOT NAME THE DEPOSIT\'S', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    t.lands(t.w.built[0]!);
    t.w.events.set(HASH, t.w.events.get(HASH)!.map((e) => ({ ...e, transactionHash: 'e2'.repeat(32) })));
    const settled = await settleDepositInFlight(t.doors, VAULT);
    expect((await t.pool.load(VAULT)).notes[0]?.createdIn,
      'RED WHEN: the page names the transaction from the events it was served rather than the one the service named').toBeUndefined();
    expect((settled as { notYetSpendable?: string }).notYetSpendable).toMatch(/does not show this deposit/);
  });

  it('THE VAULT WORKER NAMES THE CREATING TRANSACTION, REFUSES ONE WHOSE EVENTS DO NOT SHOW THE NOTE, AND CALLS NO EVENTS UNREADABLE', async () => {
    const own = [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: 'aa'.repeat(32), contract: VAULT, mtIndex: '4' } }];
    const ask = (commitment: string, events: typeof own) => answerVaultAsk(async () => ({}) as never, {
      id: 3, network: 'undeployed', ask: 'creating-transaction', vault: VAULT, commitment, transactionHash: HASH, events,
    });
    expect(await ask('aa'.repeat(32), own), 'RED WHEN: the worker does not name the transaction its events show')
      .toEqual({ id: 3, ok: true, ask: 'creating-transaction', answer: { state: 'found', createdIn: HASH } });
    expect((await ask('bb'.repeat(32), own) as { answer: unknown }).answer, 'RED WHEN: events that do not show the note are not a refusal')
      .toEqual({ state: 'refused' });
    const another = own.map((e) => ({ ...e, transactionHash: 'e2'.repeat(32) }));
    expect((await ask('aa'.repeat(32), another) as { answer: unknown }).answer,
      'RED WHEN: events from a transaction other than the one named are taken as its own').toEqual({ state: 'refused' });
    expect(creatingTransactionOfNote({ vault: VAULT, commitment: 'aa'.repeat(32), transactionHash: HASH, events: [] }),
      'RED WHEN: no events at all is judged a refusal, which would record the note as never shown').toEqual({ state: 'unreadable' });

    /* Through the page's own client, with every answer copied as a message between threads is. */
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const client = vaultBuilderOver({
      postMessage: (m) => {
        void answerVaultAsk(async () => ({}) as never, m as never).then((a) => listeners.forEach((l) => l({ data: structuredClone(a) })));
      },
      addEventListener: (_type, l) => { listeners.push(l); },
    }, 'undeployed');
    expect(await client.creatingTransaction({ vault: VAULT, commitment: 'aa'.repeat(32), transactionHash: HASH, events: own }),
      'RED WHEN: the page\'s client does not carry the worker\'s answer back').toEqual({ state: 'found', createdIn: HASH });
    expect(await client.creatingTransaction({ vault: VAULT, commitment: 'bb'.repeat(32), transactionHash: HASH, events: own }))
      .toEqual({ state: 'refused' });
  });

  it('A NOTE ANOTHER SIGNER ALREADY RECORDED IS NOT RECORDED TWICE, AND IS SETTLED WITHOUT ASKING THE CHAIN', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    const coin = t.w.built[0]!;
    t.lands(coin);
    const now = await t.pool.load(VAULT);
    await t.pool.save(VAULT, { notes: [...now.notes, { nonce: coin.nonce as never, token: MONEY.token, value: 7n, createdIn: HASH as never }] }, now.readAt);
    const reads = t.w.eventReads;
    expect(await settleDepositInFlight(t.doors, VAULT)).toEqual({ state: 'already-recorded' });
    expect(t.w.eventReads, 'RED WHEN: a deposit already in the record still waits on the chain\'s events').toBe(reads);
    expect((await t.pool.load(VAULT)).notes, 'RED WHEN: a note already in the record is added again').toHaveLength(1);
    expect(t.kept.size).toBe(0);
  });
});

describe('WHAT THIS BROWSER LAST SENT, CHECKED ON ITS OWN, AND TWO TABS OR TWO BROWSERS AT ONCE', () => {
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(6) };
  const MONEY = { token: 'ab'.repeat(32) as never, value: 9n };
  const LANDED_IN = 'e9'.repeat(32);
  type Coin = { nonce: string; token: string; value: string };
  const outputOf = (c: Coin) => `out:${c.nonce}:${c.token}:${c.value}`;
  const heldOf = (c: Coin) => `held:${c.nonce}:${c.token}:${c.value}`;
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  /** One chain and one company's records, shared by every browser a test opens on them. */
  const company = async () => {
    const w = { notes: [] as string[], everCreated: [] as string[], built: [] as Coin[], sent: 0, asked: 0,
      events: new Map<string, Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>>(),
      answer: { txRef: 'p', transactionHash: null as string | null }, sendFails: null as Error | null, paidFor: [] as string[] };
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    const records = (r: WireRecord) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
    const service = serviceFrom([], [], {
      chain: async () => view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [...w.notes], everCreated: [...w.everCreated] }),
      deposit: async () => { if (w.sendFails) throw w.sendFails; w.sent += 1; return w.answer; },
      events: async (_v, tx) => {
        const e = w.events.get(tx);
        if (e === undefined) throw new Error('the indexer does not hold this transaction yet');
        return { events: e };
      },
      createdBy: async (_v, commitment) => {
        for (const [hash, events] of w.events) {
          if (events.some((e) => e.details.commitment === commitment && e.details.contract === VAULT)) return { transactionHash: hash, events };
        }
        return null;
      },
    });
    const b: VaultBuilderClient = {
      ...builder([]),
      deposit: async (i) => { w.built.push(i.coin); return { tx: `P${w.built.length}` }; },
      commitments: async (i) => ({ output: outputOf(i.coin), held: heldOf(i.coin) }),
    };
    const lands = (coin: Coin, hash = LANDED_IN) => {
      w.notes.push(heldOf(coin));
      w.everCreated.push(outputOf(coin));
      w.events.set(hash, [{ transactionHash: hash, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' } }]);
    };
    /** One browser: its own place for what it has on its way, and the company's records. */
    const browser = (kept = new Map<string, Kept<DepositInFlight>>()) => ({
      kept,
      doors: {
        ...pacing, ...walletReadsTheVault, service, indexer: indexerOf(service), me, myRecordsKey: 'ff'.repeat(32), records, signers, company: LABEL, account: ACCOUNT, builder: b,
        inFlight: inFlightInMemory<DepositInFlight>(kept), payments: inFlightInMemory<PaymentInFlight>(),
        pay: async (ask: { transaction: string }) => {
          w.asked += 1;
          w.paidFor.push(ask.transaction);
          return { transaction: `${ask.transaction}+coins`, leaves: [] };
        },
      },
    });
    const first = browser();
    await openCompanyVaultPool(first.doors, VAULT, nothingToCheck);
    const pool = new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    return { w, records, lands, browser, first, pool };
  };

  it('CHECK MY LAST DEPOSIT SETTLES A DEPOSIT ON ITS WAY WITHOUT A NEW ONE, AND SAYS WHAT IT FOUND', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    const [built, asked] = [c.w.built.length, c.w.asked];
    const before = await checkWhatThisBrowserSent(c.first.doors, VAULT);
    expect(before.deposit.state, 'RED WHEN: the check lets go of a deposit that can still arrive').toBe('still-on-its-way');
    expect(sayWhatTheCheckFound(before)).toMatch(/has not reached the vault yet/);
    c.lands(c.w.built[0]!);
    const found = await checkWhatThisBrowserSent(c.first.doors, VAULT);
    /* RED WHEN: the check does not settle the deposit in flight, or settles it without its creating transaction. */
    expect(found.deposit).toMatchObject({ state: 'recorded', note: { createdIn: LANDED_IN } });
    expect((await c.pool.load(VAULT)).notes.map((n) => n.createdIn)).toEqual([LANDED_IN]);
    expect([c.w.built.length, c.w.asked, c.w.sent], 'RED WHEN: checking builds, asks the wallet or sends anything').toEqual([built, asked, 0]);
    expect(c.first.kept.size).toBe(0);
    expect(sayWhatTheCheckFound(found)).toBe('Your last deposit from this browser has reached the vault and is now in its record.');
    expect(sayWhatTheCheckFound(await checkWhatThisBrowserSent(c.first.doors, VAULT)))
      .toBe('This browser has no deposit into this vault waiting to be seen.');
  });

  it('CHECK MY LAST DEPOSIT READS THE VAULT ON THIS DEVICE, AND NEVER ASKS THE SERVICE WHAT IT HOLDS', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.lands(c.w.built[0]!);
    const asked = { n: 0 };
    /* RED WHEN: the check reads the vault through the service's chain route. */
    const found = await checkWhatThisBrowserSent(theServiceNeverAsked(c.first.doors, asked), VAULT);
    expect(found.deposit).toMatchObject({ state: 'recorded' });
    expect(asked.n).toBe(0);
  });

  it('CHECK MY LAST DEPOSIT NAMES A NOTE THE RECORD HOLDS WITHOUT ITS TRANSACTION, ONCE THE VAULT\'S HISTORY SHOWS IT, AND NO OTHER', async () => {
    const c = await company();
    const coin = { nonce: 'a1'.repeat(32), token: MONEY.token as string, value: '9' };
    const other = { nonce: 'a2'.repeat(32), token: MONEY.token as string, value: '4' };
    const now = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: [...now.notes,
      { nonce: coin.nonce as never, token: coin.token as never, value: 9n },
      { nonce: other.nonce as never, token: other.token as never, value: 4n }] }, now.readAt);
    c.lands(coin);
    c.w.notes.push(heldOf(other));
    const found = await checkWhatThisBrowserSent(c.first.doors, VAULT);
    const notes = (await c.pool.load(VAULT)).notes;
    /* RED WHEN: the check does not look for the transaction of a note recorded without one - it stays unspendable with no fix on the page. */
    expect(notes.find((n) => n.nonce === coin.nonce)?.createdIn).toBe(LANDED_IN);
    /* RED WHEN: a note the history does not show is named anyway. */
    expect(notes.find((n) => n.nonce === other.nonce)?.createdIn).toBeUndefined();
    expect([found.named, found.unnamed]).toEqual([1, 1]);
    expect(sayWhatTheCheckFound(found)).toMatch(/One amount in the vault can now be used for payments\. One amount in the vault still cannot be used for a payment/);
  });

  it('CHECK MY LAST DEPOSIT NAMES A NOTE ONLY UNDER A TRANSACTION THE VAULT WORKER HAS JUDGED, WHATEVER THE HISTORY ANSWERS', async () => {
    const c = await company();
    const coin = { nonce: 'a3'.repeat(32), token: MONEY.token as string, value: '9' };
    const now = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: [...now.notes, { nonce: coin.nonce as never, token: coin.token as never, value: 9n }] }, now.readAt);
    c.w.notes.push(heldOf(coin));
    const lying = (events: Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>) =>
      ({ ...c.first.doors, builder: { ...c.first.doors.builder, createdBy: async () => ({ transactionHash: LANDED_IN, events }) } });
    for (const events of [
      /* made for another contract */
      [{ transactionHash: LANDED_IN, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: 'ee'.repeat(32), mtIndex: '1' } }],
      /* made twice */
      [1, 2].map((i) => ({ transactionHash: LANDED_IN, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: String(i) } })),
      /* served under another transaction's hash */
      [{ transactionHash: 'e4'.repeat(32), details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '1' } }],
    ]) {
      const found = await checkWhatThisBrowserSent(lying(events), VAULT);
      /* RED WHEN: the check records whatever the history's lookup answers, without the vault worker judging it. */
      expect((await c.pool.load(VAULT)).notes.find((n) => n.nonce === coin.nonce)?.createdIn).toBeUndefined();
      expect([found.named, found.unnamed]).toEqual([0, 1]);
    }
  });

  it('TWO TABS OF ONE BROWSER: THE SECOND DEPOSIT STOPS BEFORE THE WALLET, AND THE FIRST ONE\'S RECORD IS NOT OVERWRITTEN', async () => {
    const c = await company();
    const shared = new Map<string, Kept<DepositInFlight>>();
    const [tabA, tabB] = [c.browser(shared), c.browser(shared)];
    const outcomes = await Promise.allSettled([
      depositIntoCompanyVault(tabA.doors, VAULT, MONEY), depositIntoCompanyVault(tabB.doors, VAULT, MONEY),
    ]);
    const stopped = outcomes.filter((o) => o.status === 'rejected' && o.reason instanceof DepositStartedElsewhere);
    /* RED WHEN: the record is written with a plain put - the second tab then overwrites the first and both go ahead. */
    expect(stopped, 'RED WHEN: two tabs both keep a deposit on its way for one vault').toHaveLength(1);
    expect(c.w.asked, 'the wallet is asked once').toBe(1);
    /* The one deposit the wallet was asked for is the one kept: its transaction is `P<n>`, built from the n-th coin. */
    const went = c.w.built[Number(c.w.paidFor[0]!.slice(1)) - 1]!;
    expect(c.w.built, 'both tabs chose and built a coin').toHaveLength(2);
    expect([...shared.values()].map((d) => d.coin.nonce), 'RED WHEN: the second tab\'s record replaces the first\'s')
      .toEqual([went.nonce]);
  });

  it('TWO BROWSERS DEPOSITING THE SAME MONEY AT ONCE MAKE TWO DIFFERENT COINS', async () => {
    const c = await company();
    const [one, two] = [c.browser(), c.browser()];
    await Promise.allSettled([depositIntoCompanyVault(one.doors, VAULT, MONEY), depositIntoCompanyVault(two.doors, VAULT, MONEY)]);
    expect(c.w.built, 'both deposits are built').toHaveLength(2);
    /* RED WHEN: the journal files a second claim on a slot another deposit claimed a moment ago - both then make one coin. */
    expect(c.w.built[0]!.nonce, 'RED WHEN: two deposits of the same money at once make the same coin').not.toBe(c.w.built[1]!.nonce);
    /* And one after the other, while the first has not landed: still two coins. */
    const d = await company();
    await depositIntoCompanyVault(d.browser().doors, VAULT, MONEY).catch(() => undefined);
    await depositIntoCompanyVault(d.browser().doors, VAULT, MONEY).catch(() => undefined);
    expect(d.w.built[0]!.nonce).not.toBe(d.w.built[1]!.nonce);
  });
});

describe('A PRIVATE PAYMENT OUT', () => {
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(3) };
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  const TOKEN = 'ab'.repeat(32);
  const PAID_IN = 'dd'.repeat(32);
  const NOTE = { nonce: '01'.repeat(32), token: TOKEN, value: 500n, createdIn: '0e'.repeat(32) };
  const CHANGE = { nonce: 'cc'.repeat(32), token: TOKEN, value: 300n };
  const NOW = new Date(1_800_000_000_000);
  const order = (over: Partial<PrivatePaymentOrderOnTheWire> = {}, pay: Partial<PrivatePaymentOnTheWire> = {}): {
    order: PrivatePaymentOrderOnTheWire; payment: PrivatePaymentOnTheWire;
  } => {
    const payment: PrivatePaymentOnTheWire = {
      index: 0, kind: 'shielded', payee: 'mn_shield-addr_x', token: TOKEN, amount: '200', blinding: '0b'.repeat(32),
      nonce: '0c'.repeat(32), leaf: '0d'.repeat(32), path: [], paid: false, ...pay,
    };
    return {
      payment,
      order: {
        asset: TOKEN, form: 'shielded', symbol: 'tUSD', vault: VAULT, proposal: '0f'.repeat(32), salt: '5a'.repeat(32),
        root: '9a'.repeat(32), payees: '1', opensAt: '1799999000', closesAt: '1800009000', payments: [payment], ...over,
      },
    };
  };
  /** A pool holding one covered note the chain holds, and the doors over them. */
  const setUp = async (note: Record<string, unknown> | Array<Record<string, unknown>> = NOTE, chainNotes: string[] = [`h${NOTE.nonce.slice(1)}`]) => {
    paymentEvents.clear();
    const log: string[] = [];
    const s = new Map<WireRecord, MemorySealedPoolStore>();
    const records = (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
    await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers)
      .create(VAULT, { notes: (Array.isArray(note) ? note : [note]) as never });
    /* The vault's nonce secret, filed when it was started: a payment out is made with it. */
    await records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(me.companyKey)]));
    const held = view({ heldByCommittee: true, fundable: true, notes: chainNotes });
    const kept = new Map<string, Kept<PaymentInFlight>>();
    const inFlight: PaymentsInFlight = inFlightInMemory<PaymentInFlight>(kept);
    const doors = (over: Partial<VaultService> & Partial<ChainBehind> = {}, views = [held]) => {
      const service = serviceFrom(views, log, over);
      return {
        ...pacing, ...walletReadsTheVault, now: () => NOW, me, myRecordsKey: 'ff'.repeat(32), records, signers,
        service, indexer: indexerOf(service), builder: builder(log), inFlight,
      };
    };
    const pool = () => new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    const notesNow = async () => (await pool().load(VAULT)).notes;
    const journal = async () => (await new PaymentJournalInStore(records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers).open()).attempts;
    return { log, doors, notesNow, journal, pool, kept };
  };
  /** The payment's own events appear once it has been sent. */
  const landsWhenSent = (change: typeof CHANGE | null = CHANGE): Partial<VaultService> => ({
    payout: async () => {
      paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, change));
      return { txRef: 'o', transactionHash: PAID_IN };
    },
  });

  it('A PRIVATE PAYMENT IS BUILT ON THE BLOCK AND THE EVENTS THIS DEVICE READ AT THE WALLET\'S INDEXER, AND CONFIRMED BY THEM; THE SERVICE IS NEVER ASKED', async () => {
    const t = await setUp();
    const asked: string[] = [];
    const d = t.doors(landsWhenSent());
    const done = await payPrivatelyFromCompanyVault({ ...d, service: aServiceThatLies(d.service, asked) }, order());
    /* RED WHEN: the block, the note's events or the payment's own events are asked of the service. */
    expect(asked).toEqual([]);
    /* RED WHEN: the payment is built at any block but the one this device read, or on any events but those it read. */
    expect(t.log).toContain('build payout spending 01 with 1 event(s) at B1');
    expect(t.log.filter((l) => l.endsWith(' here'))).toEqual(['read events of 0e here', 'read the block here', 'read events of dd here']);
    /* RED WHEN: the change is recorded under the service's history rather than this payment's own events, read here. */
    expect(done.transactionHash).toBe(PAID_IN);
  });

  it('WRITES THE PAYMENT DOWN BEFORE IT IS BUILT OR SENT, AND ADVANCES THE POOL ONLY ON THIS PAYMENT\'S OWN EVENTS, UNDER ITS OWN HASH', async () => {
    /* RED WHEN: the journal line moves below the build or the send (the journal read inside the builder stand-in is
     * then empty); the pool is advanced before this payment's own events are read (the log then lacks that read);
     * or the change is saved under anything but this payment's hash. */
    const t = await setUp();
    let journalledBeforeBuild = -1;
    let builtWith = '';
    const b = t.doors(landsWhenSent());
    const build = b.builder.payout;
    b.builder.payout = async (i) => { journalledBeforeBuild = (await t.journal()).length; builtWith = i.secret; return build(i); };
    const done = await payPrivatelyFromCompanyVault(b, order());
    expect(journalledBeforeBuild).toBe(1);
    /* RED WHEN: the payment is built with anything but the vault's secret as the company's filed record holds it. */
    expect(builtWith).toBe(openNonceSecrets((await b.records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(me.companyKey)).secrets[0]);
    expect(t.log).toEqual([
      'choose', 'read events of 0e here', 'read the block here', 'build payout spending 01 with 1 event(s) at B1', 'read events of dd here',
    ]);
    expect(done).toEqual({
      txRef: 'o', transactionHash: PAID_IN, spent: NOTE.nonce, change: { ...CHANGE, value: '300' }, seenAs: 'its-own-transaction',
    });
    expect(await t.notesNow()).toEqual([{ ...CHANGE, createdIn: PAID_IN }]);
    const lines = await t.journal();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ spent: { nonce: NOTE.nonce, token: TOKEN, value: 500n }, amount: 200n });
  });

  it('A PAYMENT THAT DRAWS ON TWO NOTES IS PLANNED, WRITTEN DOWN, BUILT AND RECORDED WITH BOTH, AS THE CHAIN HOLDS IT', async () => {
    /*
     * Two notes of 120 and 100 pay 200 together, and no single note covers it. The planner offers the larger first.
     * RED WHEN: the journal line, the build or the record names only the first note - the rebuild would then propose
     * a change the chain never made, and the pool would keep offering a note the chain has nullified.
     */
    const A = { nonce: '02'.repeat(32), token: TOKEN, value: 120n, createdIn: '0e'.repeat(32) };
    const B = { nonce: '03'.repeat(32), token: TOKEN, value: 100n, createdIn: '0f'.repeat(32) };
    const change = { nonce: 'cc'.repeat(32), token: TOKEN, value: 20n };
    const t = await setUp([B, A], [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`]);
    const b = t.doors(landsWhenSent(change));
    let inFlightWhileSending: PaymentInFlight | null = null;
    const send = b.service.payout;
    b.service.payout = async (v, tx) => { inFlightWhileSending = await b.inFlight.get(v); return send(v, tx); };
    const done = await payPrivatelyFromCompanyVault(b, order());
    expect(t.log).toEqual([
      'choose', 'read events of 0e here', 'read events of 0f here', 'read the block here', 'build payout spending 02+03 with 1+1 event(s) at B1', 'read events of dd here',
    ]);
    expect(done).toMatchObject({ spent: A.nonce, change: { ...change, value: '20' } });
    const [line] = await t.journal();
    expect(line, 'RED WHEN: the journal names only the note offered first').toMatchObject({
      spent: { nonce: A.nonce, value: 120n }, further: [{ nonce: B.nonce, token: TOKEN, value: 100n }], step: 'payment', amount: 200n,
    });
    expect((inFlightWhileSending as PaymentInFlight | null)?.further, 'RED WHEN: the record kept while the payment is sent forgets the further note')
      .toEqual([{ nonce: B.nonce, token: TOKEN, value: '100' }]);
    expect(await t.notesNow(), 'RED WHEN: the pool keeps the further note the chain has nullified').toEqual([{ ...change, createdIn: PAID_IN }]);
  });

  it('A PAYMENT OUT OF A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT, IS REFUSED BEFORE ANYTHING IS WRITTEN DOWN', async () => {
    const t = await setUp();
    const b = { ...t.doors(landsWhenSent()), onChain: async (v: string) => ({ holders: { committee: [], threshold: 1, seats: [], approvals: 1, adoptedVaults: [], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }] } }) };
    const e = await payPrivatelyFromCompanyVault(b, order()).catch((x: Error) => x);
    /* RED WHEN: a payment is made out of a vault the service named and the account never adopted. */
    expect((e as Error).message).toMatch(/not one your company's account has adopted/);
    expect(await t.journal()).toEqual([]);
    expect(t.log.filter((l) => l.startsWith('build') || l === 'choose')).toEqual([]);
  });

  it('THE CHAIN WINS BEFORE A PAYMENT READS ITS SECRET: A NEWER ONE THE VAULT NEVER TOOK IS PASSED OVER FOR THE ONE IT HOLDS', async () => {
    const t = await setUp();
    const b = t.doors(landsWhenSent());
    const theVaults = await anUnsetNewerSecret(b.records, me.companyKey);
    b.builder.secretIsTheVaults = async (i) => i.secret === theVaults;
    let builtWith = '';
    const build = b.builder.payout;
    b.builder.payout = async (i) => { builtWith = i.secret; return build(i); };
    await payPrivatelyFromCompanyVault(b, order());
    /* RED WHEN: a payment refuses, or builds, under the records' newest secret when the vault holds an earlier one. */
    expect(builtWith).toBe(theVaults);
    expect((await b.records('nonce-secret').get(VAULT))!.version).toBe(3);
  });

  /* RED WHEN: a payment is written down or built under a secret the vault's commitment does not name. */
  it('A PAYMENT UNDER A SECRET THE VAULT DOES NOT HOLD IS REFUSED BEFORE ANYTHING IS WRITTEN DOWN OR BUILT', async () => {
    const t = await setUp();
    /* The service's block names the vault's state 'V'; this device read 'DEVICE'. */
    const b = t.doors(landsWhenSent(), [view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`], state: 'DEVICE' })]);
    const asked: string[] = [];
    b.builder.secretIsTheVaults = async (i) => { asked.push(i.state); return false; };
    const e = await payPrivatelyFromCompanyVault(b, order()).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/not the one the vault holds on the chain, so nothing was built from it\. Nothing was sent/);
    /*
     * Asked of the state this device read, by the step that makes the chain's secret the records' newest and by the
     * payment's own check. RED WHEN: either is asked of the state the service served - its records are then filed from it.
     */
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['DEVICE']));
    expect(await t.journal()).toEqual([]);
    expect(t.log.filter((l) => l.startsWith('build'))).toEqual([]);
  });

  it('A NOTE SPENT EXACTLY LEAVES NO CHANGE, AND THE POOL LOSES THE NOTE ONCE THE PAYMENT\'S OWN EVENTS SHOW IT', async () => {
    const t = await setUp();
    const done = await payPrivatelyFromCompanyVault(t.doors(landsWhenSent(null)), order({}, { amount: '500' }));
    expect(done.change).toBeNull();
    expect(await t.notesNow()).toEqual([]);
  });

  it('TWO PAYMENTS FROM ONE NOTE FOR ONE AMOUNT: THE ONE WHOSE OWN TRANSACTION THE CHAIN DOES NOT HOLD IS NOT RECORDED AS PAID', async () => {
    /*
     * The other payment landed and made exactly this payment's change coin, so the vault's notes read as though this
     * one had. RED WHEN: the pool is advanced on what the vault holds rather than on this payment's own events - it is
     * then advanced, and its change recorded under a transaction that never landed.
     */
    const t = await setUp();
    const e = await payPrivatelyFromCompanyVault(t.doors({
      payout: async () => {
        paymentEvents.set('a1'.repeat(32), await eventsOfAPayment('a1'.repeat(32), CHANGE));
        return { txRef: 'o', transactionHash: PAID_IN };
      },
    }), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(await t.notesNow()).toEqual([NOTE]);
  });

  it('A PAYMENT WHOSE OWN EVENTS DO NOT CARRY THE CHANGE, OR PAY NOBODY, IS NOT RECORDED, AND SAYS AT ONCE IT IS NOT AS BUILT', async () => {
    /* RED WHEN: the confirmation stops requiring the change among this transaction's own outputs, or a person's output;
     * or the wait reads a transaction that is there and not as built as "not yet". */
    const noChange = await setUp();
    const e1 = await payPrivatelyFromCompanyVault(noChange.doors({
      payout: async () => { paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, null)); return { txRef: 'o', transactionHash: PAID_IN }; },
    }), order()).catch((x) => x);
    expect(e1).toBeInstanceOf(PaymentNotAsBuilt);
    expect(e1.message).toMatch(/did not create this note/);
    expect(noChange.log.filter((l) => l === 'read events of dd here')).toHaveLength(1);
    expect(await noChange.notesNow()).toEqual([NOTE]);
    const nobody = await setUp();
    const e2 = await payPrivatelyFromCompanyVault(nobody.doors({
      payout: async () => {
        paymentEvents.set(PAID_IN, (await eventsOfAPayment(PAID_IN, CHANGE)).filter((ev) => ev.details.commitment !== 'f0'.repeat(32)));
        return { txRef: 'o', transactionHash: PAID_IN };
      },
    }), order()).catch((x) => x);
    expect(e2).toBeInstanceOf(PaymentNotAsBuilt);
    expect(e2.message).toMatch(/paid nobody/);
    expect(await nobody.notesNow()).toEqual([NOTE]);
  });

  it('THE CONFIRMATION READS ONLY THIS TRANSACTION\'S OWN EVENTS, AND NONE IS NOT AN ANSWER', async () => {
    /* RED WHEN: events of another transaction are accepted among these, or an empty answer is read as landed. */
    const own = await eventsOfAPayment(PAID_IN, CHANGE);
    const change = { ...CHANGE, value: '300' };
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change, events: own }))
      .resolves.toEqual({ state: 'landed', createdIn: PAID_IN });
    const mixed = [...own.slice(0, 2), { ...own[2]!, transactionHash: 'a1'.repeat(32) }];
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change, events: mixed }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/not all its own/) });
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change: null, events: [] }))
      .resolves.toEqual({ state: 'not-yet' });
    /* The change must be this vault's: the same output for another contract is not it. */
    await expect(confirmPayment({ vault: 'ee'.repeat(32), transactionHash: PAID_IN, change, events: own }))
      .resolves.toMatchObject({ state: 'not-as-built' });
  });

  it('A MERGE IS CONFIRMED ONLY BY ITS OWN EVENTS KEEPING ONE COIN FOR THIS VAULT AND PAYING NOBODY', async () => {
    const MERGED_IN = 'dc'.repeat(32);
    const kept = { nonce: 'e7'.repeat(32), token: TOKEN, value: 220n };
    const keptOut = { transactionHash: MERGED_IN, details: { tag: 'zswapOutput', commitment: await vaultNoteCommitment(kept as never, VAULT as never), contract: VAULT, mtIndex: '13' } };
    const keptWire = { ...kept, value: '220' };
    /* RED WHEN: a merge's own events, which pay nobody, are refused as a payment that paid nobody. */
    await expect(confirmPayment({ vault: VAULT, transactionHash: MERGED_IN, change: keptWire, events: [keptOut], merge: true }))
      .resolves.toEqual({ state: 'landed', createdIn: MERGED_IN });
    /* RED WHEN: a transaction under a merge's name that pays a person is accepted as the merge. */
    const toAPerson = { transactionHash: MERGED_IN, details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), mtIndex: '11' } };
    await expect(confirmPayment({ vault: VAULT, transactionHash: MERGED_IN, change: keptWire, events: [toAPerson, keptOut], merge: true }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/pays somebody/) });
    /* RED WHEN: a merge with no coin named is taken as landed on any events at all. */
    await expect(confirmPayment({ vault: VAULT, transactionHash: MERGED_IN, change: null, events: [keptOut], merge: true }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/keeps one coin/) });
    /* And the same events are not a payment: one that pays nobody is refused as one. */
    await expect(confirmPayment({ vault: VAULT, transactionHash: MERGED_IN, change: keptWire, events: [keptOut] }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/paid nobody/) });
  });

  it('A PERSON THE ACCOUNT ALREADY RECORDS PAID, OR A WINDOW THAT IS NOT OPEN, IS REFUSED BEFORE THE POOL IS OPENED', async () => {
    /* RED WHEN: either early refusal is removed - the log then carries 'choose' and a journal line is written. */
    const paid = await setUp();
    await expect(payPrivatelyFromCompanyVault(paid.doors(), order({}, { paid: true }))).rejects.toThrow(/already records this person paid/);
    const early = await setUp();
    await expect(payPrivatelyFromCompanyVault(early.doors(), order({ opensAt: '1800000001' }))).rejects.toThrow(/not open now/);
    const late = await setUp();
    await expect(payPrivatelyFromCompanyVault(late.doors(), order({ closesAt: '1800000000' }))).rejects.toThrow(/not open now/);
    for (const t of [paid, early, late]) {
      expect(t.log).toEqual([]);
      expect(await t.journal()).toEqual([]);
    }
  });

  it('A VAULT THE COMMITTEE DOES NOT HOLD IS NOT OPENED HERE, AND NOTHING IS WRITTEN', async () => {
    /* RED WHEN: the `heldByCommittee` check is removed - the pool is then opened and a note chosen. */
    const t = await setUp();
    const e = await payPrivatelyFromCompanyVault(t.doors({}, [oneKey]), order()).catch((x) => x);
    expect(e.message).toMatch(/as this device read it, does not show this vault held by the company's committee/);
    expect(e.message).toMatch(/sign the change in Settings/);
    expect(t.log).toEqual([]);
    expect(await t.journal()).toEqual([]);
  });

  it('A VAULT NOT STARTED, OR HELD BY OTHER KEYS THAN THE COMPANY\'S ACCOUNT, IS NOT OPENED HERE, AND NOTHING IS WRITTEN OR PROVED', async () => {
    /*
     * The committee holds the vault and its first secret is not set, as this
     * device read it. RED WHEN: the `fundable` check is removed or moved below
     * the journal line - the pool is then opened, a note chosen and a line
     * written for a payment that could never be sent.
     */
    const t = await setUp();
    const notStarted = view({ heldByCommittee: true, fundable: false, notes: [`h${NOTE.nonce.slice(1)}`] });
    /* RED WHEN: the check moves below opening the pool - this door's records are then read at all. */
    const unopened = { ...t.doors({}, [notStarted]), records: () => { throw new Error('the pool was opened'); } };
    const e = await payPrivatelyFromCompanyVault(unopened as never, order()).catch((x) => x);
    expect(e.message).toMatch(/^No payment can be made out of this vault yet/);
    expect(e.message).toMatch(/this vault has not been started/);
    expect(e.message).toMatch(/Nothing was sent\./);
    expect(t.log).toEqual([]);
    expect(await t.journal()).toEqual([]);
    /*
     * The company's account still held by the temporary key it was created with, as the signer's own wallet reads it.
     * RED WHEN: who holds the vault is not compared with who holds the account.
     */
    const held = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const temporary = async (v: string) => ({ holders: { ...(await walletReadsTheVault.onChain(v)).holders, committee: [{ tag: 'schnorr', value: '77'.repeat(32) }] } });
    const other = await payPrivatelyFromCompanyVault({ ...t.doors({}, [held]), onChain: temporary }, order()).catch((x) => x);
    expect(other.message).toMatch(/not held by the keys that hold your company's account/);
    expect(t.log).toEqual([]);
    expect(await t.journal()).toEqual([]);
  });

  it('A NOTE THAT DOES NOT NAME ITS TRANSACTION IS NOT SPENT, AND NOTHING IS WRITTEN OR SENT', async () => {
    /* RED WHEN: the `createdIn` check is removed - the events are then read for `undefined` and a line is journalled. */
    const { createdIn: _none, ...unnamed } = NOTE;
    const t = await setUp(unnamed);
    await expect(payPrivatelyFromCompanyVault(t.doors(), order())).rejects.toThrow(/does not record which transaction created it/);
    expect(t.log).toEqual(['choose']);
    expect(await t.journal()).toEqual([]);
  });

  it('A NOTE THE CHAIN NO LONGER HOLDS IS NOT SPENT AGAIN: A PAYMENT FROM IT LANDED THAT THE RECORD DOES NOT SHOW', async () => {
    /* RED WHEN: the chosen note is not checked against what the chain holds - a line is journalled and a payment built. */
    const t = await setUp(NOTE, [`h${'cc'.repeat(32).slice(1)}`]);
    await expect(payPrivatelyFromCompanyVault(t.doors(landsWhenSent()), order())).rejects.toThrow(/a step that spent it has landed that this record does not show/);
    expect(t.log).toEqual(['choose']);
    expect(await t.journal()).toEqual([]);
  });

  it('A PAYMENT WHOSE OWN TRANSACTION THE CHAIN HAS NOT SHOWN LEAVES THE POOL AS IT WAS, AND SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: the wait is removed or accepts anything - the pool then loses the note the chain still holds. */
    const t = await setUp();
    const e = await payPrivatelyFromCompanyVault(t.doors(), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/Do not pay this person again/);
    expect(await t.notesNow()).toEqual([NOTE]);
    expect(await t.journal()).toHaveLength(1);
  });

  it('A SEND THE SERVICE REFUSED CHANGES NOTHING AND SAYS SO; A SEND THAT MAY HAVE LANDED SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: a failure the service did not mark as nothing sent is passed through as it came - a screen then says
     * the payment did not finish and offers the person again. */
    const t = await setUp();
    const refused = Object.assign(new Error('this is not a private payment. Nothing was sent.'), { nothingWasSent: true });
    await expect(payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw refused; } }), order()))
      .rejects.toThrow('this is not a private payment. Nothing was sent.');
    const lost = Object.assign(new Error('the node did not answer'), { nothingWasSent: false });
    const e = await payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw lost; } }), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/the node did not answer/);
    expect(await t.notesNow()).toEqual([NOTE]);
  });

  it('A SEND THE SERVICE CANNOT NAME, OR A RECORD THAT CANNOT BE WRITTEN AFTER IT LANDED, SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: a failure after the send reaches the screen as an ordinary error. */
    const unnamed = await setUp();
    const e1 = await payPrivatelyFromCompanyVault(unnamed.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }), order()).catch((x) => x);
    expect(e1).toBeInstanceOf(PaymentNotYetSeen);
    expect(e1.message).toMatch(/could not name the transaction/);
    expect(await unnamed.notesNow()).toEqual([NOTE]);
    const unwritable = await setUp();
    const b = unwritable.doors(landsWhenSent());
    b.builder.afterPayment = async () => { throw new Error('the pool refused the write'); };
    const e2 = await payPrivatelyFromCompanyVault(b, order()).catch((x) => x);
    /* A part of this page that stops answering after the send is not a payment that did not happen. */
    const stopped = await setUp();
    const c = stopped.doors(landsWhenSent());
    c.builder.confirmPayment = async () => { throw new Error('the part of this page that builds vault transactions stopped'); };
    const e3 = await payPrivatelyFromCompanyVault(c, order()).catch((x) => x);
    expect(e3).toBeInstanceOf(PaymentNotYetSeen);
    expect(e3.message).toMatch(/stopped/);
    /* RED WHEN: a write that fails after the payment was confirmed is reported as a payment not seen. */
    expect(e2).toBeInstanceOf(PaymentLandedUnrecorded);
    expect(e2.message).toMatch(/the pool refused the write/);
    expect(e2.message).toMatch(/The person is paid/);
  });

  /** A builder whose output commitments are the ledger's own, so the vault's history can be searched by them. */
  const withRealOutputs = (b: VaultBuilderClient): VaultBuilderClient => ({
    ...b,
    commitments: async (i) => ({
      output: await vaultNoteCommitment({ nonce: i.coin.nonce, token: i.coin.token, value: BigInt(i.coin.value) } as never, VAULT as never),
      held: `h${i.coin.nonce.slice(1)}`,
    }),
  });
  const heldChange = `h${CHANGE.nonce.slice(1)}`;
  const second = (over: Partial<PrivatePaymentOnTheWire> = {}) => {
    const o = order({}, { index: 1, amount: '100', ...over });
    return { order: { ...o.order, payments: [o.payment] }, payment: o.payment };
  };

  it('A PAYMENT WHOSE SEND GAVE NO HASH IS RECORDED UNDER ITS CREATING TRANSACTION ONCE IT LANDS, AND THE NEXT PAYMENT OF THE RUN SPENDS ITS CHANGE', async () => {
    const t = await setUp();
    const b = t.doors({
      payout: async () => {
        paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
        return { txRef: 'o', transactionHash: null };
      },
    });
    const done = await payPrivatelyFromCompanyVault({ ...b, builder: withRealOutputs(b.builder) }, order());
    /* RED WHEN: the page does not look the payment up by its change - it then raises not-yet-seen and records nothing. */
    expect(await t.notesNow(), 'RED WHEN: a payment with no hash from its send is not recorded under its creating transaction')
      .toEqual([{ ...CHANGE, createdIn: PAID_IN }]);
    /* RED WHEN: a payment found by what it left is reported as seen by its own transaction, or named by a transaction that
     * may be another payment's - the screen then says this person was paid. */
    expect(done.seenAs).toBe('by-what-it-left');
    expect(done.transactionHash).toBe('');
    expect(t.kept.size, 'RED WHEN: a recorded payment is left on its way').toBe(0);
    /* The next person on the run is paid out of the change. */
    const next = t.doors({
      payout: async () => {
        paymentEvents.set('d2'.repeat(32), await eventsOfAPayment('d2'.repeat(32), { ...CHANGE, nonce: 'c2'.repeat(32), value: 200n }));
        return { txRef: 'o2', transactionHash: 'd2'.repeat(32) };
      },
    }, [view({ heldByCommittee: true, fundable: true, notes: [heldChange] })]);
    next.builder.payout = async (i) => ({ tx: 'O2', spent: i.note.nonce, change: { nonce: 'c2'.repeat(32), token: i.note.token, value: '200' } });
    const paid = await payPrivatelyFromCompanyVault(next, second());
    expect(paid.spent, 'the run goes on, spending the change the first payment left').toBe(CHANGE.nonce);
    expect(await t.notesNow()).toEqual([{ nonce: 'c2'.repeat(32), token: TOKEN, value: 200n, createdIn: 'd2'.repeat(32) }]);
  });

  it('A PAYMENT WHOSE SEND WAS LOST IS KEPT ON ITS WAY; WHEN IT LANDS, THE NEXT PAYMENT RECORDS IT FIRST AND THE RUN FINISHES', async () => {
    const t = await setUp();
    const lost = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    const e = await payPrivatelyFromCompanyVault({ ...lost, builder: withRealOutputs(lost.builder) }, order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/the connection dropped/);
    expect([...t.kept.values()].map((p) => p.change), 'RED WHEN: a payment that may have landed is not kept with its change')
      .toEqual([{ ...CHANGE, value: '300' }]);
    /* While the chain still holds the note it spent, no other payment is made from here. */
    const early = t.doors();
    await expect(payPrivatelyFromCompanyVault(early, second()), 'RED WHEN: a second payment is built while the record does not say which notes are left')
      .rejects.toBeInstanceOf(PaymentStillInFlight);
    /* It lands: the chain no longer holds the note, and holds the change. */
    paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
    const next = t.doors(landsWhenSent({ ...CHANGE, nonce: 'c2'.repeat(32), value: 200n }), [view({ heldByCommittee: true, fundable: true, notes: [heldChange] })]);
    next.builder = withRealOutputs(next.builder);
    next.builder.payout = async (i) => ({ tx: 'O2', spent: i.note.nonce, change: { nonce: 'c2'.repeat(32), token: i.note.token, value: '200' } });
    const paid = await payPrivatelyFromCompanyVault(next, second());
    /* RED WHEN: the earlier payment is not settled first - the next one then refuses the vanished note until a rebuild. */
    expect(paid.spent).toBe(CHANGE.nonce);
    expect(t.log.some((l) => /^found /.test(l)), 'RED WHEN: the earlier payment is not found by its change').toBe(true);
    expect(await t.notesNow()).toEqual([{ nonce: 'c2'.repeat(32), token: TOKEN, value: 200n, createdIn: PAID_IN }]);
  });

  it('A PAYMENT OUT OF A VAULT PINNED TO ANOTHER ACCOUNT IS REFUSED BEFORE ANYTHING IS WRITTEN', async () => {
    const t = await setUp();
    const d = t.doors();
    const elsewhere = { ...d.builder, vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => ({ ...(await d.builder.vaultOnChain(i)), account: 'dd'.repeat(32) }) as never };
    const e = await payPrivatelyFromCompanyVault({ ...d, builder: elsewhere }, order()).catch((x) => x);
    /* RED WHEN: a payment goes out of a vault pinned to an account other than the company's. */
    expect(e.message).toMatch(/^No payment can be made out of this vault yet.*not pinned to your company's account/);
    expect(t.log).toEqual([]);
    expect(await t.journal()).toEqual([]);
  });

  it('A PAYMENT, ITS WAIT AND ITS SETTLING READ THE VAULT ON THIS DEVICE, AND THE SERVICE IS NEVER ASKED WHAT THE VAULT HOLDS', async () => {
    const asked = { n: 0 };
    const t = await setUp();
    const gone = view({ heldByCommittee: true, fundable: true, notes: [] });
    const held = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const noHash = { payout: async () => ({ txRef: 'o', transactionHash: null }) };
    /* RED WHEN: the payment, or its wait for a note with no hash to leave the vault, reads the vault through the service's chain route. */
    const done = await payPrivatelyFromCompanyVault(theServiceNeverAsked(t.doors(noHash, [held, held, gone]), asked), order({}, { amount: '500' }));
    expect(done.change).toBeNull();
    const stays = await setUp();
    await expect(payPrivatelyFromCompanyVault(stays.doors(noHash, [held]), order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    /* RED WHEN: settling on its own reads the vault through the service's chain route. */
    expect(await settlePaymentInFlight(theServiceNeverAsked(stays.doors({}, [gone]), asked), VAULT)).toEqual({ state: 'recorded', createdIn: null });
    expect(asked.n).toBe(0);
  });

  it('A PAYMENT THAT SPENT ITS NOTE EXACTLY, WITH NO HASH FROM ITS SEND, IS RECORDED ONCE THE NOTE LEAVES THE VAULT, AND NOT BEFORE', async () => {
    const t = await setUp();
    const gone = view({ heldByCommittee: true, fundable: true, notes: [] });
    const held = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const b = t.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [held, held, gone]);
    const done = await payPrivatelyFromCompanyVault(b, order({}, { amount: '500' }));
    /* RED WHEN: the note is taken out while the chain still holds it, or never once it does not. */
    expect(done.change).toBeNull();
    expect(await t.notesNow()).toEqual([]);
    const stays = await setUp();
    const s2 = stays.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [held]);
    await expect(payPrivatelyFromCompanyVault(s2, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect(await stays.notesNow(), 'RED WHEN: a note the chain still holds is taken out of the record').toEqual([NOTE]);
    expect(stays.kept.size, 'the payment is kept on its way').toBe(1);
    /* A view that did not read the vault is not a note that left it. */
    const unreadable = view({ onChain: false, heldByCommittee: true, fundable: true, notes: undefined });
    const blind = await setUp();
    const b3 = blind.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [held, unreadable]);
    /* RED WHEN: a view with no notes is read as the note having left - a note the chain holds is taken out of the record. */
    await expect(payPrivatelyFromCompanyVault(b3, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect(await blind.notesNow(), 'RED WHEN: an unreadable view takes the note out of the record').toEqual([NOTE]);
    await expect(settlePaymentInFlight(blind.doors({}, [unreadable]), VAULT), 'RED WHEN: settling reads an unreadable view as the note gone')
      .rejects.toBeInstanceOf(PaymentStillInFlight);
    expect(await blind.notesNow()).toEqual([NOTE]);
    /* The page was closed; the note leaves the vault later, and the next look from this browser records it. */
    expect(await settlePaymentInFlight(stays.doors({}, [gone]), VAULT), 'RED WHEN: a payment with no change is never settled later')
      .toEqual({ state: 'recorded', createdIn: null });
    expect(await stays.notesNow()).toEqual([]);
    expect(stays.kept.size).toBe(0);
  });

  it('A PAYMENT FOUND ONLY BY ITS NOTE LEAVING, WHEN ANOTHER HOLDER\'S MERGE SPENT THAT NOTE: THE MERGE IS RECORDED, NOT THE PAYMENT, WHETHER IT IS SEEN WHILE WATCHING OR ON THE NEXT LOOK', async () => {
    /*
     * The payment spends the 500 exactly, so it keeps no coin, and its send names no transaction. Another holder of
     * the vault's secret merges the 500 and the 300 into one coin of 800 - written down first, as every step is - and
     * the merge lands first. The 500 leaves the chain, and not by this payment.
     */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const MERGED_IN = 'e8'.repeat(32);
    const merged = { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n };
    const both = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const afterMerge = view({ heldByCommittee: true, fundable: true, notes: [`h${merged.nonce.slice(1)}`] });
    const theirMergeLands = async (records: ReturnType<Awaited<ReturnType<typeof setUp>>['doors']>['records']) => {
      await new PaymentJournalInStore(records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
        .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
      paymentEvents.set(MERGED_IN, await eventsOfAPayment(MERGED_IN, merged));
    };

    /* Seen while this device watches for the payment. */
    const t = await setUp([NOTE, B], both.notes as string[]);
    const d = t.doors({ payout: async () => { await theirMergeLands(d.records); return { txRef: 'o', transactionHash: null }; } }, [both, both, afterMerge]);
    d.builder = withRealOutputs(d.builder);
    const e = await payPrivatelyFromCompanyVault(d, order({}, { amount: '500' })).catch((x) => x);
    /* RED WHEN: the note leaving is taken as this payment landing - it returns as paid, with the merge's notes taken as its own. */
    expect(e).toBeInstanceOf(StepOvertaken);
    /* RED WHEN: the overtaken payment is not something the leg plans again from - it would stop the leg instead of paying from what is left. */
    expect(e).toBeInstanceOf(NotesMovedUnderAStep);
    /* RED WHEN: the merge is recorded as this payment: the record then holds the 300, which the chain does not, and lacks the 800. */
    expect(await t.notesNow()).toEqual([{ ...merged, createdIn: MERGED_IN }]);
    expect(t.kept.size, 'RED WHEN: the payment that can never land is still kept on its way').toBe(0);

    /* The page stopped watching first, and the next look from this browser settles it. */
    const u = await setUp([NOTE, B], both.notes as string[]);
    const firstU = u.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [both]);
    firstU.builder = withRealOutputs(firstU.builder);
    await expect(payPrivatelyFromCompanyVault(firstU, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await theirMergeLands(firstU.records);
    /* RED WHEN: settling a payment that kept no coin records it as landed without asking whether another step spent its note. */
    expect(await settlePaymentInFlight({ ...u.doors({}, [afterMerge]), builder: withRealOutputs(u.doors().builder) }, VAULT))
      .toEqual({ state: 'overtaken' });
    expect(await u.notesNow()).toEqual([{ ...merged, createdIn: MERGED_IN }]);
    expect(u.kept.size).toBe(0);
  });

  it('A PAYMENT THAT KEPT NO COIN AND SPENDS TWO NOTES IS NOT RECORDED WHILE THE CHAIN STILL HOLDS ITS SECOND, WATCHING OR ON THE NEXT LOOK', async () => {
    /*
     * 800 paid exactly from the 500 and the 300, the send naming no transaction. The 500 leaves the chain - spent by a
     * step this device's journal does not name - and the 300 is still there: a payment spends all its notes in one
     * transaction, so this one has not landed.
     */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const onlyB = view({ heldByCommittee: true, fundable: true, notes: [`h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const d = t.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [both, both, onlyB]);
    const e = await payPrivatelyFromCompanyVault(d, order({}, { amount: '800' })).catch((x) => x);
    /* RED WHEN: the payment is taken as landed once its first note leaves, and the 300 the chain still holds leaves the record. */
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect((await t.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
    expect(t.kept.size).toBe(1);
    /* RED WHEN: settling on the next look records it on its first note alone. */
    await expect(settlePaymentInFlight(t.doors({}, [onlyB]), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    expect((await t.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
    /* Both gone: it landed, and both leave the record. */
    expect(await settlePaymentInFlight(t.doors({}, [view({ heldByCommittee: true, fundable: true, notes: [] })]), VAULT))
      .toEqual({ state: 'recorded', createdIn: null });
    expect(await t.notesNow()).toEqual([]);
  });

  it('A PAYMENT THAT KEPT NO COIN IS NOT LET GO FOR A LANDED LINE THAT SPENT ITS NOTE ONLY BESIDE ANOTHER: THAT COIN NAMES THE OTHER NOTE, NOT THIS ONE', async () => {
    /*
     * A merge of the 300 and the 500, the 300 first, and a coin of 800 made from the 300 on the chain. With no coin of
     * its own to weigh that against, this payment cannot say the coin is that merge's rather than another step's that
     * also began with the 300; the 500 may have left by this payment. It is recorded as landed, as before.
     */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const first = t.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [both]);
    first.builder = withRealOutputs(first.builder);
    await expect(payPrivatelyFromCompanyVault(first, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: B.nonce as never, token: TOKEN as never, value: 300n }, further: [{ nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n }));
    const afterMerge = view({ heldByCommittee: true, fundable: true, notes: [`h${'e7'.repeat(32).slice(1)}`] });
    /* RED WHEN: a line whose coin names another note is believed over a payment with no coin of its own. */
    expect(await settlePaymentInFlight({ ...t.doors({}, [afterMerge]), builder: withRealOutputs(t.doors().builder) }, VAULT))
      .toEqual({ state: 'recorded', createdIn: null });
  });

  it('A MERGE THAT LANDS UNDER A PAYMENT ON ITS WAY: THE PAYMENT FAILS CLEANLY AT ONCE, THE RECORD FOLLOWS THE CHAIN, AND THE PERSON IS PAID FROM WHAT IS LEFT', async () => {
    /*
     * The payment spends the 500 and its send drops. Before it lands, another holder of the vault's secret merges the
     * 500 and the 300 into one coin of 800 - no approval needed - and the merge lands. The payment can never land now.
     * RED WHEN: this browser waits out the payment's time to live before paying anyone again (a stall); the record keeps
     * the merged notes or lacks the merged coin (a record that disagrees with the chain); or the person is not paid
     * again from the merged coin.
     */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const first = t.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    first.builder = withRealOutputs(first.builder);
    await expect(payPrivatelyFromCompanyVault(first, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect(t.kept.size, 'the payment is kept on its way').toBe(1);

    /* Another signer's device writes its merge down before its call, as every step out of the vault is, and it lands. */
    const MERGED_IN = 'e8'.repeat(32);
    const merged = { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n };
    await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.set(MERGED_IN, await eventsOfAPayment(MERGED_IN, merged));
    const afterMerge = view({ heldByCommittee: true, fundable: true, notes: [`h${merged.nonce.slice(1)}`] });

    /* Paying the person again, within the payment's time to live. */
    const again = t.doors(landsWhenSent({ nonce: 'cc'.repeat(32), token: TOKEN, value: 600n }), [afterMerge]);
    again.builder = withRealOutputs(again.builder);
    const paid = await payPrivatelyFromCompanyVault(again, order());
    expect(paid.spent, 'RED WHEN: the payment is not made again from the merged coin').toBe(merged.nonce);
    expect(t.kept.size, 'RED WHEN: the payment that can never land is still kept on its way').toBe(0);
    /* The record is the chain's: neither merged note, the merged coin spent, and the new change under its own payment. */
    expect(await t.notesNow()).toEqual([{ nonce: 'cc'.repeat(32), token: TOKEN, value: 600n, createdIn: PAID_IN }]);
  });

  it('THE WORKER NAMES A JOURNALLED STEP\'S COIN WITH THE VAULT\'S OWN FUNCTIONS: a merge\'s coin, a payment\'s change', async () => {
    const secret = '5a'.repeat(32);
    const n = (b: string, value: string) => ({ nonce: b.repeat(32), token: TOKEN, value });
    const ask = (step: Record<string, unknown>) => answerVaultAsk(async () => ({ vault: vaultModule }) as never,
      { id: 1, network: 'undeployed', ask: 'step-kept', vault: VAULT, secret, step } as never);
    const under = { circuits: nonceCircuitsFrom(vaultModule.pureCircuits as never), vault: VAULT as never, secret: secret as never };
    const coin = (c: ReturnType<typeof n>) => ({ nonce: c.nonce as never, token: c.token as never, value: BigInt(c.value) });
    const merge = await ask({ spent: n('11', '500'), further: [n('12', '300')], amount: '0', merge: true });
    /* RED WHEN: the worker names a merge's coin other than the vault's merged note - the overtaking step would never be seen. */
    expect(merge).toMatchObject({ ok: true, kept: { ...wireOfCoin(mergedNoteOf([coin(n('11', '500')), coin(n('12', '300'))], under)) } });
    const pay = await ask({ spent: n('11', '500'), further: [n('12', '300')], amount: '650' });
    expect(pay).toMatchObject({ ok: true, kept: { ...wireOfCoin(changeAfterSpending(coin(n('11', '500')), 800n, 650n, under)!) } });
    expect(await ask({ spent: n('11', '500'), amount: '500' })).toMatchObject({ ok: true, kept: null });
  });

  it('ANOTHER DEVICE\'S PAYMENT THAT LANDED FROM THE SAME NOTE OVERTAKES THIS ONE: RECORDED WITH ITS OWN AMOUNT, AND THIS ONE LET GO', async () => {
    /*
     * Another signer's device paid 150 out of the 500 and its change of 350 landed; its pool write has not happened.
     * RED WHEN: the overtaking payment is recorded as if it sent nothing out (the record refuses, and this browser stalls),
     * or this payment is kept on its way.
     */
    const t = await setUp();
    const first = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    first.builder = withRealOutputs(first.builder);
    await expect(payPrivatelyFromCompanyVault(first, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, step: 'payment', amount: 150n, attemptedAt: 'o' });
    const theirs = { nonce: 'e6'.repeat(32), token: TOKEN, value: 350n };
    paymentEvents.set('e9'.repeat(32), await eventsOfAPayment('e9'.repeat(32), theirs));
    const after = view({ heldByCommittee: true, fundable: true, notes: [`h${theirs.nonce.slice(1)}`] });
    expect(await settlePaymentInFlight({ ...t.doors({}, [after]), builder: withRealOutputs(t.doors().builder) }, VAULT)).toEqual({ state: 'overtaken' });
    expect(t.kept.size).toBe(0);
    expect(await t.notesNow()).toEqual([{ ...theirs, createdIn: 'e9'.repeat(32) }]);
  });

  it('NO OTHER LINE OVERTAKES A PAYMENT WHOSE OWN CHANGE IS ON THE CHAIN, OR ONE NAMING NONE OF ITS NOTES, OR ITS OWN LINE', async () => {
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const first = t.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    first.builder = withRealOutputs(first.builder);
    await expect(payPrivatelyFromCompanyVault(first, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    const journal = new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers);
    /* A merge of the 500 and the 300 whose coin is on the chain - and this payment's own change of 300 is too. */
    await journal.record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n }));
    paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
    const landed = view({ heldByCommittee: true, fundable: true, notes: [`h${'e7'.repeat(32).slice(1)}`, `h${CHANGE.nonce.slice(1)}`] });
    /* RED WHEN: another step's coin is believed while this payment's own change shows it landed. */
    expect(await settlePaymentInFlight({ ...t.doors({}, [landed]), builder: withRealOutputs(t.doors().builder) }, VAULT))
      .toMatchObject({ state: 'recorded' });

    /* A landed merge of two notes this payment does not spend is no reason to let it go. */
    const u = await setUp([NOTE, B], both.notes as string[]);
    const firstU = u.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    firstU.builder = withRealOutputs(firstU.builder);
    await expect(payPrivatelyFromCompanyVault(firstU, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    const C = { nonce: '05'.repeat(32), token: TOKEN, value: 300n };
    await new PaymentJournalInStore(firstU.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: B.nonce as never, token: TOKEN as never, value: 300n }, further: [{ nonce: C.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.clear();
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 600n }));
    const elsewhere = view({ heldByCommittee: true, fundable: true, notes: [`h${'e7'.repeat(32).slice(1)}`] });
    /* RED WHEN: a line naming none of this payment's notes is taken as having spent one of them. */
    await expect(settlePaymentInFlight({ ...u.doors({}, [elsewhere]), builder: withRealOutputs(u.doors().builder) }, VAULT))
      .rejects.toBeInstanceOf(PaymentStillInFlight);
    expect(u.kept.size).toBe(1);

    /*
     * A merge line naming this payment's note and one the chain still holds is not the step that landed, whatever coin
     * of its value is on the chain: a coin names its first note and its worth, not every note beside it.
     */
    const w = await setUp([NOTE, B], both.notes as string[]);
    const firstW = w.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    firstW.builder = withRealOutputs(firstW.builder);
    await expect(payPrivatelyFromCompanyVault(firstW, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await new PaymentJournalInStore(firstW.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.clear();
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n }));
    const stillB = view({ heldByCommittee: true, fundable: true, notes: [`h${'e7'.repeat(32).slice(1)}`, `h${B.nonce.slice(1)}`] });
    /* RED WHEN: a line one of whose notes the chain still holds is believed to have landed. */
    await expect(settlePaymentInFlight({ ...w.doors({}, [stillB]), builder: withRealOutputs(w.doors().builder) }, VAULT))
      .rejects.toBeInstanceOf(PaymentStillInFlight);
    expect((await w.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
  });

  it('A MERGE THE CHAIN DOES NOT HOLD YET OVERTAKES NOTHING: THE PAYMENT ON ITS WAY STILL HOLDS THE VAULT', async () => {
    /* RED WHEN: a merge only written down, never landed, is taken as having spent the payment's note. */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const first = t.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    await expect(payPrivatelyFromCompanyVault(first, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    /*
     * Both notes the merge names have left the chain - by this payment or by something else - and the merged coin is
     * not there, though a transfer naming it can be read. A coin the chain does not hold is no proof that the merge
     * spent the note: with every note of the line gone, only the coin's absence stops it being believed.
     */
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n }));
    const gone = view({ heldByCommittee: true, fundable: true, notes: [] });
    const s = await settlePaymentInFlight({ ...t.doors({}, [gone]), builder: withRealOutputs(t.doors().builder) }, VAULT).catch((e) => e);
    expect(s).toBeInstanceOf(PaymentStillInFlight);
    expect(t.kept.size).toBe(1);
    /* RED WHEN: the record takes in a merged coin the chain does not hold. */
    expect((await t.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
  });

  it('A TWO-NOTE PAYMENT THAT LANDED WHILE THE PAGE WAS NOT WATCHING IS SETTLED WITH BOTH NOTES TAKEN OUT', async () => {
    const A = { nonce: '02'.repeat(32), token: TOKEN, value: 120n, createdIn: '0e'.repeat(32) };
    const B = { nonce: '03'.repeat(32), token: TOKEN, value: 100n, createdIn: '0f'.repeat(32) };
    const both = view({ heldByCommittee: true, fundable: true, notes: [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const gone = view({ heldByCommittee: true, fundable: true, notes: [] });
    const t = await setUp([A, B], both.notes as string[]);
    /* Spent exactly, and the send names nothing and then drops: the payment is kept on its way. */
    await expect(payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]), order({}, { amount: '220' })))
      .rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect([...t.kept.values()].map((p) => p.further)).toEqual([[{ nonce: B.nonce, token: TOKEN, value: '100' }]]);
    /* RED WHEN: settling records only the first note - the record would then be refused, or keep a nullified note. */
    expect(await settlePaymentInFlight(t.doors({}, [gone]), VAULT)).toEqual({ state: 'recorded', createdIn: null });
    expect(await t.notesNow()).toEqual([]);
  });

  it('A PAYMENT ON ITS WAY THAT CAN NO LONGER LAND IS LET GO; ONE WHOSE NOTE SOMETHING ELSE SPENT IS LET GO ONLY ONCE THE WHOLE HISTORY SAYS SO', async () => {
    const t = await setUp();
    const lost = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    await payPrivatelyFromCompanyVault(lost, order()).catch(() => undefined);
    const later = (ms: number, views: VaultChainView[], over: Partial<VaultService> & Partial<ChainBehind> = {}) =>
      ({ ...t.doors(over, views), builder: withRealOutputs(t.doors().builder), now: () => new Date(NOW.getTime() + ms) });
    const held = view({ heldByCommittee: true, fundable: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const gone = view({ heldByCommittee: true, fundable: true, notes: [] });
    await expect(settlePaymentInFlight(later(DEPOSIT_TIME_TO_LIVE_MS - 1, [held]), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    /* RED WHEN: a payment whose note the chain still holds is forgotten before its time to live has passed, or never. */
    expect(await settlePaymentInFlight(later(DEPOSIT_TIME_TO_LIVE_MS + 1, [held]), VAULT)).toEqual({ state: 'never-landed' });
    expect(await t.notesNow()).toEqual([NOTE]);

    const u = await setUp();
    await payPrivatelyFromCompanyVault(u.doors({ payout: async () => { throw new Error('the connection dropped'); } }), order()).catch(() => undefined);
    const at = (ms: number, over: Partial<VaultService> & Partial<ChainBehind> = {}) =>
      ({ ...u.doors(over, [gone]), builder: withRealOutputs(u.doors().builder), now: () => new Date(NOW.getTime() + ms) });
    /* The note is gone and the change is nowhere: kept until its time to live has passed and the history was read in full. */
    await expect(settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1, { createdBy: async () => { throw new Error('the indexer is down'); } }), VAULT),
      'RED WHEN: a payment is let go on a history that could not be read').rejects.toBeInstanceOf(PaymentStillInFlight);
    await expect(settlePaymentInFlight(at(1), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    /* The history lists no transaction for the change, and this device's own read of the chain holds it: not let go. */
    const real = withRealOutputs(u.doors().builder);
    const change = await real.commitments({ vault: VAULT, coin: wireOfCoin(CHANGE) });
    for (const shows of [
      view({ heldByCommittee: true, fundable: true, notes: [change.held] }),
      view({ heldByCommittee: true, fundable: true, notes: [], everCreated: [change.output] }),
    ]) {
      const d = { ...u.doors({ createdBy: async () => null }, [shows]), builder: real, now: () => new Date(NOW.getTime() + DEPOSIT_TIME_TO_LIVE_MS + 1) };
      /* RED WHEN: the service's listing of no transaction is believed over the change this device read on the chain - a paid person then reads as unpaid. */
      await expect(settlePaymentInFlight(d, VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    }
    expect(u.kept.size, 'the payment is still kept on its way').toBe(1);
    expect(await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'spent-elsewhere' });
    expect(await u.notesNow(), 'RED WHEN: the record is changed for a payment that never landed').toEqual([NOTE]);
    expect(u.kept.size).toBe(0);
  });

  it('A PAYMENT WHOSE CHANGE THE CHAIN SHOWS AND THE VAULT WORKER WILL NOT NAME IS KEPT UNTIL ITS TIME TO LIVE, THEN LET GO AS NOT MATCHED', async () => {
    const t = await setUp();
    await payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw new Error('the connection dropped'); } }), order()).catch(() => undefined);
    paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
    const gone = view({ heldByCommittee: true, fundable: true, notes: [heldChange] });
    const at = (ms: number) => {
      const d = t.doors({}, [gone]);
      return { ...d, builder: { ...withRealOutputs(d.builder), creatingTransaction: async () => ({ state: 'refused' as const }) }, now: () => new Date(NOW.getTime() + ms) };
    };
    await expect(settlePaymentInFlight(at(1), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    /* RED WHEN: a change the worker will not name blocks every payment from this browser for ever. */
    expect(await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'not-matched' });
    expect(await t.notesNow(), 'RED WHEN: a change nothing established is recorded').toEqual([NOTE]);
    expect(t.kept.size).toBe(0);
  });

  it('CHECK MY LAST DEPOSIT ALSO SETTLES A PAYMENT THIS BROWSER SENT, AND SAYS SO WITHOUT SAYING WHO WAS PAID', async () => {
    const t = await setUp();
    const lost = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    await payPrivatelyFromCompanyVault({ ...lost, builder: withRealOutputs(lost.builder) }, order()).catch(() => undefined);
    paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
    const d = t.doors({}, [view({ heldByCommittee: true, fundable: true, notes: [heldChange] })]);
    const found = await checkWhatThisBrowserSent({
      ...d, builder: withRealOutputs(d.builder), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory<DepositInFlight>(), payments: d.inFlight,
      pay: async () => { throw new Error('a check asks no wallet'); }, clock: () => NOW.getTime(),
    }, VAULT);
    /* RED WHEN: the check does not settle a payment on its way - the payment messages send people to it for nothing. */
    expect(found.payment).toEqual({ state: 'recorded', createdIn: PAID_IN });
    expect(await t.notesNow()).toEqual([{ ...CHANGE, createdIn: PAID_IN }]);
    expect(t.log.filter((l) => l === 'sent payout'), 'a check sends nothing').toHaveLength(0);
    expect(sayWhatTheCheckFound(found)).toMatch(/^This browser has no deposit .* Money from a payment this browser sent has left the vault, and the vault's record now shows it\. Open the run to see who was paid\.$/);
  });

  it('TWO TABS: A SECOND PAYMENT STOPS BEFORE IT IS SENT WHILE ANOTHER TAB\'S IS BEING SENT', async () => {
    const t = await setUp();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const slow = t.doors({ payout: async () => { await held; throw Object.assign(new Error('refused. Nothing was sent.'), { nothingWasSent: true }); } });
    const first = payPrivatelyFromCompanyVault(slow, order()).catch((x) => x);
    await new Promise((r) => setTimeout(r, 5));
    /* The second tab read this browser's records before the first tab kept its payment, so it went on to build one. */
    const tabB = t.doors();
    const e = await payPrivatelyFromCompanyVault({ ...tabB, inFlight: { ...tabB.inFlight, get: async () => null } }, second()).catch((x) => x);
    /* RED WHEN: the payment's record is kept with a plain put - the second tab then replaces it and sends from the same note. */
    expect(e).toBeInstanceOf(PaymentStartedElsewhere);
    expect(t.log.filter((l) => l === 'sent payout')).toHaveLength(0);
    expect([...t.kept.values()].map((p) => p.amount), 'the first tab\'s record stands').toEqual(['200']);
    release();
    await first;
    expect(t.kept.size, 'the first tab forgets its own record once nothing was sent').toBe(0);
  });

  it('A NOTE ANOTHER WRITER ADDED WHILE THE PAYMENT PROVED IS KEPT: THE CHANGE IS APPLIED TO THE POOL AS IT STANDS', async () => {
    /* RED WHEN: the save is built on the copy loaded before the payment - it is then refused as a lost race five
     * times over, or, without the version check, the other writer's note is dropped. */
    const t = await setUp();
    const b = t.doors(landsWhenSent());
    const send = b.service.payout;
    b.service.payout = async (v, tx) => {
      const now = await t.pool().load(VAULT);
      await t.pool().save(VAULT, { notes: [...now.notes, { nonce: '02'.repeat(32), token: TOKEN, value: 9n }] }, now.readAt);
      return send(v, tx);
    };
    await payPrivatelyFromCompanyVault(b, order());
    expect((await t.notesNow()).map((n) => n.nonce).sort()).toEqual(['02'.repeat(32), 'cc'.repeat(32)]);
  });

  /* ---------------------------------------------------------------- a merge of the vault's own notes */
  const A = { nonce: '02'.repeat(32), token: TOKEN, value: 120n, createdIn: '0e'.repeat(32) };
  const B = { nonce: '03'.repeat(32), token: TOKEN, value: 100n, createdIn: '0f'.repeat(32) };
  const MERGED = { nonce: 'e7'.repeat(32), token: TOKEN, value: 220n };
  const MERGED_IN = 'dc'.repeat(32);
  const wireNote = (n: { nonce: string; token: string; value: bigint }) => ({ nonce: n.nonce, token: n.token, value: n.value.toString() });
  /** A merge's own events: its notes in, and one coin out, kept by the vault; nobody paid. */
  const eventsOfAMerge = async (hash: string, kept = MERGED, payingSomebody = false) => [
    { transactionHash: hash, details: { tag: 'zswapInput' } },
    ...(payingSomebody ? [{ transactionHash: hash, details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), mtIndex: '11' } }] : []),
    { transactionHash: hash, details: { tag: 'zswapOutput', commitment: await vaultNoteCommitment(kept as never, VAULT as never), contract: VAULT, mtIndex: '13' } },
  ];
  const mergeLandsWhenSent = (payingSomebody = false): Partial<VaultService> => ({
    merge: async () => { paymentEvents.set(MERGED_IN, await eventsOfAMerge(MERGED_IN, MERGED, payingSomebody)); return { txRef: 'm', transactionHash: MERGED_IN }; },
  });
  const twoNotes = () => setUp([B, A], [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`]);

  it('A MERGE IS WRITTEN DOWN AS A MERGE BEFORE IT IS BUILT OR SENT, SPENDS EXACTLY THE NOTES NAMED, AND THE POOL KEEPS ONE NOTE WORTH THEM UNDER ITS OWN TRANSACTION', async () => {
    const t = await twoNotes();
    const b = t.doors(mergeLandsWhenSent());
    let journalledBeforeBuild = -1;
    let keptWhileSending: PaymentInFlight | null = null;
    const build = b.builder.mergeNotes;
    b.builder.mergeNotes = async (i) => { journalledBeforeBuild = (await t.journal()).length; return build(i); };
    const send = b.service.merge;
    b.service.merge = async (v, tx) => { keptWhileSending = await b.inFlight.get(v); return send(v, tx); };
    const done = await mergeNotesInCompanyVault(b, { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] });
    /* RED WHEN: the journal line moves below the build, or the merge is not kept on this device before it is sent. */
    expect(journalledBeforeBuild).toBe(1);
    expect(keptWhileSending).toMatchObject({ spent: { nonce: A.nonce }, further: [{ nonce: B.nonce }], amount: '0', change: { ...wireNote(MERGED) }, merge: true });
    /* RED WHEN: a note is chosen again rather than the ones named, any fact is read anywhere but here, or the pool is
     * advanced before the merge's own events are read. */
    expect(t.log).toEqual([
      'read events of 0e here', 'read events of 0f here', 'read the block here', 'build merge spending 02+03 with 1+1 event(s) at B1', 'read events of dc here',
    ]);
    expect(done).toEqual({ txRef: 'm', transactionHash: MERGED_IN, spent: [A.nonce, B.nonce], kept: wireNote(MERGED), seenAs: 'its-own-transaction' });
    /* RED WHEN: the merged note is recorded under anything but the merge's own transaction - the next payment could not read its place. */
    expect(await t.notesNow()).toEqual([{ ...MERGED, createdIn: MERGED_IN }]);
    const lines = await t.journal();
    expect(lines).toEqual([expect.objectContaining({
      spent: { nonce: A.nonce, token: TOKEN, value: 120n }, further: [{ nonce: B.nonce, token: TOKEN, value: 100n }], step: 'merge', amount: 0n,
    })]);
    /* RED WHEN: a merge that landed is left kept on this device, so every later step from this browser waits on it. */
    expect(t.kept.size).toBe(0);
  });

  it('A MERGE REFUSES NOTES THE RECORD DOES NOT HOLD AS NAMED, FEWER THAN TWO OR MORE THAN FOUR, ONE NAMED TWICE, OR TWO TOKENS: NOTHING IS WRITTEN, BUILT OR SENT', async () => {
    const OTHER = { nonce: '04'.repeat(32), token: 'cd'.repeat(32), value: 50n, createdIn: '0d'.repeat(32) };
    const t = await setUp([B, A, OTHER], [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`, `h${OTHER.nonce.slice(1)}`]);
    const b = t.doors(mergeLandsWhenSent());
    for (const [why, notes, refusal] of [
      ['a note the record does not hold', [wireNote(A), wireNote({ ...B, nonce: '09'.repeat(32) })], /does not hold as named/],
      ['a note named at another value', [wireNote(A), wireNote({ ...B, value: 99n })], /does not hold as named/],
      ['one note', [wireNote(A)], /two to 4 notes/],
      ['five notes', [A, B, A, B, A].map(wireNote), /two to 4 notes/],
      ['one note twice', [wireNote(A), wireNote(A)], /names one note twice/],
      ['two tokens', [wireNote(A), wireNote(OTHER)], /notes of one token/],
    ] as const) {
      /* RED WHEN: any of these reaches the journal, the builder or the service. */
      await expect(mergeNotesInCompanyVault(b, { vault: VAULT as never, notes }), why).rejects.toThrow(refusal);
    }
    expect(t.log.filter((l) => l.startsWith('build') || l.startsWith('sent'))).toEqual([]);
    expect(await t.journal()).toEqual([]);
  });

  it('A MERGE WHOSE TRANSACTION PAYS SOMEBODY IS NOT A MERGE: NOTHING IS RECORDED FROM IT', async () => {
    const t = await twoNotes();
    const e = await mergeNotesInCompanyVault(t.doors(mergeLandsWhenSent(true)), { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] }).catch((x) => x);
    /* RED WHEN: a transaction under the merge's name that pays a person is judged as the merge - money out read as money kept. */
    expect(e).toBeInstanceOf(MergeNotAsBuilt);
    expect((e as Error).message).toMatch(/pays somebody, and a merge pays nobody/);
    expect(await t.notesNow()).toEqual([B, A]);
  });

  it('A MERGE SENT WITHOUT A NAME, ON A PAGE THAT STOPPED WATCHING, IS RECORDED BY THE NEXT STEP ONCE ITS COIN IS ON THE CHAIN', async () => {
    const t = await twoNotes();
    const lost = t.doors({ merge: async () => { throw new Error('the connection dropped'); } });
    const e = await mergeNotesInCompanyVault(lost, { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] }).catch((x) => x);
    /* RED WHEN: a merge that may have been sent is reported as one that was not, or worded as a person's payment. */
    expect(e).toBeInstanceOf(MergeNotYetSeen);
    expect((e as Error).message).not.toMatch(/pay this person/);
    expect(t.kept.size).toBe(1);
    /* It landed after all: its coin is on the chain, under its own transaction. */
    paymentEvents.set(MERGED_IN, await eventsOfAMerge(MERGED_IN));
    const real = withRealOutputs(t.doors().builder);
    const { held } = await real.commitments({ vault: VAULT, coin: wireNote(MERGED) });
    const shows = view({ heldByCommittee: true, fundable: true, notes: [held] });
    const d = { ...t.doors({}, [shows]), builder: { ...t.doors().builder, commitments: real.commitments } };
    /* RED WHEN: a merge kept on this device is not settled as one - its two notes stay in the record after the chain spent them. */
    expect(await settlePaymentInFlight(d, VAULT as never)).toEqual({ state: 'recorded', createdIn: MERGED_IN });
    expect(await t.notesNow()).toEqual([{ ...MERGED, createdIn: MERGED_IN }]);
  });

  it('A MERGE BUILT OVER OTHER NOTES THAN THE ONES NAMED IS NOT SENT', async () => {
    const t = await twoNotes();
    const b = t.doors(mergeLandsWhenSent());
    const build = b.builder.mergeNotes;
    for (const spent of [[B.nonce, A.nonce], [A.nonce, '09'.repeat(32)], [A.nonce]]) {
      b.builder.mergeNotes = async (i) => ({ ...(await build(i)), spent });
      /* RED WHEN: the page sends whatever the worker built, without checking it spends exactly the notes named, in order. */
      await expect(mergeNotesInCompanyVault(b, { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] })).rejects.toThrow(/spends other notes than the ones named/);
    }
    expect(t.log.filter((l) => l.startsWith('sent'))).toEqual([]);
    expect(t.kept.size).toBe(0);
  });

  it('A MERGE THAT FAILS AFTER IT WAS SENT SAYS IT MAY HAVE LANDED, IN A MERGE\'S WORDS', async () => {
    const t = await twoNotes();
    const b = t.doors({ merge: async () => ({ txRef: 'm', transactionHash: null }) });
    const commitments = b.builder.commitments;
    let sent = false;
    b.service.merge = async () => { sent = true; return { txRef: 'm', transactionHash: null }; };
    b.builder.commitments = async (i) => { if (sent) throw new Error('the worker stopped'); return commitments(i); };
    const e = await mergeNotesInCompanyVault(b, { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] }).catch((x) => x);
    /* RED WHEN: a failure after the send is reported with a payment's words, or as anything but a merge that may have landed. */
    expect(e).toBeInstanceOf(MergeNotYetSeen);
    expect((e as Error).message).toMatch(/the worker stopped/);
    expect((e as Error).message).not.toMatch(/pay this person/);
  });

  it('A PAYMENT GIVEN THE PLAN\'S NOTES SPENDS EXACTLY THOSE AND CHOOSES NONE, AND REFUSES ONE THE RECORD DOES NOT HOLD AS NAMED', async () => {
    const t = await twoNotes();
    const change = { nonce: 'cc'.repeat(32), token: TOKEN, value: 20n };
    /* B alone does not cover 200; the plan named A and B. RED WHEN: the payment chooses its notes again. */
    const done = await payPrivatelyFromCompanyVault(t.doors(landsWhenSent(change)), { ...order(), notes: [wireNote(A), wireNote(B)] });
    expect(done.spent).toBe(A.nonce);
    expect(t.log.includes('choose')).toBe(false);
    expect(t.log).toContain('build payout spending 02+03 with 1+1 event(s) at B1');
    const u = await twoNotes();
    await expect(payPrivatelyFromCompanyVault(u.doors(landsWhenSent(change)), { ...order(), notes: [wireNote({ ...A, value: 121n }), wireNote(B)] }))
      .rejects.toThrow(/does not hold as named/);
    expect(u.log.filter((l) => l.startsWith('build') || l === 'choose')).toEqual([]);
    expect(await u.journal()).toEqual([]);
  });
});

describe('A PUBLIC PAYMENT OUT', () => {
  const NOW = new Date(1_800_000_000_000);
  const TOKEN = '00'.repeat(32);
  const order = (pay: Partial<PrivatePaymentOnTheWire> = {}) => {
    const payment: PrivatePaymentOnTheWire = {
      index: 0, kind: 'unshielded', payee: 'mn_addr_x', token: TOKEN, amount: '250', blinding: '0b'.repeat(32),
      nonce: '0c'.repeat(32), leaf: '0d'.repeat(32), path: [], paid: false, ...pay,
    };
    return {
      payment,
      order: {
        asset: TOKEN, form: 'unshielded', symbol: 'NIGHT', vault: VAULT, proposal: '0f'.repeat(32), salt: '5a'.repeat(32),
        root: '9a'.repeat(32), payees: '1', opensAt: '1799999000', closesAt: '1800009000', payments: [payment],
      } as PrivatePaymentOrderOnTheWire,
    };
  };
  const doorsFor = (log: string[], answers: Array<boolean | null>, over: Partial<VaultService> & Partial<ChainBehind> = {}) => {
    let i = 0;
    const service = serviceFrom([view({ heldByCommittee: true, fundable: true })], log, over);
    return {
      ...pacing, ...walletReadsTheVault, now: () => NOW,
      service, indexer: indexerOf(service),
      builder: builder(log),
      paidYet: async () => { log.push('asked the account'); return answers[Math.min(i++, answers.length - 1)]!; },
    };
  };

  it('A PUBLIC PAYMENT OUT OF A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT, IS REFUSED BEFORE ANYTHING IS BUILT', async () => {
    const log: string[] = [];
    const d = {
      ...doorsFor(log, [false]),
      onChain: async (v: string) => ({ holders: { committee: [], threshold: 1, seats: [], approvals: 1, adoptedVaults: [], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }] } }),
    };
    /* RED WHEN: public money is paid out of a vault the service named and the account never adopted. */
    await expect(payPubliclyFromCompanyVault(d, order())).rejects.toThrow(/not one your company's account has adopted/);
    expect(log.filter((l) => l.startsWith('build') || l.startsWith('sent'))).toEqual([]);
  });

  it('A PUBLIC PAYMENT IS BUILT ON THE BLOCK THIS DEVICE READ AT THE WALLET\'S INDEXER; WHAT THE SERVICE WOULD SERVE IS NEVER ASKED', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const d = doorsFor(log, [false, true]);
    await payPubliclyFromCompanyVault({ ...d, service: aServiceThatLies(d.service, asked) }, order());
    /* RED WHEN: the block a public payment is built on is asked of the service. */
    expect(asked).toEqual([]);
    expect(log.filter((l) => l.startsWith('build'))).toEqual(['build public payout of 250 to mn_addr_x at B1']);
  });

  it('BUILDS THE VAULT\'S PUBLIC PAYOUT, SENDS IT THROUGH THE PUBLIC DOOR, AND IS DONE WHEN THE ACCOUNT RECORDS IT', async () => {
    const log: string[] = [];
    const done = await payPubliclyFromCompanyVault(doorsFor(log, [false, true]), order());
    /* RED WHEN: a public payment chooses a note, reads a note's events, goes out through the private door, or
     * reports done before the company's account records it. */
    expect(log).toEqual([
      'read the block here', 'build public payout of 250 to mn_addr_x at B1', 'sent public payout',
      'asked the account', 'asked the account',
    ]);
    expect(done).toEqual({ txRef: 'u' });
  });

  it('A PRIVATE PAYMENT IS NEVER PAID PUBLICLY, AND A PUBLIC ONE NEVER PRIVATELY', async () => {
    const log: string[] = [];
    /* RED WHEN: the public operation takes a payment the leg names as private - it would send a private payee public money. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true]), order({ kind: 'shielded', payee: 'mn_shield-addr_x' })))
      .rejects.toThrow(/^this payment is not a public one, so it is not paid publicly\. Nothing was sent\.$/);
    expect(log).toEqual([]);
    /* RED WHEN: the private operation takes a payment the leg names as public - it would spend a note on a public payee's leaf. */
    const wrapping = newWrappingKeypair();
    await expect(payPrivatelyFromCompanyVault({
      ...pacing, ...walletReadsTheVault, now: () => NOW, me: { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32) },
      myRecordsKey: 'ff'.repeat(32), records: () => new MemorySealedPoolStore(),
      signers: async () => [], ...hereAndThere(serviceFrom([view({ heldByCommittee: true, fundable: true })], log)), builder: builder(log),
      inFlight: inFlightInMemory<PaymentInFlight>(),
    }, order())).rejects.toThrow(/^this payment is not a private one, so it is not paid privately\. Nothing was sent\.$/);
    expect(log).toEqual([]);
  });

  it('IS NOT SENT FOR SOMEBODY THE ACCOUNT ALREADY RECORDS PAID, OR OUTSIDE THE APPROVED WINDOW', async () => {
    const log: string[] = [];
    /* RED WHEN: a public payee the account already records paid is offered a second payment. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true]), order({ paid: true })))
      .rejects.toThrow(/already records this person paid/);
    const late = { ...doorsFor(log, [true]), now: () => new Date(1_900_000_000_000) };
    /* RED WHEN: the window the signers approved is not asked before a public payment is built. */
    await expect(payPubliclyFromCompanyVault(late, order())).rejects.toThrow(/only inside the window/);
    expect(log).toEqual([]);
  });

  it('A PUBLIC PAYMENT OUT OF A VAULT NOT STARTED IS REFUSED BEFORE ANYTHING IS BUILT', async () => {
    const log: string[] = [];
    const notStarted = { chain: async () => view({ heldByCommittee: true, fundable: false }) };
    /* RED WHEN: the public payment's `fundable` check is removed - a payment is then built out of a vault not started. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true], notStarted), order())).rejects.toThrow(/^No payment can be made out of this vault yet.*this vault has not been started/);
    expect(log).toEqual([]);
  });

  it('A PUBLIC PAYMENT READS THE VAULT ON THIS DEVICE, AND THE SERVICE IS NEVER ASKED WHAT THE VAULT HOLDS', async () => {
    const log: string[] = [];
    const asked = { n: 0 };
    /* RED WHEN: the public payment reads the vault through the service's chain route. */
    await payPubliclyFromCompanyVault(theServiceNeverAsked(doorsFor(log, [false, true]), asked), order());
    expect(log).toContain('sent public payout');
    expect(asked.n).toBe(0);
  });

  it('A FAILURE AFTER THE SEND IS NEVER REPORTED AS A PAYMENT THAT DID NOT HAPPEN', async () => {
    const log: string[] = [];
    /* RED WHEN: an account that never records the payment is read as the payment not having been made. */
    const e = await payPubliclyFromCompanyVault(doorsFor(log, [false]), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PublicPaymentNotYetSeen);
    expect(e.message).toMatch(/^the payment may have been sent \(u\) and this device has not seen it land, so it may still land\. Do not pay this person again/);
    /* A refusal before anything was sent says so, and is not dressed up as a payment that may have moved. */
    const refused = Object.assign(new Error('this is not a public payment. Nothing was sent.'), { nothingWasSent: true });
    await expect(payPubliclyFromCompanyVault(doorsFor([], [true], { payoutPublicly: async () => { throw refused; } }), order()))
      .rejects.toBe(refused);
    const lost = await payPubliclyFromCompanyVault(
      doorsFor([], [true], { payoutPublicly: async () => { throw new Error('the socket closed'); } }), order()).catch((x) => x);
    /* RED WHEN: a send that may have reached the chain is reported as nothing sent. */
    expect(lost).toBeInstanceOf(PublicPaymentNotYetSeen);
  });
});

/*
 * The vault's committee and its secret, each held to what the chain shows and never to what the service says alone.
 * A company of one: Ada's wallet signed her records key for her seat, and the chain lists her committee key.
 */
describe('THE VAULT\'S COMMITTEE AND ITS SECRET, FROM THE CHAIN', () => {
  const identity = identityFromSecret(new Uint8Array(32).fill(1));
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  const temporary = { tag: 'schnorr', value: '77'.repeat(32) };
  const sealed = (secret: string, reader: string) => sealSecretCopy({ vault: VAULT, secret, reader }).map((p) => toHex(p));
  /* Ada's own doors, her wallet read stood in by `reads`, one answer per check in order, the last repeated. */
  const ada = (reads: Array<ReturnType<typeof walletRead> | null>, asked: string[]) => {
    const doors = startDoors();
    const statement = signRecordsKey(identity, LABEL, ACCOUNT, doors.me.companyKey, '4a'.repeat(32));
    let n = 0;
    const secretReaders: SecretReaderSources = {
      company: LABEL, committeeKey,
      read: async (v) => { asked.push(`wallet read ${v.slice(0, 4)}`); return reads[Math.min(n++, reads.length - 1)]!; },
      roster: async () => [{
        signerId: 'ada', userId: 'ada', name: 'Ada', filingKey: '00'.repeat(32) as never,
        keys: {
          committeeKey, recordsKey: statement.recordsKey as never,
          recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
        },
      }],
    };
    return { ...doors, secretReaders, mine: recordsKeypairFrom(doors.me.companyKey).publicKey };
  };
  /*
   * A chain that has adopted the vault and holds no secret yet. A run is open on the account only for the secret
   * `openRunFor` names; `holds` is the secret whose commitment the vault holds, if any. Each standing asked with a
   * secret is logged with that secret, and with `raise` when it is asked with a window, which only a raise does.
   */
  const chainBuilder = (log: string[], chain: { openRunFor?: string; holds?: string; runInWindow?: boolean; runOpen?: boolean }) => (): VaultBuilderClient => ({
    ...builder(log),
    governedCall: async (i) => { log.push(`built ${i.order.circuit}`); throw new Error('stand-in: nothing is proved here'); },
    startStanding: async (i) => {
      if (i.secret !== undefined) log.push(`standing with ${i.secret.slice(0, 8)}${i.window === undefined ? '' : ' raise'}`);
      const mine = (i.readers ?? [])[0] ?? '';
      return {
        standing: {
          adopted: true,
          adoption: { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), open: false, approvals: 0, needed: 1, stale: false },
          ...(i.secret === undefined ? {} : {
            secret: {
              set: chain.holds === i.secret, another: chain.holds !== undefined && chain.holds !== i.secret,
              rootIsThisRuns: true, written: [false], started: false,
              run: chain.openRunFor === i.secret ? {
                proposal: 'b1'.repeat(32), payload: 'b2'.repeat(32), named: 'b3'.repeat(32), salt: 'b4'.repeat(32),
                open: chain.runOpen ?? true, approvals: 0, needed: 1, stale: false, opensAt: '1', closesAt: '2', inWindow: chain.runInWindow ?? true,
              } : null,
              ...(i.window === undefined ? {} : {
                raise: { proposal: 'b7'.repeat(32), payload: 'b8'.repeat(32), named: 'b9'.repeat(32), salt: 'ba'.repeat(32), opensAt: '1', closesAt: '2' },
              }),
            },
          }),
        },
        ...(i.secret === undefined ? {} : { run: { root: 'b5'.repeat(32), payees: '1', asset: 'b6'.repeat(32), copies: [{ reader: mine, parts: sealed(i.secret, mine), path: [] }] } as never }),
      };
    },
  });
  const heldByThem = view({ heldByCommittee: true, why: null, authority: { committee: [committeeKey], threshold: 1, counter: '1', shape: 'committee' } });
  const press = async (
    a: ReturnType<typeof ada>, log: string[], chain: { openRunFor?: string; holds?: string; runInWindow?: boolean; runOpen?: boolean }, served: VaultChainView = heldByThem,
  ) => {
    const service = serviceFrom([served], log, { keys: async () => ({ committee, why: null, readers: [a.mine] }) });
    return createCompanyVault({
      ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: chainBuilder(log, chain)(), keys: memoryKeys(log).keys,
    }, VAULT).catch((x) => x);
  };
  const newest = async (a: ReturnType<typeof ada>) => {
    const rec = (await a.records('nonce-secret').get(VAULT))!;
    return { version: rec.version, secret: openNonceSecrets(rec, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]! };
  };

  describe('THE VAULT\'S COMMITTEE IS THE ONE THE SIGNER\'S OWN WALLET READ', () => {
    /* RED WHEN: the check takes the vault's committee from the service's report again. */
    it('the service reports the vault held while the wallet reads it still held by its temporary key: refused, nothing filed', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey, [temporary])], log);
      const e = await press(a, log, {});
      expect(e.name).toBe('VaultStartOwed');
      expect(e.stoppedAt).toBe('vault-not-held');
      expect(await a.records('nonce-secret').get(VAULT)).toBeNull();
      expect(log.filter((l) => l.startsWith('built'))).toEqual([]);
    });

    /* RED WHEN: the service's report of who holds the vault is used - here it names a temporary key and the wallet's read is good. */
    it('the service\'s report and the wallet\'s read differ: the wallet\'s read wins', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const misreported = view({ heldByCommittee: true, why: null, authority: { committee: [temporary], threshold: 1, counter: '0', shape: 'one-key' } });
      const e = await press(a, log, {}, misreported);
      /* Past both reader checks: a secret was filed and the run was raised from it. */
      expect(await a.records('nonce-secret').get(VAULT)).not.toBeNull();
      expect(log).toContain('built propose');
      expect(e.message).toMatch(/raising its first secret could not be built/);
    });

    /* RED WHEN: one wallet read is shared by the check before filing and the check before the run. */
    it('each of the two checks in one press asks the wallet afresh, and the second refuses what changed after the first', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey), walletRead(committeeKey, [temporary])], log);
      const e = await press(a, log, {});
      expect(log.filter((l) => l.startsWith('wallet read'))).toEqual([`wallet read ${VAULT.slice(0, 4)}`, `wallet read ${VAULT.slice(0, 4)}`]);
      /* The first check passed and the secret was filed; the second read sees the vault taken back, and nothing is raised. */
      expect(await a.records('nonce-secret').get(VAULT)).not.toBeNull();
      expect(e.stoppedAt).toBe('vault-not-held');
      expect(log.filter((l) => l.startsWith('built'))).toEqual([]);
    });

    it('a wallet that cannot be asked stops the press as the wallet\'s, before anything is filed', async () => {
      const log: string[] = [];
      const a = ada([null], log);
      a.secretReaders = { ...a.secretReaders, read: async () => { throw new Error('the person closed the wallet'); } } as SecretReaderSources;
      const e = await press(a, log, {});
      expect(e.stoppedAt).toBe('wallet-read-nothing');
      expect(e.message).toMatch(/your wallet did not say who holds the company and this vault \(the person closed the wallet\)/);
      expect(await a.records('nonce-secret').get(VAULT)).toBeNull();
    });
  });

  describe('A NONCE SECRET IS USED ONLY WHEN THE CHAIN VOUCHES FOR IT', () => {
    /* RED WHEN: the device that files a secret builds the run from what the route hands back. */
    it('a secret the service substitutes before any run, wrapped correctly to this device, is never used', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      /* The route files what it is given and hands back a record of the service's own, wrapped to Ada's key. */
      const theirs = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      const X = openNonceSecrets(theirs, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      const store = a.records('nonce-secret');
      let filed = false;
      const put = store.put.bind(store);
      store.put = async (v, r) => { filed = true; await put(v, r); };
      const get = store.get.bind(store);
      store.get = async (v) => (filed ? theirs : get(v));
      const e = await press(a, log, {});
      const used = log.filter((l) => l.startsWith('standing with')).map((l) => l.slice('standing with '.length, 'standing with '.length + 8));
      expect(used.length).toBeGreaterThan(0);
      expect(used, 'RED WHEN: the substituted secret reaches the run').not.toContain(X.slice(0, 8));
      /* And the records no longer holding what this device made, nothing is raised from either. */
      expect(log).not.toContain('built propose');
      expect(e.message).toMatch(/records no longer hold the secret this device was about to use, so its first secret run was not sent/);
    });

    /* RED WHEN: a device sets a secret the records no longer hold as their newest - every deposit would then be refused. */
    it('a secret another device replaced after this one raised its run is not set', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const raised = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      await a.records('nonce-secret').put(VAULT, raised);
      const S = openNonceSecrets(raised, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      /* The run made from S is open and has its approvals; meanwhile another device filed a fresh secret over S. */
      const store = a.records('nonce-secret');
      const get = store.get.bind(store);
      let reads = 0;
      store.get = async (v) => (reads++ < 2 ? get(v) : startNonceSecret(VAULT, [{ publicKey: a.mine }]));
      const build = chainBuilder(log, { openRunFor: S })();
      const approved: VaultBuilderClient = {
        ...build,
        startStanding: async (i) => {
          const st = await build.startStanding(i);
          const run = st.standing.secret?.run;
          return run ? { ...st, standing: { ...st.standing, secret: { ...st.standing.secret!, run: { ...run, approvals: 1 } } } } : st;
        },
        setNonceSecret: async () => { log.push('built set'); return { tx: 'S' }; },
      };
      const service = serviceFrom([heldByThem], log, { keys: async () => ({ committee, why: null, readers: [a.mine] }) });
      const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: approved, keys: memoryKeys(log).keys }, VAULT)
        .catch((x) => x);
      expect(log).not.toContain('built set');
      expect(e.message).toMatch(/records no longer hold the secret this device was about to use, so its first secret was not sent/);
    });

    /* RED WHEN: a filed secret that no run and no commitment vouches for is raised from rather than replaced. */
    it('a later press that finds a filed secret with no run on the chain makes a fresh one, files it and raises from it', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const earlier = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      await a.records('nonce-secret').put(VAULT, earlier);
      const X = openNonceSecrets(earlier, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      const e = await press(a, log, {});
      const now = await newest(a);
      expect(now.version).toBe(2);
      expect(now.secret).not.toBe(X);
      /* The read-back secret is only looked at; the raise is made from the fresh one. */
      expect(log.filter((l) => l.endsWith(' raise'))).toEqual([`standing with ${now.secret.slice(0, 8)} raise`]);
      expect(log).toContain('built propose');
      expect(e.message).toMatch(/raising its first secret could not be built/);
      /* Two checks of the readers: before the fresh secret is filed, and before the run. */
      expect(log.filter((l) => l.startsWith('wallet read'))).toHaveLength(2);
    });

    /* RED WHEN: a second signer's honest read-back is replaced, splitting the signers between two secrets. */
    it('a read-back secret an open run of the signers commits to is approved, not replaced', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const raised = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      await a.records('nonce-secret').put(VAULT, raised);
      const S = openNonceSecrets(raised, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      const e = await press(a, log, { openRunFor: S });
      expect((await newest(a)).version).toBe(1);
      expect(log).toContain('built approve');
      expect(log).not.toContain('built propose');
      expect(e.message).toMatch(/approving its first secret could not be built/);
    });

    /* RED WHEN: a run that can no longer be approved - closed, or outside its window - is taken as vouching for the secret it was made from. */
    it('a read-back secret whose run is closed or outside its window is replaced, not raised from again', async () => {
      for (const [why, chain] of [['outside its window', { runInWindow: false }], ['closed', { runOpen: false }]] as const) {
        const log: string[] = [];
        const a = ada([walletRead(committeeKey)], log);
        const raised = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
        await a.records('nonce-secret').put(VAULT, raised);
        const S = openNonceSecrets(raised, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
        await press(a, log, { openRunFor: S, ...chain });
        const now = await newest(a);
        expect(now.version, why).toBe(2);
        expect(log.filter((l) => l.endsWith(' raise')), why).toEqual([`standing with ${now.secret.slice(0, 8)} raise`]);
      }
    });

    /* RED WHEN: a read-back secret the vault does not hold is carried on with after the run landed. */
    it('a secret the service substitutes after the run landed is refused, and nothing is sent', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      await a.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [{ publicKey: a.mine }]));
      const e = await press(a, log, { holds: 'ee'.repeat(31) + '00' });
      expect(e.name).toBe('VaultStartOwed');
      expect(e.message).toMatch(/already holds a secret other than the one the company's records hold/);
      expect((await newest(a)).version).toBe(1);
      expect(log.filter((l) => l.startsWith('built'))).toEqual([]);
    });
  });

  describe('A DEPOSIT AND A PAYMENT ARE MADE ONLY UNDER THE SECRET THE VAULT HOLDS', () => {
    const wrapping = newWrappingKeypair();
    const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(6) };
    /* RED WHEN: a deposit chooses a coin under a secret the vault's commitment does not name. */
    it('a deposit under a secret the vault does not hold is refused before a coin is chosen or a line filed', async () => {
      const log: string[] = [];
      const s = new Map<WireRecord, MemorySealedPoolStore>();
      const records = (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
      const ready = view({ heldByCommittee: true, fundable: true, state: 'QUJD', notes: [], everCreated: [] });
      const doors = {
        ...pacing, ...walletReadsTheVault, ...hereAndThere(serviceFrom([ready], log)), builder: { vaultOnChain: readOnTheDevice }, me, myRecordsKey: 'ff'.repeat(32), records,
        signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
      };
      await openCompanyVaultPool(doors, VAULT, nothingToCheck);
      const asked: string[] = [];
      const e = await depositIntoCompanyVault({
        ...doors, company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(),
        builder: { ...builder(log), secretIsTheVaults: async (i) => { asked.push(i.state); return false; } },
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x: Error) => x);
      expect((e as Error).message).toMatch(/not the one the vault holds on the chain.*Nothing is filed or deposited/);
      /* Asked of the very state the deposit would be built against, by the step that makes the chain's secret the records' newest and by the deposit's own check. */
      expect(asked.length).toBeGreaterThan(0);
      expect(new Set(asked)).toEqual(new Set(['QUJD']));
      expect(log.filter((l) => l.startsWith('build') || l === 'paid')).toEqual([]);
      expect(await records('deposit-journal').get(VAULT)).toBeNull();
    });

    it('THE CHAIN WINS BEFORE A DEPOSIT CHOOSES ITS COIN: A NEWER SECRET THE VAULT NEVER TOOK IS PASSED OVER FOR THE ONE IT HOLDS', async () => {
      const log: string[] = [];
      const s = new Map<WireRecord, MemorySealedPoolStore>();
      const records = (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
      const ready = view({ heldByCommittee: true, fundable: true, state: 'QUJD', notes: [], everCreated: [] });
      const doors = {
        ...pacing, ...walletReadsTheVault, ...hereAndThere(serviceFrom([ready], log)), builder: { vaultOnChain: readOnTheDevice }, me, myRecordsKey: 'ff'.repeat(32), records,
        signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
      };
      await openCompanyVaultPool(doors, VAULT, nothingToCheck);
      const theVaults = await anUnsetNewerSecret(records, me.companyKey);
      await depositIntoCompanyVault({
        ...doors, company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(),
        builder: { ...builder(log), secretIsTheVaults: async (i) => i.secret === theVaults },
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch(() => undefined);
      /* RED WHEN: a deposit refuses, or chooses its coin, under the records' newest secret when the vault holds an earlier one. */
      expect(log.some((l) => l.startsWith('build deposit'))).toBe(true);
      const newest = (await records('nonce-secret').get(VAULT))!;
      expect([newest.version, newestSecretIn(newest, me.companyKey)]).toEqual([3, theVaults]);
    });
  });
});
