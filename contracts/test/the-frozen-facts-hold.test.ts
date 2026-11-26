/**
 * THE FACTS A DEPLOYED CONTRACT KEEPS FOR GOOD, HELD AGAINST THE BUILD AND THE WALLET.
 *
 * A contract on the chain never changes: its fields stay where they were, its derivations give what they gave, and
 * every signer's device, every vault and the wallet read it by those facts. The record (`contracts/frozen-facts.json`)
 * holds them for each released version, written from the build that was released and only ever added to: each entry is
 * pinned here by its digest. The build is held to the newest entry; the wallet is held to every entry still in force,
 * since it reads companies on all of them. A change that would leave deployed contracts unreadable or unspendable goes
 * red here before it ships. Whether an update keeps every approval, hold and payment already on the chain is held by
 * the update-replay test beside this record; this file freezes the derivations those call sites rest on.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { RELEASED_VERSIONS } from '../../packages/identity/src/wallet/released-versions.js';
import {
  ACCOUNT_THRESHOLD_FIELD, ADOPTED_VAULTS_FIELD, RETIRED_VAULTS_FIELD, ROLES_FIELD, SIGNER_LEAVES_FIELD, THRESHOLDS_FIELD,
} from '../../packages/identity/src/profile/account-state.js';
import { COMPANY_LABEL_ENTRY } from '../../packages/identity/src/profile/company-label.js';
import { PAY_KEY_COMMITMENT_ENTRY } from '../../packages/identity/src/profile/records-key.js';
import {
  MOVEMENTS_FIELD, OPEN_PROPOSALS_FIELD, VAULT_ACCOUNT_FIELD, VAULT_FIELDS,
} from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { OPEN_PROPOSALS_FIELD as OPEN_PROPOSALS_FIELD_SHARED } from '../../packages/web-shared/src/account-anchors-read.js';
import { pureCircuits as V } from '../managed-vault/contract/index.js';
import { receiptColourIn } from './facts-at-an-address.js';
import {
  entryDigestOf, newestVersionIn, readFrozenFacts, RECORDED_CONTRACTS, versionsInForce, walletReadFactsOf, type VersionFacts,
} from './frozen-facts.js';
import { factsOfTheBuild } from './frozen-facts-of-the-build.js';

/** Each recorded version's entry, by the digest it was recorded with. A new version's line is printed by add-frozen-facts.ts. */
const PINNED: Readonly<Record<string, string>> = {
  '1': 'fe0d16f0320f61da884585258246fc892b829d4eb7654704ebd64e19a335b873',
};

const RECORD = readFrozenFacts();
const RECORDED = RECORD[String(newestVersionIn(RECORD))]!;
let built: VersionFacts;

beforeAll(async () => { built = await factsOfTheBuild(RECORDED); });

describe('the record is only ever added to, names released versions only, and its newest is the newest released', () => {
  it('every recorded version is exactly the entry it was recorded as', () => {
    /* RED WHEN a recorded version's facts are changed, or a version is added or removed without its pin. */
    expect(Object.keys(RECORD).sort()).toEqual(Object.keys(PINNED).sort());
    for (const [v, facts] of Object.entries(RECORD)) expect(entryDigestOf(facts), `version ${v}`).toBe(PINNED[v]);
  });

  it('every version in the record is on the released list, and the newest of each is the same version', () => {
    const released = RELEASED_VERSIONS.map((v) => v.version);
    /* RED WHEN the record holds a version the released list does not, or a newer version is released and its facts are not recorded. */
    for (const v of Object.keys(RECORD)) expect(released).toContain(Number(v));
    expect(newestVersionIn(RECORD)).toBe(RELEASED_VERSIONS[0]!.version);
  });
});

describe.each(RECORDED_CONTRACTS)('the %s of the newest released version, as built', (contract) => {
  it('keeps every field where it was, stored as it was, holding what it held', () => {
    /* RED WHEN a field is added, removed, moved, renamed or holds another shape: a deployed contract's fields are read by place. */
    expect(built[contract].fields).toEqual(RECORDED[contract].fields);
    expect(built[contract].slots).toEqual(RECORDED[contract].slots);
  });

  it('works out every derivation as it did, on both input sets', () => {
    /* RED WHEN a derivation's output changes on either side of a branch or range, or one is added or removed. */
    expect(built[contract].derivations).toEqual(RECORDED[contract].derivations);
  });

  it('has each proving circuit write the fields it wrote, and no other', () => {
    /* RED WHEN a proving circuit writes one more field or one fewer, or a circuit is added or removed. */
    expect(built[contract].writes).toEqual(RECORDED[contract].writes);
  });

  it('reads the same private state, keeps the same device fields, and calls other contracts with the same arguments', () => {
    /* RED WHEN a witness changes, a field a device keeps is renamed, added or retyped, or a call into another contract changes. */
    expect(built[contract].witnesses).toEqual(RECORDED[contract].witnesses);
    expect(built[contract].device).toEqual(RECORDED[contract].device);
    expect(built[contract].calls).toEqual(RECORDED[contract].calls);
  });
});

describe('what depends on a contract\'s own address', () => {
  it('every derivation inside the account that approvals, holds, run ids and batch payees are keyed on gives what it gave', () => {
    /* RED WHEN an approval or release nullifier, a governance or run id, or a batch payee's leaf is worked out another way. */
    expect(built.atAnAddress.account).toBe(RECORDED.atAnAddress.account);
    expect(built.atAnAddress.internal).toEqual(RECORDED.atAnAddress.internal);
  });

  it('each circuit keys a hold and an anchor seat on the account\'s address as it did, and a hold is released by the key it was placed under', () => {
    /* RED WHEN a call site passes its arguments in another order, or holdRun and releaseHold key a hold differently. */
    expect(built.atAnAddress.callSites).toEqual(RECORDED.atAnAddress.callSites);
    expect(new Set(built.atAnAddress.callSites.holderKeyOf!.map((s) => s.key)).size).toBe(1);
  });

  it('a vault mints each receipt in the colour it did, so the receipts it already keeps still pay', () => {
    /* RED WHEN a receipt's colour changes: a vault's kept colour and the receipts it already minted would no longer match. */
    expect(built.atAnAddress.vault).toBe(RECORDED.atAnAddress.vault);
    expect(built.atAnAddress.receiptColours).toEqual(RECORDED.atAnAddress.receiptColours);
  });

  it('the account accepts each receipt in the colour the vault mints it', async () => {
    /* RED WHEN the account and the vault work out a receipt's colour differently: no payment, change or retirement could be recorded. */
    for (const [kind, tag] of [['payment', V.paymentReceiptTag()], ['change', V.changeReceiptTag()], ['retire', V.retireReceiptTag()]] as const) {
      expect(await receiptColourIn('account', tag, RECORDED.atAnAddress.vault), kind).toBe(RECORDED.atAnAddress.receiptColours[kind]);
    }
  });
});

describe('the wallet finds a person\'s registry entries as it did', () => {
  it('works out the same registry key, sealing key and tags on every network, and seals an entry the recorded way', () => {
    /* RED WHEN a registry key, sealing key or tag is worked out another way, or an entry is sealed with another layout or binding. */
    expect(built.registry.inTheWallet).toEqual(RECORDED.registry.inTheWallet);
  });
});

describe.each(versionsInForce(RECORD))('the wallet reads a company on version %s by that version\'s recorded places', (_, facts) => {
  it('every field the wallet reads the account and the vault by is the recorded field of that name', () => {
    const recorded = walletReadFactsOf(facts);
    /* RED WHEN a wallet field constant names a place a version still in force does not give that field: the wallet would read another field's value. */
    expect(ROLES_FIELD).toBe(recorded['account field signerRoles']);
    expect(SIGNER_LEAVES_FIELD).toBe(recorded['account field signerLeaves']);
    expect(ACCOUNT_THRESHOLD_FIELD).toBe(recorded['account field threshold']);
    expect(THRESHOLDS_FIELD).toBe(recorded['account field thresholds']);
    expect(ADOPTED_VAULTS_FIELD).toBe(recorded['account field vaults']);
    expect(RETIRED_VAULTS_FIELD).toBe(recorded['account field retiredAt']);
    expect(MOVEMENTS_FIELD).toBe(recorded['account field movements']);
    expect(OPEN_PROPOSALS_FIELD).toBe(recorded['account field openProposals']);
    expect(OPEN_PROPOSALS_FIELD_SHARED).toBe(recorded['account field openProposals']);
    expect(VAULT_ACCOUNT_FIELD).toBe(recorded['vault field account']);
    expect(VAULT_FIELDS).toBe(recorded['vault field count']);
  });

  it('the entries the wallet looks up in signerRoles are the recorded keys', () => {
    const recorded = walletReadFactsOf(facts);
    /* RED WHEN the wallet looks for the company's label or the pay-record key's commitment under a key a version in force never writes. */
    expect(COMPANY_LABEL_ENTRY).toBe(recorded['entry key companyLabelKey']);
    expect(PAY_KEY_COMMITMENT_ENTRY).toBe(recorded['entry key payKeyCommitmentKey']);
  });
});
