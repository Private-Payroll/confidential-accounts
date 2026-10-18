/**
 * **THE DEPOSIT COINS THIS DEVICE HAS BELIEVED FOR A VAULT, KEPT ON THIS DEVICE
 * AND SEALED UNDER THE SIGNER'S OWN KEY, AND HANDED TO ANOTHER SIGNER AS A FILE.**
 *
 * A deposit's note is found again from the chain only with its coin, or its
 * amount: a commitment cannot be turned back into one. The company's journals
 * hold every coin, and the company's service keeps the journals; so each
 * signer's device also keeps the coins it has read in a journal it believed,
 * and its own deposits once they land, in the same sealed store its records of
 * a step on its way use (`in-flight-on-this-device.ts`, kind `coins`). A
 * rebuild of the vault's notes reads them as well as the journals, so a service
 * that withholds the journals and the pool cannot leave a deposit unfound on a
 * device that has seen it.
 *
 * **A KEPT OR HANDED COIN IS ONLY A CANDIDATE.** Nothing here makes a note:
 * the rebuild believes a coin only where the chain holds or made its
 * commitment, so a coin kept wrongly, or forged in a file, names nothing.
 *
 * **NOTHING HERE IS SENT TO THE COMPANY'S SERVICE.** The kept coins never leave
 * this browser except in a file the signer saves and hands to another signer
 * themselves (`coinsFileText`, `coinsFileRead`). A coin with the chain confirms
 * an amount, so the file is sealed under the company's `vaults` purpose key,
 * the key every signer holds for what the company says about its vaults (the
 * one a vault's name is sealed under): the file shows only that it is one, and
 * opens only with this company's key.
 */
import { canonical, parseCanonical, seal, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { purposeKey } from '../../../src/core/sealed-records.js';
import { openedWithAnyKey, sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { openInFlight, sealInFlight, slotFor, type InFlightOpener, type InFlightRecords } from './in-flight-on-this-device.js';

/** One coin as it is kept and handed over: its nonce and token as 64 lower-case hex characters, its value in decimal digits. */
export interface CoinKept {
  readonly nonce: string;
  readonly token: string;
  readonly value: string;
}

/** The coins this device keeps for each vault. */
export interface CoinsKeptHere {
  coins(vault: Hex): Promise<readonly CoinKept[]>;
  /** Adds coins to what is kept for the vault; a coin kept already is kept once. */
  keep(vault: Hex, coins: ReadonlyArray<{ readonly nonce: string; readonly token: string; readonly value: bigint | string }>): Promise<void>;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const DIGITS = /^[1-9][0-9]*$/u;
const KEEP_ATTEMPTS = 5;

/** A coin in the one spelling kept, or null when it is not one. */
const coinKept = (c: { readonly nonce?: unknown; readonly token?: unknown; readonly value?: unknown } | null | undefined): CoinKept | null => {
  const nonce = String(c?.nonce ?? '').toLowerCase();
  const token = String(c?.token ?? '').toLowerCase();
  const value = typeof c?.value === 'bigint' ? c.value.toString() : String(c?.value ?? '');
  return HEX64.test(nonce) && HEX64.test(token) && DIGITS.test(value) ? { nonce, token, value } : null;
};
const keyOf = (c: CoinKept): string => `${c.nonce}:${c.token}:${c.value}`;

/**
 * The coins kept on this device for this signer. Two tabs adding at once each
 * write only over the record they read, so neither's coins are dropped: a lost
 * write reads again and adds its coins to what it finds.
 */
export function coinsKeptOnThisDevice(records: InFlightRecords, me: InFlightOpener): CoinsKeptHere {
  const read = async (vault: Hex) => {
    const sealed = await records.get(slotFor(me, 'coins', vault));
    const opened = sealed === null ? null : openInFlight<{ coins?: unknown }>(me, 'coins', vault, sealed);
    const coins = Array.isArray(opened?.coins) ? (opened!.coins as unknown[]).map((c) => coinKept(c as never)).filter((c): c is CoinKept => c !== null) : [];
    return { sealed, coins };
  };
  return {
    coins: async (vault) => (await read(vault)).coins,
    keep: async (vault, coins) => {
      const adding = coins.map((c) => coinKept(c)).filter((c): c is CoinKept => c !== null);
      if (adding.length === 0) return;
      for (let attempt = 1; attempt <= KEEP_ATTEMPTS; attempt += 1) {
        const now = await read(vault);
        const all = new Map(now.coins.map((c) => [keyOf(c), c]));
        const before = all.size;
        for (const c of adding) if (!all.has(keyOf(c))) all.set(keyOf(c), c);
        if (all.size === before && now.sealed !== null) return;
        const next = sealInFlight(me, 'coins', vault, { coins: [...all.values()] });
        const slot = slotFor(me, 'coins', vault);
        if (now.sealed === null ? await records.add(slot, next) : await records.replace(slot, now.sealed.claim, next)) return;
      }
      throw new Error('the coins this device keeps for this vault were written by another tab at the same time on every attempt, '
        + 'so these were not added. Nothing kept before is lost; open the vault again to add them.');
    },
  };
}

/** The format a file of coins is written in, named so a file of anything else is never read as one. */
const COINS_FILE_FORMAT = 'confidential-accounts/vault-coins/v1';

/** A file of coins handed from one signer to another, refused by name when it is not one. */
class CoinsFileUnreadable extends Error {
  constructor(why: string) {
    super(`this is not a file of this vault's coins (${why}), so nothing in it was taken. Ask the signer who saved it to save it again.`);
    this.name = 'CoinsFileUnreadable';
  }
}

/** The company a file of coins is sealed for: its id, and the keys this device holds of it. */
export interface CoinsFileCompany {
  readonly id: string;
  readonly keys: KeysHeld;
}

const COINS_PURPOSE = 'vaults' as const;

/** The text of a file of a vault's coins, sealed for the company's signers, for the signer to save and hand to another signer. */
export const coinsFileText = (vault: Hex, coins: readonly CoinKept[], company: CoinsFileCompany): string => {
  const { key, epoch } = sealingWith(company.keys, 0);
  const body = { format: COINS_FILE_FORMAT, vault: String(vault).toLowerCase(), coins: coins.map((c) => coinKept(c)).filter((c) => c !== null) };
  return `${JSON.stringify({ format: COINS_FILE_FORMAT, epoch, sealed: seal(canonical(body), purposeKey(key, company.id, COINS_PURPOSE)) }, null, 2)}\n`;
};

/** The coins a file names for this vault, each in the one spelling; a file of another company, vault or format is refused. */
export function coinsFileRead(text: string, vault: Hex, company: CoinsFileCompany): CoinKept[] {
  let outer: { format?: unknown; sealed?: unknown };
  try {
    outer = JSON.parse(text) as typeof outer;
  } catch {
    throw new CoinsFileUnreadable('it is not written as this product writes one');
  }
  if (outer?.format !== COINS_FILE_FORMAT || outer.sealed === null || typeof outer.sealed !== 'object') {
    throw new CoinsFileUnreadable('it does not say it is a file of coins');
  }
  let parsed: { format?: unknown; vault?: unknown; coins?: unknown };
  try {
    parsed = openedWithAnyKey(company.keys, (key) => parseCanonical<typeof parsed>(unseal(outer.sealed as Sealed, purposeKey(key, company.id, COINS_PURPOSE))));
  } catch {
    throw new CoinsFileUnreadable('it does not open with this company\'s key: it was sealed for another company, or under a key this device does not hold');
  }
  if (parsed?.format !== COINS_FILE_FORMAT) throw new CoinsFileUnreadable('what is sealed inside does not say it is a file of coins');
  if (String(parsed.vault ?? '').toLowerCase() !== String(vault).toLowerCase()) throw new CoinsFileUnreadable('it is for another vault');
  if (!Array.isArray(parsed.coins)) throw new CoinsFileUnreadable('it holds no list of coins');
  const coins = parsed.coins.map((c) => coinKept(c as never));
  if (coins.some((c) => c === null)) throw new CoinsFileUnreadable('a coin in it is not a nonce, a token and an amount');
  return coins as CoinKept[];
}
