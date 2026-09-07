/**
 * DOES A CROSS-CONTRACT CALL RUN OFFLINE, AND DOES THE CALLEE'S WRITE STICK?
 *
 * V-32 rests on two claims that were both filed as "needs a chain":
 *
 *   (a) a callee may write its own ledger state during a cross-contract call
 *   (b) a witness inside the callee is refused
 *
 * Reading `@midnight-ntwrk/compact-runtime` shows both are answerable here.
 * `createCircuitContext` takes a `ContractStateProvider`, which is the only
 * thing a cross-contract call needs that a simulator does not already have. So
 * the call can be executed in this process, against real compiled contracts,
 * with no node, no proof server and no Stagenet.
 *
 * This script does exactly that, using the artifacts `PROBE-VAULT-4.command`
 * already produced:
 *
 *   Acct   — contracts/probe-out-vault4/callee-per-circuit, copied to `Acct/`
 *            because the caller's generated module imports `../../Acct/`.
 *            A witness-free `claimApproval(p, v, ph, salt)` that closes the
 *            proposal and records it in `settled`.
 *   Vault  — contracts/probe-out-vault4/vault-pins-account. Holds the account
 *            in ledger state and calls `claimApproval` on it.
 *
 * It is a SPIKE, not a test: it depends on probe output, which is gitignored
 * and rebuilt by the probe commands. The permanent version arrives with the
 * real vault contract. Its job is to answer the two questions today.
 */
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
/*
 * THE COMPILED PROBE CONTRACT IS LOADED AT RUN TIME, NOT AT IMPORT TIME.
 *
 * What it names is compiler output. It is not in this repository and no step
 * here builds it, so a static import makes this file unresolvable in any copy
 * that has not built it by hand: the typecheck fails, and every tool that only
 * had to READ this file fails with it. Loaded at run time, the file is readable
 * and checkable everywhere, and the thing that is missing is reported at the
 * moment it is actually needed, by the one function that needs it.
 *
 * The path is assembled rather than written into the call so that no build step
 * tries to resolve it either.
 */
const PROBE_DIR = ['..', 'contracts', 'probe-out-vault4'].join('/');
const VAULT_CONTRACT = `${PROBE_DIR}/vault-pins-account/contract/index.js`;
const ACCT_CONTRACT = `${PROBE_DIR}/Acct/contract/index.js`;

let Vault: any;
let vaultLedger: (data: unknown) => any;
let Acct: any;
let acctLedger: (data: unknown) => any;

async function loadProbeContracts(): Promise<void> {
  try {
    const vaultMod: any = await import(VAULT_CONTRACT);
    const acctMod: any = await import(ACCT_CONTRACT);
    ({ Contract: Vault, ledger: vaultLedger } = vaultMod);
    ({ Contract: Acct, ledger: acctLedger } = acctMod);
  } catch (e: any) {
    throw new Error(
      `this probe reads two compiled contracts under contracts/probe-out-vault4, and they are not there.\n` +
      `  That directory is compiler output for throwaway contracts; nothing in this repository builds it,\n` +
      `  and it is never committed. Compile them with the pinned compiler first.\n` +
      `  (${e?.message ?? e})`,
    );
  }
}

const BLOCK = '0'.repeat(64);
const bytes = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i + n) & 0xff);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/* `sampleContractAddress()` hands back a hex STRING; a contract reference
 * crossing into Compact is a struct of 32 raw bytes. */
const asRef = (addr: unknown) => ({ bytes: Uint8Array.from(Buffer.from(String(addr), 'hex')) });

const ok = (s: string) => console.log(`  \x1b[32mYES\x1b[0m  ${s}`);
const no = (s: string) => console.log(`  \x1b[31mNO \x1b[0m  ${s}`);

const main = async () => {
  await loadProbeContracts();
  console.log('\nCan a cross-contract call be executed offline?\n');

  /* ---------------------------------------------------------------- the account */
  const witnesses = { proposalSalt: () => [{}, bytes(7)] } as never;
  // No type argument: the generated module is loaded at run time and carries no
  // types here, and a type argument on an untyped constructor is a compile error
  // rather than a claim about anything.
  const acct = new Acct(witnesses);
  const acctAddr = sampleContractAddress();
  const acctInit = await acct.initialState(createConstructorContext({}, BLOCK));
  /* Kept as a ContractState rather than a bare state value: the state provider
   * hands this to the runtime, which asks it for `operation(circuitId)` to check
   * the deployed verifier key. Only a ContractState answers that. */
  const acctCS: any = acctInit.currentContractState;

  /* Raise a proposal on the account directly, so there is something to claim.
   * `propose` reads the `proposalSalt` witness — legal, because the account is
   * the ROOT contract here rather than a callee. */
  const SALT = bytes(7);
  const PAYLOAD = bytes(8);
  const rootAcct = acct;
  {
    const ctx = createCircuitContext<{}>(
      'propose', acctAddr as never, BLOCK, acctCS, {} as never);
    const r = await rootAcct.impureCircuits.propose(ctx, PAYLOAD);
    acctCS.data = r.context.callContext.currentQueryContext.state;
  }
  const open = acctLedger(acctCS.data).openProposals;
  const ids = [...open];
  console.log(`  account has ${ids.length} open proposal(s)\n`);
  const proposalId: Uint8Array = ids[0][0];

  /* ---------------------------------------------------------------- the vault */
  const vault = new Vault({} as never);
  const vaultAddr = sampleContractAddress();
  const vaultInit = await vault.initialState(
    createConstructorContext({}, BLOCK), asRef(acctAddr) as never);
  const vaultCS: any = vaultInit.currentContractState;

  console.log(`  vault's pinned account: ${hex(vaultLedger(vaultCS.data).account.bytes).slice(0, 16)}…`);
  console.log(`  the real account:       ${String(acctAddr).slice(0, 16)}…\n`);

  /* The only thing a cross-contract call needs that a simulator has not got. */
  const stateProvider = {
    getContractState: async (_block: string, address: any) =>
      String(address) === String(acctAddr) ? acctCS : undefined,
  };

  /* ---------------------------------------------------------------- the call */
  try {
    const ctx = createCircuitContext<{}>(
      'payout', vaultAddr as never, BLOCK, vaultCS, {} as never,
      stateProvider as never, undefined, undefined, undefined, BLOCK);
    const r = await vault.impureCircuits.payout(ctx, proposalId, PAYLOAD, SALT);
    ok('the call executed, offline, with no node and no proof server');

    /* (a) did the CALLEE's own write stick? */
    const after = r.context.queryContexts[acctAddr as never];
    const settled = [...acctLedger(after.state).settled];
    const stillOpen = [...acctLedger(after.state).openProposals].length;
    if (settled.length === 1 && hex(settled[0]) === hex(proposalId) && stillOpen === 0) {
      ok('V-32(a): the callee WROTE ITS OWN STATE — the proposal is settled and no longer open');
    } else {
      no(`V-32(a): settled=${settled.length} stillOpen=${stillOpen}`);
    }

    const paid = vaultLedger(r.context.callContext.currentQueryContext.state).paid;
    if (paid === 1n) ok('and the caller\'s own write is there too (paid = 1)');
    else no(`the caller's write is wrong: paid = ${paid}`);
  } catch (e) {
    no(`the call failed: ${(e as Error).message}`);
  }

  /* ---------------------------------------------------------------- (b) witnesses */
  console.log('');

  /*
   * THE VAULT MODULE CANNOT BE USED FOR THIS, and the first attempt at it was
   * wrong in a way worth recording. A generated caller imports its callee by
   * PATH — `../../Acct/contract/index.js` — so pointing the state provider at a
   * different contract's state does not change whose CODE runs. The first
   * version of this probe thought it was calling a witness-reading contract and
   * was in fact running the same `Acct` module against someone else's state; it
   * failed with "no open proposal with that id", which is not an answer.
   *
   * So the call is made through the runtime's own `crossContractCall`, naming
   * the circuit directly. `propose` is on the same Acct module and DOES read
   * `proposalSalt()`, which is exactly the shape `claimApproval` used to have.
   */
  const { crossContractCall } = await import('@midnight-ntwrk/compact-runtime');
  const acctModule: any = await import(ACCT_CONTRACT);
  try {
    const ctx = createCircuitContext<{}>(
      'payout', sampleContractAddress() as never, BLOCK, vaultCS, {} as never,
      stateProvider as never, undefined, undefined, undefined, BLOCK);
    await (crossContractCall as any)(
      ctx, acctModule, 'propose', acctAddr, false,
      { input: [], output: [], publicTranscript: [], privateTranscriptOutputs: [] },
      bytes(9));
    no('a callee that reads a WITNESS was allowed to run — the restriction is not enforced');
  } catch (e) {
    const m = (e as Error).message;
    if (/witness/i.test(m)) ok(`V-38 was necessary — the RUNTIME refuses it: ${m.split(';')[0]}`);
    else console.log(`  \x1b[33m?\x1b[0m    refused for another reason: ${m}`);
  }

  console.log('');
};

main().catch((e) => { console.error(e); process.exit(1); });
export {};
