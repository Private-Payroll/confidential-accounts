/**
 * **THE REFUSALS OF THE DOOR THAT PUTS THE FIRST PRIVATE MONEY INTO A VAULT,
 * DRIVEN WITHOUT A CHAIN.**
 *
 * Three of them carry money directly and none of them can be checked
 * afterwards:
 *
 *   · **the circuit set.** A deployment the compiled reader does not match
 *     decodes field by field and hands back a well-formed EMPTY note set
 *     (`C268`). The deposit would land, the pool would record it, and every
 *     later check would agree that nothing happened.
 *   · **the signer set.** A deposit re-seals the whole pool and wraps it to
 *     whatever list it is handed. A shorter list is a signer who can never read
 *     the record of that vault's money again, with nothing on chain to say so.
 *   · **the unit.** Digits only, and no scale is invented for a token that
 *     declares none.
 *
 * **AND THE IMPORT ITSELF IS PART OF THE TEST.** This file imports the script,
 * which imports `fund-vault.ts` and `mint-test-token.ts`. All three carry a
 * `RUN_DIRECTLY` guard; if any were removed, importing here would go to the
 * network and spend money.
 */
import { describe, it, expect } from 'vitest';

import { readFileSync } from 'node:fs';
import type { ShieldedWaitOutcome } from './shielded-wallet.js';
import {
  amountFromText, assertVaultTakesPrivateMoney, assertNoSignerIsDropped, depositVerdict,
  depositJournalFile, noColourRefusal, chooseOpener, openerVerdicts,
} from './deposit-to-vault.js';
import { VAULT_CIRCUITS } from '../src/midnight/vault-contract.js';
import type { VaultEntry } from '../src/midnight/vault-record.js';

const entryWith = (circuits: string[]): VaultEntry => ({
  name: 'payroll-test',
  contractAddress: 'ab'.repeat(32),
  accountAddress: 'cd'.repeat(32),
  deployedAt: '2026-08-29T00:00:00.000Z',
  circuits,
  maintenanceAuthority: { kind: 'single-key', committeeSize: 1, threshold: 1 },
  adopted: false,
  deployTx: null,
} as unknown as VaultEntry);

describe('the amount, and the unit it is in', () => {
  it('takes a whole number of the smallest unit', () => {
    expect(amountFromText('250')).toBe(250n);
  });

  it('refuses a decimal point rather than interpreting it', () => {
    expect(() => amountFromText('2.5')).toThrow(/digits and nothing else/i);
  });

  it('refuses an empty answer rather than defaulting', () => {
    expect(() => amountFromText('')).toThrow(/deliberately no default/);
  });

  it('refuses a note of nothing', () => {
    expect(() => amountFromText('0')).toThrow(/not a deposit/);
  });
});

describe('which vaults can take private money', () => {
  it('takes a vault carrying every circuit', () => {
    expect(() => assertVaultTakesPrivateMoney(entryWith([...VAULT_CIRCUITS]))).not.toThrow();
  });

  it('refuses the four-circuit deployment BY NAMING WHAT WOULD GO WRONG, not the deposit', () => {
    /*
     * `payroll-test-1`'s shape. The refusal has to be about the READ rather
     * than about the call, because the call would work: `deposit` is one of the
     * four. What breaks is that the note set comes back empty from a reader
     * that does not match, so nothing afterwards could tell a landed deposit
     * from a lost one.
     */
    const four = entryWith(['deposit', 'payout', 'retire', 'splitNote']);
    expect(() => assertVaultTakesPrivateMoney(four)).toThrow(/C268/);
    expect(() => assertVaultTakesPrivateMoney(four)).toThrow(/well-formed and EMPTY/);
    expect(() => assertVaultTakesPrivateMoney(four)).toThrow(/depositUnshielded/);
  });

  it('refuses a record carrying no circuits at all', () => {
    expect(() => assertVaultTakesPrivateMoney(entryWith([]))).toThrow(/missing 7 of the vault/);
  });

  it('does NOT claim the checks afterwards would agree, because they would refuse', () => {
    /*
     * **A REGRESSION PIN ON A REASON RATHER THAN ON BEHAVIOUR, and it is here
     * because the first version of this guard was defended by a false one.** It
     * said the deposit would land and every later check would agree that
     * nothing happened. `VaultLedger.balance` recomputes each pool note's
     * commitment and asks the chain's set for it, so against `C268`'s empty set
     * the reconciliation REFUSES. **A guard defended by a reason that does not
     * survive testing is a guard the next person deletes.**
     */
    const four = entryWith(['deposit', 'payout', 'retire', 'splitNote']);
    expect(() => assertVaultTakesPrivateMoney(four)).toThrow(/the reconciliation afterwards would/);
    expect(() => assertVaultTakesPrivateMoney(four)).not.toThrow(/would agree that nothing happened/);
    expect(() => assertVaultTakesPrivateMoney(four)).toThrow(/what drifts is the state layout/i);
  });
});

describe('the attempt journal', () => {
  it('is named after the vault and never addressed by it', () => {
    /*
     * `C236`: a filename is a screen. And it is a SEPARATE file from the pool —
     * one records what was attempted, the other claims what the vault holds,
     * and merging them is the direction `C199` rejected.
     */
    expect(depositJournalFile('/x/.midnight', 'stagenet', 'payroll-test-2'))
      .toBe('/x/.midnight/stagenet-vault-deposit-journal-payroll-test-2.json');
  });

  it('refuses a vault name that could escape the directory', () => {
    expect(() => depositJournalFile('/x/.midnight', 'stagenet', '../../etc')).toThrow();
  });
});

describe('nobody loses their copy of the pool key because a deposit was made', () => {
  it('allows a re-seal to exactly the signers already wrapped', () => {
    expect(() => assertNoSignerIsDropped(['a', 'b', 'c'], ['a', 'b', 'c'])).not.toThrow();
  });

  it('allows a re-seal that ADDS a signer', () => {
    /*
     * Adding is not this guard's business: a pool readable by more of the
     * people who might have to pay from it is the direction
     * `OPEN-VAULT-POOL.command` already argues for. Only losing readers is the
     * silent failure.
     */
    expect(() => assertNoSignerIsDropped(['a', 'b'], ['a', 'b', 'c'])).not.toThrow();
  });

  it('refuses a re-seal that would drop a signer, and names who', () => {
    expect(() => assertNoSignerIsDropped(['a', 'b', 'c'], ['a']))
      .toThrow(/would lose their copy of the key: b, c/);
  });

  it('says the loss is silent, because that is why the guard is before the money', () => {
    expect(() => assertNoSignerIsDropped(['a', 'b'], ['a']))
      .toThrow(/nothing on chain would say so/i);
  });
});

describe('what the two reconciliations say', () => {
  it('confirms when the vault moved by exactly what was deposited', () => {
    expect(depositVerdict(0n, 500n, 500n)).toBe('confirmed-by-the-chain');
  });

  it('does not confirm when it moved by something else', () => {
    expect(depositVerdict(0n, 0n, 500n)).toBe('not-confirmed');
    expect(depositVerdict(0n, 700n, 500n)).toBe('not-confirmed');
  });

  it('does not confirm when there was no reading before', () => {
    /*
     * A single reading cannot tell *the deposit landed* from *this vault
     * already held that much*. `V-172` is the same shape on the public path,
     * and the answer is the same: no baseline, no claim.
     */
    expect(depositVerdict(null, 500n, 500n)).toBe('not-confirmed');
  });
});

describe('THE DOOR THAT COULD NOT REACH ITS OWN CALL', () => {
  /*
   * **THIS DOOR REFUSED TWICE ON 30 AUGUST AGAINST A WALLET THAT HELD THE
   * COIN.** `the wallet holds 0 of that colour`, printed one second after the
   * wallet was built, four stages before the call. The read was taken before
   * the shielded scan had done anything, and nothing anywhere waited for it.
   *
   * The refusal itself was RIGHT — nothing was proved and nothing was spent —
   * and it was right by accident. **The same words for the opposite situation
   * send a person away to wait for a coin that will never arrive**, and no
   * assertion on a thrown/not-thrown catches that. So these pin the WORDS.
   */
  /**
   * A MADE-UP COLOUR, for the reason `shielded-wallet.test.ts` states at its
   * own `COLOUR`, and the same value: this was the stagenet test token's, every
   * use here passes it straight to `noColourRefusal`, which only slices it into
   * a message, and no assertion on this page reads it back. **Deliberately not
   * a repeating pattern** — that file says what a uniform one unpins.
   */
  const COLOUR = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const outcome = (over: Partial<ShieldedWaitOutcome>): ShieldedWaitOutcome => ({
    reached: 'deadline', caughtUp: false, known: true, awaitedOwnCoin: false,
    waitedMs: 720_000, describe: 'shielded 400 of 1,000 — 600 events behind', ...over,
  });
  const notCaughtUp = outcome({});
  const caughtUp = outcome({
    reached: 'caught-up', caughtUp: true, waitedMs: 31_000,
    describe: 'shielded 1,000 of 1,000 — 0 events behind',
  });

  it('says THE SCAN HAS NOT CAUGHT UP when that is what it is holding', () => {
    const m = noColourRefusal(COLOUR, notCaughtUp, 0n);
    expect(m).toMatch(/nothing for this deposit's output to be funded from/);
    expect(m).toMatch(/THE SCAN HAS NOT CAUGHT UP/);
    expect(m).toMatch(/run this door again/i);
  });

  it('says THERE IS NO SUCH COIN when the scan HAS caught up, and does not say wait', () => {
    const m = noColourRefusal(COLOUR, caughtUp, 0n);
    expect(m).toMatch(/THERE IS NO SUCH COIN/);
    expect(m).toMatch(/waiting will not change this answer/i);
    expect(m).not.toMatch(/run this door again/i);
  });

  it('DOES NOT CALL AN UNREADABLE WALLET AN EMPTY ONE', () => {
    /*
     * `shieldedHeldOf` answers `null` when it could not read the coin list at
     * all. The first draft of the shared read returned `0n` for that, and `0n`
     * on a caught-up scan is the sentence *"it was already spent"* — a fault in
     * this machine reported to a person as their money being gone. Found by
     * `S17`'s `money-safety-auditor`.
     */
    const m = noColourRefusal(COLOUR, caughtUp, null);
    expect(m).toMatch(/cannot tell whether the wallet holds a coin of that colour/);
    expect(m).toMatch(/NOT A BALANCE OF NOTHING/i);
    expect(m).not.toMatch(/THERE IS NO SUCH COIN/);
    expect(m).not.toMatch(/already spent/i);
  });

  it('treats a run that never waited as its own state, and not as either of the others', () => {
    const m = noColourRefusal(COLOUR, null, 0n);
    expect(m).toMatch(/NEVER WAITED FOR/);
    expect(m).toMatch(/defect in the door/i);
    expect(m).not.toMatch(/THERE IS NO SUCH COIN/);
    expect(m).not.toMatch(/THE SCAN HAS NOT CAUGHT UP/);
  });

  it('HAS NO SECOND COPY OF THE COIN READ OR THE WAIT, AND REFUSES A PASSED DEADLINE', () => {
    /*
     * `M-104`: one procedure, written twice, second copy missing the part that
     * mattered. This door's copy read `availableCoins` once and never waited;
     * the mint door's read it again and polled for five minutes. Both are gone.
     *
     * The deadline check is here because a passed deadline used to be a NOTE:
     * a partial scan showing enough of the colour would have gone on to prove
     * and submit from a view this door had just called incomplete — `C243`'s
     * sentence one sub-wallet along. Found by `S17`'s `money-safety-auditor`.
     */
    const src = readFileSync(new URL('./deposit-to-vault.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/state\(\)\??\.?\s*\??\.?shielded\?\.availableCoins/);
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/availableCoins/);
    /*
     * NOT /shieldedHeldOf/. That word is on the import line too, so the
     * expectation was met by an unrelated line and a second inline read of
     * wallet state SURVIVED when `S31`'s `test-auditor` ran it — `M-104`
     * reached by the exact road `T-70` names. Pinned on the CALL.
     */
    expect(src).toMatch(/shieldedHeldOf\(live\.state\(\), colour\)/);
    expect(src).toMatch(/withShielded: true/);
    expect(src).toMatch(/scan\.reached === 'deadline'/);
  });
});

/*
 * **THE WRONG KEY IS CAUGHT INSTEAD OF MISREPORTED.** `C320`.
 *
 * `C275` overwrote one vault's secrets with another's, twice, under identical
 * ids, and the refusal a person would have met said *THAT IS THE MECHANISM
 * WORKING* — a true sentence about the design and a false one about that case.
 * **These tests exist to make that sentence unreachable for a key that is
 * present and wrong**, and `S30` proved a test of exactly this shape could be
 * deleted with the suite still green, so the last one pins the CALLER too.
 */
const K = (n: string) => n.repeat(64).slice(0, 64);
const RIGHT = K('1e');
const WRONG = K('b8');
const SECRET = K('7c');
/*
 * **A KEY THAT AGREES FOR 48 CHARACTERS AND DIFFERS AFTER IT.** `RIGHT` and
 * `WRONG` differ in every position, so a comparison of the FIRST CHARACTER
 * passes every test that uses only those two — measured by `S31`'s
 * `test-auditor`, which ran `held[0] !== pub[0]` and got 31 green. The two keys
 * in `C275` were sibling outputs of one generator, and `half()` truncating for
 * display sits four lines from the comparison.
 */
const NEAR = RIGHT.slice(0, 48) + 'ff'.repeat(8);

const secretsOf = (rows: [string, string, string][]) => Object.fromEntries(
  rows.map(([id, pub, sec]) => [id, { wrappingPublicKey: pub, wrappingSecret: sec }]));

describe('the opener is chosen by the key it holds, not by the id it is filed under', () => {
  it('opens as a signer whose public half is the one the signers file publishes', () => {
    const chosen = chooseOpener(
      ['v-signer-1'],
      [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }],
      secretsOf([['v-signer-1', RIGHT, SECRET]]));
    expect(chosen).toEqual({ id: 'v-signer-1', wrappingSecret: SECRET });
  });

  it('skips a signer this machine was never given, and opens as one it was', () => {
    const chosen = chooseOpener(
      ['v-signer-1', 'v-signer-2'],
      [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }, { id: 'v-signer-2', wrappingPublicKey: RIGHT }],
      secretsOf([['v-signer-2', RIGHT, SECRET]]));
    expect(chosen.id).toBe('v-signer-2');
  });

  it('REFUSES a secret whose public half is not the one the pool was sealed to', () => {
    expect(() => chooseOpener(
      ['v-signer-1'],
      [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }],
      secretsOf([['v-signer-1', WRONG, SECRET]])))
      .toThrow(/NOT THE ONE THIS POOL WAS SEALED TO/);
  });

  it('REFUSES A KEY THAT AGREES FOR 48 CHARACTERS AND DIFFERS AFTER IT', () => {
    // The whole key, or the check is a prefix check nobody wrote down.
    expect(() => chooseOpener(
      ['v-signer-1'],
      [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }],
      secretsOf([['v-signer-1', NEAR, SECRET]])))
      .toThrow(/NOT THE ONE THIS POOL WAS SEALED TO/);
  });

  it('reads UPPERCASE hex as the same key rather than as an absent one', () => {
    /*
     * Every other fixture here is lowercase, so removing the three
     * `.toLowerCase()` calls in `openerVerdicts` left 31 tests green — `S31`'s
     * `test-auditor` ran it. What it costs on a real file: a present, correct
     * secret scored `never-given`, and the door printing *THAT IS THE MECHANISM
     * WORKING* about a key that is right there. Which is `C320` exactly.
     */
    const chosen = chooseOpener(
      ['v-signer-1'],
      [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }],
      secretsOf([['v-signer-1', RIGHT.toUpperCase(), SECRET.toUpperCase()]]));
    expect(chosen).toEqual({ id: 'v-signer-1', wrappingSecret: SECRET });
  });

  it('names WHICH id and BOTH key prefixes, and never the whole key', () => {
    let msg = '';
    try {
      chooseOpener(['v-signer-1'], [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }],
        secretsOf([['v-signer-1', WRONG, SECRET]]));
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/v-signer-1/);
    expect(msg).toContain(RIGHT.slice(0, 16));
    expect(msg).toContain(WRONG.slice(0, 16));
    expect(msg).not.toContain(RIGHT);
    expect(msg).not.toContain(WRONG);
    expect(msg).not.toContain(SECRET);
  });

  it('KEEPS THE TWO REFUSALS APART — the absent one never claims the mechanism is working about a wrong key', () => {
    /*
     * The whole point of the row. Two sentences, because they send a person to
     * two different places: one to whoever holds that signer's device, the
     * other to a backup of key material that has been replaced.
     */
    const absent = (() => { try {
      chooseOpener(['v-signer-1'], [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }], {});
      return ''; } catch (e) { return (e as Error).message; } })();
    const wrong = (() => { try {
      chooseOpener(['v-signer-1'], [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }],
        secretsOf([['v-signer-1', WRONG, SECRET]]));
      return ''; } catch (e) { return (e as Error).message; } })();

    expect(absent).toMatch(/THAT IS THE MECHANISM WORKING/);
    expect(absent).toMatch(/holds no secret for any signer/);
    expect(wrong).not.toMatch(/THAT IS THE MECHANISM WORKING/);
    expect(wrong).toMatch(/there is one here under that id, and it is a different key/i);
  });

  it('REFUSES ON A MISMATCH EVEN WHEN ANOTHER ID WOULD HAVE OPENED IT', () => {
    /*
     * A deposit re-seals the whole pool to the signers file. Carrying on with a
     * working opener would re-seal a company's money to a set this machine's
     * own key material contradicts. Rule 28: downtime beats a pool nobody can
     * open (`C284`).
     */
    expect(() => chooseOpener(
      ['v-signer-1', 'v-signer-2'],
      [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }, { id: 'v-signer-2', wrappingPublicKey: RIGHT }],
      secretsOf([['v-signer-1', RIGHT, SECRET], ['v-signer-2', WRONG, SECRET]])))
      .toThrow(/NOT THE ONE THIS POOL WAS SEALED TO/);
  });

  it('refuses a secret nothing can check rather than using it', () => {
    const noPublished = (() => { try {
      chooseOpener(['v-signer-1'], [], secretsOf([['v-signer-1', RIGHT, SECRET]]));
      return ''; } catch (e) { return (e as Error).message; } })();
    expect(noPublished).toMatch(/NOTHING CAN CHECK IT/);
    expect(noPublished).toMatch(/does not publish a key for this id/);

    const noHeldHalf = (() => { try {
      chooseOpener(['v-signer-1'], [{ id: 'v-signer-1', wrappingPublicKey: RIGHT }],
        { 'v-signer-1': { wrappingSecret: SECRET } });
      return ''; } catch (e) { return (e as Error).message; } })();
    expect(noHeldHalf).toMatch(/NOTHING CAN CHECK IT/);
    expect(noHeldHalf).toMatch(/records no public half/);
  });

  it('reads a case an instrument measured on this machine on 31 Aug: same ids, different keys', () => {
    /*
     * `payroll-test-1`'s pool and `payroll-test-2`'s secrets, in shape: three
     * ids identical, three public halves different. Today's code picked the
     * first id and handed a wrong secret to `openPool`; this refuses by name.
     */
    const ids = ['test-signer-1', 'test-signer-2', 'test-signer-3'];
    const v = openerVerdicts(
      ids,
      ids.map((id) => ({ id, wrappingPublicKey: RIGHT })),
      secretsOf(ids.map((id) => [id, WRONG, SECRET]) as [string, string, string][]));
    expect(v.map((r) => r.verdict)).toEqual(['mismatch', 'mismatch', 'mismatch']);
  });

  it('IS THE RULE THE CALLER ACTUALLY USES, AND NOT A SECOND COPY BESIDE IT', () => {
    /*
     * `S30` deleted a test of exactly this shape with the suite green, and
     * `S31`'s `test-auditor` then broke the first version of THIS test two
     * ways, running both:
     *
     *   · the pinned call left as a `//` comment and the old by-id `.find`
     *     put back beside it — 31 green, because the assertion ran against the
     *     raw source and nothing strips line comments;
     *   · the pinned call left verbatim and `opener` / `openerSecret`
     *     reassigned from a second `.find` underneath it — 31 green, because
     *     only the DEFINING call was pinned and never the CONSUMING lines.
     *
     * So: comments stripped, both consuming lines pinned, and no reading of a
     * `wrappingSecret` anywhere in the body outside the two exported functions.
     */
    const src = readFileSync(new URL('./deposit-to-vault.ts', import.meta.url), 'utf8');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(body).toMatch(/const chosen = chooseOpener\(sealed\.wrapped\.map\(\(w\) => w\.signerId\), signers, secrets\);/);
    expect(body).toMatch(/const opener = chosen\.id;/);
    expect(body).toMatch(/const openerSecret = chosen\.wrappingSecret;/);

    // Exactly one call site, so a second selection path cannot sit beside it.
    const calls = body.match(/chooseOpener\(/g) ?? [];
    expect(calls, 'chooseOpener is called somewhere other than the one money path')
      .toHaveLength(2); // its own declaration, and the one call

    /*
     * **AND NOTHING BETWEEN READING THE SECRETS FILE AND HANDING THE POOL ITS
     * IDENTITY MAY PICK A SIGNER OR TOUCH A SECRET.** That span is where a
     * second selection path would go and where `S31`'s `test-auditor` put one.
     * `chooseOpener`'s own `verdicts.find` is inside the function and outside
     * this window, which is why the window and not the file is what is banned.
     */
    const from = body.indexOf("const secrets = JSON.parse(readFileSync(SIGNER_SECRETS");
    const to = body.indexOf('const pool = new SealedNotePool');
    expect(from, 'the secrets file is no longer read where it was').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const window = body.slice(from, to);
    expect(window).not.toMatch(/\.find\(/);
    expect(window).not.toMatch(/wrappingSecret\s*(\?\?|\]|\)|,)/);
    expect(window.match(/wrappingSecret/g) ?? []).toHaveLength(1); // chosen.wrappingSecret
  });
});
