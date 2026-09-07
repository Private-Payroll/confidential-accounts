# midnight-identity

A person's identity and wallet on Midnight: **passkey sign-in, a wallet from the first moment,
sharded recovery, and keys derived from one secret they hold.**

It is built to be two things at once — a standalone wallet, and the identity layer inside a larger
product — which is why the core performs no input or output. See [ARCHITECTURE.md](ARCHITECTURE.md).

Apache-2.0 licensed. Requires Node 22 or later.

## The short version

- **Sign up with a passkey.** Face ID, a fingerprint, whatever the device offers. That is the whole
  of it: no password, no seed phrase to write down, no wallet app to install.
- **A wallet exists from that moment.** An address people can pay.
- **The passkey authenticates and never carries keys.** Deliberate, and pinned by a test — see
  [SECURITY.md](SECURITY.md).
- **Recovery is pieces the person places**, with a threshold they choose, and it is proved to work
  before it is claimed to.
- **Everything is derived from one 32-byte secret.** Nothing is stored that cannot be rebuilt.

## Getting it running

```sh
npm install          # or `npm ci`, to install exactly what the lockfile pins
npm run typecheck    # tsc --noEmit
npm test             # the typecheck, then the whole vitest suite
npm run build        # emits the library to lib/
npm run wallet       # serves the standalone wallet at http://localhost:5180
```

Two more, both about the published package rather than the source:

```sh
npm run check:consumer   # builds a consumer OUTSIDE this folder and imports
                         # every entry point in the `exports` map by specifier
npm run wallet:build     # production build of the wallet application
```

`npm run build` also runs automatically on `npm install` as the `prepare` script, so a consumer that
depends on this repository directly gets `lib/` without being told to build it.

The wallet's port is fixed at 5180 and `strictPort` is set (`vite.config.ts:89`); it is not a
preference. **A passkey is bound to an origin and an origin includes the port**, so an account
created on one port cannot sign in on another.

**What `npm run wallet` gives you, and what it does not.** The wallet runs against a public
stagenet indexer for balances and needs nothing else to start: a real passkey, a real address, real
recovery, real device pairing. **It cannot produce a proof.** Proving needs about 117 MB of key
material that is not in this repository — the SHA-256 pins for it are, at
`apps/wallet/public/keys/manifest.json`, but the program that downloads and verifies against them is
not, so anything requiring a proof will tell you the key material is missing. Balances, addresses,
recovery and pairing do not need it.

## What you can actually do in the wallet

1. **Create an account.** A real WebAuthn ceremony — the browser will ask.
2. **See your address.** Real, and payable. Paste it into an explorer if you want to check.
3. **Check the balance.** This is the one thing that talks to a third party: a named public indexer,
   asked only when you press the button, and named on screen because asking it tells its operator
   this wallet's address.
4. **Secure it.** Cut the account into pieces, watch the rules refuse a bad plan, and note that
   every combination of the threshold is genuinely rebuilt before you are shown anything.
5. **Recover it.** "Forget everything in this browser", then paste the pieces back. The same
   address comes back.
6. **Add a device.** Open a second browser — a different one, or a private window — and move the
   account across. Four messages you copy and paste, and two digits that must match.

**What it does not do.** There is no server of ours, so the passkey is a gate on this browser rather
than authentication to anybody. Sending is declared and not built. Nothing in the interface pretends
otherwise.

## What is here

```
src/
  keys/        a secret → a seed → a wallet and a set of credentials. Pure.
  passkey/     checking a registration and a sign-in. Pure — no browser.
  wallet/      the address somebody is paid at. Pure.
  recovery/    cutting the secret into pieces, locking them, putting it back. Pure.
  devices/     adding a device by scanning a code. Pure.
  profile/     disclosing facts about a person, signed by the wallet that owns the address.
  browser/     the passkey ceremony and the Buffer polyfill. Where the platform lives.
  app/         the standalone wallet — the web app, and the only place with a screen.
  ports.ts     the interfaces a host supplies
  index.ts     the library's main entry point
```

The `exports` map in `package.json` is the full list of entry points a consumer may import. Nothing
under `apps/wallet/` is importable from the package: the library half has no edge into the application
half, which is what makes the library build possible.

## What it will not do

- **It holds no recovery piece and needs no server of ours.** A host may add a destination of its
  own; the library ships none that phones home.
- **It does not send money yet.** Reading is implemented, spending is declared and not built, and
  nothing is named read-only so that adding it later is a new file rather than a redesign.
- **It knows nothing about companies, payroll or invitations.** That is a different layer.

## Reading further

- [ARCHITECTURE.md](ARCHITECTURE.md) — why the core does no I/O, and what that buys
- [SECURITY.md](SECURITY.md) — what to know before auditing this, what is pinned by which test, and
  how to report a vulnerability privately
