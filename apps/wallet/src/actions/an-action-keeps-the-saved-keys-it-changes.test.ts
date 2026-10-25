import { describe, expect, it } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import type { SealedKeyring } from 'midnight-identity/profile/unlock';
import type { ActEnded, ActingChannel, KeptOver, Relayed } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { toHex, unseal } from '../../../../src/core/crypto.js';
import { sealKeyring, withNewSeat } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { KeyringMark, KeyringMarks } from '../keyring/held-keyring.js';
import { runAction } from './run.js';
import type { ActionDefinition, ActionStep, Held } from './definition.js';
import { keyringSealKeyFor } from '../keyring/seal-key.js';

/*
 * **AN ACTION KEEPS THE SAVED KEYS IT CHANGES BEFORE IT HANDS OVER WHAT NEEDS THEM.** A step opens the person's saved
 * keys from the sealed copy the page handed in, changes them, and has the page keep them, in turn with the
 * transactions; saved keys the wallet refuses, or the page does not keep, stop the action at that step.
 */

const START = Date.now();
const secret = newSecret();
const identity = identityFromSecret(secret);
const held: Held = { identity, secret };
const REQUESTER = { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' };
const KEY = toHex(keyringSealKeyFor(identity, { requester: REQUESTER, person: 'usr_a' }));
const SEAT = { signerId: 'sig_1', signingSecret: '11'.repeat(32), wrappingSecret: '22'.repeat(32), blinding: '33'.repeat(32), scope: '44'.repeat(32) };

const request = (count: number | null): ActRequest => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: REQUESTER, purpose: 'A test.', nonce: 'n1',
  expiresAt: START + 20 * 60_000, hearsProgress: true, intent: { name: 'move-between-vaults' as never, fields: {} },
  person: 'usr_a',
  keyring: { sealed: count === null ? null : sealKeyring({ accounts: {}, counter: count - 1 }, KEY).sealed, version: 5 },
});

const marks = (start?: number): KeyringMarks & { count(p: string): number | undefined } => {
  const seen = new Map<string, KeyringMark>(start === undefined ? [] : [['usr_a', { counter: start, digest: 'ab'.repeat(32) }]]);
  return {
    count: (p) => seen.get(p)?.counter,
    markOf: (p) => seen.get(p) ?? null,
    raise: (p, m) => { if ((seen.get(p)?.counter ?? -1) < m.counter) seen.set(p, m); },
  };
};

/** A page that keeps or refuses saved keys and relays every transaction, recording the order it was handed them. */
const aPage = (keeps: (n: number) => KeptOver) => {
  const order: string[] = [];
  const kept: Array<{ sealed: SealedKeyring; ifVersion: number }> = [];
  const ended: ActEnded[] = [];
  let k = 0;
  const channel = {
    step: () => true,
    relay: async (_at: unknown, tx: string): Promise<Relayed> => { order.push(`relay ${tx}`); return 'relayed'; },
    keep: async (_at: unknown, sealed: SealedKeyring, ifVersion: number): Promise<KeptOver> => {
      order.push('keep');
      kept.push({ sealed, ifVersion });
      return keeps((k += 1));
    },
    answer: (a: unknown) => { ended.push(a as ActEnded); return true; },
  } as unknown as ActingChannel;
  return { channel, order, kept, ended };
};

const actionOf = (steps: readonly ActionStep[]): ActionDefinition => ({
  headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps,
});
const seatThenSend: ActionStep = {
  title: { key: 'x' },
  run: async (c) => {
    c.keyring!.open();
    await c.keyring!.keep((k) => withNewSeat(k, 'acc_A', SEAT));
    await c.relay('AAAA');
  },
};

describe('an action keeps the saved keys it changes', () => {
  it('keeps them before the transaction that needs them, one write on, over the version handed in, and counts them once kept', async () => {
    const page = aPage(() => ({ of: 'kept', version: 6 }));
    const m = marks();
    const end = await runAction({ definition: actionOf([seatThenSend]), request: request(2), channel: page.channel, held, stop: new AbortController().signal, marks: m });
    expect(end.ended).toMatchObject({ ended: 'done', relayed: 1 });
    /* RED WHEN: a transaction that needs the changed saved keys reaches the page before they are kept. */
    expect(page.order).toEqual(['keep', 'relay AAAA']);
    expect(page.kept[0]!.ifVersion).toBe(5);
    const inside = JSON.parse(unseal(page.kept[0]!.sealed, KEY));
    expect(inside.counter).toBe(3);
    expect(inside.accounts.acc_A.signingSecret).toBe(SEAT.signingSecret);
    /* RED WHEN: the wallet does not count kept saved keys as the newest, so an older copy still opens. */
    expect(m.count('usr_a')).toBe(3);
    /* RED WHEN: the end answer does not say what the saved keys now hold, so the page cannot list the seat without opening them;
     * or it says it with a seat's secret in it. */
    expect(Object.keys(page.ended[0]!.keys!.seats)).toEqual(['acc_A']);
    expect(page.ended[0]!.keys!.viewing).toEqual({});
    for (const s of [SEAT.signingSecret, SEAT.wrappingSecret, SEAT.blinding, KEY]) expect(JSON.stringify(page.ended[0])).not.toContain(s);
  });

  it('stops at the step when the page says the saved keys were not kept, and hands over nothing after', async () => {
    const page = aPage(() => 'refused');
    const m = marks();
    const end = await runAction({ definition: actionOf([seatThenSend]), request: request(2), channel: page.channel, held, stop: new AbortController().signal, marks: m });
    /* RED WHEN: a transaction that needs saved keys the service did not keep is still handed over. */
    expect(end.ended).toMatchObject({ ended: 'stopped', why: 'keep-refused', step: 1, relayed: 0 });
    expect(page.order).toEqual(['keep']);
    /* RED WHEN: saved keys the page did not keep are counted as the newest, so the copy the service still holds is refused. */
    expect(m.count('usr_a')).toBe(2);
  });

  it('stops when the page does not say whether they were kept', async () => {
    const page = aPage(() => 'unanswered');
    const end = await runAction({ definition: actionOf([seatThenSend]), request: request(2), channel: page.channel, held, stop: new AbortController().signal, marks: marks() });
    /* RED WHEN: saved keys handed over and never answered are taken as kept. */
    expect(end.ended).toMatchObject({ ended: 'stopped', why: 'no-keep-answer' });
  });

  it('stops before building anything on an older copy of the saved keys', async () => {
    const page = aPage(() => ({ of: 'kept', version: 6 }));
    const end = await runAction({ definition: actionOf([seatThenSend]), request: request(2), channel: page.channel, held, stop: new AbortController().signal, marks: marks(4) });
    /* RED WHEN: an older copy handed in by the page is opened, changed and handed back as the newest. */
    expect(end.ended).toMatchObject({ ended: 'stopped', why: 'older-keys', step: 1 });
    expect(page.order).toEqual([]);
  });

  it('a step of an ask that carried no saved keys has none to open', async () => {
    let seen: unknown = 'not run';
    const { person: _p, keyring: _k, ...bare } = request(2);
    const page = aPage(() => 'refused');
    await runAction({
      definition: actionOf([{ title: { key: 'x' }, run: async (c) => { seen = c.keyring; } }]),
      request: bare as ActRequest, channel: page.channel, held, stop: new AbortController().signal, marks: marks(),
    });
    /* RED WHEN: a step can reach saved keys the page never handed in. */
    expect(seen).toBeNull();
  });
});
