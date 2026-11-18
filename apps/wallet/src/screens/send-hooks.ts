import { useEffect, useMemo, useState } from 'react';
import type { Identity, Secret } from 'midnight-identity';
import { NETWORK } from '../config.js';
import { ownedAddressFor } from '../accounts/owned-address.js';
import { loadSubwallets } from '../accounts/storage.js';
import { MAIN_ACCOUNT, isWalletAccount } from '../accounts/subwallets.js';
import type { RehearsalScenario } from '../chain/rehearsal.js';
import type { SendWiring } from '../chain/send-context.js';
import { pendingGuardFor, transactionStatusOnChain } from '../chain/pending.js';
import { parseRecipient, starsFromNight } from '../chain/send.js';
import type { Recipient } from '../chain/send.js';

/**
 * THE SCREEN WAKE LOCK, AND ITS ABSENCE IS A STATE RATHER THAN AN ERROR.
 *
 * THE RULE: *"a browser that refuses it still proves, and the screen
 * then says keep this awake yourself rather than pretending it has been
 * handled. Never let a rejected lock take the send down."*
 *
 * The API is not in this project's TypeScript lib and it is declared narrowly
 * here rather than widened globally, because this file uses exactly two
 * members of it. Two different facts reach the same sentence: `request`
 * REJECTS when a browser refuses (a hidden document, a policy, a battery
 * saver), and `navigator.wakeLock` is simply ABSENT where the API was never
 * implemented. They read the same to a person, who can do nothing different
 * about either, so they say the same thing.
 */
interface WakeSentinel { readonly release: () => Promise<void> }
interface WakeLockApi { readonly request: (kind: 'screen') => Promise<WakeSentinel> }
const wakeLockApi = (): WakeLockApi | null => {
  const holder = navigator as Navigator & { wakeLock?: WakeLockApi };
  return holder.wakeLock ?? null;
};

/** `idle` before and after; `held` while the browser is keeping the screen
 * on; `unheld` when it refused or never had the API. */
export type WakeState = 'idle' | 'held' | 'unheld';

/** Holds the screen awake while `proving` is true, and says whether the browser agreed. */
export function useWakeLock(proving: boolean): WakeState {
  const [wake, setWake] = useState<WakeState>('idle');
  useEffect(() => {
    if (!proving) {
      setWake('idle');
      return undefined;
    }
    const api = wakeLockApi();
    if (api === null) {
      setWake('unheld');
      return undefined;
    }
    let sentinel: WakeSentinel | null = null;
    let gone = false;
    /* A REJECTION IS A STATE. It is caught here and never reaches the engine,
     * so a browser that refuses the lock still proves and still sends — the
     * screen simply asks the person to do what the browser would not. */
    void api.request('screen').then(
      (granted) => {
        if (gone) {
          void granted.release().catch(() => { /* releasing twice is fine */ });
          return;
        }
        sentinel = granted;
        setWake('held');
      },
      () => { setWake('unheld'); },
    );
    /* Released when proving ends, however it ends — a terminal state, a
     * failure, or the screen going away under it. */
    return () => {
      gone = true;
      void sentinel?.release().catch(() => { /* the browser took it back */ });
    };
  }, [proving]);
  return wake;
}

/** The wallet this screen pays from: the account last used on the home screen, and the address it owns. */
export function usePayingWallet(identity: Identity, secret: Secret): {
  readonly account: number;
  readonly owned: ReturnType<typeof ownedAddressFor>;
} {
  /* The PAYING wallet is the one open on the home screen — same storage,
   * same guard. Switching wallets stays on home, where switching is
   * unmistakable; this screen only ever pays from the wallet it names. */
  const [{ names, account }] = useState(() => {
    const stored = loadSubwallets(secret);
    return {
      names: stored.names,
      account: isWalletAccount(stored.lastUsed) ? stored.lastUsed : MAIN_ACCOUNT,
    };
  });
  const owned = useMemo(
    () => ownedAddressFor(identity, account, names, NETWORK), [identity, account, names]);
  return { account, owned };
}

/** The doors this send runs through: the real chain, or the pretend one for the chosen scenario. */
export function useSendDoors(
  wiring: SendWiring, mode: 'live' | 'rehearsal', identity: Identity, secret: Secret,
  account: number, scenario: RehearsalScenario,
) {
  const doors = useMemo(
    () => (mode === 'live' && wiring.live
      /* The LIVE doors gain the two pending doors here, where the secret is:
       * the written-down middle (pending.ts, this account's store) and the
       * chain-by-identifier question the engine watches with. The rehearsal
       * doors carry their own throwaway versions. */
      ? {
        ...wiring.live.doorsFor(identity, account),
        pending: pendingGuardFor(secret, account),
        transactionStatus: transactionStatusOnChain,
      }
      : wiring.rehearsalDoorsFor(identity, account, scenario)),
    [wiring, mode, identity, secret, account, scenario]);
  return doors;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
const tryParse = <T,>(parse: () => T): Parsed<T> => {
  try {
    return { ok: true, value: parse() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

/** The recipient and amount the person has typed, each parsed as they type. */
export function useSendForm() {
  const [recipientText, setRecipientText] = useState('');
  const [amountText, setAmountText] = useState('');

  /* Live, per-keystroke honesty: the kind said back in words the moment an
   * address parses; the exact STARs the moment an amount does; the refusal
   * verbatim the moment either fails. */
  const recipientInfo: Parsed<Recipient> | null = useMemo(
    () => (recipientText.trim() ? tryParse(() => parseRecipient(recipientText, NETWORK)) : null),
    [recipientText]);
  const amountInfo: Parsed<bigint> | null = useMemo(
    () => (amountText.trim() ? tryParse(() => starsFromNight(amountText)) : null),
    [amountText]);

  const ready = recipientInfo?.ok === true && amountInfo?.ok === true;
  return {
    recipientText, setRecipientText, amountText, setAmountText, recipientInfo, amountInfo, ready,
  };
}
