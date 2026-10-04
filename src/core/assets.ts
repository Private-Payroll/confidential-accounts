/**
 * The asset registry, and the only place that knows how many decimal places a
 * token has. D10 and D11 in docs/scope-v1-data-model.md.
 *
 * **AN ASSET IS ITS LEDGER TOKEN.** Vaults only ever hold real tokens, so every
 * asset is identified by the 32-byte token type the ledger gives it: the same
 * value for its private notes and its public balance. Runs, run roots,
 * spending policies, the server, the device and the payment builders all name
 * an asset by that token, and a screen shows its symbol or name.
 *
 * TWO RULES, and everything here follows from them.
 *
 * 1. **Every amount is an integer in the asset's smallest unit.** 5,000 tUSD is
 *    `5000000000n`, at six decimal places. There is no float anywhere
 *    in this system and there must never be one: `0.1 + 0.2` is not `0.3`, so
 *    payroll totals drift by pennies and the drift gets blamed on us — and,
 *    worse, a JavaScript number cannot hold 18 significant digits at all, so an
 *    amount in a token with 18 decimals does not round, it silently loses value.
 *
 * 2. **Nothing about an asset is secret.** There is nothing confidential about
 *    the existence of a token, so this table is plaintext, and adding a
 *    token is a row rather than a release. What IS confidential is the
 *    pairing of an asset with an account, which is why the on-chain map is keyed
 *    by `assetKeyOf(assetId, accountBlinding)` and never by the token itself.
 *
 * The registry lives in code here, in `SEED_ASSETS` below. No database table
 * holds it yet; one that is added is seeded from that list, so there stays one
 * list rather than two, and it carries each row's ledger identity too.
 */

import { NETWORK as THE_NETWORK_THIS_BUILD_IS_ON } from 'midnight-identity/network';
import { isNetworkId, networkRecord, type NetworkKind } from './networks.js';

/**
 * **AN ASSET'S IDENTITY: ITS LEDGER TOKEN, AS 64 LOWER-CASE HEX CHARACTERS.**
 *
 * The raw token type the ledger gives the money. It is the same 32 bytes for a
 * token's private notes and for its public balance, so one token is one
 * identity in both forms. It is what a run's root commits to, what a spending
 * policy is keyed by, and what a vault hands the account when it pays.
 */
export type AssetId = string;

/** Whether a value is an asset identity: 64 lower-case hex characters. */
export const isAssetId = (value: unknown): value is AssetId =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export interface Asset {
  /**
   * **THE TOKEN.** 64 lower-case hex characters, the asset's identity
   * everywhere. The field keeps its name; what it holds is the ledger's token.
   */
  code: AssetId;
  /** What a screen shows for this token, such as `NIGHT` or `tUSD`. Never the token itself. */
  symbol: string;
  name: string;
  /**
   * How many of the smallest unit make one whole unit, as a power of ten.
   *
   * The only number in this system that converts between what a human types and
   * what everything else stores. It is on the asset and nowhere else, because a
   * second copy is how `500000` comes to mean five thousand dollars in one
   * place and half a token in another.
   */
  decimals: number;
  /**
   * **WHICH FORMS THIS TOKEN TAKES ON MIDNIGHT.**
   *
   * Money on Midnight is held in one of two forms, privately in notes or
   * publicly in a contract's balance. The ledger names both by the same token
   * type, so each form here is either `code` itself or `null`.
   *
   * `null` is a statement and not a gap: this token has no such form, so no
   * vault can hold it that way and no payment in it can be made that way. A
   * token has both forms or one, and a row stating a form that differs from
   * `code`, or stating neither, is refused when the registry is built.
   */
  ledger: LedgerIdentity;
  /**
   * Off means the asset exists and cannot be used. It is a switch rather than a
   * deletion because rows are referenced by sealed records we cannot rewrite —
   * an asset that has ever been held must stay resolvable forever, or its
   * balance becomes unreadable.
   */
  enabled: boolean;
  sortOrder: number;
}

/** The two forms money takes on Midnight: private notes, or a public balance. */
export type LedgerForm = 'shielded' | 'unshielded';

/**
 * An asset's token in each form, as the 64 lower-case hex characters the
 * ledger's own token types carry (the asset's `code`), or `null` where the
 * asset has no such form.
 */
export interface LedgerIdentity {
  readonly shielded: string | null;
  readonly unshielded: string | null;
}

/**
 * **THE LEDGER'S OWN TOKEN TYPE FOR NIGHT, WHICH IS UNSHIELDED BY DEFINITION.**
 *
 * WRITTEN OUT RATHER THAN ASKED FOR, because this module is loaded by the page
 * and must not load the ledger's WebAssembly to learn one value. It is not a
 * second definition: `ledger-token.test.ts` reads `nativeToken().raw` from the
 * ledger itself and fails the day the two differ.
 */
export const NIGHT: AssetId = '0000000000000000000000000000000000000000000000000000000000000000';

const NIGHT_ON_THE_LEDGER: LedgerIdentity = Object.freeze({
  shielded: null,
  unshielded: NIGHT,
});

/**
 * The asset a governance round moves, which is none: the bytes of `NONE`,
 * zero padded, which is no ledger token.
 *
 * `addSigner`, `removeSigner` and `setThreshold` are approval rounds that move
 * no money — but they still go through `propose`, and `propose` commits to
 * `changeCommitmentOf(assetKey, amount, batch, salt)`, which needs an asset.
 * Passing a real one would be a lie in the ledger a client could read as "this
 * round concerns this token", and picking "whatever the account holds first" would
 * fail on an account that holds nothing, which every account does at the moment
 * it seats its second signer.
 *
 * So there is a reserved value that means no asset. It derives a perfectly valid
 * key and **that key can never appear in `assetBalances`**, because the only
 * circuits that write to the map are `credit` and `execute`, and no governance
 * circuit calls either. Deliberately NOT in the registry: it has no decimals,
 * nothing may be denominated in it, `require` refuses it like any other
 * unknown token, and a registry row carrying it is refused.
 */
export const NO_ASSET: AssetId = '4e4f4e4500000000000000000000000000000000000000000000000000000000';

/* ------------------------------------------------------------------ *
 * the test settlement asset, and the networks it may exist on
 * ------------------------------------------------------------------ */

/**
 * **THE ONLY ASSET IN THIS REGISTRY THAT CAN BE PAID PRIVATELY, AND IT IS
 * WORTHLESS ON PURPOSE.**
 *
 * A company pays in a token its vault holds. NIGHT
 * cannot be the settlement asset: `nativeToken()` is unshielded by definition,
 * so there is no private NIGHT and there never will be. A private payment
 * spends a shielded note, and a shielded note on Midnight is a MINTED token. So
 * a test stablecoin is what the private path can be walked with until a real
 * one is issued, and this row is it.
 *
 * **DECIMALS ARE NOT A CHAIN FACT.** On chain an amount is an integer; six
 * decimal places is only how `parseAmount` and `formatAmount` read and print
 * it. Six because that is what a dollar stablecoin uses, so the path this
 * exercises is the path the real one will take.
 *
 * **IT HAS NO PUBLIC FORM AND THE ROW MUST NOT CLAIM ONE.** Nothing has ever
 * minted an unshielded token of this asset and no circuit could send one, so
 * `unshielded` is `null` - a statement, not a gap.
 */
/**
 * **THE COLOUR, AND IT IS A REAL ONE ON A REAL CHAIN.**
 *
 * Sixty-four hex characters that a mint actually produced on stagenet and that
 * a settled transaction has already moved: the shielded deposit of 30 Aug
 * carries it, and the note it created is held by a vault on chain today.
 * **This is not a number chosen to look like one.** A colour nothing ever
 * minted is money no wallet can fund a deposit with, which is a payment that
 * fails after the approvals and the fee.
 *
 * **IT IS THE ONE VALUE HERE THAT A PERSON MAY CHANGE, AND ONLY BY MINTING.**
 * A fresh mint produces a fresh colour, and that colour is read off the mint's
 * own answer rather than derived, so the way to change it is to mint and put
 * the number the mint reports here. Changing it to anything else names money
 * that does not exist.
 */
const TEST_SETTLEMENT_COLOUR = 'abda184485c6abbbe4440d65b99ef88e0f79f61ec19af52a5bb0d91b4a824679';  // not-a-secret: the colour a mint produced on a public test network, published by the chain itself and readable by anyone; this is the asset's own identity and there is no other way to name it

/** The test settlement token's identity: its colour, which is its token type. */
export const TEST_SETTLEMENT_ASSET: AssetId = TEST_SETTLEMENT_COLOUR;

/**
 * **WHERE THE MONEY THIS COLOUR NAMES ACTUALLY IS, AND IT IS A CLOSED LIST.**
 *
 * A colour is produced by one mint on one chain, so this is a fact about the
 * ASSET rather than about any network: on any other chain this colour names
 * money that was never minted, and a payment in it fails after the approvals
 * and the fees have been paid for.
 *
 * **IT IS A LIST OF CHAINS THE MONEY IS ON AND NOT A LIST OF CHAINS IT IS NOT**:
 * a network nobody has thought of yet is refused by default rather than
 * admitted by default, and that is the whole difference.
 *
 * **IT IS NOT WHAT KEEPS THE ROW OFF A REAL CHAIN.** That is the network's own
 * `kind`, one function down. Two conditions, and the one that matters for
 * somebody's pay does not depend on anybody having remembered to write a name
 * down here.
 */
export const TEST_SETTLEMENT_MINTED_ON: readonly string[] = Object.freeze(['stagenet']);

/**
 * **A TEST ASSET MAY ONLY EXIST WHERE THE NETWORK'S OWN RECORD SAYS NO REAL
 * MONEY SETTLES, AND A NAME NEVER DECIDES THAT.**
 *
 * Three conditions, in the order they matter:
 *
 * 1. **The network must have a record at all.** A network nobody has written
 *    down is a network nobody has decided whether real pay settles on, so it
 *    gets the answer that cannot hurt anybody.
 * 2. **Its `kind` must be `test`.** This is the condition that stands between
 *    a worthless token and somebody's real pay, and it is read off the one
 *    record every part of this application reads. It used to be a list of names
 *    kept here - so a network that was real and was not on the list was
 *    admitted, and a network that was real and WAS spelled slightly differently
 *    was admitted too.
 * 3. **The colour must have been minted there.** A fact about the asset rather
 *    than the network, and the reason a test chain nobody has minted on gets
 *    nothing.
 *
 * **THE ANSWER IS COMPILED IN, NOT CONFIGURED.** The network reaches this
 * function from `midnight-identity/network` - one constant naming the network
 * both products are built for, not read from `.env`, from `process.env`, from a
 * build flag or from a hostname, and it CANNOT be: a Midnight address carries
 * the network name inside the string, so a deployment able to disagree with
 * that constant is a deployment writing addresses no wallet in the pair can
 * read.
 *
 * **THERE IS NO OVERRIDE AND NONE MAY BE ADDED.** Not an environment variable,
 * not a flag, not an argument with a default. A test asset reaching a real
 * chain is the worst thing in this file, and the way that happens is somebody
 * adding a way to say "yes, really".
 */
export const aTestAssetMayExistOn = (network: string): boolean =>
  isNetworkId(network)
  && aTestAssetMayExistOnAKindOf(networkRecord(network).kind, network);

/**
 * The two conditions, as a function of the two values they are about.
 *
 * **IT IS SEPARATE SO THE ONE THAT MATTERS CAN BE WATCHED REFUSING ON ITS
 * OWN.** With the real records the two hide each other: every network whose
 * record says real money settles there is also a network this colour was never
 * minted on, so a `kind` check that had stopped working would refuse anyway and
 * nothing would say. Handed a kind directly, it can be asked the question that
 * actually stands between a worthless token and somebody's pay.
 *
 * **IT IS NOT A WAY IN.** It answers about the values it is given and changes
 * nothing about what the registry asks: the registry passes the network this
 * build is compiled for, and the test beside this file pins that call.
 */
export const aTestAssetMayExistOnAKindOf = (kind: NetworkKind, network: string): boolean =>
  kind === 'test' && TEST_SETTLEMENT_MINTED_ON.includes(network);

/** Whether a token is one that exists only so the private path can be walked. */
export const isATestAsset = (code: AssetId): boolean => code === TEST_SETTLEMENT_ASSET;

/**
 * The test rows a given network gets, which is all of them or none of them.
 *
 * A function of the network name and nothing else, so every network this
 * toolchain knows can be asked the question in a test - including the ones
 * nobody runs.
 */
export function testAssetsFor(network: string): readonly Asset[] {
  if (!aTestAssetMayExistOn(network)) return [];
  return [{
    code: TEST_SETTLEMENT_ASSET,
    symbol: 'tUSD',
    name: 'Test Dollar',
    decimals: 6,
    ledger: Object.freeze({ shielded: TEST_SETTLEMENT_ASSET, unshielded: null }),
    enabled: true,
    sortOrder: 90,
  }];
}

/**
 * The registry every build runs on: the tokens a vault can actually hold.
 *
 * **ONLY REAL LEDGER TOKENS.** Every row is a token the ledger knows, in the
 * forms it actually takes. Money that has no token on Midnight is not a row,
 * because no vault can hold it and no payment in it can be made.
 *
 * **THE TEST SETTLEMENT ASSET IS APPENDED BY THE NETWORK AND NOT BY HAND.** On
 * any network it may not exist on, `testAssetsFor` returns nothing and its token
 * resolves to no asset at all - `require` refuses it exactly as it refuses a
 * token nobody has ever written down.
 */
export const SEED_ASSETS: readonly Asset[] = Object.freeze([
  { code: NIGHT, symbol: 'NIGHT', name: 'Night', decimals: 6, ledger: NIGHT_ON_THE_LEDGER, enabled: true, sortOrder: 50 },
  ...testAssetsFor(THE_NETWORK_THIS_BUILD_IS_ON),
] as const);

/* ------------------------------------------------------------------ *
 * whether an asset can be held and paid PRIVATELY
 * ------------------------------------------------------------------ */

/**
 * **CAN MONEY IN THIS ASSET BE PAID PRIVATELY?**
 *
 * **A FUNCTION AND NOT A LIST AT A CALL SITE**, because the answer changes for
 * every asset at once on the day the converter is deployed, and a screen that
 * hardcoded it would go on saying no afterwards. The unavailable side of the
 * private/public toggle is rendered from this, with `why` on the screen, so a
 * customer learns the product will do this and does not yet — rather than
 * concluding it never will.
 *
 * `why` is CUSTOMER-FACING and is audited as product copy.
 */
export type PrivateForm =
  | { readonly of: 'available' }
  | { readonly of: 'not-yet'; readonly why: string };

/**
 * **THE ANSWER IS READ OFF THE ASSET'S OWN ROW, AND IT IS YES FOR EXACTLY THE
 * ASSETS THAT HAVE A PRIVATE TOKEN.**
 *
 * Money is paid privately by sending a SHIELDED note, and a note has a colour.
 * An asset that states a private token has one to send; an asset that states
 * `null` does not, and no amount of wanting produces one.
 *
 * **NIGHT IS STILL NO, AND IT ALWAYS WILL BE** — `nativeToken()` is an
 * `UnshieldedTokenType`, so there is no private NIGHT and no converter changes
 * that.
 *
 * **THE CONVERTER IS STILL WHAT CHANGES THE REST**: it takes a public deposit
 * and mints a wrapped shielded token against it. Nothing in `src/` reaches a
 * converter and none is deployed.
 *
 * **TWO ANSWERS, BOTH READ OFF THE ROW.** Neither is a table of tokens,
 * because a table is the hardcoded list this exists to replace and it would go
 * on saying no for a token that had gained a form.
 */
export function privateForm(asset: Asset): PrivateForm {
  /*
   * **THE ROW FIRST, AND THIS IS THE WHOLE OF WHAT "AVAILABLE" MEANS.** The
   * asset has a token in the private form, so a note of it can be sent. It says
   * nothing about whether a particular vault holds any, which is a different
   * question asked by a different reader at the moment of payment.
   */
  if (ledgerFormOf(asset, 'shielded').of === 'token') return { of: 'available' };
  /*
   * **`why` SAYS WHAT THE AVAILABLE SIDE COSTS, NOT ONLY THAT THE OTHER SIDE IS
   * SHUT.** product-copy pass.
   *
   * This is the sentence beside the option a company cannot pick, which makes
   * it the sentence they read at the moment they settle for a public payment.
   * A string that says only *private is coming* leaves them reading public as
   * the ordinary temporary option, and nothing tells them it publishes the
   * recipient and the amount for good.
   *
   * **AND IT PROMISES NOTHING.** *"Still being built"* and *"will open later"*
   * were both here and both are commitments: no converter is deployed and
   * nothing in `src/` reaches one.
   */
  return {
    of: 'not-yet',
    why: `${asset.symbol} can only be paid publicly. Anyone can read the recipient's address and the amount.`,
  };
}

export interface AssetRegistry {
  /** Every asset, enabled or not. A held asset must stay resolvable forever. */
  all(): Asset[];
  /** The assets a person may choose from today. */
  enabled(): Asset[];
  find(code: AssetId): Asset | null;
  /** Throws with a readable message. Use this at every boundary. */
  require(code: AssetId): Asset;
}

export class StaticAssetRegistry implements AssetRegistry {
  private byCode: Map<AssetId, Asset>;

  constructor(assets: readonly Asset[] = SEED_ASSETS) {
    refuseAnAmbiguousLedgerIdentity(assets);
    refuseATestAssetOffItsNetwork(assets, THE_NETWORK_THIS_BUILD_IS_ON);
    this.byCode = new Map(assets.map(a => [a.code, { ...a, ledger: Object.freeze({ ...a.ledger }) }]));
  }

  all(): Asset[] {
    return [...this.byCode.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  enabled(): Asset[] {
    return this.all().filter(a => a.enabled);
  }

  find(code: AssetId): Asset | null {
    return this.byCode.get(code) ?? null;
  }

  require(code: AssetId): Asset {
    const a = this.find(code);
    if (!a) {
      throw new Error(
        `no asset in the registry is the token "${code}". Assets come from the registry, and an ` +
          'amount without one has no decimal place, so there is no safe default to fall back to.',
      );
    }
    return a;
  }
}

/**
 * **WHAT A PERSON IS SHOWN FOR A TOKEN: ITS SYMBOL, NEVER THE TOKEN ITSELF.**
 * A token the registry does not know, and the marker that is no token, are
 * named as such rather than printed.
 */
export function symbolOf(code: AssetId, registry: AssetRegistry = assets): string {
  return (code === NO_ASSET ? null : registry.find(code)?.symbol) ?? 'a token this app does not know';
}

/** The registry every caller gets unless it is handed another one. */
export const assets: AssetRegistry = new StaticAssetRegistry();

/* ------------------------------------------------------------------ *
 * the encoding the circuit sees
 * ------------------------------------------------------------------ */

/**
 * How an asset reaches the contract: the 32 bytes of its token.
 *
 * ONE DEFINITION, here, because both halves of `assetKeyOf` depend on the bytes
 * being identical, and because a run's root commits to the same 32 bytes the
 * vault hands the account when it pays: the spent coin's colour for a private
 * payment, the token sent for a public one. Both forms of a token are one value,
 * so a spending policy keyed by it covers both.
 *
 * Refuses anything that is not 64 lower-case hex characters, because any other
 * spelling of a token is money nobody holds.
 */
export const ASSET_ID_BYTES = 32;


export function assetIdBytes(id: AssetId): Uint8Array {
  if (!isAssetId(id)) {
    throw new Error(
      `"${String(id)}" is not an asset. An asset is its ledger token, written as 64 lower-case hex ` +
        'characters, and any other spelling of a token is money nobody holds.',
    );
  }
  const out = new Uint8Array(ASSET_ID_BYTES);
  for (let i = 0; i < ASSET_ID_BYTES; i++) out[i] = parseInt(id.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * An asset as hex: its token. What a payroll run's root commits to beside its
 * total, and so what a vault's spending policy is looked up by. Refuses what
 * `assetIdBytes` refuses.
 */
export function assetIdHex(id: AssetId): string {
  assetIdBytes(id);
  return id;
}

/**
 * **REFUSES THE MARKER THAT IS NO TOKEN AS THE ASSET OF A PAYMENT.** A round
 * that pays somebody names the token it pays in; `NO_ASSET` names none.
 */
export function refuseNoAssetAsPayment(id: AssetId): void {
  if (id === NO_ASSET) {
    throw new Error(
      'a payment has to name the token it pays in, and this one names no asset. Nothing was built.');
  }
}

/* ------------------------------------------------------------------ *
 * the token a payment moves on the ledger
 * ------------------------------------------------------------------ */

/**
 * **A REGISTRY IN WHICH A ROW IS NOT A TOKEN, TWO ROWS ARE ONE TOKEN, OR A
 * FORM NAMES ANOTHER TOKEN, IS REFUSED WHEN IT IS BUILT.**
 *
 * An asset is its token, so its `code` is 64 lower-case hex characters and
 * each form it has is that same token: the ledger names a token's private
 * notes and its public balance by one token type. A form naming a different
 * token would be a payment that commits to one token and moves another. Two
 * rows with one token would be two names for one balance. A row with no form
 * at all is money no vault can hold. A row with no symbol has nothing a screen
 * can show. Each is a mistake in a row, and a row is where it is caught.
 */
function refuseAnAmbiguousLedgerIdentity(rows: readonly Asset[]): void {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const label = typeof row?.symbol === 'string' && row.symbol.trim() !== '' ? row.symbol : String(row?.code);
    if (!isAssetId(row?.code)) {
      throw new Error(
        `${label}'s token is not 64 lower-case hex characters. An asset is its ledger token, `
        + 'compared byte for byte, so any other spelling of it is money nobody holds.');
    }
    if (row.code === NO_ASSET) {
      throw new Error(`${label} is the marker for no asset, which is no token and cannot be a row.`);
    }
    if (typeof row.symbol !== 'string' || row.symbol.trim() === '') {
      throw new Error(`the token ${row.code} has no symbol, so a screen would have nothing to call it.`);
    }
    const identity = (row as { ledger?: unknown }).ledger as Partial<LedgerIdentity> | undefined;
    if (identity === null || typeof identity !== 'object') {
      throw new Error(
        `${label} does not say what the ledger calls it. Every asset states its token for each `
        + 'form it has, or null where it has no such form, so that no payment has to guess.');
    }
    let forms = 0;
    for (const form of ['shielded', 'unshielded'] as const) {
      const token = identity[form];
      if (token === null) continue;
      if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
        throw new Error(
          `${label}'s ${formWord(form)} token is not 64 lower-case hex characters. A token is `
          + 'compared byte for byte, so any other spelling of it is money nobody holds.');
      }
      if (token !== row.code) {
        throw new Error(
          `${label}'s ${formWord(form)} form names a different token from the asset itself. The ledger `
          + 'names both forms of a token by the same token type, so a payment committing to one '
          + 'would move the other.');
      }
      forms += 1;
    }
    if (forms === 0) {
      throw new Error(
        `${label} has no form on Midnight, private or public, so no vault can hold it. Only a token `
        + 'a vault can hold is an asset.');
    }
    const other = seen.get(row.code);
    if (other !== undefined) {
      throw new Error(
        `${other} and ${label} are the same token. They would be two names for one balance, so a `
        + 'vault holding either would read as holding both.');
    }
    seen.set(row.code, label);
  }
}

/**
 * **A REGISTRY CARRYING A TEST ASSET ON A NETWORK THAT MAY NOT HAVE ONE DOES
 * NOT BUILD.**
 *
 * `SEED_ASSETS` already leaves the row out off stagenet, so on the ordinary
 * path this never fires. **It is here for the path that is not ordinary**: a
 * registry assembled by hand, a list spread from somewhere else, a row copied
 * into a fixture that then reaches a server. The seed is one way to get a row
 * into a registry and this is the only way to get a registry.
 *
 * It throws rather than dropping the row. A registry quietly missing an asset
 * is a payroll run that refuses for a reason nobody can find; a registry that
 * refuses to exist is a process that does not start, which is what should
 * happen when a worthless token is a network away from real people.
 */
export function refuseATestAssetOffItsNetwork(rows: readonly Asset[], network: string): void {
  if (aTestAssetMayExistOn(network)) return;
  const found = rows.filter(r => isATestAsset(r?.code)).map(r => r.symbol ?? r.code);
  if (found.length === 0) return;
  throw new Error(
    `${found.join(', ')} ${found.length === 1 ? 'is a test asset' : 'are test assets'} and this `
    + `build is on "${network}". A test asset is backed by nothing, so a payroll run settling in `
    + 'one pays real people nothing at all, with real approvals behind it and no way back. It '
    + `exists on ${TEST_SETTLEMENT_MINTED_ON.join(', ')} and nowhere else, and it may exist only `
    + 'on a network whose own record says no real money settles there. Remove the row, or run '
    + 'this build on a network a test asset is allowed on; there is no setting that permits it '
    + 'and none may be added.');
}

/*
 * Function declarations rather than constants: the default registry below is
 * built while this module loads, before a constant declared here would exist.
 */
function formWord(form: LedgerForm): string {
  return form === 'shielded' ? 'private' : 'public';
}

/**
 * **WHAT THE LEDGER CALLS AN ASSET IN ONE FORM, OR THAT IT HAS NO SUCH FORM.**
 *
 * An asset IS its token, so the account's name for it (`assetIdBytes`), the
 * root a run commits to, and the token a vault pays out of are one value. What
 * this answers is whether the token takes the form a payee is paid in: a vault
 * can only pay a private payee from notes and a public one from its balance.
 *
 * **READ OFF THE ASSET'S OWN ROW.** No asset is named in this function, so a
 * new asset, or a new form of an old one, is a change to a row and to nothing
 * else.
 */
export type LedgerAnswer =
  | { readonly of: 'token'; readonly token: string }
  | { readonly of: 'no-such-form'; readonly why: string };

export function ledgerFormOf(asset: Asset, form: LedgerForm): LedgerAnswer {
  if (form !== 'shielded' && form !== 'unshielded') {
    throw new Error(`"${String(form)}" is not a form money takes on Midnight; it is private or public.`);
  }
  const identity = (asset as { ledger?: unknown }).ledger as Partial<LedgerIdentity> | undefined;
  const token = identity?.[form];
  if (typeof token === 'string') return { of: 'token', token };
  if (token !== null) {
    throw new Error(
      `${asset.symbol} does not say whether it has a ${formWord(form)} form, so no payment in it `
      + 'can name its money. Its row states a token or null for each form.');
  }
  const other: LedgerForm = form === 'shielded' ? 'unshielded' : 'shielded';
  const why = typeof identity?.[other] === 'string'
    ? `${asset.symbol} has no ${formWord(form)} form on Midnight, so no vault can hold it `
      + `${formWord(form)}ly and no ${formWord(form)} payment in it can be made. It has a `
      + `${formWord(other)} form only.`
    : `${asset.symbol} has no form on Midnight, private or public, so no vault can hold it and no `
      + 'payment in it can be made out of one.';
  return { of: 'no-such-form', why };
}

/**
 * **THE TOKEN A PAYMENT IN AN ASSET MOVES, IN THE FORM ITS PAYEE IS PAID IN.**
 *
 * Every producer of a payment's token calls this, and nothing else turns an
 * asset into a ledger token. Where the asset has no such form it refuses,
 * naming the assets that have one, rather than handing back a stand-in: a
 * stand-in is a payment no vault can make, discovered after the approvals and
 * the fees.
 */
export function ledgerTokenOf(
  code: AssetId, form: LedgerForm, registry: AssetRegistry = assets,
): string {
  const answer = ledgerFormOf(registry.require(code), form);
  if (answer.of === 'token') return answer.token;
  const payable = registry.enabled()
    .filter(a => ledgerFormOf(a, form).of === 'token')
    .map(a => a.symbol);
  throw new Error(
    `${answer.why} ${payable.length === 0
      ? `No asset has a ${formWord(form)} form yet.`
      : `Assets that have a ${formWord(form)} form: ${payable.join(', ')}.`}`);
}

/* ------------------------------------------------------------------ *
 * amounts
 * ------------------------------------------------------------------ */

/**
 * Turns what a person typed into an integer in the asset's smallest unit.
 *
 * STRICT, on purpose, and every refusal below is a bug it would otherwise hide:
 *
 *   "5,000.00"   thousands separators are ambiguous across locales — in much of
 *                Europe that string means five, not five thousand.
 *   "5.005"      more decimal places than the asset has. Truncating silently is
 *                how someone is paid half a penny less every month; rounding
 *                silently is the same thing with a friendlier name. The caller
 *                has to decide, so this refuses and says by how much.
 *   "1e3"        exponent notation is a float in disguise.
 *   "-5"         negative amounts are not a thing this system moves. A refund
 *                is an entry in the other direction, not a negative one.
 */
export function parseAmount(text: string, asset: Asset): bigint {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `"${text}" is not a plain decimal amount. Write digits and at most one point — no ` +
        'separators, no exponent, no sign.',
    );
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > asset.decimals) {
    throw new Error(
      `${asset.symbol} has ${asset.decimals} decimal ${asset.decimals === 1 ? 'place' : 'places'}, ` +
        `and "${text}" has ${fraction.length}. Rounding somebody's pay without being asked is ` +
        'not something this will do quietly.',
    );
  }
  return BigInt(whole + fraction.padEnd(asset.decimals, '0'));
}

/**
 * Turns an integer in the smallest unit back into something a person reads.
 *
 * Always shows every decimal place the asset has, including trailing zeros:
 * `5000000000` in tUSD is `5000.000000` and not `5000`. Money with a variable number of
 * decimal places in a column is how a person misreads a figure by a factor of
 * ten, and this is the display path for payslips.
 */
export function formatAmount(value: bigint, asset: Asset): string {
  if (value < 0n) throw new Error('amounts are never negative');
  if (asset.decimals === 0) return value.toString();
  const digits = value.toString().padStart(asset.decimals + 1, '0');
  const cut = digits.length - asset.decimals;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/**
 * Adds up amounts OF ONE ASSET.
 *
 * There is deliberately no function here that adds amounts of different assets,
 * and there must not be one. "A run has a subtotal per asset, never one total" —
 * a single number across mixed tokens is a number that means nothing, and
 * the moment a helper exists to produce one, something will display it.
 */
export const sumAmounts = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/**
 * **THE LARGEST AMOUNT ANY CHANGE MAY CARRY, AND THE ONE PLACE IT IS WRITTEN.**
 *
 *
 * `Uint<128>`, because that is what `changeCommitmentOf` argument 2 is
 * (`contracts/managed/contract/index.js:4220`) and what the `changeAmount`
 * witness is range-checked against before a call is built (`:1380`).
 *
 * **IT LIVES HERE AND NOT IN `src/midnight/`, AND THE DIRECTION IS FORCED.**
 * `core/` may not import `src/midnight/` — that dependency rule is what keeps
 * the standalone build working and it is stated at `src/wiring/selection.ts:84-93`
 * — and the value has to be readable from `core/` because that is where a
 * change is BUILT. `src/midnight/commitments.ts:42` now reads it from here
 * rather than declaring its own; a second copy of the value would be the
 * eleventh time a duplicated constant has cost this project.
 */
export const MAX_CHANGE_AMOUNT = (1n << 128n) - 1n;

/**
 * **THE SUM A CHANGE COMMITS TO, REFUSED WHERE IT IS BUILT.**
 *
 * ── WHY A SECOND SUMMING FUNCTION AND NOT A CHECK INSIDE `sumAmounts` ────────
 *
 * `sumAmounts` above is used for display subtotals and for arithmetic that has
 * nothing to do with a circuit argument. **This one is for the value that
 * becomes `StateChange.amount`**, and it is separate so the refusal cannot be
 * inherited by a caller that only wanted to add three numbers up — the shape
 * `newProposalSalt` uses (`src/core/crypto.ts:141-146`): the assert is where
 * the value is MADE, not at either consumer, and it is a NAMED generator rather
 * than a widened shared one.
 *
 * ── WHAT WAS REACHABLE BEFORE IT, MEASURED ──────────────────────────────────
 *
 * `AccountService.propose` summed with a bare reduce and nothing bounded the
 * result. The live door was the plug-in one, since deleted: its install route
 * took `perProposal` as a string and converted it with `parseAmount`, **which
 * refuses a sign, separators and an exponent and imposes NO MAXIMUM** (above)
 * — so the only ceiling on the path was a number the same caller set. Its
 * propose route then passed every check the plug-in service made and wrote
 * `entries`.
 *
 * **AND ON TODAY'S WIRING NOTHING DOWNSTREAM REFUSES IT.**
 * `src/wiring/selection.ts:144` selects the simulated scheme, whose
 * `changeCommitment` HMACs the decimal string (`src/core/ledger.ts:2106-2110`)
 * and takes a bigint of any magnitude. The round opens, collects approvals, and
 * names a change no contract can ever reproduce: approvals spent on a round
 * that can never be paid, reached through a second door. On the Midnight wiring
 * it is loud instead, at the witness range check, before anything is submitted.
 *
 * **THE GUARD THAT SHOULD HAVE CAUGHT IT EXISTS AND IS DEAD CODE**, which is
 * why this is a new function rather than a call to that one: `checkAmount`
 * (`src/midnight/commitments.ts:44-55`) does exactly this and its only caller
 * is `MidnightCommitments.changeCommitment` (`:219-222`), **which nothing in
 * `src/` calls** — `MidnightLedger` reaches `pureCircuits` directly
 * (`src/midnight/ledger.ts:1672`). A tested guard on a path the product does
 * not take proves nothing about the product.
 *
 * **A NEGATIVE IS ALSO REFUSED BY `parseAmount`'s REGEX** (above). It is
 * refused here as well, because the ceiling and the floor are one rule about
 * one value and splitting them across files is how one of them goes missing.
 */
export const sumChangeAmount = (xs: readonly bigint[], what: string): bigint => {
  const total = sumAmounts(xs);
  if (total < 0n) {
    throw new Error(
      `${what} sums to ${total}, which is negative. A change commitment's amount is the ` +
        'contract\'s Uint<128> and cannot represent it, so this round would be approved and ' +
        'then impossible to settle.',
    );
  }
  if (total > MAX_CHANGE_AMOUNT) {
    throw new Error(
      `${what} sums to ${total}, which does not fit the contract's Uint<128>. The largest ` +
        `amount a change can carry is ${MAX_CHANGE_AMOUNT}. A round raised above it collects ` +
        'approvals and can never be settled by any payment.',
    );
  }
  return total;
};

/**
 * Subtotals per asset, which is what a mixed run actually has.
 *
 * Returned sorted by token so two runs over the same lines produce the same
 * object — anything that gets sealed or digested has to be deterministic.
 */
export function subtotals(
  lines: ReadonlyArray<{ asset: AssetId; amount: bigint }>,
): Record<AssetId, bigint> {
  const out: Record<AssetId, bigint> = {};
  for (const code of [...new Set(lines.map(l => l.asset))].sort()) {
    out[code] = sumAmounts(lines.filter(l => l.asset === code).map(l => l.amount));
  }
  return out;
}
