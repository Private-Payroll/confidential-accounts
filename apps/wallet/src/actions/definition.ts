import type { Identity, Secret } from 'midnight-identity/keys/derivation';
import type { ActIntent } from 'midnight-identity/profile/request';
import type { RelayLabel, StepAt } from 'midnight-identity/profile/channel';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { HeldKeyring } from '../keyring/held-keyring.js';

/**
 * WHAT ONE ACTION IS, FOR THE WALLET THAT RUNS IT.
 *
 * An action is three fixed lists and nothing else: what the window shows
 * before the passkey, what is checked after it, and its steps. Each line shown
 * is marked by whose words it is: this wallet's own read that needs no seed,
 * only the page's words, or the action's own account of what it does or checks.
 * What is checked runs with the opened
 * wallet before any step, and a check that does not hold builds nothing. Each
 * step builds its transactions itself and hands each to the page to send; the
 * page's answer means only that it was handed to the service, so a step that
 * needs to know what landed reads the chain for itself.
 */

/** Words on a screen: a key into the wallet's language files, and what goes into it. */
export interface Words {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

/**
 * One line shown before the passkey, and whose words it is: `wallet` for what this wallet read itself, `page` for what
 * only the page says, `action` for the action's own account of what it will do or check, which is neither.
 */
export interface ShownLine extends Words {
  readonly from: 'wallet' | 'page' | 'action';
}

/** The wallet once the passkey has opened it. Held only while the action runs. */
export interface Held {
  readonly identity: Identity;
  readonly secret: Secret;
  /** This wallet's own record of the companies it started and the accounts it pinned, when the screen running the action has it. */
  readonly wallet?: WalletRecord;
  /** The account the person chose in the window, which an action that pays pays from; absent when the screen gives none. */
  readonly account?: number;
}

/**
 * THIS WALLET'S OWN RECORD OF A COMPANY, as the action reads and adds to it: whether it drew the company's label
 * itself, and the account it pinned as that company's. Kept in this wallet's own storage, never read from the page.
 */
export interface WalletRecord {
  /** Whether this wallet drew `label` for a new company and has pinned no account for it yet. */
  drewTheLabel(label: string): boolean;
  /** The account this wallet pinned for `label`, and whether it pinned it as a company it created; null for none. */
  pinnedFor(label: string): { readonly account: string; readonly created: boolean } | null;
  /** Pin `account` as the company `label` this wallet created. Throws, pinning nothing, for a second account. */
  pin(label: string, account: string, from?: 'created' | 'invited'): Promise<void>;
}

/**
 * A step that finds what it acts on is not what this wallet can stand behind: it builds nothing more, and the action
 * stops with these words on the window, as a check after the passkey that did not hold.
 */
export class StepRefused extends Error {
  readonly words: Words;
  constructor(words: Words) {
    super(`the step refused: ${words.key}`);
    this.name = 'StepRefused';
    this.words = words;
  }
}

/**
 * THE PERSON'S SAVED KEYS, FOR A STEP THAT READS OR CHANGES THEM. `open` opens the sealed copy the page handed in,
 * once, and throws `ActionStopped` (`keys-did-not-open`, `older-keys`) for one this wallet refuses. `keep` applies
 * `change` to the saved keys held at that moment, seals the result one write on and hands it to the page in turn with
 * the transactions; it resolves once the page says the service kept them, and throws `ActionStopped` (`keep-refused`,
 * `no-keep-answer`) and stops the action otherwise. A change that drops or alters a seat already held is refused and
 * fails the step. A step keeps the saved keys before it hands over a transaction that needs them kept.
 */
export interface ActKeyring {
  open(): HeldKeyring;
  keep(change: (current: Keyring) => Keyring): Promise<void>;
}

/**
 * What a step is given: the action, the opened wallet, where it is, how to hand a transaction over, how to ask the page
 * for a call to the service, and the person's saved keys when the ask carried them.
 *
 * **A STEP TAKEN UP AGAIN WORKS OUT WHAT IS DONE FROM THE CHAIN**, never from the counts an earlier run of the action
 * ended with: a transaction the page refused or did not answer was still handed to it, and may still land.
 */
export interface StepContext {
  readonly intent: ActIntent;
  /** The page that asked, as the channel saw it: what a key this wallet derives for a company is asked for by. */
  readonly asker: { readonly origin: string; readonly name: string; readonly rdns: string };
  /** The site's name for the person the page is signed in as, when the ask carried their saved keys; null otherwise. */
  readonly person: string | null;
  /** The opened wallet. Reading it after the action has ended throws: a step still running then is cut off. */
  readonly held: Held;
  readonly at: StepAt;
  /** Aborted when the person presses Stop or the action runs out of time. A step stops building when it is. */
  readonly signal: AbortSignal;
  /**
   * Hands one built transaction to the page and resolves once the page says it
   * handed it to the service. Throws `ActionStopped` if the page refused it,
   * did not answer in time, or the action was stopped first. After a refusal or
   * no answer, every later call throws too and the action stops at this step,
   * whatever the step does with the error. Calls are handed over one at a time:
   * each waits for the page's answer to the one before. `label` says what the
   * transaction is for, from the action's list in `act-intents.ts`, and carries
   * a second transaction sent in the same request.
   */
  relay(transaction: string, label?: RelayLabel): Promise<void>;
  /**
   * Asks the page to make one call to the service, in turn with the relays and
   * the keeps, and resolves with the status and body the page reports. Every
   * answer is the page's word: a step relies on one only once it has checked it
   * against what it read itself. A call the action's route list in
   * `act-intents.ts` does not name is never sent. Throws `ActionStopped` if the
   * page would not make it, did not answer in time, or the action was stopped
   * first; after that every later call, relay and keep throws too. A call whose
   * route carries a transaction is counted with the relays.
   */
  call(method: 'GET' | 'PUT' | 'POST', path: string, body?: string): Promise<{ readonly status: number; readonly body: unknown }>;
  /** Adds to what the action's end tells the page: only the parts the action's entry lists, all of them public. */
  tell(outcome: Readonly<Record<string, string | number>>): void;
  /** The person's saved keys, or null when the ask carried none. */
  readonly keyring: ActKeyring | null;
}

export interface ActionStep {
  readonly title: Words;
  run(context: StepContext): Promise<void>;
}

export interface ActionDefinition {
  /** The window's headline, given `{origin}`. */
  readonly headline: string;
  /** (a) What the window shows before the passkey, from reads that need no seed. */
  shown(intent: ActIntent): Promise<readonly ShownLine[]>;
  /** (b) What is checked after the passkey, as the window lists it before. */
  readonly checks: readonly Words[];
  /** (b) The checks themselves: `null` when every one holds, else what did not. */
  check(intent: ActIntent, held: Held): Promise<Words | null>;
  /** (c) The steps, in order. */
  steps(intent: ActIntent): readonly ActionStep[];
}
