/**
 * CAN A NOTE'S PLACE IN THE COMMITMENT TREE EVER BE OBTAINED? `C244`, `V-139`.
 *
 * **THIS INSTRUMENT DECIDES WHETHER `C244` IS DOWNTIME OR LOSS, AND IT IS THE
 * ONLY THING THAT CAN.** The register classifies `C244` as downtime rather than
 * loss. `SC1c` ruled that classification UNMEASURED: the refusal in
 * `witnessesOver` is right, `Note.index` being optional is right, and **nothing
 * anywhere establishes that the index can ever be READ BACK.** A vault whose
 * notes can never be qualified is a vault whose money cannot be moved, which is
 * loss wearing downtime's clothes.
 *
 * Read-only. Nothing is built, proved, submitted, deployed or spent. One
 * indexer is asked several questions and one contract state is decoded.
 *
 * ------------------------------------------------------------------------
 * **THE VAULT'S STATE IS READ THROUGH THE CLIENT'S OWN READ, AND THAT IS NOT
 * A STYLE CHOICE.** `C264`, `M-104`.
 *
 * This file used to fetch the state as hex and deserialise it itself, with
 * `ContractState` from `@midnight-ntwrk/midnight-js-protocol/ledger`. **It had
 * never worked, on either vault, on any run**, and it refused with `expected
 * instance of ChargedState` in a way that read as a fact about the vault.
 *
 * **MEASURED, 29 Aug, both reads in one process against one vault:** the bytes
 * are identical either way, and the two `ContractState` names are two classes
 * from two different wasm modules — `midnight-js-protocol/ledger` re-exports
 * `@midnightntwrk/ledger-v9`, while the generated reader is compiled against
 * `@midnight-ntwrk/compact-runtime`, which is `@midnightntwrk/onchain-runtime-v4`.
 * The public data provider deserialises with `deserializeCompactContractState`,
 * which is the class the reader wants, so the same bytes decode through it.
 *
 * **Surfaces A, C and E do NOT carry this**: they deserialise a ledger type and
 * then only call methods on that same object, with no hand-off across the
 * module boundary. Measured, not assumed — all three deserialised and answered
 * in the same run.
 *
 * ------------------------------------------------------------------------
 * **`firstFree = 0` ON A FILTERED STATE IS NOT A STATEMENT ABOUT THE TREE, AND
 * NEITHER READ IS BROKEN. ANSWERED FROM SOURCE.** `V-204`.
 *
 * Surfaces A and E both report `firstFree = 0` on states that deserialise to
 * 634 and 1,818 bytes, while the chain's own `zswapEndIndex` is 618. **The
 * indexer never assigns the field.** `extract_contract_zswap_state` builds
 * `ZswapStateV9::new()` and then replaces **only** `coin_coms` with
 * `ledger_state.zswap.filter(&[address])`
 * (`midnight-src/midnight-indexer/indexer-common/src/domain/ledger/ledger_state.rs:909-919`),
 * and `State::default()` has `first_free: 0`
 * (`midnight-src/midnight-ledger/zswap/src/ledger.rs:51-56`). `filter` returns
 * a `MerkleTree` rather than a `State` (`:211-236`), so there is no count for
 * it to carry across. **The leaves ARE retained at their true indices; the
 * count beside them is a sibling field nobody set.** So `firstFree` on a
 * filtered state may never be read as a leaf count, in either direction, and
 * nothing in this file builds on it.
 *
 * ------------------------------------------------------------------------
 * **IT PRINTS ITS DERIVATION AND NEVER A PREDICTED NUMBER.** `C238`.
 *
 * Every index this prints is accompanied by the surface it came off and the
 * bytes it was decoded from. **A measurement it could not take is a refusal
 * that says so.** There is no path through this file that prints a plausible
 * index: an index that is wrong is a transaction the chain refuses with nothing
 * a person can act on (`vault-notes.ts:60-82`), so a guess here would be worse
 * than the silence it replaced.
 *
 * ------------------------------------------------------------------------
 * WHAT IT ASKS, AND WHY THESE FOUR
 *
 * **Stage 1 introspects ALL THREE roots** — query, mutation and subscription.
 * Not just query: `C244`'s own history is an introspection of the query root
 * alone that drew four "Unknown field" errors and a confident conclusion from
 * them, and was wrong because subscriptions were never looked at.
 *
 * **AND IT WALKS THE TYPES THOSE ROOTS RETURN, WHICH IS WHERE THE ANSWER
 * ACTUALLY IS.** `V-148`. A run that enumerated root fields alone printed 38
 * query, 2 mutation and 13 subscription fields and reported *"none of them
 * mentions an index, a commitment or a tree"* — an honest report at the wrong
 * level. **The two most promising surfaces are fields on TYPES and cannot
 * appear in a list of root fields**: `ContractAction.zswapState` and
 * `Transaction.zswapStartIndex`/`zswapEndIndex` are exactly what stages 2 and 3
 * go on to read. So the types are walked, every field on each is printed, and
 * **the types walked AND the ones not walked are both named**, because the
 * boundary of an answer is part of the answer.
 *
 * Stages 2 and 3 then try, in order of how directly each answers *"at what
 * index is this commitment"*:
 *
 *   A  `ContractAction.zswapState` — the vault's OWN zswap state. The indexer
 *      builds it as `ZswapState::new()` with
 *      `coin_coms = ledger_state.zswap.filter(&[address])`
 *      (`midnight-src/midnight-indexer/indexer-common/src/domain/ledger/ledger_state.rs`,
 *      the `contract_zswap_state` arm), and `filter` RETAINS the contract's own
 *      leaves at their true indices while collapsing every gap between them
 *      (`midnight-src/midnight-ledger/zswap/src/ledger.rs:211-236`). If indices
 *      survive that serialisation in a form JS can read, this is the answer and
 *      it needs no replay of anything.
 *
 *   B  `RegularTransaction.zswapStartIndex` / `zswapEndIndex` — the index range
 *      a settled transaction's outputs occupy. **This repository's own
 *      reference does not record these two fields**; they are in the served
 *      schema
 *      (`midnight-src/midnight-indexer/indexer-api/graphql/schema-v4.graphql`).
 *      **MEASURED HERE: they are on `RegularTransaction` and NOT on the
 *      `Transaction` interface**, so selecting them through
 *      `contractAction.transaction` needs an inline fragment and is otherwise
 *      refused. A reading of settled history rather than a prediction about a
 *      pending offer, which is the objection `C244` raises against `tryApply`.
 *
 *   C  `zswapMerkleTreeCollapsedUpdate(startIndex, endIndex)` — the candidate
 *      `C244` names. Deserialised with `MerkleTreeCollapsedUpdate` from the
 *      ledger this project compiles against.
 *
 *   D  `Transaction.zswapLedgerEvents` — the raw serialised zswap ledger
 *      events. Named nowhere in `C244`. **MEASURED HERE: it is on the
 *      `Transaction` interface, and `Block` has no such field**, so only the
 *      transaction's own events can be asked for.
 *
 *   E  `Block.contractZswapState(address:)` — the vault's OWN commitment tree,
 *      which is the subject of `C244` and which nothing in this project had
 *      ever asked for (`V-162`). **READ AT THE LATEST BLOCK, WHICH THE SCHEMA
 *      REQUIRES RATHER THAN SUGGESTS**: *"older trees age out of the ledger's
 *      root window, and blocks beyond the chain-indexer's ledger state
 *      retention window no longer have a loadable ledger state and yield an
 *      error"*, and it is to be composed with `ledgerParameters` and
 *      `contract { state }` in one request anchored to the same block
 *      (`docs/midnight/02-indexer-graphql-v4.md` §Block). **A read at the
 *      deploy block would refuse for age, and reading that refusal as "the
 *      field does not work" would close the most promising surface `C244`
 *      has.**
 *
 *   F  `zswapMerkleTreeCollapsedUpdate` over the **NARROW** range surface B
 *      reads off the depositing transaction, rather than over the whole tree.
 *      **AND WHAT IT CAN ANSWER IS NARROWER THAN IT LOOKS, MEASURED FROM
 *      SOURCE.** `MerkleTreeCollapsedUpdate` is `{ start: u64, end: u64,
 *      hashes: Vec<MerkleTreeDigest> }`
 *      (`midnight-src/midnight-ledger/transient-crypto/src/merkle_tree.rs:309-315`):
 *      **it carries DIGESTS and no leaf value anywhere, at the boundaries or
 *      between them**, and its `Debug` impl prints `start` and `end` and
 *      nothing else (`:318-325`) — which is the whole of why surface C's dump
 *      was 57 characters long. So F does not ask *does this contain our
 *      commitment*; it asks **does applying it produce a QUALIFIED coin**,
 *      through `ZswapLocalState.applyCollapsedUpdate` and then `coins`.
 *      **AND THE TWO `endIndex`es ARE NOT THE SAME NUMBER**: the schema's
 *      `zswapEndIndex` is exclusive, the ledger's `end` is inclusive
 *      (`merkle_tree.rs:384-409`, `MerkleTreeCollapsedUpdate::new`), so the
 *      range is converted, the conversion is printed, and the unconverted one
 *      is asked for as well so nobody has to take the conversion on trust.
 *
 *   G  **ASK THE VAULT'S OWN FILTERED TREE WHICH CANDIDATE LEAVES IT DOES NOT
 *      HOLD.** `filter` RETAINS this contract's leaves at their true indices
 *      and COLLAPSES every other leaf (`zswap/src/ledger.rs:211-236`), and the
 *      ledger's own `MerkleTreeCollapsedUpdate` constructor refuses to build
 *      over a range whose ancestors are collapsed
 *      (`merkle_tree.rs:363-382`, `InvalidUpdate::CollapsedIndex`). So asking
 *      it for the single-leaf range `(i, i)` over the vault's OWN state is a
 *      reading about that leaf's tree, taken from the ledger's own types, with
 *      no parser over any Debug string.
 *
 *      **AND IT READS AT PAIR GRANULARITY, NOT LEAF GRANULARITY, WHICH IS THE
 *      WHOLE OF WHAT THIS SURFACE MAY CLAIM.** Found by this round's
 *      `money-safety-auditor` against this round's own first draft, which
 *      claimed leaf granularity and would have recorded an index that is not
 *      the vault's. **`partial_index` inspects the nodes at heights `h…1` and
 *      hands the node at height 0 straight to `root()` without matching it**
 *      (`merkle_tree.rs:369-381`), and `root()` answers `Some` for a `Leaf`,
 *      for a `Collapsed { height: 0 }` and for a `Stub { height: 0 }` alike
 *      (`:704-711`). **`Collapsed { height: 0 }` is exactly what `filter`
 *      leaves at the merkle SIBLING of every retained leaf** — `collapse`
 *      turns a covered `Leaf` into one (`:880-887`) and merges upward only
 *      when both children are collapsed (`:928-933`). So:
 *
 *        the constructor BUILDS   ⟹ the pair `{i, i^1}` was not collapsed.
 *                                   Where both leaves exist that means at
 *                                   least ONE of them is this vault's, and it
 *                                   does not say which. **Where the sibling is
 *                                   beyond the tree's last written leaf it
 *                                   means only that the pair was not
 *                                   collapsed** — `Stub { height: 0 }.root()`
 *                                   answers too (`:704-711`) — so `i` may be
 *                                   nobody's. It over-populates what is still
 *                                   in play and never what is excluded.
 *        the constructor REFUSES  ⟹ the pair was collapsed entirely, so
 *                                   NEITHER `i` nor `i^1` is this vault's.
 *
 *      **The negative is exact about the tree it was served and the leaves it
 *      was asked about, and this round establishes neither of those.** Surface
 *      B is not pinned to the depositing transaction, and no positive control
 *      exists, so **G counts towards NO verdict in any branch** and prints
 *      what would let it. So G can EXCLUDE and it cannot IDENTIFY, **it writes
 *      nothing into `located`**,
 *      and on a deposit whose two candidate leaves are a sibling pair it does
 *      not advance past surface B. That is a finding rather than a failure,
 *      and the door it names is in `docs/foundation-divergences.md` entry 11:
 *      the Rust has `MerkleTree::iter_aux()` and `MerkleTree::index(i)`, which
 *      answer at leaf granularity, and **neither is exposed to JS.**
 *
 *      **A CONTROL IS ASKED FIRST AND EVERY ANSWER IS DISCARDED IF IT FAILS.**
 *      A probe that answers yes to everything looks exactly like a probe that
 *      found everything retained. So an index far outside the range is asked
 *      too, and unless it comes back collapsed this surface refuses the lot.
 * *
 * **A, B, D and E are not in `C244`'s text and B, D and E were not in our
 * reference either.** That is a finding whether or not any of them answers.
 */
export {};   // a MODULE rather than a global script; see scripts/indexer-check.ts.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createScreen } from './deploy-report.js';
import { ENDPOINTS, type NetworkName } from '../src/midnight/network.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const NETWORK = process.env.MIDNIGHT_NETWORK_ID || 'stagenet';

/**
 * **THE ENDPOINTS ARE NOT WRITTEN DOWN HERE.** `M-104`.
 *
 * `src/midnight/network.ts` is where they are declared and it is what every
 * client path already reads (`open-vault-pool.ts:289`). A URL typed into this
 * file would be a second copy of a value that has already moved under this
 * project once — and the read below is now the client's read, so it has to
 * point at the client's endpoints or it is measuring a different network.
 *
 * `MIDNIGHT_INDEXER_URL` still overrides the query endpoint, because
 * `INDEXER-CHECK.command` and this instrument have always honoured it against a
 * local indexer. **The socket URL has no override and does not need one**: the
 * provider opens it only for subscriptions and nothing here subscribes.
 */
const ENDPOINT = ENDPOINTS[NETWORK as NetworkName];
const INDEXER = process.env.MIDNIGHT_INDEXER_URL
  || ENDPOINT?.indexerUrl
  || 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const INDEXER_WS = ENDPOINT?.indexerWsUrl
  || 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws';
/**
 * **WHICH VAULT, AND THERE IS NO DEFAULT.** `C264`, `M-104`.
 *
 * A default here is not a fallback: `MEASURE-NOTE-INDEX.command` takes no
 * argument, so whatever is written here would be the ONLY value this instrument
 * could ever have, and it would answer confidently about a vault nobody asked
 * about. That is not hypothetical — the vault a default named was the
 * four-circuit deployment while the compiled reader is the seven-circuit one, so
 * a run against it cannot decode a state and a run against the vault deployed to
 * make the measurement possible could not be asked for at all.
 *
 * **So the door PROMPTS, and an unanswered prompt is a refusal.** That is this
 * instrument's whole discipline: a measurement it could not take says so rather
 * than reporting a number about something else.
 */
const VAULT_NAME = (process.env.VAULT_NAME ?? '').trim();

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', O = '\x1b[0m';

/**
 * **EVERY LINE THIS INSTRUMENT PRINTS GOES THROUGH THE `C236` SCREEN.** `V-97`.
 *
 * This file holds the vault's address and sends it to the indexer five times,
 * and it prints two kinds of text it did not author and cannot bound: a
 * GraphQL error verbatim on every refusal path, and a window of a
 * `ZswapChainState` Debug dump whose format this file says it does not know.
 * **A promise not to print the address is a promise kept by whoever edits this
 * next; the screen makes it a refusal at the moment the line is written**, and
 * every other instrument that holds an address already uses it
 * (`scripts/deploy-vault.ts`, `scripts/open-vault-pool.ts`). `V-97` is the row
 * about a refusal path putting an address into a `REPORT-*.txt` twice, found by
 * running an instrument rather than by reasoning about it.
 */
const secret: Array<{ what: string; value: string }> = [];
const say = createScreen(() => secret);

/** Refusals are collected so the verdict can name every one of them. */
const refusals: string[] = [];
const refuse = (what: string, why: string) => {
  refusals.push(`${what}: ${why}`);
  say(`    ${Y}COULD NOT MEASURE${O}  ${what}`);
  say(`      ${D}${why}${O}`);
};

/** Commitments are truncated in print. The vault's ADDRESS is never printed: C236. */
const short = (h: string) => `${h.slice(0, 16)}…`;

/**
 * **A NETWORK FAILURE AND A SCHEMA FAILURE ARE DIFFERENT ANSWERS AND MUST NOT
 * LOOK ALIKE.** `C110`'s shape, one layer out: *"the indexer has no such
 * field"* rules on `C244`, and *"this machine could not reach the indexer"*
 * rules on nothing at all. `fetch` reports both as a thrown error, so the
 * unreachable case is caught here and re-thrown saying which it was.
 */
async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(INDEXER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (cause) {
    throw new Error(
      `this machine could not reach ${INDEXER} (${(cause as Error)?.message ?? String(cause)}). `
      + 'That is a fact about this machine and NOT an answer about the indexer, so nothing '
      + 'here rules on C244. INDEXER-CHECK.command establishes whether the indexer is '
      + 'reachable and level with the node; run that first, then this again.');
  }
  return res.json();
}

/* ------------------------------------------------------------------ *
 * stage 1 — all three roots
 * ------------------------------------------------------------------ */

const INTROSPECT = `
query {
  __schema {
    queryType { name fields { name description } }
    mutationType { name fields { name description } }
    subscriptionType { name fields { name description } }
  }
}`;

/** A field is WORTH READING if its name or description mentions any of these. */
const RELEVANT = /index|indices|commitment|merkle|tree|zswap|leaf|leaves/i;

interface Field { name: string; description?: string | null }

/**
 * **THE TYPES WALKED, AND WHY THESE THREE.** `V-148`.
 *
 * Each is the type a root field this instrument already reads comes back as:
 * `contractAction(address:)` returns `ContractAction`, its `transaction` is a
 * `Transaction`, and that transaction's `block` is a `Block`.
 *
 * **AND `RegularTransaction`, WHICH IS NOT OPTIONAL AND IS THE FINDING.**
 * MEASURED HERE, 29 August, against the stagenet indexer: `Transaction` is an
 * INTERFACE whose fields are id, hash, protocolVersion, raw, block,
 * contractActions, unshieldedCreatedOutputs, unshieldedSpentOutputs,
 * zswapLedgerEvents and dustLedgerEvents — **`zswapStartIndex` and
 * `zswapEndIndex` are not among them.** They are on `RegularTransaction`, one
 * of the interface's three implementations. Asking for them on the interface
 * answers `Unknown field "zswapStartIndex" on type "Transaction"`, which is
 * surface B's whole reading. A vault's deploy and calls are regular
 * transactions; `SystemTransaction` and `BridgeClaimTransaction` are the
 * chain's own and carry no zswap index range, so they are named as not walked
 * rather than walked.
 *
 * **Every surface stages 2 and 3 ask about is a field on one of these**, so a
 * walk that covers them covers the schema this measurement depends on — and the
 * ones it does not cover are printed, so nobody reads this as a walk of the
 * whole schema.
 */
const TYPES_TO_WALK = [
  'ContractAction', 'Transaction', 'RegularTransaction', 'Block',
] as const;

/*
 * `__type` takes a name and cannot be looped over in one document, so the
 * aliases are built here. The type names are valid GraphQL names, which is why
 * they can be aliases as well; nothing is interpolated that a person typed.
 */
const TYPE_INTROSPECT = `query {
${TYPES_TO_WALK.map((t, i) => `  t${i}: __type(name: "${t}") { `
  + 'name kind fields { name description } possibleTypes { name } interfaces { name } }').join('\n')}
}`;

interface WalkedType {
  name: string;
  kind?: string;
  fields: Field[];
  possibleTypes: string[];
  interfaces: string[];
}

async function stageOne(): Promise<{ roots: Record<string, Field[]>; types: WalkedType[] } | undefined> {
  say(`\n${B}1 of 4  All three GraphQL roots AND the types they return, introspected${O}`);
  say(`  ${D}${INDEXER}${O}`);
  say(`  ${D}query, mutation AND subscription. Introspecting only the query root is${O}`);
  say(`  ${D}how this project last drew a confident wrong conclusion about this schema.${O}`);
  say(`  ${D}AND THE TYPES, because the surfaces that answer are fields on types and${O}`);
  say(`  ${D}cannot appear in a list of root fields at all. V-148.${O}\n`);

  let j: any;
  try {
    j = await gql(INTROSPECT);
  } catch (e: any) {
    refuse('the three roots',
      `the indexer could not be reached: ${String(e?.message ?? e).slice(0, 500)}`);
    return undefined;
  }
  if (j?.errors) {
    refuse('the three roots', `introspection refused: ${JSON.stringify(j.errors).slice(0, 300)}`);
    return undefined;
  }

  const s = j?.data?.__schema;
  if (!s) {
    refuse('the three roots', 'the response carried no __schema');
    return undefined;
  }

  const roots: Record<string, Field[]> = {
    query: s.queryType?.fields ?? [],
    mutation: s.mutationType?.fields ?? [],
    subscription: s.subscriptionType?.fields ?? [],
  };

  for (const [root, fields] of Object.entries(roots)) {
    say(`  ${B}${root}${O}  ${D}${fields.length} field(s)${O}`);
    if (fields.length === 0) {
      say(`    ${Y}this root has no fields, or the indexer does not expose one${O}`);
      continue;
    }
    /* EVERY field name is printed, including the ones that do not answer. What
     * is wanted is the names found, not only the ones that helped. */
    say(`    ${D}${fields.map(f => f.name).join(', ')}${O}`);
    const worth = fields.filter(f => RELEVANT.test(`${f.name} ${f.description ?? ''}`));
    if (worth.length === 0) {
      say(`    ${D}none of them mentions an index, a commitment or a tree${O}`);
    } else {
      say(`    ${B}mentioning an index, a commitment or a tree:${O}`);
      for (const f of worth) {
        const d = (f.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 150);
        say(`      ${G}${f.name}${O}${d ? `  ${D}${d}${O}` : ''}`);
      }
    }
    say('');
  }

  /* ---------------------------------------------------------------- *
   * the TYPES, which is the level the answer is on
   * ---------------------------------------------------------------- */

  const types: WalkedType[] = [];
  const notWalked = new Set<string>();

  say(`  ${B}THE TYPES THOSE ROOTS RETURN${O}`);
  say(`  ${D}a root field's NAME is not where an index lives — it lives on the type${O}`);
  say(`  ${D}the field comes back as. A walk of roots alone reported "none of them${O}`);
  say(`  ${D}mentions an index" and that was never a statement about the schema.${O}\n`);

  let tj: any;
  try {
    tj = await gql(TYPE_INTROSPECT);
  } catch (e: any) {
    refuse('the types',
      `the indexer could not be reached for the type walk: ${String(e?.message ?? e).slice(0, 500)}`);
    tj = undefined;
  }
  if (tj?.errors) {
    refuse('the types', `type introspection refused: ${JSON.stringify(tj.errors).slice(0, 300)}`);
    tj = undefined;
  }

  if (tj?.data) {
    for (let i = 0; i < TYPES_TO_WALK.length; i++) {
      const asked = TYPES_TO_WALK[i]!;
      const t = tj.data[`t${i}`];
      if (!t) {
        /*
         * **THE SCHEMA HAS NO SUCH TYPE IS AN ANSWER; NOT LOOKING IS NOT.** A
         * null here is the indexer saying the name does not exist, which is
         * worth printing under its own words rather than folding into silence.
         */
        say(`  ${Y}${asked}${O}  ${D}the schema has no type by this name${O}\n`);
        notWalked.add(asked);
        continue;
      }
      const fields: Field[] = t.fields ?? [];
      const walked: WalkedType = {
        name: String(t.name ?? asked),
        kind: t.kind ? String(t.kind) : undefined,
        fields,
        possibleTypes: (t.possibleTypes ?? []).map((p: any) => String(p?.name)),
        interfaces: (t.interfaces ?? []).map((p: any) => String(p?.name)),
      };
      types.push(walked);

      say(`  ${B}${walked.name}${O}  ${D}${walked.kind ?? 'kind not stated'}, ${fields.length} field(s)${O}`);
      if (walked.interfaces.length) {
        say(`    ${D}implements ${walked.interfaces.join(', ')}${O}`);
      }
      if (fields.length === 0) {
        say(`    ${Y}it exposes no fields at this level${O}`);
      } else {
        /* EVERY field, including the ones that do not answer — same rule as the roots. */
        say(`    ${D}${fields.map(f => f.name).join(', ')}${O}`);
        const worth = fields.filter(f => RELEVANT.test(`${f.name} ${f.description ?? ''}`));
        if (worth.length === 0) {
          say(`    ${D}none of them mentions an index, a commitment or a tree${O}`);
        } else {
          say(`    ${B}mentioning an index, a commitment or a tree:${O}`);
          for (const f of worth) {
            const d = (f.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 150);
            say(`      ${G}${walked.name}.${f.name}${O}${d ? `  ${D}${d}${O}` : ''}`);
          }
        }
      }
      /*
       * A type this one can BE but that was not itself walked. `ContractAction`
       * is an interface over the deploy, call and update variants, and a field
       * that exists only on one of them would be invisible to this walk.
       */
      for (const p of walked.possibleTypes) {
        if (!(TYPES_TO_WALK as readonly string[]).includes(p)) notWalked.add(p);
      }
      say('');
    }
  }

  /*
   * **THE BOUNDARY OF THE ANSWER IS PART OF THE ANSWER.** `C110`, one layer
   * out: this walk covers the types stages 2 and 3 read and no others, and a
   * reader who takes it for a walk of the whole schema would draw the same kind
   * of confident wrong conclusion that a walk of roots alone already produced.
   */
  say(`  ${B}WHAT THIS WALK COVERED, AND WHAT IT DID NOT${O}`);
  say(`    ${D}walked:     ${types.length ? types.map(t => t.name).join(', ') : 'nothing — see the refusals'}${O}`);
  say(`    ${D}not walked: ${notWalked.size ? [...notWalked].join(', ') : 'no type named by these was left out'}${O}`);
  say(`    ${D}and every other type in the schema. This is a walk of the types this${O}`);
  say(`    ${D}measurement reads, NOT of the schema.${O}\n`);

  say(`  ${B}THE DIRECT QUESTION — is there a field taking a COMMITMENT and`);
  say(`  answering with an INDEX?${O}`);
  const takesCommitment = [
    ...Object.entries(roots).flatMap(([root, fs]) =>
      fs.filter(f => /commitment/i.test(f.name)).map(f => `${root}.${f.name}`)),
    ...types.flatMap(t =>
      t.fields.filter(f => /commitment/i.test(f.name)).map(f => `${t.name}.${f.name}`)),
  ];
  if (takesCommitment.length === 0) {
    say(`    ${Y}NO. No field on the three roots or on the types walked above is named${O}`);
    say(`    ${Y}for a commitment.${O}`);
    say(`    ${D}So the index is not asked for directly, and stages 2 and 3 decide${O}`);
    say(`    ${D}whether it can be obtained INDIRECTLY. Those are different answers.${O}`);
    say(`    ${D}And this is now a statement about types as well as roots, which the${O}`);
    say(`    ${D}same sentence was not when only the roots had been looked at.${O}`);
  } else {
    say(`    ${G}${takesCommitment.join(', ')}${O}`);
  }

  return { roots, types };
}

/* ------------------------------------------------------------------ *
 * stage 2 — the vault, and the commitments to look for
 * ------------------------------------------------------------------ */

interface VaultSubject {
  address: string;
  commitments: string[];
  deployBlockHeight?: number;
}

async function stageTwo(): Promise<VaultSubject | undefined> {
  say(`\n${B}2 of 4  The vault, and the commitments this looks for${O}`);
  say(`  ${D}the vault's address is NOT printed, here or anywhere — C236${O}`);

  if (!VAULT_NAME) {
    refuse('the vault',
      'no vault was named, so there is nothing to measure against. '
      + 'MEASURE-NOTE-INDEX.command asks which vault and passes the answer here; there is no '
      + 'default, because a default would be the only vault this instrument could ever look at.');
    return undefined;
  }

  const vaultsFile = join(ROOT, '.midnight', `${NETWORK}-vaults.json`);
  if (!existsSync(vaultsFile)) {
    refuse('the vault',
      `there is no ${NETWORK}-vaults.json on this machine, so there is no deployed vault `
      + 'to measure against. DEPLOY-VAULT.command creates one.');
    return undefined;
  }

  let record: any;
  try {
    record = JSON.parse(readFileSync(vaultsFile, 'utf8'))?.vaults?.[VAULT_NAME];
  } catch (e: any) {
    refuse('the vault', `${NETWORK}-vaults.json did not parse: ${String(e?.message ?? e)}`);
    return undefined;
  }
  if (!record?.contractAddress) {
    /*
     * **THE NAME IS TYPED AT A PROMPT NOW, SO THIS REFUSAL LISTS THE ONES THAT
     * EXIST.** A misspelling and an undeployed vault are the same refusal from
     * here, and the difference is the whole of what the person needs; the
     * registry is the only place a name and an address are tied together, and
     * the addresses are never printed (`C236`).
     */
    let known: string[] = [];
    try {
      known = Object.keys(JSON.parse(readFileSync(vaultsFile, 'utf8'))?.vaults ?? {});
    } catch { /* the parse refusal above already covers a file that will not read */ }
    refuse('the vault',
      `no vault named "${VAULT_NAME}" in ${NETWORK}-vaults.json. `
      + (known.length
        ? `The vaults on ${NETWORK} are: ${known.join(', ')}. `
        : `There are no vaults at all on ${NETWORK}; DEPLOY-VAULT.command creates one. `)
      + 'This measurement is against a REAL settled vault and there is no substitute for one.');
    return undefined;
  }

  /* C236, before this function prints anything else. */
  secret.push({ what: "the vault's contract address", value: String(record.contractAddress) });
  say(`  ${G}✓${O} vault "${VAULT_NAME}", deployed ${record.deployedAt ?? 'at an unrecorded time'}`);
  if (record.deployTx?.blockHeight) {
    say(`  ${G}✓${O} its deploy settled in block ${record.deployTx.blockHeight}`);
  }

  /*
   * **THE VAULT'S NOTE SET IS READ THE WAY THE CLIENT READS IT, AND THAT IS THE
   * WHOLE OF THIS BLOCK.** `C264`, `M-104`.
   *
   * This used to fetch the state as hex over GraphQL and deserialise it here,
   * with `ContractState` from `@midnight-ntwrk/midnight-js-protocol/ledger`.
   * **That was a SECOND implementation of a read the client already has, and it
   * had never once worked** — on either vault, on any run.
   *
   * **MEASURED, 29 Aug, both reads in one process against one vault:** the
   * bytes are identical either way (same length, same digest), and the two
   * `ContractState` names are two different classes from two different wasm
   * modules. `midnight-js-protocol/ledger` re-exports `@midnightntwrk/ledger-v9`;
   * the generated reader below is compiled against
   * `@midnight-ntwrk/compact-runtime`, which is `@midnightntwrk/onchain-runtime-v4`.
   * A `ChargedState` from the first is not an instance of the second, and
   * `expected instance of ChargedState` is that boundary refusing. The provider
   * deserialises with `deserializeCompactContractState`
   * (`@midnight-ntwrk/midnight-js-utils`), which is the compact-runtime class the
   * reader wants — so the SAME BYTES read through the provider decode and the
   * same `readVault` then answers.
   *
   * **So the hand-rolled decode is deleted rather than repaired.** An instrument
   * that reads the chain a way no production code reads it can only answer a
   * question the product never asks — and here it could not answer at all,
   * while looking like a fact about the vault.
   *
   * **Only the public data provider is built**: no wallet, no proof server, no
   * proving config. This reads one contract state and never builds a
   * transaction, and a providers bundle carrying credentials it does not use is
   * a bundle somebody later reaches into (`open-vault-pool.ts:298-306`).
   */
  let state: any;
  try {
    const { indexerPublicDataProvider } =
      await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
    state = await indexerPublicDataProvider(INDEXER, INDEXER_WS)
      .queryContractState(record.contractAddress);
  } catch (e: any) {
    /*
     * REFUSAL ONE OF THREE: we could not reach the indexer. A fact about this
     * machine and not an answer about the vault, so it rules on nothing.
     */
    refuse('the vault’s note set',
      `the indexer could not be reached: ${String(e?.message ?? e).slice(0, 500)}. `
      + 'That is a fact about this machine and NOT an answer about the vault, so nothing here '
      + 'rules on C244. INDEXER-CHECK.command establishes whether the indexer is reachable and '
      + 'level with the node; run that first, then this again.');
    return undefined;
  }

  if (!state) {
    /*
     * REFUSAL TWO OF THREE. `C110`: an absent read is our ignorance, never
     * "the vault holds nothing". The provider returns null for a state it did
     * not find, and the difference between that and an empty vault is the
     * whole of what a reader needs.
     */
    refuse('the vault’s note set',
      'the indexer returned no contract state for this vault. That is NOT an empty vault — '
      + 'C110 is the reading that came back absent 168ms after the node had finalised it.');
    return undefined;
  }

  const commitments: string[] = [];
  try {
    /*
     * **NOTHING IS PRINTED UNTIL EVERY FIELD HAS DECODED, AND THAT ORDERING IS
     * THE POINT OF THIS BLOCK.** `C110`, `C238`.
     *
     * **MEASURED, 29 Aug, against `payroll-test-1`** — the four-circuit
     * deployment read by the seven-circuit reader: **the generated reader
     * decodes FIELD BY FIELD, and `notes` handed back a well-formed EMPTY set
     * from a state whose very next field threw** `invalid operation for type:
     * index out of bounds in idx: 3 >= 3`. Printed in the obvious order, this
     * instrument said *"the chain holds 0 note commitment(s)"* and refused to
     * decode immediately afterwards — a number read off a state that did not
     * decode, in the file written to enforce `C238`.
     *
     * **So every field is forced first and the screen is written only after.**
     * A state that does not decode produces a refusal and NO number, which is
     * the only honest shape: an empty set from a broken decode and an empty set
     * from an empty vault are indistinguishable by value, and one of them is a
     * vault's whole balance.
     */
    const { ledger: readVault } = await import('../contracts/managed-vault/contract/index.js');
    const parsed: any = (readVault as any)(state.data);
    for (const c of parsed.notes) commitments.push(hexOf(c));
    const held = String(parsed.notes.size());
    const payments = String(parsed.payments);
    say(`  ${G}✓${O} the chain holds ${held} note commitment(s) for this vault`);
    say(`  ${G}✓${O} it has recorded ${payments} payment(s)`);
    say(`  ${D}read through the same public data provider VaultLedger.chainNotes uses,${O}`);
    say(`  ${D}and decoded by the vault's own generated reader — every field forced${O}`);
    say(`  ${D}before either number was printed${O}`);
  } catch (e: any) {
    /*
     * REFUSAL THREE OF THREE: the state was read and did not decode. **This is
     * a real answer about a real mismatch and it must stay distinct from the
     * two above.** `payroll-test-1`, the four-circuit deployment, refuses here
     * against the seven-circuit reader — measured 29 Aug, `invalid operation
     * for type: index out of bounds in idx: 3 >= 3`. `C231`'s shape: a
     * deployment and its client move together.
     */
    refuse('the vault’s note set',
      `the contract state did not decode: ${String(e?.message ?? e).slice(0, 500)}`);
    return undefined;
  }

  if (commitments.length === 0) {
    /*
     * NOT A FAILURE OF THE INSTRUMENT, AND NOT AN ANSWER EITHER. An empty note
     * set is a true statement about a vault that has never taken a deposit, and
     * there is nothing to locate. Saying so is the whole of the honest answer.
     */
    refuse('the measurement',
      'this vault holds no note commitments, so there is nothing whose index could be '
      + 'located. That is a true statement about the vault and not a property of the '
      + 'indexer. Fund it with a deposit first; C244 stays unmeasured until then.');
    return undefined;
  }

  for (const c of commitments) say(`    ${D}commitment ${short(c)}${O}`);
  return {
    address: record.contractAddress,
    commitments,
    deployBlockHeight: record.deployTx?.blockHeight,
  };
}

const hexBytes = (h: string): Uint8Array => {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};

const hexOf = (b: unknown): string =>
  b instanceof Uint8Array
    ? [...b].map(x => x.toString(16).padStart(2, '0')).join('')
    : String(b);

/* ------------------------------------------------------------------ *
 * stage 3 — five surfaces, each of which ANSWERS or REFUSES
 * ------------------------------------------------------------------ */

/**
 * An index this instrument is willing to stand behind.
 *
 * **`derivation` is not decoration.** It is the sentence that has to survive
 * somebody reading this report a month later and asking why the number is
 * believed. A `Located` without one is the shape `C238` exists about.
 */
export interface Located { commitment: string; index: bigint; from: string; derivation: string }

/**
 * **ANSWERED AND REFUSED ARE DIFFERENT AND THE VERDICT DEPENDS ON WHICH.**
 * `C110`, one layer out.
 *
 * A surface ANSWERS when it read what it went for and reached a conclusion,
 * including the conclusion *"this does not carry the index"*. It REFUSES when
 * it could not read at all: no network, no such field, bytes that did not
 * decode. **Five refusals are not evidence that the index cannot be obtained**,
 * and a verdict that treats them as evidence is the instrument ruling a launch
 * gate off its own inability to run.
 */
export interface Attempt { located: Located[]; answered: number }

/* ------------------------------------------------------------------ *
 * surfaces F and G — the parts that decide, kept out of the network path
 * ------------------------------------------------------------------ *
 *
 * **THESE ARE PURE AND EXPORTED FOR ONE REASON: A TEST CAN DRIVE BOTH OF EACH
 * SURFACE'S VERDICTS WITHOUT AN INDEXER.** `C263`, `C265`. Twice now this file
 * has shipped a surface that could reach only the verdict ordering a redesign —
 * once because nothing wrote to `located`, once because the only writer asked a
 * question the schema refuses — and both times the branch tests passed because
 * the deciding code was tangled into the fetch. A verdict that cannot be
 * reached in a test is a verdict nobody has seen.
 */

/**
 * The index range a settled transaction's outputs occupy, as surface B reads it.
 *
 * `endExclusive` is the schema's own word: *"The end index into the zswap
 * state; exclusive, i.e. the next free index."* **The ledger's `end` is
 * INCLUSIVE** (`MerkleTreeCollapsedUpdate::new`,
 * `midnight-src/midnight-ledger/transient-crypto/src/merkle_tree.rs:384-409`),
 * so the two numbers name different leaves and the conversion is never done
 * silently.
 */
export interface LeafRange {
  start: bigint;
  endExclusive: bigint;
  txHash: string;
  merkleTreeRoot?: string;
}

/**
 * **HOW MANY CANDIDATES ARE WORTH ASKING ABOUT ONE AT A TIME.** A payroll run
 * settles many payments in one transaction by design (`V-60`, `V-61`), so a
 * range is not always two leaves, and a loop that asks the ledger once per leaf
 * over a range of thousands is a different instrument. Beyond this, G refuses
 * and says so rather than half-asking.
 */
export const MOST_CANDIDATES = 64;

/** The leaves a range names. Two candidates is not an answer; it is a list. */
export function candidatesOf(r: LeafRange): bigint[] {
  const out: bigint[] = [];
  for (let i = r.start; i < r.endExclusive; i += 1n) out.push(i);
  return out;
}

/* ---------------------------- F ---------------------------- */

/** What F read, once the narrow update was fetched, deserialised and applied. */
export interface NarrowUpdate {
  askedStart: bigint;
  askedEndInclusive: bigint;
  bytes: number;
  firstFreeBefore: bigint;
  firstFreeAfter: bigint;
  /** `ZswapLocalState.coins` — the set of SPENDABLE coins, each carrying `mt_index`. */
  qualifiedCoins: number;
}

export type NarrowVerdict = 'A QUALIFIED COIN' | 'NO LEAF';

/**
 * **F ANSWERS EITHER WAY AND NEITHER ANSWER IS A REFUSAL.**
 *
 * A collapsed update that yields a qualified coin would mean the index is
 * obtainable from a served surface with nothing else held. A collapsed update
 * that yields none is a statement about what a collapsed update IS — hashes,
 * no leaves (`merkle_tree.rs:309-315`) — and that closes the route rather than
 * failing to read it.
 *
 * **`A QUALIFIED COIN` IS EXPECTED TO BE UNREACHABLE, AND IT IS KEPT BECAUSE
 * OF THAT RATHER THAN IN SPITE OF IT.** `apply_collapsed_update` is
 * `{ merkle_tree, first_free, ..self.clone() }` (`zswap/src/local.rs:75-84`) —
 * **`coins` is carried across untouched** — and every writer of `coins` takes
 * `ZswapSecretKeys`, which a contract-owned coin has none of. So this branch
 * is a FALSIFIER of that source reading and not a path anybody expects a run
 * to take: if it ever fires, the reading above is wrong and the run says so on
 * the screen. **Which is why `NO LEAF` counts towards NOTHING** — it is a
 * property of the type that was applied, established from source, not a
 * reading about this vault — **and only `A QUALIFIED COIN` would count.**
 */
export function narrowUpdateVerdict(u: NarrowUpdate): NarrowVerdict {
  return u.qualifiedCoins > 0 ? 'A QUALIFIED COIN' : 'NO LEAF';
}

/* ---------------------------- G ---------------------------- */

/**
 * What one ask of the ledger's own constructor establishes, and it is about a
 * PAIR of leaves rather than about one leaf. See this file's header for why,
 * and for the two source lines that make it so.
 */
export type PairOutcome = 'PAIR NOT COLLAPSED' | 'PAIR COLLAPSED' | 'UNREADABLE';

export interface PairReading {
  index: bigint;
  outcome: PairOutcome;
  from: string;
  detail: string;
}

/** The merkle sibling of a leaf. The pair `{i, i^1}` is one height-1 node. */
export const siblingOf = (i: bigint): bigint => (i % 2n === 0n ? i + 1n : i - 1n);

/**
 * **TWO MESSAGES MEAN SOMETHING AND EVERY OTHER ONE IS A REFUSAL, DELIBERATELY
 * IN THAT DIRECTION.** `C238`, `C263`.
 *
 * The constructor either builds — no ancestor of `index` above height 0 is
 * collapsed, so the pair containing it survived the filter — or it refuses.
 * `InvalidUpdate::CollapsedIndex` prints *"attempted update on collapsed
 * sub-tree at {idx}/{height}"* (`merkle_tree.rs:167-193`), and **it is only
 * read as `PAIR COLLAPSED` when it names the index this call asked about.**
 * Every other refusal — a stub, a tree that would not rehash, a message this
 * project has never seen — is UNREADABLE and counts towards nothing.
 *
 * **So a message that changes upstream degrades to a refusal and never to a
 * wrong answer**, which is the only safe direction. **And the throw itself is
 * undocumented**: `ledger-v9.d.ts` says this constructor throws *"If the
 * indices are out-of-bounds for the state, or `end < start`"* and does not
 * admit the collapsed case at all, so the degrade is load-bearing rather than
 * defensive.
 */
export function classifyPair(
  index: bigint,
  r: { ok: boolean; message?: string },
): PairOutcome {
  if (r.ok) return 'PAIR NOT COLLAPSED';
  return (r.message ?? '').includes(`collapsed sub-tree at ${index}/`)
    ? 'PAIR COLLAPSED'
    : 'UNREADABLE';
}

/**
 * **G HAS NO POSITIVE VERDICT AND THAT IS THE MEASUREMENT, NOT A GAP IN IT.**
 *
 * EXCLUDED is the real negative: every candidate was read and every one sits
 * in a pair this vault's filtered tree collapsed away, so none of them is the
 * vault's leaf. NARROWED is what this surface reaches when a pair survives —
 * one of two leaves is the vault's and **nothing available to JS says which**,
 * which is exactly where surface B already stood. UNREADABLE is our ignorance
 * and rules on nothing (`C110`).
 *
 * **NOTHING HERE WRITES INTO `located`.** A first draft of this surface did,
 * on the strength of a claim about leaf granularity that is false; the reading
 * it would have recorded is `C244`'s own failure mode — a merkle path built for
 * a different leaf, refused by the chain with nothing a person can act on.
 */
export type QualifyVerdict = 'EXCLUDED' | 'NARROWED' | 'UNREADABLE';

export interface Qualification {
  verdict: QualifyVerdict;
  /** Leaves this vault's own tree does not hold. A reading, not a guess. */
  excluded: bigint[];
  /** Leaves still in play, each with its sibling, because the pair is the unit. */
  surviving: bigint[];
}

/**
 * **THE CONTROL IS CHECKED BEFORE ANY ANSWER IS BELIEVED.**
 *
 * A probe that answers *not collapsed* to everything is indistinguishable from
 * a tree in which everything is retained, and one of those is a broken read.
 * So indices known to be outside the vault's own range are asked too, and
 * **unless every one of them comes back `PAIR COLLAPSED` the whole surface is
 * UNREADABLE** — including the candidates that looked like answers.
 */
export function qualify(
  readings: PairReading[],
  controls: PairReading[],
  asked: bigint[],
): Qualification {
  const none: Qualification = { verdict: 'UNREADABLE', excluded: [], surviving: [] };
  if (controls.length === 0 || !controls.every((c) => c.outcome === 'PAIR COLLAPSED')) return none;
  if (readings.length === 0 || readings.some((r) => r.outcome === 'UNREADABLE')) return none;

  const byIndex = new Map<string, Set<PairOutcome>>();
  for (const r of readings) {
    const at = byIndex.get(String(r.index)) ?? new Set<PairOutcome>();
    at.add(r.outcome);
    byIndex.set(String(r.index), at);
  }
  /* Two reads of the same object disagreeing is a finding, never a casting vote. */
  for (const at of byIndex.values()) if (at.size > 1) return none;

  /*
   * **COMPLETENESS IS HELD HERE AND NOT BY THE LOOP THAT CALLS THIS.** An
   * exclusion is a claim about EVERY candidate, and until this line the only
   * thing making it one was `for (const i of cands)` a few hundred lines away.
   * That is the shape this file's own source-level assertion about `located`
   * exists for: a later edit that filters or continues inside that loop would
   * narrow the basis of an exclusion with every test still green.
   */
  if (asked.length === 0) return none;
  if (byIndex.size !== new Set(asked.map(String)).size) return none;
  for (const i of asked) if (!byIndex.has(String(i))) return none;

  const excluded: bigint[] = [];
  const surviving: bigint[] = [];
  for (const [i, at] of byIndex) {
    (at.has('PAIR COLLAPSED') ? excluded : surviving).push(BigInt(i));
  }
  return {
    verdict: surviving.length === 0 ? 'EXCLUDED' : 'NARROWED',
    excluded: excluded.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    surviving: surviving.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

async function stageThree(v: VaultSubject): Promise<Attempt> {
  say(`\n${B}3 of 4  Seven surfaces asked "at what index is this commitment"${O}`);
  say(`  ${D}each prints the surface it read and the bytes it decoded. None of them${O}`);
  say(`  ${D}prints a number it did not read off something. C238.${O}`);
  say(`  ${D}A surface that could not be read at all is a REFUSAL and counts towards${O}`);
  say(`  ${D}no verdict; only a surface that answered does.${O}`);

  const located: Located[] = [];
  let answered = 0;
  /*
   * **WHAT A AND B READ IS WHAT F AND G ASK ABOUT, SO IT IS KEPT RATHER THAN
   * PRINTED AND DROPPED.** Surface B narrowed the answer to a range and then
   * correctly refused to guess inside it; G is that refusal being resolved by
   * a reading rather than by a choice, and it needs both the range and the
   * vault's own filtered tree to do it.
   */
  const filtered: Array<{ from: string; state: any }> = [];
  let range: LeafRange | undefined;

  /* ---- A: the vault's own filtered zswap state ---- */
  say(`\n  ${B}A  ContractAction.zswapState — the vault's OWN zswap state${O}`);
  say(`     ${D}the indexer builds this as ZswapState::new() with${O}`);
  say(`     ${D}coin_coms = ledger_state.zswap.filter(&[address]), and filter RETAINS${O}`);
  say(`     ${D}this contract's leaves at their true indices, collapsing the gaps${O}`);
  say(`     ${D}(midnight-src/midnight-ledger/zswap/src/ledger.rs:211-236)${O}`);
  try {
    const j = await gql(
      `query ($a: HexEncoded!) { contractAction(address: $a) { zswapState } }`,
      { a: v.address });
    if (j?.errors) {
      refuse('A, ContractAction.zswapState',
        `refused: ${JSON.stringify(j.errors).slice(0, 500)}`);
    } else {
      const raw = j?.data?.contractAction?.zswapState;
      if (!raw) {
        refuse('A, ContractAction.zswapState', 'the field came back empty');
      } else {
        /*
         * **THIS IS THE LEDGER'S OWN TYPE READING THE LEDGER'S OWN BYTES, AND
         * IT DOES NOT CROSS THE BOUNDARY STAGE 2 CROSSED.** `C264`.
         *
         * Stage 2's old defect was handing a `ledger-v9` object to a reader
         * compiled against `onchain-runtime-v4`. Here the object deserialised
         * from `midnight-js-protocol/ledger` is only ever asked for its own
         * `firstFree` and its own Debug string, so there is no hand-off.
         * **MEASURED, 29 Aug: A, C and E all deserialised and answered in the
         * run that established stage 2's failure**, so the fix to stage 2 is
         * not owed here.
         */
        const { ZswapChainState } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
        const st: any = (ZswapChainState as any).deserialize(hexBytes(raw));
        filtered.push({ from: 'A, ContractAction.zswapState', state: st });
        say(`     ${G}✓${O} deserialised ${hexBytes(raw).length} bytes; firstFree = ${st.firstFree}`);
        say(`     ${D}firstFree is READ, not derived: ZswapChainState.firstFree — AND IT IS${O}`);
        say(`     ${D}NOT A LEAF COUNT: the indexer builds this state with ZswapState::new()${O}`);
        say(`     ${D}and replaces only coin_coms, so first_free keeps new()'s zero. The${O}`);
        say(`     ${D}leaves are still at their true indices. See this file's header.${O}`);
        /*
         * `ZswapChainState` in @midnightntwrk/ledger-v9 declares firstFree,
         * serialize, deserialize, deserializeFromLedgerState, postBlockUpdate,
         * tryApply, toString and filter — AND NO LEAF ITERATOR (`V-149`,
         * divergence 11). So the only way to reach a leaf from JS is the Debug
         * string, and whether that even carries one is what this measures.
         */
        const dump = String(st.toString(false));
        say(`     ${D}the object exposes no leaf iterator, so its Debug string is${O}`);
        say(`     ${D}searched instead — ${dump.length} characters${O}`);
        answered += 1;
        let seen = 0;
        for (const c of v.commitments) {
          const at = dump.indexOf(c);
          if (at < 0) continue;
          seen += 1;
          say(`     ${Y}the Debug string contains commitment ${short(c)} at character ${at}${O}`);
          say(`       ${D}${dump.slice(Math.max(0, at - 240), at + 96).replace(/\s+/g, ' ')}${O}`);
          /*
           * **NO NUMBER IS EXTRACTED FROM THIS WINDOW, DELIBERATELY.** An
           * earlier draft printed the first index-shaped number in the 300
           * characters before the commitment and said it "stands before it".
           * That asserted an adjacency the search does not establish, which is
           * `C238`'s defect in miniature. The window is printed; the reader
           * judges it; nothing here turns it into an index.
           */
          say(`       ${Y}NO INDEX IS TAKEN FROM THIS. The Debug format is undocumented,${O}`);
          say(`       ${Y}so a number picked out of it would be a guess wearing a${O}`);
          say(`       ${Y}measurement's clothes, and a wrong index is a transaction the${O}`);
          say(`       ${Y}chain refuses with nothing a person can act on.${O}`);
        }
        if (seen === 0) {
          say(`     ${Y}ANSWERED, AND THE ANSWER IS NO.${O} the state deserialised and its`);
          say(`     ${D}Debug string carries none of this vault's commitments, so no index${O}`);
          say(`     ${D}can be read off it. The leaves are hashed into the tree, not listed.${O}`);
        }
      }
    }
  } catch (e: any) {
    refuse('A, ContractAction.zswapState', String(e?.message ?? e).slice(0, 500));
  }

  /* ---- B: the transaction's own index range ---- */
  say(`\n  ${B}B  RegularTransaction.zswapStartIndex / zswapEndIndex${O}`);
  say(`     ${D}the index range a SETTLED transaction's outputs occupy.${O}`);
  say(`     ${Y}ON RegularTransaction, NOT ON Transaction.${O} ${D}Transaction is an INTERFACE and${O}`);
  say(`     ${D}carries neither field; asking for them there answers "Unknown field${O}`);
  say(`     ${D}\\"zswapStartIndex\\" on type \\"Transaction\\"" and reads as a refusal rather${O}`);
  say(`     ${D}than an answer — which is what this surface did until it was measured.${O}`);
  try {
    /*
     * **THE INLINE FRAGMENT IS THE MEASUREMENT, NOT A STYLE CHOICE.** `V-148`.
     *
     * `contractAction.transaction` is typed as the `Transaction` INTERFACE, and
     * the two index fields exist only on its `RegularTransaction`
     * implementation. Selecting them directly is refused by the schema — and a
     * refusal counts towards no verdict, so this surface, **the only one that
     * writes into `located`**, could never have ruled `C244` obtainable however
     * the chain answered. Measured against the stagenet indexer on 29 August:
     * the bare form errors, this form returns data.
     */
    const j = await gql(
      `query ($a: HexEncoded!) {
         contractAction(address: $a) {
           transaction {
             hash
             block { height zswapEndIndex }
             ... on RegularTransaction { zswapStartIndex zswapEndIndex zswapMerkleTreeRoot }
           }
         }
       }`,
      { a: v.address });
    if (j?.errors) {
      refuse('B, RegularTransaction.zswapStartIndex/zswapEndIndex',
        `refused: ${JSON.stringify(j.errors).slice(0, 500)}`);
    } else {
      const t = j?.data?.contractAction?.transaction;
      if (!t) {
        refuse('B, RegularTransaction.zswapStartIndex/zswapEndIndex', 'no transaction came back');
      } else if (t.zswapStartIndex == null || t.zswapEndIndex == null) {
        /*
         * **A TRANSACTION THAT IS NOT A `RegularTransaction` ANSWERS THE
         * FRAGMENT WITH NOTHING**, and that is a reading rather than a failure
         * to read: the action settled in a transaction that carries no zswap
         * index range at all. Counting it as a refusal would hide it among the
         * network failures, which is `C110` in the direction that matters least
         * and still matters.
         */
        answered += 1;
        say(`     ${Y}ANSWERED, AND THERE IS NO RANGE.${O} the action's transaction carries`);
        say(`     ${D}no zswapStartIndex/zswapEndIndex, so it is not a RegularTransaction —${O}`);
        say(`     ${D}the fragment matched nothing. NOTHING RECORDED.${O}`);
      } else {
        answered += 1;
        say(`     ${G}✓${O} transaction ${short(String(t.hash))}`);
        say(`       ${D}zswapStartIndex ${t.zswapStartIndex}, zswapEndIndex ${t.zswapEndIndex}${O}`);
        say(`       ${D}its block ${t.block?.height}, block zswapEndIndex ${t.block?.zswapEndIndex}${O}`);
        if (t.zswapMerkleTreeRoot) {
          say(`       ${D}zswapMerkleTreeRoot ${short(String(t.zswapMerkleTreeRoot))} — read and${O}`);
          say(`       ${D}carried to G, which says what can and cannot be done with it${O}`);
        }
        const start = BigInt(t.zswapStartIndex);
        range = {
          start,
          endExclusive: BigInt(t.zswapEndIndex),
          txHash: String(t.hash),
          merkleTreeRoot: t.zswapMerkleTreeRoot ? String(t.zswapMerkleTreeRoot) : undefined,
        };
        const span = Number(BigInt(t.zswapEndIndex) - start);
        say(`     ${D}this action's outputs occupy [${t.zswapStartIndex}, ${t.zswapEndIndex}),`);
        say(`     ${D}which is ${span} leaf/leaves.${O}`);
        /*
         * **THE IDENTIFICATION HAS TO BE FORCED, NEVER CHOSEN.** This field
         * says WHERE the transaction's leaves went and never WHICH commitment
         * is which. One leaf and one commitment leaves nothing to choose
         * between, and that is a reading. Anything else narrows, and a narrowed
         * index is not an index: `witnessesOver` refuses without one precisely
         * so nobody supplies a near miss.
         */
        if (span === 1 && v.commitments.length === 1) {
          const only = v.commitments[0];
          say(`     ${G}${B}READ: commitment ${short(only)} is at index ${start}.${O}`);
          say(`     ${D}derivation: this action inserted exactly one zswap leaf${O}`);
          say(`     ${D}(zswapEndIndex ${t.zswapEndIndex} minus zswapStartIndex ${t.zswapStartIndex}${O}`);
          say(`     ${D}is 1) and the chain holds exactly one commitment for this vault,${O}`);
          say(`     ${D}so the pairing is forced rather than chosen. Both numbers were${O}`);
          say(`     ${D}read off Transaction; neither was computed here.${O}`);
          located.push({
            commitment: only,
            index: start,
            from: 'Transaction.zswapStartIndex, via contractAction(address:)',
            derivation:
              `this action inserted exactly one zswap leaf (${t.zswapEndIndex} - ${t.zswapStartIndex} = 1) `
              + 'and the chain holds exactly one commitment for this vault, so the pairing is forced',
          });
        } else if (span === 1) {
          say(`     ${Y}ANSWERED, AND IT DOES NOT IDENTIFY.${O} one leaf went in at`);
          say(`     ${Y}${start}, and the chain holds ${v.commitments.length} commitments for this${O}`);
          say(`     ${Y}vault. Which of them sits at ${start} is not stated by this field, and${O}`);
          say(`     ${Y}picking one is a guess. NOTHING RECORDED.${O}`);
        } else if (span > 1) {
          say(`     ${Y}ANSWERED, AND IT ONLY NARROWS.${O} ${span} leaves, and nothing here`);
          say(`     ${Y}says which is ours. A narrowed index is not an index. NOTHING RECORDED.${O}`);
        } else {
          say(`     ${Y}ANSWERED: this action inserted no zswap leaves at all.${O}`);
        }
      }
    }
  } catch (e: any) {
    refuse('B, RegularTransaction.zswapStartIndex/zswapEndIndex', String(e?.message ?? e).slice(0, 500));
  }

  /* ---- C: the collapsed update, the candidate C244 names ---- */
  say(`\n  ${B}C  zswapMerkleTreeCollapsedUpdate(startIndex, endIndex)${O}`);
  say(`     ${D}the candidate C244 names, off our own reference line 403${O}`);
  try {
    const head = await gql(`query { block { height zswapEndIndex } }`);
    const end = Number(head?.data?.block?.zswapEndIndex ?? -1);
    if (!(end > 0)) {
      refuse('C, zswapMerkleTreeCollapsedUpdate',
        `the latest block's zswapEndIndex did not read: ${JSON.stringify(head?.errors ?? head?.data).slice(0, 500)}`);
    } else {
      say(`     ${G}✓${O} latest block ${head.data.block.height}, zswapEndIndex ${end}`);
      say(`       ${D}zswapEndIndex is exclusive (next free), so the last leaf is ${end - 1}${O}`);
      const j = await gql(
        `query ($s: Int!, $e: Int!) {
           zswapMerkleTreeCollapsedUpdate(startIndex: $s, endIndex: $e) {
             startIndex endIndex update protocolVersion
           }
         }`,
        { s: 0, e: end - 1 });
      if (j?.errors) {
        refuse('C, zswapMerkleTreeCollapsedUpdate',
          `refused: ${JSON.stringify(j.errors).slice(0, 500)}`);
      } else {
        const u = j?.data?.zswapMerkleTreeCollapsedUpdate;
        const bytes = hexBytes(String(u.update));
        say(`     ${G}✓${O} [${u.startIndex}, ${u.endIndex}], ${bytes.length} bytes, protocol ${u.protocolVersion}`);
        /* Same-module, same reasoning as A: deserialised and then only asked
         * for its own Debug string. Measured 29 Aug alongside A and E. */
        const { MerkleTreeCollapsedUpdate } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
        const parsed: any = (MerkleTreeCollapsedUpdate as any).deserialize(bytes);
        const dump = String(parsed.toString(false));
        say(`     ${G}✓${O} deserialised; its Debug string is ${dump.length} characters`);
        answered += 1;
        const hits = v.commitments.filter((c) => dump.includes(c));
        for (const c of hits) say(`     ${Y}it contains commitment ${short(c)}${O}`);
        if (hits.length === 0) {
          say(`     ${Y}ANSWERED, AND THE ANSWER IS NO.${O} the update deserialised and`);
          say(`     ${D}carries none of this vault's commitments by value. A collapsed update${O}`);
          say(`     ${D}carries HASHES for the range rather than the leaves in it.${O}`);
        } else {
          say(`     ${Y}present, but no index is taken from a Debug string. See A.${O}`);
        }
      }
    }
  } catch (e: any) {
    refuse('C, zswapMerkleTreeCollapsedUpdate', String(e?.message ?? e).slice(0, 500));
  }

  /* ---- D: the raw zswap ledger events ---- */
  say(`\n  ${B}D  Transaction.zswapLedgerEvents${O}`);
  say(`     ${D}the raw serialised zswap ledger events of the transaction. Named${O}`);
  say(`     ${D}in neither C244 nor our own reference.${O}`);
  try {
    const j = await gql(
      `query ($a: HexEncoded!) {
         contractAction(address: $a) {
           transaction { zswapLedgerEvents { id raw maxId protocolVersion } }
         }
       }`,
      { a: v.address });
    if (j?.errors) {
      refuse('D, Transaction.zswapLedgerEvents',
        `refused: ${JSON.stringify(j.errors).slice(0, 500)}`);
    } else {
      const evs = j?.data?.contractAction?.transaction?.zswapLedgerEvents ?? [];
      if (evs.length === 0) {
        refuse('D, Transaction.zswapLedgerEvents', 'this transaction carries none');
      } else {
        answered += 1;
        say(`     ${G}✓${O} ${evs.length} zswap ledger event(s) on this transaction`);
        let seen = 0;
        for (const e of evs) {
          const raw = String(e.raw);
          say(`       ${D}event ${e.id}, ${hexBytes(raw).length} bytes, protocol ${e.protocolVersion}${O}`);
          for (const c of v.commitments) {
            if (!raw.includes(c)) continue;
            seen += 1;
            say(`     ${Y}event ${e.id} CONTAINS commitment ${short(c)} at byte offset ${raw.indexOf(c) / 2}${O}`);
            say(`       ${Y}A BYTE OFFSET INSIDE A SERIALISED EVENT IS NOT A TREE INDEX${O}`);
            say(`       ${Y}and nothing here treats it as one. Deserialising the event is${O}`);
            say(`       ${Y}what would answer, and this instrument does not yet know that${O}`);
            say(`       ${Y}type's name. NOTHING RECORDED.${O}`);
          }
        }
        if (seen === 0) {
          say(`     ${Y}ANSWERED, AND THE ANSWER IS NO.${O} none of the events carries any`);
          say(`     ${D}of this vault's commitments in its raw bytes.${O}`);
        }
      }
    }
  } catch (e: any) {
    refuse('D, Transaction.zswapLedgerEvents', String(e?.message ?? e).slice(0, 500));
  }


  /* ---- E: the vault's OWN commitment tree, at the LATEST block ---- */
  say(`\n  ${B}E  Block.contractZswapState(address:) — the vault's OWN tree${O}`);
  say(`     ${D}"the zswap commitment tree FILTERED TO THE GIVEN CONTRACT ADDRESS,${O}`);
  say(`     ${D}resolved from this block's ledger state; null if the contract does${O}`);
  say(`     ${D}not exist at this block" — schema-v4.graphql:109, docs/midnight/02 §Block${O}`);
  say(`     ${Y}READ AT THE LATEST BLOCK, WHICH THE SCHEMA REQUIRES RATHER THAN${O}`);
  say(`     ${Y}SUGGESTS:${O} ${D}older trees age out of the ledger's root window, and blocks${O}`);
  say(`     ${D}beyond the chain-indexer's retention window have no loadable ledger${O}`);
  say(`     ${D}state and YIELD AN ERROR. So a read at the deploy block would refuse${O}`);
  say(`     ${D}for age, and reading that refusal as "the field does not work" would${O}`);
  say(`     ${D}close the most promising surface C244 has.${O}`);
  say(`     ${D}Composed with ledgerParameters and contract { state } in ONE request,${O}`);
  say(`     ${D}which is how the schema says to ask for it.${O}`);
  try {
    const j = await gql(
      `query ($a: HexEncoded!) {
         block { height hash ledgerParameters contractZswapState(address: $a) }
         contract(address: $a) { state }
       }`,
      { a: v.address });
    if (j?.errors) {
      /*
       * **A REFUSAL HERE IS ABOUT THIS REQUEST, NOT ABOUT THE FIELD.** The
       * schema names two ways this errors that have nothing to do with whether
       * a tree carries an index: a root outside the ledger's window, and a
       * block outside the indexer's retention. Both are read as refusals and
       * count towards no verdict, which is what `C263` exists about.
       */
      refuse('E, Block.contractZswapState',
        `refused: ${JSON.stringify(j.errors).slice(0, 500)}. An error here can be the tree `
        + 'having aged out rather than the field being unusable, and the two are different '
        + 'answers; this run read at the LATEST block, so age is not the explanation.');
    } else {
      const raw = j?.data?.block?.contractZswapState;
      const height = j?.data?.block?.height;
      const params = j?.data?.block?.ledgerParameters;
      const cstate = j?.data?.contract?.state;
      say(`     ${G}✓${O} block ${height}; ledgerParameters ${params ? 'present' : 'ABSENT'}, `
        + `contract state ${cstate ? 'present' : 'ABSENT'}`);
      if (!raw) {
        /*
         * NOT AN ANSWER. `C110`. Null means "the contract does not exist at
         * this block" by the schema's own words, which about a vault we just
         * read a state for is our ignorance and not a fact about the tree.
         */
        refuse('E, Block.contractZswapState',
          'the field came back null. By the schema that means the contract does not exist at '
          + 'this block — which cannot be squared with having just read its state, so this is '
          + 'read as our ignorance rather than as a statement about the tree.');
      } else {
        const bytes = hexBytes(String(raw));
        const { ZswapChainState } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
        const st: any = (ZswapChainState as any).deserialize(bytes);
        filtered.push({ from: 'E, Block.contractZswapState', state: st });
        say(`     ${G}✓${O} deserialised ${bytes.length} bytes; firstFree = ${st.firstFree}`);
        say(`     ${D}firstFree is READ, not derived, and is NOT a leaf count — the indexer${O}`);
        say(`     ${D}never assigns it on a filtered state. See this file's header.${O}`);
        answered += 1;
        /*
         * The same object and the same absence of a leaf iterator as surface A
         * (`V-149`, divergence 11), so the same discipline: the Debug string is
         * searched, printed, and **no number is taken out of it**. `C238`.
         */
        const dump = String(st.toString(false));
        say(`     ${D}no leaf iterator on this type either, so its Debug string is${O}`);
        say(`     ${D}searched instead — ${dump.length} characters${O}`);
        let seen = 0;
        for (const c of v.commitments) {
          const at = dump.indexOf(c);
          if (at < 0) continue;
          seen += 1;
          say(`     ${Y}the Debug string contains commitment ${short(c)} at character ${at}${O}`);
          say(`       ${D}${dump.slice(Math.max(0, at - 240), at + 96).replace(/\s+/g, ' ')}${O}`);
          say(`       ${Y}NO INDEX IS TAKEN FROM THIS, for the reason surface A gives.${O}`);
        }
        if (seen === 0) {
          say(`     ${Y}ANSWERED, AND THE ANSWER IS NO.${O} the vault's own tree deserialised`);
          say(`     ${D}and its Debug string carries none of this vault's commitments, so no${O}`);
          say(`     ${D}index can be read off it from JS.${O}`);
        }
      }
    }
  } catch (e: any) {
    refuse('E, Block.contractZswapState', String(e?.message ?? e).slice(0, 500));
  }

  /* ---- F: the collapsed update over the NARROW range ---- */
  say(`\n  ${B}F  zswapMerkleTreeCollapsedUpdate over the NARROW range${O}`);
  say(`     ${D}surface C asked for the WHOLE tree, and a collapsed update over the${O}`);
  say(`     ${D}whole tree collapses almost all of it. This asks for the range surface${O}`);
  say(`     ${D}B read off the depositing transaction, and then APPLIES it.${O}`);
  say(`     ${Y}WHAT IT CAN ANSWER IS NARROWER THAN IT LOOKS:${O} ${D}MerkleTreeCollapsedUpdate${O}`);
  say(`     ${D}is { start, end, hashes: Vec<MerkleTreeDigest> } — DIGESTS, and no leaf${O}`);
  say(`     ${D}value anywhere (merkle_tree.rs:309-315). So this does not ask whether${O}`);
  say(`     ${D}the update contains our commitment. It asks whether applying it${O}`);
  say(`     ${D}produces a QUALIFIED coin, which is the thing a spend needs.${O}`);
  if (!range) {
    /*
     * NOT A FAILURE OF F. Surface B is where the range comes from, and a run
     * where B refused has no narrow range to ask about. Saying so is the whole
     * of the honest answer, and it rules on nothing.
     */
    refuse('F, the narrow collapsed update',
      'surface B read no index range off the depositing transaction, so there is no narrow '
      + 'range to ask for. F is a question about the range B reports and it has nothing to ask '
      + 'about; this is B refusing, carried forward, and not a reading about the update.');
  } else {
    try {
      /*
       * **THE TWO `endIndex`es ARE DIFFERENT NUMBERS AND THE CONVERSION IS
       * PRINTED RATHER THAN PERFORMED QUIETLY.** The schema says `zswapEndIndex`
       * is *"exclusive, i.e. the next free index"*; the ledger's `end` is
       * inclusive, and the indexer passes the argument straight into
       * `MerkleTreeCollapsedUpdate::new`
       * (`indexer-api/src/infra/api/v4/query.rs:106-131`,
       * `ledger_state.rs:924-947`). So the range B reports as [start, end)
       * is asked for as (start, end - 1) — AND the unconverted form is asked
       * for too, immediately below, because a reader should not have to take
       * this paragraph on trust.
       */
      const endInclusive = range.endExclusive - 1n;
      say(`     ${D}B read [${range.start}, ${range.endExclusive}) — exclusive, the schema's own word.${O}`);
      say(`     ${D}The ledger's end is INCLUSIVE, so this asks (${range.start}, ${endInclusive}).${O}`);

      const ask = async (st: bigint, en: bigint) => gql(
        `query ($s: Int!, $e: Int!) {
           zswapMerkleTreeCollapsedUpdate(startIndex: $s, endIndex: $e) {
             startIndex endIndex update protocolVersion
           }
         }`,
        { s: Number(st), e: Number(en) });

      const j = await ask(range.start, endInclusive);
      if (j?.errors) {
        refuse('F, the narrow collapsed update',
          `the indexer refused (${range.start}, ${endInclusive}): ${JSON.stringify(j.errors).slice(0, 500)}`);
      } else {
        const u = j?.data?.zswapMerkleTreeCollapsedUpdate;
        const bytes = hexBytes(String(u.update));
        say(`     ${G}✓${O} [${u.startIndex}, ${u.endIndex}], ${bytes.length} bytes, protocol ${u.protocolVersion}`);
        say(`     ${D}surface C asked for the whole tree and printed its own byte count a${O}`);
        say(`     ${D}few lines above; the two are read off the same run and neither is${O}`);
        say(`     ${D}written down here. C238.${O}`);

        const { MerkleTreeCollapsedUpdate, ZswapLocalState } =
          await import('@midnight-ntwrk/midnight-js-protocol/ledger');
        const parsed: any = (MerkleTreeCollapsedUpdate as any).deserialize(bytes);
        /*
         * **APPLIED TO A BLANK LOCAL STATE, WHICH IS THE DOCUMENTED FLOW.** The
         * binding's own words: *"Skip (with this method) sections Alice does not
         * care about"* — a collapsed update is how a wallet fast-forwards past
         * leaves it has no business holding. `applyCollapsedUpdate` sets
         * `first_free` to `end + 1` and inserts the update's hashes into the
         * tree (`zswap/src/local.rs:75-84`). Whether it also produces a coin is
         * exactly what this measures.
         */
        const before: any = new (ZswapLocalState as any)();
        const after: any = before.applyCollapsedUpdate(parsed);
        const applied: NarrowUpdate = {
          askedStart: range.start,
          askedEndInclusive: endInclusive,
          bytes: bytes.length,
          firstFreeBefore: BigInt(before.firstFree),
          firstFreeAfter: BigInt(after.firstFree),
          /*
           * **NO `?? 0` HERE, DELIBERATELY.** A coin set that could not be read
           * and a coin set that is empty are opposite claims, and defaulting to
           * zero renders the first as the second — `C110`, in the one line of
           * this surface where a default would look harmless. An absent
           * accessor throws and reaches the refusal below.
           */
          qualifiedCoins: Number((after.coins as { size: number }).size),
        };
        say(`     ${G}✓${O} applied to a blank ZswapLocalState: firstFree ${applied.firstFreeBefore}`);
        say(`       ${D}became ${applied.firstFreeAfter}, and its spendable coin set holds ${applied.qualifiedCoins}${O}`);
        const verdict = narrowUpdateVerdict(applied);
        if (verdict === 'A QUALIFIED COIN') {
          answered += 1;
          /*
           * A qualified coin carries `mt_index`, and that is a reading. It is
           * PRINTED and NOT recorded, because nothing here ties one of these
           * coins to one of this vault's commitments: `QualifiedShieldedCoinInfo`
           * carries nonce, type, value and index, and the commitment is a hash
           * of the first three with a recipient. Tying them is a derivation this
           * file does not have and must not invent. C238.
           */
          say(`     ${G}${B}ANSWERED: applying the narrow update produced ${applied.qualifiedCoins} qualified${O}`);
          say(`     ${G}${B}coin(s), each carrying an mt_index.${O}`);
          for (const c of after.coins) {
            say(`       ${G}mt_index ${(c as any).mt_index}${O}  ${D}read off QualifiedShieldedCoinInfo${O}`);
          }
          say(`       ${Y}NOTHING IS RECORDED FROM THIS. A qualified coin is not yet tied to${O}`);
          say(`       ${Y}one of this vault's commitments, and inventing the tie is the defect${O}`);
          say(`       ${Y}this instrument exists to refuse. AND THIS BRANCH REFUTES A SOURCE${O}`);
          say(`       ${Y}READING THIS FILE MAKES TWICE${O} ${D}— apply_collapsed_update carries coins${O}`);
          say(`       ${D}across untouched and every writer of that set takes ZswapSecretKeys —${O}`);
          say(`       ${D}so it should be impossible. Read the source again before acting on it.${O}`);
        } else {
          say(`     ${Y}ANSWERED, AND THE ANSWER IS NO — AND IT IS AN ANSWER ABOUT THE${O}`);
          say(`     ${Y}MECHANISM RATHER THAN ABOUT THIS VAULT.${O} a collapsed update carries`);
          say(`     ${D}start, end and a vector of digests, and no leaf value at either end of${O}`);
          say(`     ${D}the range (merkle_tree.rs:309-315). Applying it fast-forwards the tree${O}`);
          say(`     ${D}and inserts NO coin, so no mt_index can come out of this route however${O}`);
          say(`     ${D}narrow the range is. Narrowing the range does not change the kind of${O}`);
          say(`     ${D}thing a collapsed update is.${O}`);
          say(`     ${Y}AND THIS COUNTS TOWARDS NOTHING.${O} ${D}apply_collapsed_update carries coins${O}`);
          say(`     ${D}across untouched (zswap/src/local.rs:75-84) and every writer of that set${O}`);
          say(`     ${D}takes ZswapSecretKeys, which a contract-owned coin has none of. So this${O}`);
          say(`     ${D}line was established from source before the run and the run did not${O}`);
          say(`     ${D}refute it. A surface whose answer is a property of the type it applied${O}`);
          say(`     ${D}is not evidence about this vault, and the verdict below does not count${O}`);
          say(`     ${D}it. C263.${O}`);
        }

        /*
         * **AND THE UNCONVERTED RANGE, ASKED FOR RATHER THAN REASONED ABOUT.**
         * `C244`'s own text and this round's brief both name `(616, 618)`. If
         * that form answers, the conversion above is wrong and this line says
         * so; if it refuses, the refusal is about a leaf past the tree's last
         * one and not about F.
         */
        const lit = await ask(range.start, range.endExclusive);
        if (lit?.errors) {
          say(`     ${D}and the unconverted range (${range.start}, ${range.endExclusive}) — the form named in${O}`);
          say(`     ${D}C244's text — was refused: ${JSON.stringify(lit.errors).slice(0, 200)}${O}`);
        } else {
          const l = lit?.data?.zswapMerkleTreeCollapsedUpdate;
          say(`     ${Y}and the unconverted range (${range.start}, ${range.endExclusive}) ALSO answered:${O}`);
          say(`     ${Y}[${l?.startIndex}, ${l?.endIndex}], ${hexBytes(String(l?.update)).length} bytes. Read the conversion above again.${O}`);
        }
      }
    } catch (e: any) {
      refuse('F, the narrow collapsed update', String(e?.message ?? e).slice(0, 500));
    }
  }

  /* ---- G: which candidate leaves the vault's OWN tree does not hold ---- */
  say(`\n  ${B}G  ASK THE VAULT'S OWN TREE WHICH CANDIDATES IT DOES NOT HOLD${O}`);
  say(`     ${D}the question C244 asks is not "can a number be found in a string". It${O}`);
  say(`     ${D}is "can this note be spent", and a note is spendable when a merkle path${O}`);
  say(`     ${D}can be built for it. filter RETAINS this contract's leaves at their true${O}`);
  say(`     ${D}indices and COLLAPSES every other leaf (zswap/src/ledger.rs:211-236), and${O}`);
  say(`     ${D}the ledger's own MerkleTreeCollapsedUpdate constructor refuses over a${O}`);
  say(`     ${D}range whose ANCESTORS are collapsed (merkle_tree.rs:363-382).${O}`);
  say(`     ${Y}AND IT READS AT PAIR GRANULARITY, NOT LEAF GRANULARITY.${O} ${D}partial_index${O}`);
  say(`     ${D}hands the node at height 0 to root() without matching it (:369-381), and${O}`);
  say(`     ${D}root() answers for a Leaf, a Collapsed{0} and a Stub{0} alike (:704-711).${O}`);
  say(`     ${D}A Collapsed{0} is exactly what filter leaves at the SIBLING of every leaf${O}`);
  say(`     ${D}it retained. So a build means ONE OF THE PAIR {i, i^1} is this vault's and${O}`);
  say(`     ${D}not which; a refusal means NEITHER of them is.${O}`);
  say(`     ${B}THE NEGATIVE IS EXACT. THE POSITIVE NARROWS TO TWO AND STOPS THERE, AND${O}`);
  say(`     ${B}THIS SURFACE RECORDS NOTHING.${O}`);
  if (range?.merkleTreeRoot) {
    /*
     * **THE ROOT IS READ AND THE COMPARISON IS REFUSED, AND SAYING WHICH IS THE
     * POINT.** `RegularTransaction.zswapMerkleTreeRoot` is *"the hex-encoded
     * SERIALIZED zswap state Merkle tree root"*; the only root the JS binding
     * hands back is `ZswapLocalState.merkleTreeRoot`, a `bigint`. Nothing in
     * the binding converts between them, nothing verifies a path against one,
     * and `ZswapChainState` has no root accessor at all. Writing the conversion
     * here would be reimplementing a serialisation from the outside — a guess
     * wearing a measurement's clothes, on the value the money depends on.
     * `C238`. **And `pathForLeaf` in the same package is NOT the answer**: it
     * is on `StateBoundedMerkleTree`, a contract's own state tree, which cannot
     * be loaded from a zswap state.
     */
    say(`     ${D}the transaction's own zswapMerkleTreeRoot was read: ${short(range.merkleTreeRoot)}${O}`);
    say(`     ${Y}AND NO PATH IS CHECKED AGAINST IT HERE, WHICH IS A REFUSAL AND NOT AN${O}`);
    say(`     ${Y}OVERSIGHT.${O} ${D}the schema serves a SERIALIZED root as hex; the only root the JS${O}`);
    say(`     ${D}binding offers is ZswapLocalState.merkleTreeRoot, a bigint, and nothing in${O}`);
    say(`     ${D}the binding converts between the two or verifies a path against either.${O}`);
    say(`     ${D}WHAT WOULD CLOSE IT: an accessor on the binding that serialises a zswap${O}`);
    say(`     ${D}root, or one that verifies a path. Neither is in ledger-v9.d.ts, and the${O}`);
    say(`     ${D}pathForLeaf that IS there belongs to a contract's own state tree.${O}`);
  }
  if (!range) {
    refuse('G, the vault\x27s own tree',
      'surface B read no index range, so there are no candidate leaves to ask about. This is B '
      + 'refusing, carried forward, and rules on nothing.');
  } else if (filtered.length === 0) {
    refuse('G, the vault\x27s own tree',
      'neither surface A nor surface E produced a filtered zswap state for this vault, so there '
      + 'is no tree to ask about a candidate. Both are reads of the same object by two routes '
      + 'and both refused; that is a fact about this run and not about the tree.');
  } else if (range.endExclusive - range.start > BigInt(MOST_CANDIDATES)) {
    /*
     * **THE CEILING IS CHECKED ON THE RANGE, BEFORE THE LIST IS BUILT.** A
     * malformed range should not be allocated and then refused.
     */
    refuse('G, the vault\x27s own tree',
      `the range [${range.start}, ${range.endExclusive}) names ${range.endExclusive - range.start} candidate `
      + `leaves, and this surface asks the ledger once per leaf. It refuses above ${MOST_CANDIDATES} `
      + 'rather than half-asking. A range that size is a transaction with many outputs, which is '
      + 'what a payroll run settles by design, and picking one note out of it is a different '
      + 'instrument.');
  } else {
    const cands = candidatesOf(range);
    if (cands.length === 0) {
      refuse('G, the vault\x27s own tree',
        'this action\x27s transaction inserted no zswap leaves, so its range names no candidate '
        + 'to ask about. Surface B says the same thing one surface earlier.');
    } else {
      const { MerkleTreeCollapsedUpdate } =
        await import('@midnight-ntwrk/midnight-js-protocol/ledger');

      /*
       * **THE CONTROLS, AND THEY ARE ASKED FOR THE SAME REASON A THERMOMETER IS
       * PUT IN ICE.** A tree that answered *not collapsed* to every index would
       * look identical to a tree that retained every leaf, and one of those is a
       * broken read. Leaf 0 and leaf 1 are the chain's very first commitments;
       * a vault deployed at block 231,000 does not own them, so both must come
       * back collapsed. **If either does not, every answer below is discarded.**
       * A vault that genuinely owns leaf 0 or 1 makes this surface refuse, which
       * is a refusal and not a wrong answer.
       */
      const controlIndices = [0n, 1n].filter((i) => !cands.includes(i));

      const ask = (state: any, i: bigint, from: string): PairReading => {
        try {
          /* eslint-disable-next-line no-new */
          new (MerkleTreeCollapsedUpdate as any)(state, i, i);
          return {
            index: i,
            outcome: classifyPair(i, { ok: true }),
            from,
            detail: 'the constructor built over (i, i), so no ancestor above height 0 is collapsed',
          };
        } catch (e: any) {
          const message = String(e?.message ?? e);
          return { index: i, outcome: classifyPair(i, { ok: false, message }), from, detail: message.slice(0, 200) };
        }
      };

      const readings: PairReading[] = [];
      const controls: PairReading[] = [];
      for (const f of filtered) {
        say(`     ${B}against ${f.from}${O}`);
        for (const i of controlIndices) {
          const r = ask(f.state, i, f.from);
          controls.push(r);
          say(`       ${D}control leaf ${i}: ${r.outcome}${O}  ${D}${r.detail}${O}`);
        }
        for (const i of cands) {
          const r = ask(f.state, i, f.from);
          readings.push(r);
          const colour = r.outcome === 'PAIR COLLAPSED' ? G : r.outcome === 'PAIR NOT COLLAPSED' ? Y : R;
          say(`       ${colour}leaf ${i} (pair with ${siblingOf(i)}): ${r.outcome}${O}`);
          say(`         ${D}${r.detail}${O}`);
        }
      }

      const q = qualify(readings, controls, cands);
      if (q.verdict === 'UNREADABLE') {
        refuse('G, the vault\x27s own tree',
          'nothing here may be read. Either a control index came back as something other than '
          + 'PAIR COLLAPSED — which would mean this probe answers the same way whatever it is '
          + 'asked, and a probe that cannot say no cannot say yes either — or a candidate '
          + 'refused with a message this instrument does not recognise, or two reads of the same '
          + 'filtered state disagreed about one leaf, or a candidate was never asked about at '
          + 'all. All four are our ignorance and none of them rules on C244.');
      } else if (q.verdict === 'EXCLUDED') {
        /*
         * **ANSWERED, AND IT COUNTS TOWARDS NOTHING UNTIL TWO DOORS ARE SHUT.**
         * Both found by this round's `money-safety-auditor` against this
         * round's own rework, and either one alone would be enough.
         *
         * **ONE — this is not pinned to the transaction it says it is.**
         * Surface B asks `contractAction(address:)` with no offset, which the
         * indexer resolves to the LATEST action
         * (`indexer-api/src/infra/api/v4/query.rs:245-250`). And `EXCLUDED` is
         * reachable ONLY when the candidate range holds no leaf of this vault:
         * a range that does hold one leaves that leaf's pair uncollapsed, so a
         * candidate survives and the verdict is `NARROWED`. **So the branch
         * that would count is exactly the branch that fires when the leaves
         * asked about were never this vault's** — and this is a STANDING
         * CHECK, so the next call to a funded vault makes that the ordinary
         * case. `C265`'s shape a third time.
         *
         * **TWO — the control is one-sided.** It proves this probe can say no.
         * **Nothing here proves it can say yes.** A tree that retained NOTHING
         * answers `PAIR COLLAPSED` at every index, controls included, and
         * `filter` produces exactly that from a state whose offers were applied
         * under a whitelist this contract is not on
         * (`zswap/src/ledger.rs:118-120`, `:159-161`, `:167-179`). Today the
         * indexer applies with `whitelist: None`
         * (`indexer-common/src/domain/ledger/ledger_state.rs:540`, `:624`) —
         * **a default in somebody else's repository, which nothing here reads
         * or pins.** A positive control would close it, and a positive control
         * is the very thing `C244` is trying to obtain.
         */
        say(`     ${Y}${B}ANSWERED, AND THE ANSWER IS NO — AND IT COUNTS TOWARDS NOTHING.${O}`);
        say(`     ${D}every candidate leaf sits in a pair this vault's own filtered tree${O}`);
        say(`     ${D}collapsed away, so none of them is this vault's: ${q.excluded.join(', ')}.${O}`);
        say(`     ${Y}READ THE NEXT TWO PARAGRAPHS BEFORE TREATING THIS AS EVIDENCE.${O}`);
        say(`     ${D}ONE: surface B asks contractAction(address:) with no offset, and the${O}`);
        say(`     ${D}indexer answers with the LATEST action rather than the depositing one.${O}`);
        say(`     ${D}A range that DOES hold this vault's leaf leaves that leaf's pair${O}`);
        say(`     ${D}uncollapsed, so a candidate survives and this branch cannot fire. So${O}`);
        say(`     ${D}this branch fires exactly when the leaves asked about were never this${O}`);
        say(`     ${D}vault's — which, on a standing check against a vault that has been${O}`);
        say(`     ${D}called since, is the ordinary case and not an anomaly.${O}`);
        say(`     ${D}TWO: the controls prove this probe can say no. NOTHING here proves it${O}`);
        say(`     ${D}can say yes. A tree that retained nothing answers this way at every${O}`);
        say(`     ${D}index, controls included, and filter produces exactly that from a state${O}`);
        say(`     ${D}applied under a whitelist this contract is not on. The indexer applies${O}`);
        say(`     ${D}with no whitelist today — a default in another repository that nothing${O}`);
        say(`     ${D}here pins.${O}`);
        say(`     ${B}WHAT WOULD LET THIS COUNT:${O} ${D}pin surface B to the action by transaction${O}`);
        say(`     ${D}hash, which the schema already offers, AND one positive control — an${O}`);
        say(`     ${D}index this vault is known to hold. NOTHING RECORDED.${O}`);
      } else {
        /*
         * **ANSWERED AND COUNTS TOWARDS NOTHING, WHICH IS THE HONEST SHAPE.**
         * A narrowing is not a reading and it is not a negative either: the
         * leaf is one of two and the binding offers nothing that says which. It
         * must not be added to the tally the LOSS verdict is read off, because
         * that sentence would then count a surface that found the note's pair
         * as evidence that the note cannot be found. `C263`, `C110`.
         */
        say(`     ${Y}ANSWERED, AND IT NARROWS TO A PAIR AND STOPS.${O}`);
        if (q.excluded.length > 0) {
          say(`     ${G}EXCLUDED, and this part is exact: ${q.excluded.join(', ')} — this vault's${O}`);
          say(`     ${G}tree collapsed the pairs those sit in, so they are not its leaves.${O}`);
        }
        say(`     ${Y}STILL IN PLAY: ${q.surviving.map((i) => `${i} (with ${siblingOf(i)})`).join(', ')}.${O}`);
        say(`     ${D}Each survivor shares a height-1 node with its sibling, and the ask${O}`);
        say(`     ${D}cannot see inside that node — see this surface's header. NOTHING${O}`);
        say(`     ${D}RECORDED, AND THIS COUNTS TOWARDS NO VERDICT: a surface that found the${O}`);
        say(`     ${D}note's PAIR must not be counted as evidence that the note cannot be${O}`);
        say(`     ${D}found. C263, C110.${O}`);
        say(`     ${B}WHAT WOULD CLOSE IT, AND IT IS ONE ACCESSOR:${O} ${D}the Rust has${O}`);
        say(`     ${D}MerkleTree::iter_aux(), which yields (index, (hash, contract address)),${O}`);
        say(`     ${D}and MerkleTree::index(i), which returns None for a collapsed or stubbed${O}`);
        say(`     ${D}leaf and Some for a retained one (merkle_tree.rs:1154-1183, :770-786).${O}`);
        say(`     ${D}NEITHER IS EXPOSED TO JS. docs/foundation-divergences.md entry 11 is${O}`);
        say(`     ${D}the row, and this is the second run to arrive at the same door.${O}`);
      }
    }
  }

  return { located, answered };
}

/* ------------------------------------------------------------------ *
 * stage 4 — the verdict
 * ------------------------------------------------------------------ */

/**
 * **THREE VERDICTS, AND THE THIRD IS THE ONE THAT MUST NOT COLLAPSE INTO THE
 * SECOND.** `C110` with a launch gate behind it.
 *
 * *We could not check* and *there is none* are opposite claims, and `C244` is
 * item 4 of `C257`'s gate: a LOSS reading does not merely block, it instructs —
 * the private design changes on it. **So a run that read nothing returns
 * UNMEASURED, never LOSS**, however many surfaces refused.
 */
export function stageFour(a: Attempt, reachedStageThree: boolean): number {
  say(`\n${B}4 of 4  What this means for C244${O}`);

  if (a.located.length > 0) {
    say(`  ${G}${B}THE INDEX IS OBTAINABLE.${O}`);
    for (const l of a.located) {
      say(`    ${G}commitment ${short(l.commitment)} is at index ${l.index}${O}`);
      say(`      ${D}read off ${l.from}${O}`);
      say(`      ${D}${l.derivation}${O}`);
    }
    say(`  ${D}So C244 is DOWNTIME rather than loss, on the strength of this reading${O}`);
    say(`  ${D}and no further. One surface answering is not the same as a resolver${O}`);
    say(`  ${D}that answers for every note a vault will ever hold.${O}`);
    return 0;
  }

  if (!reachedStageThree || a.answered === 0) {
    say(`  ${Y}${B}UNMEASURED. THE GATE IS NOT RULED EITHER WAY.${O}`);
    say(`  ${D}${a.answered} surface(s) answered and ${refusals.length} refused, so this run took no${O}`);
    say(`  ${D}measurement and reports no verdict. C244 stays UNKNOWN, exactly as SC1c${O}`);
    say(`  ${D}left it: neither downtime nor loss. Nothing may be designed on this row${O}`);
    say(`  ${D}until a run gets past the refusals below.${O}\n`);
    for (const r of refusals) say(`    ${Y}·${O} ${r}`);
    say(`\n  ${B}A measurement this instrument could not take is a refusal, never a`);
    say(`  plausible figure. C238.${O}`);
    return 3;
  }

  say(`  ${R}${B}NO SURFACE THAT ANSWERED LOCATED A COMMITMENT BY INDEX.${O}`);
  say(`  ${D}${a.answered} surface(s) answered; ${refusals.length} refused and count towards nothing.${O}`);
  say(`  ${D}On this evidence C244 is LOSS rather than downtime, and the private${O}`);
  say(`  ${D}design has to change: a note this client creates and cannot qualify${O}`);
  say(`  ${D}cannot be spent, ever, and payroll is pinned to the private path by${O}`);
  say(`  ${D}product rule.${O}`);
  if (refusals.length > 0) {
    say(`  ${Y}READ THE REFUSALS BEFORE ACTING ON THIS. A surface that could not be${O}`);
    say(`  ${Y}read is not a surface that has no answer.${O}\n`);
    for (const r of refusals) say(`    ${Y}·${O} ${r}`);
  }
  return 1;
}

async function main() {
  say('────────────────────────────────────────────────────────────');
  say(`  ${B}Can a note's place in the commitment tree be obtained?${O}  —  C244`);
  say('────────────────────────────────────────────────────────────');
  say('');
  say('  Read-only. Nothing is built, proved, submitted, deployed or spent.');
  say(`  network ${NETWORK}, vault "${VAULT_NAME}"`);

  const one = await stageOne();
  const v = one ? await stageTwo() : undefined;
  const attempt = v ? await stageThree(v) : { located: [], answered: 0 };
  const code = stageFour(attempt, Boolean(v));

  say(`\n${D}  Nothing was built, proved, submitted, deployed or spent.${O}`);
  process.exit(code);
}

/**
 * **ONLY WHEN THIS FILE IS THE THING BEING RUN.** `scripts/measure-note-index.test.ts`
 * imports `stageFour` to prove both of its verdicts are reachable, and an
 * unguarded `main()` would make that import go to the network and call
 * `process.exit` out from under the suite.
 */
const RUN_DIRECTLY = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (RUN_DIRECTLY) main().catch((e: any) => {
  /*
   * `WouldHaveShownASecret` reaches here rather than being caught locally,
   * deliberately: a line carrying the vault's address is a defect in this file
   * and not a condition to carry on past. C236.
   *
   * **AND ITS MESSAGE IS NOT PRINTED, WHICH IS THE WHOLE POINT OF IT.** `V-97`,
   * found in this file by this round's `money-safety-auditor`. That error's own
   * text ends `the line was: ${line.slice(0, 120)}` (`scripts/deploy-report.ts`)
   * — **the first 120 characters of the line that carried the address** — and
   * this catch is outside the screen and writes straight into
   * `REPORT-NOTE-INDEX.txt` through the door's `tee`. So the one path that
   * exists to stop an address reaching a report was the path that wrote it
   * there. **What is printed is WHICH secret was nearly shown and nothing
   * else.** The guard's own message is a defect one layer up and is described
   * rather than fixed here: it is in a file this round does not touch.
   */
  const nearlyShown = e?.name === 'WouldHaveShownASecret';
  console.error(`\n${R}stopped:${O} ${nearlyShown
    ? `a line carrying ${String(e?.what ?? 'a secret')} was about to be printed and was refused. `
      + 'C236. The line itself is NOT reproduced here, because reproducing it is how it would '
      + 'reach REPORT-NOTE-INDEX.txt. Find it by the surface that was running when this stopped.'
    : String(e?.message ?? e)}`);
  console.error(`${D}  This is a refusal and not a measurement. C244 stays unmeasured.${O}`);
  process.exit(2);
});
