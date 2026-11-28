/**
 * THE SIGNERS OF AN ACCOUNT DEPLOYED FROM THIS MACHINE: REAL IDENTITIES, BORN HERE AND KEPT OUT OF THE REPOSITORY.
 *
 * **WHY NOT A FORMULA.** A signer's identity computed from a small integer by a
 * formula in this repository is an identity any reader can compute, from any
 * machine, for ever; two of them is a threshold on a 2-of-N account, and a
 * threshold is what stands between a reader and every `recordPayment` that moves
 * a vault's money. Deterministic bytes are right for a payload, a batch digest or
 * a salt that two processes must agree on and nobody's money depends on. They are
 * wrong for an IDENTITY: real devices generate their keys with
 * `newSigningKeypair` and their blindings with `newBlinding`, and so does this.
 *
 * **WHY A FILE AT ALL.** The deploy seats a signer's leaf on chain, and a later
 * run has to prove membership of that same leaf, minutes later, in a DIFFERENT
 * PROCESS. Two processes agreeing on an identity means either a formula both can
 * compute, or a value one writes down and the other reads. `.midnight/` is kept
 * out of the repository for exactly this: it already holds the wallet seed and
 * the maintenance authority.
 *
 * **PER ACCOUNT, NEVER SHARED.** One file for every account would let the second
 * account's run overwrite the first's signers in place, and the first account's
 * pool could no longer be opened. The account id is in the filename, and
 * `assertPreviewAccountId` is why it can only ever be a filename.
 *
 * **NEVER OVERWRITTEN.** A file that exists is REUSED, exactly as `wallet.seed`
 * is. Regenerating on a redeploy would strand every signer already seated on
 * chain under the previous material.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { newSigningKeypair, newBlinding, fromHex, type Hex } from '../src/core/crypto.js';

/**
 * An account id a person chose, narrowed because it becomes a FILENAME.
 *
 * The same rule and the same reason as `assertVaultName`
 * (`src/midnight/vault-record.ts:115`): lowercase, digits and single hyphens,
 * 2–48 characters, starting and ending with an alphanumeric. `.` and `..`
 * cannot be spelled under it, and neither can a slash, so an id can neither
 * escape `.midnight/` nor shadow another account's material.
 *
 * NOT IMPORTED FROM `vault-record.ts`. That function's refusal talks about
 * vaults, and a wrong-sounding error is how a person is sent to the wrong file.
 * The RULE is shared by being identical and stated in both places; if it ever
 * needs to differ, it can.
 */
const ID_RULE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,47}$/;

export function assertPreviewAccountId(accountId: string): string {
  if (typeof accountId !== 'string' || !ID_RULE.test(accountId)) {
    throw new Error(
      `"${String(accountId)}" is not a usable account id for a signer file. It becomes a ` +
        'FILENAME under .midnight/, so it is lowercase letters, digits and single hyphens, ' +
        '2 to 48 characters, starting and ending with a letter or digit — an id carrying a ' +
        'slash or a dot is one that can escape the directory or shadow another account.'
    );
  }
  return accountId;
}

/** Where one account's demo signer material lives. Per network AND per account. */
export const previewSignersFile = (stateDir: string, network: string, accountId: string): string =>
  join(stateDir, `${network}-preview-signers-${assertPreviewAccountId(accountId)}.json`);

/** One device's identity: the two values its leaf is committed from. */
export interface PreviewSigner {
  /** 32 bytes from `newSigningKeypair`. The contract hashes this into a public key. */
  signingSecret: Hex;
  /** 32 bytes from `newBlinding`. What makes the published leaf inert. */
  blinding: Hex;
}

/**
 * THE FIVE THE PREVIEW SCRIPTS USE, AND THE NAMES ARE THE SCRIPTS' OWN.
 *
 * A is the FOUNDING signer — the seat the constructor creates. B is seated
 * through the bootstrap window, C through an approved proposal, and D and E
 * exist because four signers is the smallest account in which somebody can be
 * removed from the MIDDLE.
 */
export const PREVIEW_SIGNER_IDS = ['A', 'B', 'C', 'D', 'E'] as const;
export type PreviewSignerId = (typeof PREVIEW_SIGNER_IDS)[number];

export type PreviewSigners = Record<PreviewSignerId, PreviewSigner>;

interface PreviewSignersRecord {
  /** What wrote it, so a person reading the file knows what it is for. */
  note: string;
  network: string;
  accountId: string;
  createdAt: string;
  signers: PreviewSigners;
}

/**
 * **PARSED, NOT CAST.** A truncated or hand-edited file is a refusal here
 * rather than a signer whose leaf is not in the tree — which surfaces minutes
 * later, on chain, as *"you are not a signer on this account"* against a
 * contract that deployed perfectly. That message is the most expensive one this
 * project has, and every hour it has cost was spent looking at the contract.
 */
export function parsePreviewSigners(raw: unknown, file: string): PreviewSigners {
  const r = raw as Partial<PreviewSignersRecord>;
  const out = {} as PreviewSigners;
  for (const id of PREVIEW_SIGNER_IDS) {
    const s = r?.signers?.[id];
    const ok = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
    if (!s || !ok(s.signingSecret) || !ok(s.blinding)) {
      throw new Error(
        `${file} does not carry usable material for signer ${id}. Each of the five signers ` +
          'needs a `signingSecret` and a `blinding` of 64 hex characters. Delete the file to ' +
          'have a new set generated — every signer already seated on chain under the old ' +
          'material becomes unreachable when you do, so a redeploy comes with it.'
      );
    }
    out[id] = { signingSecret: s.signingSecret, blinding: s.blinding };
  }
  return out;
}

/**
 * Read this account's signers, or make them once.
 *
 * **THE ENTROPY IS REAL AND IT IS THE POINT.** `newSigningKeypair`
 * (`src/core/crypto.ts:26`) draws from `ed25519.utils.randomSecretKey` and
 * `newBlinding` (`:107`) from `randomBytes(32)`. Nothing here derives from a
 * seed, an index or a name, so nothing in this repository names any of these
 * five.
 *
 * **THE DEMO SCRIPT STANDS IN FOR FIVE PEOPLE'S DEVICES AND THIS FILE SAYS SO
 * RATHER THAN PRETENDING OTHERWISE.** On a real deployment each signer's
 * material is born on their own device and only their LEAF ever travels; here
 * one machine plays all five, so all five secrets are on this disk. What that
 * buys is the property that matters for a public repository: **the material is
 * not in the repository, and no reader of it can compute any of these
 * identities.**
 */
export function readOrCreatePreviewSigners(
  stateDir: string,
  network: string,
  accountId: string
): { signers: PreviewSigners; file: string; created: boolean } {
  const file = previewSignersFile(stateDir, network, accountId);
  if (existsSync(file)) {
    return { signers: parsePreviewSigners(JSON.parse(readFileSync(file, 'utf8')), file), file, created: false };
  }
  const signers = {} as PreviewSigners;
  for (const id of PREVIEW_SIGNER_IDS) {
    signers[id] = { signingSecret: newSigningKeypair().secret, blinding: newBlinding() };
  }
  const record: PreviewSignersRecord = {
    note:
      'Demo signer material for an account deployed from this machine, drawn from real entropy ' +
      'and kept out of the repository: nothing in the repository may grant a seat on an account. ' +
      'Deleting this file strands every signer already seated on chain from it.',
    network,
    accountId,
    createdAt: new Date().toISOString(),
    signers
  };
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  // 0o600, as the wallet seed is written: this is key material on a shared disk.
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { signers, file, created: true };
}

/** The two values as the private state and the leaf circuits want them. */
export const signerBytes = (s: PreviewSigner): { secretKey: Uint8Array; blinding: Uint8Array } => ({
  secretKey: fromHex(s.signingSecret),
  blinding: fromHex(s.blinding)
});
