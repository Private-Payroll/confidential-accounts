/**
 * **THE PAGE'S SIDE OF THE VAULT WORKER.** One request, one answer, matched by
 * id. The page never loads what the worker loads; it only sends what to build
 * and receives proven bytes back.
 */
import type { Committee } from '../../../src/midnight/vault-committee.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { PaymentsFitAnswer } from '../../../src/midnight/vault-notes.js';
import type { EventOnTheWire, NoteOnTheWire, PaymentConfirmation, SecretRunOnTheWire } from './vault-builder.js';
import type { RoundMadeOf, RoundStanding } from '../../../src/midnight/vault-start.js';

export type { SecretRunOnTheWire } from './vault-builder.js';

/**
 * **HOW FAR A VAULT'S START HAS GOT**, as the worker read it off the account's
 * and the vault's ledgers at one block: adopted or not, where the adoption round
 * stands, and, once the company's record of the secret has been read, where the
 * first secret run, the secret and each sealed copy stand.
 */
export interface StartStandingOnTheWire {
  readonly adopted: boolean;
  readonly adoption: RoundStanding & RoundMadeOf;
  readonly secret?: {
    readonly set: boolean;
    readonly another: boolean;
    readonly rootIsThisRuns: boolean;
    readonly run: (RoundStanding & RoundMadeOf & { readonly opensAt: string; readonly closesAt: string; readonly inWindow: boolean }) | null;
    readonly raise?: RoundMadeOf & { readonly proposal: string; readonly opensAt: string; readonly closesAt: string };
    readonly written: readonly boolean[];
    readonly started: boolean;
  };
}
import type { GovernanceOnTheWire, GovernedCallOrder, OpenedRound, ProposalIdentity, SignerMaterial } from './governed-call-builder.js';

export interface SigningKeyOnTheWire { readonly tag: string; readonly value: string }
export interface CoinOnTheWire { readonly nonce: string; readonly token: string; readonly value: string }
/** One block's view of what a payment out is built on, every value base64 of its bytes. */
export interface PayoutChainOnTheWire {
  readonly blockHash: string;
  readonly vaultState: string;
  readonly zswapState: string;
  readonly parameters: string;
  readonly accountState: string;
}
export type OrderOnTheWire = Omit<PrivatePaymentOrderOnTheWire, 'payments'>;
/**
 * Which transaction created a note, as its events say: `found`; `refused`, the
 * events are there and do not show this note as made there, and asking again
 * will not change that; or `unreadable`, and asking again may answer it.
 */
export type CreatingTransactionAnswer =
  | { readonly state: 'found'; readonly createdIn: string }
  | { readonly state: 'refused' }
  | { readonly state: 'unreadable' };
/** One block's view of the company account, for a raise or an approval to be built on. Base64 of the bytes. */
export interface AccountCallChainOnTheWire {
  readonly blockHash: string;
  readonly accountState: string;
  readonly parameters: string;
}

/**
 * **WHERE THE COMPANY'S PAY-RECORD KEY STANDS ON ITS ACCOUNT, FOR ONE SIGNER**,
 * read off the account's state with its own functions, and a copy of the key
 * sealed to that signer, ready to write.
 */
export interface PayKeyStandingOnTheWire {
  /** The commitment the account holds, or null when none is written yet. */
  readonly committed: string | null;
  readonly isThisKey: boolean;
  readonly sealedMine: boolean;
  readonly round: {
    readonly commitment: string; readonly payload: string; readonly salt: string; readonly proposal: string;
    readonly open: boolean; readonly approvals: number; readonly needed: number; readonly stale: boolean;
  };
  /** The value a governance round names in place of a vault. */
  readonly noVault: string;
  /** The key sealed to the signer's wrapping key, as the four entries the account stores. */
  readonly wrap: string[];
}

export type VaultAsk =
  | { id: number; network: string; ask: 'deploy'; account: string }
  /*
   * **A COMPANY'S ACCOUNT, HELD BY ITS FOUNDING SIGNER'S OWN COMMITTEE KEY FROM
   * ITS FIRST TRANSACTION**, and then the second step that finishes it, signed
   * by that key in the founding signer's wallet. Nothing secret crosses: a
   * seat, a label, a public key and a signature.
   */
  | { id: number; network: string; ask: 'account-deploy'; foundingLeaf: string; label: string; foundingKey: SigningKeyOnTheWire }
  | { id: number; network: string; ask: 'finished-creation'; account: string; signature: SigningKeyOnTheWire }
  /*
   * **A VAULT HELD BY THE COMPANY'S COMMITTEE FROM ITS FIRST TRANSACTION**, and
   * the reading of a vault's deploy, as sent, before it is adopted: held by
   * exactly that committee, this build's circuits, nothing written.
   */
  | { id: number; network: string; ask: 'born-held-vault'; account: string; holders: Committee }
  | { id: number; network: string; ask: 'vault-as-deployed'; vault: string; account: string; holders: Committee; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'handover'; vault: string; counter: string; temporaryKey: SigningKeyOnTheWire; to: Committee }
  | { id: number; network: string; ask: 'deposit'; vault: string; coin: CoinOnTheWire; state: string; parameters: string }
  | { id: number; network: string; ask: 'public-deposit'; vault: string; token: string; amount: string; state: string; parameters: string }
  | { id: number; network: string; ask: 'commitments'; vault: string; coin: CoinOnTheWire }
  | { id: number; network: string; ask: 'step-kept'; vault: string; secret: string; step: StepOnTheWire }
  | { id: number; network: string; ask: 'vault-on-chain'; vault: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'own-seat'; material: SignerMaterial }
  /* The founding signer's seat in a company made on this device: its leaf, and the scope it was made under. */
  | { id: number; network: string; ask: 'founding-seat'; material: { signingSecret: string; blinding: string } }
  /* A company's deploy and its signed second step, carried in fresh transactions: the same account, the same signature. */
  | { id: number; network: string; ask: 'creation-again'; deploy: string; insert: string }
  /* Where the pay-record key stands on the account for one signer, and their copy sealed. The key stays on this device. */
  | {
    id: number; network: string; ask: 'pay-key-standing'; account: string; accountState: string; key: string;
    signingSecret: string; wrappingPublicKey: string;
  }
  | { id: number; network: string; ask: 'secret-is-the-vaults'; vault: string; state: string; secret: string }
  | { id: number; network: string; ask: 'notes-for-payment'; notes: readonly NoteOnTheWire[]; token: string; amount: string }
  | {
    id: number; network: string; ask: 'payments-fit'; notes: readonly NoteOnTheWire[];
    payments: ReadonlyArray<{ token: string; amount: string }>;
  }
  | {
    id: number; network: string; ask: 'after-payment'; notes: readonly NoteOnTheWire[];
    spent: string; further?: readonly string[]; amount: string; change: NoteOnTheWire | null; createdIn: string | null;
  }
  | {
    id: number; network: string; ask: 'confirm-payment'; vault: string; transactionHash: string;
    change: NoteOnTheWire | null; events: readonly EventOnTheWire[];
  }
  | {
    id: number; network: string; ask: 'creating-transaction'; vault: string; commitment: string;
    transactionHash: string; events: readonly EventOnTheWire[];
  }
  | {
    id: number; network: string; ask: 'payout'; vault: string; account: string; order: OrderOnTheWire;
    payment: PrivatePaymentOnTheWire; note: NoteOnTheWire; events: readonly EventOnTheWire[];
    further?: ReadonlyArray<{ readonly note: NoteOnTheWire; readonly events: readonly EventOnTheWire[] }>; chain: PayoutChainOnTheWire;
    /** The vault's current nonce secret, opened on this device, for this one payment. */
    secret: string;
  }
  /*
   * **A VAULT'S START.** The secret, when given, is the one the page opened from
   * the company's filed record, handed to the worker on the same device so the
   * first secret run is made with the contracts' own functions; it keeps none.
   */
  | {
    id: number; network: string; ask: 'start-standing'; vault: string; account: string;
    accountState: string; vaultState: string; secret?: string; readers?: readonly string[]; now: string;
    window?: { opensAt: string; closesAt: string };
  }
  | {
    id: number; network: string; ask: 'set-nonce-secret'; vault: string; account: string; run: SecretRunOnTheWire;
    secret: string; proposal: string; opensAt: string; closesAt: string; chain: PayoutChainOnTheWire;
  }
  | {
    id: number; network: string; ask: 'write-secret-copy'; vault: string; run: SecretRunOnTheWire; place: number;
    state: string; parameters: string;
  }
  | {
    id: number; network: string; ask: 'payout-publicly'; vault: string; account: string; order: OrderOnTheWire;
    payment: PrivatePaymentOnTheWire; chain: PayoutChainOnTheWire;
  }
  /*
   * **THE ONE ASK THAT CARRIES A SIGNER'S OWN KEY MATERIAL**, from the page to
   * the worker on the same device. The worker uses it for this one call and
   * keeps none of it.
   */
  | {
    id: number; network: string; ask: 'proposal-identity'; change: GovernanceOnTheWire; salt: string;
  }
  | { id: number; network: string; ask: 'company-wide' }
  | {
    id: number; network: string; ask: 'governed-call'; account: string; order: GovernedCallOrder;
    material: SignerMaterial; chain: AccountCallChainOnTheWire; opened: OpenedRound;
  };

type Answered<A extends VaultAsk['ask'], T> = { id: number; ok: true; ask: A } & T;

export type VaultAnswer =
  | Answered<'deploy', { vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>
  | Answered<'account-deploy', { account: string; tx: string; insert: ReadonlyArray<{ circuit: string; key: string }> }>
  | Answered<'finished-creation', { tx: string }>
  | Answered<'born-held-vault', { vault: string; tx: string }>
  | Answered<'vault-as-deployed', { refusal: string | null }>
  | Answered<'handover', { tx: string }>
  | Answered<'deposit', { tx: string }>
  | Answered<'public-deposit', { tx: string }>
  | Answered<'commitments', { output: string; held: string }>
  | Answered<'step-kept', { kept: NoteOnTheWire | null }>
  | Answered<'vault-on-chain', { read: VaultOnChainOnTheWire }>
  | Answered<'own-seat', { seat: string }>
  | Answered<'founding-seat', { seat: string; scope: string }>
  | Answered<'creation-again', { account: string; deploy: string; insert: string }>
  | Answered<'pay-key-standing', { standing: PayKeyStandingOnTheWire }>
  | Answered<'secret-is-the-vaults', { matches: boolean }>
  | Answered<'notes-for-payment', { notes: NoteOnTheWire[] }>
  | Answered<'payments-fit', { answer: PaymentsFitAnswer }>
  | Answered<'after-payment', { notes: NoteOnTheWire[] }>
  | Answered<'confirm-payment', { confirmation: PaymentConfirmation }>
  | Answered<'creating-transaction', { answer: CreatingTransactionAnswer }>
  | Answered<'payout', { tx: string; spent: string; change: NoteOnTheWire | null }>
  | Answered<'payout-publicly', { tx: string }>
  | Answered<'governed-call', { tx: string }>
  | Answered<'proposal-identity', { identity: ProposalIdentity }>
  | Answered<'company-wide', { value: string }>
  | Answered<'start-standing', { standing: StartStandingOnTheWire; run?: SecretRunOnTheWire }>
  | Answered<'set-nonce-secret', { tx: string }>
  | Answered<'write-secret-copy', { tx: string }>
  | { id: number; ok: false; error: string };

type Without<T> = T extends unknown ? Omit<T, 'id' | 'network'> : never;
export type VaultRequest = Without<VaultAsk>;

/** What the page needs from wherever vault transactions are built. */
/**
 * **A VAULT AS THE CHAIN HOLDS IT, AS THIS DEVICE READ IT.** `onChain: false`
 * when the indexer holds no state for the address. `notes` and `everCreated`
 * are commitments, 64 hex characters each; `notes` is absent when the state was
 * not laid out the way this build's vault is (`notesWhy` says why). `authority`
 * is who holds the vault; `account` the company account it is pinned to;
 * `started` whether its first secret is set and every sealed copy written.
 */
export type VaultOnChainOnTheWire =
  | { readonly onChain: false }
  | {
    readonly onChain: true;
    readonly state: string;
    readonly notes?: readonly string[];
    readonly notesFromThisBuild: boolean;
    readonly notesWhy?: string;
    readonly everCreated: readonly string[];
    readonly authority: { readonly committee: ReadonlyArray<{ readonly tag: string; readonly value: string }>; readonly threshold: number } | null;
    readonly account: string | null;
    readonly started: boolean;
    /** What it holds in public money, read off its state; absent, with why, when that could not be read. */
    readonly publicBalances?: ReadonlyArray<{ readonly token: string; readonly amount: string }>;
    readonly publicBalancesWhy?: string;
  };

/** One step of the vault's payment journal as it crosses to the worker: its notes in place order, what left, and whether it was a merge. */
interface StepOnTheWire {
  readonly spent: NoteOnTheWire;
  readonly further?: readonly NoteOnTheWire[];
  readonly amount: string;
  readonly merge?: boolean;
}

export interface VaultBuilderClient {
  deploy(account: string): Promise<{ vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>;
  /**
   * The company's account, deployed held by the founding signer's committee key
   * from its first transaction, proved; and the keys of this build the second
   * step inserts, each checked against the compiled account's own digest, as
   * base64 of their files, for the founding signer's wallet to check again.
   */
  accountDeploy?(input: { foundingLeaf: string; label: string; foundingKey: SigningKeyOnTheWire }): Promise<{
    account: string; tx: string; insert: ReadonlyArray<{ circuit: string; key: string }>;
  }>;
  /** The second step of the account's creation, with the founding signer's wallet's signature on it, proved. */
  finishedCreation?(input: { account: string; signature: SigningKeyOnTheWire }): Promise<{ tx: string }>;
  /** A vault deployed held by the company's committee at its threshold from its first transaction, proved. */
  bornHeldVault?(input: { account: string; holders: Committee }): Promise<{ vault: string; tx: string }>;
  /**
   * The vault as its deploy made it, read here: null when it was born held by
   * `holders`, pinned to `account`, with this build's circuits and nothing
   * written; otherwise the sentence that says what it is instead.
   */
  /**
   * The vault as its deploy made it, read in the worker from the deploy the
   * chain holds for its address, at the indexer the person's own wallet names.
   */
  vaultAsDeployed?(input: { vault: string; account: string; holders: Committee; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<{ refusal: string | null }>;
  handover(input: { vault: string; counter: bigint; temporaryKey: SigningKeyOnTheWire; to: Committee }): Promise<{ tx: string }>;
  /** `state` and `parameters` are base64 of the vault's state and of the ledger parameters the chain holds now. */
  deposit(input: { vault: string; coin: CoinOnTheWire; state: string; parameters: string }): Promise<{ tx: string }>;
  /**
   * The vault's public deposit of one public token and one amount, built and
   * proved: no coin, no nonce, no note. `amount` is decimal digits.
   */
  publicDeposit?(input: { vault: string; token: string; amount: string; state: string; parameters: string }): Promise<{ tx: string }>;
  commitments(input: { vault: string; coin: CoinOnTheWire }): Promise<{ output: string; held: string }>;
  /**
   * The one coin a step written in the vault's payment journal kept, if it
   * landed, worked out with the vault's own functions under `secret`: a merge's
   * coin, or a payment's change; `null` when it kept none.
   */
  stepKept(input: { vault: string; secret: string; step: StepOnTheWire }): Promise<NoteOnTheWire | null>;
  /**
   * The vault as the chain holds it, read in this worker from the indexer the
   * person's own wallet names (`indexer`), and from nowhere else.
   */
  vaultOnChain(input: { vault: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<VaultOnChainOnTheWire>;
  /**
   * The seat this signer's own key material makes on the company's account: the
   * leaf the account holds for them, worked out here and not taken from any record.
   */
  ownSeat(material: SignerMaterial): Promise<string>;
  /**
   * The seat keys made on this device make on a company founded here: the leaf
   * the account seats, and the scope it was made under, both worked out with
   * the chain's own function.
   */
  foundingSeat?(material: { signingSecret: string; blinding: string }): Promise<{ seat: string; scope: string }>;
  /** A company's deploy and its signed second step carried again in fresh transactions, as base64. */
  creationAgain?(input: { deploy: string; insert: string }): Promise<{ account: string; deploy: string; insert: string }>;
  /** Where the pay-record key stands on the account (its state as base64) for the signer whose secret is given. */
  payKeyStanding?(input: {
    account: string; accountState: string; key: string; signingSecret: string; wrappingPublicKey: string;
  }): Promise<PayKeyStandingOnTheWire>;
  /**
   * Whether `secret` is the one the vault's commitment names in `state` (base64
   * of the vault's state): its commitment, worked out with the vault's own
   * function, against the one the state holds.
   */
  secretIsTheVaults(input: { vault: string; state: string; secret: string }): Promise<boolean>;
  /**
   * The notes a payment spends, by the one choice every payment makes: in place
   * order, the first the one the vault is offered and the rest the further notes
   * the payment takes. Refuses with what the pool holds.
   */
  notesForPayment(input: { notes: readonly NoteOnTheWire[]; token: string; amount: string }): Promise<NoteOnTheWire[]>;
  /**
   * Whether the notes can make every payment in turn: `fits`, or `does-not-fit`
   * naming the first they cannot. Refuses only when it could not ask.
   */
  paymentsFit(input: { notes: readonly NoteOnTheWire[]; payments: ReadonlyArray<{ token: string; amount: string }> }): Promise<PaymentsFitAnswer>;
  /** The pool after a payment landed: `spent` and every `further` note gone, the change added. */
  afterPayment(input: {
    notes: readonly NoteOnTheWire[]; spent: string; further?: readonly string[]; amount: string;
    change: NoteOnTheWire | null; createdIn: string | null;
  }): Promise<NoteOnTheWire[]>;
  /** What this payment's own events say about it. */
  confirmPayment(input: {
    vault: string; transactionHash: string; change: NoteOnTheWire | null; events: readonly EventOnTheWire[];
  }): Promise<PaymentConfirmation>;
  /** Which transaction created the note with this commitment, as these events of the named transaction say. */
  creatingTransaction(input: {
    vault: string; commitment: string; transactionHash: string; events: readonly EventOnTheWire[];
  }): Promise<CreatingTransactionAnswer>;
  payout(input: {
    vault: string; account: string; order: OrderOnTheWire; payment: PrivatePaymentOnTheWire;
    note: NoteOnTheWire; events: readonly EventOnTheWire[];
    /** The further notes the payment draws on, in place order, each with the events of the transaction that created it. */
    further?: ReadonlyArray<{ readonly note: NoteOnTheWire; readonly events: readonly EventOnTheWire[] }>;
    chain: PayoutChainOnTheWire;
    /** The vault's current nonce secret, opened on this device. */
    secret: string;
  }): Promise<{ tx: string; spent: string; change: NoteOnTheWire | null }>;
  /** A public payment out of the vault, built and proved: no note, no change. */
  payoutPublicly(input: {
    vault: string; account: string; order: OrderOnTheWire; payment: PrivatePaymentOnTheWire; chain: PayoutChainOnTheWire;
  }): Promise<{ tx: string }>;
  /**
   * **A GOVERNANCE PROPOSAL'S IDENTITY, MADE HERE WITH THE CONTRACT'S OWN
   * FUNCTIONS**: the payload the change commits to, and its identity on the
   * chain under the salt given and no vault.
   */
  proposalIdentity(change: GovernanceOnTheWire, salt: string): Promise<ProposalIdentity>;
  /** The value a company-wide run names in place of a vault, made with the account's own function. */
  companyWide(): Promise<string>;
  /** A raise or an approval on the company account, built and proved with this signer's own material. */
  governedCall(input: {
    account: string; order: GovernedCallOrder; material: SignerMaterial; chain: AccountCallChainOnTheWire;
    /** What this device opened from the company's sealed records, which the call is checked against and proved with. */
    opened: OpenedRound;
  }): Promise<{ tx: string }>;
  /**
   * Where a vault's start stands, read off both contracts' states at one block
   * (base64), and with `secret` the first secret run made from it. `now` is
   * this device's clock in seconds, as digits.
   */
  startStanding(input: {
    vault: string; account: string; accountState: string; vaultState: string;
    secret?: string; readers?: readonly string[]; now: string;
    /** A window to make the first secret run's identity with, for a raise about to be built. */
    window?: { opensAt: string; closesAt: string };
  }): Promise<{ standing: StartStandingOnTheWire; run?: SecretRunOnTheWire }>;
  /** The vault's first secret set under its approved run, built against one block's view of both contracts. */
  setNonceSecret(input: {
    vault: string; account: string; run: SecretRunOnTheWire; secret: string; proposal: string; opensAt: string; closesAt: string;
    chain: PayoutChainOnTheWire;
  }): Promise<{ tx: string }>;
  /** One sealed copy of the run's secret written into the vault, by its place in the approved tree. */
  writeSecretCopy(input: { vault: string; run: SecretRunOnTheWire; place: number; state: string; parameters: string }): Promise<{ tx: string }>;
}

interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** A client over a started worker. `network` is the deployment's own network name. */
export function vaultBuilderOver(worker: WorkerLike, network: string): VaultBuilderClient {
  let next = 1;
  const waiting = new Map<number, { resolve: (a: VaultAnswer) => void }>();
  worker.addEventListener('message', (event) => {
    const a = event.data as VaultAnswer;
    if (typeof a !== 'object' || a === null || typeof (a as { id?: unknown }).id !== 'number') return;
    const w = waiting.get(a.id);
    if (w === undefined) return;
    waiting.delete(a.id);
    w.resolve(a);
  });
  const ask = async <A extends VaultAsk['ask']>(request: VaultRequest & { ask: A }) => {
    const id = next;
    next += 1;
    const answered = new Promise<VaultAnswer>((resolve) => waiting.set(id, { resolve }));
    worker.postMessage({ ...request, id, network });
    const a = await answered;
    if (a.ok !== true) throw new Error((a as { error: string }).error);
    if (a.ask !== request.ask) throw new Error('the vault worker answered a different question.');
    return a as Extract<VaultAnswer, { ask: A }>;
  };
  return {
    deploy: async (account) => {
      const a = await ask({ ask: 'deploy', account });
      return { vault: a.vault, temporaryKey: a.temporaryKey, tx: a.tx };
    },
    accountDeploy: async (input) => {
      const a = await ask({ ask: 'account-deploy', ...input });
      return { account: a.account, tx: a.tx, insert: a.insert };
    },
    finishedCreation: async (input) => ({ tx: (await ask({ ask: 'finished-creation', ...input })).tx }),
    bornHeldVault: async (input) => {
      const a = await ask({ ask: 'born-held-vault', ...input });
      return { vault: a.vault, tx: a.tx };
    },
    vaultAsDeployed: async (input) => ({ refusal: (await ask({ ask: 'vault-as-deployed', ...input })).refusal }),
    handover: async (input) => {
      const a = await ask({
        ask: 'handover', vault: input.vault, counter: input.counter.toString(),
        temporaryKey: input.temporaryKey, to: input.to,
      });
      return { tx: a.tx };
    },
    deposit: async (input) => {
      const a = await ask({ ask: 'deposit', ...input });
      return { tx: a.tx };
    },
    publicDeposit: async (input) => ({ tx: (await ask({ ask: 'public-deposit', ...input })).tx }),
    commitments: async (input) => {
      const a = await ask({ ask: 'commitments', ...input });
      return { output: a.output, held: a.held };
    },
    stepKept: async (input) => (await ask({ ask: 'step-kept', ...input })).kept,
    vaultOnChain: async (input) => (await ask({ ask: 'vault-on-chain', ...input })).read,
    ownSeat: async (material) => (await ask({ ask: 'own-seat', material })).seat,
    foundingSeat: async (material) => {
      const a = await ask({ ask: 'founding-seat', material });
      return { seat: a.seat, scope: a.scope };
    },
    creationAgain: async (input) => {
      const a = await ask({ ask: 'creation-again', ...input });
      return { account: a.account, deploy: a.deploy, insert: a.insert };
    },
    payKeyStanding: async (input) => (await ask({ ask: 'pay-key-standing', ...input })).standing,
    secretIsTheVaults: async (input) => (await ask({ ask: 'secret-is-the-vaults', ...input })).matches,
    notesForPayment: async (input) => (await ask({ ask: 'notes-for-payment', ...input })).notes,
    paymentsFit: async (input) => (await ask({ ask: 'payments-fit', ...input })).answer,
    afterPayment: async (input) => (await ask({ ask: 'after-payment', ...input })).notes,
    confirmPayment: async (input) => (await ask({ ask: 'confirm-payment', ...input })).confirmation,
    creatingTransaction: async (input) => (await ask({ ask: 'creating-transaction', ...input })).answer,
    payout: async (input) => {
      const a = await ask({ ask: 'payout', ...input });
      return { tx: a.tx, spent: a.spent, change: a.change };
    },
    payoutPublicly: async (input) => ({ tx: (await ask({ ask: 'payout-publicly', ...input })).tx }),
    governedCall: async (input) => ({ tx: (await ask({ ask: 'governed-call', ...input })).tx }),
    proposalIdentity: async (change, salt) => (await ask({ ask: 'proposal-identity', change, salt })).identity,
    companyWide: async () => (await ask({ ask: 'company-wide' })).value,
    startStanding: async (input) => {
      const a = await ask({ ask: 'start-standing', ...input });
      return { standing: a.standing, ...(a.run === undefined ? {} : { run: a.run }) };
    },
    setNonceSecret: async (input) => ({ tx: (await ask({ ask: 'set-nonce-secret', ...input })).tx }),
    writeSecretCopy: async (input) => ({ tx: (await ask({ ask: 'write-secret-copy', ...input })).tx }),
  };
}

/** The worker, started the way the page starts it, and a client over it once it says it is ready. */
export function startVaultBuilder(network: string): Promise<VaultBuilderClient> {
  const worker = new Worker(new URL('./vault-worker-entry.js', import.meta.url), { type: 'module', name: 'vault-builder' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the part of this page that builds vault transactions did not start.')), 30_000);
    worker.addEventListener('message', function ready(event: MessageEvent) {
      if ((event.data as { kind?: unknown } | null)?.kind !== 'vault-worker-ready') return;
      clearTimeout(timer);
      worker.removeEventListener('message', ready);
      resolve(vaultBuilderOver(worker as unknown as WorkerLike, network));
    });
    worker.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the part of this page that builds vault transactions stopped before it started.'));
    });
  });
}
