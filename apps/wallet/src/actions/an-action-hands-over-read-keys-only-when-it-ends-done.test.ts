/**
 * **AN ACTION HANDS A PAGE READ KEYS ONLY IN THE END ANSWER OF AN ACTION THAT RAN TO ITS END.** A step that has worked
 * out the read keys a reader's grant names hands them over (`releaseReadKeys`); an action that then stops hands over
 * nothing of them, and an end answer that would carry a secret this wallet watches is not sent at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import type { ActEnded, ActingChannel } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import type { ReadKeysReleased } from 'midnight-identity/profile/read-keys-release';
import { forgetWatched, watchFor } from '../keyring/nothing-secret-crosses.js';
import type { ActionDefinition, ActionStep, Held } from './definition.js';
import { runAction } from './run.js';

const secret = newSecret();
const held: Held = { identity: identityFromSecret(secret), secret };
const KEY = 'ab'.repeat(32);
const RELEASE = { accountId: 'acc_1', byEpoch: { 0: { roster: KEY } } };

const request = (name: 'reader-keys' | 'grant-read' = 'reader-keys'): ActRequest => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'A test.', nonce: 'n1', expiresAt: Date.now() + 20 * 60_000, hearsProgress: true,
  intent: { name, fields: { record: 'acc_1', company: `co_${'c3'.repeat(32)}`, account: 'ab'.repeat(32) } },
});
const ran = async (steps: readonly ActionStep[], name: 'reader-keys' | 'grant-read' = 'reader-keys'): Promise<ActEnded> => {
  const ended: ActEnded[] = [];
  const channel: ActingChannel = {
    step: () => true, relay: async () => 'relayed', keep: async () => ({ of: 'kept', version: 1 }),
    call: async () => ({ of: 'answered', status: 200, body: null }), answer: (a) => { ended.push(a as ActEnded); return true; },
    refuse: () => true, progress: () => true, over: () => false, stop: () => {},
  };
  const definition: ActionDefinition = { headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps };
  await runAction({ definition, request: request(name), channel, held, stop: new AbortController().signal });
  return ended.at(-1)!;
};
const releases = (keys: ReadKeysReleased): ActionStep => ({ title: { key: 'a' }, run: async (ctx) => { ctx.releaseReadKeys(keys); } });

beforeEach(() => { forgetWatched(); });

describe('READ KEYS IN AN ACTION\'S END ANSWER', () => {
  it('ARE HANDED OVER WHEN THE ACTION ENDS DONE, AND NOT WHEN IT STOPS AFTER THEM', async () => {
    expect((await ran([releases(RELEASE)])).readKeys).toEqual(RELEASE);
    /* RED WHEN: an action that stopped part way hands a page the read keys an earlier step worked out. */
    const stopped = await ran([releases(RELEASE), { title: { key: 'b' }, run: async () => { throw new Error('the next step fails'); } }]);
    expect(stopped.ended).toBe('stopped');
    expect(stopped.readKeys).toBeUndefined();
  });

  it('LEAVE THE WALLET ONLY FROM A READER\'S ACT AND ONLY IN THEIR ONE SHAPE, NAMING ONLY THE COMPANY\'S PURPOSES', async () => {
    /* RED WHEN: any other act a step of which hands over read keys sends them to the page. */
    const other = await ran([releases(RELEASE)], 'grant-read');
    expect(other.ended).toBe('done');
    expect(other.readKeys).toBeUndefined();
    /* RED WHEN: a release naming a kind of record the company has no purpose for, or not in the closed shape, leaves the wallet. */
    expect((await ran([releases({ accountId: 'acc_1', byEpoch: { 0: { secrets: KEY } } })])).readKeys).toBeUndefined();
    expect((await ran([releases({ ...RELEASE, companyKey: KEY } as ReadKeysReleased)])).readKeys).toBeUndefined();
  });

  it('ARE NEVER SENT WITH A SECRET THIS WALLET WATCHES: THE END SAYS ONLY THAT IT STOPPED', async () => {
    const readerSecret = 'cd'.repeat(32);
    watchFor(readerSecret);
    /* RED WHEN: an end answer carrying a reader's own secret reaches the page. */
    const end = await ran([releases({ accountId: 'acc_1', byEpoch: { 0: { roster: readerSecret } } })]);
    expect(end).toMatchObject({ ended: 'stopped', why: 'step-failed' });
    expect(JSON.stringify(end)).not.toContain(readerSecret);
  });
});
