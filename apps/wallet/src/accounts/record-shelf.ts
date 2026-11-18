import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import type { Secret } from 'midnight-identity/keys/derivation';
import { claimFingerprint, heldWallet, keyFor, openWalletId } from './wallets-held.js';

/**
 * WHICH COMPARTMENT A SECRET'S RECORDS BELONG IN — and the whole of the
 * wrong-wallet safety on the WRITE side.
 *
 * Before this change every reader carried the same check — a record naming a
 * different secret reads as absent — and that was enough, because there was
 * one compartment and a foreign record could only ever be a leftover. With
 * several compartments a WRITER that picked the wrong one would not show
 * wallet B's names over wallet A; it would DESTROY B's names with A's, which
 * no reader-side check can undo. So the check moves to both ends.
 *
 * The answer is always THIS WINDOW'S OPEN WALLET (`openWalletId`), and the
 * only question is whether the secret in hand is that wallet's:
 *
 *   - the slot's fingerprint matches — the ordinary case;
 *   - the slot has no fingerprint on record — a wallet that predates this
 *     change, whose secret was sealed before there was anywhere to write one.
 *     The secret is here now, so it is written down once (`claimFingerprint`);
 *   - the slot's fingerprint is something else — the caller is holding a
 *     wallet this window does not have open. Readers answer as they always
 *     did, with absence; writers refuse.
 *
 * Nothing is registered yet on a landing in flight (`saveSecret` writes the
 * entry itself), so an unknown slot is this window's and is used as it is.
 */
export function slotOf(secret: Secret): string | null {
  const id = openWalletId();
  const fingerprint = toBase64Url(fingerprintOf(secret));
  const registered = heldWallet(id)?.fingerprint ?? null;
  if (registered !== null) return registered === fingerprint ? id : null;

  /* Nothing registered. The RECORDS are then the evidence, and they are
   * better evidence than the index: every one of them was written by the
   * secret whose fingerprint it carries. */
  const onDisk = fingerprintsInSlot(id);
  if (onDisk.length === 0) return id;
  if (!onDisk.includes(fingerprint)) return null;
  claimFingerprint(id, fingerprint);
  return id;
}

/**
 * EVERY FINGERPRINT WRITTEN INTO ONE COMPARTMENT, off the records themselves.
 *
 * This is what identifies an older wallet: its keyring is sealed
 * and carries no name, but five of its seven records were written by
 * `fingerprintOf(secret)` and say so in the clear. **The secret never has to
 * be opened to find out whose compartment this is.**
 *
 * A LIST RATHER THAN ONE VALUE, because two records disagreeing is a state
 * this browser could historically reach (records were overwritten in place,
 * one writer at a time) and the honest reading of it is *the wallet whose
 * record is here is at home* — not *the compartment belongs to whichever
 * record I happened to read first*.
 */
function fingerprintsInSlot(walletId: string): readonly string[] {
  const found = new Set<string>();
  for (const kind of ['wallet-name', 'subwallets', 'secured', 'arrived', 'created'] as const) {
    const raw = localStorage.getItem(keyFor(walletId, kind));
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as { fingerprint?: unknown };
      if (typeof parsed?.fingerprint === 'string' && parsed.fingerprint !== '') {
        found.add(parsed.fingerprint);
      }
    } catch {
      /* Damaged is not evidence. The record's own reader says so too. */
    }
  }
  return [...found];
}

/** As `slotOf`, for the writers — a refusal rather than a wrong shelf. */
export function slotToWrite(secret: Secret): string {
  const slot = slotOf(secret);
  if (slot === null) {
    throw new Error(
      'this window has a different wallet open than the one being written to. '
      + 'Nothing was written. This is a defect: two wallets are never unlocked '
      + 'at once, so a secret in hand is always the open wallet\u2019s.');
  }
  return slot;
}
