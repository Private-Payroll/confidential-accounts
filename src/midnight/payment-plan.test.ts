/**
 * The run planner: every plan it makes is one the vault accepts, and it never
 * refuses a run the notes of its token can pay. Each plan is replayed here
 * against the vault's own rules for its steps - notes held and of the token,
 * within each step's limit, covering what is paid, change exact, every payee
 * paid once - so a planner that cuts a corner fails on the plan it made.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planRun, STEP_LIMITS, MOST_A_COIN_HOLDS, RunNotPlannable,
  type PlanNote, type PlanPayee, type PlanUnit, type Plan, type NoteRef,
} from './payment-plan.js';

const TOKEN = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);
const note = (id: string, value: bigint, token = TOKEN): PlanNote => ({ id, token, value });
const payee = (id: string, amount: bigint): PlanPayee => ({ id, amount, nonce: `nonce-${id}` });
const payees = (...amounts: bigint[]): PlanPayee[] => amounts.map((a, i) => payee(`p${i}`, a));

/** Replays a plan against the vault's rules and returns what the pool holds at the end. */
const replay = (notes: readonly PlanNote[], plan: Plan): Map<string, bigint> => {
  if (!plan.ok) throw new Error(`no plan: ${messageOf(plan)}`);
  const pool = new Map<string, bigint>();
  for (const n of notes) if (n.token === TOKEN) pool.set(`h:${n.id}`, n.value);
  const key = (r: NoteRef): string => (r.kind === 'held' ? `h:${r.id}` : `m:${r.step}`);
  const paid = new Set<number>();
  plan.steps.forEach((s, i) => {
    const limit = s.kind === 'merge' ? STEP_LIMITS.mergeNotes
      : s.kind === 'payment' ? STEP_LIMITS.paymentNotes : STEP_LIMITS.batchNotes;
    expect(s.notes.length).toBeGreaterThanOrEqual(s.kind === 'merge' ? 2 : 1);
    expect(s.notes.length).toBeLessThanOrEqual(limit);
    let held = 0n;
    for (const r of s.notes) {
      const k = key(r);
      expect(pool.has(k), `step ${i} spends ${k}, which the pool does not hold`).toBe(true);
      held += pool.get(k)!;
      pool.delete(k);
      if (r.kind === 'made') expect(s.after).toContain(r.step);
    }
    /* A step's notes may hold more than one coin together; the coin it makes may not. */
    expect(s.kind === 'merge' ? held : held - s.pays).toBeLessThanOrEqual(MOST_A_COIN_HOLDS);
    if (s.kind === 'merge') {
      expect(s.makes).toBe(held);
      pool.set(`m:${i}`, held);
    } else {
      const unit = plan.units[s.unit]!;
      expect(unit.kind).toBe(s.kind);
      const owed = unit.payees.reduce((t, p) => t + p.amount, 0n);
      expect(s.pays).toBe(owed);
      expect(held >= owed, `step ${i} offers ${held} for ${owed}`).toBe(true);
      expect(s.change).toBe(held - owed);
      expect(paid.has(s.unit), `unit ${s.unit} paid twice`).toBe(false);
      paid.add(s.unit);
      if (s.change > 0n) pool.set(`m:${i}`, s.change);
    }
  });
  expect([...paid].sort((a, b) => a - b)).toEqual(plan.units.map((_, i) => i));
  const left = new Map(plan.left.map((l) => [key(l.note), l.value]));
  expect(left).toEqual(pool);
  for (const v of pool.values()) expect(v > 0n).toBe(true);
  return pool;
};

/** A refused plan's sentence, or nothing. */
const messageOf = (plan: Plan): string => ('message' in plan ? plan.message : '');

const sum = (m: Map<string, bigint>): bigint => [...m.values()].reduce((t, v) => t + v, 0n);

describe('the planner pays what a single note cannot', () => {
  it('pays a payee no single note covers from two notes, in one payment', () => {
    const notes = [note('a', 60n), note('b', 50n)];
    const plan = planRun({ token: TOKEN, notes, payees: payees(100n) });
    replay(notes, plan);
    expect(plan.ok && plan.steps.map((s) => s.kind)).toEqual(['payment']);
    expect(plan.ok && plan.steps[0]!.notes).toEqual([{ kind: 'held', id: 'a' }, { kind: 'held', id: 'b' }]);
  });

  it('merges first when a payment needs more notes than it can take', () => {
    const notes = [note('a', 40n), note('b', 40n), note('c', 40n)];
    const plan = planRun({ token: TOKEN, notes, payees: payees(100n) });
    const pool = replay(notes, plan);
    expect(plan.ok && plan.steps.map((s) => s.kind)).toEqual(['merge', 'payment']);
    expect(sum(pool)).toBe(20n);
  });

  it('pays a batch from exactly three notes without a merge, and merges for a fourth', () => {
    const three = [note('a', 30n), note('b', 30n), note('c', 40n)];
    const p = payees(25n, 25n, 25n, 25n);
    const plan = planRun({ token: TOKEN, notes: three, payees: p });
    replay(three, plan);
    expect(plan.ok && plan.steps.map((s) => s.kind)).toEqual(['batch']);
    const four = [note('a', 25n), note('b', 25n), note('c', 25n), note('d', 25n)];
    const merged = planRun({ token: TOKEN, notes: four, payees: p });
    replay(four, merged);
    expect(merged.ok && merged.steps.map((s) => s.kind)).toEqual(['merge', 'batch']);
  });

  it('spends a later step from the change of an earlier one, and says it waits for it', () => {
    const notes = [note('a', 1_000n)];
    const plan = planRun({ token: TOKEN, notes, units: [
      { kind: 'payment', payees: [payee('x', 100n)] },
      { kind: 'payment', payees: [payee('y', 200n)] },
    ] });
    replay(notes, plan);
    expect(plan.ok && plan.steps[1]!.after).toEqual([0]);
    expect(plan.ok && plan.steps[1]!.notes).toEqual([{ kind: 'made', step: 0 }]);
  });

  it('leaves no note of nothing when a step spends its notes exactly', () => {
    const notes = [note('a', 70n), note('b', 30n)];
    const plan = planRun({ token: TOKEN, notes, payees: payees(100n) });
    expect(replay(notes, plan).size).toBe(0);
    const only = plan.ok ? plan.steps[0] : undefined;
    expect(only !== undefined && only.kind !== 'merge' ? only.change : undefined).toBe(0n);
  });

  it('pays from many small notes, merging as often as it takes', () => {
    const notes = Array.from({ length: 300 }, (_, i) => note(`n${i}`, 1n));
    const plan = planRun({ token: TOKEN, notes, payees: payees(250n) });
    const pool = replay(notes, plan);
    expect(sum(pool)).toBe(50n);
    expect(plan.ok && plan.steps.filter((s) => s.kind === 'merge').length).toBeGreaterThan(70);
  });

  it('never puts one note in two places when notes are worth the same', () => {
    const notes = [note('a', 50n), note('b', 50n), note('c', 50n)];
    const plan = planRun({ token: TOKEN, notes, payees: payees(50n, 50n, 50n) });
    replay(notes, plan);
  });

  it('plans only from notes of the run\'s token', () => {
    const notes = [note('a', 60n), note('z', 1_000n, OTHER), note('b', 50n)];
    const plan = planRun({ token: TOKEN, notes, payees: payees(100n) });
    replay(notes, plan);
    expect(plan.ok && plan.steps[0]!.notes.some((r) => r.kind === 'held' && r.id === 'z')).toBe(false);
  });

  it('refuses only when the notes of the token hold less than the run pays, and says by how much', () => {
    const notes = [note('a', 60n), note('z', 1_000n, OTHER)];
    const plan = planRun({ token: TOKEN, notes, payees: payees(50n, 20n) });
    expect(plan).toMatchObject({ ok: false, reason: 'short', holds: 60n, pays: 70n });
    expect(messageOf(plan)).toMatch(/Deposit 10 more/);
  });

  it('never makes a coin larger than a coin can hold, and refuses only a leaf no set of its step\'s notes can pay', () => {
    const half = (MOST_A_COIN_HOLDS >> 1n) + 1n;
    const big = [note('a', half), note('b', half), note('c', 5n)];
    replay(big, planRun({ token: TOKEN, notes: big, payees: payees(half + 5n) }));
    /* Merging two of these would make a coin past the limit, so the planner pays from them without merging. */
    const full = [note('a', MOST_A_COIN_HOLDS), note('b', MOST_A_COIN_HOLDS), note('c', MOST_A_COIN_HOLDS)];
    replay(full, planRun({ token: TOKEN, notes: full, payees: payees(MOST_A_COIN_HOLDS, MOST_A_COIN_HOLDS, 1n) }));
    /* Two full notes and four halves: the full ones cannot merge with anything, so two halves merge instead.
       RED WHEN a merge is sought only from the largest note down, which refuses a batch the vault can pay. */
    const halves = [note('a', MOST_A_COIN_HOLDS), note('b', MOST_A_COIN_HOLDS), ...['c', 'd', 'e', 'f'].map((id) => note(id, MOST_A_COIN_HOLDS / 2n))];
    const most = (MOST_A_COIN_HOLDS * 29n) / 30n;
    replay(halves, planRun({ token: TOKEN, notes: halves, payees: payees(most, most, most) }));
    /* Four payees of a full coin each need four full notes, and a batch draws on three: no plan pays it. */
    const four = [...full, note('d', MOST_A_COIN_HOLDS)];
    const fullBatch = payees(MOST_A_COIN_HOLDS, MOST_A_COIN_HOLDS, MOST_A_COIN_HOLDS, MOST_A_COIN_HOLDS);
    expect(planRun({ token: TOKEN, notes: four, payees: fullBatch })).toMatchObject({ ok: false, reason: 'too-large' });
    expect(() => planRun({ token: TOKEN, notes: four, payees: payees(MOST_A_COIN_HOLDS + 1n) })).toThrow(/more than one payment can carry/);
  });
});

describe('the planner never refuses a run the vault can pay', () => {
  /** A small fixed generator, so a failure names the case that made it. */
  const prng = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  it('pays every run whose token\'s notes hold enough, over 400 generated pools and runs', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const r = prng(seed);
      const notes = Array.from({ length: 1 + Math.floor(r() * 12) }, (_, i) =>
        note(`n${i}`, BigInt(1 + Math.floor(r() * (r() < 0.3 ? 5 : 500)))));
      const count = 1 + Math.floor(r() * 9);
      const amounts = Array.from({ length: count }, () => BigInt(1 + Math.floor(r() * 300)));
      const holds = notes.reduce((t, n) => t + n.value, 0n);
      const owed = amounts.reduce((t, a) => t + a, 0n);
      const plan = planRun({ token: TOKEN, notes, payees: payees(...amounts) });
      if (holds >= owed) {
        expect(plan.ok, `seed ${seed}: ${messageOf(plan)}`).toBe(true);
        expect(sum(replay(notes, plan))).toBe(holds - owed);
      } else {
        expect(plan).toMatchObject({ ok: false, reason: 'short' });
      }
    }
  });

  it('gives the same plan for the same pool in any order', () => {
    const notes = [note('a', 30n), note('b', 30n), note('c', 90n), note('d', 10n)];
    const p = payees(100n, 20n, 20n, 5n, 3n);
    expect(planRun({ token: TOKEN, notes: [...notes].reverse(), payees: p }))
      .toEqual(planRun({ token: TOKEN, notes, payees: p }));
  });
});

describe('the run as the signers approve it', () => {
  const kinds = (n: number): string[] => {
    const plan = planRun({ token: TOKEN, notes: [note('a', 10_000n)], payees: payees(...Array(n).fill(10n)) });
    return plan.ok ? plan.units.map((u) => `${u.kind}:${u.payees.length}`) : [];
  };

  it('pays a run of one as a single payment and every larger run in batches of four', () => {
    expect(kinds(1)).toEqual(['payment:1']);
    expect(kinds(4)).toEqual(['batch:4']);
    expect(kinds(5)).toEqual(['batch:4', 'batch:1']);
    expect(kinds(9)).toEqual(['batch:4', 'batch:4', 'batch:1']);
  });

  it('refuses a payee nonce used twice, since a batch holding a paid nonce can never be paid', () => {
    const twice = [payee('x', 1n), { id: 'y', amount: 1n, nonce: 'nonce-x' }];
    expect(() => planRun({ token: TOKEN, notes: [note('a', 9n)], payees: twice })).toThrow(/used twice/);
  });

  it('refuses a payment of nothing, a batch of five and a payment of two', () => {
    expect(() => planRun({ token: TOKEN, notes: [note('a', 9n)], payees: payees(0n) })).toThrow(RunNotPlannable);
    const five: PlanUnit = { kind: 'batch', payees: payees(1n, 1n, 1n, 1n, 1n) };
    expect(() => planRun({ token: TOKEN, notes: [note('a', 9n)], units: [five] })).toThrow(/one to 4/);
    const two: PlanUnit = { kind: 'payment', payees: payees(1n, 1n) };
    expect(() => planRun({ token: TOKEN, notes: [note('a', 9n)], units: [two] })).toThrow(/pays one/);
  });

  it('refuses a payee named twice, a run of nobody, and a note worth nothing or more than a coin can hold', () => {
    /* RED WHEN one payee may stand in two leaves of a run. */
    expect(() => planRun({ token: TOKEN, notes: [note('a', 9n)], payees: [payee('x', 1n), { id: 'x', amount: 1n, nonce: 'other' }] }))
      .toThrow(/appears twice/);
    /* RED WHEN a run with nobody in it is planned as nothing to do. */
    expect(() => planRun({ token: TOKEN, notes: [note('a', 9n)], payees: [] })).toThrow(/nobody to pay/);
    /* RED WHEN a note worth nothing, or more than a coin can hold, is planned with. */
    expect(() => planRun({ token: TOKEN, notes: [note('a', 0n)], payees: payees(1n) })).toThrow(/holds 0/);
    expect(() => planRun({ token: TOKEN, notes: [note('a', MOST_A_COIN_HOLDS + 1n)], payees: payees(1n) })).toThrow(/at most/);
  });

  it('holds a coin to what the runtime makes: below 2^64', () => {
    /* RED WHEN the ceiling is read as the circuits' 128 bits: the runtime refuses a coin of 2^64 or more (measured 2 Oct), so a merge planned past it fails. */
    expect(MOST_A_COIN_HOLDS).toBe((1n << 64n) - 1n);
  });

  it('refuses a note offered twice', () => {
    expect(() => planRun({ token: TOKEN, notes: [note('a', 9n), note('a', 9n)], payees: payees(1n) }))
      .toThrow(/offered twice/);
  });
});

describe('where the planner runs', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..');

  it('imports nothing, so a device and the proving service run the same function', () => {
    const source = readFileSync(join(here, 'payment-plan.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it('is never imported by the main server, which holds only ciphertext', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(f) ? [p] : [];
    });
    const server = [...walk(join(root, 'src', 'server')), ...walk(join(root, 'src', 'db'))];
    expect(server.length).toBeGreaterThan(0);
    for (const f of server) expect(readFileSync(f, 'utf8'), f).not.toMatch(/payment-plan/);
  });
});
