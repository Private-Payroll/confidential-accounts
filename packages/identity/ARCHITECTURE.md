# How this is put together

Two things have to be true at once, and every decision below follows from them:

1. **It can be a wallet on its own** — somebody signs up, gets an address, is paid, recovers.
2. **It drops into the payroll product** without that product inheriting a second opinion about
   storage, servers, or screens.

The way to have both is a **core that performs no input or output.**

---

## The shape

```
src/
  index.ts          the public API — the only thing another product imports
  keys/             a secret → seed → keys. Pure. No storage, no network, no browser.
  passkey/          checking a registration and a sign-in. Pure — no browser.
  recovery/         splitting a secret into pieces and putting it back. Pure.
  ports.ts          the interfaces a host must supply
  browser/          the passkey ceremony, IndexedDB, cloud homes — anything with a
                    platform behind it
  app/              the standalone wallet. Uses everything above; nothing imports it.
```

**`browser/` is where the platform lives, and that includes globals.** `address-format` is written
against Node's `Buffer`, which a browser does not have — so `browser/buffer.ts` installs it, and a
host bundling for a browser gets it by importing `midnight-identity/browser`. It is not in the core
because a global is a platform, and `keys/`, `wallet/`, `recovery/` and `passkey/` take values and
return values. Trouble is what happens when that is discovered by running the thing rather than by
reading it: 179 passing tests, and the wallet could not show anybody their own address.

**`passkey/` is pure and `browser/passkey.ts` is the ceremony.** The split is not tidiness: a
browser cannot be driven from a test runner, so the file that calls `navigator` is kept nearly
free of judgement, and every decision about whether an answer is acceptable sits in a file that is
tested against recorded output from a real browser.

**`keys/` and `recovery/` never import from `browser/` or `app/`.** They take values and return
values. That is what makes them testable without a browser, reusable inside the payroll product, and
safe to reason about — the interesting cryptography has no I/O anywhere near it.

## Ports, not implementations

The core does not know where anything is kept. It declares what it needs:

```ts
export interface PieceStore {          // where a recovery piece goes
  put(id: string, piece: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array | null>;
  readonly holder: string;             // for "no two pieces behind one account"
}

export interface KeyringStore {        // where a device keeps its copy
  read(): Promise<Sealed | null>;
  write(next: Sealed, ifVersion: number): Promise<number>;
}
```

The standalone app supplies one set. The payroll product supplies its own — it already has a server,
a session, and a place for sealed blobs, and it should keep using them.

**This is the line that decides whether the "plugs in" claim is real.** If anything in `keys/` or
`recovery/` ever reaches for `fetch`, `window`, or a database, the payroll product inherits an
opinion it did not ask for, and the two stop being separable. It has happened before in this
codebase's history; it is cheap to prevent and expensive to undo.

## Two entry points

- **`midnight-identity`** — the core. Node and browser, no platform assumptions.
- **`midnight-identity/browser`** — passkeys, local storage, cloud pieces. Browser only.

A server-side host imports the first and never pulls the second into its bundle.

## Receiving now, sending later — without a rewrite

The standalone wallet **receives and shows** money: an address, what has arrived, the history behind
it. That is a read from the indexer and nothing more — no proving, no dust, no transaction building,
which is most of the SDK's complexity left out for now.

**Sending is meant to arrive later without anything being rebuilt**, so two rules apply from the
first line of code:

- **Nothing is named or typed as read-only.** No `ReadOnlyWallet`, no `canSend: false`. The wallet
  is a wallet; what exists today is the reading half of it. A type that encodes the limitation has
  to be unpicked from every call site the day the limitation goes.
- **Reading and spending are separate ports from the start.** `WalletReader` — balance, history,
  address — is what we implement. `WalletSpender` is declared and has no implementation. Adding one
  later is a new file and a wiring change, not a redesign.

What must NOT be done in the name of preparing for it: building the facade, the proof server wiring
or dust handling before anything uses them. Designing for a feature nobody has asked to ship is its
own kind of waste. The rule is that the seam exists, not that the machinery does.

## What must never end up in here

- **Anything about companies, payroll, invitations or vaults.** That is the other product. This one
  knows about a person and their keys.
- **A second derivation scheme.** There is one, it is the SDK's, and it is verified against the
  Foundation's own testkit by a test that runs before any other.
