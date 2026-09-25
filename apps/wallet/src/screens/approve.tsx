import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity, Secret } from 'midnight-identity/keys/derivation';
import { PUBLIC_RECEIVING_ADDRESS, RECEIVING_ADDRESS, REGISTRY } from 'midnight-identity/profile/attributes';
import type { Registry } from 'midnight-identity/profile/attributes';
import { abbreviate, check } from 'midnight-identity/profile/definition';
import type { AttributeDefinition, AttributeName } from 'midnight-identity/profile/definition';
import {
  emptyProfile, grantTo, heldAbout, originsFor, recordDisclosure, recordRelease, selfAssert,
} from 'midnight-identity/profile/model';
import type { Held, Profile, Recipient, Sent } from 'midnight-identity/profile/model';
import { browserPort, load, save } from 'midnight-identity/profile/store';
import type { Port } from 'midnight-identity/profile/store';
import type { Opened } from 'midnight-identity/profile/seal';
import { asked } from 'midnight-identity/profile/request';
import type { Ask, Wanting } from 'midnight-identity/profile/request';
import { framingOf, listen } from 'midnight-identity/profile/channel';
import type { Channel, ChannelState, ChannelWindow } from 'midnight-identity/profile/channel';
import { mint } from 'midnight-identity/profile/disclosure';
import { keyringReleaseFor, releaseFor } from 'midnight-identity/profile/unlock';
/* The envelope an acceptance travels in, and the wire contract that
 * decides its shape. Nothing else in this app seals anything to a stranger. */
import { sealToInbox } from 'midnight-identity/profile/inbox';
/* A RENDERING of the company's address. It is not, and must never
 * become, an input to anything derived; `profile/fingerprint.ts` says why.
 * THE SECOND SUBJECT: a rendering of the RECEIVING ADDRESS this
 * screen is about to disclose, for the person to carry back to the page that
 * asked. The same file, the same width, the same argument. */
import { addressFingerprint, companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { EMBEDDER, INDEXER_HTTP_URL, INDEXER_WS_URL } from '../config.js';
import { useConsent } from '../framing.js';
import { ApproveBalance } from './approve-balance.js';
import type { Consent } from '../framing.js';

/**
 * **WHY A PRESS IS REFUSED, BESIDE THE BUTTON IT REFUSES.** A disabled button
 * with no sentence is a page that looks broken; this names what would make the
 * press possible. It renders nothing when the press is allowed.
 */
function ConsentRefused({ consent }: { readonly consent: Consent }): ReactNode {
  if (consent.ok) return null;
  return (
    <p className="m-0 w-full text-sm text-muted" data-consent-refused>
      {consent.says.charAt(0).toUpperCase() + consent.says.slice(1)}
    </p>
  );
}
import { unshieldedAddressFor } from '../chain/unshielded.js';
import { ownedAddressFor } from '../accounts/owned-address.js';
import type { OwnedAddress } from '../accounts/owned-address.js';
/* The producer for a DERIVED attribute, and the reason it lives beside
 * the screen rather than in the registry: `../accounts/derived.ts`. */
import { derive, receivingAddressesOf } from '../accounts/derived.js';
import type { Derived } from '../accounts/derived.js';
/* Which wallet a company is OFFERED, which is a rule and a default
 * rather than a refusal: `../accounts/slot-choice.ts`. */
import { alsoUsedBy, chooseSlot } from '../accounts/slot-choice.js';
import { WALLET_ACCOUNTS, displayNameOf } from '../accounts/subwallets.js';
import { loadSubwallets } from '../accounts/storage.js';
import { NETWORK } from 'midnight-identity/network';
import {
  Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Section,
} from '../kit/index.js';
/* The code is COPIED, never transcribed. By design, nobody
 * reads anything down a phone line in this design. */
import { CopyButton } from '../components/ui.js';
import { hrefOf } from '../routes.js';
import { sayingForUnopenable } from '../lib/unopenable-details.js';
import { rememberSignIn, whyNotThisWallet } from '../lib/signed-in-here.js';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';

/**
 * THE APPROVAL SURFACE FOR A DISCLOSURE.
 *
 * **A DISCLOSURE IS AN ACTION, AND THIS PRODUCT HAS ONE RULE ABOUT ACTIONS:
 * one surface approves anything that leaves the wallet.** Money today, facts
 * about a person now. The interface's first standing rule, and
 * the design repeats it. This is a different SET OF ROWS on the same
 * surface family, not a second approval path.
 *
 * **THE REQUESTER NEVER DRAWS THIS SCREEN.** It is wallet chrome on the
 * wallet's own origin, in a tab the requester opened but cannot reach into.
 * the same family, and already the rule for mini-apps
 * (*the approval surface lives OUTSIDE the frame and
 * the frame can never draw it*). The requester's own words — its name, its
 * reasons — are rendered as TEXT NODES and nothing else.
 *
 * **NO SILENT DISCLOSURE, EVER.** §6. A remembered grant pre-ticks the boxes;
 * it may never skip this screen, and there is no code path here that answers
 * without a press.
 *
 * ── TWO KINDS OF ASK, ONE SURFACE, AND A DIFFERENT SENTENCE ───────────
 *
 * The protocol's second action kind lands here.
 * **A SIGN-IN IS NOT THIS SCREEN WITH AN EMPTY LIST.** An approval screen
 * listing nothing is not an approval screen; it is a screen a person cannot
 * read an answer off. So a sign-in asks ONE question — do you want this site to
 * know it is you — and names the site and the wallet that will answer it.
 *
 * **THE SURFACE IS THE SAME AND EVERY RULE ON IT IS THE SAME.** Wallet chrome
 * the requester cannot draw; the origin observed and shown beside the name it
 * calls itself; the signature bound to origin, nonce, address and time; and
 * **no silent path.** A remembered grant pre-ticks NOTHING here, because there
 * is nothing to tick — and it still may never skip the press. **A site that
 * could sign a person in without a press is a site that can act as them**,
 * which is a strictly larger power than reading one attribute.
 *
 * -- A THIRD KIND, AND THE ONE THAT HANDS OVER A CAPABILITY --------------
 *
 * **AN UNLOCK IS NOT A SIGN-IN WITH A
 * KEY ATTACHED.** A sign-in and a disclosure both end in a statement about the
 * past that a recipient can check for ever. This one ends in **something that
 * keeps working**: the site can read, from now on, and nobody can watch it or
 * take it back. So the screen is written in consequences rather than in
 * mechanism -- what they will be able to do, for how long, and that it does not
 * come back -- and the design is explicit that *release a key* is the
 * wrong sentence to put in front of a person.
 *
 * **THERE IS NO WALLET PICKER ON IT, AND THAT IS THE POINT RATHER THAN AN
 * OMISSION.** The released key is a function of the ACCOUNT and the origin
 * (`profile/unlock.ts`) -- it cannot be per-slot, because a slot is a choice
 * and a choice would have to be REMEMBERED for the same site to be openable
 * tomorrow, which is the stored mapping the design forbids, and its
 * shape besides. A picker here would be the interface asserting a separation
 * the mechanism does not provide. So the screen says out loud
 * that the wallet does not matter, and offers no control that implies it does.
 *
 * **NO SILENT UNLOCK, AND THERE IS NOTHING TO PRE-TICK.** §6's rule is that a
 * remembered grant may pre-tick a box and may never skip the press. Here there
 * is no box: a release is one press or it does not happen. **A site that could
 * obtain a key without a person present is a site that can read a company
 * whenever it likes**, which is strictly more than acting as somebody once.
 *
 * -- THE WALLET CAN SAY WHERE TO PAY YOU, AND IT IS A ROW RATHER THAN A
 * FOURTH KIND -------------------------------------------------------------
 *
 * A founder who signs in with their wallet could not be paid, because nothing
 * in this protocol hands over a receiving address. **The shape taken is (a):
 * the disclosure ask asks for it BY NAME, like any other attribute, and this
 * screen fills it in from the subwallet the person chose — never from `held`,
 * and never from anything the request said.**
 *
 * **WHY IT IS NOT A FOURTH ASK KIND.** An ask kind exists when a screen cannot
 * be written that approves both things at once: an unlock is its own kind
 * because a key and a fact are different powers and *a screen approving both
 * behind one press could not be read*. **A receiving address is not a different
 * power from a first name — it is one more row on the list of things this
 * company will hold about you**, and the invitation design already
 * assumes it: accepting an invitation is a disclosure, on the one surface that
 * approves anything leaving this wallet. A fourth kind would have bought a
 * second screen, a second refusal path and a second place for the origin to
 * stop being shown, and would have made *name, email and where to pay me* two
 * presses when a company legitimately needs all three at once.
 *
 * **WHAT (b) COULD HAVE DONE THAT (a) CANNOT, said rather than skipped:** a
 * kind of its own could refuse to carry anything else, the way `unlock` does —
 * so *hand over your address* could never arrive with *and your email* behind
 * one button. That is a real property and it is not worth a screen: the
 * disclosure surface already shows every row separately, every row is approved
 * separately, and declining one is a normal answer.
 *
 * **AND THE VALUE IS NOT A `Held`.** `../profile/definition.ts`'s `Source` is
 * the whole argument: an address is computed from this person's keys, so
 * storing it would record a computed fact as though somebody had asserted it,
 * and the copy would go stale the moment a different wallet was chosen.
 *
 * -- A FOURTH KIND, AND IT IS NOT A FOURTH SET OF ROWS ----------------------
 *
 * **AN INVITATION RESOLVES HERE**:
 * *"Accepting means handing a company an address and probably a name. That is a
 * disclosure, and this product has one rule about anything leaving a wallet:
 * one surface approves it."*
 *
 * **THE ARGUMENT ABOVE SURVIVES THIS CHANGE INTACT, AND IT IS WORTH SAYING
 * WHY, BECAUSE IT LOOKS OVERTURNED.** It refused to make the receiving address
 * a kind of its own, on the ground that a kind exists when a screen cannot be
 * written that approves both things at once -- and an address is one more row,
 * not another power. **That is still true and a join does not contradict it.**
 * A join's rows ARE a disclosure's rows: the same `wants`, the same `Want`
 * shape, the same item-by-item approval, the same `rowsFor`, the same render.
 * The company sends the list, as it does for a disclosure, because *"probably a
 * name"* is the company's sentence and not one this wallet is entitled to fix
 * for it.
 *
 * **WHAT MAKES IT A KIND IS THE DOOR THE ANSWER LEAVES BY.** A disclosure is
 * answered in the clear over the channel to the page that asked. An acceptance
 * is SEALED to a key the ask carries and is readable by whoever holds it, who
 * need not be that page (`../../profile/inbox.ts`, §5: *"the address never
 * reaches us either"*). Those are two different destinations for the same
 * bytes, and a kind is what makes choosing between them a parse rather than a
 * branch somebody can remove. **A join answered in the clear would be a working
 * path that leaks and it would look finished**, which is the one shape a screen
 * cannot show a person.
 *
 * **SO NOTHING BELOW IS FORKED.** One heading pair, one wallet sentence pair,
 * one closing warning pair, one button pair, and a section a join has that a
 * disclosure does not because a disclosure has no key to name. The rows, the
 * pre-tick, the missing-required line, the origin card and the wallet picker
 * are the same elements, rendered once. **Two copies of this surface would be
 * two places for the observed origin to stop being shown, and only one of them
 * would be the one a test happened to open** -- that was written about the sign-in
 * and it did not stop being true.
 *
 * **AND NOTHING THE ASKING PARTY SUPPLIES IS DRAWN AS MARKUP.** Its name, its
 * `rdns`, its `purpose`, each `want`'s `attribute` and each `want`'s `reason`
 * are the five values it chooses, and every one of them reaches this screen as
 * a React text node. That is the rule this whole surface exists for and it is
 * the reason an invitation belongs here rather than in a form: **a company that
 * could style, order or word what the person sees would be drawing the screen
 * that approves it.** `join-screen.test.tsx` mutation-proves it on two of the
 * five, and the payee-address mutations keep both proofs standing.
 *
 * WHAT THIS CHANGE DID NOT DECIDE. An open question is carried forward
 * about whether an action is *"pushed over a place, dismissible"* or a route in
 * the old frame. **This follows the send screen's precedent — a route — because
 * the shape of the approval surface is not data and is not a round's to
 * settle.** Said rather than quietly chosen.
 */

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * **THE TWO SIZES, NAMED, BECAUSE THE RULE IS ABOUT SIZE.**
 *
 * The wallet was rendering a self-chosen name in its largest type
 * and the address the browser actually observed in its smallest, on a page
 * served from `payroll-b.example` calling itself *Payroll A*. **A claim shown
 * larger than the fact that checks it is a claim this interface has endorsed.**
 *
 * So the two are named here rather than typed at each call site: a FACT — the
 * observed origin, the company's own address — is never smaller than a CLAIM,
 * which is anything the asking site chose to call itself. `unlock-screen.test`
 * ranks the tokens and fails if that inverts.
 */
const FACT_TEXT = 'text-lg';

/** The fingerprint is the thing a person is asked to COMPARE, so it is
 * the largest thing in the section rather than an equal of the address it
 * stands for. */
const FINGERPRINT_TEXT = 'text-xl';
const CLAIM_TEXT = 'text-base';

interface Row {
  readonly attribute: AttributeName;
  readonly required: boolean;
  readonly reason: string | undefined;
  readonly definition: AttributeDefinition | null;
  readonly options: readonly Held[];
  /**
   * **WHAT THIS WALLET WORKED OUT, FOR A DERIVED ATTRIBUTE ONLY.** `null`
   * for every stated one, and a stated row's `options` are `null` here for the
   * same reason: **a row is one or the other and never both**, so there is no
   * state where a screen could show a held value beside a computed one and
   * leave a person guessing which is about to be sent.
   */
  readonly derived: Derived | null;
  /**
   * **THE CODE THE PERSON CARRIES BACK, AND WHY IT IS A FIELD RATHER
   * THAN A BRANCH IN THE RENDER.**
   *
   * `derived.ts`'s whole discipline is that this screen asks whether a
   * definition is derived and never which attribute it is holding. A code
   * belongs to the attributes money arrives at — the shielded receiving
   * address and the public one — so the question
   * *which attribute is this* is answered once, here, where the attribute is
   * already in hand, and the render below stays a render.
   *
   * `null` for every other row, including a derived row whose value was
   * refused: there is nothing about to be disclosed, so there is nothing to
   * confirm.
   */
  readonly code: string | null;
}

/**
 * What the wallet can offer for each thing asked for.
 *
 * **`owned` IS THE CHOSEN WALLET, AS ONE VALUE.** It carries the address
 * and its owner together (`owned-address.ts`), so the slot a derived
 * value is computed from is the slot the screen is showing, by being the same
 * object rather than by two call sites agreeing.
 */
const rowsFor = (
  request: Wanting, registry: Registry, profile: Profile, owned: OwnedAddress,
): readonly Row[] => asked(request, registry).map(({ want, known }) => {
  const definition = known ? registry.definitionOf(want.attribute) : null;
  const isDerived = definition !== null && definition.source === 'derived';
  const derived = isDerived ? derive(definition, owned) : null;
  return {
    attribute: want.attribute,
    required: want.required,
    reason: want.reason,
    definition,
    /* NOTHING DERIVED IS EVER IN `held`, so there is nothing to offer and no
     * list to pick from. `heldAbout` would answer an empty array anyway; not
     * calling it is what says the emptiness is by construction. */
    options: definition === null || isDerived ? [] : heldAbout(profile, definition.name),
    derived,
    /* Computed from the value that is about to be sent and from
     * nothing else — the same string the receiving side will compute from the
     * same address, which is the whole of the comparison. */
    code: (want.attribute === RECEIVING_ADDRESS || want.attribute === PUBLIC_RECEIVING_ADDRESS)
      && derived !== null && derived.ok
      ? addressFingerprint(derived.value) : null,
  };
});

export function Approve({
  identity, secret, registry = REGISTRY, port = browserPort(), view, now = Date.now,
  embedder = EMBEDDER,
}: {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly registry?: Registry;
  readonly port?: Port;
  /** The window this listens on. Injected so a test can drive a real origin. */
  readonly view?: ChannelWindow;
  readonly now?: () => number;
  /** The one page allowed to frame this wallet. Injected so a test can frame it. */
  readonly embedder?: string | null;
}): ReactNode {
  /*
   * **EVERY PRESS THAT SENDS SOMETHING IS GATED ON WHAT CAN BE SEEN.** In a
   * window of its own this is always yes. In a frame it is the visibility guard:
   * a press on a wallet shown too small, on a hidden tab, or on a request that
   * has only just appeared is refused, on the button, with the reason beside it. What is measured is the
   * frame's size, whether the tab is showing, and how long this request has been
   * on screen; what is NOT measured is anything the page around draws over the
   * frame, fades it with, or moves it by - `framing.ts` says why. A disabled
   * button fires no press in React, by click or by key.
   */
  const framing = useMemo(
    () => framingOf(view ?? (window as unknown as ChannelWindow), embedder), [view, embedder]);
  const [channelState, setChannelState] = useState<ChannelState>({ of: 'waiting' });
  const [channel, setChannel] = useState<Channel | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [subwallet, setSubwallet] = useState<number>(() => loadSubwallets(secret).lastUsed);
  /**
   * **WHETHER THE PERSON HAS TOUCHED THE PICKER.**
   *
   * The offered wallet is a DEFAULT, and a default that overwrites a deliberate
   * choice is not one. This is the only thing that stops the effect below
   * putting the fresh slot back after somebody has picked a used one on
   * purpose — which the scope says they are entitled to do.
   */
  const [choseWallet, setChoseWallet] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  /**
   * **A DERIVED ROW IS DECLINED HERE AND NOT IN `picked`.**
   *
   * `picked` maps an attribute to the id of a `Held` record, and a derived
   * value has none: there is nothing held. Putting a sentinel id in there would
   * be a value that looks like a record id and is not one, which is exactly the
   * shape every owner-line rule in this project is about. So the two questions
   * are two states — *which held value* and *is this computed one refused* —
   * and neither can be mistaken for the other.
   */
  const [refused, setRefused] = useState<Record<string, true>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  /** This wallet, by the fingerprint of the secret that is answering - not by the slot it sits in. */
  const thisWallet = useMemo(() => toBase64Url(fingerprintOf(secret)), [secret]);

  useEffect(() => {
    const target = view ?? (window as unknown as ChannelWindow);
    const opened2 = listen(target, now, setChannelState, embedder);
    setChannel(opened2);
    return () => opened2.stop();
  }, [view, now, embedder]);

  useEffect(() => {
    let alive = true;
    void load(port, identity).then((state) => {
      if (!alive) return;
      setOpened(state);
      setProfile(state.of === 'profile' ? state.profile : emptyProfile(now()));
    });
    return () => { alive = false; };
  }, [identity, port, now]);

  const request: Ask | null = channelState.of === 'request' ? channelState.request : null;
  /* The dwell is timed from the moment THIS request is on screen, not from when
   * the screen mounted: a page that holds its request back until the wait has
   * run out would otherwise put a pressable button up the instant it arrives. */
  const consent = useConsent(framing, request);
  /* A SIGN-IN HAS NO ROWS BECAUSE ITS TYPE HAS NO `wants`, not because this
   * filtered an empty list out of one. `request.ts` is where that is decided.
   *
   * **AND A JOIN HAS ROWS FOR THE SAME REASON, WHICH IS WHY THIS IS NOW
   * A TEST ON THE TYPE AND NOT ON ONE KIND'S NAME.** `Wanting` is the two kinds
   * that carry `wants`; everything below reads this and not `request.kind`, so
   * a join walks the disclosure's own path through the rows, the pre-tick, the
   * missing-required line and the render rather than a copy of it. */
  const wanting: Wanting | null = request !== null
    && (request.kind === 'disclosure' || request.kind === 'join') ? request : null;
  /**
   * **THE CHOSEN WALLET, AS ONE VALUE, DERIVED ONCE PER CHOICE.**
   *
   * Every derived row on this screen comes out of this object, so changing the
   * picker changes every address shown and every address sent, together. There
   * is no path where the row says one slot and the signature names another.
   */
  const owned = useMemo(
    () => ownedAddressFor(identity, subwallet, loadSubwallets(secret).names, NETWORK),
    [identity, subwallet, secret]);

  const rows = useMemo(
    () => (wanting === null || profile === null
      ? [] : rowsFor(wanting, registry, profile, owned)),
    [wanting, profile, registry, owned]);

  /**
   * **THE WALLET THIS SCREEN OPENS ON, AND THE WHOLE RULE.**
   * `../accounts/slot-choice.ts` decides it; this is only where it is applied.
   *
   * It runs when the ask and the profile are both here, because the answer
   * depends on WHO is asking — a company that already has a slot keeps it, and
   * anybody new is offered one no site has used. **It never runs again once the
   * person has touched the picker**, which is what makes it a default rather
   * than a refusal.
   */
  useEffect(() => {
    if (choseWallet || request === null || profile === null) return;
    setSubwallet(chooseSlot(profile, request.requester.origin).account);
  }, [choseWallet, request, profile]);

  /* A REMEMBERED GRANT PRE-TICKS AND NEVER SKIPS. §6. */
  useEffect(() => {
    if (wanting === null || request === null || profile === null) return;
    const grant = profile.grants.find(
      (g) => g.recipient.origin === request.requester.origin && g.subwallet === subwallet);
    if (!grant) return;
    const pre: Record<string, string> = {};
    for (const row of rows) {
      const match = row.options.find((held) => grant.values.includes(held.id));
      if (match) pre[row.attribute] = match.id;
    }
    setPicked((current) => ({ ...pre, ...current }));
  }, [wanting, request, profile, subwallet, rows]);

  const fill = useCallback((definition: AttributeDefinition, text: string): void => {
    if (profile === null) return;
    const outcome = check(definition, text);
    if (!outcome.ok) { setProblem(outcome.says); return; }
    try {
      const next = selfAssert(profile, registry, definition.name, text, '', now());
      const added = next.held[next.held.length - 1]!;
      setProfile(next);
      setPicked((current) => ({ ...current, [definition.name]: added.id }));
      setTyped((current) => ({ ...current, [definition.name]: '' }));
      setProblem(null);
      void save(port, identity, next).catch(() => setProblem('That could not be saved.'));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That could not be added.');
    }
  }, [profile, registry, port, identity, now]);

  /*
   * A derived row is missing when it was refused or could not be worked
   * out, and never because nothing was picked: there is no list to pick from.
   */
  const missingRequired = rows.filter((row) => row.required && (
    row.derived !== null
      ? !(row.derived.ok && refused[row.attribute] !== true)
      : picked[row.attribute] === undefined));

  const approve = useCallback((): void => {
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
     * the press on its own screen (`approve-balance.tsx`). */
    if (request.kind === 'balance') return;
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
          asserted: { by: 'wallet' },
        });
        continue;
      }
      const id = picked[row.attribute];
      const held = id === undefined ? undefined : profile.held.find((h) => h.id === id);
      if (held === undefined) { declined.push(row.attribute); continue; }
      disclosed.push({
        id: held.id, about: held.about, says: held.says, asserted: held.asserted,
      });
    }
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
      requesterSaidItWas: { name: request.requester.name, rdns: request.requester.rdns },
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
      outgoing = request.kind === 'join'
        ? sealToInbox(JSON.stringify(response), request.inboxPublicKey)
        : response;
    } catch (e) {
      setProblem(e instanceof Error
        ? `${e.message} Nothing has been sent.`
        : 'That could not be sealed, so nothing has been sent.');
      return;
    }
    channel.answer(outgoing);
    /* THIS WALLET ANSWERED THAT PAGE'S SIGN-IN, so a company's key it asks for
     * next is given by this wallet and by no other held here. The answer has gone
     * whether or not this can be written, so a failure is said, not thrown. */
    let noted = true;
    if (request.kind === 'sign-in') {
      try { rememberSignIn(port, request.requester.origin, thisWallet); } catch { noted = false; }
    }

    const recipient: Recipient = {
      origin: request.requester.origin,
      name: request.requester.name,
      rdns: request.requester.rdns,
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
    const grantedIds = disclosed
      .filter((s) => s.asserted.by !== 'wallet').map((s) => s.id);
    let next = request.kind === 'sign-in'
      ? profile
      : grantTo(profile, recipient, subwallet, grantedIds, at);
    /* THE HISTORY RECORDS CONTENT, NOT POINTERS. §3.2b. */
    next = recordDisclosure(next, recipient, subwallet, {
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
        scheme: response.scheme,
      },
    }, at);
    setProfile(next);
    setSentAt(at);
    if (!noted) {
      setProblem('It was sent, and this wallet could not note that it answered this sign-in. Until a '
        + 'later sign-in to that page is noted, this browser\'s note of which wallet answered it may be '
        + 'out of date: another wallet here may be let give that page a company\'s key, and this one '
        + 'may be refused.');
    }
    void save(port, identity, next).catch(
      () => setProblem('It was sent, and this wallet could not write down that it was.'));
  }, [request, profile, channel, rows, picked, refused, subwallet, identity, port, now, thisWallet]);

  /**
   * **THE RELEASE. A SEPARATE FUNCTION, NOT A BRANCH INSIDE `approve`.**
   *
   * `approve` mints and sends a `DisclosurePayload`; this sends a key. Sharing
   * a body would mean one function whose most dangerous line is behind an
   * `if`, and the finding was a sign-in falling through a disclosure's
   * `grantTo` and erasing a person's grant. **A release touches no grant, mints
   * nothing, and signs nothing.**
   */
  const release = useCallback((): void => {
    if (request === null || request.kind !== 'unlock' || profile === null
      || channel === null) return;
    const at = now();
    /* The origin is read off the PARSED ask, which the parser put there from
     * `MessageEvent.origin`. `releaseFor` takes the ask rather than a string,
     * so there is no argument here an attacker-supplied origin could reach.
     * The indexer this wallet reads the chain through goes with it: two public
     * addresses, so the page can read its company's contract where this wallet
     * reads its own balance, rather than through the page's own service.
     * And every receiving address this wallet holds, which leave as digests
     * under the page's own nonce and never as addresses: the page can test
     * only an address it already has. */
    channel.answer(releaseFor(identity, request, at,
      { indexerUri: INDEXER_HTTP_URL, indexerWsUri: INDEXER_WS_URL },
      receivingAddressesOf(identity, NETWORK)));

    /* WHAT IS WRITTEN DOWN: that a key went, to whom, and when. **The key is
     * not in this call and there is no field on `Release` to put it in.** */
    const next = recordRelease(profile, {
      at,
      nonce: request.nonce,
      recipient: {
        origin: request.requester.origin,
        name: request.requester.name,
        rdns: request.requester.rdns,
      },
      /* WHICH COMPANY, so a later ask for the same one from a different
       * host can be shown as such. **Read to warn, never read into a key.** */
      company: request.company,
    }, at);
    setProfile(next);
    setSentAt(at);
    void save(port, identity, next).catch(
      () => setProblem('The key was given, and this wallet could not write down that it was.'));
  }, [request, profile, channel, identity, port, now]);

  /**
   * **WHICH OF THIS WALLET'S OWN ACCOUNTS HAS THE ADDRESS A KEYRING ASK SAYS THE
   * PAGE SIGNED IN AS**, or null when none does or none is named. Worked out from
   * this wallet's own keys, for every account it offers, and compared whole.
   */
  const addressesHeld = useMemo((): ReadonlyMap<string, number> => {
    const held = new Map<string, number>();
    if (request === null || request.kind !== 'keyring' || request.signedInAs === null) return held;
    for (const account of WALLET_ACCOUNTS) {
      try { held.set(unshieldedAddressFor(identity, account), account); } catch { /* not an address this wallet can show */ }
    }
    return held;
  }, [request, identity]);

  /**
   * **THE KEYRING RELEASE. ITS OWN FUNCTION, FOR `release`'S REASON.**
   *
   * The gate is inside `keyringReleaseFor`: when the ask names the address the
   * page signed in as and no account of this wallet has it, nothing is built
   * and nothing is sent, whatever state the button is in.
   */
  const releaseKeyring = useCallback((): void => {
    if (request === null || request.kind !== 'keyring' || profile === null
      || channel === null) return;
    const at = now();
    /* With no address named, this browser's note of which wallet answered that
     * page's last sign-in is the only gate there is, and it is checked here as
     * well as on the button. */
    if (request.signedInAs === null) {
      const refused = whyNotThisWallet(port, request.requester.origin, thisWallet);
      if (refused !== null) { setProblem(`${refused} No key has been given.`); return; }
    }
    let answer;
    try {
      answer = keyringReleaseFor(identity, request, at, (address) => addressesHeld.has(address));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Nothing has been given.');
      return;
    }
    channel.answer(answer);
    setSentAt(at);
    /* A company's key given in the same answer is written down as any company's
     * key is, so a later ask for it from a different host is shown as such. The
     * keyring key has no company, and nothing about it is written down. */
    if (request.company === null) return;
    const next = recordRelease(profile, {
      at,
      nonce: request.nonce,
      recipient: {
        origin: request.requester.origin,
        name: request.requester.name,
        rdns: request.requester.rdns,
      },
      company: request.company,
    }, at);
    setProfile(next);
    void save(port, identity, next).catch(
      () => setProblem('The key was given, and this wallet could not write down that it was.'));
  }, [request, profile, channel, identity, port, now, addressesHeld, thisWallet]);

  /*
   * ── THE THREE STATES THAT DO NOT KNOW WHICH KIND OF ASK THIS IS ──────────
   *
   * **FOUND BY LOOKING AT THE PICTURE, NOT BY READING THE CODE.** The first
   * walk photographed a refused SIGN-IN under the heading *Share your details*,
   * because the heading was written when there was only one kind of ask and a
   * refused request has no parsed kind to read. The screen was naming one of
   * two kinds and had a even chance of naming the wrong one — a heading
   * asserting something nobody checked, which is this project's oldest class.
   *
   * So these three say the thing that is true in ALL of them and name no kind.
   */
  /* **ONLY THIS WALLET'S OWN RECORD REACHES THIS.** Another wallet's details in
   * this browser are kept under their own name and never stop this one answering. */
  if (opened?.of === 'unopenable') {
    const saying = sayingForUnopenable(opened);
    return (
      <>
        <h1>Nothing has been shared</h1>
        <Alert tone={saying.tone} title={saying.title}>
          <p className="m-0" data-unopenable-why>{saying.sentence}</p>
          <p className="m-0">Nothing has been sent and nothing has been changed.</p>
        </Alert>
      </>
    );
  }

  if (channelState.of === 'refused') {
    return (
      <>
        <h1>Nothing has been shared</h1>
        <Alert tone="danger" title="This request was refused before you saw it">
          <p className="m-0">{channelState.error.message}</p>
        </Alert>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>← Your wallet</a></p>
      </>
    );
  }

  if (request === null) {
    /*
     * **TWO WAYS TO BE HERE WITH NOTHING TO SHOW, AND THEY ARE NOT THE SAME
     * SCREEN.**
     *
     * The requester now opens this window **while it is still handling the
     * person's click** — before it has asked its own server for a nonce —
     * because a browser only grants that permission for the length of a press,
     * and both paths used to spend it on a round trip first. Chromium forgave
     * that; Safari and Firefox refuse it outright.
     *
     * So this window is now routinely open for a moment with the ask still in
     * flight, and *Nothing is asking* would be a wallet telling somebody the
     * press they just made did nothing. **`window.opener` is what tells the two
     * apart, and the browser fills it in** — the same property `channel.ts`
     * already refuses messages on, read the other way. A page cannot set it on
     * a window it did not open, so it cannot make this wallet claim to be
     * waiting for it.
     *
     * It says nothing about WHO is asking, because at this moment this wallet
     * does not know: the origin is observed on the first message and not
     * before. A screen that named the requester here would be naming a guess.
     */
    const here = view ?? (window as unknown as ChannelWindow);
    /* **OR THE PAGE THIS WALLET WAS BUILT TO SIT INSIDE.** A frame has no
     * `opener`, so without this a framed wallet said *Nothing is asking* under
     * a live request. Only the ALLOWED embedder counts: a stranger's frame is
     * refused before this screen renders at all. */
    if (here.opener || framing.of === 'framed') {
      return (
        <>
          <h1 data-waiting-for-ask>Waiting for the request</h1>
          <p className="lede">
            The application that opened this window is still preparing what it wants to
            ask. Nothing has been sent and nothing has been signed.
          </p>
          <p className="m-0 text-sm text-muted">
            When it arrives, this wallet will tell you where the page actually came
            from — and nothing leaves here until you press something.
          </p>
          <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>← Your wallet</a></p>
        </>
      );
    }
    return (
      <>
        <h1>Nothing is asking</h1>
        <p className="lede">
          Nothing is asking for anything. This screen appears when an application opens
          your wallet to sign you in, or to ask for details about you — it will name
          itself, and this wallet will tell you where it actually came from.
        </p>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>← Your wallet</a></p>
      </>
    );
  }

  if (sentAt !== null && request.kind === 'unlock') {
    return (
      <>
        <h1>They have the key</h1>
        {/* The sentence shown afterwards was written in the asker's
          * own words too. It names what was OBSERVED and what was OPENED.
          *
          * **and the company is named by its fingerprint rather than
          * by sixty-four characters of hex threaded through the middle of a
          * sentence**, which is how the picture of this screen read. The full
          * address is still here, underneath, on a line of its own where it can
          * wrap without breaking a sentence in half. */}
        <div data-key-given>
          <p className="lede m-0">
            {`On ${dateOf(sentAt)} you gave `}
            <span className="font-mono break-all">{request.requester.origin}</span>
            {' the key to the records company '}
            <span className="font-mono tracking-wide" data-given-fingerprint>
              {companyFingerprint(request.company)}
            </span>
            {' keeps for you.'}
          </p>
          <p className="m-0 text-sm text-muted" style={{ marginTop: '0.5rem' }}>
            That company’s address in full
          </p>
          <p className="m-0 font-mono break-all text-sm text-muted">{request.company}</p>
        </div>
        {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. And here it binds hardest:
          * a disclosure hands over a fact somebody already knew about
          * themselves; this hands over the ability to read. */}
        <Alert tone="info" role={null} title="What they can do now">
          <p className="m-0">
            {`${request.requester.origin} can open those records from now on, and this `}
            wallet cannot see them doing it. You can refuse the next time they ask. Nothing
            takes back a key that has gone.
          </p>
        </Alert>
        {problem !== null && <Alert tone="warning" title="One thing did not save">{problem}</Alert>}
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('profile')}>My profile</a></p>
      </>
    );
  }

  if (sentAt !== null && request.kind === 'keyring') {
    return (
      <>
        <h1>They have the key</h1>
        <div data-keyring-given>
          <p className="lede m-0">
            {`On ${dateOf(sentAt)} you gave `}
            <span className="font-mono break-all">{request.requester.origin}</span>
            {' the key to the keys this wallet saved under the account name it gave'}
            {request.company !== null ? ', and the key to the records one company keeps for you.' : '.'}
          </p>
        </div>
        <Alert tone="info" role={null} title="What they can do now">
          <p className="m-0">
            {`${request.requester.origin} can use the keys this wallet saved under that account name from now on - `}
            for every company that account belongs to - and this wallet cannot see them doing
            it. You can refuse the next time they ask. Nothing takes back a key that has gone.
          </p>
        </Alert>
        {problem !== null && <Alert tone="warning" title="One thing did not save">{problem}</Alert>}
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('profile')}>My profile</a></p>
      </>
    );
  }

  if (sentAt !== null && request.kind === 'sign-in') {
    return (
      <>
        {/* **THIS WALLET SAYS WHAT IT DID, NOT WHAT IT ACHIEVED.**
          *
          * It read `Signed in`, and on the first walk-through of the two
          * applications that heading was on the screen while the payroll tab
          * was refusing the answer it had just been handed. **The wallet was
          * telling the truth about itself and the words were about somebody
          * else's outcome** — one it does not observe and cannot: the answer
          * crosses a channel to a different origin, which verifies it and may
          * refuse it.
          *
          * So the heading names the ACT and the SITE it was done for. The
          * alternative — the requester telling the wallet how it went, and the
          * wallet waiting to say anything until it knows — is a protocol
          * change, and it is not this. */}
        <h1 data-signed-in-heading>
          {'You signed in to '}
          <span className="font-mono break-all">{request.requester.origin}</span>
        </h1>
        {/* The sentence afterwards names what was OBSERVED. It used to
          * name what the page called itself, which is the one field on the ask
          * the asker chose. */}
        <p className="lede" data-signed-in>
          {`On ${dateOf(sentAt)} you signed in to `}
          <span className="font-mono break-all">{request.requester.origin}</span>
          {` as ${displayNameOf(subwallet, loadSubwallets(secret).names)}.`}
        </p>
        {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. */}
        <Alert tone="info" role={null} title="What they know now">
          <p className="m-0">
            {`${request.requester.origin} now holds a signed statement that the owner of `}
            this wallet address was here. You can stop signing in to them. Nothing can take
            back what has gone.
          </p>
        </Alert>
        {problem !== null && <Alert tone="warning" title="One thing did not save">{problem}</Alert>}
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('profile')}>My profile</a></p>
      </>
    );
  }

  if (sentAt !== null && request.kind === 'join') {
    return (
      <>
        {/* **THIS WALLET SAYS WHAT IT DID, NOT WHAT IT ACHIEVED.**
          * It accepted and it sealed. Whether the company can pay anybody is
          * an outcome on a machine this wallet does not observe, and a heading
          * that claimed it would be the sentence it was written for. */}
        <h1 data-accepted-heading>
          {'You accepted the invitation from '}
          <span className="font-mono break-all">{request.requester.origin}</span>
        </h1>
        <p className="lede" data-accepted>
          {`On ${dateOf(sentAt)} you sent what you approved to `}
          <span className="font-mono break-all">{request.requester.origin}</span>
          {', sealed so that only whoever holds the key below can read it.'}
        </p>
        <p className="m-0 text-sm text-muted" style={{ marginTop: '0.5rem' }}>
          The key it was sealed to, in full
        </p>
        <p className="m-0 font-mono break-all text-sm text-muted" data-sealed-to>
          {request.inboxPublicKey}
        </p>
        {/* §6 -- NO REVOCATION LANGUAGE, ANYWHERE. And the honest half of the
          * seal: it decides WHO CAN READ, and it decides nothing at all about
          * what a reader does next. */}
        <Alert tone="info" role={null} title="What is sent, is sent">
          <p className="m-0">
            Whoever holds that key keeps their own copy of what you just sent, which is
            normally what you want &mdash; it is how they pay you. Sealing it decided who
            could read it on the way, and nothing more. You can stop sending them anything
            new. Nothing can take back what has gone.
          </p>
        </Alert>
        {problem !== null && <Alert tone="warning" title="One thing did not save">{problem}</Alert>}
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('profile')}>My profile</a></p>
      </>
    );
  }

  if (sentAt !== null) {
    return (
      <>
        <h1>Sent</h1>
        {/* Observed, not claimed. */}
        <p className="lede" data-details-sent>
          {`On ${dateOf(sentAt)} you sent details to `}
          <span className="font-mono break-all">{request.requester.origin}</span>
          {'.'}
        </p>
        {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. */}
        <Alert tone="info" role={null} title="What is sent, is sent">
          <p className="m-0">
            {request.requester.origin} keeps their own copy of what you just sent, which is
            normally what you want — it is how they pay you. You can stop sending them
            anything new. Nothing can take back what has gone.
          </p>
        </Alert>
        {problem !== null && <Alert tone="warning" title="One thing did not save">{problem}</Alert>}
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('profile')}>My profile</a></p>
      </>
    );
  }

  const names = loadSubwallets(secret).names;

  /*
   * WHO IS ASKING, AND WHERE THEY ACTUALLY CAME FROM. §5.3.
   * The name is what they call themselves. The origin is what the browser
   * saw, and the two are labelled differently on purpose — a name that
   * stood in for an identity is the owner-line rule.
   *
   * **ONE ELEMENT, RENDERED BY BOTH KINDS.** Two copies of this card
   * would be two places for the observed origin to stop being shown, and only
   * one of them would be the one a test happened to open.
   */
  const whoIsAsking = (
    <Card>
      <CardHeader><CardTitle>Who is asking</CardTitle></CardHeader>
      <CardContent>
        <p className="m-0">
          {'They call themselves '}
          <strong className={CLAIM_TEXT} data-requester-name>{request.requester.name}</strong>.
        </p>
        <p className="m-0">
          {'This page actually came from '}
          <strong className="font-mono" data-requester-origin>
            {request.requester.origin}
          </strong>
          {'. Your browser told this wallet that, not the request — anything that could '}
          name its own address could name somebody else&rsquo;s.
        </p>
        <p className="m-0 text-sm text-muted" data-purpose>
          {`Why they say they want it: ${request.purpose}`}
        </p>
      </CardContent>
    </Card>
  );

  /*
   * **BOTH KINDS ARE SIGNED BY A WALLET AND THE PERSON CHOOSES WHICH.** The
   * picker is one element rendered by both branches rather than two that have
   * to be kept saying the same thing; the sentence under it differs because
   * what the wallet is FOR differs, and that sentence is the only difference.
   */
  /*
   * **WHICH WALLET IS OFFERED, AND WHO ELSE ALREADY HAS IT.**
   *
   * Two sentences, and they are two different facts. The first says WHY this
   * one is proposed. The second appears only when the wallet in the box is one
   * another site already has, and it is the whole of what the rule asked for:
   * **an inconsistent warning teaches people that silence means it is fine**,
   * so this one says exactly what sharing costs and does not editorialise. It
   * never refuses — reusing an address costs linkability, and linkability is
   * the person's to spend.
   */
  const choice = profile === null
    ? null : chooseSlot(profile, request.requester.origin);
  const shared = profile === null
    ? [] : alsoUsedBy(profile, subwallet, request.requester.origin);

  const whyThisWallet = (): string => {
    if (choseWallet || choice === null) return '';
    if (choice.because === 'already-theirs') {
      return 'This is the wallet you used with them before, so what they already hold goes '
        + 'on working.';
    }
    if (choice.because === 'unused') {
      return 'This one has not been given to anybody, which is why it is the one offered.';
    }
    return 'Every wallet here has already been given to somebody, so whichever you choose '
      + 'is one another site can recognise.';
  };

  const whichWallet = (title: string, description: string): ReactNode => (
    <Section title={title} description={description}>
      <Label htmlFor="approve-subwallet">Wallet</Label>
      <select
        id="approve-subwallet"
        value={String(subwallet)}
        onChange={(e) => { setChoseWallet(true); setSubwallet(Number(e.target.value)); }}
        className="block w-full rounded-tight border border-line-strong bg-bg px-3 py-2 text-base text-ink"
      >
        {WALLET_ACCOUNTS.map((account) => (
          <option key={account} value={String(account)}>
            {displayNameOf(account, names)}
          </option>
        ))}
      </select>
      <p className="m-0 font-mono text-sm text-muted" data-address>
        {unshieldedAddressFor(identity, subwallet)}
      </p>
      {whyThisWallet() !== '' && (
        <p className="m-0 text-sm text-muted" data-why-wallet={choice?.because}>
          {whyThisWallet()}
        </p>
      )}
      {shared.length > 0 && (
        <Alert tone="warning" title="Another site already has this wallet's address">
          <div data-wallet-shared>
            {/* EACH ONE ON ITS OWN LINE — the same rule as the unlock screen's
              * warning, and for the same reason: a value a person is being
              * asked to recognise, wrapped mid-string, is unreadable. */}
            {shared.map((origin) => (
              <p className="m-0 font-mono text-ink" key={origin}>{origin}</p>
            ))}
          </div>
          <p className="m-0">
            If you use this wallet here too, both of them are paying the same address, and
            they could learn you work for both by comparing notes. That is sometimes exactly
            what you want. Choosing a different wallet above is what keeps them apart — and
            it keeps them apart from each other, not from us: it is one wallet signing in
            either way.
          </p>
        </Alert>
      )}
    </Section>
  );

  if (request.kind === 'balance') {
    return (
      <ApproveBalance
        request={request}
        identity={identity}
        account={subwallet}
        channel={channel}
        consent={consent}
        whoIsAsking={whoIsAsking}
        whichWallet={whichWallet(
          'Which of your wallets pays',
          'The coins come from this wallet, and only from it.')}
        onDecline={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
      />
    );
  }

  if (request.kind === 'unlock') {
    /*
     * **WHERE ELSE THIS COMPANY'S KEY HAS ALREADY GONE.**
     *
     * A convenience and never an ingredient: `originsFor` reads the history and
     * nothing reads it back into a key. **An empty list is not a refusal** — a
     * company legitimately moves host, and that is the whole reason the key
     * stopped depending on one. Losing every row costs this warning and cannot
     * cost access.
     */
    const elsewhere = originsFor(profile ?? emptyProfile(now()), request.company)
      .filter((origin) => origin !== request.requester.origin);
    /* Read at render, from this browser's own record of which wallet signed in to this page. */
    const notThisWallet = whyNotThisWallet(port, request.requester.origin, thisWallet);

    return (
      <>
        {/*
          * **THE HEADLINE IS BUILT FROM THE OBSERVED ORIGIN.** It used
          * to be built from `request.requester.name` — the one field on the
          * whole ask that the ASKER chose — which is how a page served from
          * `payroll-b.example` came to sit under a wallet headline reading
          * *"Let Payroll A open your records"*. The name is still shown, in the
          * card below, labelled as what they call themselves.
          */}
        <h1 data-headline>{`Let ${request.requester.origin} open a company’s records`}</h1>

        {/*
          * **THE TWO FACTS, TOGETHER, AND NEITHER SMALLER THAN A NAME.**
          * One of them your browser observed; the other the
          * page claims, and the screen says which is which rather than
          * presenting both as though the wallet checked them.
          */}
        <Section
          title="What is being opened, and who is asking"
          description="One of these your browser saw for itself. The other is what the page says."
        >
          <p className="m-0 text-sm text-muted">This page really came from</p>
          <p
            className={`m-0 font-mono break-all text-ink ${FACT_TEXT}`}
            data-observed-origin
          >
            {request.requester.origin}
          </p>
          <p className="m-0 text-sm text-muted" style={{ marginTop: '0.75rem' }}>
            The company whose records it wants to open, as the page names it
          </p>
          {/*
            * **THE THING A PERSON CAN ACTUALLY COMPARE.** This screen
            * asked somebody to recognise a company and then showed them
            * sixty-four characters of hex — the one instruction on the page a
            * person must follow being the one no person can. This is that same
            * address, rendered twenty characters wide; `profile/fingerprint.ts`
            * carries the arithmetic for the width and the reason it is not the
            * two digits `devices/pairing.ts` shows.
            */}
          <p
            className={`m-0 font-mono tracking-wide text-ink ${FINGERPRINT_TEXT}`}
            data-company-fingerprint
          >
            {companyFingerprint(request.company)}
          </p>
          <p className="m-0 text-sm text-muted">
            Those twenty characters stand for this company and are the same in every wallet,
            for ever. If somebody told you which company to expect — in the invitation you
            accepted, or by email or over the phone — that is what they can tell you, and
            this is where you check it. Compare all of it, not the ends.
          </p>
          <p className="m-0 text-sm text-muted" style={{ marginTop: '0.75rem' }}>
            The address it stands for, in full
          </p>
          <p className={`m-0 font-mono break-all text-ink ${FACT_TEXT}`} data-company>
            {request.company}
          </p>
          <p className="m-0 text-sm text-muted" style={{ marginTop: '0.75rem' }}>
            This wallet cannot check that those two belong together. It can only show you
            both. If you do not recognise the company, do not give the key.
          </p>
        </Section>

        {whoIsAsking}

        {elsewhere.length > 0 && (
          <Alert
            tone="warning"
            title="You have given this company’s key to a different page before"
          >
            {/* **EACH ADDRESS ON ITS OWN LINE.** Found by looking at the first
              * picture of this screen: inline, the previous host wrapped as
              * `https://payroll-a.exampl` / `e.` — a fact a person is being
              * asked to COMPARE, broken in the middle of itself. */}
            <div data-seen-elsewhere>
              {/* WHICH company, said in the form a person was told it
                * in. The warning named two origins and left the company itself
                * to be inferred from the section above. */}
              <p className="m-0">The company is</p>
              <p className="m-0 font-mono tracking-wide text-ink" data-warning-fingerprint>
                {companyFingerprint(request.company)}
              </p>
              <p className="m-0" style={{ marginTop: '0.5rem' }}>
                Before now, this company’s key has gone to
              </p>
              {elsewhere.map((origin) => (
                <p className="m-0 font-mono text-ink" key={origin}>{origin}</p>
              ))}
              <p className="m-0" style={{ marginTop: '0.5rem' }}>This page is</p>
              <p className="m-0 font-mono text-ink">{request.requester.origin}</p>
            </div>
            <p className="m-0">
              That can be perfectly ordinary — a company can move, or run its own copy of
              the same thing. It is shown because you are the only one who can tell the
              difference between that and somebody standing in the way.
            </p>
          </Alert>
        )}

        <Section
          title="What you are agreeing to"
          description="This is not a fact about you. It is the ability to read."
        >
          <p className="m-0 text-base text-ink" data-unlock-question>
            {`Do you want ${request.requester.origin} to be able to open the records this `}
            company keeps for you?
          </p>
          <p className="m-0 text-sm text-muted">
            {`From the moment you press the button, ${request.requester.origin} can open `}
            those records whenever their page is running. This wallet cannot watch it
            happen and cannot tell you afterwards how often it did.
          </p>
          <p className="m-0 text-sm text-muted" data-unlock-held-addresses>
            It also lets this page check whether a payslip was paid to one of your wallets. It
            does not tell the page any of your addresses.
          </p>
        </Section>

        <Section
          title="How long they have it"
          description="The honest answer, which is not “until you say stop”."
        >
          <p className="m-0 text-sm text-muted">
            Their page holds the key while it is open, and this wallet never stores it. But
            nothing stops them keeping their own copy, and nothing here could tell. Treat
            this as given for good.
          </p>
        </Section>

        {/*
          * SAID BECAUSE IT IS TRUE AND BECAUSE IT IS THE REASON THIS IS SAFE
          * ENOUGH TO DO AT ALL. One key per site, and the same key for ever —
          * which is also why a recovery gets the records back.
          */}
        <Section
          title="It does not matter which of this wallet's addresses you use, or which page asked"
          description="The key belongs to the company and to this wallet, not to this website."
        >
          <p className="m-0 text-sm text-muted" data-not-per-wallet>
            This is one key, for this company and no other: no other company can be opened
            with it, and no other key of yours opens theirs. It is the same key on every
            device you sign in on, the same key again if you ever have to rebuild this
            wallet from your recovery pieces, and — this is the part that matters — the
            same key if you one day open these records somewhere that is not this website
            at all. That last one is what stops these records being ours rather than yours.
            It is made from this wallet, though: another wallet held in this browser gives a
            different key for the same company.
          </p>
        </Section>

        {notThisWallet !== null && (
          <Alert tone="danger" title="Another wallet answered this page's last sign-in">
            <p className="m-0" data-not-this-wallet>{notThisWallet}</p>
            <p className="m-0">No key has been given.</p>
          </Alert>
        )}

        {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. */}
        <Alert tone="warning" role={null} title="What is given, is given">
          <p className="m-0">
            You can refuse the next time they ask. That is the whole of what stopping
            means: whoever is behind that page keeps everything they have already opened
            and anything they copied while it was open, and nothing can take back a key.
          </p>
        </Alert>

        <div className="flex flex-wrap gap-2">
          {/* THE BUTTON IS THE HEADLINE'S RULE AGAIN. The rule names the button
            * as well as the `<h1>`: a person who skims reads those two and
            * nothing else, so neither may be written in the asker's own words. */}
          {/* Disabled for a wallet that did not answer this page's last sign-in: a
            * disabled button fires no press in React, by click or by key, so this is
            * the gate and `release` has no second copy of it. */}
          <Button variant="primary" onClick={release} disabled={!consent.ok || notThisWallet !== null} data-approve data-unlock>
            {`Give ${request.requester.origin} the key`}
          </Button>
          <Button
            variant="ghost"
            data-decline
            onClick={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
          >
            Do not give a key
          </Button>
          <ConsentRefused consent={consent} />
        </div>
      </>
    );
  }

  if (request.kind === 'keyring') {
    const holder = request.signedInAs === null ? null : addressesHeld.get(request.signedInAs) ?? null;
    const notHeld = request.signedInAs !== null && holder === null;
    /* With no address named there is nothing to compare, and this browser's own
     * note of which wallet answered that page's last sign-in is what is left. */
    const notThisWallet = request.signedInAs === null
      ? whyNotThisWallet(port, request.requester.origin, thisWallet) : null;
    const elsewhere = request.company === null ? [] : originsFor(profile ?? emptyProfile(now()), request.company)
      .filter((origin) => origin !== request.requester.origin);
    return (
      <>
        {/* **THE HEADLINE IS BUILT FROM THE OBSERVED ORIGIN**, for the unlock's reason. */}
        <h1 data-headline>{`Let ${request.requester.origin} use the keys saved under the account name it gives`}</h1>

        <Section
          title="Who is asking, and who they say you are"
          description="One of these your browser saw for itself. The other is what the page says."
        >
          <p className="m-0 text-sm text-muted">This page really came from</p>
          <p className={`m-0 font-mono break-all text-ink ${FACT_TEXT}`} data-observed-origin>
            {request.requester.origin}
          </p>
          <p className="m-0 text-sm text-muted" style={{ marginTop: '0.75rem' }}>
            The wallet address the page says you signed in to it with
          </p>
          {request.signedInAs !== null ? (
            <>
              <p className={`m-0 font-mono break-all text-ink ${FACT_TEXT}`} data-signed-in-as>
                {request.signedInAs}
              </p>
              {holder !== null && (
                <p className="m-0 text-sm text-muted" data-signed-in-holder>
                  {`That is ${displayNameOf(holder, loadSubwallets(secret).names)}, in this wallet.`}
                </p>
              )}
            </>
          ) : (
            <p className="m-0 text-sm text-muted" data-signed-in-unknown>
              The page does not say. It may be a tab that did not sign you in itself, such as one
              you reloaded. Keys that are already saved there only open with the wallet that saved
              them; nothing new is saved from such a tab until it signs you in.
            </p>
          )}
          <p className="m-0 text-sm text-muted" style={{ marginTop: '0.75rem' }}>
            The account name the page gives you there
          </p>
          <p className={`m-0 font-mono break-all text-ink ${FACT_TEXT}`} data-keyring-person>
            {request.person}
          </p>
          <p className="m-0 text-sm text-muted" data-keyring-person-unchecked>
            The key is made from this wallet and that name. Any page can give any name, and this
            wallet cannot check that it is yours - only show it to you.
          </p>
        </Section>

        {request.company !== null && (
          <Section
            title="And the key to one company's records"
            description="Asked for in the same answer, so the page knows both came from one wallet."
          >
            <p className={`m-0 font-mono tracking-wide text-ink ${FINGERPRINT_TEXT}`} data-company-fingerprint>
              {companyFingerprint(request.company)}
            </p>
            <p className={`m-0 font-mono break-all text-ink ${FACT_TEXT}`} data-company>
              {request.company}
            </p>
            <p className="m-0 text-sm text-muted">
              That company&rsquo;s key is what your payslip key there is worked out from. This wallet
              cannot check that the company belongs to that page; it can only show you both.
            </p>
            <p className="m-0 text-sm text-muted" data-committee-key-given>
              The answer also carries the public half of the key you sit on that company&rsquo;s vault
              committee with, so the company can list it. The half that signs never leaves this wallet.
            </p>
          </Section>
        )}

        {whoIsAsking}

        {elsewhere.length > 0 && request.company !== null && (
          <Alert tone="warning" title="You have given this company’s key to a different page before">
            <div data-seen-elsewhere>
              <p className="m-0">The company is</p>
              <p className="m-0 font-mono tracking-wide text-ink">{companyFingerprint(request.company)}</p>
              <p className="m-0" style={{ marginTop: '0.5rem' }}>Before now, this company’s key has gone to</p>
              {elsewhere.map((origin) => (
                <p className="m-0 font-mono text-ink" key={origin}>{origin}</p>
              ))}
              <p className="m-0" style={{ marginTop: '0.5rem' }}>This page is</p>
              <p className="m-0 font-mono text-ink">{request.requester.origin}</p>
            </div>
          </Alert>
        )}

        {/* **NOT "THE ABILITY TO READ".** The keys saved for a person hold the
          * secrets they approve payments with, for every company they belong to
          * on that site, and the screen says so. */}
        <Section
          title="What you are agreeing to"
          description="This is more than reading. It is your vote on payments, for every company there."
        >
          <p className="m-0 text-base text-ink" data-keyring-question>
            {`Do you want ${request.requester.origin} to be able to use the keys this wallet saved under that account name?`}
          </p>
          <p className="m-0 text-sm text-muted" data-keyring-power>
            Those keys are how you open the records of, and approve payments for, every company you
            belong to on that site - not only one. From the moment you press the button, whoever runs
            that page can use them whenever it is open. This wallet cannot watch it happen and cannot
            tell you afterwards what was done.
          </p>
        </Section>

        <Section
          title="How long they have it"
          description="The honest answer, which is not “until you say stop”."
        >
          <p className="m-0 text-sm text-muted">
            Their page holds the key while it is open, and this wallet never stores it. But nothing
            stops them keeping their own copy, and nothing here could tell. Treat this as given for good.
          </p>
        </Section>

        <Section
          title="Which keys this opens"
          description="Made from this wallet and the account name above, not from the web address."
        >
          <p className="m-0 text-sm text-muted" data-keyring-whose>
            It opens whatever is saved under that account name by this wallet, wherever that is kept -
            which is why the page asking matters as much as the name. It is the same key on every
            device and again if you rebuild this wallet from its recovery pieces. Another wallet gives
            a different key, which opens nothing this one saved.
          </p>
        </Section>

        {notHeld && (
          <Alert tone="danger" title="None of this wallet's addresses is the one that page signed in with">
            <p className="m-0" data-not-signed-in-here>
              {`The page at ${request.requester.origin} says you signed in to it as an address no account in `}
              this wallet has, so this is not the wallet you signed in with. A key from this wallet would
              not open what the wallet you signed in with saved there, and anything saved under it could
              only ever be opened with this one. Open the wallet you signed in with.
            </p>
            <p className="m-0">No key has been given.</p>
          </Alert>
        )}

        {notThisWallet !== null && (
          <Alert tone="danger" title="Another wallet answered this page's last sign-in">
            <p className="m-0" data-not-this-wallet>{notThisWallet}</p>
            <p className="m-0">No key has been given.</p>
          </Alert>
        )}

        {problem !== null && (
          <Alert tone="danger" title="Nothing has been given">
            <p className="m-0" data-keyring-problem>{problem}</p>
          </Alert>
        )}

        <Alert tone="warning" role={null} title="What is given, is given">
          <p className="m-0">
            You can refuse the next time they ask. That is the whole of what stopping means: whoever is
            behind that page keeps everything they have already opened and anything they copied while it
            was open, and nothing can take back a key.
          </p>
        </Alert>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={releaseKeyring}
            disabled={!consent.ok || notHeld || notThisWallet !== null}
            data-approve
            data-keyring
          >
            {`Give ${request.requester.origin} the key`}
          </Button>
          <Button
            variant="ghost"
            data-decline
            onClick={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
          >
            Do not give a key
          </Button>
          <ConsentRefused consent={consent} />
        </div>
      </>
    );
  }

  if (request.kind === 'sign-in') {
    return (
      <>
        <h1>Sign in</h1>

        {whoIsAsking}

        {whichWallet(
          'Which wallet answers',
          'Signing in tells them this wallet’s address and proves you hold it. It is '
          + 'the same address they would pay, which is the point — but it is a fact about '
          + 'you and it does not come back.')}

        <Section
          title="What you are agreeing to"
          description="Nothing about you is sent. This is one question and one answer."
        >
          {/*
            * **THE QUESTION IS BUILT FROM THE OBSERVED ORIGIN.** This change
            * does to this screen what was done to unlock. It used to be built
            * from `request.requester.name` — the one field on the whole ask
            * that the ASKER chose — so a page served from `payroll-b.example`
            * calling itself *Payroll A* was asked about in the wallet's own
            * voice as *"Do you want Payroll A to know it is you?"*. The name is
            * still shown, in the card above, labelled as what they call
            * themselves.
            */}
          <p className="m-0 text-base text-ink" data-sign-in-question>
            {`Do you want ${request.requester.origin} to know it is you?`}
          </p>
          <p className="m-0 text-sm text-muted">
            There is nothing to tick here and nothing to choose. They asked to be told that
            the person in front of them owns this wallet, and pressing the button below is
            the whole of the answer.
          </p>
        </Section>

        {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. */}
        <Alert tone="warning" role={null} title="What they learn, they keep">
          <p className="m-0">
            {`${request.requester.origin} will keep a signed statement that you were here, `}
            and the address it was signed by. This wallet can stop signing you in to them
            later. Nothing can take back what has gone.
          </p>
        </Alert>

        <div className="flex flex-wrap gap-2">
          {/* THE BUTTON IS THE QUESTION'S RULE AGAIN. The rule names the button
            * as well as the headline: a person who skims reads those and
            * nothing else, so neither may be written in the asker's own words. */}
          <Button variant="primary" onClick={approve} disabled={!consent.ok} data-approve data-sign-in>
            {`Sign in to ${request.requester.origin}`}
          </Button>
          <Button
            variant="ghost"
            data-decline
            onClick={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
          >
            Do not sign in
          </Button>
          <ConsentRefused consent={consent} />
        </div>
      </>
    );
  }

  /*
   * **THE JOIN, NARROWED ONCE, HERE.** Everything below renders for both
   * kinds; this is the only handle on the field a join has and the disclosure
   * does not, and it exists so that the render reads `join !== null` rather
   * than re-testing `request.kind` in four places that could drift apart.
   */
  const join = request.kind === 'join' ? request : null;

  return (
    <>
      {/* OBSERVED, NOT CLAIMED, ON THE HEADING AS ON THE BUTTON. A
        * person who skims reads these two and nothing else, so neither may be
        * written in the asker's own words. The disclosure's heading names no
        * origin because it names no party at all; the join's does, because an
        * invitation is FROM somebody and the only party this wallet observed
        * is the page. */}
      {join === null
        ? <h1>Share your details</h1>
        : (
          <h1 data-join-heading>
            {'Accept the invitation from '}
            <span className="font-mono break-all">{request.requester.origin}</span>
          </h1>
        )}

      {whoIsAsking}

      {/*
        * **THE SEAL, SAID BEFORE THE LIST RATHER THAN AFTER IT.**
        *
        * It is not a reassurance and it is not decoration: it is the one fact
        * that makes the rows below different from the same rows on a
        * disclosure. What is approved here does not travel to the page that
        * asked; it travels THROUGH it, readable only by whoever holds this
        * key. **And this wallet cannot check whose key it is** -- the same
        * unchecked-claim shape once accepted for `company` on an unlock, and
        * said out loud there for the same reason.
        *
        * **THE KEY IS SHOWN WHOLE AND NOT AS A FINGERPRINT.** The twenty
        * characters exist so a person can COMPARE a value against one they
        * were told out of band, and nobody is told an inbox key out of band --
        * it is published by the company's software, not read down a phone. A
        * fingerprint here would be a comparison ritual with nothing to compare
        * against, which teaches that checking is theatre. The full value is
        * shown because it is what decides who can read the address, and a
        * thing that decides that is not the protocol's private business.
        */}
      {join !== null && (
        <Section
          title="Where what you send can be read"
          description="An invitation is answered in a sealed envelope. This is the key it is sealed to."
        >
          <p className="m-0 text-sm text-muted">
            What you approve below is sealed on this device before it leaves it. The page
            that asked carries it; only whoever holds this key can open it.
          </p>
          <p className="m-0 text-sm text-muted" style={{ marginTop: '0.75rem' }}>
            The key it will be sealed to, in full
          </p>
          <p
            className={`m-0 font-mono break-all text-ink ${FACT_TEXT}`}
            data-inbox-key
          >
            {join.inboxPublicKey}
          </p>
          <p className="m-0 text-sm text-muted">
            This wallet cannot check that this key belongs to the company you think you are
            joining. It can only show it to you. If you do not recognise who invited you,
            send nothing.
          </p>
        </Section>
      )}

      {whichWallet(
        join === null ? 'Which wallet is this about' : 'Which wallet you are joining as',
        join === null
          ? 'The details you send are signed by this wallet, so whoever receives them can '
            + 'check that the person telling them these facts is the person they are about '
            + 'to pay.'
          : 'What you send is signed by this wallet, so whoever opens it can check that the '
            + 'person telling them these facts is the person they are about to pay. It is '
            + 'also the wallet any address below is worked out from.')}

      <Section
        title="What they are asking for"
        description="Approve each one. Saying no to an optional detail is a normal answer and they are told which ones you declined."
      >
        {problem !== null && <Alert tone="danger" title="Not added">{problem}</Alert>}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row) => {
            const chosen = picked[row.attribute];
            /* An attribute this vocabulary does not know is SHOWN as unknown.
             * Dropping it would be a screen lying about what was asked; turning
             * it into an attribute would let a requester define one (§3.4). */
            if (row.definition === null) {
              return (
                <li
                  key={row.attribute}
                  data-row={row.attribute}
                  data-unknown
                  className="rounded-tight border border-line p-3"
                >
                  <p className="m-0">
                    {'They asked for '}
                    <strong className="font-mono">{row.attribute}</strong>
                    {row.required ? ' and marked it required.' : '.'}
                  </p>
                  <p className="m-0 text-sm text-muted">
                    This wallet does not hold anything of that kind, and it will not invent
                    it. Nothing will be sent for this.
                  </p>
                </li>
              );
            }
            const definition = row.definition;
            /*
             * **A DERIVED ROW: NO LIST, NO BOX, AND THE VALUE IN FULL.**
             *
             * There is nothing to pick between, because nothing is held, and
             * nothing to type into, because nothing anybody typed would change
             * the answer. What a person can do is see it, see which wallet it
             * came from, and say no — which is a normal answer here as it is
             * anywhere else on this screen.
             *
             * **IT IS SHOWN WHOLE.** `render.abbreviate` exists for a list of
             * held values with no room; this is one value, it is where money
             * will arrive, and a shortened address is one a person cannot
             * check. That rule is about what to do when there is no room, and
             * here there is.
             */
            if (row.derived !== null) {
              const derived = row.derived;
              return (
                <li
                  key={row.attribute}
                  data-row={row.attribute}
                  data-required={row.required ? 'yes' : 'no'}
                  data-sensitivity={definition.sensitivity}
                  data-derived
                  className="rounded-tight border border-line p-3"
                >
                  <p className="m-0 text-base text-ink">
                    {definition.render.label}
                    <span className="text-sm text-muted">
                      {row.required ? ' — they require this' : ' — optional'}
                    </span>
                  </p>
                  {row.reason !== undefined && (
                    <p className="m-0 text-sm text-muted" data-reason>
                      {`They say: ${row.reason}`}
                    </p>
                  )}
                  {derived.ok ? (
                    <div className="flex flex-col gap-1">
                      <label
                        className="flex items-baseline gap-2 text-sm"
                        data-option="derived"
                      >
                        <input
                          type="radio"
                          name={`pick-${row.attribute}`}
                          checked={refused[row.attribute] !== true}
                          onChange={() => setRefused((c) => {
                            const next = { ...c };
                            delete next[row.attribute];
                            return next;
                          })}
                        />
                        <span className="font-mono break-all" data-derived-value>
                          {derived.value}
                        </span>
                      </label>
                      {/* §3.1's rule, extended by the arm it needed: self and
                        * issued never look alike, and neither of them looks
                        * like a value nobody stated at all. */}
                      <p className="m-0 text-sm text-muted" data-provenance="wallet">
                        {`This wallet worked it out from ${owned.owner}. Nobody typed it, `}
                        and choosing a different wallet above changes it.
                      </p>
                      {/*
                        * **THE CODE FOR THE ADDRESS ABOVE.**
                        *
                        * The address itself is sealed on this device and the
                        * page that asked never sees it, which is the property
                        * it bought — so the person on the other end has no
                        * way to tell that the address they received is the one
                        * this wallet showed. **This is that way.** It is a
                        * rendering of the value on the line above and of
                        * nothing else, so their machine computes the same
                        * twenty characters from what arrives.
                        *
                        * It moves when the wallet picker moves, because it is
                        * computed from `derived.value` — the same object the
                        * radio above sends. There is no path where the code
                        * says one wallet and the disclosure carries another.
                        */}
                      {row.code !== null && refused[row.attribute] !== true && (
                        <div
                          className="mt-1 rounded-tight border border-line p-3"
                          data-confirmation
                        >
                          <p className="m-0 text-sm text-muted">
                            The code for this address
                          </p>
                          <p
                            className={`m-0 font-mono ${FINGERPRINT_TEXT} text-ink`}
                            data-confirmation-code
                          >
                            {row.code}
                          </p>
                          <p className="m-0 text-sm text-muted">
                            Copy this and paste it where you were asked for it. Whoever
                            receives your address works out the same code from what
                            reaches them, so the two are compared and a different address
                            does not match.
                          </p>
                          <CopyButton
                            text={row.code}
                            label="Copy the code"
                            copied="Copied the code"
                          />
                        </div>
                      )}
                      <label
                        className="flex items-baseline gap-2 text-sm"
                        data-option="none"
                      >
                        <input
                          type="radio"
                          name={`pick-${row.attribute}`}
                          checked={refused[row.attribute] === true}
                          onChange={() => setRefused((c) => ({ ...c, [row.attribute]: true }))}
                        />
                        <span>Do not send this</span>
                      </label>
                    </div>
                  ) : (
                    <p className="m-0 text-sm text-muted" data-derived-refused>
                      {derived.says}
                    </p>
                  )}
                </li>
              );
            }
            return (
              <li
                key={row.attribute}
                data-row={row.attribute}
                data-required={row.required ? 'yes' : 'no'}
                data-sensitivity={definition.sensitivity}
                className="rounded-tight border border-line p-3"
              >
                <p className="m-0 text-base text-ink">
                  {definition.render.label}
                  <span className="text-sm text-muted">
                    {row.required ? ' — they require this' : ' — optional'}
                  </span>
                </p>
                {row.reason !== undefined && (
                  <p className="m-0 text-sm text-muted" data-reason>
                    {`They say: ${row.reason}`}
                  </p>
                )}
                {row.options.length === 0 ? (
                  definition.selfAssertable ? (
                    <div className="flex flex-col gap-2" data-fill={row.attribute}>
                      <p className="m-0 text-sm text-muted">
                        You do not hold this yet. You can add it here, once, and it stays
                        for the next company that asks.
                      </p>
                      <Input
                        aria-label={`Add your ${definition.render.label.toLowerCase()}`}
                        value={typed[definition.name] ?? ''}
                        onChange={(e) => setTyped(
                          (c) => ({ ...c, [definition.name]: e.target.value }))}
                      />
                      <div>
                        <Button
                          size="sm"
                          onClick={() => fill(definition, typed[definition.name] ?? '')}
                        >
                          Add it
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="m-0 text-sm text-muted">
                      You hold nothing of this kind, and it is not something you can state
                      about yourself. Nothing will be sent for this.
                    </p>
                  )
                ) : (
                  <div className="flex flex-col gap-1">
                    {row.options.map((held) => (
                      <label
                        key={held.id}
                        className="flex items-baseline gap-2 text-sm"
                        data-option={held.id}
                      >
                        <input
                          type="radio"
                          name={`pick-${row.attribute}`}
                          checked={chosen === held.id}
                          onChange={() => setPicked((c) => ({ ...c, [row.attribute]: held.id }))}
                        />
                        <span>
                          {held.says.of === 'value'
                            ? abbreviate(definition, held.says.value)
                            : `${held.says.predicate}: ${held.says.result ? 'yes' : 'no'}`}
                          {held.label !== '' && ` (${held.label})`}
                        </span>
                        {/* §3.1 — self and issued NEVER look alike, and an
                          * issued record never appears without its date. */}
                        {held.asserted.by === 'issuer' ? (
                          <span className="text-good" data-provenance="issuer">
                            {`checked by ${held.asserted.issuer} on `}
                            {dateOf(held.asserted.issuedAt)}
                          </span>
                        ) : (
                          <span className="text-muted" data-provenance="self">
                            you typed this; nobody has checked it
                          </span>
                        )}
                      </label>
                    ))}
                    <label className="flex items-baseline gap-2 text-sm" data-option="none">
                      <input
                        type="radio"
                        name={`pick-${row.attribute}`}
                        checked={chosen === undefined}
                        onChange={() => setPicked((c) => {
                          const next = { ...c };
                          delete next[row.attribute];
                          return next;
                        })}
                      />
                      <span>Do not send this</span>
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      {/* SAID ONCE, BEFORE, AND IT IS NOT DECORATION. §6.
        *
        * **THE JOIN'S SENTENCE IS THE SAME WARNING AND A DIFFERENT
        * PARTY.** On a disclosure the keeper is the page. On a join it is
        * whoever holds the inbox key, who may not be the page, and naming the
        * page would be this wallet telling somebody the wrong thing about who
        * ends up holding their address. **Sealing is not a smaller warning** --
        * it decides who can read on the way and nothing about what a reader
        * keeps -- so the second half of the sentence does not soften. */}
      <Alert tone="warning" role={null} title="What is sent, is sent">
        {join === null ? (
          <p className="m-0">
            {`${request.requester.origin} will keep their own copy of whatever you send. `}
            This wallet can stop sending them anything new later. Nothing can take back
            what has gone.
          </p>
        ) : (
          <p className="m-0" data-join-warning>
            Whoever holds that key will keep their own copy of whatever you send. Sealing
            it decides who can read it on the way and nothing about what they do with it
            afterwards. This wallet can stop sending them anything new later. Nothing can
            take back what has gone.
          </p>
        )}
      </Alert>

      {/*
        * **A DECLINED ADDRESS ON AN INVITATION IS A CONSEQUENCE, NOT A
        * HINT, AND THE TWO HALVES OF THAT ARE CHOSEN TOGETHER.**
        *
        * `profile/request.ts` refuses an invitation that never ASKS for
        * `receiving-address`, required. This screen still lets the person
        * DECLINE it, because every row here is refusable and a surface with one
        * row that cannot be refused is a surface with a coerced answer (§6).
        * **Those are not in tension: the refusal is about a message this wallet
        * cannot answer, and the decline is about an answer a person is entitled
        * to give.**
        *
        * What that costs is that a person can accept an invitation and send
        * nowhere to be paid, which is honest and is useless to the receiver.
        * **So it is SAID, in the consequence's own words, rather than left to
        * the ordinary muted line** -- which reads *you can send anyway, and
        * they are told what you declined* and is true of a first name and
        * badly wrong here. The alternative was making this one row
        * unrefusable, and that would be the first coerced answer on this
        * surface.
        */}
      {missingRequired.length > 0 && (
        join !== null && missingRequired.some((r) => r.attribute === RECEIVING_ADDRESS) ? (
          <Alert
            tone="warning"
            title="You have said not to send where you are paid"
          >
            <p className="m-0" data-join-no-address>
              You can accept anyway, and they are told you declined it. But nothing in what
              you send says where to pay you, so whoever opens it cannot pay you and will
              have to ask you again some other way.
            </p>
            {missingRequired.length > 1 && (
              <p className="m-0">
                {`They also require ${missingRequired
                  .filter((row) => row.attribute !== RECEIVING_ADDRESS)
                  .map((row) => row.definition?.render.label ?? row.attribute)
                  .join(', ')}.`}
              </p>
            )}
          </Alert>
        ) : (
          <p className="m-0 text-sm text-muted" data-missing-required>
            {`They require ${missingRequired.map(
              (row) => row.definition?.render.label ?? row.attribute).join(', ')}. `}
            {join === null
              ? 'You can send anyway, and they are told what you declined.'
              : 'You can accept anyway, and they are told what you declined.'}
          </p>
        )
      )}

      <div className="flex flex-wrap gap-2">
        {/* Observed, not claimed, on the button as on the question. */}
        <Button
          variant="primary"
          onClick={approve}
          disabled={!consent.ok}
          data-approve
          {...(join === null ? {} : { 'data-join': '' })}
        >
          {join === null
            ? `Send these to ${request.requester.origin}`
            : `Accept, and send these to ${request.requester.origin}`}
        </Button>
        <Button
          variant="ghost"
          data-decline
          onClick={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
        >
          {join === null ? 'Send nothing' : 'Do not accept'}
        </Button>
        <ConsentRefused consent={consent} />
      </div>
    </>
  );
}
