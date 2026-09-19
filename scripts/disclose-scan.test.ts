/**
 * THE FOUR TRAPS, EACH AS A TEST, BECAUSE EACH WAS MEASURED RATHER THAN
 * IMAGINED AND EACH PRODUCES A WRONG COLUMN RATHER THAN AN EMPTY ONE.
 *
 * A DISCLOSES column that is short by a site says a circuit reveals less than it
 * does, about a system that holds money. So the fixtures below are the exact
 * shapes `ConfidentialAccount.compact` and `Vault.compact` contain, and the
 * last group asserts the real counts against the real files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { blankNonCode, scanSource, scanSourceFile } from './disclose-scan.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const own = (cs: ReturnType<typeof scanSource>, name: string) => cs.find((c) => c.name === name)?.discloses.filter((d) => d.via.length === 0) ?? [];

describe('TRAP 1 and 2 — comments are stripped BEFORE anything else', () => {
  it('does not count a disclose that is written in prose', () => {
    const src = [
      '/* `disclose(intoVacatedSlot)` is required and is not noise. */',
      'export circuit c(x: Bytes<32>): [] {',
      '  ledgerField = disclose(x);',
      '}',
    ].join('\n');
    expect(own(scanSource(src), 'c')).toHaveLength(1);
  });

  it('does not count a FABRICATED CODE EXAMPLE inside a comment', () => {
    // ConfidentialAccount.compact:1290 writes
    //   stateCommitment = disclose(stateCommitmentOf(nextBalance(), ...));
    // and `stateCommitmentOf` does not exist anywhere in the file. A regex over
    // raw text emits a disclosure of a value that is not in the contract.
    const src = [
      '/**',
      ' *     stateCommitment = disclose(stateCommitmentOf(nextBalance(), x));',
      ' */',
      'export circuit c(): [] { }',
    ].join('\n');
    expect(own(scanSource(src), 'c')).toEqual([]);
  });

  it('blanks comments WITHOUT moving any line number', () => {
    // Every line number in the output is quoted as a `file:line` citation, so
    // a scanner that shifted them by one would be manufacturing citations that
    // point at the wrong line. Nothing downstream re-checks them.
    const src = 'a\n/* two\n   three */\nfour\n';
    const blanked = blankNonCode(src);
    expect(blanked.split('\n')).toHaveLength(src.split('\n').length);
    expect(blanked.split('\n')[3]).toBe('four');
  });
});

describe('TRAP 3 — `constructor` is not the keyword `circuit`', () => {
  it('attributes a constructor disclosure rather than dropping it', () => {
    // TWO real sites live in constructors: `:1590` in the account and `:263` in
    // the vault. It was four until `S35d` deleted the constructor's threshold
    // argument (`C340` + `C343`) and with it both of that argument's
    // disclosures — its assert and its assignment.
    const src = 'constructor(a: Bytes<32>) {\n  account = disclose(a);\n}\n';
    expect(own(scanSource(src), 'constructor')).toHaveLength(1);
  });
});

describe('TRAP 4 — a `contract X { … }` interface block declares BODILESS circuits', () => {
  it('does not invent a circuit from an interface member', () => {
    // Vault.compact:88-126. Both member names collide with REAL exported
    // circuits on the account, so a name-keyed index would merge them.
    const src = [
      'contract Acct {',
      '  circuit recordPayment(p: Bytes<32>): Bytes<32>;',
      '  circuit retireVault(p: Bytes<32>): [];',
      '}',
      'export circuit payout(x: Bytes<32>): [] {',
      '  account.recordPayment(disclose(x));',
      '}',
    ].join('\n');
    const cs = scanSource(src);
    expect(cs.map((c) => c.name)).toEqual(['payout']);
    expect(own(cs, 'payout')).toHaveLength(1);
  });

  it('and the bodies AFTER the interface block are still anchored correctly', () => {
    // A brace matcher that treated a bodiless declaration as an opener would
    // mis-anchor every range that follows it.
    const src = [
      'contract Acct {',
      '  circuit recordPayment(p: Bytes<32>): Bytes<32>;',
      '}',
      'export circuit one(): [] { x = disclose(1); }',
      'export circuit two(): [] { y = disclose(2); z = disclose(3); }',
    ].join('\n');
    const cs = scanSource(src);
    expect(own(cs, 'one')).toHaveLength(1);
    expect(own(cs, 'two')).toHaveLength(2);
  });
});

describe('struct literals put braces inside expressions', () => {
  it('counts depth by character, not by line', () => {
    const src = [
      'export circuit c(r: Bytes<32>): [] {',
      '  send(left<A, B>(ZswapCoinPublicKey { bytes: disclose(r) }));',
      '}',
      'export circuit after(): [] { q = disclose(9); }',
    ].join('\n');
    const cs = scanSource(src);
    expect(own(cs, 'c')).toHaveLength(1);
    expect(own(cs, 'after')).toHaveLength(1);
  });

  it('counts FOUR sites on one line, which `grep -c` cannot', () => {
    const src = 'export circuit c(): [] {\n  h(runPayload(disclose(a), disclose(b), disclose(c), disclose(d)));\n}\n';
    expect(own(scanSource(src), 'c')).toHaveLength(4);
  });
});

describe('THE CLOSURE — a helper’s disclosures belong to its callers too', () => {
  it('inherits from a helper, and marks the route', () => {
    const src = [
      'circuit requireSigner(): Bytes<32> {',
      '  assert(signers.checkRoot(disclose(root)), "not a signer");',
      '}',
      'export circuit approve(p: Bytes<32>): [] {',
      '  requireSigner();',
      '  approvals.insert(disclose(p));',
      '}',
    ].join('\n');
    const cs = scanSource(src);
    const approve = cs.find((c) => c.name === 'approve');
    expect(approve?.discloses).toHaveLength(2);
    expect(approve?.discloses.filter((d) => d.via.length > 0).map((d) => d.via)).toEqual([['requireSigner']]);
  });

  it('a circuit that does NOT call the helper inherits nothing', () => {
    const src = [
      'circuit requireSigner(): Bytes<32> { assert(x(disclose(root)), "m"); }',
      'export circuit recordPayment(p: Bytes<32>): [] { movements.insert(disclose(p)); }',
    ].join('\n');
    expect(scanSource(src).find((c) => c.name === 'recordPayment')?.discloses).toHaveLength(1);
  });
});

describe('the real sources', () => {
  it('counts SITES rather than lines, and the counts are the measured ones', () => {
    // `grep -c disclose` reports 80 and 52 LINES. There are 68 and 48 SITES:
    // comments overcount and multi-site lines undercount. (The account read 76
    // before `S35c`, 75 after it, and 80 after `S48` — whose sixty-five-line
    // comment at `ConfidentialAccount.compact:2129-2191` is five more lines of
    // PROSE saying `disclose`. The SITE count moved by ONE over that same edit.
    // A line count would have reported five times the change; that is the whole
    // reason this counts sites.)
    
    // THE ACCOUNT'S SITE COUNT MOVED ON 2 Sep, AND `S35d` IS WHY: 68 -> 67.
    // MINUS TWO for the constructor's deleted threshold argument — its floor
    // assert and its assignment to the ledger field, `C340` + `C343`. PLUS ONE
    // for `C363`'s `assert(disclose(vault) == noVault(), …)` in `propose`'s
    // governance branch. Read off `scanSourceFile` rather than derived from
    // those three, because rule 9 wants the instrument's number and not the
    // arithmetic. The vault's 48 is unchanged: `S35d` added only comments there.
    
    // AND IT MOVED AGAIN ON 3 Sep, `S48`: 67 -> 68. ONE site,
    // `ConfidentialAccount.compact:2192`, in `propose`'s RUN branch —
    //     assert(disclose(vault) != noVault(), "a run must name the vault that will pay it");
    // — `C363`'s mirror: `:2319` says a governance proposal names NO vault,
    // this says a run names ONE. Raised here by `S49`, 4 Sep, board `2y7d5c`,
    // `C388`. The vault's 48 is again unchanged; `S48` did not touch that file.
    
    // ======================================================================
    // WHY THAT SITE PUBLISHES NOTHING NEW. THE PIN EXISTS BECAUSE A `disclose()`
    // SITE IS PRIVACY-RELEVANT, SO RAISING THE NUMBER WITHOUT THIS PARAGRAPH IS
    // THE ONE WAY TO DO IT WRONG. Four things, in the order they were checked,
    // every line opened at source:
    
    //   1. MEASURED IN THE COMPILED ARTIFACT, NOT ARGUED FROM THE SOURCE.
    //      `contracts/managed/contract/index.js:2201-2202` compiles the assert to
    //      `assert(!this._equal_10(vault_0, this._noVault_0()), …)`. NEITHER
    //      `_equal_10` (`:2854-2857`) NOR `_noVault_0` (`:1471-1473`) TAKES
    //      `context` OR `partialProofData`. Every operation that reaches the
    //      PUBLIC TRANSCRIPT goes through `queryLedgerState(context,
    //      partialProofData, …)` — the very NEXT assert does, because
    //      `openProposals.member(id)` is a ledger READ and compiles to a
    //      `push`/`member`/`popeq` triple (`index.js:2219-2235`). This site
    //      compiles to neither. It contributes ZERO ops to the transcript.
    //   2. THE LEDGER WRITES ARE UNCHANGED. The run branch writes
    //      `openProposals.insert(id, change)` (`compact:2203`),
    //      `approvalCounts.insert(id, 0)` (`:2204`) and
    //      `runWindow.insert(id, Window { opensAt, closesAt })` (`:2221`).
    //      `vault` reaches the chain only inside `id`, a `persistentCommit` over
    //      `[domain, payloadHash, vault]` blinded by the WITNESS `proposalSalt()`
    //      (`:874-881`, `:670`). The assert changes WHETHER those three writes
    //      happen. It changes nothing about what they contain.
    //   3. THE ONE BIT IT ADDS IS TRUE OF EVERY TRANSACTION THAT CAN EXIST.
    //      An observer of a landed run proposal can now infer `vault != noVault()`.
    //      That predicate holds of every run-branch transaction there is, so it
    //      partitions nothing and carries no bits about WHICH one is being looked
    //      at. It names no value either: `noVault()` is a compile-time constant,
    //      a hash of a padded literal with no witness and no ledger read
    //      (`compact:1014-1016`; `index.js:1471-1473` is the same constant with
    //      the string already resolved to bytes). AND THE CHANGE SHRINKS THE
    //      OBSERVABLE SURFACE RATHER THAN WIDENING IT: before `S48` a run raised
    //      at the sentinel LANDED and took a `runWindow` row that opened and
    //      closed with no settlement against any vault, which is a
    //      LOUDER signal than that run simply not existing.
    //   4. THE STRICTLY STRONGER SHAPE IS ALREADY INSIDE THIS NUMBER. `:2319` is
    //      `assert(disclose(vault) == noVault(), …)` — it PINS the value exactly
    //      where `:2192` only excludes one — and it is the `PLUS ONE` in the
    //      paragraph above, accepted by this pin on 2 Sep.
    
    // THE STANDING FACT, AND IT MUST NOT BE COPIED OUT OF HERE WITHOUT ITS
    // SECOND CLAUSE, BECAUSE THE FIRST ALONE LICENSES THE NEXT MISTAKE.
    // `disclose()` HAS NO RUNTIME EFFECT — the compiler erases it, and both
    // compiled artifacts contain ZERO occurrences of it against these 68 and 48
    // sites (`scripts/disclose-scan.ts:5-9`, measured again 4 Sep) — SO WHAT IS
    // PUBLIC IS MEASURED OVER LEDGER WRITES *AND OVER WHAT A TRANSACTION CANNOT
    // HIDE*, NEVER OVER `disclose()` CALLS. Reading it the other way is what
    // `C356` cost.
    // THE SECOND CLAUSE IS THE ONE THAT BITES HERE: a `disclose()` feeding a
    // ledger READ writes no field and still pushes its value into the public
    // transcript VERBATIM. Which is why point 1 above is a measurement over the
    // artifact and NOT the argument `C388`'s cell records — *`vault` is already
    // disclosed in the same branch at `:2200`, so `:2192` is free*.
    
    // RULE 20, BOTH POSITIONS, NEITHER MARKED CORRECT. THAT ARGUMENT IS TRUE AND
    // `S49` DID NOT USE IT: `:2200` discloses `vault` INTO A SALTED COMMITMENT
    // and `:2192` discloses it INTO A CONDITION GATING PUBLIC STATE — the
    // language reference's paths (a) and (c), which are different channels
    // (`docs/midnight/01-compact-language-and-stdlib.md:1398-1402`). *Already
    // disclosed once, therefore free to disclose again* is not sound in general,
    // and it is close in shape to reasoning this project has already struck out
    // once: `BACKLOG.md:305-311`, *"A leaf is already a blinded commitment, so
    // publishing a revoked one names nobody"*, retracted 14 Aug as *"a serious
    // privacy regression"*. `S49` reached `C388`'s CONCLUSION and not its
    // reasoning, and this is where a later reader is told so.
    
    // AND THE RESIDUAL, NAMED SO NOBODY READS THIS NUMBER AS SOMETHING IT IS NOT.
    // THIS IS A COUNT OF SITES AND IT IS NOT A PRIVACY BUDGET. What makes 68 safe
    // is not that 68 is a small number; it is that THIS site reaches no ledger
    // operation. A site feeding a ledger read would be equally ONE site and would
    // publish its value. Said the other way round: *`DISCLOSES` IS NOT A LIST
    // OF WHAT IS PUBLIC, AND MUST NOT BE READ AS ONE* — and the enumeration
    // that WOULD be that list has not been written.
    // ======================================================================
    const account = scanSourceFile(ROOT, 'contracts/src/ConfidentialAccount.compact');
    const vault = scanSourceFile(ROOT, 'contracts/src/Vault.compact');
    const sites = (cs: typeof account) => cs.reduce((n, c) => n + c.discloses.filter((d) => d.via.length === 0).length, 0);
    expect(sites(account)).toBe(68);
    expect(sites(vault)).toBe(48);
  });

  it('every site is attributed — nothing floats outside a body', () => {
    for (const f of ['contracts/src/ConfidentialAccount.compact', 'contracts/src/Vault.compact']) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      const inCode = (blankNonCode(text).match(/\bdisclose\s*\(/g) ?? []).length;
      const attributed = scanSourceFile(ROOT, f).reduce((n, c) => n + c.discloses.filter((d) => d.via.length === 0).length, 0);
      expect(attributed).toBe(inCode);
    }
  });

  it('`requireSigner` discloses the signer root, and SEVEN circuits inherit it', () => {
    // A DISCLOSES column for any of those seven that omits it says the circuit
    // reveals nothing when it reveals the root of the signer tree.
    const account = scanSourceFile(ROOT, 'contracts/src/ConfidentialAccount.compact');
    expect(own(account, 'requireSigner')).toHaveLength(1);
    const inheritors = account.filter((c) => c.exported && c.discloses.some((d) => d.via.includes('requireSigner')));
    expect(inheritors.map((c) => c.name).sort()).toEqual(
      ['adopt', 'amendSigner', 'approve', 'cancel', 'propose', 'setThreshold', 'setVaultThreshold'],
    );
  });

  it('AGREES WITH THE FILE ABOUT THE LINE AND THE TEXT, not only the count', () => {
    // Every assertion in this file used to be a length or a `via` chain, and an
    // auditor showed what that misses: `text.slice(openParen + 1, …)` off by
    // one — dropping the first character of EVERY disclosed expression — and
    // `lineOf(...) + 1` — moving every generated `file:line` citation one line
    // off — both stayed green. The citation check cannot see the second
    // either: it only asks whether a cited file is long enough to have that
    // line, so ±1 is always in range.

    // THE LINE IS DERIVED FROM THE FILE'S CONTENT AND IS NO LONGER A LITERAL,
    // AND THAT CHANGE IS THE FINDING RATHER THAN A RELAXATION.
    //
    // It was a literal, twice: 1045, then 1270 when a rewrite moved every line
    // in the contract. The second time it broke it was called the pin working.
    // It is not. A pin by line answers "has anything above this moved", and
    // NOTHING IN THIS SUITE IS SUPPOSED TO ANSWER THAT — the contract is a
    // file whose comments are edited, and inserting a paragraph of prose two
    // hundred lines above a circuit is not a defect in the scanner. Each time
    // the literal broke, the fix was to read the new number off the file and
    // write it down, which restores nothing and buys the next break.
    //
    // WHAT THE TEST IS ACTUALLY DEFENDING is narrower and does not involve a
    // number at all: THE SCANNER SEES THIS DISCLOSE, AT THE PLACE THE FILE
    // ACTUALLY HAS IT, AND REPORTS THE RIGHT EXPRESSION. Both defects above
    // break that and neither moves a line, so deriving the line loses nothing
    // they would have caught — and a comment edit, which breaks a literal and
    // catches nothing, now costs no red.
    //
    // A COUNT IS STILL NOT WHAT THIS IS. The count survived both defects. What
    // stands here is an independent reading of the file compared against the
    // scanner's answer, which is the same instrument the literal was standing
    // in for, with the one thing it could not survive removed.

    // Comments and string bodies are blanked before the search, with newlines
    // kept so line numbers do not move. Two reasons, and the first is this
    // file's own subject: a `disclose(` written in prose must not be found
    // here any more than the scanner may count it — traps 1 and 2 above. The
    // second is that it makes this reading and the scanner's agree about what
    // the file's CODE is, so a disagreement between them is about the scanner
    // and not about which of the two read a comment.
    const discloseLineIn = (relPath: string, opensWith: string): number => {
      const lines = blankNonCode(readFileSync(join(ROOT, relPath), 'utf8')).split('\n');

      const from = lines.findIndex((l) => l.startsWith(opensWith));
      expect(from, `no line in ${relPath} starts with \`${opensWith}\` — the circuit this test `
        + 'reads has been renamed, moved behind an export, or deleted').toBeGreaterThan(-1);

      // The body ends at the first `}` in column 0 after the opener, which is
      // how every circuit in both contracts closes.
      const span = lines.slice(from).findIndex((l, i) => i > 0 && l === '}');
      expect(span, `\`${opensWith}\` in ${relPath} has no closing brace in column 0`)
        .toBeGreaterThan(0);

      const found = lines.slice(from, from + span)
        .map((text, i) => ({ line: from + i + 1, text }))
        .filter((e) => e.text.includes('disclose('));

      // EXACTLY ONE, so the derivation cannot quietly pick the first of
      // several. If a second disclose is added to one of these circuits this
      // test must be looked at rather than silently keep reading the old one.
      expect(found.map((e) => e.line),
        `expected exactly one disclose in \`${opensWith}\` in ${relPath}`).toHaveLength(1);
      return found[0].line;
    };

    // THE ACCOUNT. `requireSigner` is the circuit seven exported circuits
    // inherit their signer-root disclosure from, which is why it is the one
    // read here.
    const ACCOUNT = 'contracts/src/ConfidentialAccount.compact';
    const rsLine = discloseLineIn(ACCOUNT, 'circuit requireSigner(');
    const rs = own(scanSourceFile(ROOT, ACCOUNT), 'requireSigner');
    expect(rs).toHaveLength(1);
    expect(rs[0].line,
      'the scanner reports a different line for `requireSigner`\'s disclose than the file has '
      + 'it on. An off-by-one here moves every generated `file:line` citation and nothing else '
      + 'in this repository refuses it — the citation check only asks whether the file is long '
      + 'enough to have the line.').toBe(rsLine);
    expect(rs[0].text,
      'the scanner reports the wrong expression for `requireSigner`\'s disclose. Dropping or '
      + 'adding one character here is the defect this test was written for, and it changes what '
      + 'a published privacy document says a circuit reveals.').toBe('root');

    // And the derived line really is the disclose, read raw rather than
    // blanked, so the two halves cannot both be satisfied by a search that
    // found the wrong line.
    expect(readFileSync(join(ROOT, ACCOUNT), 'utf8').split('\n')[rsLine - 1])
      .toContain('disclose(root)');

    // THE VAULT. Same shape, and a different declaration keyword on purpose:
    // the account's is `circuit`, the vault's is `constructor`, so the helper
    // is exercised on both spellings.
    const VAULT = 'contracts/src/Vault.compact';
    const ctorLine = discloseLineIn(VAULT, 'constructor(');
    const ctor = own(scanSourceFile(ROOT, VAULT), 'constructor');
    expect(ctor).toHaveLength(1);
    expect(ctor[0].line,
      'the scanner reports a different line for the vault constructor\'s disclose than the file '
      + 'has it on.').toBe(ctorLine);
    expect(ctor[0].text,
      'the scanner reports the wrong expression for the vault constructor\'s disclose.')
      .toBe('a');
    expect(readFileSync(join(ROOT, VAULT), 'utf8').split('\n')[ctorLine - 1])
      .toContain('account = disclose(a);');
  });

  it('the vault declares NO bodiless circuit as its own', () => {
    const vault = scanSourceFile(ROOT, 'contracts/src/Vault.compact');
    expect(vault.map((c) => c.name)).not.toContain('recordPayment');
    expect(vault.map((c) => c.name)).not.toContain('retireVault');
  });
});
