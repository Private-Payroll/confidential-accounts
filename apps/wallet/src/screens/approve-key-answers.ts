/*
 * The presses that hand a page a key: an unlock key and a keyring.
 * Each runs its answering function with what the screen holds, the keyring press allows one release per ask,
 * and nothing is given without a press.
 */
import { useCallback, useMemo, useRef } from 'react';
import { unshieldedAddressFor } from '../chain/unshielded.js';
import { WALLET_ACCOUNTS } from '../accounts/subwallets.js';
import type { ApproveInputs } from './approve-inputs.js';
import type { ApproveState, WhatIsAsked } from './approve-state.js';
import { giveKeyring, giveUnlockKey } from './approve-answer-keys.js';

export function useUnlockAnswer(a: ApproveInputs & ApproveState & WhatIsAsked) {
  const { identity, port, now, channel, profile, setProfile, setProblem, setSentAt, request, companyOnChain } = a;
  const release = useCallback((): void => {
    giveUnlockKey({
      request,
      profile,
      channel,
      identity,
      port,
      now,
      companyOnChain,
      setProblem,
      setProfile,
      setSentAt
    });
  }, [request, profile, channel, identity, port, now, companyOnChain]);
  return { release };
}
export type UnlockAnswer = ReturnType<typeof useUnlockAnswer>;

export function useHeldAddresses(a: ApproveInputs & ApproveState & WhatIsAsked) {
  const { identity, request } = a;
  /**
   * **WHICH OF THIS WALLET'S OWN ACCOUNTS HAS THE ADDRESS A KEYRING ASK SAYS THE
   * PAGE SIGNED IN AS**, or null when none does or none is named. Worked out from
   * this wallet's own keys, for every account it offers, and compared whole.
   */
  const addressesHeld = useMemo((): ReadonlyMap<string, number> => {
    const held = new Map<string, number>();
    if (request === null || request.kind !== 'keyring' || request.signedInAs === null) return held;
    for (const account of WALLET_ACCOUNTS) {
      try {
        held.set(unshieldedAddressFor(identity, account), account);
      } catch {
        /* not an address this wallet can show */
      }
    }
    return held;
  }, [request, identity]);
  return { addressesHeld };
}
export type HeldAddresses = ReturnType<typeof useHeldAddresses>;

export function useKeyringAnswer(a: ApproveInputs & ApproveState & WhatIsAsked & HeldAddresses) {
  const {
    identity,
    secret,
    port,
    now,
    channel,
    profile,
    setProfile,
    setProblem,
    setSentAt,
    setGivenCompany,
    thisWallet,
    request,
    companyOnChain,
    openedCompanyRead,
    addressesHeld
  } = a;
  /* One release per ask: founding a company takes a moment, and a second press in it must not found a second one. */
  const releasing = useRef<unknown>(null);
  const releaseKeyring = useCallback((): void => {
    giveKeyring({
      request,
      profile,
      channel,
      identity,
      secret,
      port,
      now,
      addressesHeld,
      thisWallet,
      companyOnChain,
      openedCompanyRead,
      releasing,
      setProblem,
      setProfile,
      setSentAt,
      setGivenCompany
    });
  }, [
    request,
    profile,
    channel,
    identity,
    secret,
    port,
    now,
    addressesHeld,
    thisWallet,
    companyOnChain,
    openedCompanyRead
  ]);
  return { releaseKeyring };
}
export type KeyringAnswerPress = ReturnType<typeof useKeyringAnswer>;
export type KeyAnswers = UnlockAnswer & HeldAddresses & KeyringAnswerPress;
