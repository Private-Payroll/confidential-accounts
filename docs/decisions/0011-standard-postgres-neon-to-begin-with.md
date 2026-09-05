# 0011 — Standard Postgres, hosted on Neon to begin with

*14 Aug 2026. Status: **decided**. Revised the same day, because a better
framing of the problem replaced the one this document opened with.*

## Decision

**We run on standard Postgres. Neon hosts it to begin with.**

Not "we are on Neon". The point of this document is that the host is a
connection string, and the first host was chosen in ten minutes rather than
defended for an afternoon.

**Supabase was the first answer and was changed the same day**, before anything
was built on it, on the obvious question: if we are only using the database,
why not start on the one that is only a database? That was right, and the
reasoning that had said "stay put" was inertia rather than an argument —
switching costs an hour once there is data and nothing at all before that.

**The two facts that decided it, both checked rather than remembered:**

| | Neon free | Supabase free |
| --- | --- | --- |
| projects | 100 per org | **2 active** |
| inactivity | compute suspends after 5 min, resumes on connect | **project PAUSED after 1 week** |
| branches | **10 per project** | none |
| storage | 0.5 GB | 500 MB + 1 GB files |
| egress | 5 GB | 5 GB |

1. **Supabase pauses a free project after a week of inactivity.** This project
   goes quiet for days at a time — waiting on the Foundation, waiting on a
   chain reset. Returning to a paused database in the middle of a session is
   exactly the class of friction that cost an hour on 14 Aug when a stale dust
   cache read as healthy. Neon suspends *compute* and wakes on the next
   connection; that is a cold start, not an errand.

2. **Branching, ten per project, and this one is not a convenience.** The
   concurrency test that proves the rate limiter is real needs a database, so
   without one it SKIPS — and a skipped test that reads as green is the failure
   this repo keeps a list of. A branch per CI run (I-3) is what turns those ten
   tests from skipped into run. Supabase has no equivalent on the free tier.

Three projects is also the honest minimum — development, CI, and eventually a
beta — and Supabase allows two.

**What Neon does not give us is file storage**, which Supabase bundles. That
costs nothing here: D-3 already decided sealed blobs go to an S3-compatible
store precisely so the choice stays portable, and S3 is available free
elsewhere. We would not have used Supabase Storage anyway.

**Nothing built so far had to change.** The rate limiter is plain SQL behind a
structural type, and the migration is standard DDL — which is the portability
rule paying for itself within a day of being written down, on the very first
occasion it could have.

Identity and auth are **ours**, per the boundary below and M-94. Row Level Security is defence in depth and never the guarantee.

### The correction, and it matters more than the choice

This document first argued for keeping the "exit to AWS" cheap — insurance
against a migration that might never happen. **Companies may eventually
SELF-HOST, and that changes what kind of requirement this is.**

A customer running this on their own infrastructure will not have Supabase.
They will have a Postgres box. So "runs on plain Postgres" is not a hedge
against a future event, it is **a product requirement on day one** — and the
architecture has to be modular now, not modular later.

The practical consequence is stronger than what this document originally said.
It said *only the store adapter may import the Supabase SDK*. The better answer
is **do not use their SDK at all**: connect with a standard Postgres driver over
the connection string they provide. Then there is no Supabase-specific code in
the repository, self-hosting costs nothing, and their free tier is used for
exactly what it is good for.

Same reasoning for sealed blobs when D-3 arrives: use the **S3 API**, which
Supabase Storage, AWS S3, Cloudflare R2 and MinIO all speak — rather than
Supabase Storage's own client. Self-hosters get MinIO and change one endpoint.

## Why the host barely matters, which is the real point

Any managed Postgres is the right trade for a solo founder: I-1 wants Postgres
with migrations and real transactions, and every provider on the list gives
that with the operational burden removed.

**The reason the provider barely matters is work already done.** After S-8, S-9
and M-96 the store cannot express a plaintext salary, company name, signer
name, role or `leafCommitment` — none of them compiles. What a hosted database
holds is envelopes. So the question "can we trust the provider with the data" has
already been answered by not giving them the data, and this decision is about
operations rather than confidentiality.

That is the whole argument for having sealed everything first, arriving on time.

## Identity is ours — and the rule is sharper than "build it ourselves"

**Decided: identity, including auth, is built here — modular and scalable to
our needs, with the option to keep integrating different providers.** The
second half is the part worth stating precisely, because "build it ourselves"
read literally would rule out the very providers the decision keeps open.

> **A provider may attest WHO someone is. It must never be able to obtain WHAT
> they can decrypt.**

Under that rule, passkeys, Google sign-in, or a Midnight passport can all plug
in later: they establish identity, while the key material stays derived on the
device from something the provider never sees. That is exactly M-94's plug-in
slot, and this is the same slot seen from the storage side.

What it rules out is any provider that can reset a password and mint a session,
because that party can become a user — and a user is who unwraps the viewing
key. **This is not a criticism of Supabase Auth specifically; it is equally true
of Auth0, Cognito and Firebase.**

**And it is not free.** Owning identity means owning password reset, email
verification, MFA, recovery, session revocation and breach response, on top of
the three login holes already open (S-1 to S-4). It is the right call because the
alternative breaks the product, but it is the expensive option and a reason to
keep the surface small.

## Why Supabase Auth in particular is the default trap

**Supabase Auth would invert this product's trust model, and it is the default
path, which is what makes it dangerous.**

Our identity design: the password never leaves the device, key material is
derived client-side with argon2id, and the server holds `authHash` and
`authSalt` — values it cannot derive anything useful from. The server cannot
impersonate a user, and therefore cannot obtain what a user's client can
decrypt.

Supabase Auth owns identity instead. It holds the email, performs password
reset, and mints sessions. **A provider that can reset a password and mint a
session can become any user** — and a user is exactly the party who can unwrap a
viewing key. The confidentiality claim would then rest on Supabase's good
behaviour rather than on cryptography, which is the difference between a
guarantee and a control.

This is not a criticism of Supabase Auth, which is good at what it is for. It is
for products where the server is trusted to read user data. Ours is not one.

**So: `auth.users` unused, no `supabase.auth.*` calls, sessions stay ours.**
I-2 (real secrets management, and a `SESSION_SECRET` that survives a restart) is
what makes ours honest, and it is now a prerequisite rather than a chore.

## The second boundary: RLS is defence in depth, never the guarantee

Row Level Security is worth turning on. It must never become the reason data is
safe.

Our guarantee is *the server cannot read it, because it is ciphertext*. RLS is
*the server chooses not to return it*. If RLS becomes the story, we have
replaced a guarantee with a control and told customers it is the former — which
is M-102 exactly, in a new place, and M-102 was a P0.

The test: if RLS were switched off tomorrow by a misconfiguration, what would
leak? The answer must remain "opaque envelopes, plus what
`docs/accounts-and-identity.md` already lists as deliberately readable" — ids,
timestamps, `threshold`, `signerCount`, `memberUserIds`. If that answer ever
becomes "customer data", the sealing has regressed and RLS is hiding it.

## What must never go near Supabase, or any host

- **The proof server.** Decision 0007: the proof preimage contains the balance,
  the amount and the signer's secret key. A hosted prover is not a deployment
  choice, it is the end of the product.
- **Viewing keys and blinding factors.** M-106 removed the last reason the
  server ever held a blinding; do not reintroduce one for operational
  convenience.
- **`.midnight/` seeds.** They fund and identify wallets.

## Staying portable, which is now a feature rather than insurance

`AccountService` and the rest of `core/` already take `DataStore` as an
interface, and `FileStore` implements it. The new work is one more
implementation — `PostgresStore`, not `SupabaseStore`.

**The trap is not the database, it is the platform.** Supabase sells a Postgres
database and, alongside it, an auth system, a storage API, realtime
subscriptions, edge functions and a JavaScript client. That client is the
dangerous one, because `supabase.from('accounts').select(…)` reads like a
database call and is actually an HTTP request to Supabase's own API. There would
be hundreds of them, and every one is a rewrite for anybody not on Supabase —
including a self-hosting customer.

So the rule, and it should be a test rather than a memory (M-105's lesson):

> **No file in this repository imports `@supabase/supabase-js`.**

That is stricter than confining it to an adapter, and it is *easier* — a plain
Postgres driver and SQL migrations are less work than learning their client, and
the result runs on any Postgres anywhere.

What we give up by not using the platform: RLS enforced through their JWTs
(we are not relying on RLS anyway, see above), realtime (not needed), and their
storage API (replaced by S3, which is also a standard).

## Sequencing, and why this comes before the login work

The obvious order is "fix the three login problems, then move the database".
It is the wrong way round, and the reason is not tidiness.

**S-2 is rate limiting. A rate limiter needs an atomic increment.** I-1 records
that `FileStore` has no transactions and that concurrent writes interleave and
lose data — so a rate limiter built on it can be defeated by issuing the
requests concurrently, which is precisely what an attacker does. Building S-2
first would mean building something that looks like a rate limiter and is not,
and this project already has a name for that pattern.

**S-3/S-4 are revocable sessions.** They need a session store that survives a
restart, which is I-2.

So: the storage layer first, then the login work lands on it once, correctly.

## What "self-hosted" means, answered

**Decided 14 Aug: the database only. We still sponsor the transaction fees.**

That is the right split, and it has three consequences worth writing down now
rather than discovering in a support thread.

**1. The sponsor becomes a service with a network boundary.** Today
`WalletFeeSponsor` is a class in this process. A self-hosted deployment runs
their own server and their own Postgres, and calls ours to get a transaction
balanced. That is an API that does not exist yet, and it is the piece that turns
decision 0001 from a component into a product surface. Nothing to build today —
but `settle`, quotas and authentication all belong to it, and it should be
designed as a boundary rather than grown into one.

**2. What the sponsor can see, and it is not nothing.** A transaction handed to
us for fees carries commitments and proofs, not plaintext — no amounts, no
names, no balances. But it does carry the contract address, which circuit is
being called, and when. So we learn *that this account did something of this
kind at this time*, which is metadata rather than content.

That is already true for hosted customers, and it is disclosed in the tiers
document. It matters more here: somebody who self-hosts is likely doing it
*for privacy*, and "you still tell us every time you transact" is a caveat they
should read before choosing, not after. **It should be stated in the
self-hosting docs in those words.**

**3. The sponsor is the natural billing boundary — and it is not a lock.** This
is the good news commercially: self-hosting the database does not let a customer
out of the commercial relationship, because the fees still run through us. That
is what makes offering self-hosting safe rather than a way to lose the business.

But be honest about what it is. **The contract does not care who pays.** Nothing
stops a determined customer funding their own sponsor wallet and paying their
own fees — decision 0001's two-phase balancing is a public technique against a
public chain. So the sponsor is where the commercial relationship naturally
sits, not a technical restriction, and **nobody should later try to make it
one.** Building enforcement into it would mean degrading a design whose whole
merit is that the customer never has to hold a token.

## Consequences

- I-1 and I-2 move from "required eventually" to "next", ahead of S-1 to S-4.
- The Postgres schema is a schema of *envelopes*. Sealed columns are `bytea` or
  `text`; the readable columns are the six named in `SealedAccount` and nothing
  else. A migration that adds a plaintext column for convenience is the S-8
  regression, and the store-leak tests should catch it — they run against
  whatever `DataStore` is in play, which is the point of them.
- I-3 (CI) gets easier to justify the moment the repo is public, and CI is what
  keeps `npm test` honest for outside contributors.
- The existing suite is the acceptance test: **the same tests must pass against
  the Postgres implementation**, unchanged. If any test needs editing to pass on
  Postgres, that test was asserting something about JSON files rather than about
  the product.
