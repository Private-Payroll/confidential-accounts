import React, { useCallback, useEffect, useState } from 'react';
import { NETWORK } from 'midnight-identity/network';
import {
  AddressShapeError, checkShieldedAddress,
} from 'midnight-identity/wallet/address-shape';
/* X12 §2 — the one place the code's spelling is decided, in the repository
 * that decides its width. */
import { tidyFingerprint } from 'midnight-identity/profile/fingerprint';
import { RECEIVING_ADDRESS } from '../core/wallet-payee-ask.js';
import { reviveBigints, toHex, type Hex } from '../core/crypto.js';
import { payslipKeypairFrom } from '../core/payslip-key-derive.js';
import { sealHandover } from '../core/invite-handover.js';
import { assets, formatAmount } from '../core/assets.js';
import type { AssetId } from '../core/assets.js';
import * as keyring from './keyring.js';
import { shownError } from './shown-error.js';
import { AuthScreen, WALLET_ORIGIN } from './Auth.js';
import { askWalletToUnlock } from './wallet-unlock.js';
import { askWalletForPayeeAddress } from './wallet-payee.js';
import { openWalletDialog } from './wallet-sign-in.js';
import { walletInThisPage } from './wallet-frame.js';

/**
 * **THE SCREEN AN INVITATION OPENS.** `docs/NEXT.md` `X11` §2 and §3,
 * `docs/scope-invitations.md` §6 and §8.
 *
 * ── NOBODY HAS EVER BEEN HIRED BY THIS PRODUCT, AND THIS IS WHY ──────────
 *
 * The server half has existed for rounds: `GET /api/invites/:token/offer` is
 * public and returns the sealed offer, `POST /api/invites/:token/accept-employee`
 * takes the handover, `POST /api/employees/:id/admit` makes somebody payable.
 * **There was no `/join` route anywhere in the application**, so the token
 * reached a page that did not exist. This is that page.
 *
 * ── THE TOKEN IS IN THE FRAGMENT, AND THAT IS THE ONE ROUTING DECISION ───
 *
 * The link is `<origin>/join#<token>`. **A fragment is never sent to a server**
 * — it is not in the request line, so it is not in an access log, and it is not
 * in a `Referer` header when this page later loads anything. A path segment is
 * all three. The token is the key to the offer AND the capability to accept it
 * (`payroll.ts:35-36`), so keeping it out of every log we can is worth the one
 * line of routing it costs.
 *
 * **WHAT THAT DOES NOT FIX, SAID RATHER THAN IMPLIED:** the offer LOOKUP puts
 * the token in an API path, because that is the route's shape and `X11` did not
 * change it. So the token still reaches this deployment's own request log at
 * the moment it is read. That is already on the register as part of `C21`'s
 * amendment and it is not narrowed here; what the fragment buys is that it does
 * not reach it a second time for every asset, stylesheet and script the page
 * loads, and does not travel to anywhere the page navigates.
 *
 * ── AND THE OPERATOR-SIDE "OPEN IT AS THEM" BUTTON IS NOT COMING BACK ────
 *
 * It was deleted on 17 Aug and `X11`'s first rule is that it stays deleted:
 * **whoever opens an invitation sets the address the salary is paid to.** This
 * screen is reachable by anybody holding the link and by nobody else, and there
 * is no route that hands an operator a token after the invitation is made —
 * `src/server/invitations.test.ts` is what holds that.
 */

/** What `offerFor` returns. `bigint` arrives as a tagged value; see below. */
interface Offer {
  company: string;
  /**  Null when no chain has given this company an address. */
  companyAddress: string | null;
  /**  What this browser seals the handover to. */
  inboxPublicKey: Hex;
  name: string;
  title: string;
  email: string | null;
  asset: AssetId;
  baseAmount: bigint;
  startDate: string;
  /**  When this offer stops being one. Beside the sealed offer
   * rather than inside it — the service is what enforces it. */
  expiresAt: string;
}

/** How this deployment introduces itself to a wallet. Untrusted there, shown as text. */
const US_TO_A_WALLET = {
  name: 'Confidential Accounts',
  rdns: 'social.lemonade.confidential-accounts',
};

/**
 * **READING THE ADDRESS OUT OF THE WALLET'S ANSWER, WITHOUT VERIFYING IT — AND
 * THE REASON IS NOT THAT VERIFYING IS HARD.** `X11` §3 and §7.
 *
 * `addSelfAsPayee` sends the wallet's signed disclosure to the SERVER, which
 * verifies it, because on that door somebody already on a company is writing a
 * row onto that company's roster and *a check made by the thing being persuaded
 * is not a check*.
 *
 * **THIS DOOR IS THE OTHER CASE.** The person approving IS the payee, the token
 * is the authorisation, and the value is theirs to set — that is the whole of
 * *the payee's key comes from the payee*. And §7 says the address must not
 * reach us at all, so **there is nothing for a server to verify**: what we
 * receive is a blob. Sending the signature as well would put the plaintext back
 * on the wire and reopen `C160` in the same round that closes it.
 *
 * What is checked here is what CAN be checked here: `askWallet` refuses any
 * message whose `MessageEvent.origin` is not the wallet's, and the two
 * assertions below are the same two `payeeFromWallet` makes about the CONTENT —
 * that the value was worked out by the wallet rather than typed, and that it is
 * an address rather than a proof about one. Both are plain JSON and cost no
 * WebAssembly.
 *
 * **WHAT IS LOST AGAINST THE OTHER DOOR, MEASURED:** the signature is not
 * checked, so a page running at this origin that could talk to the wallet could
 * substitute a value. That is a page running at our origin in the invitee's own
 * browser, which is already able to do anything this screen can — and the door
 * it replaces took a bech32 string straight out of a text box with no wallet in
 * the loop at all. **This is strictly stronger than what it replaces and
 * strictly weaker than `self-payee`, and both halves of that belong in the
 * entry rather than in a claim.**
 */
const addressFromWalletAnswer = (answer: unknown): string => {
  const payload = (answer as { payload?: unknown })?.payload as {
    disclosed?: unknown;
  } | undefined;
  const disclosed = Array.isArray(payload?.disclosed) ? payload!.disclosed : null;
  if (!disclosed) {
    throw new Error('your wallet did not answer with anything this page can read.');
  }
  const extra = disclosed.filter(
    (s: unknown) => (s as { about?: unknown })?.about !== RECEIVING_ADDRESS);
  if (extra.length > 0) {
    throw new Error(
      `your wallet was asked for a receiving address and also sent ${extra.length} other `
      + 'detail(s). Nothing else was asked for, so nothing has been sent on.');
  }
  const sent = disclosed.find(
    (s: unknown) => (s as { about?: unknown })?.about === RECEIVING_ADDRESS) as {
      says?: { of?: string; value?: unknown };
      asserted?: { by?: string };
    } | undefined;
  if (!sent) {
    throw new Error(
      'no address was sent. Declining is a normal answer in a wallet and nothing here has '
      + 'been changed — but there is nowhere to pay you until one arrives.');
  }
  if (sent.asserted?.by !== 'wallet') {
    throw new Error(
      'that address is marked as something somebody stated rather than something your '
      + 'wallet worked out from its own keys. An address that was typed is an address that '
      + 'can be typed wrong, so it is refused here.');
  }
  if (sent.says?.of !== 'value' || typeof sent.says.value !== 'string') {
    throw new Error('your wallet sent a proof about an address rather than an address.');
  }
  return sent.says.value;
};

/** How long the wallet has to answer the address ask. The unlock's own window. */
const PAYEE_WINDOW_MS = 2 * 60 * 1000;

export function JoinScreen({ token }: { token: string }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(keyring.isSignedIn());
  /* **A PERSON WHO RELOADS THE INVITATION IS STILL SIGNED IN.** The sign-in is a
   * cookie this page cannot see, so it asks; a failure here leaves the sign-in
   * button, which is the state this screen was already in. */
  useEffect(() => {
    let alive = true;
    keyring.resumeSession().then((u) => { if (alive && u) setSignedIn(true); }, () => {});
    return () => { alive = false; };
  }, []);
  const [accepted, setAccepted] = useState(false);
  /**
   * **X12 §2 — WHAT THE WALLET APPROVED, HELD ON THIS DEVICE BETWEEN TWO
   * PRESSES.** `docs/how-money-can-be-lost.md` `C21`.
   *
   * Accepting used to be one press: the wallet answered and the handover went
   * out in the same breath. It cannot be, now that a code has to travel with
   * it — **the code is on the wallet's screen, and the wallet's screen is a
   * window in front of this one.** A person cannot paste something they have
   * not been shown yet.
   *
   * So the address waits here, in this tab's memory, for as long as it takes
   * somebody to paste twenty characters. **That is their own address, on their
   * own device, and it is the same value that is about to be sealed** — it is
   * not a copy of anything and nothing else can read it. It is never written
   * to storage, so closing the tab loses it and the wallet is asked again,
   * which is the correct outcome rather than a cost.
   */
  const [held, setHeld] = useState<{ address: string; wrappingPublicKey: Hex } | null>(null);
  const [code, setCode] = useState('');

  /*
   * **PUBLIC, AND NO SESSION.** The person has no account yet, and
   * seeing the offer before accepting it is the whole reason this route exists:
   * the person best placed to notice that a hire is wrong is the person it is
   * about.
   */
  const load = useCallback(async () => {
    setErr('');
    try {
      const raw = await fetch(`/api/invites/${encodeURIComponent(token)}/offer`);
      const body = await raw.json().catch(() => ({}));
      if (!raw.ok) throw new Error(body?.error ?? `could not read this invitation (${raw.status})`);
      /* Money is a bigint and JSON has no bigints. `reviveBigints` is the same
       * revival every other screen uses, so a salary is never a float. */
      setOffer(reviveBigints(body) as Offer);
    } catch (e) {
      setErr(shownError(e, 'opening an invitation'));
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  /**
   * **STEP ONE: THE WALLET.** `X12` §2 split this from what follows, and the
   * reason is not tidiness.
   *
   * The code the invitee has to hand back is on the WALLET's screen, and the
   * wallet's screen is a window in front of this one. Sending in the same
   * breath as approving would mean asking somebody to paste something they had
   * not been shown. So the wallet round trip ends here, holding what it
   * produced, and the acceptance is a second press with the code in it.
   */
  const approve = async () => {
    setErr(''); setBusy(true);
    /*
     * **THE WALLET IS OPENED IN THE CLICK.** Everything after this is a
     * round trip, and a permission spent on one is gone by the time a window is
     * wanted. Both asks reuse this one dialog, so a person sees one wallet
     * window with two things to approve rather than two windows.
     */
    let dialog;
    let stopShowing: (() => void) | null = null;
    try {
      if (!WALLET_ORIGIN) {
        throw new Error(
          'this build does not know where your wallet is served from, so it cannot open it. '
          + 'VITE_WALLET_ORIGIN has to be set when the site is built.');
      }
      const current = offer;
      if (!current) throw new Error('there is no offer on this screen to accept.');
      if (!current.companyAddress) {
        /*
         * `C140`'s gate, arriving where somebody can act on it. The key that
         * opens this person's payslips is derived from the company's own
         * address on a chain, and a company that has never been deployed has
         * none — so accepting now would seal every future payslip under a
         * number our own server invented, and they would all stop opening on
         * the day the company is real.
         */
        throw new Error(
          'this company is not on a chain yet, so it has no address — and the key that opens '
          + 'your payslips is worked out from that address. Accepting now would seal your '
          + 'payslips to a number that changes the day the company is deployed, and none of '
          + 'them would open again. Ask whoever invited you to deploy the company first.');
      }
      /* The wallet is shown inside this page, and both asks below speak to it. */
      const host = walletInThisPage(window);
      dialog = openWalletDialog(host, WALLET_ORIGIN);
      /* Announced, so the page's *Stop waiting* refuses this journey's asks
       * rather than only hiding the wallet they are waiting on. */
      stopShowing = keyring.showWaitingFor(dialog);
      /*
       * **AND THE WINDOW BELONGS TO THIS FUNCTION RATHER THAN TO EITHER ASK.**
       *
       * An ask closes the dialog when it settles, which is right everywhere
       * else in this product because everywhere else one ask is the whole of
       * what the window was opened for. **Here it is not, and that is what
       * stopped an invited employee getting in:** the company-key ask
       * succeeded, its success put the window away, and the address ask that
       * follows was handed a window that no longer existed — so it reached
       * nothing, waited out its deadline, and said the wallet had not answered.
       * The `finally` below is what closes this one, on every outcome.
       */
      dialog.moreThanOneAsk();

      /*
       * ── ONE: THE COMPANY KEY, SO THE PAYSLIP KEY IS DERIVED AND NEVER
       * MINTED ──────────────────────────────────────────────────────────────
       *
       * `newWrappingKeypair()` here would be thirty-two random bytes
       * handed to the server as a public key and kept nowhere: **every payslip
       * this person is ever issued would be sealed to a secret this tab forgets
       * on reload**, and nothing — not another device, not a recovery, not us —
       * could work it out again. So it is `payslipKeypairFrom(companyKey)`,
       * exactly what a founder's own entry derives and exactly what a second
       * device rebuilds from twenty-four words.
       *
       * The company is named by the address that came out of the SEALED OFFER,
       * which only the holder of this link can open. `POST /api/accounts/:id/unlock`
       * is shut to an invitee by construction — they are not a member — and
       * `X11` §0 forbids inventing a second key path for them.
       */
      const companyKey = await askWalletToUnlock(host, WALLET_ORIGIN, {
        company: current.companyAddress,
        atOrigin: window.location.origin,
        name: US_TO_A_WALLET.name,
        rdns: US_TO_A_WALLET.rdns,
      }, dialog);
      const wrapping = payslipKeypairFrom(companyKey);

      /*
       * ── TWO: WHERE THE MONEY GOES, FROM THE WALLET'S OWN APPROVAL SCREEN ──
       *
       * `X11` §3, `docs/scope-invitations.md` §6. Accepting means handing a
       * company an address, and this product has one rule about anything
       * leaving a wallet: **one surface approves it.** So this is not a payroll
       * form that collects an address and posts it — it is `X8`'s disclosure
       * ask, the same chrome, the same origin observed from the browser, the
       * same refusal to let the asking party draw the asking, and the same
       * attribute. **No fourth ask kind was added and none was needed.**
       *
       * **THE NONCE IS MINTED HERE**, which is the unlock's arrangement rather
       * than the sign-in's, and the reason is the same one `wallet-unlock.ts`
       * gives: nobody but the wallet is a party to this question. `self-payee`
       * takes its nonce from the server because the SERVER is what writes that
       * record and has to know the answer is fresh. Here the server never sees
       * the answer at all — it receives a blob — so a server-issued nonce would
       * be a number nothing could ever check, and the member-gated challenge
       * route is shut to an invitee anyway.
       */
      const answer = await askWalletForPayeeAddress(host, WALLET_ORIGIN, {
        nonce: toHex(crypto.getRandomValues(new Uint8Array(16))),
        expiresAt: Date.now() + PAYEE_WINDOW_MS,
        name: US_TO_A_WALLET.name,
        rdns: US_TO_A_WALLET.rdns,
      }, dialog);

      /*
       * ── THREE: THE THREE CHECKS, HERE, WHERE YOU CAN DO SOMETHING ABOUT
       * THEM ────────────────────────────────────────────────────────────────
       *
       * `payeeAddress()`'s checks did not disappear, they moved: the
       * Bech32m checksum, the `shield-addr` TYPE and the NETWORK. A preview
       * address handed to a stagenet company is still refused by name — and now
       * it is refused on the screen of the person who can pick a different
       * wallet, rather than by a server that has already been handed the value.
       *
       * `checkShieldedAddress` carries no WebAssembly, which is why it exists:
       * `C149` says this page may not, and the real decoder's package has one
       * unrelated `ledger-v9` import at module scope. It is held against the
       * real decoder by a test in the wallet repository, and `admit` still
       * rebuilds the value through the real `payeeAddress()` from this very
       * string before anything is paid.
       */
      const address = checkShieldedAddress(addressFromWalletAnswer(answer), NETWORK);

      /*
       * ── FOUR: NOTHING LEAVES THIS DEVICE YET ──────────────────────────────
       *
       * **NOTHING IS SENT YET, AND THAT IS THE CHANGE.** The address is held on
       * this device until the person has pasted the code their wallet showed —
       * see `held`. `send` below is what seals and posts it.
       */
      setHeld({ address: address.bech32, wrappingPublicKey: wrapping.publicKey });
    } catch (e) {
      setErr(shownError(
        e,
        e instanceof AddressShapeError
          ? `accepting an invitation (${e.code})`
          : 'accepting an invitation'));
    } finally {
      dialog?.giveUp();
      stopShowing?.();
      setBusy(false);
    }
  };

  /**
   * **STEP TWO: SEALED, WITH THE CODE, AND SENT.** `X12` §2,
   * `docs/how-money-can-be-lost.md` `C21`,
   * `docs/scope-invitations.md` §5.
   *
   * ── WHY A CODE AT ALL, WHEN THE ADDRESS IS ALREADY SEALED ────────────────
   *
   * `C160` bought a real property and took a real one away with it: the company
   * cannot read the address on the wire, **and cannot tell that the address
   * which reached them is the one this person's wallet actually showed.** A
   * page running at this origin could have relayed the acceptance to a
   * different wallet, and everything downstream would look correct.
   *
   * The code closes exactly that gap and nothing wider. It is a fingerprint of
   * the address the wallet displayed, read off the wallet's own screen by the
   * person, typed in here, and sealed alongside the address — so the receiving
   * admin holds two values that were computed on two different machines from
   * what each of them believes the address to be.
   *
   * ── AND IT IS CHECKED FOR SHAPE HERE, NOT FOR TRUTH ─────────────────────
   *
   * Nothing on this page can tell whether the code is the RIGHT one — that
   * comparison happens on the admin's machine, against the address that
   * arrives, which is the whole design. What can be told here is that twenty
   * characters were pasted rather than nine, and saying so now is worth more
   * than an admin discovering a half-code days later with no way to know
   * whether it was a slip or a substitution.
   */
  const send = async () => {
    setErr(''); setBusy(true);
    try {
      const current = offer;
      const ready = held;
      if (!current || !ready) {
        throw new Error('there is nothing on this screen to send yet.');
      }
      const tidy = tidyFingerprint(code);
      if (tidy === null) {
        throw new Error(
          'that is not a whole code. Your wallet showed twenty characters in five groups, '
          + 'beside the address it was about to send — copy all of it. Nothing has been '
          + 'sent and the offer is still here.');
      }
      /*
       * ── SEALED BEFORE IT LEAVES THIS DEVICE ─────────────────────────
       *
       * `C160`, `docs/scope-invitations.md` §5. The company's inbox public key
       * came out of the sealed offer. It seals and cannot open; opening needs
       * the account's viewing key, which no invitee ever holds. What crosses
       * the wire from here is a blob our server cannot read — **and the code
       * goes inside it rather than beside it**, because a fingerprint is a
       * hundred bits that identify one address, which is a standing handle on
       * where somebody is paid for anybody reading the wire.
       */
      await keyring.api(`/api/invites/${encodeURIComponent(token)}/accept-employee`, {
        method: 'POST',
        body: JSON.stringify({
          handover: sealHandover(
            {
              wrappingPublicKey: ready.wrappingPublicKey,
              address: ready.address,
              confirmation: tidy,
            },
            current.inboxPublicKey),
        }),
      });
      setAccepted(true);
    } catch (e) {
      setErr(shownError(e, 'accepting an invitation'));
    } finally {
      setBusy(false);
    }
  };

  if (!offer) {
    return (
      <div className="authwrap">
        <div className="authcard">
          <div className="authmark">CA</div>
          <h1>Your invitation</h1>
          {err ? <div className="err">{err}</div> : <p className="authsub">Opening it…</p>}
        </div>
      </div>
    );
  }

  const asset = assets.require(offer.asset);

  if (accepted) {
    return (
      <div className="authwrap">
        <div className="authcard">
          <div className="authmark">CA</div>
          <h1>Accepted</h1>
          <p className="authsub">
            {offer.company} has been sent your address, sealed so that only they can read it.
            An admin has to admit you before you appear on a payroll run — until they do,
            nothing is paid to you.
          </p>
          <p className="authsub">
            The key that opens your payslips is worked out from your wallet and the company's
            own address on the chain. It was never sent and is not stored here, so any device
            holding your wallet opens every payslip you are ever issued.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="authwrap">
        <div className="authcard">
          <div className="authmark">CA</div>
          <h1>{offer.company} would like to put you on payroll</h1>
          <p className="authsub">
            This is what you are being offered. Nothing has been agreed and nothing has been
            sent — you are seeing it before you decide.
          </p>

          <div className="field"><label>Your name, as they have it</label>
            <input readOnly value={offer.name} /></div>
          <div className="field"><label>Title</label>
            <input readOnly value={offer.title} /></div>
          <div className="field"><label>Monthly gross</label>
            <input readOnly value={`${formatAmount(offer.baseAmount, asset)} ${asset.code}`} /></div>
          <div className="field"><label>Starting</label>
            <input readOnly value={new Date(offer.startDate).toLocaleDateString('en-GB')} /></div>
          {/*
            * **X12 §3 — THE OFFER HAS A DEADLINE AND THE PERSON IT IS ABOUT CAN
            * SEE IT.** `docs/scope-invitations.md` §8.
            *
            * A deadline nobody is shown is a deadline that happens TO
            * somebody: a person who leaves this open over a holiday comes back
            * to a refusal and no idea why. It is a field beside the others
            * because it is a fact about this offer, exactly as the salary is.
            */}
          <div className="field"><label>This offer is open until</label>
            <input readOnly value={new Date(offer.expiresAt).toLocaleDateString('en-GB')} /></div>

          {err && <div className="err">{err}</div>}

          {!signedIn ? (
            <>
              <p className="authsub">
                To accept, sign in first — the company records who set the address, and an
                acceptance that says nothing about who made it is not evidence of anything.
              </p>
              <AuthScreen onDone={() => setSignedIn(keyring.isSignedIn())} />
            </>
          ) : held === null ? (
            <>
              {/*
                * **X12 §1 — WHAT IS ABOUT TO HAPPEN, BEFORE IT HAPPENS.**
                * `docs/how-money-can-be-lost.md` `C161`.
                *
                * **THIS FILE NEVER SAID THE WORD *WALLET* TO A PERSON BEFORE
                * THEY PRESSED THE BUTTON.** It said *accept, and choose where
                * you are paid* — and then a window appeared. For the ordinary
                * first-time invitee, who has just been hired and has never
                * heard of any of this, that window is the product's entire
                * first impression and it arrived unannounced, containing a
                * thing they do not have.
                *
                * So the sentence goes BEFORE the press: a window, what is in
                * it, and — the part that decides whether this person is ever
                * paid — that not having one is an ordinary state with a way
                * out, in that window, without losing this page.
                *
                * **THE WAY BACK IS NOT BUILT BECAUSE THERE IS NOTHING TO
                * BUILD.** `X9` made the wallet a dialog: this page does not
                * navigate, the offer stays on screen behind it, and the ask
                * carries on when a wallet exists. The sentence says that
                * because a person cannot see it from here.
                */}
              <p className="authsub" data-before-the-wallet>
                Next, your wallet opens in a window on top of this page. <strong>If you have
                never used a Midnight wallet, that window is where you make one</strong> — it
                takes one touch, and this offer is still here when you come back to it. This
                page does not go anywhere.
              </p>
              <button type="button" className="primary" disabled={busy} onClick={approve}>
                {busy ? 'Waiting for your wallet' : 'Open my wallet and approve'}
              </button>
              <p className="authsub">
                Your wallet opens twice: once to work out the key that opens your payslips, and
                once to show you which of your own wallets this company would be paying. You
                choose that wallet, on your wallet's own screen. Nothing here can propose an
                address and there is nowhere on this page to type one.
              </p>
              <p className="authsub">
                Your address is sealed to {offer.company} on this device before it is sent, so
                this service never sees it.
              </p>
            </>
          ) : (
            <>
              {/*
                * **X12 §2 — THE SECOND PRESS, AND THE CODE THAT MAKES IT WORTH
                * HAVING.** `C21`, `docs/scope-invitations.md` §5.
                */}
              <p className="authsub">
                <strong>Your wallet has approved it, and nothing has been sent yet.</strong>{' '}
                One thing is left.
              </p>
              <div className="field">
                <label htmlFor="join-code">The code your wallet showed</label>
                <input
                  id="join-code"
                  data-confirmation-code
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                />
              </div>
              <p className="authsub">
                Your wallet showed a short code beside the address it is about to send. Paste
                it here. {offer.company} works out the same code from the address that reaches
                them and holds the two side by side — so <strong>if anything but your wallet
                had supplied that address, the two would not match.</strong>
              </p>
              <button
                type="button"
                className="primary"
                disabled={busy || tidyFingerprint(code) === null}
                onClick={send}
              >
                {busy ? 'Sending' : `Send this to ${offer.company}`}
              </button>
              <p className="authsub">
                Nothing has left this device yet. Your address is sealed to {offer.company}
                {' '}here, with the code, before either of them is sent.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * **THE TOKEN, OUT OF THE FRAGMENT.** Exported so the routing decision and the
 * reason for it are one thing a test can hold.
 */
export const joinTokenFromLocation = (
  where: { pathname: string; hash: string },
): string | null => {
  if (where.pathname.replace(/\/+$/, '') !== '/join') return null;
  const token = decodeURIComponent((where.hash ?? '').replace(/^#/, '')).trim();
  return token === '' ? null : token;
};
