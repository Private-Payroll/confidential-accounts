/**
 * **WHAT THE GRANT-READ ACT TAKES FROM THE PAGE.** A grant hands over the reader's join code, signed by the reader's own
 * wallet over its key for this company and its person id, and a reader role; a taking-away names the key and `away`.
 * Anything else is refused before the passkey, with words that say what to do.
 */
import { describe, expect, it } from 'vitest';
import type { ActIntent } from 'midnight-identity/profile/request';
import { ACT_INTENTS } from 'midnight-identity/profile/act-intents';
import { readFileSync } from 'node:fs';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { signJoinCode, writeJoinCode, type JoinCode, type ReaderParts } from 'midnight-identity/profile/join-code';
import { readerCodeFingerprint } from 'midnight-identity/profile/fingerprint';
import { grantEntryOf } from '../../../../src/midnight/grants-record.js';
import type { StepContext, Words } from './definition.js';
import type { CompanyReach } from './company-reach.js';

const unreachedAtAll = (): never => { throw new Error('nothing is reached'); };
import { confirmWhatAGiveReplaces, grantAskedOf, grantReadAction } from './grant-read.js';

const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;

const KEY = 'ab'.repeat(32);
const CO = `co_${'c3'.repeat(32)}` as CompanyLabel;
const OTHER = `co_${'c4'.repeat(32)}` as CompanyLabel;
const readersWallet = identityFromSecret(new Uint8Array(32).fill(7));
const ask = (fields: Record<string, string>): ActIntent => ({ name: 'grant-read', fields: { record: 'acc_1', company: CO, ...fields } }) as ActIntent;
const readerCode = (company: CompanyLabel = CO, readerKey = KEY): JoinCode => signJoinCode(readersWallet, company, 'rhea', { kind: 'reader', readerKey });
const CODE = writeJoinCode(readerCode());

describe('THE GRANT-READ ACT', () => {
  it('takes a grant from a reader\'s code at a reader role, or a taking-away, and refuses a signer role, a bad key or an unknown word', () => {
    expect(grantAskedOf(ask({ code: CODE, role: 'limited' }))).toEqual({
      give: { recipient: KEY, person: 'rhea', role: 'limited', purposes: ['roster', 'policy', 'proposals'] },
    });
    expect(grantAskedOf(ask({ recipient: KEY, away: 'yes' }))).toEqual({ takeAway: KEY });
    /* RED WHEN: a read grant may be given at a signer role, which would read as a seat that is none. */
    expect(grantAskedOf(ask({ code: CODE, role: 'admin' }))).toEqual({ key: 'act.grant-read.why.not-a-reader-role' });
    expect(grantAskedOf(ask({ recipient: 'zz', away: 'yes' }))).toEqual({ key: 'act.grant-read.why.not-a-key' });
    expect(grantAskedOf(ask({ recipient: KEY, away: 'maybe' }))).toEqual({ key: 'act.grant-read.why.not-a-choice' });
    expect(grantAskedOf(ask({ code: CODE, recipient: KEY, away: 'yes' }))).toEqual({ key: 'act.grant-read.why.not-a-choice' });
  });

  it('gives read access only to a key a reader\'s own wallet signed for this company', () => {
    const code = readerCode();
    /* RED WHEN: a page names the key to give read access to, which no reader's wallet signed. */
    expect(grantAskedOf(ask({ recipient: KEY, code: CODE, role: 'limited' }))).toEqual({ key: 'act.grant-read.why.key-from-the-code' });
    expect(grantAskedOf(ask({ recipient: KEY, role: 'limited' }))).toEqual({ key: 'act.grant-read.why.key-from-the-code' });
    /* RED WHEN: a code with its key or person swapped after the reader's wallet signed it gives read access. */
    expect(grantAskedOf(ask({ code: writeJoinCode({ ...code, parts: { kind: 'reader', readerKey: 'cd'.repeat(32) } }), role: 'limited' })))
      .toEqual({ key: 'act.grant-read.why.code-not-signed' });
    expect(grantAskedOf(ask({ code: writeJoinCode({ ...code, person: 'mallory' }), role: 'limited' }))).toEqual({ key: 'act.grant-read.why.code-not-signed' });
    /* RED WHEN: a reader's code made for another company gives read access to this one. */
    expect(grantAskedOf(ask({ code: writeJoinCode(readerCode(OTHER)), role: 'limited' }))).toEqual({ key: 'act.grant-read.why.code-another-company' });
    /* RED WHEN: a signer's or payee's code gives read access, taking a seat or payslip key as a reader's. */
    const payee = signJoinCode(readersWallet, CO, 'rhea', { kind: 'payee', address: `mn_shield-addr_test1${'p'.repeat(60)}`, payslipKey: KEY });
    expect(grantAskedOf(ask({ code: writeJoinCode(payee), role: 'limited' }))).toEqual({ key: 'act.grant-read.why.not-a-reader-code' });
    expect(grantAskedOf(ask({ code: 'hello', role: 'limited' }))).toEqual({ key: 'act.grant-read.why.not-a-code' });
    for (const k of ['not-a-code', 'code-not-signed', 'code-another-company', 'not-a-reader-code', 'key-from-the-code']) {
      expect(WORDS[`act.grant-read.why.${k}`], k).toMatch(/nothing was filed/iu);
    }
  });

  it('says before the passkey that the service is given every reader\'s sign-in id, and that an accountant reads what each run pays', async () => {
    const unreached = (): never => { throw new Error('nothing is reached to show the act'); };
    const shown = await grantReadAction({ chain: unreached, builder: unreached }).shown(ask({ code: CODE, role: 'accountant' }));
    const keys = shown.map((l) => l.key);
    /* RED WHEN: the signer giving read access is not shown the reader's fingerprint to compare with the one the reader reads out. */
    expect((shown[0] as { values?: Record<string, string> }).values?.['fingerprint']).toBe(readerCodeFingerprint(readerCode() as JoinCode & { parts: ReaderParts }));
    expect(WORDS['act.grant-read.shown.give.accountant']).toMatch(/\{fingerprint\}.*reads out to you from their wallet/u);
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

  it('says, before anything is signed, when a give replaces a reader already in force and that the company\'s key will change', async () => {
    const rhea = grantEntryOf({ recipient: KEY, person: 'rhea', role: 'limited' });
    const asked: (readonly Words[])[] = [];
    const ctx = { confirm: async (lines: readonly Words[]) => { asked.push(lines); } };
    /* A give that names nobody in force asks nothing more. */
    await confirmWhatAGiveReplaces(ctx, [rhea], grantEntryOf({ recipient: 'cd'.repeat(32), person: 'abe', role: 'accountant' }));
    await confirmWhatAGiveReplaces(ctx, [rhea], rhea);
    expect(asked).toEqual([]);
    /* RED WHEN: a code naming a reader already in force, signed by another wallet, is given with words that say only that it gives. */
    await confirmWhatAGiveReplaces(ctx, [rhea], grantEntryOf({ recipient: 'cd'.repeat(32), person: 'rhea', role: 'limited' }));
    expect(asked).toEqual([[
      { key: 'act.grant-read.confirm.replaces', values: { person: 'rhea', recipient: KEY, role: 'limited' } },
      { key: 'act.grant-read.confirm.key-changes' },
    ]]);
    expect(WORDS['act.grant-read.confirm.replaces']).toMatch(/replaces the read access of \{person\}.*taken away/u);
    expect(WORDS['act.grant-read.confirm.key-changes']).toMatch(/changes the company's key/u);
    /* RED WHEN: the same key given another role or person reads as a plain give. */
    await confirmWhatAGiveReplaces(ctx, [rhea], grantEntryOf({ recipient: KEY, person: 'rhea', role: 'accountant' }));
    expect(asked).toHaveLength(2);
  });

  it('asks for that Confirm in its first step, before the upkeep or the filing hands anything over', async () => {
    const rhea = grantEntryOf({ recipient: KEY, person: 'rhea', role: 'limited' });
    const asked: (readonly Words[])[] = [];
    const steps = grantReadAction({
      chain: unreachedAtAll, builder: unreachedAtAll,
      reachFor: async () => ({ stepTo: () => {} }) as unknown as CompanyReach, inForceFor: async () => [rhea],
    }).steps(ask({ code: writeJoinCode(signJoinCode(identityFromSecret(new Uint8Array(32).fill(8)), CO, 'rhea', { kind: 'reader', readerKey: 'cd'.repeat(32) })), role: 'limited' }));
    await steps[0]!.run({ confirm: async (lines: readonly Words[]) => { asked.push(lines); } } as unknown as StepContext);
    /* RED WHEN: the act signs a give that replaces a reader in force without the person confirming whom it replaces. */
    expect(asked.map((l) => l[0]!.key)).toEqual(['act.grant-read.confirm.replaces']);
  });
});

