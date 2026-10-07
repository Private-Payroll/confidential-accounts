import { privateAmount, type PrivateAmount } from 'vaults-ui';
import { assets, type AssetRegistry } from '../../../../src/core/assets.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import type { Hex } from '../../../../src/core/crypto.js';
import { SealedNotePool } from '../../../../src/midnight/vault-pool.js';
import { deviceVaultHoldings } from 'vaults-web-shared/device-vault-holdings.js';
import { api, companyKeyReleasedFor, currentUser } from 'vaults-web-shared/keyring.js';
import { deviceRecordsFor, deviceSignerFrom, readersIn, vaultServiceFor } from 'vaults-web-shared/vault-page-doors.js';
import { wireOf } from 'vaults-web-shared/vault-operation.js';
import { Fault, FAULT } from '../faults.js';
import { companyRoute } from './handover-state.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { directoryHereFor, filingJudgeFor, openedHere } from './filing-judge.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { theVaultBuilder } from './vault-builder.js';

/*
 * WHAT A VAULT HOLDS PRIVATELY, READ ON THIS DEVICE, HANDED TO A SCREEN AS
 * AMOUNTS.
 *
 * A vault's private money is its notes, and the record of them is sealed so
 * that only a signer's own key opens it; so it is read here or nowhere. The
 * reader is the shared one the legacy page's payments use
 * (`deviceVaultHoldings`), given the same doors: the vault's pool opened with
 * the records key this signer's wallet released for the company, filed under
 * their seat, the seats the company's directory names as the ones the pool is
 * wrapped to, the company's service asked what the
 * chain holds for the vault, and each note's commitment worked out in the
 * page's vault worker. The pool is believed only when a seat the company's
 * directory names filed it, checked against a fresh read by the person's own
 * wallet. The notes are summed only when the pool and the chain agree both
 * ways. Nothing it reads leaves this device; the vault's address
 * goes out to ask the chain.
 *
 * Each amount is made with `privateAmount`, from the decimals and symbol of the
 * asset whose private token it is, so a screen never holds a number it could
 * show as money. None of the reader's words are handed on.
 */

/** The pool's record, and the form private money takes on the ledger: the shared code's names, passed and never shown. */
const LEDGER = { pool: 'pool', shielded: 'shielded' } as const;

/** What a vault holds privately, as a screen shows it: one amount for each token it holds any of, in the registry's order. */
export interface VaultPrivateMoney {
  readonly amounts: readonly PrivateAmount[];
}

/**
 * WHAT THE VAULT `vault` OF THE COMPANY `companyId` HOLDS PRIVATELY, for the
 * person `personId`, or `null` when it could not be read: nobody or somebody
 * else is signed in, this device holds no keys for the company, its pool
 * could not be opened, the chain could not be asked, the pool and the chain
 * disagree, or two assets name the same private token. Null is never shown
 * as nothing held. A token it holds none of is not listed.
 */
export async function readVaultPrivateMoney(
  personId: string, companyId: string, vault: string, registry: AssetRegistry = assets,
): Promise<VaultPrivateMoney | null> {
  try {
    if (!(await keyringFor(personId))) return null;
    const sealed = await api(companyRoute(companyId)) as SealedAccount;
    const me = await keysOnTheWayIn(companyId, async () => sealed);
    if (me === null) return null;
    const account = await openedHere(sealed);
    if (account === null) return null;
    const builder = await theVaultBuilder();
    const label = sealed.companyLabel ?? null;
    const address = sealed.contractAddress ?? null;
    if (label === null || address === null) return null;
    /* The company key this tab's wallet already released; a read asks the wallet for nothing, so without it nothing is read. */
    const companyKey = companyKeyReleasedFor(companyId);
    if (companyKey === null) return null;
    /* This signer's seat, worked out from their own key material, and the records key their wallet gives: what their copy is filed under and wrapped to. */
    const scope = (me as { scope?: Hex }).scope;
    const seat = await builder.ownSeat({ signingSecret: me.signingSecret, blinding: me.blinding, ...(scope === undefined ? {} : { scope }) });
    const mine = deviceSignerFrom(seat, companyKey);
    /* Believed only when a seat the directory names filed it, checked against a fresh read by this person's own wallet. */
    const judge = filingJudgeFor(companyId, label as CompanyLabel, address as AccountAddress, async () => account);
    const readers = readersIn(directoryHereFor(companyId, label as CompanyLabel, address as AccountAddress, async () => account));
    const records = deviceRecordsFor(me.signingSecret, judge, () => currentUser()?.id ?? null);
    const pool = new SealedNotePool(records(LEDGER.pool), { signerId: mine.signerId, wrappingSecret: mine.wrappingSecret }, readers.signers);
    const holdings = deviceVaultHoldings({
      chain: (v) => vaultServiceFor(api, account.id, async () => account).chain(v),
      pool: async (v) => (await pool.load(v)).notes,
      heldCommitmentOf: async (v, note) => (await builder.commitments({ vault: v, coin: wireOf(note) })).held,
      /* Only what the vault holds is read here; whether payments fit is asked where a payment is made. */
      paymentsFit: () => { throw new Fault(FAULT.vaultPaymentsNotAsked); },
    });
    const tokens = new Set<string>();
    const amounts: PrivateAmount[] = [];
    for (const asset of registry.all()) {
      const token = asset.ledger.shielded;
      if (typeof token !== 'string') continue;
      if (tokens.has(token.toLowerCase())) return null;
      tokens.add(token.toLowerCase());
      const held = await holdings.held(vault, LEDGER.shielded, token);
      if (held.of !== 'held') return null;
      if (held.amount > 0n) amounts.push(privateAmount(held.amount, asset.decimals, asset.symbol));
    }
    return { amounts };
  } catch {
    return null;
  }
}
