/*
 * The press that answers a disclosure, a sign-in or a join.
 * It runs the answering function with what the screen holds; nothing is sent without a press.
 */
import { useCallback } from 'react';
import type { ApproveInputs } from './approve-inputs.js';
import type { ApproveState, WhatIsAsked } from './approve-state.js';
import { answerDisclosure } from './approve-answer-disclosure.js';

export function useAnswers(a: ApproveInputs & ApproveState & WhatIsAsked) {
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
  const approve = useCallback((): void => {
    answerDisclosure({
      request,
      profile,
      channel,
      rows,
      picked,
      refused,
      subwallet,
      identity,
      port,
      now,
      thisWallet,
      setProblem,
      setProfile,
      setSentAt
    });
  }, [request, profile, channel, rows, picked, refused, subwallet, identity, port, now, thisWallet]);
  return { approve };
}
export type Answers = ReturnType<typeof useAnswers>;
