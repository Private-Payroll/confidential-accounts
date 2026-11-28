/*
 * Chooses what the approval screen shows: a request that was swapped, a wallet record that cannot be opened, a refused request, a wait for the request, the record of what was sent, or the ask itself.
 * It reads what the screen holds and draws nothing of its own.
 */
import type { ReactNode } from 'react';
import { AskOver } from './ask-over.js';
import type { Screen } from './approve-shape.js';
import { noRequestView, refusedView, swappedView, unopenableView } from './approve-early-views.js';
import {
  detailsSentView,
  joinSentView,
  keyringSentView,
  signInSentView,
  unlockSentView
} from './approve-sent-views.js';
import { askedView } from './approve-asked.js';

export function approveView(v: Screen): ReactNode {
  const { framing, channelState, channel, opened, sentAt, request, swapped } = v;
  if (swapped && request !== null) {
    return swappedView({ ...v, request });
  }

  if (opened?.of === 'unopenable') {
    return unopenableView({ opened });
  }

  if (channelState.of === 'refused') {
    return refusedView({ channelState });
  }

  if (request === null && channel !== null && channel.over()) {
    /* The page has had its answer - a person said no, or closed a request this wallet refused - and nothing more is coming. */
    return <AskOver framed={framing.of === 'framed'} />;
  }

  if (request === null) {
    return noRequestView(v);
  }

  if (sentAt !== null && request.kind === 'unlock') {
    return unlockSentView({ ...v, request, sentAt });
  }

  if (sentAt !== null && request.kind === 'keyring') {
    return keyringSentView({ ...v, request, sentAt });
  }

  if (sentAt !== null && request.kind === 'sign-in') {
    return signInSentView({ ...v, request, sentAt });
  }

  if (sentAt !== null && request.kind === 'join') {
    return joinSentView({ ...v, request, sentAt });
  }

  if (sentAt !== null) {
    return detailsSentView({ ...v, request, sentAt });
  }

  return askedView({ ...v, request });
}
