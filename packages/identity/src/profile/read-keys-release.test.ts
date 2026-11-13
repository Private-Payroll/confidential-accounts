/**
 * **THE READ KEYS A READER'S WALLET HANDS A PAGE ARE READ IN ONE CLOSED SHAPE, AND ONLY AT THE END OF THE READER'S ACT.**
 */
import { describe, expect, it } from 'vitest';
import { ACT_ENDED_SCHEMA } from './channel.js';
import { readActEnded } from './act-channel.js';
import { MOST_RELEASED_EPOCHS, readReleasedReadKeys } from './read-keys-release.js';

const KEY = 'ab'.repeat(32);
const RELEASE = { accountId: 'acc_1', byEpoch: { 0: { roster: KEY, policy: KEY }, 1: { roster: KEY } } };
const ended = (intent: string, over: Record<string, unknown> = {}) => ({
  schema: ACT_ENDED_SCHEMA, nonce: 'n1', intent, ended: 'done', step: 1, steps: 1, relayed: 0, unconfirmed: 0, readKeys: RELEASE, ...over,
});

describe('THE READ KEYS RELEASED TO A READER\'S PAGE', () => {
  it('ARE READ WHOLE IN THEIR ONE SHAPE, AND REFUSED WHOLE IN ANY OTHER', () => {
    expect(readReleasedReadKeys(RELEASE)).toEqual({ accountId: 'acc_1', byEpoch: { 0: { roster: KEY, policy: KEY }, 1: { roster: KEY } } });
    /* RED WHEN: a release carrying anything beside the company and its keys by epoch, such as a company key or a reader's key, is read. */
    expect(readReleasedReadKeys({ ...RELEASE, companyKey: KEY })).toBeNull();
    expect(readReleasedReadKeys({ ...RELEASE, byEpoch: { 0: { roster: KEY.toUpperCase() } } })).toBeNull();
    expect(readReleasedReadKeys({ ...RELEASE, byEpoch: { '01': { roster: KEY } } })).toBeNull();
    expect(readReleasedReadKeys({ ...RELEASE, byEpoch: { 0: { 'Roster!': KEY } } })).toBeNull();
    expect(readReleasedReadKeys({ ...RELEASE, byEpoch: {} })).toBeNull();
    expect(readReleasedReadKeys({ ...RELEASE, byEpoch: { 0: {} } })).toBeNull();
    expect(readReleasedReadKeys({ ...RELEASE, accountId: '../x' })).toBeNull();
    /* RED WHEN: a release naming a kind of record the caller's closed list does not hold is read. */
    expect(readReleasedReadKeys(RELEASE, (p) => p === 'roster')).toBeNull();
    expect(readReleasedReadKeys(RELEASE, (p) => p === 'roster' || p === 'policy')).not.toBeNull();
    const many = Object.fromEntries(Array.from({ length: MOST_RELEASED_EPOCHS + 1 }, (_, i) => [String(i), { roster: KEY }]));
    expect(readReleasedReadKeys({ ...RELEASE, byEpoch: many })).toBeNull();
  });

  it('REACH THE PAGE ONLY AT THE END OF A READER\'S ACT THAT ENDED DONE', () => {
    expect(readActEnded(ended('reader-keys'), { nonce: 'n1', intent: 'reader-keys' })?.readKeys).toEqual(RELEASE);
    expect(readActEnded(ended('reader-keys', { readKeys: undefined }), { nonce: 'n1', intent: 'reader-keys' })?.readKeys).toBeUndefined();
    /* RED WHEN: any other act's end may hand a page read keys, so a signer's act becomes a way to release them. */
    expect(readActEnded(ended('grant-read'), { nonce: 'n1', intent: 'grant-read' })).toBeNull();
    /* RED WHEN: a stopped act's end hands a page read keys. */
    expect(readActEnded(ended('reader-keys', { ended: 'stopped', why: 'step-failed', step: 1 }), { nonce: 'n1', intent: 'reader-keys' })).toBeNull();
    /* RED WHEN: a malformed release is dropped and the rest of the end taken, so a page reads an end that carried something else. */
    expect(readActEnded(ended('reader-keys', { readKeys: { ...RELEASE, extra: 1 } }), { nonce: 'n1', intent: 'reader-keys' })).toBeNull();
  });
});
