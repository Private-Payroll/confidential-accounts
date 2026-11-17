/*
 * What lets an ask be answered the moment it appears: an approval the person already pressed in the locked wallet's window, the refusal of an ask that differs from it, and the checks each kind of ask must pass before it is answered without another press.
 */
import { useEffect, useRef, useState } from 'react';
import { originsFor } from 'midnight-identity/profile/model';
import { actionFor } from '../actions/registry.js';
import { useText } from 'vaults-ui';
import { noteWalletId, whyNotThisWallet } from '../lib/signed-in-here.js';
import { openWalletId } from '../accounts/wallets-held.js';
import { takeApprovalBeforeThePasskey, useAnswerAtOnce } from '../framing.js';
import { slotIsQuiet } from './approve-slot.js';
import type { ApproveInputs } from './approve-inputs.js';
import type { ApproveState, WhatIsAsked } from './approve-state.js';
import type { Answers } from './approve-answers.js';
import type { KeyAnswers } from './approve-key-answers.js';

/**
 * No silent disclosure. A remembered grant pre-ticks the boxes and never skips the press. A disclosure or a join is
 * always answered by a press on this screen, because what is sent is chosen here, and so is a committee change,
 * because the keys it adds and removes are read and shown here. A sign-in, an unlock or a keyring ask may instead be
 * answered by the Approve the person pressed in the locked wallet's window for exactly the same ask
 * (`takeApprovalBeforeThePasskey`).
 */
export function useAtOnce(a: ApproveInputs & ApproveState & WhatIsAsked & Answers & KeyAnswers) {
  const { port, channel, profile, opened, subwallet, thisWallet, request, companyOnChain, openedCompanyRead, consent, approve, release, addressesHeld, releaseKeyring } = a;
  /*
   * **AN ASK APPROVED BEFORE THE PASSKEY IS ANSWERED HERE WITHOUT ANOTHER PRESS** - only the identical ask
   * (`takeApprovalBeforeThePasskey`), and only once every check its own button waits for agrees and nothing warns
   * that the window before the passkey could not show: a company's key given to another page before, or an address
   * another site already has. Those need this wallet open to know, so when one appears the screen stays, with the
   * warning above its button. **An ask that differs from the one approved** - the page swapped it in after the
   * passkey - is refused at once and said to be so: it is never shown with its own button as if it were what the
   * person approved.
   */
  const say = useText();
  const [atOnce, setAtOnce] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const channelNow = useRef(channel);
  channelNow.current = channel;
  useEffect(() => {
    if (request === null) return;
    const approval = takeApprovalBeforeThePasskey(request);
    if (approval === 'approved') setAtOnce(true);
    if (approval === 'other') {
      channelNow.current?.refuse('declined');
      setSwapped(true);
    }
    /* A page's last sign-in recorded before wallets' places were kept gains this wallet's place, when this is the
     * wallet it names, so the next ask from that page opens it without the list. */
    if (request.kind !== 'sign-in') {
      try { noteWalletId(port, request.requester.origin, thisWallet, openWalletId()); } catch { /* the next ask shows the list again */ }
    }
  }, [request, port, thisWallet]);
  /* An action this wallet has no definition for is refused at once, as the window before the passkey refuses it. */
  const actNotRun = request !== null && request.kind === 'act' && actionFor(request.intent.name) === null;
  useEffect(() => { if (actNotRun) channelNow.current?.refuse('unreadable'); }, [actNotRun]);
  const readable = opened !== null && opened.of !== 'unopenable' && profile !== null && channel !== null;
  const slotQuiet = readable && profile !== null && request !== null
    && slotIsQuiet(profile, request.requester.origin, subwallet);
  const keyGivenElsewhere = readable && profile !== null && request !== null
    && (request.kind === 'unlock' || request.kind === 'keyring')
    && request.company !== null
    && originsFor(profile, request.company, request.account).some((o) => o !== request.requester.origin);
  const otherWalletSignedIn = request !== null && (request.kind === 'unlock' || (request.kind === 'keyring' && request.signedInAs === null))
    && whyNotThisWallet(port, request.requester.origin, thisWallet) !== null;
  useAnswerAtOnce(atOnce && request?.kind === 'sign-in', consent.ok && slotQuiet, approve);
  useAnswerAtOnce(atOnce && request?.kind === 'unlock',
    consent.ok && readable && companyOnChain && !otherWalletSignedIn && !keyGivenElsewhere, release);
  useAnswerAtOnce(atOnce && request?.kind === 'keyring',
    consent.ok && readable && !otherWalletSignedIn && !keyGivenElsewhere
      && (request?.kind !== 'keyring' || request.signedInAs === null || addressesHeld.has(request.signedInAs))
      && (request?.kind !== 'keyring' || request.company === null || companyOnChain || openedCompanyRead), releaseKeyring);

  /* WHAT HOLDS AN ASK APPROVED BEFORE THE PASSKEY IS BROUGHT INTO SIGHT, once: a refusal or a warning found after the
   * passkey sits far down this screen, and the person is waiting for an answer, not reading from the top. */
  const heldInSight = useRef(false);
  useEffect(() => {
    if (!atOnce || heldInSight.current) return;
    const held = document.querySelector<HTMLElement>('[data-not-this-wallet], [data-not-signed-in-here], [data-seen-elsewhere], [data-wallet-shared], [data-you-leave]');
    if (held === null) return;
    heldInSight.current = true;
    held.scrollIntoView?.({ block: 'center' });
  });
  return { say, atOnce, swapped, readable, slotQuiet };
}
export type Standing = ReturnType<typeof useAtOnce>;
