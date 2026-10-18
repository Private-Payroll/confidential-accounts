/**
 * An answer to an invitation is believed from the company's inbox in force, or from an older inbox only when the change
 * of the company's key that replaced it named the answer as waiting.
 */
import { describe, expect, it } from 'vitest';
import { newSymmetricKey, type Hex } from './crypto.js';
import { inboxPublicKey, sealToInbox } from './sealed-records.js';
import type { CompanyKeys } from './company-key.js';
import { AnswerNotOpened, answerDigestOf, answerOpenedWith, AnswerToAnOldInvitation, type SealedAnswer } from './answer-opened.js';

const ACC = 'acc_answers';
const K0 = newSymmetricKey() as Hex;
const K1 = newSymmetricKey() as Hex;
const K2 = newSymmetricKey() as Hex;
const sealedTo = (key: Hex, value: unknown): SealedAnswer => sealToInbox(value, inboxPublicKey(key, ACC)) as SealedAnswer;

/** The company's keys at epoch 2, with the answers each change of key named, by the epoch of the inbox they answered. */
const keysWith = (answered: ReadonlyMap<number, ReadonlySet<string>>): CompanyKeys => ({
  epoch: 2, key: K2, newest: 2, keyAt: (e) => [K0, K1, K2][e]!, sealing: () => ({ key: K2, epoch: 2 }), answered,
});

describe('an answer to an invitation, opened across changes of the company\'s key', () => {
  it('an answer sealed to the inbox in force opens with the key in force', () => {
    const got = answerOpenedWith<{ n: number }>(keysWith(new Map()), sealedTo(K2, { n: 1 }), ACC);
    /* RED WHEN: an answer to the inbox in force is refused, or is said to have opened under another key. */
    expect(got).toEqual({ value: { n: 1 }, key: K2, epoch: 2 });
  });

  it('an answer sealed to an older inbox opens only when the change that replaced that key named it', () => {
    const named = sealedTo(K0, { n: 2 });
    const got = answerOpenedWith<{ n: number }>(keysWith(new Map([[0, new Set([answerDigestOf(named)])]])), named, ACC);
    /* RED WHEN: a named answer from before the change is refused, or its proof would be checked under the key in force. */
    expect(got).toEqual({ value: { n: 2 }, key: K0, epoch: 0 });
    /* RED WHEN: an answer sealed to an old inbox and named by no change is believed. */
    expect(() => answerOpenedWith(keysWith(new Map([[0, new Set()]])), sealedTo(K0, { n: 3 }), ACC)).toThrow(AnswerToAnOldInvitation);
    expect(() => answerOpenedWith(keysWith(new Map()), sealedTo(K1, { n: 3 }), ACC)).toThrow(/did not find it waiting/u);
  });

  it('an answer named by a later change than the one that replaced its key is refused', () => {
    const old = sealedTo(K0, { n: 4 });
    /* RED WHEN: any change's list believes an answer, not the one that replaced the key it was sealed to. */
    expect(() => answerOpenedWith(keysWith(new Map([[1, new Set([answerDigestOf(old)])]])), old, ACC)).toThrow(AnswerToAnOldInvitation);
  });

  it('an answer no key of the company opens is refused, and a bare key opens only its own inbox', () => {
    /* RED WHEN: an answer sealed to another company's inbox is opened. */
    expect(() => answerOpenedWith(keysWith(new Map()), sealedTo(newSymmetricKey() as Hex, {}), ACC)).toThrow(AnswerNotOpened);
    expect(answerOpenedWith<{ n: number }>(K0, sealedTo(K0, { n: 5 }), ACC)).toEqual({ value: { n: 5 }, key: K0, epoch: 0 });
    /* RED WHEN: a bare key opens what is sealed to an inbox it does not make. */
    expect(() => answerOpenedWith(K0, sealedTo(K1, {}), ACC)).toThrow(AnswerNotOpened);
  });
});
