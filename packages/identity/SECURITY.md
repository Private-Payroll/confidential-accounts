# Security

This library derives and holds the keys to people's money.

**EVERY CLAIM BELOW IS PINNED BY A TEST THAT GOES RED WHEN IT STOPS BEING TRUE, OR IT IS MARKED AS A
DESCRIPTION YOU CAN CHECK BY READING THE FILE NAMED BESIDE IT.** Sentences that could be neither were
removed rather than softened. A `file:line` in this document is a place you can go and look; if one
does not resolve, that is a defect and worth reporting.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting on this
repository — the *Security* tab, *Report a vulnerability* — which opens an advisory private to you
and the maintainers. (How GitHub handles it is GitHub's behaviour, not this library's.)

**There is no security email address for this project**, and the advisory flow above is the only
channel that is monitored. This is process rather than a property of the code, so nothing pins it.

If your report concerns key derivation, recovery, or anything that could cause a person to lose
access to their funds, say so in the title.

## What is pinned, and where

### Key derivation

- **The seed and the account-0 keys are byte-identical to the Midnight Foundation's own testkit.**
  Not "compatible with" — the same bytes. A 64-byte `mnemonicToSeedSync` master seed, no passphrase.
  **PINNED:** `packages/identity/src/keys/derivation.portability.test.ts:47` (the seed, and its 64-byte length),
  `:57`, `:61`, `:65` (the three account-0 keys, each compared against
  `@midnight-ntwrk/testkit-js`). Divergence here would produce a wallet no other Midnight tool can
  open, and it would happen silently, which is why the comparison is against somebody else's
  implementation rather than a recorded vector of our own.

- **The path is the SDK's, not ours.** `m/44'/2400'/{account}'/{role}/{index}`; purpose, coin type
  and account hardened, role and index not. **DESCRIPTION — CHECK BY READING**
  `@midnightntwrk/wallet-sdk-hd@3.1.0-beta.1`, `dist/HDWallet.js:21-22` (the `PURPOSE` and
  `COIN_TYPE` constants) and `:96-103` (the path construction and the hardening pattern). This
  library never writes a path string; it calls `selectAccount().selectRoles().deriveKeysAt()`
  (`packages/identity/src/keys/derivation.ts:474-477`).
  **The authority path specifically is pinned** — `m/44'/2400'/1'/0/0`, walked independently through
  `@scure/bip32` and compared byte for byte at
  `packages/identity/src/keys/derivation.portability.test.ts:235-240`, `:347`.

- **An authority key is never a spending key at any BIP-44 path the ecosystem walks.** Authority
  keys are an HKDF-SHA256 expansion of a single SDK-derived key, domain-separated per purpose
  (`packages/identity/src/keys/derivation.ts:524-532`). **PINNED:** `packages/identity/src/keys/derivation.portability.test.ts:395`
  (45 keys across three accounts, five roles and three indices) and `packages/identity/src/profile/unlock.test.ts:591`
  (280 keys). Both walk the BIP-44 grid with `@scure/bip32` and assert the authority keys are
  nowhere in it. **WHAT THAT PINS IS THE PATH AND THE DOMAIN-SEPARATION CONSTANTS, NOT THE
  CRYPTOGRAPHIC PRIMITIVES**, and the difference is worth stating plainly: `@scure/bip32` is the
  same library the SDK itself derives with — `@midnightntwrk/wallet-sdk-hd` declares `@scure/bip32`
  as a dependency and calls its `HDKey` directly, which you can check in the installed package — so
  a defect inside it moves both sides of the comparison together and both tests stay green.
  **This repository now declares `@scure/bip32` in its own `devDependencies`, at the same version
  the SDK resolves**, and that changes where the package comes from without changing whose choice
  it is: the comparison library is still the one `@midnightntwrk/wallet-sdk-hd` depends on, not a
  second, independently chosen one. **The reason for declaring it is not that a clone was broken.**
  `package-lock.json` already carried `@scure/bip32` as that SDK's own transitive, so `npm ci`
  placed it. It is that the pin under the claims above rested on somebody else's dependency list:
  a release of `@midnightntwrk/wallet-sdk-hd` that stopped depending on `@scure/bip32` would take
  these tests down with a missing module rather than a wrong answer, and nothing in this
  repository said it needed the package at all.
  **An earlier version of this document called it an independent walk and concluded that the
  library and its test cannot agree by being wrong in the same way. At the level of the primitives
  they can.**

- **No extended public key above the leaf leaves this library, and that is a rule rather than an
  omission.** Because role and index are not hardened, an extended *public* key at the account or
  role node combined with any single child *private* key beneath it yields the parent private key —
  and therefore every sibling. **PINNED:** `packages/identity/src/security-claims.test.ts:77`, `:96`, a source scan
  that fails if any file outside the three tests that deliberately walk `@scure/bip32` names an HD
  node or an extended key. A watch-only balance view, a server-side verifier and an address export
  are all ordinary features that would reach for one; the scan is there so that whoever writes one
  is told, rather than having to already know.

### The reserved account

- **Account 1 of this seed is reserved and must never be offered as a wallet.** Its NIGHT key —
  the plain BIP-44 key at `m/44'/2400'/1'/0/0` — **is the root every authority credential expands
  from**: expanding it with this library's HKDF reproduces every login, device and seat credential
  byte for byte. A wallet offered at account 1 would hand its holder a spending key that is also the
  credential root.
  **PINNED, four ways:** the expansion itself at `apps/wallet/src/accounts/subwallets.test.ts:137` and
  `packages/identity/src/keys/derivation.portability.test.ts:237-240`, `:347`; the refusal at the derivation door —
  `moneyAt(1)` throws `account-reserved` — at `apps/wallet/src/accounts/subwallets.test.ts:127`; the offered set,
  accounts **0 and 2–11**, at `apps/wallet/src/shell/shell.test.tsx:294`; and the refusals at the storage and
  balance doors at `apps/wallet/src/shell/wallets.test.ts:73`, `:93`, `:148` and
  `apps/wallet/src/chain/balance.test.tsx:89`. **Anything built on this seed must hold the same line.**

  **What this means for a person who imports these twenty-four words into another wallet:** that
  wallet knows nothing of the reservation. It will offer a plain series — account 0, 1, 2, 3 — and
  money received into what it calls account 1 is real, is theirs, and **this wallet can never
  display it, never balance it and never spend it.** Not stolen; stranded, in the wallet they use.
  If you are auditing an integration, check that nothing you build pays into, or displays, account 1
  of this seed.

### Where key material lives

- **No DERIVED key — money or authority — is ever written down. Every one is rebuilt from the one
  secret on demand.** **PINNED:** `packages/identity/src/profile/seal.test.ts:126` (the profile key is created
  non-extractable, and `crypto.subtle.exportKey` on it rejects) and `:132` (the same key comes back
  from the secret alone).

- **THE SECRET ITSELF IS AT REST IN THIS BROWSER, AND SO IS THE KEY THAT OPENS IT.** The account
  secret is AES-GCM sealed into `localStorage` (`apps/wallet/src/accounts/storage.ts:269`) and the key that unseals it
  is generated non-extractable and kept in IndexedDB (`apps/wallet/src/accounts/storage.ts:213-218`).
  **DESCRIPTION — CHECK BY READING** those two ranges. **Non-extractable means the ciphertext cannot
  be carried off and opened somewhere else. It does not mean there is no key at rest**, and the
  passkey does not gate these bytes: the sealed copy is opened without any ceremony
  (`apps/wallet/src/accounts/storage.ts:30-32`, and the same limitation is stated again below). **THAT KEY CAN ALSO
  BE LOST**, and losing it costs the local copy of the wallet — the failure has a name in the type
  system, `sealed-copy-unopenable` (`apps/wallet/src/accounts/storage.ts:57-61`) — after which recovery is only from
  pieces. **An earlier version of this document said there was no key at rest to steal and none to
  lose. Both halves were false, and this repository's own storage layer is where they are false.**

- **An 8-byte fingerprint of the secret, and each account's coin public key, are stored
  UNENCRYPTED.** **DESCRIPTION — CHECK BY READING** `apps/wallet/src/accounts/storage.ts:270`, `:571`, `:635`, `:723`,
  `:848` and `:1173` for the fingerprint — an HKDF-SHA256 of the secret, `packages/identity/src/recovery/pieces.ts:84-89`
  — and `apps/wallet/src/accounts/storage.ts:499-503` for the coin public key. **Neither is a spending key and neither
  is invertible; both are stable correlators** that link records in this browser to one another and
  the coin public key to on-chain activity.

- **This library ships no destination that phones home.** **DESCRIPTION — CHECK BY READING**
  `apps/wallet/src/config.ts:62`: `INBOX_HOST` is `null`, not an unreachable address — there is no server
  of ours anywhere in this repository. A host may add a destination of its own.

  **AND THE LIMITATION THAT BELONGS BESIDE THAT, SAID PLAINLY:** the secret is held in this
  browser, so **script running on this origin can read it without any ceremony** — a cross-site
  scripting hole here is a total compromise of the wallet, and the passkey does not stand in its
  way. `apps/wallet/src/accounts/storage.ts:26-35` says the same thing where the storage is written.

### Recovery

- **One piece is never enough to rebuild anything.** **PINNED:** `packages/identity/src/recovery/pieces.test.ts:85`,
  which asserts `combinePieces` refuses a single piece by name (`not-enough-pieces`).

- **A threshold of one is refused**, and **no two pieces may sit behind the same holder**.
  **PINNED:** `packages/identity/src/recovery/pieces.test.ts:242` and `:261` (`holders-collide`, including the
  case-folded duplicate), `packages/identity/src/recovery/session.test.ts:114`, and the stored-record read path at
  `apps/wallet/src/accounts/storage.test.ts:143`.

- **A recovery piece carries the threshold and a fingerprint of the account it belongs to**, and
  **the rebuilt answer is checked.** Shamir itself has no integrity check and no knowledge of its own
  threshold, so without this a wrong number of pieces — or pieces from an older set of the same
  person's — would rebuild *something*, and the person would be handed a valid wallet at a place
  nobody has ever paid into. **PINNED:** `packages/identity/src/recovery/session.test.ts:209` (a piece from a foreign
  set is refused), `:270` (the threshold is read off the piece, not trusted from the caller),
  `packages/identity/src/recovery/pieces.test.ts:129` (a damaged share is caught by the fingerprint of what was
  rebuilt — `wrong-secret`) and `:174` (two cuts of the *same* secret are refused as
  `pieces-from-different-sets`).

- **A recovery session that has ended — finished or cancelled — carries none of its pieces.**
  Cancellation is the veto, so that is the case that matters most. **PINNED separately for each
  branch:** `packages/identity/src/recovery/session.test.ts:28` (completed) and `:140` (cancelled, which also asserts
  that what remains can no longer be combined).

- **Recovery is proved before it is claimed.** The secret is rebuilt from real subsets of the pieces
  at set-up, and every minimum-sized subset is tried rather than the first one that works.
  **PINNED:** `packages/identity/src/recovery/split-proves.test.ts:34`, which substitutes a splitter whose shares do
  not rebuild and asserts `splitSecret` itself rejects — so removing the proof from the split door
  turns it red — and `packages/identity/src/recovery/pieces.test.ts:414`, which corrupts one piece of five at
  threshold three and asserts the proof still fails after a good triple has already succeeded.

- **A recovery session that is still gathering holds FEWER pieces than its threshold — for a 2-of-N
  set, exactly one.** **DESCRIPTION — CHECK BY READING** `packages/identity/src/recovery/session.ts:281-287`, which is
  the sole definition of what `gathering` means: at threshold or above the session is no longer
  gathering. **SO THE SESSION THAT HOLDS THE WHOLE SECRET IS A `waiting` OR `ready` ONE**
  (`packages/identity/src/recovery/session.ts:290-295`), because threshold-many pieces ARE the secret — **and
  `waiting` is precisely the state designed to be serialised and carried between devices.**
  **THIS IS AN INSTRUCTION TO A HOST AND NOTHING IN THIS LIBRARY ENFORCES IT: a session that has
  reached its threshold must not be written anywhere a host can read without being sealed first.**
  The reference wallet keeps it in memory only (`apps/wallet/src/session.tsx`), and no test would notice if
  that changed. The terminal states are safe by construction — `completeRecovery`
  (`packages/identity/src/recovery/session.ts:376-381`) and `cancelRecovery` (`:323-329`) both return a session with
  `gathered` emptied. **An earlier version of this document said a gathering session holds more than
  one piece, which is false and pointed the warning at the wrong state.**

### Device pairing

- **Pairing commits before it reveals, and the sealing side answers exactly once.** The two digits
  both screens show are computed from both public keys **and a nonce the receiving device chooses
  after the sending one has committed**. Committing to the key alone is not enough — the nonce is the
  other free variable, and a device that will answer a second time can be made to display any number
  you like. **PINNED:** `packages/identity/src/devices/pairing.test.ts:222` (a reveal that does not match the
  commitment is refused), `:102` (the digits cannot be ground, because the commitment comes first),
  `:170` (the nonce cannot be ground either, because the old device answers once), `:519` (the digits
  depend on both keys *and* the nonce), `:475` (300 distinct, unpredictable nonces), `:69` (nothing
  is sealed until a number has been shown) and `:321` (a code is one use on the receiving side too).

### Passkeys and sign-in

- **A passkey authenticates and never carries key material.** Otherwise a remotely compromised
  platform account would be a total compromise. **PINNED:** `packages/identity/src/security-claims.test.ts:108`, a
  source scan asserting there is no PRF call and no WebAuthn extension requested or read anywhere in
  the library.

- **A registration proves nothing about who holds the key** — `attestation: 'none'` means there is no
  signature over one, so this library accepts a registration carrying somebody else's public key and
  records it as unproven. **PINNED:** the literal at `packages/identity/src/security-claims.test.ts:113`; the flag at
  `packages/identity/src/passkey/verify.test.ts:85` (unproven at registration), `:95` (a registration with a foreign
  key succeeds, and that person's own sign-in is then refused for ever) and `:276` (proven after one
  real sign-in). **A host must not count an unproven credential toward any rule about what an account
  may do** — that is an instruction to a host, and nothing here can enforce it.

- **A sign-in names a person and that name is checked, not reported.** The authenticator's
  `userHandle` must match the handle recorded at registration, so a host cannot take the person from
  the request. **The signature is checked first, so a mismatch cannot be used to discover which
  accounts exist.** **PINNED, and the ordering specifically:** `packages/identity/src/passkey/verify.test.ts:293` (a
  sign-in claimed for the wrong person is refused) and `:335`, which supplies an input that is wrong
  in *both* ways at once and requires the answer to be `bad-signature` — so moving the handle check
  above the signature check turns it red.

- **Replay is refused by a one-use challenge, and the challenge STORE is the thing that refuses
  it.** **PINNED at two levels:** `packages/identity/src/passkey/challenges.test.ts:27` (the store spends a challenge
  exactly once) and `apps/wallet/src/session.test.tsx:343`, which injects a store that spends everything and
  asserts the verifier is never even reached. **THE VERIFIER IS NOT A THIRD LEVEL AND MUST NOT BE
  READ AS ONE.** `verifyAssertion` checks that the challenge presented is the one expected, which is
  a stateless comparison (`packages/identity/src/passkey/verify.ts:287-291`), **so a replayed assertion carrying the
  same expected challenge passes it.** Only something with memory can refuse a second use, and that
  is this interface's job rather than the verifier's — the library says so at `packages/identity/src/ports.ts:17-20`.
  An earlier version of this document cited `packages/identity/src/passkey/verify.test.ts:383` here as a third level;
  that test passes a REGISTRATION challenge as a sign-in's expectation and asserts
  `challenge-mismatch`, which pins BINDING and not one use.

- **THE ONE-USE CHALLENGE IS THE WHOLE OF THE REPLAY DEFENCE FOR MOST PEOPLE, AND THE CLONE
  DETECTOR IS NOT A SECOND LAYER FOR THEM.** A synced passkey — iCloud Keychain, Google Password
  Manager, which is how most people's passkeys are stored — reports a sign counter of zero for
  ever, and **a zero is treated as the counter being switched off rather than as a clone**, because
  it must not fire on every ordinary sign-in. So for those credentials the detector sees nothing.
  **PINNED:** `packages/identity/src/passkey/verify.test.ts:430`, which asserts `signCountLooksCloned(7, 0)` is
  `false` while `(5, 2)` is `true`. The detector is real for authenticators that do count —
  `:407` refuses a genuine, correctly signed sign-in replayed after a later one — but **do not
  count on it being reached.** That a synced passkey reports zero for ever is a fact about those
  platforms, not about this library, and nothing here can pin it.

- **A host supplying its own challenge store MUST run the conformance suite against it.**
  **DESCRIPTION — CHECK BY READING** `packages/identity/src/passkey/challenges.test.ts:13-62`, which is the suite. The
  one-use property above is the whole replay defence, and a store that does not hold it silently
  removes that defence. **THIS IS AN INSTRUCTION TO A HOST AND NOTHING HERE ENFORCES IT** — the
  suite's own contents are pinned, and `packages/identity/src/passkey/challenges.test.ts:64` is where it is run
  against `MemoryChallengeStore` — but whether YOUR store was put through it is not observable from
  here. It is `everyChallengeStoreMustPass` in `packages/identity/src/passkey/challenges.test.ts:13`. **IT IS NOT A PACKAGE
  EXPORT:** the build excludes test files (`tsconfig.build.json:58-63`) and `package.json`'s
  `exports` map has no entry for it, so a host installing this package cannot import it and **must
  copy it out of this repository.** The duty stands; only the convenience is missing.

### The wallet page

- **Nothing is fetched from a third party when the wallet opens.** No font CDN, no analytics, no
  anything: the request itself would tell that party when a wallet was opened and from where, before
  the person has done a thing. Fonts ship in the bundle from exactly pinned packages
  (`package.json:90-91`, no version range). **PINNED:** `packages/identity/src/security-claims.test.ts:137` (every URL
  in the page shell is relative or inline) and `:174` (the stylesheet pulls in no remote font or
  sheet).

- **The wallet does reach the network later, and here is every party it reaches.** **PINNED:**
  `packages/identity/src/security-claims.test.ts:148`, which derives this list from the source rather than trusting
  the prose below, and fails if a fourth file anywhere in the application names an absolute origin.
  - **The indexer**, for balances — `apps/wallet/src/config.ts:33`, `:38`. Asked **only when the person
    presses *Check the balance***, and named on screen for that reason: asking it tells its
    operator this wallet's address.
  - **A stagenet RPC node**, through the SDK facade — `apps/wallet/src/chain/facade.ts`.
  - **`rehearsal.invalid`** — `apps/wallet/src/chain/rehearsal.ts`, deliberately unresolvable, so a rehearsal
    reaches nothing.
  **AND SEPARATELY, FROM THIS WALLET'S OWN ORIGIN:** the proving-key manifest and the key artefacts
  themselves, `apps/wallet/src/chain/key-material.ts:167`, `:227`, reached from the send path via
  `apps/wallet/src/chain/proving.ts:61`. Same-origin and hash-pinned against a committed manifest, so it is not a
  third party — but it **is** a network request, and an earlier draft of this file said there was
  only one and named only the manifest. That is why the list above is derived and not written.

## Handling of secrets in this repository

**DESCRIPTION — CHECK BY READING `.gitignore`.** It excludes `.env` and `.env.*`, wallet and chain
state (`.data/`, `.wallet-state/`, `.midnight/`), and seed material by pattern (`test-wallet.seed`,
`seed*.txt`, `*.mnemonic`, `*.pem`, `*.key`).

**AND THE PART YOU CANNOT CHECK FROM THIS REPOSITORY, SAID RATHER THAN IMPLIED:** what goes INTO
this repository is decided by an allowlist held outside it, not by `.gitignore` — a file not named
on that list is not published. **That list is not in this repository, so you cannot audit that
claim from here.** It is stated because the alternative is letting you infer that `.gitignore` is
the control, which it is not.

**The commit history of this repository has not been scanned end to end.** That is stated because the
absence of a scan is the kind of thing a security document usually implies it has done. If you
believe something sensitive is present, report it through the advisory flow above; treat it as
compromised and rotate, rather than assuming a rewrite of history has removed it.
