/**
 * **WHAT THE GRANT-READ ACT TAKES FROM THE PAGE.** A grant names the reader's key, its person id and a reader role; a
 * taking-away names the key and `away`. Anything else is refused before the passkey, with words that say what to do.
 */
import { describe, expect, it } from 'vitest';
import type { ActIntent } from 'midnight-identity/profile/request';
import { ACT_INTENTS } from 'midnight-identity/profile/act-intents';
import { readFileSync } from 'node:fs';
import { grantAskedOf, grantReadAction } from './grant-read.js';

const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;

const KEY = 'ab'.repeat(32);
const ask = (fields: Record<string, string>): ActIntent => ({ name: 'grant-read', fields: { record: 'acc_1', ...fields } }) as ActIntent;

describe('THE GRANT-READ ACT', () => {
  it('takes a grant at a reader role, or a taking-away, and refuses a signer role, a bad key or an unknown word', () => {
    expect(grantAskedOf(ask({ recipient: KEY, person: 'rhea', role: 'limited' }))).toEqual({
      give: { recipient: KEY, person: 'rhea', role: 'limited', purposes: ['roster', 'policy', 'proposals'] },
    });
    expect(grantAskedOf(ask({ recipient: KEY, away: 'yes' }))).toEqual({ takeAway: KEY });
    /* RED WHEN: a read grant may be given at a signer role, which would read as a seat that is none. */
    expect(grantAskedOf(ask({ recipient: KEY, person: 'rhea', role: 'admin' }))).toEqual({ key: 'act.grant-read.why.not-a-reader-role' });
    expect(grantAskedOf(ask({ recipient: 'zz', person: 'rhea', role: 'limited' }))).toEqual({ key: 'act.grant-read.why.not-a-key' });
    expect(grantAskedOf(ask({ recipient: KEY, away: 'maybe' }))).toEqual({ key: 'act.grant-read.why.not-a-choice' });
    expect(grantAskedOf(ask({ recipient: KEY, person: 'has space', role: 'limited' }))).toEqual({ key: 'act.grant-read.why.not-a-person' });
  });

  it('says before the passkey that the service is given every reader\'s sign-in id, and that an accountant reads what each run pays', async () => {
    const unreached = (): never => { throw new Error('nothing is reached to show the act'); };
    const keys = (await grantReadAction({ chain: unreached, builder: unreached }).shown(ask({ recipient: KEY, person: 'abe', role: 'accountant' }))).map((l) => l.key);
    /* RED WHEN: the act is shown without saying the service is handed the readers' sign-in ids in plain text. */
    expect(keys).toContain('act.grant-read.shown.service-told');
    expect(WORDS['act.grant-read.shown.service-told']).toMatch(/sign-in id of every reader .* in plain text/u);
    /* RED WHEN: an accountant's grant promises they never see what is paid, though the runs they open hold every amount. */
    expect(keys[0]).toBe('act.grant-read.shown.give.accountant');
    expect(WORDS['act.grant-read.shown.give.accountant']).toMatch(/the payroll runs and what each run pays each person/u);
    expect(WORDS['act.grant-read.shown.give.accountant']).not.toMatch(/never what a proposal pays/u);
  });

  it('may hand the service the readers and file the grants, and nothing a seat act does not', () => {
    const calls = ACT_INTENTS['grant-read'].calls;
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/accounts/:record/readers')).toBe(true);
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/accounts/:record/records/:kind/:id/:version')).toBe(true);
    /* RED WHEN: a seat act's upkeep cannot read the grants, so its change of the company's key never knows a grant was taken away. */
    for (const name of ['approve-proposal', 'remove-signer', 'raise-run'] as const) {
      expect(ACT_INTENTS[name].calls.some((c) => c.method === 'GET' && c.path === '/api/accounts/:record/records/:kind/:id/versions'), name).toBe(true);
    }
  });
});
