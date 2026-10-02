/**
 * **WHICH NOTES A PAYMENT RUN DRAWS ON, AND IN WHAT STEPS. ONE PURE FUNCTION.**
 *
 * The vault checks a plan; it never makes one. It holds the capability and its
 * fixed sizes - a single payment draws on up to two held notes, a batch of up
 * to four payees on up to three, a merge combines two to four into one - and
 * refuses any step whose notes are not held, are of another token, do not
 * cover what is paid, or pay anyone the run did not approve. Choosing the notes,
 * grouping the payees and ordering the steps is this file, and only this file.
 *
 * It runs where the run is paid: on a signer's device, or on the proving
 * service a company opted into. Both call the same function with the same
 * approved run, so nothing depends on which one pays. It imports nothing, reads
 * no clock, no network and no storage, and so it can be improved at any time
 * without touching a contract: a better plan is only ever a different choice
 * among steps the vault already accepts.
 *
 * It is planned ONCE, at the start of a run, over the whole run. The rules are
 * simple on purpose:
 *
 *   - a step takes the largest notes first, as few as cover it;
 *   - when no set within the step's limit covers it, the largest notes are
 *     merged first, up to four at a time, until one set does;
 *   - the change of a payment and the coin of a merge go back into the pool and
 *     are spent by later steps, which then wait for the step that made them.
 *
 * A merge never loses value and always leaves fewer notes, so while the notes
 * of the token hold at least what the run pays, merging ends with a set that
 * covers the step, unless the notes are so large that a merge would make a coin
 * larger than one coin can hold. Then the run is refused, and with notes that
 * large a different choice of notes could sometimes still pay it: these rules
 * are simple, not best, and a better choice is ordinary code here.
 *
 * A step whose notes are all held at the start waits for nothing, so steps can
 * be sent one after another or side by side; `after` says which must land first.
 */

/** The fixed sizes of the vault's steps. Changing one needs a contract change. */
export const STEP_LIMITS = Object.freeze({
  /** Notes a single payment draws on. */
  paymentNotes: 2,
  /** Notes a batch draws on. */
  batchNotes: 3,
  /** Notes a merge combines, at most; it takes at least two. */
  mergeNotes: 4,
  /** Payees in one batch. */
  batchPlaces: 4,
});

/**
 * The most one coin can hold, so the most a merge or a payment's change can be.
 * The vault's circuits and the ledger take amounts of 128 bits, but the Compact
 * runtime that builds a shielded coin on the device describes its value in
 * eight bytes and refuses 2^64 or more, so a plan never makes a coin larger
 * than that.
 */
export const MOST_A_COIN_HOLDS = (1n << 64n) - 1n;

/** A note the vault holds, as the pool records it. `id` names it uniquely: its nonce. */
export interface PlanNote {
  readonly id: string;
  readonly token: string;
  readonly value: bigint;
}

/** One payee of a run. `nonce` is the payee nonce their leaf carries. */
export interface PlanPayee {
  readonly id: string;
  readonly amount: bigint;
  readonly nonce: string;
}

/** One leaf of a run: a single payment, or a batch of one to four payees approved together. */
export interface PlanUnit {
  readonly kind: 'payment' | 'batch';
  readonly payees: readonly PlanPayee[];
}

/** A note a step spends: one held at the start, or the coin an earlier step made. */
export type NoteRef =
  | { readonly kind: 'held'; readonly id: string }
  | { readonly kind: 'made'; readonly step: number };

/** One step of a plan, in the order it is planned. */
export type PlanStep =
  | {
      readonly kind: 'merge';
      /** Two to four notes, largest first. */
      readonly notes: readonly NoteRef[];
      /** What the one kept coin holds. */
      readonly makes: bigint;
      /** Steps that must land before this one. */
      readonly after: readonly number[];
    }
  | {
      readonly kind: 'payment' | 'batch';
      /** Which unit of the run it pays. */
      readonly unit: number;
      /** One to the step's limit, largest first: a payment's first goes to the note it is offered. */
      readonly notes: readonly NoteRef[];
      /** What it pays in all. */
      readonly pays: bigint;
      /** What its change coin holds; nothing means it makes none. */
      readonly change: bigint;
      readonly after: readonly number[];
    };

/** A note of the token the plan leaves in the pool. */
export interface PlanLeft { readonly note: NoteRef; readonly value: bigint }

export type Plan =
  | {
      readonly ok: true;
      readonly units: readonly PlanUnit[];
      readonly steps: readonly PlanStep[];
      readonly left: readonly PlanLeft[];
    }
  | {
      readonly ok: false;
      /** `short`: the notes of the token hold less than the run pays. `too-large`: a leaf needs more than its step can draw on and no merge can make one coin of it. */
      readonly reason: 'short' | 'too-large';
      readonly holds: bigint;
      readonly pays: bigint;
      readonly message: string;
    };

/** What a run is planned from: the pool, the token, and the run as payees or as its approved units. */
export type PlanInput = {
  readonly token: string;
  readonly notes: readonly PlanNote[];
} & ({ readonly payees: readonly PlanPayee[] } | { readonly units: readonly PlanUnit[] });

/** A run that cannot be planned as given, whatever the pool holds. */
export class RunNotPlannable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunNotPlannable';
  }
}

const total = (payees: readonly PlanPayee[]): bigint => payees.reduce((t, p) => t + p.amount, 0n);

/**
 * The run's payees as the leaves its tree is raised over: one payee alone is a
 * single payment; more are batches of four in the order given, the last holding
 * what is left. A payee nonce used twice is refused, because a batch is paid
 * whole or not at all and a repeated nonce would stop every batch after the
 * first that holds it.
 */
const unitsOf = (payees: readonly PlanPayee[]): PlanUnit[] => {
  if (payees.length === 1) return [{ kind: 'payment', payees: payees.slice(0, 1) }];
  const units: PlanUnit[] = [];
  for (let i = 0; i < payees.length; i += STEP_LIMITS.batchPlaces) {
    units.push({ kind: 'batch', payees: payees.slice(i, i + STEP_LIMITS.batchPlaces) });
  }
  return units;
};

const checkUnits = (units: readonly PlanUnit[]): void => {
  if (units.length === 0) throw new RunNotPlannable('a run with nobody to pay has nothing to plan.');
  const ids = new Set<string>();
  const nonces = new Set<string>();
  units.forEach((u, i) => {
    const most = u.kind === 'payment' ? 1 : STEP_LIMITS.batchPlaces;
    if (u.payees.length < 1 || u.payees.length > most) {
      throw new RunNotPlannable(`item ${i} of the run is a ${u.kind} of ${u.payees.length} payee(s). A payment pays one person and a batch one to ${STEP_LIMITS.batchPlaces}.`);
    }
    for (const p of u.payees) {
      if (typeof p.amount !== 'bigint' || p.amount <= 0n) {
        throw new RunNotPlannable(`payee ${p.id} is paid ${String(p.amount)}; the vault refuses a payment of nothing.`);
      }
      if (p.amount > MOST_A_COIN_HOLDS) {
        throw new RunNotPlannable(`payee ${p.id} is paid more than one payment can carry (${MOST_A_COIN_HOLDS}). Pay it as smaller payments.`);
      }
      if (ids.has(p.id)) throw new RunNotPlannable(`payee ${p.id} appears twice in the run.`);
      if (nonces.has(p.nonce)) {
        throw new RunNotPlannable(`the payee nonce of ${p.id} is used twice in the run, so the second leaf holding it could never be paid; raise the run with each payment once.`);
      }
      ids.add(p.id);
      nonces.add(p.nonce);
    }
  });
};

interface Entry { readonly ref: NoteRef; readonly value: bigint; readonly order: string }

const refOrder = (r: NoteRef): string => (r.kind === 'held' ? `h:${r.id}` : `m:${String(r.step).padStart(9, '0')}`);

/** Largest first; equal values in a fixed order, so the same pool always gives the same plan. */
const byLargest = (a: Entry, b: Entry): number =>
  a.value === b.value ? (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) : (a.value > b.value ? -1 : 1);

/**
 * The largest notes, as few as cover `need` and no more than `limit`, or
 * undefined. The change is always less than the last note taken, so it is a
 * coin one coin can hold.
 */
const cover = (pool: readonly Entry[], need: bigint, limit: number): Entry[] | undefined => {
  const chosen: Entry[] = [];
  let sum = 0n;
  for (const e of pool) {
    if (sum >= need || chosen.length === limit) break;
    chosen.push(e);
    sum += e.value;
  }
  return sum >= need ? chosen : undefined;
};

/**
 * The largest notes a merge can combine: two to four, never more than a coin
 * can hold. When the largest note cannot be combined with any other, the next
 * largest are tried, so a pool of a few very large notes and some smaller ones
 * still merges the smaller ones.
 */
const mergeable = (pool: readonly Entry[]): Entry[] | undefined => {
  for (let from = 0; from < pool.length - 1; from += 1) {
    const chosen: Entry[] = [];
    let sum = 0n;
    for (const e of pool.slice(from)) {
      if (chosen.length === STEP_LIMITS.mergeNotes) break;
      if (sum + e.value > MOST_A_COIN_HOLDS) continue;
      chosen.push(e);
      sum += e.value;
    }
    if (chosen.length >= 2) return chosen;
  }
  return undefined;
};

const madeBy = (notes: readonly Entry[]): number[] =>
  [...new Set(notes.flatMap((e) => (e.ref.kind === 'made' ? [e.ref.step] : [])))].sort((a, b) => a - b);

/**
 * **THE PLAN FOR ONE RUN.** Given the vault's notes and the run - as payees,
 * when the run is being raised, or as the units the signers approved, when it
 * is being paid - every step that pays it, in order. It never returns a plan
 * the vault would refuse for its notes. It refuses a run only when the notes of
 * its token hold less than it pays, or when an item needs more notes than its
 * step takes and no merge this planner tries makes them fewer without a coin
 * larger than one coin can hold, which only notes near that limit can cause.
 */
export const planRun = (input: PlanInput): Plan => {
  const units = 'units' in input ? [...input.units] : unitsOf(input.payees);
  checkUnits(units);
  const seen = new Set<string>();
  const pool: Entry[] = [];
  for (const n of input.notes) {
    if (n.token !== input.token) continue;
    if (typeof n.value !== 'bigint' || n.value <= 0n || n.value > MOST_A_COIN_HOLDS) {
      throw new RunNotPlannable(`note ${n.id} holds ${String(n.value)}. A note the vault holds is worth more than nothing and at most ${MOST_A_COIN_HOLDS}.`);
    }
    if (seen.has(n.id)) throw new RunNotPlannable(`note ${n.id} is offered twice; one note can be spent once.`);
    seen.add(n.id);
    const ref: NoteRef = { kind: 'held', id: n.id };
    pool.push({ ref, value: n.value, order: refOrder(ref) });
  }
  const holds = pool.reduce((t, e) => t + e.value, 0n);
  const pays = units.reduce((t, u) => t + total(u.payees), 0n);
  if (holds < pays) {
    return {
      ok: false, reason: 'short', holds, pays,
      message: `this vault holds ${holds} of this token and the run pays ${pays}. Deposit ${pays - holds} more, then pay the run.`,
    };
  }

  const steps: PlanStep[] = [];
  const take = (used: readonly Entry[]): void => {
    for (const e of used) pool.splice(pool.indexOf(e), 1);
  };
  const put = (ref: NoteRef, value: bigint): void => {
    pool.push({ ref, value, order: refOrder(ref) });
  };

  for (const [u, unit] of units.entries()) {
    const need = total(unit.payees);
    const limit = unit.kind === 'payment' ? STEP_LIMITS.paymentNotes : STEP_LIMITS.batchNotes;
    for (;;) {
      pool.sort(byLargest);
      const set = cover(pool, need, limit);
      if (set !== undefined) {
        take(set);
        const held = set.reduce((t, e) => t + e.value, 0n);
        const at = steps.length;
        steps.push({ kind: unit.kind, unit: u, notes: set.map((e) => e.ref), pays: need, change: held - need, after: madeBy(set) });
        if (held > need) put({ kind: 'made', step: at }, held - need);
        break;
      }
      const merge = mergeable(pool);
      if (merge === undefined) {
        return {
          ok: false, reason: 'too-large', holds, pays,
          message: `item ${u} of this run needs more notes than its step can take, and this planner finds no merge that makes them fewer without making a coin larger than ${MOST_A_COIN_HOLDS}. Raise the run again with that item as smaller payments.`,
        };
      }
      take(merge);
      const makes = merge.reduce((t, e) => t + e.value, 0n);
      const at = steps.length;
      steps.push({ kind: 'merge', notes: merge.map((e) => e.ref), makes, after: madeBy(merge) });
      put({ kind: 'made', step: at }, makes);
    }
  }
  pool.sort(byLargest);
  return { ok: true, units, steps, left: pool.map((e) => ({ note: e.ref, value: e.value })) };
};
