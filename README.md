# Confidential Accounts

[![check](https://github.com/Private-Payroll/confidential-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/Private-Payroll/confidential-accounts/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Compact](https://img.shields.io/badge/Compact-pinned-informational.svg)](.github/checks/toolchain.mjs)
[![Tests](https://img.shields.io/badge/tests-see%20CI-informational.svg)](#tests)

An M-of-N account layer for the Midnight Network, and the first product built on it: confidential
stablecoin payroll.

The account is the primitive. Payroll proves the primitive is useful. Everything after payroll is a
plug-in.

## Why this exists

Midnight has no account abstraction. The Foundation's wallet documentation classifies every wallet by
custody model, and the smart contract row is empty across browser, mobile, CLI and agent. Every
shipped wallet is single-signer self-custody.

So no business can hold funds on Midnight the way businesses actually hold funds, which is jointly,
under a policy, with an audit trail.

Porting a Safe would not fix it. On a transparent chain a Safe publishes every owner, every approval
and every balance. On Midnight we can do what Safe cannot.

|           | Safe on a transparent chain | Here                                                             |
| --------- | --------------------------- | ---------------------------------------------------------------- |
| Owners    | Every address public        | Blinded commitments as Merkle leaves; only the root on chain       |
| Approvals | Name the signer             | Nullifiers: a distinct authorised signer approved, not which one   |
| Payload   | Public                      | Commitment only                                                    |
| Balance   | Public                      | Not on chain at all. The account contract holds no balance field   |
| Threshold | Public                      | Public here too, deliberately: it is what makes the account auditable |

## How it works

- **Customers never touch a token.** A sponsor service pays all fees. See
  [decision 1](docs/decisions/0001-a-sponsor-service-pays-all-fees.md).
- **Signers share confidential state** through a viewing key wrapped to each of them, with a
  commitment on chain. Midnight has no primitive for this, so the account layer supplies it. See
  [decision 2](docs/decisions/0002-shared-confidential-state-is-built-at-the-account-layer.md).
- **The chain learns that a threshold was met, not who met it.** See
  [decision 3](docs/decisions/0003-signers-are-merkle-leaves-and-approvals-are-nullifiers.md).
- **One commitment scheme for account state**, defined once in the contract. See
  [decision 4](docs/decisions/0004-one-state-commitment-scheme-defined-in-the-contract.md).

Read `docs/decisions/` before changing the contract or the key handling. Those four files are the
difference between this and a Safe clone, and two of them exist because writing the contract tests
found real bugs.

## Current state

| Layer                        | State                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| Cryptography                 | Real. ed25519, x25519, AES-256-GCM, all `@noble`. Passkeys via WebAuthn |
| Account, policy, payroll     | Real                                                                    |
| Identity and multi-tenancy   | Real. A wallet signs in. There is no password, anywhere                 |
| Key custody                  | Real. `packages/identity` derives and holds them; see its `SECURITY.md` |
| Wallet application           | Real. `apps/wallet`                                                     |
| Contracts                    | Two. The account and the vault. Both compile; their circuits are tested |
| On chain                     | The account contract has been deployed to Stagenet and settled          |
| Ledger and proofs at runtime | **Simulated.** `MidnightLedger` is written, not wired to a node          |
| Plug-in isolation            | **Not built.** The catalogue is manifest data, not a sandbox             |

### On chain

The account contract was deployed to Midnight Stagenet on 28 August 2026 and the chain accepted it
as `SucceedEntirely`, at block 215,346.

|                              |                                                                     |
| ---------------------------- | ------------------------------------------------------------------- |
| Circuits live                | 11 of 15                                                             |
| Transaction size             | 31,201 of a 50,000 limit - 62.4%, against a real ceiling of 37,500   |
| Predicted before submitting  | 31,450, so the size model was 0.8% low                               |
| Fee                          | estimated to the unit                                                |
| Deploy time                  | 28.3s, or 67.4s including wallet sync                                |
| Proof server                 | `midnightntwrk/proof-server:9.0.0-rc.3`                              |
| Protocol version             | 2000000                                                              |

Of the transaction, 25,035 bytes are the contract's initial state and 22,541 are the eleven verifier
keys. **The four remaining circuits were deferred deliberately, not omitted**: `adopt`,
`recordPayment`, `retireVault` and `setVaultThreshold` arrive in a second deployment with a
migration carrying the signer tree, balances and movement log across. The client refuses to call one
by name, and refuses any deployment whose operation set is not the one it was built for, in both
directions.

**Stagenet resets, so a contract address from August is a historical fact rather than a live pointer.
The measurements above are not.**

### And what is not on chain

The **application** is not wired to a node. The server and the web client run against
`MidnightLedger`, an implementation of the boundary that does not talk to one. So the contract is
proven on a real chain and the product is not yet plugged into it. **That wiring is in progress**, and
it is a wiring rather than a rewrite: the boundary was built for exactly this and nothing above it
knows which implementation is running.

`src/core/ledger.ts` is that boundary, and its header states exactly what is honest and what is
simulated.

## Tests

A clone of this repository runs the whole suite with `npm test`, and every push runs it. The file
and assertion counts are on the run rather than written down here, because a number typed into a
README is a number nothing keeps true.

Sixteen assertions do not run in a clone. Five are on the money path: they read verifier keys, which
an ordinary compile does not produce, so a separate job builds those keys and runs exactly those
files on every push. The other eleven read files that are not published, and they are excluded rather
than left to fail.

## Layout

```
contracts/     Compact source. The account and the vault
src/core/      isomorphic. runs identically on a server and in a browser
  crypto.ts    the part that does not change when we move to Midnight
  ledger.ts    THE BOUNDARY. Ledger and ProofSystem interfaces
  identity.ts  sessions and the sealed bundle the server cannot open
  account.ts   signers, policy, proposals, approvals, membership
  payroll.ts   roster, runs, per-employee sealed payslips
  plugins.ts   capability tokens. propose-never-execute
src/server/    Express. auth and membership gates on every route
src/web/       React client. holds every key the server must not
src/midnight/  Midnight adapters, behind the boundary
src/standalone/ single-file build. the whole product, no server
packages/identity/ the key library. its own manifest, its own SECURITY.md
apps/wallet/   the wallet application. React, its source under src/
scripts/       the build, the checks, and the tools that measure them
.github/       the checks that run on every push
docs/decisions/ why the architecture is the way it is
```

## Running it

```bash
npm install
npm run dev          # the app on :5173, its server on :8787, the wallet on :5180
npm run standalone   # one self-contained html file
```

`npm run dev` is the one command that starts the product. The server it starts is read-only: it holds
no wallet and cannot write to a chain. The wallet is started on an address of its own, never on the app's,
because a wallet's keys are made for the address it is served from.

`npm test` compiles the contracts first, so it needs the Compact compiler.

## The contracts

The compiler version and the language version it accepts are different numbers, and a mismatch fails
with an unhelpful `language version X mismatch`. **`.github/checks/toolchain.mjs` declares which
compiler this repository is built with, and it is the only place that does.**
`.github/checks/fetch-compiler.mjs` installs exactly that one, the build script reads its version
from it rather than repeating it, and the automated checks fetch it on every push - so the path you
are being sent down is the path proven on a machine that has never built this before.

```bash
node .github/checks/fetch-compiler.mjs
```

`contracts/src/ConfidentialAccount.compact` declares `language_version >= 0.22` and
`contracts/src/Vault.compact` declares `0.25`.

```bash
npm run compact:fast   # ABI and circuits, seconds
npm run compact        # plus proving keys, minutes
npm run compact:vault  # the vault
```

Contract work against the Foundation's own source needs a clone of it:

```bash
./scripts/clone-midnight-src.sh            # about 1.2 GB
SLIM=1 ./scripts/clone-midnight-src.sh     # skip the heavy repos, about 180 MB
```

That script installs no compiler of its own; it calls the same fetcher.

The proof server needs Docker:

```bash
docker run -p 6301:6300 midnightntwrk/proof-server:9.0.0-rc.3 midnight-proof-server -v
```

## Rules

Not style preferences. Breaking one turns this into a normal SaaS app that mentions a blockchain.

- **The server never holds anything that decrypts.** No viewing keys, no signer secrets, and no
  password to hold: a wallet signs in, and the key that unseals a person's keyring is made on their
  own device.
- **`core/` stays isomorphic.** No `node:*`, no `Buffer`. The standalone build is the test that it
  still is.
- **Midnight stays behind `Ledger` and `ProofSystem`.** Nothing above the boundary knows which
  implementation is running.
- **A plug-in can propose. A plug-in can never execute.** And it never receives the viewing key.
- **Errors do not leak existence.** A foreign account and a missing account return the same 404, so
  the product cannot be used to find out who its customers are.

## Next

1. **Wiring the application to a node**, so the product runs against the chain the contract is
   already deployed on. In progress.
2. The second deployment, bringing the four deferred circuits live with a migration that carries the
   signer tree, balances and movement log across.
3. Out-of-process plug-in isolation.
4. Postgres, migrations, jobs, a deployed environment.

## Proving

**Proving runs where the private data already is** - see
[decision 7](docs/decisions/0007-proving-runs-where-the-private-data-already-is.md). For a web
product that means the customer's browser, and the SDK supports it: the prover ships as WASM with a
browser entry point declared separately from the Node one.

**Nothing has proved a real transaction in a browser yet.** What has been measured is what the SDK
contains and what these circuits cost, by reading the installed packages and running the compiled
artefacts. The two numbers that decide whether a browser is enough - the bytes and the seconds for a
first payroll run - are taken once the application is wired to a node, because until then there is
nothing honest to time.

Proving keys and the proof server need Docker and open egress, so neither runs in a sandbox.
