import { useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity';
import { coinPublicKeyOf } from '../chain/balance.js';
import type { StopBalance } from '../chain/balance.js';
import { GIVE_UP_AFTER_MS } from '../chain/balance.js';
import { BalanceEnginesContext } from '../chain/balance-context.js';
import { nightFromStars } from '../chain/amount.js';
import {
  holdsAnyOther, otherTokenLines, shortColour, smallestUnits,
} from '../chain/shielded-tokens.js';
import type { OtherTokens } from '../chain/shielded-tokens.js';
import { loadWalletCheckpoint } from '../accounts/storage.js';
import { openWalletId } from '../accounts/wallets-held.js';
import { WALLET_ACCOUNTS } from '../accounts/subwallets.js';

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
  /* `others` is every other private token the slot held at `asOf`, or absent
   * when the figure did not record them. Absent is not none. */
  | {
    readonly kind: 'known'; readonly night: bigint; readonly asOf: number;
    readonly others?: OtherTokens;
  }
  | { readonly kind: 'failed' };

export type WalletBalanceRows = Readonly<Record<number, WalletBalanceRow>>;

/**
 * How long the sweep waits on one slot for a live figure. The engine's own
 * clock gives up on silence at the same length, and it stops watching once a
 * saved figure is on screen, so the sweep keeps a deadline of its own.
 */
export const SWEEP_SLOT_GIVE_UP_MS = GIVE_UP_AFTER_MS;

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
 *
 * NIGHT IS ONE TOKEN AMONG THE ONES A SLOT CAN HOLD. A slot holding only some
 * other private token holds money, and it earns its place in the preview
 * exactly as a NIGHT balance does. The question asked of each amount is still
 * the same one: is it more than nothing.
 */
export const holdsMoney = (row: WalletBalanceRow): boolean =>
  row.kind === 'known' && (row.night > 0n || holdsAnyOther(row.others));

/**
 * **WHAT EARNS A SLOT A PLACE IN A SHORT PREVIEW: MONEY, OR A FIGURE THAT
 * CANNOT SAY THERE IS NONE.** A figure saved by an older version of the wallet
 * recorded NIGHT only. A slot whose only money is another private token then
 * reads as zero NIGHT with its other tokens not recorded, and ranking that as
 * empty would leave a funded slot out of the preview on the strength of a
 * figure that never looked. So it ranks with the funded ones until a check
 * records the whole map.
 */
export const earnsAPreviewPlace = (row: WalletBalanceRow): boolean =>
  holdsMoney(row) || (row.kind === 'known' && row.others === undefined);

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

/** A known row, carrying the other tokens only when they were recorded, so an
 * unrecorded figure never turns into "holds no other token" on the way. */
const knownRow = (night: bigint, asOf: number, others: OtherTokens | undefined): WalletBalanceRow =>
  (others === undefined
    ? { kind: 'known', night, asOf }
    : { kind: 'known', night, asOf, others });

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
          ? knownRow(checkpoint.night, checkpoint.asOf, checkpoint.others)
          : { kind: 'unknown' };
      }
      if (!stale) setRows((now) => mergeStored(now, loaded));
    })();
    return () => { stale = true; };
  }, [identity, changed, announced]);

  /*
   * **ONE SLOT, READ LIVE, AND ONLY ITS OWN ENGINE STOPPED.**
   *
   * An engine starts by replaying the figure it saved last time, with that
   * figure's old moment, and only then reads the chain. So the first number it
   * reports is not a check. A slot is finished by a figure established after
   * the check began, by a failure, or by the deadline; at the deadline the
   * replayed figure stands with its old moment, which says how stale it is, and
   * with none the slot could not be checked.
   *
   * The stop handle is this slot's own, held here. A shared handle read later
   * would by then belong to the next slot, and stopping that one leaves it
   * checking for ever.
   */
  const checkOne = (account: number): Promise<WalletBalanceRow> =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      let finished = false;
      let stop: StopBalance | null = null;
      let replayed: WalletBalanceRow | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      const finish = (row: WalletBalanceRow): void => {
        if (finished) return;
        finished = true;
        if (deadline !== null) clearTimeout(deadline);
        resolve(row);
        if (stop !== null) {
          stop();
          if (stopCurrent.current === stop) stopCurrent.current = null;
        }
      };
      const handle = engines.shielded(identity, account, (state) => {
        if (state.name === 'synced') {
          const row = knownRow(state.night, state.asOf, state.others);
          if (state.asOf >= startedAt) finish(row);
          else replayed = row;
        } else if (state.name === 'failed') {
          finish(replayed ?? { kind: 'failed' });
        }
      });
      stop = handle;
      if (finished) {
        /* It answered before its handle was returned. */
        handle();
        return;
      }
      stopCurrent.current = handle;
      deadline = setTimeout(() => finish(replayed ?? { kind: 'failed' }), SWEEP_SLOT_GIVE_UP_MS);
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
      {/* THE ROW'S FIGURE: the NIGHT amount, the kind of money and the moment,
        * then one segment per other private token held (its smallest-unit
        * amount and short colour, the whole colour on the segment), or
        * "other private tokens not recorded" when the figure did not record
        * them. The wallet has no name and no scale for those tokens. The line
        * has no fixed length, so it is `break-words` and never
        * `whitespace-nowrap`: an unbreakable line set a minimum width the
        * switcher's dialog could not go below (`shell/switcher.tsx`, the
        * right column), and the dialog scrolled sideways. */}
      {row.kind === 'known' && (
        <span className="text-xs break-words text-muted">
          {nightFromStars(row.night)} tNIGHT shielded &middot; {asMoment(row.asOf)}
          {row.others === undefined
            ? <> &middot; other private tokens not recorded</>
            : otherTokenLines(row.others).map(([colour, amount]) => (
              <span key={colour} data-token={colour}>
                {' '}&middot; {smallestUnits(amount)} of token{' '}
                <span title={colour}>{shortColour(colour)}</span>
              </span>
            ))}
        </span>
      )}
    </>
  );
}
