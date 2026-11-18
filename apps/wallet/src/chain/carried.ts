import { DefaultForkSchedule, ProtocolVersion, WalletTransaction } from '@midnightntwrk/wallet-sdk';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { Either } from 'effect';
import { filter, firstValueFrom, map } from 'rxjs';

/** Every protocol version a handle may be stamped with: which ledger it carries is read from what it carries. */
const ANY_VERSION = ProtocolVersion.makeRange(ProtocolVersion.MinSupportedVersion, ProtocolVersion.MaxSupportedVersion);

/**
 * **THE LEDGER TRANSACTION A WALLET TRANSACTION HANDLE CARRIES.** The facade
 * hands transactions back sealed in a handle stamped with the protocol version
 * they were built for; what this wallet checks before it signs, proves or
 * sends (which coins a recipe spends, what it pays, its identifiers) is read
 * from the ledger transaction inside.
 *
 * Only a ledger-v9 transaction, the ledger this wallet builds for, is handed
 * out. A handle carrying anything else, or one sealed by another copy of the
 * SDK, gives `null`, and every check that reads it then refuses it as
 * unreadable. Anything that is not a handle is returned as it is: a ledger
 * transaction is already what the checks read.
 */
export const carriedBy = (tx: unknown): unknown => {
  if (!WalletTransaction.is(tx)) return tx;
  const carried = Either.getOrNull(WalletTransaction.unwrapWithin<unknown>(tx, ANY_VERSION));
  return carried instanceof Transaction ? carried : null;
};

/**
 * Whether the facade acts at the ledger version this wallet builds its
 * transactions for. The facade reads a transaction with the ledger of the
 * LOWEST version its three wallets report, and a wallet whose start could not
 * ask the network where the chain is reports the earliest version and keeps it
 * until it syncs. A part a path never syncs then holds the whole facade on the
 * earlier ledger, which reads none of this wallet's transactions, so a path
 * asks this before it hands the facade anything to read.
 */
export const actsOnThisWalletsLedger = async (facade: Pick<WalletFacade, 'state'>, waitMs = 180_000): Promise<boolean> => {
  /* A part still syncing reports the earlier ledger until it crosses the fork, so this waits for that, up to `waitMs`. */
  const crossed = firstValueFrom(facade.state().pipe(filter((s) => s.activeProtocolVersion >= DefaultForkSchedule.v9), map(() => true)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), waitMs); });
  try {
    return await Promise.race([crossed.catch(() => {
      /* A state stream that failed is a facade not on this ledger. */
      return false;
    }), late]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * **THE PART THAT PAYS, READ UP TO DATE ON THIS WALLET'S LEDGER**, called once its first read has finished. A part
 * replaying the earlier ledger reports itself complete when it reaches the fork, then moves to this ledger and reads
 * on from there; read at that moment, it holds none of the coins received since (15 Nov, preprod: "holds nothing in
 * 0 available coins" with 1,000 tokens held). So whether the first read was made on this ledger is asked at once;
 * the facade is then given up to `waitMs` to reach it; and a first read made before it is made again (`readUp`).
 * False when the facade never reached this ledger, and nothing is read again: the caller refuses in its own words.
 */
export const readOnThisWalletsLedger = async (
  facade: Pick<WalletFacade, 'state'>, readUp: () => Promise<void>, waitMs?: number,
): Promise<boolean> => {
  const readOnThisLedger = await actsOnThisWalletsLedger(facade, 0);
  if (!await actsOnThisWalletsLedger(facade, waitMs)) return false;
  if (!readOnThisLedger) await readUp();
  return true;
};

/** Why a path read nothing and paid nothing when the facade is not on this wallet's ledger, and what clears it. */
export const NOT_ON_THIS_WALLETS_LEDGER = 'this wallet could not learn from the network which ledger version the chain '
  + 'is on when it opened, so it read nothing and paid nothing. It asks the network again the next time it is asked to pay.';
