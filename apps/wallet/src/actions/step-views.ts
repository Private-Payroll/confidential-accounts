/*
 * THE COMPANY AS ONE STEP OF AN ACTION READS IT, AND THE ONE GATE EVERY SEND OF THE STEP PASSES. A step names its
 * company and the doors it reads who holds it through, and gets its view (`viewFor`): the runner builds the view's
 * source over its calls to the service for the step, so nothing the view reads or writes goes around the page's route
 * list or the check. Every view a step opened ends with the step.
 *
 * The runner runs the gate (`check`) before anything of the step leaves for the chain by its own door: a relay, an ask
 * made by name that carries a transaction, a transaction this wallet sends itself. Every view the step holds checks
 * that the company has not changed since it was read (`stillAsRead`), and a send into a vault checks too that the
 * company's account still adopts that vault, which the vault's own contract does not check on a deposit. A send the
 * view writes itself is checked by the view, once, under the same rules (company-view.ts). A view ended by the step's
 * own send, or by a write refused or not known, is opened again from the same reading, so a later send is checked
 * against what the step read first. A send that moves who holds the company (a seat, the threshold, a vault's
 * threshold, the policy bar, a vault adopted or retired) is declared by the step before it is sent, named exactly
 * (`movesWhoHolds`): the reading the views open again from then holds the holders moved by exactly that, and any
 * other difference still stops the step.
 */
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import {
  companyViewFor,
  THE_STEP_SENT,
  viewHeldOver,
  type CompanyView,
  type HeldReader,
  type ViewHeld
} from '../../../../packages/web-shared/src/company-view.js';
import {
  adopts,
  CompanyChangedMeanwhile,
  holdersStandingOf,
  VaultNotAdopted,
  type HoldersMove
} from '../../../../packages/web-shared/src/company-view-probe.js';
import type { ViewDoors } from '../../../../packages/web-shared/src/company-view-doors.js';
import {
  serviceCallOf,
  serviceSource,
  type AnsweredCall,
  type RecordSource,
  type RecordWrite,
  type ServiceCall
} from '../../../../packages/web-shared/src/records-source.js';
import type { Words } from './definition.js';

/** The company as this wallet reads it for a step. */
export type WalletView = CompanyView<AccountHoldersRead>;

/** The doors every view this wallet opens is given: the device's own stores, how it believes the directory and its own reads of the company on the chain included. */
export type WalletViewDoors = ViewDoors<AccountHoldersRead> &
  Required<Pick<ViewDoors<AccountHoldersRead>, 'kept' | 'directory' | 'chain'>>;

/** How a step gets its view of `company`: its doors, and how the view reads which records the company's anchor holds. */
export type ViewFor = (company: string, doors: WalletViewDoors, held: HeldReader) => ViewHeld<AccountHoldersRead>;

export { VaultNotAdopted };

/** What the person is told when another signer changed the company while the step ran, before anything was handed over. */
export const COMPANY_CHANGED: Words = Object.freeze({ key: 'act.reach.why.company-changed' });

/** The same, once the action had already handed something over: what was sent stands, and nothing more was sent. */
export const COMPANY_CHANGED_AFTER_SENDING: Words = Object.freeze({
  key: 'act.reach.why.company-changed-after-sending'
});

/** What the person is told when a vault money was to go into is no longer the company's. */
export const VAULT_NOT_ADOPTED: Words = Object.freeze({ key: 'act.reach.why.vault-not-adopted' });

/** A transaction this wallet sends itself, through the runner's door: checked first, and counted once it is handed over. */
export interface StraightDoor {
  /** Checks the company again, for a send that waited (a fee confirmed) since the door opened; throws when it moved. */
  ready(): Promise<void>;
  /** Says the transaction was handed to the chain or to the company's own service. */
  handedOver(): void;
}

/** Whether a call's answer says it sent nothing, so the step's views need not be read again after it. */
export const answeredNothingSent = (out: unknown): boolean => {
  const answer = out as {
    readonly status?: unknown;
    readonly body?: { readonly nothingWasSent?: unknown } | null;
  } | null;
  return (
    typeof answer?.status === 'number' &&
    (answer.status < 200 || answer.status >= 300) &&
    answer.body?.nothingWasSent === true
  );
};

/**
 * What a refusal at the gate makes of the action: the words it ends with (none for a failure to check at all), and the
 * marks on what is thrown. The send the gate stopped was never handed over (`thisSendNotSent`); the action sent nothing
 * (`nothingWasSent`) only when nothing of it was handed over before.
 */
export const gateRefusal = (e: unknown, handedOver: number) => {
  const words =
    e instanceof VaultNotAdopted
      ? VAULT_NOT_ADOPTED
      : e instanceof CompanyChangedMeanwhile
        ? handedOver === 0
          ? COMPANY_CHANGED
          : COMPANY_CHANGED_AFTER_SENDING
        : null;
  return {
    words,
    marks: { thisSendNotSent: true as const, ...(handedOver === 0 ? { nothingWasSent: true as const } : {}) }
  };
};

/**
 * The runner's call for one step, as that step's views read through it: the body read as JSON; a refusal thrown with
 * the service's words, its status and its code, marked as nothing sent when the answer says so (or, saying neither,
 * its words do).
 */
export const serviceCallOver = (call: AnsweredCall): ServiceCall =>
  serviceCallOf((path, init) => call(init.method, path, init.body));

/**
 * A send a step says moves who holds the company, named exactly: a proposal's step or a vault's start written through
 * the view, a call by its path, or a call sent straight to the chain.
 */
export type MovingSend =
  | { readonly proposal: string }
  | { readonly start: string }
  | { readonly path: string }
  | { readonly circuit: string; readonly contract: string };

const keyOf = (s: MovingSend): string =>
  'proposal' in s
    ? `proposal ${s.proposal}`
    : 'start' in s
      ? `start ${s.start.toLowerCase()}`
      : 'path' in s
        ? `path ${s.path}`
        : `chain ${s.circuit} ${s.contract.toLowerCase()}`;

/* The declared send a write through the view is, when it is one: a proposal's step, or the account's call of a vault's start. */
const movingWrite = (w: RecordWrite): MovingSend | undefined =>
  w.to === 'proposal'
    ? { proposal: w.id }
    : w.to === 'vault-start' && w.step === 'account'
      ? { start: w.vault }
      : undefined;

/** One view the step holds, with the holders its last read found and the standing its next opening starts from. */
interface Held {
  readonly company: string;
  readonly view: ViewHeld<AccountHoldersRead>;
  readonly at: { checked: AccountHoldersRead | null; movedTo: string | null };
}

/** One move a step declared, under every send that may carry it out: the first of them to go takes it, and the rest drop it. */
interface Moving {
  readonly move: HoldersMove;
  readonly keys: string[];
}

/**
 * The views one step opened, and the gate its sends pass. `inTurn` is the step's call to the service as its views make
 * it, each in its turn; `direct` is the same call made inside a turn already held, as the gate's own reads are.
 */
export class StepViews {
  private readonly held: Held[] = [];
  private readonly opened: WalletView[] = [];
  private readonly moving = new Map<string, Moving>();

  constructor(private readonly calls: { readonly inTurn: ServiceCall; readonly direct: ServiceCall }) {}

  /** The step's view of `company`, held for the gate as well as for the step. */
  readonly viewFor: ViewFor = (company, doors, held) => {
    const at: Held['at'] = { checked: null, movedTo: null };
    const read: WalletViewDoors = { ...doors, holders: async () => (at.checked = await doors.holders()) };
    const view = viewHeldOver((from) => {
      if (from !== undefined && at.movedTo !== null) from.moveHolders(at.movedTo);
      at.movedTo = null;
      const opened = companyViewFor(this.sourceOf(company), read, held, from);
      this.opened.push(opened);
      return opened;
    });
    this.held.push({ company, view, at });
    return view;
  };

  /* The source a view of `company` reads and writes through: a proposal's step or a vault's start it writes carries the move declared for it. */
  private sourceOf(company: string): RecordSource {
    const source = serviceSource(this.calls.inTurn, company);
    return {
      ...source,
      write: async (w) => {
        try {
          return await source.write(w);
        } catch (e) {
          this.drop(movingWrite(w));
          throw e;
        }
      },
      movesOf: (w) => this.take(movingWrite(w)) ?? undefined
    };
  }

  /** The step's word that the first of `sends` to go moves who holds the company by `move` (`StepContext.movesWhoHolds`). */
  readonly movesWhoHolds = (sends: readonly MovingSend[], move: HoldersMove): void => {
    const entry: Moving = { move, keys: sends.map(keyOf) };
    for (const k of entry.keys) this.moving.set(k, entry);
  };

  /* The move declared for `send`, taken off every send it was declared under. */
  private take(send: MovingSend | undefined): HoldersMove | null {
    const entry = send === undefined ? undefined : this.moving.get(keyOf(send));
    if (entry === undefined) return null;
    for (const k of entry.keys) if (this.moving.get(k) === entry) this.moving.delete(k);
    return entry.move;
  }

  /* A send that went nowhere: its own key no longer carries the move, and every other key it was declared under still does. */
  private drop(send: MovingSend | undefined): void {
    if (send === undefined) return;
    const k = keyOf(send);
    const entry = this.moving.get(k);
    if (entry === undefined) return;
    this.moving.delete(k);
    entry.keys.splice(entry.keys.indexOf(k), 1);
  }

  /** Whether a view of the step found that another signer changed the company. */
  changed(): boolean {
    return this.opened.some((v) => v.endedAs === 'changed');
  }

  /* Whether a view of the step refused a deposit into a vault the company does not adopt. */
  private notAdopted(): boolean {
    return this.opened.some((v) => v.endedAs === 'not-adopted');
  }

  /** What the moves declared for `sends` do together, in order, without taking them: null when none was declared. */
  private movesFor(sends: readonly MovingSend[]): HoldersMove | null {
    const entries = [
      ...new Set(sends.map((s) => this.moving.get(keyOf(s))).filter((e): e is Moving => e !== undefined))
    ];
    if (entries.length === 0) return null;
    return (<H extends Parameters<HoldersMove>[0]>(before: H): H =>
      entries.reduce((h, e) => e.move(h), before)) as HoldersMove;
  }

  /**
   * The gate: every view the step holds, opened again after the step's own send or a failed write where it was, finds
   * the company as the step read it, and the account adopts every vault in `into`, both now and as the calls `sends`
   * carries move who holds the company, so no call of one transaction deposits into a vault another call of it
   * retires. A step that opened no view of the company reads nothing of it, so it has nothing to check and passes. A
   * step that held views, none of which is left to check against, is refused, and so is any send into a vault when no
   * view is left.
   */
  async check(into: readonly { readonly vault: string }[] = [], sends: readonly MovingSend[] = []): Promise<void> {
    if (this.notAdopted()) throw new VaultNotAdopted(into[0]?.vault ?? '');
    const moved = into.length === 0 ? null : this.movesFor(sends);
    let checked = 0;
    for (const { company, view, at } of this.held) {
      const now = view.current();
      if (now.ended !== null) continue;
      const holders = await now.stillAsRead(serviceSource(this.calls.direct, company));
      at.checked = holders;
      checked += 1;
      const after = moved === null ? holders : moved(holders);
      for (const { vault } of into)
        if (!adopts(holders, vault) || !adopts(after, vault)) throw new VaultNotAdopted(vault);
    }
    if (checked === 0 && (into.length > 0 || this.held.length > 0)) {
      throw into.length > 0
        ? new VaultNotAdopted(into[0]!.vault)
        : new CompanyChangedMeanwhile(['no view of the company was left to check this send against']);
    }
  }

  /**
   * The step handed over a transaction of the calls `sends`: each view it holds is opened again, from the same reading,
   * before it is next used; the reading's holders are moved by every move the step declared for those calls, in order.
   */
  sent(sends: readonly MovingSend[] = []): void {
    const taken = sends.map((s) => this.take(s)).filter((m): m is HoldersMove => m !== null);
    const declared =
      taken.length === 0
        ? null
        : ((<H extends Parameters<HoldersMove>[0]>(before: H): H =>
            taken.reduce((h, m) => m(h), before)) as HoldersMove);
    for (const { view, at } of this.held) {
      const now = view.current();
      if (now.ended !== null) continue;
      if (declared !== null && at.checked !== null) at.movedTo = holdersStandingOf(declared(at.checked));
      now.end(THE_STEP_SENT, 'sent');
    }
  }

  /**
   * `sends` went nowhere: the move declared for each is dropped from it, so no later send by that way takes it; a send
   * by another way it was declared under (the chain behind a refused service) still takes it.
   */
  notSent(sends: readonly MovingSend[] = []): void {
    for (const s of sends) this.drop(s);
  }

  /** What stops the action once the step is over: a deposit a view refused, or another signer's change a view found. */
  stoppedWith(handedOver: number): Words | null {
    if (this.notAdopted()) return VAULT_NOT_ADOPTED;
    return this.changed() ? (handedOver === 0 ? COMPANY_CHANGED : COMPANY_CHANGED_AFTER_SENDING) : null;
  }

  /** The step is over: nothing more is read or written through its views. */
  end(): void {
    for (const view of this.opened) view.end('the step it was read for ended');
  }
}
