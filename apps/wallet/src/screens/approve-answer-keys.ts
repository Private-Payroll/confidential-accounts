/*
 * Gives an unlock key or answers a keyring ask: each hands the page the key it asked for and writes down that it went, to whom and when.
 * A keyring answer founds a new company first when the page asked it to, and gives nothing if the company cannot be written down.
 */
import { recordRelease } from 'midnight-identity/profile/model';
import { save } from 'midnight-identity/profile/store';
import { keyringReleaseFor, releaseFor, withTheFounding, withTheKeysRead } from 'midnight-identity/profile/unlock';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { foundTheCompanyInTheWallet } from '../keyring/found-company.js';
import { keyringMarksFor } from '../keyring/held-keyring.js';
import { keysReadForThePage } from '../keyring/read-for-the-page.js';
import { refuseIfItCarriesASecret } from '../keyring/nothing-secret-crosses.js';
import { INDEXER_HTTP_URL, INDEXER_WS_URL } from '../config.js';
/* This wallet's own receiving addresses, which an unlock answer carries so the page can
 * check whether a payslip was paid to one of them: `../accounts/derived.ts`. */
import { receivingAddressesOf } from '../accounts/derived.js';
import type { ApproveInputs } from './approve-inputs.js';
import type { ApproveState, WhatIsAsked } from './approve-state.js';
import { NETWORK } from 'midnight-identity/network';
import { whyNotThisWallet } from '../lib/signed-in-here.js';

type Held = ApproveInputs & ApproveState & WhatIsAsked;

export type UnlockKeyAnswer = Pick<Held, 'request' | 'profile' | 'channel' | 'identity' | 'port' | 'now' | 'companyOnChain' | 'setProblem' | 'setProfile' | 'setSentAt'>;

export type KeyringAnswer = Pick<Held, 'request' | 'profile' | 'channel' | 'identity' | 'secret' | 'port' | 'now' | 'thisWallet' | 'companyOnChain'
  | 'openedCompanyRead' | 'setProblem' | 'setProfile' | 'setSentAt' | 'setGivenCompany'> & {
  readonly addressesHeld: ReadonlyMap<string, number>;
  readonly releasing: { current: unknown };
};

/**
 * **THE RELEASE. A SEPARATE FUNCTION, NOT A BRANCH INSIDE `answerDisclosure`.**
 *
 * `answerDisclosure` mints and sends a `DisclosurePayload`; this sends a key. Sharing
 * a body would mean one function whose most dangerous line is behind an
 * `if`, and the finding was a sign-in falling through a disclosure's
 * `grantTo` and erasing a person's grant. **A release touches no grant, mints
 * nothing, and signs nothing.**
 */
export function giveUnlockKey(a: UnlockKeyAnswer): void {
  const { request, profile, channel, identity, port, now, companyOnChain, setProblem, setProfile, setSentAt } = a;
  if (request === null || request.kind !== 'unlock' || profile === null
    || channel === null || !companyOnChain) return;
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
    /* WHICH COMPANY, and on which account, so a later ask for the same one
     * from a different host can be shown as such. **Read to warn, never read
     * into a key.** */
    company: request.company,
    account: request.account,
  }, at);
  setProfile(next);
  setSentAt(at);
  void save(port, identity, next).catch(
    () => setProblem('The key was given, and this wallet could not write down that it was.'));
}

/**
 * **THE KEYRING RELEASE. ITS OWN FUNCTION, FOR `giveUnlockKey`'S REASON.**
 *
 * The gate is inside `keyringReleaseFor`: when the ask names the address the
 * page signed in as and no account of this wallet has it, nothing is built
 * and nothing is sent, whatever state the button is in. When the ask hands
 * the saved keys in, this wallet opens them and answers with what they hold
 * that is not secret (`keyring/read-for-the-page.ts`).
 */
export function giveKeyring(a: KeyringAnswer): void {
  const { request, profile, channel, identity, secret, port, now, addressesHeld, thisWallet, companyOnChain, openedCompanyRead, releasing, setProblem, setProfile, setSentAt, setGivenCompany } = a;
  if (request === null || request.kind !== 'keyring' || profile === null
    || channel === null || releasing.current === request) return;
  /* A company's key goes only once its account has been read and carries its label. */
  if (request.company !== null && !companyOnChain && !openedCompanyRead) return;
  const { companyIfOnChain: _opened, ...alone } = request;
  const asked = request.companyIfOnChain === true && !companyOnChain ? { ...alone, company: null, account: null } : request;
  const at = now();
  /* With no address named, this browser's note of which wallet answered that
   * page's last sign-in is the only gate there is, and it is checked here as
   * well as on the button. */
  if (request.signedInAs === null) {
    const refused = whyNotThisWallet(port, request.requester.origin, thisWallet);
    if (refused !== null) { setProblem(`${refused} Nothing has been given.`); return; }
  }
  releasing.current = request;
  void (async () => {
  let answer;
  let handedOver: (() => void) | undefined;
  try {
    if (request.drawLabel) {
      /* A new company is founded here, before anything is answered: the label
       * drawn, the seat made from this wallet's words, the founding signed and
       * the seat kept in the saved keys sealed again. Only then is the
       * release made, for that label. */
      const label = drawCompanyLabel();
      const founded = await foundTheCompanyInTheWallet({ identity, request, label, marks: keyringMarksFor(secret) });
      answer = withTheKeysRead(withTheFounding(
        keyringReleaseFor(identity, request, at, (address) => addressesHeld.has(address), () => label),
        { founded: founded.founded, sealed: founded.sealed, ifVersion: founded.ifVersion },
      ), founded.read);
    } else {
      const released = keyringReleaseFor(identity, asked, at, (address) => addressesHeld.has(address));
      const here = keysReadForThePage({ identity, request, marks: keyringMarksFor(secret) });
      answer = here === null ? released : withTheKeysRead(released, here.read);
      handedOver = here?.handedOver;
    }
    refuseIfItCarriesASecret(answer);
  } catch (e) {
    releasing.current = null;
    setProblem(e instanceof Error ? e.message : 'Nothing has been given.');
    return;
  }
  /* A company's key given in the same answer is written down as any company's
   * key is, so a later ask for it from a different host is shown as such -
   * including the key for a company this wallet has just drawn the label of.
   * The keyring key has no company, and nothing about it is written down. */
  const next = answer.company === null ? null : recordRelease(profile, {
    at,
    nonce: request.nonce,
    recipient: {
      origin: request.requester.origin,
      name: request.requester.name,
      rdns: request.requester.rdns,
    },
    company: answer.company,
    account: answer.account,
  }, at);
  /* A FOUNDING IS WRITTEN DOWN BEFORE IT IS ANSWERED. Finishing the company
   * here is allowed only for a label this record says the wallet drew, so a
   * founding answered and then not written down could never be finished from
   * this wallet. A founding that cannot be written down is not answered. */
  if (request.drawLabel && next !== null) {
    try {
      await save(port, identity, next);
    } catch {
      releasing.current = null;
      setProblem('This wallet could not write down the company it was starting, so nothing was created and nothing was given. '
        + 'Check that this browser keeps this site\'s data (not a private window, and with room left), then press again.');
      return;
    }
  }
  if (channel.answer(answer)) handedOver?.();
  setSentAt(at);
  setGivenCompany(answer.company === null ? null : { company: answer.company, account: answer.account });
  if (next === null) return;
  setProfile(next);
  if (request.drawLabel) return;
  void save(port, identity, next).catch(
    () => setProblem('The key was given, and this wallet could not write down that it was.'));
  })();
}
