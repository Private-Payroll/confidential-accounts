/**
 * **A VAULT'S NAME AND DESCRIPTION, KEPT AS ONE OF THE COMPANY'S OWN RECORDS.**
 *
 * One record per vault, filed under the vault's address, a new version each
 * time an admin changes it. It is sealed under the vaults key derived from the
 * company's key, which every seat holds - so every signer
 * reads it, a signer seated later included, and no list of readers is kept
 * beside it. A signer who has left holds only the keys from before they left,
 * so a version filed after the company's key changed is closed to them.
 *
 * What is sealed names the record it was filed as (company, vault, version),
 * and is padded to one size that holds the longest name and description
 * allowed (`VAULT_INFO_SEALED_BYTES`), so the service holding it learns
 * neither the name nor how long it is, and cannot pass one vault's name off as
 * another's.
 *
 * Nothing the company does with money reads this record: it is what the
 * screens show a vault as.
 */
import { canonical, parseCanonical, seal, unseal, type Hex } from '../core/crypto.js';
import { purposeKey } from '../core/sealed-records.js';
import type { SealedCompanyRecord } from './sealed-record-wire.js';

/** The kind of company record a vault's name and description are filed as. */
export const VAULT_INFO_KIND = 'vault-info' as const;
/** The company key's purpose the record is sealed under. */
export const VAULT_INFO_PURPOSE = 'vaults' as const;
/** The longest name a vault is given, in characters. */
export const VAULT_NAME_MOST = 64;
/** The longest description a vault is given, in characters. */
export const VAULT_DESCRIPTION_MOST = 1000;

/** What a vault is called, and what it is for. */
export interface VaultInfo {
  readonly name: string;
  readonly description: string;
}

/** A name or description refused, or a record that does not open as one. Nothing was sealed or believed from it. */
export class VaultInfoRefused extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(why, options);
    this.name = 'VaultInfoRefused';
  }
}

/**
 * The one size every vault's name and description is padded to before it is
 * sealed, in bytes: room for the longest name and description, every character
 * four bytes, and 512 bytes for the label and the record's own punctuation.
 */
export const VAULT_INFO_SEALED_BYTES = 4 * (VAULT_NAME_MOST + VAULT_DESCRIPTION_MOST) + 512;

/* Pads `text` with spaces to exactly `VAULT_INFO_SEALED_BYTES`; JSON reads past the spaces. */
const paddedToTheOneSize = (text: string): string => {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > VAULT_INFO_SEALED_BYTES) throw new VaultInfoRefused('This vault\'s name and description do not fit the size every vault\'s is sealed at.');
  return text + ' '.repeat(VAULT_INFO_SEALED_BYTES - bytes);
};

const VAULT = /^[0-9a-f]{64}$/u;
/* A control character: none in a name; in a description, only a line break. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_BUT_A_LINE_BREAK = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const characters = (s: string): number => [...s].length;

/**
 * The name and description as they are kept: composed one way (NFC) so two
 * devices file the same text the same way, the name trimmed, each checked.
 * A name is 1 to 64 characters on one line; a description is up to 1,000
 * characters, line breaks allowed.
 */
export const vaultInfoTidied = (given: { readonly name: unknown; readonly description: unknown }): VaultInfo => {
  if (typeof given.name !== 'string' || typeof given.description !== 'string') {
    throw new VaultInfoRefused('A vault is given a name and a description, each as text.');
  }
  const name = given.name.normalize('NFC').trim();
  const description = given.description.normalize('NFC').trim();
  if (characters(name) < 1 || characters(name) > VAULT_NAME_MOST) {
    throw new VaultInfoRefused(`A vault's name is 1 to ${VAULT_NAME_MOST} characters, and this one is ${characters(name)}.`);
  }
  if (CONTROL.test(name)) throw new VaultInfoRefused('A vault\'s name is one line of text, with no line breaks or control characters.');
  if (characters(description) > VAULT_DESCRIPTION_MOST) {
    throw new VaultInfoRefused(`A vault's description is at most ${VAULT_DESCRIPTION_MOST} characters, and this one is ${characters(description)}.`);
  }
  if (CONTROL_BUT_A_LINE_BREAK.test(description)) {
    throw new VaultInfoRefused('A vault\'s description is text and line breaks, with no other control characters.');
  }
  return { name, description };
};

interface InfoLabel {
  readonly record: typeof VAULT_INFO_KIND;
  readonly company: string;
  readonly vault: string;
  readonly version: number;
}
const LABEL = '$label';

/**
 * Seals version `version` of `vault`'s name and description for `company`,
 * under `key` - the company's key at `keyEpoch` - for the vaults purpose. The
 * record still needs the filing seat's signature (`signCompanyFiling`).
 */
export const sealVaultInfo = (input: {
  readonly company: string;
  readonly vault: Hex;
  readonly version: number;
  readonly keyEpoch: number;
  readonly key: Hex;
  readonly info: VaultInfo;
}): SealedCompanyRecord => {
  const vault = String(input.vault).toLowerCase();
  if (!VAULT.test(vault)) throw new VaultInfoRefused('A vault\'s name is filed under the vault\'s address, and this is not one.');
  const info = vaultInfoTidied(input.info);
  const label: InfoLabel = { record: VAULT_INFO_KIND, company: input.company, vault, version: input.version };
  return {
    company: input.company, kind: VAULT_INFO_KIND, id: vault, version: input.version, keyEpoch: input.keyEpoch,
    sealed: seal(paddedToTheOneSize(canonical({ name: info.name, description: info.description, [LABEL]: label })),
      purposeKey(input.key, input.company, VAULT_INFO_PURPOSE)),
    wrapped: [],
  };
};

/**
 * Opens a vault's name and description with `key`, the company's key at the
 * epoch the record names. Refuses a record that will not open, one whose
 * sealed label names another company, vault or version than it is filed as,
 * and text the check would refuse.
 */
export const openVaultInfo = (rec: SealedCompanyRecord, key: Hex): VaultInfo => {
  if (rec.kind !== VAULT_INFO_KIND) throw new VaultInfoRefused('This record is not a vault\'s name and description.');
  let body: Record<string, unknown>;
  try {
    body = parseCanonical<Record<string, unknown>>(unseal(rec.sealed, purposeKey(key, rec.company, VAULT_INFO_PURPOSE)));
  } catch (e) {
    throw new VaultInfoRefused('This vault\'s name does not open with the company\'s key this device holds.', { cause: e });
  }
  const label = body?.[LABEL] as Partial<InfoLabel> | undefined;
  if (label?.record !== VAULT_INFO_KIND || label.company !== rec.company || label.vault !== rec.id || label.version !== rec.version) {
    throw new VaultInfoRefused('What is sealed inside this vault\'s name says it is another vault or another version than the one '
      + 'it is filed as, so it is not believed.');
  }
  return vaultInfoTidied({ name: body.name, description: body.description });
};
