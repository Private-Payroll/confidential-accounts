/**
 * The doubles and readings the vault operation's tests share: one company, its vault, its service and its builder,
 * as `vault-operation.test.ts` and `vault-secret-run.test.ts` stand them in.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { type EventOnTheWire, confirmPayment, notesForPayment, poolAfterPayment } from './vault-builder.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { Kept, KeptOnThisDevice } from './in-flight-on-this-device.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../../src/midnight/vault-pool.js';
import { PaymentJournalInStore } from '../../../src/midnight/vault-journal.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { PaymentInFlight, PaymentsInFlight, SecretReaderSources, ServedVaultChain, VaultChainView, VaultService } from './vault-operation.js';
import type { VaultBuilderClient, VaultOnChainOnTheWire } from './vault-worker-client.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { approverRosterFrom } from '../../../src/core/vault-approvers.js';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { creatingTransactionOfNote } from './vault-worker-entry.js';
import { identityFromSecret } from 'midnight-identity';
import { leafOfTheContract, seatOpenedFor } from '../../../src/testing/directory-seats.js';
import { openNonceSecrets, recordsKeypairFrom, startNonceSecret, startNonceSecretAgain } from '../../../src/midnight/company-nonce-secret.js';
import { proposalsKeptInATest } from './a-vaults-start-proposals.test-support.js';
import { recordsReaderOf } from './deposit-on-device.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import { vaultNoteCommitment } from '../../../src/midnight/note-index.js';
import { ledgerTokenOf } from '../../../src/core/assets.js';
import { TEST_TOKEN, registryWithTestPrivateForms } from '../../../src/testing/assets.js';


/** A coin as the worker answers it: every number as decimal digits. */
export const wireOfCoin = (c: { nonce: string; token: string; value: bigint }) => ({ nonce: c.nonce, token: c.token, value: c.value.toString() });
/** A test stand-in for what a chain read says: the device's view, the service's answer and the one knob the worker stand-in turns into `started`. */
export type TestView = VaultChainView & ServedVaultChain & { readonly started?: boolean };

/** Wallet key `n`: the x-only public key of a secret made of one repeated byte, a key the chain builds a committee with. */
export const walletKey = (n: number): string => Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex');

/**
 * Deposits or payments in flight, kept for the length of one test in the clear, one per vault, each changed only
 * under its claim. The sealing is in-flight-on-this-device.ts's, tested in a-deposit-in-flight-stays-in-this-browser.test.ts.
 */
export let claims = 0;
export const inFlightInMemory = <T,>(kept = new Map<string, Kept<T>>()): KeptOnThisDevice<T> => ({
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
export const VAULT = 'ab'.repeat(32);
/* The company's account, and the label it carries. */
export const ACCOUNT = 'c0'.repeat(32) as AccountAddress;
export const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
/* Ada's seat as her seating device made it: its leaf commits to her wallet key for the company, and its opening shows that. */
export const ADAS = seatOpenedFor(committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(1)), LABEL) as { tag: string; value: string }, 1);
/* The company's directory as Ada's device believes it: her seat's entry, with its opening, and her records key as its one reader. */
export const adasDirectory = async () => ({ seats: [{ seat: ADAS.seat, opening: ADAS.opening, retired: null }], leafOf: leafOfTheContract, readers: [recordsKeypairFrom(new Uint8Array(32).fill(4)).publicKey] });
export const committee = { committee: [{ tag: 'schnorr', value: walletKey(0x11) }], threshold: 1 };
/*
 * The company as a device counts it for the vault check, beside the pacing every operation takes: three seats with every
 * right and one approval needed, so no vault here is left short. The check is driven in
 * `src/core/a-vault-keeps-as-many-approvers-as-its-bar.test.ts` and `apps/web/src/adapters/create-vault.test.ts`.
 */
export const nobodyShort = {
  approvers: async () => approverRosterFrom({
    threshold: 1, vaultThresholds: [], seated: ['e1', 'e2', 'e3'].map((leaf) => ({ leaf })), adoptedVaults: [], companyWide: 'cc'.repeat(32),
  }),
  vaultName: (v: string) => v,
};
export const pacing = { sleep: async () => {}, waitMs: 3, everyMs: 1, ...nobodyShort };
/*
 * The vault's company account as the signer's own wallet reads it: an account that has adopted the vault. A test about
 * a vault that is not the company's hands its own.
 */
export const walletReadsTheVault = {
  account: 'c0'.repeat(32) as AccountAddress,
  /* The indexer the wallet names, behind which stands the chain of the stand-in service made last (`serviceFrom`). */
  indexer: async () => ({ indexerUri: CURRENT_CHAIN, indexerWsUri: 'wss://indexer.current.example/ws' }),
  onChain: async (v: string) => ({
    holders: { committee: [{ tag: 'schnorr', value: walletKey(0x11) }], threshold: 1, seats: ['4a'.repeat(32)], approvals: 1, vaultThresholds: [], policyBar: null, seatBar: seatBarOf(1, null), adoptedVaults: [v], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: walletKey(0x11) }] },
  }),
};
/* Stand-in ledger parameters: the header the ledger writes them under, and nothing a ledger could read. */
export const PARAMS = btoa('midnight:ledger-parameters[v8]:stand-in');
export const view = (over: Partial<TestView>): TestView => ({ vault: VAULT, onChain: true, committee, deployed: 'D', ...over });
/*
 * **THE VAULT AS THIS DEVICE'S WORKER READS IT, AT THE INDEXER THE WALLET NAMES.** Each stand-in service's chain is the
 * stand-in chain, and a door's `indexer` names it: the stand-in builder's `vaultOnChain` answers what that chain holds,
 * as the worker would read it - held by the company's committee when the view says so, by one other key when it says
 * not, and started when money may go in. The read of a real ledger state is `vault-on-chain-here.test.ts`'s.
 */
export const chains = new Map<string, (vault: string) => Promise<TestView>>();
/** The indexer a door names when a test gives none of its own: the chain of the stand-in service made last. */
export const CURRENT_CHAIN = 'https://indexer.current.example/api/v3/graphql';
export const indexerOf = (service: VaultService) => {
  const uri = `https://indexer-${chains.size + 1}.example/api/v3/graphql`;
  chains.set(uri, (v) => service.chain(v as never));
  behind.set(uri, behindOf.get(service) ?? nothingBehind(uri));
  return async () => ({ indexerUri: uri, indexerWsUri: `wss://indexer-${chains.size}.example/api/v3/graphql/ws` });
};
/*
 * **WHAT A STEP IS BUILT ON AND JUDGED BY, BEHIND EACH STAND-IN INDEXER**: one block's view, a transaction's events and
 * the vault's own history, as each stand-in service's chain holds them. The stand-in builder reads them at the indexer a
 * door names, as the worker does; a vault's start, a deposit and a payment never ask the service for any of the three.
 * The read of a real indexer's answers is `vault-on-chain-here.test.ts`'s.
 */
export interface ChainBehind {
  payoutState(vault: string): Promise<{ vault: string; account: string; blockHash: string; vaultState: string; zswapState: string; parameters: string; accountState: string }>;
  events(vault: string, transactionHash: string): Promise<{ events: EventOnTheWire[] }>;
  createdBy(vault: string, commitment: string): Promise<{ transactionHash: string; events: EventOnTheWire[] } | null>;
}
export const behind = new Map<string, ChainBehind>();
export const behindOf = new WeakMap<VaultService, ChainBehind>();
export const nothingBehind = (uri: string): ChainBehind => {
  const none = async (): Promise<never> => { throw new Error(`the stand-in has no chain behind ${uri}`); };
  return { payoutState: none, events: none, createdBy: none };
};
export const behindAt = (i: { indexerUri: string }): ChainBehind => behind.get(i.indexerUri) ?? nothingBehind(i.indexerUri);
/** A service, and the indexer door that names its chain. */
export const hereAndThere = (service: VaultService) => ({ service, indexer: indexerOf(service) });
/** The same doors with the service's own answer about the vault refused, and every time it is asked counted. */
export const theServiceNeverAsked = <D extends { service: VaultService }>(d: D, asked: { n: number }): D =>
  ({ ...d, service: { ...d.service, chain: async () => { asked.n += 1; throw new Error('the service was asked what the vault holds'); } } });
export const wireOf = (v: TestView): VaultOnChainOnTheWire => (!v.onChain ? { onChain: false } : {
  onChain: true, state: v.state ?? '',
  ...(v.notes === undefined ? {} : { notes: v.notes }), notesFromThisBuild: v.notesFromThisBuild ?? true,
  ...(v.notesWhy === undefined ? {} : { notesWhy: v.notesWhy }),
  ...(v.nonceCommitment === undefined ? {} : { nonceCommitment: v.nonceCommitment }),
  ...(v.splitJournal === undefined ? {} : { splitJournal: v.splitJournal }),
  everCreated: v.everCreated ?? [],
  account: ACCOUNT,
  started: v.started === true,
  circuits: null, accountCircuits: null,
});
export const readOnTheDevice = async (i: { vault: string; indexer: { indexerUri: string } }): Promise<VaultOnChainOnTheWire> => {
  const chain = chains.get(i.indexer.indexerUri);
  if (chain === undefined) throw new Error(`the stand-in has no chain behind ${i.indexer.indexerUri}`);
  return wireOf(await chain(i.vault));
};
/* A pool opened outside a vault's start, where nobody is approved: there are no readers to check. */
export const nothingToCheck = async (): Promise<void> => {};

export const builder = (log: string[]): VaultBuilderClient => ({
  proofsInProgress: () => [],
  /* What a governance proposal is called, and the value a company-wide run names: no vault operation asks either. */
  proposalIdentity: async () => { throw new Error('a vault operation never names a governance proposal'); },
  vouchedRunIdentity: async () => { throw new Error('a vault operation never asks what a run vouches for'); },
  companyWide: async () => { throw new Error('a vault operation never asks what a company-wide run names'); },
  spendingPolicyKeys: async () => { throw new Error('a vault operation never asks for a spending policy\'s keys'); },
  policyBarKey: async () => { throw new Error('a vault operation never asks for the policy bar\'s key'); },
  clearRun: async () => { throw new Error('a vault operation never charges a run to its period'); },
  periodTotal: async () => { throw new Error('a vault operation never works out a period\'s total'); },
  runCharged: async () => { throw new Error('a vault operation never asks whether a run is charged'); },
  lastRecovery: async () => { throw new Error('a vault operation never asks for the account\'s latest recovery'); },
  anchorHeads: async () => { throw new Error('a vault operation never reads the record anchor'); },
  anchorTag: async () => { throw new Error('a vault operation never anchors the company\'s records'); },
  seatOpenings: async () => { throw new Error('a vault operation never reads whose anchor is whose'); },
  recoverAnchor: async () => { throw new Error('a vault operation never recovers the company\'s records'); },
  accountCallChain: async () => { throw new Error('a vault operation reads both contracts at one block, never the account alone'); },
  anchorsOnChain: async () => { throw new Error('a vault operation never reads the account\'s anchors'); },
  roundsOnChain: async () => { throw new Error('a vault operation never reads where the company\'s proposals stand'); },
  paidLeaves: async () => { throw new Error('a vault operation never reads which payments the account records'); },
  runsOutrun: async () => { throw new Error('a vault operation never reads which runs a removal has outrun'); },
  invitedSeats: async () => { throw new Error('a vault operation never reads which seat an invitation took'); },
  seatInvited: async () => { throw new Error('a vault operation never takes a seat'); },
  anchor: async () => { throw new Error('a vault operation never anchors the company\'s records'); },
  /* The old temporary-key deploy and hand-over: creating a vault never asks for either. */
  deploy: async () => { log.push('build deploy'); return { vault: VAULT, temporaryKey: { tag: 'schnorr', value: walletKey(0x77) }, tx: 'D' }; },
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
  /*
   * A built transaction the stand-in reads names itself after its bytes, ends at the start of time (inside any window),
   * calls this vault's payout once and creates for it the one coin a deposit here builds (`commitments`' output). A test
   * about its end, or about one that names nothing, hands its own.
   */
  readTransaction: async (i) => ({
    identifiers: [`${i.transaction} named`], timeToLive: 0, calls: [{ address: VAULT, entryPoint: 'payout', segments: [1] }],
    coinsForContracts: [{ contract: VAULT, commitment: 'aa'.repeat(32) }], publicTakes: [],
  }),
  /* A transaction is looked for by what the stand-in chain says of it; a test about an indexer that fails hands its own. */
  vaultCallOnChain: async (i) => ownOnChain.get(i.transaction) ?? { of: 'not-seen' },
  commitments: async (i) => ({ output: 'aa'.repeat(32), held: i.coin.nonce === 'ee'.repeat(32) ? 'bb'.repeat(32) : `h${i.coin.nonce.slice(1)}` }),
  ownSeat: async () => { throw new Error('nothing here signs for a seat'); },
  /* The stand-in vault holds the secret the company's records hold; a test about one it does not hands its own. */
  secretIsTheVaults: async () => true,
  /* The vault's secret set by a run raised before any removal the chain counts. */
  secretSetAt: async () => 0,
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
    const first = i.notes[0];
    if (first === undefined) throw new Error('a merge spends at least one note');
    return { tx: 'M', spent: i.notes.map((n) => n.note.nonce), kept: { nonce: 'e7'.repeat(32), token: first.note.token, value: held.toString() } };
  },
  payoutPublicly: async (i) => {
    log.push(`build public payout of ${i.payment.amount} to ${i.payment.payee} at ${i.chain.blockHash}`);
    return { tx: 'U' };
  },
  /* No step of a start is raised here: the stand-in chain shows every one already done. */
  governedCall: async () => { throw new Error('a vault operation asked for a governed call'); },
  startStanding: async (i) => ({
    standing: {
      adopted: true, removals: 0,
      adoption: { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), open: false, approvals: 0, needed: 1, stale: false, approvedHere: false },
      ...(i.secret === undefined ? {} : { secret: { set: true, another: false, held: '00'.repeat(32), landed: [], rootIsThisRuns: true, run: null, written: [true], started: true } }),
    },
    ...(i.secret === undefined ? {} : { run: { copies: [{ reader: '40'.repeat(32), parts: [], path: [] }] } as never }),
  }),
  setNonceSecret: async () => { throw new Error('a start set a secret the chain already holds'); },
  writeSecretCopy: async () => { throw new Error('a start wrote a copy the chain already holds'); },
});
/* Who holds the account and the vault, as a signer's own wallet reads them: a company of one, the vault held by it. */
export const walletRead = (committeeKey: { tag: string; value: string }, vaultHeldBy: Array<{ tag: string; value: string }> = [committeeKey], seats: string[] = [ADAS.seat]) => ({
  committee: [committeeKey], threshold: 1, seats,
  vault: { vault: VAULT, account: ACCOUNT, committee: vaultHeldBy, threshold: 1 },
});
/** What creating a vault is handed to start it: this signer, their records and their own three. */
export const startDoors = () => {
  const wrapping = recordsKeypairFrom(new Uint8Array(32).fill(4));
  const s = new Map<WireRecord, MemorySealedPoolStore>();
  return {
    me: { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(4) },
    myRecordsKey: recordsKeypairFrom(new Uint8Array(32).fill(4)).publicKey,
    records: (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    /* The company's proposals the vault's adoption and first secret run are written down in, Ada's seat an admin's. */
    proposals: proposalsKeptInATest({ signingSecret: '11'.repeat(32) as Hex }).doors,
    /* Refuses every reader: a wallet that read nothing. A test that reaches the check hands its own. */
    secretReaders: { company: LABEL, committeeKey: committee.committee[0]!, read: async () => null, roster: async () => [], directory: adasDirectory } as SecretReaderSources,
  };
};
/** The newest secret a nonce-secret record holds, opened with `companyKey`. */
export const newestSecretIn = (rec: Parameters<typeof openNonceSecrets>[0], companyKey: Uint8Array): string => {
  const opened = openNonceSecrets(rec, VAULT, recordsKeypairFrom(companyKey));
  return opened.secrets[opened.secrets.length - 1]!;
};
/**
 * The records as a device left them after filing a fresh secret it never set: version 1 is the one the vault holds,
 * version 2 is newer and the vault does not hold it. Answers the vault's secret.
 */
export const anUnsetNewerSecret = async (records: (r: WireRecord) => MemorySealedPoolStore | { get: (v: string) => Promise<unknown>; put: (v: string, p: never) => Promise<unknown> }, companyKey: Uint8Array): Promise<string> => {
  const first = (await records('nonce-secret').get(VAULT)) as Parameters<typeof openNonceSecrets>[0];
  await records('nonce-secret').put(VAULT, startNonceSecretAgain(first, VAULT, [recordsReaderOf(companyKey)]) as never);
  return newestSecretIn(first, companyKey);
};
/** A start whose chain already shows the secret set, so the company's records already hold it too. */
export const filedAlready = async () => {
  const doors = startDoors();
  await doors.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(doors.me.companyKey)]));
  return doors;
};
export const serviceFrom = (views: TestView[], log: string[], over: Partial<VaultService> & Partial<ChainBehind> = {}): VaultService => {
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
    /* Nothing on the page asks the service for its block; a test that asks whether it was asked counts it. */
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
export const aServiceThatLies = (service: VaultService, asked: string[]): VaultService => ({
  ...service,
  payoutState: async () => {
    asked.push('the block');
    return { vault: VAULT as never, account: 'ee'.repeat(32) as never, blockHash: 'LIE', vaultState: 'L', zswapState: 'L', parameters: btoa('midnight:ledger-parameters[v8]:a lie'), accountState: 'L' };
  },
});
/** The events a landed payment has, by its hash; a test fills this in when its payment lands. */
export const paymentEvents = new Map<string, Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>>();
/**
 * What the chain says of a transaction this device holds, looked for by its own identifiers, under the transaction the
 * stand-in builder built; a test fills this in when its payment lands or is refused. One not listed is not seen.
 */
export const ownOnChain = new Map<string, { of: 'landed' | 'refused'; transactionHash: string } | { of: 'not-known'; why: string }>();
export const eventsOfAPayment = async (hash: string, change: { nonce: string; token: string; value: bigint } | null, vault = VAULT) => [
  { transactionHash: hash, details: { tag: 'zswapInput' } },
  { transactionHash: hash, details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), mtIndex: '11' } },
  ...(change === null ? [] : [{
    transactionHash: hash,
    details: { tag: 'zswapOutput', commitment: await vaultNoteCommitment(change as never, vault as never), contract: vault, mtIndex: '12' },
  }]),
];
export const oneKey = view({ authority: { committee: [{ tag: 'schnorr', value: walletKey(0x99) }], threshold: 1, counter: '0', shape: 'one-key' }, heldByCommittee: false });
export const held = view({ heldByCommittee: true });

/** A private payment out of the vault: one signer, one covered note the chain holds, an order, and the doors over them. */
export const aPrivatePaymentOut = () => {
  const wrapping = recordsKeypairFrom(new Uint8Array(32).fill(3));
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(3) };
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  const PAID_IN = 'dd'.repeat(32);
  const NOTE = { nonce: '01'.repeat(32), token: ledgerTokenOf(TEST_TOKEN, 'shielded', registryWithTestPrivateForms()), value: 500n, createdIn: '0e'.repeat(32) };
  const TOKEN = NOTE.token;
  const CHANGE = { nonce: 'cc'.repeat(32), token: NOTE.token, value: 300n };
  const NOW = new Date(1_800_000_000_000);
  const order = (over: Partial<PrivatePaymentOrderOnTheWire> = {}, pay: Partial<PrivatePaymentOnTheWire> = {}): {
    order: PrivatePaymentOrderOnTheWire; payment: PrivatePaymentOnTheWire;
  } => {
    const payment: PrivatePaymentOnTheWire = {
      index: 0, kind: 'shielded', payee: 'mn_shield-addr_x', token: NOTE.token, amount: '200', blinding: '0b'.repeat(32),
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
    ownOnChain.clear();
    const log: string[] = [];
    const s = new Map<WireRecord, MemorySealedPoolStore>();
    const records = (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
    await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers)
      .create(VAULT, { notes: (Array.isArray(note) ? note : [note]) as never });
    /* The vault's nonce secret, filed when it was started: a payment out is made with it. */
    await records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(me.companyKey)]));
    const held = view({ heldByCommittee: true, started: true, notes: chainNotes });
    const kept = new Map<string, Kept<PaymentInFlight>>();
    const inFlight: PaymentsInFlight = inFlightInMemory<PaymentInFlight>(kept);
    const doors = (over: Partial<VaultService> & Partial<ChainBehind> = {}, views = [held]) => {
      const service = serviceFrom(views, log, over);
      return {
        ...pacing, ...walletReadsTheVault, now: () => NOW, me, myRecordsKey: 'ff'.repeat(32), records, signers,
        service, indexer: indexerOf(service), builder: builder(log), inFlight,
        /* This device's seat, an admin's: a rebuild on the way to a payment may file the vault's records. */
        seatHere: async () => ({ role: 'admin' as const, retired: null }),
      };
    };
    const pool = () => new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    const notesNow = async () => (await pool().load(VAULT)).notes;
    const journal = async () => (await new PaymentJournalInStore(records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers).open()).attempts;
    return { log, doors, notesNow, journal, pool, kept };
  };
  /** The payment's own events appear once it has been sent, and, for one that keeps no change, its own transaction. */
  const landsWhenSent = (change: typeof CHANGE | null = CHANGE): Partial<VaultService> => ({
    payout: async () => {
      paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, change));
      if (change === null) ownOnChain.set('O', { of: 'landed', transactionHash: PAID_IN });
      return { txRef: 'o', transactionHash: PAID_IN };
    },
  });
  return { wrapping, me, signers, TOKEN, PAID_IN, NOTE, CHANGE, NOW, order, setUp, landsWhenSent };
};
