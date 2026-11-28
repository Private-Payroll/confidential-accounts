/*
 * Answers a disclosure, a sign-in or a join: it sorts what the person ticked into what is sent and what is declined, signs the answer, seals it to the inviting company's key for a join, hands it to the page and writes down what went.
 * It sends nothing when the answer cannot be sealed.
 */
import type { AttributeName } from 'midnight-identity/profile/definition';
import { grantTo, recordDisclosure } from 'midnight-identity/profile/model';
import type { Profile, Recipient, Sent } from 'midnight-identity/profile/model';
import { save } from 'midnight-identity/profile/store';
import { mint } from 'midnight-identity/profile/disclosure';
/* The envelope an acceptance travels in, and the wire contract that
 * decides its shape. Nothing else in this app seals anything to a stranger. */
import { sealToInbox } from 'midnight-identity/profile/inbox';
import { unshieldedAddressFor } from '../chain/unshielded.js';
import { rememberSignIn } from '../lib/signed-in-here.js';
import { openWalletId } from '../accounts/wallets-held.js';
import type { ApproveInputs } from './approve-inputs.js';
import type { ApproveState, WhatIsAsked } from './approve-state.js';

export type DisclosureAnswer = Pick<
  ApproveInputs & ApproveState & WhatIsAsked,
  | 'request'
  | 'profile'
  | 'channel'
  | 'rows'
  | 'picked'
  | 'refused'
  | 'subwallet'
  | 'identity'
  | 'port'
  | 'now'
  | 'thisWallet'
  | 'setProblem'
  | 'setProfile'
  | 'setSentAt'
>;

export function disclosedAndDeclined(
  a: Pick<DisclosureAnswer, 'rows' | 'picked' | 'refused'> & { readonly profile: Profile }
): { readonly disclosed: Sent[]; readonly declined: AttributeName[] } {
  const { rows, picked, refused, profile } = a;
  const disclosed: Sent[] = [];
  const declined: AttributeName[] = [];
  for (const row of rows) {
    const definition = row.definition;
    /*
     * **A DERIVED ROW IS COMPUTED HERE AND NOWHERE ELSE, AND `owned` IS
     * WHAT COMPUTED IT.**
     *
     * The value sent is the one the screen showed, because both come out of
     * `row.derived`, which came out of `owned`, which is a function of the
     * slot in the picker. **Nothing in `request` is read on this path.** A
     * request that named an address never got past the parser
     * (`request.ts`), and even if it had there is no line here that could
     * reach it.
     */
    if (definition !== null && row.derived !== null) {
      if (!row.derived.ok || refused[row.attribute] === true) {
        declined.push(row.attribute);
        continue;
      }
      disclosed.push({
        /* NOT A HELD ID, BECAUSE NOTHING IS HELD. `model.ts`'s `Sent` says
         * why this is a label and never a key: `changed` skips a send whose
         * assertion is the wallet's, so nothing ever looks it up. */
        id: definition.name,
        about: definition.name,
        says: { of: 'value', value: row.derived.value },
        /* NOBODY SAID IT. THIS WALLET WORKED IT OUT. `model.ts`'s third arm,
         * and `by: 'self'` here would be the wallet telling a recipient the
         * person typed something nothing they could type would change. */
        asserted: { by: 'wallet' }
      });
      continue;
    }
    const id = picked[row.attribute];
    const held = id === undefined ? undefined : profile.held.find((h) => h.id === id);
    if (held === undefined) {
      declined.push(row.attribute);
      continue;
    }
    disclosed.push({
      id: held.id,
      about: held.about,
      says: held.says,
      asserted: held.asserted
    });
  }
  return { disclosed, declined };
}

export function answerDisclosure(a: DisclosureAnswer): void {
  const {
    identity,
    port,
    now,
    channel,
    profile,
    setProfile,
    subwallet,
    picked,
    refused,
    setProblem,
    setSentAt,
    thisWallet,
    request,
    rows
  } = a;
  if (request === null || profile === null || channel === null) return;
  /*
   * **AN UNLOCK NEVER COMES THROUGH HERE, AND THE TYPE IS WHAT SAYS
   * SO.** This function mints a `DisclosurePayload` and writes a
   * `NewDisclosure`, whose `kind` excludes `unlock` (`model.ts`): a release
   * signs nothing, so an entry claiming it did would demand bytes that do not
   * exist. Removing this line is a typecheck failure, not a silent path --
   * which is the shape it is about, facing the other way.
   */
  if (request.kind === 'unlock') return;
  /* **AND NEITHER DOES A KEYRING ASK**, for the same reason: it gives keys and
   * signs nothing. `releaseKeyring` below is its only door. */
  if (request.kind === 'keyring') return;
  /* **NOR A BALANCE ASK**: it pays and discloses nothing, and its one door is
   * its own screen (`approve-balance.tsx`). */
  if (request.kind === 'balance') return;
  /* **NOR A COMMITTEE CHANGE**: it signs a change to a company's rules and
   * discloses nothing, and its one door is its own screen
   * (`approve-committee.tsx`). */
  if (request.kind === 'committee') return;
  /* **NOR A RECORDS-KEY ASK**: it signs one statement and discloses nothing, and its one door is its own
   * screen (`approve-records-key.tsx`). */
  if (request.kind === 'records-key') return;
  /* **NOR A HOLDERS ASK**: it hands back public chain facts and signs nothing, and its one door is its own
   * screen (`answer-holders.tsx`), which answers without a press. */
  if (request.kind === 'holders') return;
  /* **NOR A CREATION**: this wallet no longer signs a deploy a page built, and refuses it on its own screen. */
  if (request.kind === 'creation') return;
  /* **NOR A JOIN CODE**: it signs one code and discloses nothing, and its one door is its own screen
   * (`approve-join-code.tsx`). */
  if (request.kind === 'join-code') return;
  /* **NOR AN ACTION**: it runs whole on its own screen (`actions/runner-screen.tsx`), which hands back what it
   * builds and discloses nothing. */
  if (request.kind === 'act') return;
  const { disclosed, declined } = disclosedAndDeclined({ rows, picked, refused, profile });
  const at = now();
  const address = unshieldedAddressFor(identity, subwallet);
  /*
   * **THE PAYLOAD DOES NOT CHANGE, AND THAT IS THE POINT.** A sign-in is the
   * same `DisclosurePayload` with `disclosed` and `declined` empty — same
   * bytes, same signature, same `verify` on the other side. Nothing in
   * `disclosure.ts` or `payload.ts` was opened by this change;
   * `sign-in.test.ts` shows one verifier taking both.
   */
  const { response, signedBytes } = mint(identity, subwallet, {
    origin: request.requester.origin,
    nonce: request.nonce,
    address,
    at,
    disclosed,
    declined,
    requesterSaidItWas: { name: request.requester.name, rdns: request.requester.rdns }
  });

  /*
   * **AN ACCEPTANCE IS SEALED BEFORE IT IS SENT, AND BEFORE ANYTHING
   * IS WRITTEN DOWN.** `profile/inbox.ts`.
   *
   * **THE PAYLOAD DOES NOT CHANGE, AND THAT IS THE POINT -- AGAIN.** The same was said
   * about a sign-in being the same bytes as a disclosure. A
   * join is the same bytes as both: `mint` above ran for all three kinds, so
   * what the far side unseals is a `DisclosureResponse` its existing verifier
   * reads. **This change adds an envelope and no new thing to verify.**
   *
   * **THE ORDER IS THE SAFETY.** A seal that refuses -- a key that is the
   * right length and not a point on the curve -- throws here, before
   * `channel.answer`, before `grantTo` and before `recordDisclosure`. So a
   * refusal means nothing crossed, no grant moved and no history entry
   * claims a disclosure that did not happen. **The opposite order would
   * write down an acceptance whose address never left this device**, which is
   * a record that is wrong about the one subject it exists to be right about.
   *
   * **AND THERE IS NO ARM OF THIS THAT ANSWERS IN THE CLEAR.** `answer` is
   * assigned once, from a ternary, so a join with a broken seal has no
   * `response` fallback to reach for: it throws, and the catch below sends
   * nothing at all.
   */
  let outgoing;
  try {
    outgoing = request.kind === 'join' ? sealToInbox(JSON.stringify(response), request.inboxPublicKey) : response;
  } catch (e) {
    setProblem(
      e instanceof Error ? `${e.message} Nothing has been sent.` : 'That could not be sealed, so nothing has been sent.'
    );
    return;
  }
  channel.answer(outgoing);
  /* THIS WALLET ANSWERED THAT PAGE'S SIGN-IN, so a company's key it asks for
   * next is given by this wallet and by no other held here, and every later ask
   * from that page opens this wallet, by its place in this browser. The answer
   * has gone whether or not this can be written, so a failure is said, not thrown. */
  let noted = true;
  if (request.kind === 'sign-in') {
    try {
      rememberSignIn(port, request.requester.origin, thisWallet, openWalletId());
    } catch {
      noted = false;
    }
  }

  const recipient: Recipient = {
    origin: request.requester.origin,
    name: request.requester.name,
    rdns: request.requester.rdns
  };
  /*
   * **A SIGN-IN DOES NOT TOUCH THE GRANT, AND THAT IS A BUG THIS CHANGE CAUGHT
   * RATHER THAN A TIDINESS.** `grantTo` REPLACES a grant's value list, so
   * calling it with the empty list a sign-in has would erase what a person
   * had already agreed this site may see — and the next disclosure screen
   * would pre-tick nothing, silently, with no way to tell that from never
   * having agreed. A sign-in agrees to nothing new, so it changes nothing.
   */
  /*
   * **A GRANT NAMES HELD VALUES, AND A DERIVED ONE IS NOT ONE.**
   *
   * `grantTo` refuses an id nothing holds — correctly, because a grant is
   * *this recipient may see THIS value of mine* and a computed answer is not
   * a value anybody keeps. Passing the derived id would throw at the moment
   * of approval, after the answer had already crossed. So the grant records
   * the held values and the derived row is remembered by the disclosure
   * history alone, which is the record that says what was actually sent.
   */
  const grantedIds = disclosed.filter((s) => s.asserted.by !== 'wallet').map((s) => s.id);
  let next = request.kind === 'sign-in' ? profile : grantTo(profile, recipient, subwallet, grantedIds, at);
  /* THE HISTORY RECORDS CONTENT, NOT POINTERS. §3.2b. */
  next = recordDisclosure(
    next,
    recipient,
    subwallet,
    {
      at,
      kind: request.kind,
      nonce: request.nonce,
      sent: disclosed,
      declined,
      /* §5.5 — the EXACT bytes that were signed, carried straight from `mint`
       * rather than rebuilt here. Nothing on this screen re-serialises them. */
      signed: {
        bytes: signedBytes,
        signature: response.signature,
        verifyingKey: response.verifyingKey,
        scheme: response.scheme
      }
    },
    at
  );
  setProfile(next);
  setSentAt(at);
  if (!noted) {
    setProblem(
      'It was sent, and this wallet could not note that it answered this sign-in. Until a ' +
        "later sign-in to that page is noted, this browser's note of which wallet answered it may be " +
        "out of date: another wallet here may be let give that page a company's key, and this one " +
        'may be refused.'
    );
  }
  void save(port, identity, next).catch(() =>
    setProblem('It was sent, and this wallet could not write down that it was.')
  );
}
