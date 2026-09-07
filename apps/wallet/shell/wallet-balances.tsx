import { useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity';
import { coinPublicKeyOf } from '../balance.js';
import type { StopBalance } from '../balance.js';
import { BalanceEnginesContext } from '../balance-context.js';
import { nightFromStars } from '../amount.js';
import { loadWalletCheckpoint } from '../storage.js';
import { openWalletId } from '../wallets-held.js';
import { WALLET_ACCOUNTS } from '../subwallets.js';

/**
 * WHAT EACH SLOT WAS LAST KNOWN TO HOLD — one implementation, two surfaces.
 *
 * THIS IS SPLIT OUT OF `screens/home.tsx`, AND THE SPLIT IS THE POINT.
 * Home's *Every wallet* card listed all eleven slots and carried the sweep;
 * eleven rows is a wall, and the design moves the sweep
 * into the switcher — *"where a person has asked to see all of them"* — while
 * Home keeps a short preview with a chevron to it. That is TWO surfaces
 * rendering the same fact, which is exactly the shape the rule is about, so it is
 * one module rather than two copies: one row type, one loader, one sweep, one
 * set of sentences. A second implementation of "what is in slot 7" is a second
 * answer free to disagree with the first.
 *
 * IT LIVES BESIDE THE SWITCHER because the switcher is the surface that owns
 * the full list — Home's card is a preview OF it, not a peer of it.
 *
 * NOTHING HERE SYNCS ON ITS OWN. The loader reads stored checkpoints, which is
 * a local read and asks nobody anything; the sweep runs only when a person
 * presses it. That is `SECURITY.md`'s promise and `balance.ts:30-46`'s reason,
 * unchanged by this move: the indexer learns the fact of being asked, so being
 * asked is an act a person performs.
 *
 * NO SECOND READER OF THE ATOMIC UNITS — the second half of the
 * money-card freeze. The only arithmetic in this file is `nightFromStars`,
 * which is `amount.ts`'s own converter and is the call `screens/home.tsx` was
 * already making on this exact row; `holdsMoney` compares to zero, which is
 * the one question about an amount whose answer does not depend on the unit.
 * Nothing here names STARs or SPECKs, and nothing here divides by anything.
 */

/** Moved out of `screens/home.tsx` unchanged — the money card never called it;
 * it formats the AGE on an every-wallet row, and it moves with the rows. */
export const asMoment = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

/**
 * FOUR STATES, AND THEY ARE THE FOUR SENTENCES THE DESIGN ALLOWS.
 * Zero and "I do not know" are different facts, so `unknown` is not a zero and
 * `failed` is not a zero, and only `known` carries a number — with the moment
 * it was true of, which is what keeps a stored figure from reading as a fresh
 * one.
 */
export type WalletBalanceRow =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'known'; readonly night: bigint; readonly asOf: number }
  | { readonly kind: 'failed' };

export type WalletBalanceRows = Readonly<Record<number, WalletBalanceRow>>;

/**
 * AS A PREDICATE. *"The account this wallet refuses to show is one
 * another wallet will happily pay into, and the money is real."* Home shows a
 * preview of three, and a preview that could leave a funded slot out would be
 * that row happening through a layout decision — so this is what earns a slot
 * a place in the preview ahead of an empty one.
 *
 * IT ASKS THE NUMBER ONE QUESTION AND NO OTHER: is it more than nothing.
 * That is deliberately the only question whose answer is the same in every
 * unit, so this is not a second reader of the atomic figure — it never
 * converts it, never displays it and never compares it to anything but zero.
 *
 * A SLOT NOBODY HAS CHECKED IS NOT "EMPTY", it is unknown, and it does not
 * rank — which is why the card still says out loud that an unchecked slot can
 * be holding money. Ranking an unknown as funded would fill the preview with
 * every slot; ranking it as empty and then calling the preview complete is the
 * lie. The sentence is what covers it, and the sentence stays.
 */
export const holdsMoney = (row: WalletBalanceRow): boolean =>
  row.kind === 'known' && row.night > 0n;

/**
 * THE CHANGE EVENT — the same shape, and the same reason, as `shell/wallets.ts`
 * gives for the one it carries: `storage.ts` cannot emit one, and two surfaces
 * now read this fact.
 *
 * WHAT IT IS FOR, PRECISELY. The sweep lives in the switcher and Home shows a
 * preview of the same slots behind it. Without this, a person sweeps every
 * wallet, closes the dialog, and **Home's preview still says *never checked*
 * about a slot they have just checked** — a false sentence about money, which
 * is the whole family it belongs to.
 *
 * IT CARRIES THE ANSWER, NOT A NUDGE TO GO AND LOOK. A bare "something
 * changed" would send every reader back to the stored summaries, and the
 * answer is only there if the engine that produced it happened to persist one
 * — which the real engine does and a test double does not. **A notification
 * whose correctness depends on a side effect somewhere else is a notification
 * that works in production and lies in a test**, or the other way round. So
 * the sweep hands over what it learned, per slot, as it learns it.
 *
 * A `Set`, and iterated over a COPY, for `shell/wallets.ts`'s two reasons: a
 * component that subscribes twice under StrictMode is notified once, and a
 * listener that unsubscribes while being notified does not mutate the set
 * mid-iteration.
 */
type Answer = (answers: Readonly<Record<number, WalletBalanceRow>>) => void;

const listeners = new Set<Answer>();

function announce(answers: Readonly<Record<number, WalletBalanceRow>>): void {
  for (const listener of [...listeners]) listener(answers);
}

/**
 * THE MERGE, AND IT IS A CLAIM ABOUT HONESTY RATHER THAN A CACHE POLICY.
 *
 * The stored summaries are the durable answer and win wherever they HAVE one:
 * a checkpoint written by the open wallet's own sync is newer than anything a
 * sweep saw. Two things survive a reload anyway:
 *
 *   a row still `checking`, which is in flight and not an answer yet; and
 *   an answer this session established over a slot the store knows NOTHING
 *   about — because replacing it with `unknown` would print *never checked*
 *   over a slot somebody just checked, and that sentence would be false.
 */
function mergeStored(
  now: WalletBalanceRows, loaded: Record<number, WalletBalanceRow>,
): Record<number, WalletBalanceRow> {
  const next = { ...loaded };
  for (const [key, mine] of Object.entries(now)) {
    const account = Number(key);
    if (mine.kind === 'checking' || (next[account] ?? { kind: 'unknown' }).kind === 'unknown') {
      next[account] = mine;
    }
  }
  return next;
}

export const rowFor = (rows: WalletBalanceRows, account: number): WalletBalanceRow =>
  rows[account] ?? { kind: 'unknown' };

export const anyNeverChecked = (rows: WalletBalanceRows): boolean =>
  WALLET_ACCOUNTS.some((account) => rowFor(rows, account).kind === 'unknown');

/**
 * The stored summaries, and the deliberate sweep. Lifted out of
 * `screens/home.tsx`'s `AllWalletsCard` with its behaviour unchanged: the
 * checkpoints are re-read whenever `changed` moves (a sync established a
 * number), and the sweep walks the slots ONE AT A TIME on the same engine,
 * because eleven concurrent wallets is eleven concurrent asks of the indexer.
 */
export function useWalletBalances(identity: Identity, changed = 0): {
  readonly rows: WalletBalanceRows;
  readonly sweeping: boolean;
  readonly sweep: () => void;
} {
  const engines = useContext(BalanceEnginesContext);
  const [rows, setRows] = useState<WalletBalanceRows>({});
  const [sweeping, setSweeping] = useState(false);
  /* Bumped by the change event above, so every reader re-reads the stored
   * summaries when a sweep has written new ones. */
  const [announced, setAnnounced] = useState(0);
  useEffect(() => {
    const listener: Answer = (answers) => {
      setRows((now) => ({ ...now, ...answers }));
      /* And go back to the stored summaries too: the engine saved a
       * checkpoint for every slot that answered, so what is on disk has
       * moved as well. */
      setAnnounced((n) => n + 1);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const cancelled = useRef(false);
  const stopCurrent = useRef<StopBalance | null>(null);
  useEffect(() => () => {
    cancelled.current = true;
    stopCurrent.current?.();
  }, []);

  useEffect(() => {
    let stale = false;
    /* CAPTURED HERE, SYNCHRONOUSLY, FOR THE REASON `balance.ts` GIVES
     * AT LENGTH: the loop below awaits eleven times, so every iteration after
     * the first resolves LATER, and a compartment read at that point is
     * whichever wallet is open by then rather than the one these rows are
     * about. A read landing in the wrong compartment costs only a spurious
     * cache miss — the coin-public-key check refuses a foreign entry — but it
     * is the same mistake as the write, and it is fixed the same way. */
    const walletId = openWalletId();
    void (async (): Promise<void> => {
      const loaded: Record<number, WalletBalanceRow> = {};
      for (const account of WALLET_ACCOUNTS) {
        /* And nothing is asked for after this component has gone. Eleven
         * IndexedDB reads for rows nobody will see is waste on its own; it
         * also keeps work in flight past the end of a test's environment,
         * which is where this was found. */
        if (stale) return;
        const checkpoint = await loadWalletCheckpoint(
          coinPublicKeyOf(identity, account), account, walletId);
        loaded[account] = checkpoint
          ? { kind: 'known', night: checkpoint.night, asOf: checkpoint.asOf }
          : { kind: 'unknown' };
      }
      if (!stale) setRows((now) => mergeStored(now, loaded));
    })();
    return () => { stale = true; };
  }, [identity, changed, announced]);

  const checkOne = (account: number): Promise<WalletBalanceRow> =>
    new Promise((resolve) => {
      let finished = false;
      const finish = (row: WalletBalanceRow): void => {
        if (finished) return;
        finished = true;
        resolve(row);
        /* The engine may resolve before its stop handle is assigned. */
        setTimeout(() => stopCurrent.current?.(), 0);
      };
      stopCurrent.current = engines.shielded(identity, account, (state) => {
        if (state.name === 'synced') finish({ kind: 'known', night: state.night, asOf: state.asOf });
        else if (state.name === 'failed') finish({ kind: 'failed' });
      });
    });

  const runSweep = async (): Promise<void> => {
    setSweeping(true);
    for (const account of WALLET_ACCOUNTS) {
      if (cancelled.current) break;
      announce({ [account]: { kind: 'checking' } });
      const outcome = await checkOne(account);
      if (cancelled.current) break;
      /* Published rather than kept: the preview on the screen behind this
       * dialog is showing the same slot and must not go on saying *never
       * checked* about one that has just answered. `announce` reaches this
       * instance too, through the subscription above. */
      announce({ [account]: outcome });
    }
    if (!cancelled.current) setSweeping(false);
  };

  return { rows, sweeping, sweep: () => { void runSweep(); } };
}

/**
 * ONE ROW'S WORTH OF WORDS. The four sentences are `screens/home.tsx`'s, moved
 * rather than rewritten — including the two that are the whole reason this
 * component is careful: *never checked* is a warning rather than a zero, and
 * *couldn't check — not a zero* says out loud what a failure is not.
 * `known` names the KIND of money it read: a row silent about that
 * would read as the whole wallet, and the sweep reads the shielded side only.
 */
export function WalletBalanceCell({ row }: { readonly row: WalletBalanceRow }): ReactNode {
  return (
    <>
      {row.kind === 'unknown' && (
        <span className="text-xs text-warn-text">never checked</span>
      )}
      {row.kind === 'checking' && (
        <span className="text-xs text-muted">checking…</span>
      )}
      {row.kind === 'failed' && (
        <span className="text-xs text-warn-text">
          couldn&rsquo;t check — not a zero
        </span>
      )}
      {/* `whitespace-nowrap` REMOVED, AND IT WAS THE OVERFLOW.
        * This is the longest thing either surface prints on one row: an amount,
        * the kind of money and the moment, forty-odd characters with no
        * opportunity to break. Held unbreakable it set a minimum width that the
        * switcher's dialog could not go below, and the dialog scrolled sideways
        * rather than the line wrapping (`shell/switcher.tsx`, the right column).
        * The WORDS are untouched — all four sentences are still the ones
        * the design allows, and the amount still names the kind of
        * money it read and the moment it was true of. Only the line
        * break is new: `break-words` lets it wrap inside whatever column it is
        * given, on the switcher's rows and on Home's preview alike. */}
      {row.kind === 'known' && (
        <span className="text-xs break-words text-muted">
          {nightFromStars(row.night)} tNIGHT shielded &middot; {asMoment(row.asOf)}
        </span>
      )}
    </>
  );
}
