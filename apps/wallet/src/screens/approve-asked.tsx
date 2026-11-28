/*
 * Chooses the screen for the ask in front of the person, one kind at a time: an action, a committee change, a records key, a retired creation, a join code, holders, addresses and balances, a balance, an unlock, a keyring, a sign-in, or a disclosure or invitation.
 */
import type { ReactNode } from 'react';
import type { Ask } from 'midnight-identity/profile/request';
import { quietConsentFor } from '../framing.js';
import { AnswerHolders } from './answer-holders.js';
import type { ScreenAsking } from './approve-shape.js';
import { askingParts } from './approve-asking.js';
import {
  actView,
  addressesView,
  balanceView,
  committeeView,
  creationView,
  joinCodeView,
  recordsKeyView
} from './approve-asked-views.js';
import { unlockView } from './approve-unlock.js';
import { keyringView } from './approve-keyring.js';
import { disclosureView, signInView } from './approve-disclosure.js';

export function askedView(v: ScreenAsking<Ask>): ReactNode {
  const { framing, channel, request } = v;
  const { whoIsAsking, whichWallet } = askingParts(v);
  const w = { ...v, whoIsAsking, whichWallet };
  if (request.kind === 'act') {
    return actView({ ...w, request });
  }

  if (request.kind === 'committee') {
    return committeeView({ ...w, request });
  }

  if (request.kind === 'records-key') {
    return recordsKeyView({ ...w, request });
  }

  if (request.kind === 'creation') {
    return creationView({ ...w, request });
  }

  if (request.kind === 'join-code') {
    return joinCodeView({ ...w, request });
  }

  if (request.kind === 'holders') {
    return <AnswerHolders request={request} channel={channel} consent={quietConsentFor(framing)} />;
  }

  if (request.kind === 'addresses-and-balances') {
    return addressesView({ ...w, request });
  }

  if (request.kind === 'balance') {
    return balanceView({ ...w, request });
  }

  if (request.kind === 'unlock') {
    return unlockView({ ...w, request });
  }

  if (request.kind === 'keyring') {
    return keyringView({ ...w, request });
  }

  if (request.kind === 'sign-in') {
    return signInView({ ...w, request });
  }

  return disclosureView({ ...w, request });
}
