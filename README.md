# Confidential Accounts

> **Licence undecided. Do not publish this repository.**
>
> `package.json` says `UNLICENSED` and `private: true` deliberately, so nothing
> here claims a licence it does not have. Whether this is open infrastructure
> under Apache-2.0, matching the Foundation's own repos, or a held product
> asset, has not been decided. Resolve it before adding a git remote.

An M-of-N account layer for the Midnight Network, and the first product built on it: confidential stablecoin payroll.

The account is the primitive. Payroll proves the primitive is useful. Everything after payroll is a plug-in.

## Why this exists

Midnight has no account abstraction. The Foundation's wallet documentation classifies every wallet by custody model, and the smart contract row is empty across browser, mobile, CLI and agent. Every shipped wallet is single-signer self-custody.

So no business can hold funds on Midnight the way businesses actually hold funds, which is jointly, under a policy, with an audit trail.

Porting a Safe would not fix it. On a transparent chain a Safe publishes every owner, every approval and every balance. On Midnight we can do what Safe cannot.

|           | Safe on a transparent chain | Here                                                     |
| --------- | --------------------------- | -------------------------------------------------------- |
| Owners    | Every address public        | Blinded commitments as Merkle leaves; only the root on chain |
| Approvals | Name the signer             | Nullifiers: a distinct authorised signer approved, not which one |
| Payload   | Public                      | Commitment only                                            |
| Balance   | Public                      | Commitment only                                            |
| Threshold | Public                      | Public here too, deliberately: it is what makes the account auditable |

## How it works

- **Customers never touch a token.** A sponsor service pays all fees. See [decision 1](docs/decisions/0001-a-sponsor-service-pays-all-fees.md).
- **Signers share confidential state** through a viewing key wrapped to each of them, with a commitment on chain. Midnight has no primitive for this, so the account layer supplies it. See [decision 2](docs/decisions/0002-shared-confidential-state-is-built-at-the-account-layer.md).
- **The chain learns that a threshold was met, not who met it.** See [decision 3](docs/decisions/0003-signers-are-merkle-leaves-and-approvals-are-nullifiers.md).
- **One commitment scheme for account state**, defined once in the contract. See [decision 4](docs/decisions/0004-one-state-commitment-scheme-defined-in-the-contract.md).

Read `docs/decisions/` before changing the contract or the key handling. Those four files are the difference between this and a Safe clone, and two of them exist because writing the contract tests found real bugs.

## Current state

| Layer                      | State                                                          |
| -------------------------- | -------------------------------------------------------------- |
| Cryptography               | Real. ed25519, x25519, AES-256-GCM, argon2id, all `@noble`      |
| Account, policy, payroll   | Real. 46 tests                                                  |
| Identity and multi-tenancy | Real. The password never reaches the server                     |
| Compact contract           | Compiles, 29 tests run its circuits, proving keys build in 37s   |
| Ledger and proofs at runtime | **Simulated.** `MidnightLedger` is written, not wired to a node |
| Plug-in isolation          | **Not built.** The catalogue is manifest data, not a sandbox    |
| Key custody                | **Not built.** A forgotten password loses the account           |

`src/core/ledger.ts` is the boundary, and its header states exactly what is honest and what is simulated. Read it before trusting anything above.

## Layout

```
src/core/        isomorphic. runs identically on a server and in a browser
  crypto.ts      the part that does not change when we move to Midnight
  ledger.ts      THE BOUNDARY. Ledger and ProofSystem interfaces
  identity.ts    argon2id, zero-knowledge-of-password auth
  account.ts     signers, policy, proposals, approvals, membership
  payroll.ts     roster, runs, per-employee sealed payslips
  plugins.ts     capability tokens. propose-never-execute
src/server/      Express. auth and membership gates on every route
src/web/         React client. holds every key the server must not
src/midnight/    Midnight adapters, behind the boundary
src/standalone/  single-file build. the whole product, no server
contracts/       Compact source
docs/decisions/  why the architecture is the way it is
```

## Running it

```bash
npm install
npm test                 # 75 tests, including 29 against the contract
npm run dev              # server on :8787, client on :5173
npm run build:standalone # one self-contained html file
```

Contract work needs the Compact toolchain and the Foundation's source. One command:

```bash
./scripts/clone-midnight-src.sh            # about 1.2 GB
SLIM=1 ./scripts/clone-midnight-src.sh     # skip the heavy repos, about 180 MB

npm run compact:fast   # ABI and circuits, seconds
npm run compact        # plus proving keys, minutes
```

Pin the compiler. The toolchain version and the language version it accepts are different numbers, and a mismatch fails with an unhelpful `language version X mismatch`. Toolchain 0.31.1 speaks language 0.23.0, which is what `contracts/src` is written against.

The proof server needs Docker:

```bash
docker run -p 6301:6300 midnightntwrk/proof-server:9.0.0-rc.3 midnight-proof-server -v
```

## Rules

Not style preferences. Breaking one turns this into a normal SaaS app that mentions a blockchain.

- **The server never holds anything that decrypts.** No viewing keys, no signer secrets, no passwords.
- **`core/` stays isomorphic.** No `node:*`, no `Buffer`. The standalone build is the test that it still is.
- **Midnight stays behind `Ledger` and `ProofSystem`.** Nothing above the boundary knows which implementation is running.
- **A plug-in can propose. A plug-in can never execute.** And it never receives the viewing key.
- **Errors do not leak existence.** A foreign account and a missing account return the same 404. A wrong password and an unknown email return the same message.

## Next

1. Out-of-process plug-in isolation.
2. Key custody: passkeys and WebAuthn PRF, device enrolment, recovery.
3. Postgres, migrations, jobs, CI, a deployed environment.
4. Wire `MidnightLedger` to a node and settle a real transaction.

Proving keys and the proof server need Docker and open egress, so they do not
run in a sandbox. `./scripts/prove-and-deploy.sh` preflights both and reports
circuit sizes, which is the number that decides whether proving can happen in
a browser or whether every signer needs a local proof server.
