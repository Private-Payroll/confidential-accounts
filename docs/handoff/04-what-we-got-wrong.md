# What we got wrong

**Read this before trusting anything in this repo that reads like a settled fact.**

`docs/midnight/00-INDEX.md` §1a records where the *platform's* documentation is wrong. This file
records where **we** were, which nothing else does. Every entry below was believed, acted on, and
sometimes built.

The pattern is one thing: **a source sentence became a paraphrase, and the paraphrase became the
working truth.** Once a fact stops looking like a quotation, nobody re-checks it.

---

### "Midnight creates no coin ciphertext, so a payee is never told they were paid"

**False, and it cost the most.** The upstream sentence — *"this does **not currently** create coin
ciphertexts…"* — is about the **circuit**. The ciphertext is attached at transaction assembly;
midnight-js **refuses to build the transaction** if the payee's encryption key cannot be resolved.
A payee's ordinary wallet holds the coin, permanently, with no help from the payer.

Built on the misreading before anybody checked: a contract change, `payslip.ts`, `coin-commitment.ts`,
two probe commands, a 512-byte event costing **77,292 zkir on the circuit that runs once per person**,
a retention window, a prune circuit, and a row in the money-loss register. All deleted. `V-77`

**What found it:** a non-technical reading — *all wallets have a historic view of all assets
coming in and going out* — and a refusal to accept a design whose elegance was not visible. **A
design that reads as inelegant is evidence, not friction.**

---

### "The mutation suite says the contracts are covered"

**It said so while measuring nothing, three times.** Each time the harness was confidently wrong in
a way the summary line could not show.

- Grep matched multi-line text loosely, and a failed substitution went unchecked — so mutations that
  never applied were reported as *survivors*. `T-6`
- Six mutations went stale against a rewrite and silently stopped testing the thing they named.
  `T-7`
- Sources were restored between iterations but **artifacts were not**, so every vault mutation ran
  against whatever mutated account had last been compiled. `T-9`

**Read the entries, never the verdict line.**

---

### "That test is flaky"

**It was a real defect, twice, and both times the output was thrown away by piping the run into
`grep`.** When finally read: ciphertext is hex, every decimal digit is a hex digit, so a test
searching a serialised record for a salary fails on correct code about one run in 120. The rule
already existed and lived as a private helper in one test file, so the next test that needed it did
not have it. `T-12`

Then a *new* flaky test was written in the same round — one asserting that a 400-iteration loop
happened to hit a 1-in-256 case. Fixed by testing the property instead of the odds.

---

### Smaller, same shape

- **`from` is a reserved keyword in Compact**, so `runPayload(root, payees, from, until)` reads
  perfectly and does not compile. The keyword list was in our own docs. `T-8`
- **`coinCommitment` is not in `compact-runtime`**, which our reference said it was. It is in
  `midnight-js-protocol/ledger`. `V-75`
- **The ledger's `ShieldedCoinInfo` and Compact's are different shapes with the same name** —
  `{type, nonce, value}` as hex strings versus `{color, nonce, value}` as bytes. Passing the wrong
  one fails inside wasm with `arg.charCodeAt is not a function`, which names nothing.
- **A hand-written test double reads circuit arguments by index**, and an argument inserted in the
  middle moves them all. Failed twice, identically, as a `Uint8Array` coerced into an error message
  as `170,170,170,…`.

---

## What to do with this

Nothing here is a rule to memorise. It is one habit: **when a fact matters and you did not read it
yourself, go and read it.** The check has never taken more than two greps, and not doing it has
never cost less than a day.
