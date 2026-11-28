/**
 * Every action that reads the company may make every read of the company's view, each as a read, so a read the view
 * makes never stops an action whose list was written before that read existed. An action that never reads the company
 * is not given them, and no action's list names a route twice.
 */
import { describe, it, expect } from 'vitest';
import { ACT_INTENTS, routeOf, type CallRoute, type IntentShape } from './act-intents.js';
import { UPKEEP_CALLS, VIEW_READS } from './act-intent-calls.js';

/* A call the page would make for a route: the account's and a proposal's ids in place of `:record` and `:proposal`, and the query a route names. */
const QUERY: Record<string, string> = { root: 'ab'.repeat(32), after: '0', limit: '64' };
const callOf = (r: CallRoute): string =>
  r.path.replace(':record', 'acc_view').replace(':proposal', 'prp_view') +
  ((r.query ?? []).length === 0 ? '' : `?${(r.query ?? []).map((q) => `${q}=${QUERY[q]}`).join('&')}`);
const named = (shape: IntentShape, r: CallRoute) =>
  (shape.calls ?? []).some((c) => c.method === r.method && c.path === r.path);
const intents = Object.entries(ACT_INTENTS) as Array<[string, IntentShape]>;
/*
 * Taking a seat offered by an invitation reads only the company's directory, before its holder is a member, and lists
 * exactly the routes it calls; it never reads through the company's view.
 */
const BEFORE_THE_VIEW = ['seat-invited'];
const reading = intents.filter(
  ([name, shape]) => !BEFORE_THE_VIEW.includes(name) && VIEW_READS.some((r) => named(shape, r))
);

describe("the company view's reads in every action", () => {
  it('lets every action that reads the company make every read of the view, each as a read that sends nothing', () => {
    /* RED WHEN: an action that reads the company leaves out one of the view's reads, or lists one as a call that writes. */
    const missing = reading.flatMap(([name, shape]) =>
      VIEW_READS.filter((r) => {
        const route = routeOf(shape, r.method, callOf(r));
        return route === null || route.reads !== r.reads || route.sends === true;
      }).map((r) => `${name}: ${r.method} ${r.path}`)
    );
    expect(missing).toEqual([]);
    expect(reading.length).toBeGreaterThan(20);
  });

  it("names each of the view's reads, the three list reads among them, as reads", () => {
    /* RED WHEN: a read of the view is dropped from the one list, or a list read is listed as a call that writes. */
    expect(VIEW_READS.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'POST /api/accounts/:record/records/read',
        'POST /api/accounts/:record/vault-records/read',
        'POST /api/accounts/:record/handovers',
        'GET /api/accounts/:record',
        'GET /api/accounts/:record/directory',
        'GET /api/accounts/:record/people',
        'POST /api/proposals/:proposal/standing'
      ])
    );
    /* RED WHEN: a read the wallet's view makes of the chain itself is listed as one it asks the service for. */
    expect(
      VIEW_READS.map((r) => r.path).filter((p) =>
        /\/(call-state|chain|payout-state|authority|committee-change|vault-keys)$/u.test(p)
      )
    ).toEqual([]);
    expect(VIEW_READS.filter((r) => r.method === 'POST').every((r) => r.reads === true)).toBe(true);
    expect(VIEW_READS.some((r) => r.method === 'PUT' || r.sends === true)).toBe(false);
  });

  it("gives the view's reads to no action that never reads the company", () => {
    /* RED WHEN: finishing a company, claiming a payee's place or taking a seat by an invitation is given the company's reads. */
    const without = intents.filter(([, shape]) => !VIEW_READS.every((r) => named(shape, r))).map(([name]) => name);
    expect(without).toEqual(
      expect.arrayContaining(['finish-company', 'claim-by-address', 'join-by-code', 'seat-invited'])
    );
  });

  it("leaves the view's reads out of the upkeep, which every action adding the upkeep makes through the view", () => {
    /* RED WHEN: the upkeep names a read the view already makes, or an action that adds the upkeep cannot make the view's reads. */
    expect(UPKEEP_CALLS.filter((u) => VIEW_READS.some((r) => r.method === u.method && r.path === u.path))).toEqual([]);
    const upkeep = intents.filter(([, shape]) => UPKEEP_CALLS.every((u) => named(shape, u)));
    expect(upkeep.filter(([, shape]) => !VIEW_READS.every((r) => named(shape, r))).map(([name]) => name)).toEqual([]);
    expect(upkeep.length).toBeGreaterThan(20);
  });

  it("names no route twice in any action's list", () => {
    /* RED WHEN: a list built from shared lists carries a route twice, so a later copy with other flags would never be read. */
    const twice = intents.flatMap(([name, shape]) =>
      (shape.calls ?? [])
        .filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) !== i)
        .map((r) => `${name}: ${r.method} ${r.path}`)
    );
    expect(twice).toEqual([]);
  });
});
