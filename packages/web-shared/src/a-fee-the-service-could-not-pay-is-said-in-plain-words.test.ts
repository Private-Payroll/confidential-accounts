import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as keyring from './keyring.js';

/**
 * **A FEE THE SERVICE COULD NOT PAY IS SAID IN PLAIN WORDS, AND ONLY WHEN NOTHING WAS SENT.**
 *
 * When a step was refused before anything went out, the service says which reason it was (`fee-not-paid`
 * or `network-refused`) beside its text, and the keyring hands that code to the page so the person is told
 * "nothing was lost, try again". A refusal where something may have been sent never carries the code.
 *
 * RED WHEN: a 422 that says nothing was sent loses its code on the way to the page; a 502, or a 422 that
 * does not say nothing was sent, or one with a code the page does not know, is given one.
 */
let answers: Array<() => Response | Promise<Response>> = [];
const reply = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => answers[0]!()));
});
afterEach(() => { vi.unstubAllGlobals(); keyring.forgetLocally(); });

describe('a refusal that says nothing was sent reaches the page with the reason it can say in plain words', () => {
  const codeOf = async () => {
    const caught = await keyring.api('/api/accounts', { method: 'POST' }).catch((e: unknown) => e) as Error & { code?: unknown };
    expect(caught).toBeInstanceOf(Error);
    return caught.code;
  };

  /* RED WHEN: a 422 that says nothing was sent and names `fee-not-paid` or `network-refused` reaches the page without that code, so the page can only say "it did not finish". */
  it('a step refused with nothing sent reaches the page with the reason, so it can say the fee or the network', async () => {
    answers = [reply(422, { nothingWasSent: true, code: 'fee-not-paid', error: 'the fee payer is behind' })];
    expect(await codeOf()).toBe('fee-not-paid');
    answers = [reply(422, { nothingWasSent: true, code: 'network-refused', error: 'the node refused it' })];
    expect(await codeOf()).toBe('network-refused');
  });

  /* RED WHEN: a 502, where something may have been sent, carries the fee code to the page as though nothing had been sent. */
  it('a step that failed after something may have been sent never reaches the page as a fee that was not paid', async () => {
    answers = [reply(502, { nothingWasSent: false, code: 'fee-not-paid', error: 'unknown' })];
    expect(await codeOf()).toBeUndefined();
    answers = [reply(502, { nothingWasSent: true, code: 'fee-not-paid', error: 'unknown' })];
    expect(await codeOf()).toBeUndefined();
  });

  /* RED WHEN: a 422 that does not say nothing was sent, or that names a code the page does not know, is given a code. */
  it('a refusal that does not say nothing was sent, or gives a reason the page does not know, is not given a reason', async () => {
    answers = [reply(422, { nothingWasSent: false, code: 'fee-not-paid', error: 'x' })];
    expect(await codeOf()).toBeUndefined();
    answers = [reply(422, { nothingWasSent: true, code: 'something-else', error: 'x' })];
    expect(await codeOf()).toBeUndefined();
    answers = [reply(422, { nothingWasSent: true, error: 'x' })];
    expect(await codeOf()).toBeUndefined();
  });
});
