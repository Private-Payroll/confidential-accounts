/**
 * **THE PACKAGED DOOR STILL DOES THE WHOLE SEQUENCE, IN THE ORDER THAT MAKES
 * THE WINDOW SHORT, AND STILL STOPS AT THE FIRST REFUSAL.**
 *
 * `NEW-VAULT.command` exists for one number: the time between a vault's deploy
 * settling on chain and its note pool being opened. **In that window one
 * `deposit` call by a stranger makes the vault's `notes` set non-empty and
 * `OPEN-VAULT-POOL.command` refuses for ever** — `deposit` is unpermissioned by
 * design, the contract source is public, and the address is readable off the
 * chain. Nobody steals anything; the vault is unusable and somebody deploys
 * another.
 *
 * ── WHY A TEST AND NOT A NOTE IN THE HEADER ──────────────────────────────
 *
 * `command-index.test.ts` and `mint-signers-call.test.ts` are the two arguments
 * and this is the third instance: **a rule that lives only inside a `.command`
 * is a rule no test can reach**, and the four edits that would quietly undo
 * this door are all plausible ones a later round makes for a good reason:
 *
 *   · put `MAKE-TEST-SIGNERS.command` back after the deploy, where
 *     `docs/command-order.md` §1 numbers it — **which lengthens the window by a
 *     whole door and breaks nothing visible**;
 *   · re-implement a stage inline "to avoid the subprocess", which is the one
 *     outcome the brief calls the worst available: a door that quietly does
 *     something different from the one it replaced;
 *   · judge a stage by its exit status alone — every door here is run with
 *     stdin closed, so one that grows a new prompt would read empty and take
 *     its own default with status 0 and nothing written;
 *   · print an estimated window instead of the one the block timestamp gives,
 *     which is rule 9 exactly.
 *
 * **NONE OF THESE FIRES A FAILURE ANYWHERE ELSE.** That is what this file is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const door = readFileSync(join(ROOT, 'NEW-VAULT.command'), 'utf8');
const mint = readFileSync(join(ROOT, 'MAKE-TEST-SIGNERS.command'), 'utf8');

/**
 * **THE DOOR WITH ITS COMMENTS GONE, WHICH IS WHAT EVERY POSITION IS READ OFF.**
 *
 * `S31`'s test-coverage pass moved the signer stage after the deploy — the one edit
 * that lengthens the window — and left one `#` line mentioning
 * `./MAKE-TEST-SIGNERS.command </dev/null` above the sequence. **All twenty
 * tests stayed green**, because `indexOf` over the raw file found the comment
 * first and the ordering assertion was pinned to prose. Comments are stripped
 * here rather than in three of the tests, so no assertion can be satisfied by
 * something a person wrote about the door instead of by the door.
 */
const body = door.replace(/^\s*#.*$/gm, '');

/** Where each door is CALLED. Positions are in `body`, never in `door`. */
const callAt = (name: string): number => {
  const i = body.indexOf(`./${name}.command </dev/null`);
  expect(i, `NEW-VAULT.command no longer calls ${name}.command`).toBeGreaterThan(-1);
  expect(body.indexOf(`./${name}.command </dev/null`, i + 1),
    `${name}.command is called twice`).toBe(-1);
  return i;
};

describe('the packaged door calls the three doors rather than replacing them', () => {
  it('calls all three, by file, with no argument', () => {
    // Rule 8: a double-click carries no argument, so no door here is ever
    // named by an argument form. Each is called as the file a person could
    // double-click themselves.
    for (const n of ['MAKE-TEST-SIGNERS', 'DEPLOY-VAULT', 'OPEN-VAULT-POOL']) callAt(n);
  });

  it('does not deploy, seal or mint anything itself', () => {
    // The subprocess IS the mechanism. A stage reimplemented here is a second
    // copy of a rule about money — `M-104`, and `C276` is what it costs.
    expect(body).not.toMatch(/deploy-vault\.ts/);
    expect(body).not.toMatch(/open-vault-pool\.ts/);
    expect(body).not.toMatch(/_mint-signers/);
    expect(body).not.toMatch(/newWrappingKeypair|sealPool|wrapKey/);
  });

  it('MINTS THE SIGNERS BEFORE IT DEPLOYS, AND OPENS THE POOL AFTER', () => {
    /*
     * THE WHOLE POINT OF THE ORDER. `MAKE-TEST-SIGNERS.command` asks for a NAME
     * and touches no chain — `docs/command-order.md` §1 says so in its own
     * words — so every second of it spent AFTER the deploy is a second of the
     * window. Moving it back to §1's 6-7-8 numbering costs a whole door's
     * runtime of exposure and breaks nothing else.
     */
    expect(callAt('MAKE-TEST-SIGNERS')).toBeLessThan(callAt('DEPLOY-VAULT'));
    expect(callAt('DEPLOY-VAULT')).toBeLessThan(callAt('OPEN-VAULT-POOL'));
  });

  it('asks everything it needs BEFORE the first stage runs', () => {
    // A door that stops to ask halfway through has re-opened the window it
    // exists to close.
    /*
     * NOT the position of three known variable names. `S31`'s test-coverage pass
     * inserted a FOURTH prompt — `open its pool now? [Y/n]` — between the
     * deploy and the pool, and all twenty tests stayed green: a person away
     * from the keyboard holds the window open for as long as they are away,
     * which is the one thing this door exists to prevent. So the CONSTRUCT is
     * banned after the first stage, not three of its spellings.
     */
    const first = callAt('MAKE-TEST-SIGNERS');
    expect(body.slice(0, first)).toMatch(/read -r VAULT_NAME/);
    expect(body.slice(first), 'a prompt after the sequence has started re-opens the window')
      .not.toMatch(/^\s*read -[rn]/m);
    // `finish()`'s own "press any key" is defined long before the first stage.
    expect(body.indexOf('read -n 1 -s')).toBeLessThan(first);
  });
});

describe('a stage is judged by what it produced, not only by what it returned', () => {
  it('checks the signer file, the registry entry and the pool file after their stages', () => {
    /*
     * Every door is run with stdin closed so its "press any key to close"
     * passes instead of stopping the sequence three times. THE COST OF THAT is
     * that a door which later grows a NEW prompt reads empty and takes its own
     * default — exit 0, nothing written. So each stage asserts its own output.
     */
    /*
     * ANCHORED WHOLE LINES, not substrings. `S31`'s test-coverage pass wrapped one
     * of these in `[ "${SKIP_POOL_CHECK:-0}" = "0" ] && false && { … }` — the
     * pinned substring was still there verbatim, the post-deploy refusal was
     * unreachable, and twenty tests passed.
     */
    expect(body).toMatch(/^  if \[ "\$STATUS" -ne 0 \] \|\| \[ ! -f "\$SIGNERS_FILE" \]; then$/m);
    expect(body).toMatch(/^  if \[ "\$STATUS" -ne 0 \] \|\| \[ "\$DEPLOYED_NOW" = "0" \]; then$/m);
    expect(body).toMatch(/^  if \[ "\$STATUS" -ne 0 \] \|\| \[ ! -f "\$POOL_FILE" \]; then$/m);
  });

  it('reads a real exit status, from a call that is not piped into anything', () => {
    /*
     * `$?` after a pipeline is the LAST command's status, so a door piped into
     * `tee` always looks successful — `S31`'s test-coverage pass swapped
     * `${PIPESTATUS[0]}` for `$?` under the old piped form and every
     * `[ "$STATUS" -ne 0 ]` went dead with twenty tests green. These doors are
     * no longer piped at all (`C232`, below), so the status is honest — and
     * that is what is pinned: the call, then the read, with nothing between.
     */
    for (const n of ['MAKE-TEST-SIGNERS', 'DEPLOY-VAULT', 'OPEN-VAULT-POOL']) {
      expect(body).toMatch(new RegExp(`\\./${n}\\.command </dev/null\n  STATUS="\\$\\?"`));
    }
  });

  it('stops at the first refusal instead of running the next stage', () => {
    // Three refusal blocks, each ending the run. A stage that logged and
    // carried on would deploy a vault whose signers were never made.
    /*
     * COUNTED PER REFUSAL BLOCK, not once over the file. `S31`'s
     * test-coverage pass replaced the post-deploy `finish 1` with a COMMENT
     * mentioning it — the count stayed at six and twenty tests passed, while a
     * vault that was on chain with no pool ran on to print a window
     * measurement and exit 0.
     */
    for (const marker of [
      'bad "The signers were not made',
      'bad "The vault was not deployed',
      'bad "The pool was not opened',
    ]) {
      const at = body.indexOf(marker);
      expect(at, `${marker} — the refusal is gone`).toBeGreaterThan(-1);
      const next = body.indexOf('\nstep "', at);
      const block = body.slice(at, next === -1 ? body.length : next);
      expect(block, `${marker} — this refusal no longer stops the run`).toMatch(/^ {4}finish 1$/m);
    }
  });

  it('says what exists on chain already and what does not, on every refusal after the deploy', () => {
    // Rule 19: a refusal a person cannot act on is a dead end. The two states
    // that matter are *the vault is on chain and unfundable* and *nothing new
    // is on chain at all*, and they are not the same problem.
    expect(door).toMatch(/WHAT EXISTS NOW/);
    expect(door).toMatch(/THIS IS THE STATE THE WINDOW IS ABOUT/);
    expect(door).toMatch(/deployed and it is NOT fundable/);
  });

  it('refuses BEFORE minting when the deploy could not succeed, and names the door for each', () => {
    // A mint standing in front of a refusal is a state a person has to reason
    // about: MAKE-TEST-SIGNERS.command will not overwrite its own output.
    const stage0b = body.slice(body.indexOf('0b of 4'), callAt('MAKE-TEST-SIGNERS'));
    expect(stage0b).toMatch(/COMPILE-VAULT\.command/);
    expect(stage0b).toMatch(/DEPLOY-PREVIEW\.command/);
    expect(stage0b).toMatch(/CHOOSE-AUTHORITY\.command/);
    expect(stage0b).toMatch(/Nothing was minted, deployed or written/);
  });

  it('never deploys a second contract under a name the registry already holds', () => {
    // Overwriting a registry entry does not replace a vault, it forgets one,
    // with the money still on chain.
    expect(door).toMatch(/DEPLOYED" = "1" \]/);
    expect(door).toMatch(/already recorded on/i);
  });
});

describe('the window is a measurement and never an estimate', () => {
  it('reads the settling block timestamp the node put on the transaction', () => {
    // Rule 9. The window opens when the transaction is IN A BLOCK, which is
    // earlier than any moment this door can observe by itself, so the only
    // honest start is the block's own timestamp out of the vault registry.
    /*
     * WITH ITS `?? null`. `S31`'s test-coverage pass changed it to
     * `?? Number(deployDone)` and the door printed a window computed from this
     * machine's own clock, under the paragraph saying it came from the node —
     * rule 9 exactly — with twenty tests green, because the words
     * `deployTx?.blockTimestamp` and `THE WINDOW WAS NOT MEASURED` were both
     * still in the file and one of them was unreachable.
     */
    expect(body).toMatch(/const settled=v\?\.deployTx\?\.blockTimestamp \?\? null;/);
    expect(body).toMatch(/if \(settled==null\)/);
    const at = body.indexOf('if (settled==null)');
    expect(body.slice(at, at + 600), 'the not-measured branch no longer ends the measurement')
      .toMatch(/process\.exit\(0\)/);
  });

  it('refuses a number rather than estimating one when the timestamp is absent', () => {
    expect(door).toMatch(/THE WINDOW WAS NOT MEASURED/);
    expect(door).toMatch(/number this door could not take is a refusal rather than an estimate/);
  });

  it('says it is two clocks and an upper bound, rather than presenting one figure', () => {
    expect(door).toMatch(/TWO CLOCKS/);
    expect(door).toMatch(/UPPER bound/);
  });

  it('measures nothing when the run did not do both stages back to back', () => {
    // A resumed run skips the deploy, so there is no interval in it to read.
    expect(door).toMatch(/Not measured: this run did not do both/);
  });

  it('carries no window figure of its own anywhere in the file', () => {
    // The one number this round must not invent. Nothing has ever timed it.
    /*
     * The first version required a digit right after the verb, so `the window
     * was open for 12.4s, which is typical for stagenet` walked straight
     * through — `S31`'s test-coverage pass added exactly that line and nothing
     * failed. Any digit within forty characters of the word now fails, unless
     * it arrived through a `${…}` the door computed.
     */
    const prose = body.replace(/\$\{[^}]*\}/g, '');
    expect(prose).not.toMatch(/window[^.\n]{0,40}\d/i);
  });
});

describe('what the packaged door must never do', () => {
  it('prints no vault address, here or in its report', () => {
    // `C236`. A filename and a report line are both screens.
    expect(body).not.toMatch(/contractAddress/);
    expect(body).not.toMatch(/mn_addr_/);
  });

  it('DOES NOT COPY THE THREE DOORS OUTPUT INTO ITS OWN REPORT', () => {
    /*
     * The wallet SDK logs the seed at info level and
     * `REPORT-DEPLOY-VAULT.txt` already carries it. Teeing each door through
     * this file would make `REPORT-NEW-VAULT.txt` a FIFTH plaintext home for a
     * spendable key, produced by the door the index calls EVERYDAY. Found by
     * `S31`'s money-safety pass.
     */
    for (const n of ['MAKE-TEST-SIGNERS', 'DEPLOY-VAULT', 'OPEN-VAULT-POOL']) {
      const at = callAt(n);
      expect(body.slice(at, at + 200), `${n}.command's output is being copied into REPORT-NEW-VAULT.txt`)
        .not.toMatch(/tee/);
    }
  });

  it('refuses a vault registry it cannot read, rather than reading it as empty', () => {
    /*
     * `C110`, and `MAKE-TEST-SIGNERS.command`'s own `readSecrets` is the
     * doctrine. Scoring an unparseable registry as *no such vault* prints
     * NOTHING IS ON CHAIN over vaults that are — which is the one question this
     * door exists to answer. Found by `S31`'s money-safety pass.
     */
    expect(body).toMatch(/process\.exit\(2\)/);
    expect(body).toMatch(/could not be read/);
    expect(body).toMatch(/never an empty one \(C110\)/);
  });

  it('leaves the three doors runnable on their own', () => {
    // A person recovering from a half-finished sequence needs them, and this
    // door tells them so on both of its post-deploy refusals.
    expect(body).toMatch(/Run OPEN-VAULT-POOL\.command as soon as/);
    expect(body).toMatch(/run this file again with the same name/);
  });

  it('names BACKUP-KEYS.command on success, because the pool is the only record of the money', () => {
    expect(body).toMatch(/RUN BACKUP-KEYS\.command/);
  });

  it('SAYS ON SCREEN THAT deposit IS STILL UNPERMISSIONED AFTER THE POOL EXISTS', () => {
    /*
     * The first draft of this door's header said the window CLOSED at stage 3.
     * `S31`'s own money-safety pass read the contract and the client and
     * showed it does not: `deposit` takes a coin and no signer for ever
     * (`Vault.compact:452-460`), `VaultLedger.reconcile` refuses any vault
     * whose chain holds notes its pool does not (`vault-ledger.ts:1438-1452`),
     * and `affordable` turns that into `VaultCannotAfford` (`:749-754`). **On
     * an empty vault that is a vault thrown away; on a funded one it is money
     * nobody can move**, and `replayVault` cannot adopt a stranger's note. A
     * door that claimed otherwise on its success screen would be rule 29's
     * failure aimed at recoverability instead of privacy.
     */
    expect(body).toMatch(/STILL UNPERMISSIONED/);
    expect(body).toMatch(/money nobody can move/);
    expect(body).not.toMatch(/Nobody steals anything/);
  });
});

describe('the signer count gate did not change what a double-click does', () => {
  it('MAKE-TEST-SIGNERS still asks when nothing set it, and still defaults to 3', () => {
    /*
     * The one edit this round made to a proven door: `COUNT` got the same
     * `[ -z ... ]` gate `VAULT_NAME` already had, so a caller that asked once
     * at its start can pass what it was told. A person double-clicking the file
     * is asked exactly as before — and if that gate ever loses its prompt, the
     * door silently mints 3 for everybody.
     */
    expect(mint).toMatch(/if \[ -z "\$\{COUNT:-\}" \]; then\n\s*printf "  how many test signers\?/);
    expect(mint).toMatch(/COUNT="\$\(echo "\$\{COUNT:-3\}" \| tr -cd '0-9'\)"/);
  });

  it('the packaged door passes the count it asked for, rather than letting the default happen', () => {
    expect(door).toMatch(/export VAULT_NAME COUNT/);
    expect(door).toMatch(/read -r COUNT/);
  });

  it('refuses a pool wrapped to nobody', () => {
    expect(door).toMatch(/wrapped to nobody is ciphertext with no key in the world/);
  });
});
