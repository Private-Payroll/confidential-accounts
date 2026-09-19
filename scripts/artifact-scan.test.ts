/**
 * THE EXTRACTOR IS THE PART THAT CAN BE WRONG WITHOUT ANYTHING GOING RED, so
 * this is where the tests are.
 *
 * A MISATTRIBUTED EDGE DOES NOT ANNOUNCE ITSELF. It renders as a confident row
 * in a table somebody is about to decide the account contract's shape from, and
 * nothing anywhere disagrees with it. Nothing downstream re-derives this and
 * compares, so a wrong answer here stays wrong and stays quiet.
 *
 * The one that nearly happened is preserved below as a test. `Vault.payout`
 * calls `_sendShielded_0`, which writes KERNEL slots 0, 1 and 2 — and the
 * vault's own fields 0, 1 and 2 are `account`, `notes` and `unshieldedTokens`.
 * Read carelessly, the generator reported `payout` WRITING the contract
 * reference it settles against. In the account contract the same trap is
 * quieter: `_approvalNullifier_0` reads `kernel.self()` at slot 0 and
 * `_blockTimeLt_0` reads block time at slot 2, which decode as `signers` and
 * `openProposals`.
 *
 * SO THE DISCRIMINATION IS TESTED BOTH WAYS — a contract access must be read as
 * a contract access, and a kernel access must NOT be. Asserting only the first
 * is how the bug survives.
 */
import { describe, expect, it } from 'vitest';

import {
  ARTIFACTS,
  callSpansFlat,
  classifyQuery,
  indexDescriptor,
  indicesFromLedgerFn,
  queriesIn,
  readContract,
  spanEnd,
  topLevelStrings,
} from './artifact-scan.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The account's field-index descriptor. Named here so the fixtures are readable. */
const D = '_descriptor_21';

const array = (ops: string) => `context, partialProofData, [${ops}]`;

describe('the scanner survives the strings the generated code actually contains', () => {
  it('does not close a bracket that is inside a string literal', () => {
    // contracts/managed-vault/contract/index.js:826 carries
    // 'contract Acct[recordPayment(Bytes<32>, ...): Bytes<32>, retireVault(...)]'
    // as a type-error message. A paren counter that is not string-aware closes
    // on its parens and takes the rest of the method with it.
    // THE FIXTURE MUST DISCRIMINATE. An auditor showed that the obvious one
    // does not: in `f('contract Acct[recordPayment(Bytes<32>)]', second)` the
    // brackets inside the string are BALANCED, so a counter with no string
    // handling returns the identical index and the test passes either way. So
    // the unbalanced case is asserted first and is the one that matters.
    expect(spanEnd("f('a)b', second)", 1)).toBe(16);
    expect(spanEnd("f('a(b', second)", 1)).toBe(16);
    const text = "f('contract Acct[recordPayment(Bytes<32>)]', second)";
    expect(spanEnd(text, 1)).toBe(text.length);
    expect(topLevelStrings(text.slice(2, -1))).toEqual(['contract Acct[recordPayment(Bytes<32>)]']);
  });

  it('takes the LAST top-level string of an assert, not one nested in its expression', () => {
    expect(topLevelStrings("inner('not this'), 'the message'")).toEqual(['the message']);
  });

  it('blanks a NESTED call out of its parent, so the inner does not donate to the outer', () => {
    // The vault reads the callee address with a queryLedgerState nested inside
    // a crossContractCall argument list.
    const text = 'q(a, q(b, c), d)';
    const flat = callSpansFlat(text, 'q');
    expect(flat[0].replace(/\s+/g, ' ').trim()).toBe('a, , d');
    expect(flat[1]).toBe('b, c');
  });
});

describe('CONTRACT LEDGER ACCESS is read as contract ledger access', () => {
  it('a read: the state is on top and dup n=0 selects it', () => {
    const ops = `{ dup: { n: 0 } }, { idx: { cached: false, pushPath: false, path: [ { tag: 'value', value: { value: ${D}.toValue(10n), alignment: ${D}.alignment() } }] } }, { popeq: { cached: true } }`;
    expect(classifyQuery(array(ops), D)).toEqual({ root: 'contract', kind: 'reads', index: 10 });
  });

  it('a Cell write: a leading push OF THE FIELD INDEX, then ins', () => {
    const ops = `{ push: { storage: false, value: newCell({ value: ${D}.toValue(5n) }) } }, { push: { storage: true, value: newCell({ value: other.toValue(x) }) } }, { ins: { cached: false, n: 1 } }`;
    expect(classifyQuery(array(ops), D)).toEqual({ root: 'contract', kind: 'writes', index: 5 });
  });

  it('A MAP WRITE IS A WRITE, THOUGH IT ALSO WALKS IN', () => {
    // `ins` is the discriminator and NOT the absence of `idx`. A map write
    // carries both, and reading it as a read is how a WRITER goes missing from
    // the table SC8 reads — the one thing this round was told to get right.
    const ops = `{ idx: { cached: false, pushPath: true, path: [ { tag: 'value', value: { value: ${D}.toValue(2n) } }] } }, { push: { storage: true, value: newCell({}) } }, { ins: { cached: true, n: 1 } }`;
    expect(classifyQuery(array(ops), D)).toEqual({ root: 'contract', kind: 'writes', index: 2 });
  });
});

describe('KERNEL ACCESS IS NOT READ AS A LEDGER FIELD — the trap this file exists for', () => {
  it('dup n=2 with no push is the kernel, though slot 0 is a real field index', () => {
    // _approvalNullifier_0 reading kernel.self(). Decoded as a field this is
    // `signers`, and the account really has a field 0.
    const ops = `{ dup: { n: 2 } }, { idx: { cached: true, pushPath: false, path: [ { tag: 'value', value: { value: ${D}.toValue(0n) } }] } }, { popeq: { cached: true } }`;
    expect(classifyQuery(array(ops), D)).toEqual({ root: 'kernel', kind: 'reads', slot: 0 });
  });

  it('dup n=3 AFTER ONE PUSHED VALUE is still the kernel', () => {
    // _unshieldedBalanceGt_0. The pushed value is not a field index, so the
    // contract state has moved one deeper and the selector counts past it.
    const ops = `{ push: { storage: false, value: newCell({ value: other.toValue(amount_0) }) } }, { dup: { n: 3 } }, { idx: { cached: true, path: [ { tag: 'value', value: { value: ${D}.toValue(5n) } }] } }`;
    expect(classifyQuery(array(ops), D)).toEqual({ root: 'kernel', kind: 'reads', slot: 5 });
  });

  it('swap n=0 with an ins is a KERNEL WRITE, not a write to field 1', () => {
    // _sendShielded_0, reached from Vault.payout. This is the exact array that
    // would have made the generator claim `payout` writes the vault's `notes`
    // and `account` fields.
    const ops = `{ swap: { n: 0 } }, { idx: { cached: true, pushPath: true, path: [ { tag: 'value', value: { value: ${D}.toValue(1n) } }] } }, { push: { storage: false, value: newCell({}) } }, { ins: { cached: true, n: 2 } }, { swap: { n: 0 } }`;
    const got = classifyQuery(array(ops), D);
    expect(got.root).toBe('kernel');
    expect(got).not.toMatchObject({ root: 'contract' });
  });

  it('a push of a value one deeper still selects the CONTRACT at dup n=1', () => {
    // The arithmetic, from the other side: the model is that `dup n` counts
    // past whatever has been pushed. If it were "n=0 means contract" this
    // would be misread.
    const ops = `{ push: { storage: false, value: newCell({ value: other.toValue(v) }) } }, { dup: { n: 1 } }, { idx: { path: [ { tag: 'value', value: { value: ${D}.toValue(4n) } }] } }`;
    expect(classifyQuery(array(ops), D)).toEqual({ root: 'contract', kind: 'reads', index: 4 });
  });
});

describe('an unrecognised shape is a REFUSAL, not a default branch', () => {
  it('refuses rather than bucketing something it has not seen', () => {
    // C238 one level up: a classifier with a default branch cannot report that
    // it did not know. A compiler change must stop the generator, not be folded
    // into whichever bucket the code fell through to.
    expect(() => classifyQuery(array(`{ neverSeen: { n: 7 } }, { popeq: {} }`), D)).toThrow(/does not recognise/);
    expect(() => classifyQuery(array(`{ neverSeen: { n: 7 } }`), D)).toThrow(/Nothing was emitted/);
  });
});

describe('the three refusals the header calls load-bearing actually refuse', () => {
  it('refuses when the field-index descriptor is not unique — or is absent', () => {
    // It is `_descriptor_21` in the account and `_descriptor_26` in the vault,
    // where 21 is an `Either`. A generator that took the account's number would
    // read the vault's edges off the wrong constant and emit a plausible table.
    // The check is inert today — there is exactly one in each artifact — so
    // nothing but this proves it would ever fire.
    const one = 'const _descriptor_9 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);';
    expect(indexDescriptor(one)).toBe('_descriptor_9');
    expect(() => indexDescriptor('const _descriptor_9 = new __compactRuntime.CompactTypeBytes(32);')).toThrow(/exactly ONE/);
    expect(() => indexDescriptor(one + '\n' + one.replace('_9', '_12'))).toThrow(/found 2/);
  });

  it('refuses when the TWO compiler passes disagree about a field index', () => {
    // `contract-info.json` and the `ledger()` accessors are two passes stating
    // the same table. Reaching agreement is not evidence that disagreement is
    // caught — this constructs one.
    const desc = '_descriptor_3';
    const accessor = (name: string, idx: number) =>
      `${name}: { isEmpty() { return q(c, p, [{ dup: { n: 0 } }, { idx: { path: [{ tag: 'value', value: { value: ${desc}.toValue(${idx}n) } }] } }]); } }`;
    const moduleText = `export function ledger(x) { return { ${accessor('alpha', 0)}, ${accessor('beta', 1)} }; }`;
    expect(indicesFromLedgerFn(moduleText, desc)).toEqual(new Map([['alpha', 0], ['beta', 1]]));
    const swapped = `export function ledger(x) { return { ${accessor('alpha', 1)}, ${accessor('beta', 0)} }; }`;
    expect(indicesFromLedgerFn(swapped, desc)).toEqual(new Map([['alpha', 1], ['beta', 0]]));
    // Which is what `readContract` compares against `contract-info.json`; the
    // two maps above differ, so the comparison there has something to find.
    expect(indicesFromLedgerFn(moduleText, desc)).not.toEqual(indicesFromLedgerFn(swapped, desc));
  });

  it('refuses a decoded index outside the field table — the misattribution backstop', () => {
    // This is the check that caught the vault's kernel access before the stack
    // model existed. It has no test of its own until here.
    const ops = `{ dup: { n: 0 } }, { idx: { path: [ { tag: 'value', value: { value: ${D}.toValue(9n) } }] } }`;
    expect(() => queriesIn(`queryLedgerState(${array(ops)})`, D, 4, 'Fixture._x_0')).toThrow(/addresses ledger field 9, and this contract has 4 fields/);
    expect(() => queriesIn(`queryLedgerState(${array(ops)})`, D, 12, 'Fixture._x_0')).not.toThrow();
  });
});

describe('the real artifacts, read end to end', () => {
  it('decodes both contracts and cross-checks the field table against TWO compiler passes', async () => {
    // readContract throws if `compiler/contract-info.json` and the `ledger()`
    // accessors disagree about any field index. Reaching this line is that
    // cross-check passing.
    const account = await readContract(ROOT, ARTIFACTS[0]);
    const vault = await readContract(ROOT, ARTIFACTS[1]);
    expect(account.fields.map((f) => f.name)).toEqual([
      // S35c fixed this table for ever. Slots 0-13, in declaration order; slot
      // 14 is deliberately empty and is the guard's margin, not inventory
      //. `runStart`+`runEnd` became `runWindow` and `signerCount` was
      // deleted as derivable from `signerLeaves.size()`; the last four are
      // reserved, and three of them have no circuit anywhere.
      'signers', 'approvals', 'openProposals', 'approvalCounts', 'movements', 'threshold',
      'thresholds', 'vaults', 'runWindow', 'signerLeaves', 'retiredAt', 'proposalHolds',
      'successor', 'signerRoles',
    ]);
    // DECLARATION ORDER. `spendingCaps` is reserved: the constructor's emitted
    // `initialState` writes it, and no circuit reads or writes it yet, so it
    // appears here and in the constructor list below and nowhere else.
    expect(vault.fields.map((f) => f.name)).toEqual([
      'account', 'notes', 'unshieldedTokens', 'payments', 'spendingCaps',
    ]);
  });

  it('`Vault.payout` does NOT write the vault fields its stdlib touches in the kernel', async () => {
    const vault = await readContract(ROOT, ARTIFACTS[1]);
    const payout = vault.circuits.find((c) => c.name === 'payout');
    expect(payout).toBeDefined();
    expect(payout?.writes.map((w) => w.field).sort()).toEqual(['notes', 'payments']);
    // `account` is the contract reference it settles against. It is READ and
    // never written, and the kernel writes are recorded as kernel writes.
    expect(payout?.reads.map((r) => r.field).sort()).toEqual(['account', 'notes']);
    expect(payout?.kernel.some((k) => k.kind === 'writes')).toBe(true);
  });

  it('the WITNESS closure runs through helpers — without it no circuit checks its caller', async () => {
    // Not one of the account's provable circuits reads localSecretKey itself:
    // all three signer witnesses are read inside `_requireSigner_0`, which
    // seven circuits call. A direct-only scan reports that nothing on this
    // contract checks who is calling it.
    const account = await readContract(ROOT, ARTIFACTS[0]);
    const approve = account.circuits.find((c) => c.name === 'approve');
    expect(approve?.witnesses.map((w) => w.witness).sort()).toEqual(['localSecretKey', 'signerBlinding', 'signerPath', 'signerScope']);
    expect(approve?.witnesses.every((w) => w.via.length > 0)).toBe(true);
    // And the three cross-contract callees read no witness at all, by design.
    for (const name of ['recordPayment', 'retireVault', 'closeExpiredRun']) {
      expect(account.circuits.find((c) => c.name === name)?.witnesses).toEqual([]);
    }
  });

  it('the CROSS-CONTRACT calls are the three the vault really makes', async () => {
    const vault = await readContract(ROOT, ARTIFACTS[1]);
    const calls = vault.circuits.flatMap((c) => c.calls.map((x) => `${c.name} → ${x.circuit}`)).sort();
    expect(calls).toEqual(['payout → recordPayment', 'payoutUnshielded → recordPayment', 'retire → retireVault']);
    const account = await readContract(ROOT, ARTIFACTS[0]);
    expect(account.circuits.flatMap((c) => c.calls)).toEqual([]);
  });

  it('THE CONSTRUCTOR IS EXTRACTED — it writes fields no circuit writes', async () => {
    // `contract-info.json` has no constructor entry and the emitted body is
    // `initialState`, which does not match `_<name>_<n>`. A scan over circuits
    // alone reported that `Vault.account` has NO WRITER — which is `C286`'s
    // corrected sentence coming back as machine-written fact.
    const vault = await readContract(ROOT, ARTIFACTS[1]);
    expect(vault.ctor).not.toBeNull();
    expect(vault.ctor?.writes.map((w) => w.field).sort()).toEqual([
      'account', 'notes', 'payments', 'spendingCaps', 'unshieldedTokens',
    ]);
    // And no CIRCUIT writes `account`, which is the property C286 is about.
    expect(vault.circuits.filter((c) => c.writes.some((w) => w.field === 'account'))).toEqual([]);
    // Its signature is read off its own type checks, not invented.
    const account = await readContract(ROOT, ARTIFACTS[0]);
    // ONE ARGUMENT SINCE `S35d` — `C340` + `C343` deleted the threshold and the
    // constructor sets `threshold = 1` from a literal. This reads the COMPILED
    // artifact, so it goes red until `COMPILE-CONTRACT.command` has run.
    expect(account.ctor?.signature).toBe('constructor(foundingLeaf: Bytes<32>)');
    expect(account.ctor?.writes).toHaveLength(account.fields.length);
  });

  it('the helper chain printed is the SHORTEST one, because it is a claim about the route', async () => {
    const account = await readContract(ROOT, ARTIFACTS[0]);
    const approve = account.circuits.find((c) => c.name === 'approve');
    const signers = approve?.reads.find((r) => r.field === 'signers');
    expect(signers?.via).toEqual(['_requireSigner_0']);
  });

  it('an assert carries its MESSAGE, not the first string in its expression', async () => {
    const account = await readContract(ROOT, ARTIFACTS[0]);
    const setThreshold = account.circuits.find((c) => c.name === 'setThreshold');
    expect(setThreshold?.asserts.map((a) => a.message)).toContain('the threshold must be at least one');
    expect(setThreshold?.asserts.map((a) => a.message)).toContain('that proposal is not for this threshold');
    // Nothing that is not a message, and nothing empty.
    for (const a of setThreshold?.asserts ?? []) expect(a.message.length).toBeGreaterThan(0);
  });

  it('READS THE SAME NUMBER OF ASSERTS UNDER VITEST AS ON DISK', async () => {
    // This assertion exists because it once did not hold. The needle was
    // `__compactRuntime.assert`, and `Function.prototype.toString()` returns
    // different text depending on who loaded the module — vitest's module
    // runner rewrites a namespace import — so the generator found every assert
    // and the suite found none, silently, on the same artifact.
    const account = await readContract(ROOT, ARTIFACTS[0]);
    const vault = await readContract(ROOT, ARTIFACTS[1]);
    expect(account.circuits.reduce((n, c) => n + c.asserts.length, 0)).toBeGreaterThan(20);
    expect(vault.circuits.reduce((n, c) => n + c.asserts.length, 0)).toBeGreaterThan(5);
    // And `C285` on sight: the vault's `deposit` has NO assert while its
    // unshielded sibling carries one. That is the column earning its place.
    expect(vault.circuits.find((c) => c.name === 'deposit')?.asserts).toEqual([]);
    expect(vault.circuits.find((c) => c.name === 'depositUnshielded')?.asserts.length).toBeGreaterThan(0);
  });

  it('`maxval` KEEPS ITS DIGITS — JSON.parse rounds it and rule 9 forbids that', async () => {
    // Parsed as a JavaScript number, 18446744073709551615 comes back as
    // 18446744073709552000, and a signature rendered from that is a number no
    // instrument read off anything.
    const account = await readContract(ROOT, ARTIFACTS[0]);
    const sig = account.circuits.find((c) => c.name === 'setThreshold')?.signature ?? '';
    expect(sig).toContain('Uint<0..18446744073709551615>');
    expect(sig).not.toContain('18446744073709552000');
  });

  it('A KEY FACT REFUSES RATHER THAN GOING BLANK when the keys are absent', async () => {
    // An ordinary compile skips the proving backend and leaves no keys/, which
    // is the state on almost every machine. A fact that came back blank would
    // read as "this circuit has no verifier key", which is a different claim
    // from "nobody has measured one here".
    const account = await readContract(ROOT, ARTIFACTS[0]);
    const provable = account.circuits.filter((x) => !x.pure);
    expect(provable.length).toBeGreaterThan(5);
    for (const c of provable) {
      const k = account.keys.get(c.name);
      expect(k).toBeDefined();
      if (k && k.measured === false) {
        expect(k.why).toContain('keys');
      } else if (k && k.measured === true) {
        expect(k.bytes).toBeGreaterThan(0);
        expect(k.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('AND A KEY FACT NAMES NO DOOR, because a fact nothing publishes may not name one', async () => {
    // It used to carry the name of a local launcher, and that name was rendered
    // into a document this repository publishes. Both halves of that were
    // wrong: a published document may not name a tool that is not published,
    // and a document may not quote a measurement most copies of this repository
    // cannot take.
    //
    // READ OFF A LIVE SCAN. The first version of this built a literal three
    // lines above and asserted its own keys, so restoring the field tomorrow
    // would have left it green: a test with no subject.
    const account = await readContract(ROOT, ARTIFACTS[0]);
    const facts = [...account.keys.values()];
    expect(facts.length).toBeGreaterThan(5);
    for (const fact of facts) {
      expect(Object.keys(fact).sort()).toEqual(
        fact.measured ? ['bytes', 'measured', 'sha256'] : ['measured', 'why'],
      );
    }
  });
});
