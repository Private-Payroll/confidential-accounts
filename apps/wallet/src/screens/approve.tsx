/*
 * The approval screen: a page asks for details, a sign-in, a company's records or an action, and the wallet shows what is asked and who asks.
 * It puts together the screen's state, the presses that answer and the view for the kind of ask.
 * It answers only on a press, from the wallet's own window, and the page that asked never draws any of it.
 */
import type { ReactNode } from 'react';
import type { Identity, Secret } from 'midnight-identity/keys/derivation';
import { REGISTRY } from 'midnight-identity/profile/attributes';
import type { Registry } from 'midnight-identity/profile/attributes';
import { browserPort } from 'midnight-identity/profile/store';
import type { Port } from 'midnight-identity/profile/store';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { liveLabelReader } from './company-on-chain.js';
import type { LabelReader } from './company-on-chain.js';
import { EMBEDDER } from '../config.js';
import type { ChainReader } from './approve-committee.js';
import type { ApproveInputs } from './approve-inputs.js';
import { useApproveState, useRowEntry, useWalletRecord, useWhatIsAsked } from './approve-state.js';
import { useAnswers } from './approve-answers.js';
import { useHeldAddresses, useKeyringAnswer, useUnlockAnswer } from './approve-key-answers.js';
import { useAtOnce } from './approve-at-once.js';
import { approveView } from './approve-view.js';

export function Approve({
  identity,
  secret,
  registry = REGISTRY,
  port = browserPort(),
  view,
  now = Date.now,
  embedder = EMBEDDER,
  readLabel = liveLabelReader,
  readChain
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
  /** How a company's account is read off the chain. Injected so a test can answer. */
  readonly readLabel?: LabelReader;
  /** How a committee change's contracts are read off the chain. Replaceable so a test can answer. */
  readonly readChain?: ChainReader;
}): ReactNode {
  const inputs: ApproveInputs = { identity, secret, registry, port, view, now, embedder, readLabel, readChain };
  const state = useApproveState(inputs);
  const asked = useWhatIsAsked({ ...inputs, ...state });
  const entry = useRowEntry({ ...inputs, ...state, ...asked });
  const answers = useAnswers({ ...inputs, ...state, ...asked });
  const unlockAnswer = useUnlockAnswer({ ...inputs, ...state, ...asked });
  const held = useHeldAddresses({ ...inputs, ...state, ...asked });
  const kept = useWalletRecord({ ...inputs, ...state });
  const keyringAnswer = useKeyringAnswer({ ...inputs, ...state, ...asked, ...held });
  const standing = useAtOnce({ ...inputs, ...state, ...asked, ...answers, ...unlockAnswer, ...held, ...keyringAnswer });
  return approveView({
    ...inputs,
    ...state,
    ...asked,
    ...entry,
    ...answers,
    ...unlockAnswer,
    ...held,
    ...kept,
    ...keyringAnswer,
    ...standing
  });
}
