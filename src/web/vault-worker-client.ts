/**
 * **THE PAGE'S SIDE OF THE VAULT WORKER.** One request, one answer, matched by
 * id. The page never loads what the worker loads; it only sends what to build
 * and receives proven bytes back.
 */
import type { Committee } from '../midnight/vault-committee.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../midnight/private-payment-wire.js';
import type { PaymentsFitAnswer } from '../midnight/vault-notes.js';
import type { EventOnTheWire, NoteOnTheWire, PaymentConfirmation } from './vault-builder.js';
import type { GovernedCallOrder, OpenedRound, SignerMaterial } from './governed-call-builder.js';

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

export type VaultAsk =
  | { id: number; network: string; ask: 'deploy'; account: string }
  | { id: number; network: string; ask: 'handover'; vault: string; counter: string; temporaryKey: SigningKeyOnTheWire; to: Committee }
  | { id: number; network: string; ask: 'deposit'; vault: string; coin: CoinOnTheWire; state: string; parameters: string }
  | { id: number; network: string; ask: 'public-deposit'; vault: string; token: string; amount: string; state: string; parameters: string }
  | { id: number; network: string; ask: 'commitments'; vault: string; coin: CoinOnTheWire }
  | { id: number; network: string; ask: 'choose-note'; notes: readonly NoteOnTheWire[]; token: string; amount: string }
  | {
    id: number; network: string; ask: 'payments-fit'; notes: readonly NoteOnTheWire[];
    payments: ReadonlyArray<{ token: string; amount: string }>;
  }
  | {
    id: number; network: string; ask: 'after-payment'; notes: readonly NoteOnTheWire[];
    spent: string; amount: string; change: NoteOnTheWire | null; createdIn: string | null;
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
    payment: PrivatePaymentOnTheWire; note: NoteOnTheWire; events: readonly EventOnTheWire[]; chain: PayoutChainOnTheWire;
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
    id: number; network: string; ask: 'governed-call'; account: string; order: GovernedCallOrder;
    material: SignerMaterial; chain: AccountCallChainOnTheWire; opened: OpenedRound;
  };

type Answered<A extends VaultAsk['ask'], T> = { id: number; ok: true; ask: A } & T;

export type VaultAnswer =
  | Answered<'deploy', { vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>
  | Answered<'handover', { tx: string }>
  | Answered<'deposit', { tx: string }>
  | Answered<'public-deposit', { tx: string }>
  | Answered<'commitments', { output: string; held: string }>
  | Answered<'choose-note', { note: NoteOnTheWire }>
  | Answered<'payments-fit', { answer: PaymentsFitAnswer }>
  | Answered<'after-payment', { notes: NoteOnTheWire[] }>
  | Answered<'confirm-payment', { confirmation: PaymentConfirmation }>
  | Answered<'creating-transaction', { answer: CreatingTransactionAnswer }>
  | Answered<'payout', { tx: string; spent: string; change: NoteOnTheWire | null }>
  | Answered<'payout-publicly', { tx: string }>
  | Answered<'governed-call', { tx: string }>
  | { id: number; ok: false; error: string };

type Without<T> = T extends unknown ? Omit<T, 'id' | 'network'> : never;
export type VaultRequest = Without<VaultAsk>;

/** What the page needs from wherever vault transactions are built. */
export interface VaultBuilderClient {
  deploy(account: string): Promise<{ vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>;
  handover(input: { vault: string; counter: bigint; temporaryKey: SigningKeyOnTheWire; to: Committee }): Promise<{ tx: string }>;
  /** `state` and `parameters` are base64 of the vault's state and of the ledger parameters the chain holds now. */
  deposit(input: { vault: string; coin: CoinOnTheWire; state: string; parameters: string }): Promise<{ tx: string }>;
  /**
   * The vault's public deposit of one public token and one amount, built and
   * proved: no coin, no nonce, no note. `amount` is decimal digits.
   */
  publicDeposit?(input: { vault: string; token: string; amount: string; state: string; parameters: string }): Promise<{ tx: string }>;
  commitments(input: { vault: string; coin: CoinOnTheWire }): Promise<{ output: string; held: string }>;
  chooseNote(input: { notes: readonly NoteOnTheWire[]; token: string; amount: string }): Promise<NoteOnTheWire>;
  /**
   * Whether the notes can make every payment in turn: `fits`, or `does-not-fit`
   * naming the first they cannot. Refuses only when it could not ask.
   */
  paymentsFit(input: { notes: readonly NoteOnTheWire[]; payments: ReadonlyArray<{ token: string; amount: string }> }): Promise<PaymentsFitAnswer>;
  afterPayment(input: {
    notes: readonly NoteOnTheWire[]; spent: string; amount: string; change: NoteOnTheWire | null; createdIn: string | null;
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
    note: NoteOnTheWire; events: readonly EventOnTheWire[]; chain: PayoutChainOnTheWire;
  }): Promise<{ tx: string; spent: string; change: NoteOnTheWire | null }>;
  /** A public payment out of the vault, built and proved: no note, no change. */
  payoutPublicly(input: {
    vault: string; account: string; order: OrderOnTheWire; payment: PrivatePaymentOnTheWire; chain: PayoutChainOnTheWire;
  }): Promise<{ tx: string }>;
  /** A raise or an approval on the company account, built and proved with this signer's own material. */
  governedCall(input: {
    account: string; order: GovernedCallOrder; material: SignerMaterial; chain: AccountCallChainOnTheWire;
    /** What this device opened from the company's sealed records, which the call is checked against and proved with. */
    opened: OpenedRound;
  }): Promise<{ tx: string }>;
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
    chooseNote: async (input) => (await ask({ ask: 'choose-note', ...input })).note,
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
