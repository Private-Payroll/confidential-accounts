# 9. Recovery is three different problems, and we already solve the common one

## The claim in the backlog was too broad

K-2 says a forgotten password destroys a company's payroll history. That is true
of *one* case and not of the other two, and the difference decides how much work
this is.

The viewing key is wrapped separately to **every** signer:
`account.wrappedKeys.push({ signerId, ...wrapKey(viewingKey, signer.wrappingPublicKey) })`.
So it is not one secret held in one place. It is N copies, each locked to a
different person's device.

That splits recovery cleanly:

| case | what is lost | is the data gone? |
| --- | --- | --- |
| **A. One signer loses access** | their signing key and blinding factor | **No.** Other signers still hold the viewing key. |
| **B. Every signer loses access at once** | all copies of the viewing key | **Yes.** Nothing on chain can reconstruct it. |
| **C. A one-signer account** | the only copy | **Yes.** Case B with N=1. |

Case A is the one that will actually happen — a lost laptop, a new phone, a
forgotten password by one person on a team of three. Cases B and C are the
catastrophic ones, and they are rarer by construction.

## Case A needs no new cryptography

A signer who has lost everything is, to the contract, indistinguishable from a
new signer. The remaining signers propose their new leaf, approve it to
threshold, and `addSigner` admits it — the same approved path M-37 built, and the
same one that is proven on chain. `grantAccess` then wraps the existing viewing
key to their new wrapping key, and their history is readable again.

**So the mechanism exists and is deployed. What is missing is a screen.** That is
a materially different piece of work from what K-2 implied, and it should be
built as part of the account-management UI rather than as a cryptography project.

The one honest caveat: this is recovery by *quorum*, so it inherits the account's
own threshold. A 2-of-3 account can restore a lost signer; a 2-of-2 account
cannot, because losing one signer already means the threshold can never be met
again. **That is worth telling a customer at the moment they choose their
threshold, not after.**

## Case B and C need a designed answer

Here nothing internal helps, because by construction we hold nothing that
decrypts. The survey of 22 end-to-end-encrypted providers
([PETS 2025](https://petsymposium.org/popets/2025/popets-2025-0113.pdf)) is
blunt about the options:

- **Recovery codes.** What 17 of 22 providers use. Proven and simple. Also
  badly used: only 14.8% of users store the code in more than one place, and
  **12% believed the provider could still help them** — a false belief we would
  be creating if we are not explicit.
- **Human-memorable PIN plus rate-limited HSMs.** More usable, but a hardware
  exploit compromises the data, and the paper's own recommendation is to
  distribute across HSMs from *different vendors* — which is the most promising
  direction it identifies and also the heaviest to operate.
- **Social / trusted contacts.** Five providers offer it. The paper flags
  generative-AI impersonation as a live and underexplored risk. For us it is
  also largely redundant: our M-of-N *is* the social layer, and it is enforced
  by a contract rather than by a support agent's judgement.

**Recommendation: a recovery code, generated once at account creation, plus a
second copy the customer may place wherever they choose.** It is the honest
option — it says plainly that this is the only way back and that we cannot help
— and it is the one whose failure mode is understood. Multi-HSM is the better
long-term answer and should be revisited when there is an operations team to run
it.

## Passkeys are an unlock, not a recovery

WebAuthn PRF is now broadly available: default on Android via Google Password
Manager, Windows 11 since the February 2026 update, and macOS/iOS via iCloud
Keychain across Safari 18+, Chrome 132+ and Firefox 139+.

But **a PRF key is bound to the specific passkey**, so losing the passkey makes
the data permanently inaccessible — the same cliff we have today, reached by a
different road. Passkeys replace *typing a password*; they do not answer *what
happens when it is gone*.

So K-1 does not subsume K-2, and shipping passkeys without a recovery path would
make the problem worse rather than better, by making the credential harder for a
person to hold a copy of.

## Consequences

- **Case A becomes account-management UI**, built on governance that is already
  on chain. No new cryptography, no new trust assumption.
- **The threshold choice becomes a recovery decision**, and the interface has to
  say so at the moment it is made: 2-of-2 has no recovery path, 2-of-3 does.
- **A recovery code is issued at account creation**, worded so nobody believes
  we can help without it. The 12% figure is what that wording exists to fix.
- **Passkeys are sequenced after the recovery path**, not before it.
- **Nothing here changes the main application screens**, so it does not block
  building them.
