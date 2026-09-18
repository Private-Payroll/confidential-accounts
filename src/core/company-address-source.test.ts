import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from './store.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import { AccountService, openAccount, sealAccount } from './account.js';
import { NoCompanyAddress, companyForSession } from './company-address.js';

/**
 * **THE SYSTEM CAN TELL WHETHER AN ADDRESS CAME FROM A CHAIN.** `docs/NEXT.md`
 * PI2b §1.
 *
 * ── WHAT THIS FILE IS FOR, AND WHY IT IS NOT A FIELD TEST ─────────────────
 *
 * `PI2a` built a refusal that is correct, well argued and names `C136` as its
 * reason: a company with no chain address is told so rather than handed a
 * substitute. **It could never once fire.** `SimulatedLedger` gives every
 * company `toHex(randomBytes(32))` — sixty-four lower-case hex characters,
 * deliberately indistinguishable from what a chain assigns — and the guard
 * checks the shape.
 *
 * So the deliverable of that item is not the field. It is **the mutation that
 * makes a simulated address indistinguishable again, and the assertion that
 * dies when it does.** Two deliberate defects between them are the two
 * ways to put it back; the tests below are what notices.
 *
 * ── AND THE POINT IS THAT IT CAN TELL, NOT THAT IT STOPS ──────────────────
 *
 * A simulation that produced a failing address would switch every flow behind
 * this off until a contract deploys. So development says so deliberately —
 * `ALLOW_SIMULATED_COMPANY_ADDRESS=1`, an environment variable, which is the
 * one kind of setting **a request cannot carry**. `§4` below is the test that
 * it is a deliberate act rather than a default.
 */

const world = () => {
  const store = new MemoryStore();
  const ledger = new SimulatedLedger(SimulatedCommitments);
  return { store, ledger, accounts: new AccountService(store, ledger, SimulatedCommitments) };
};

const ada = [{ name: 'Ada', role: 'admin' as const, userId: 'usr_1' }];

/** A real deployed address, in the spelling the chain's serialisation produces. */
const DEPLOYED = 'a1'.repeat(32);

const refusalOf = (run: () => unknown): NoCompanyAddress => {
  try { run(); } catch (e) {
    expect(e).toBeInstanceOf(NoCompanyAddress);
    return e as NoCompanyAddress;
  }
  throw new Error('should have refused');
};

/* Nothing here is development unless a test says it is. `§4` is the one that
 * says so, and every other block runs in the posture a deployment runs in. */
beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv('ALLOW_SIMULATED_COMPANY_ADDRESS', ''); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('§1 — THE LEDGER SAYS WHERE THE ADDRESS CAME FROM, IN THE SAME VALUE', () => {
  it('A SIMULATED ADDRESS SAYS IT IS SIMULATED, AND LOOKS EXACTLY LIKE A REAL ONE', async () => {
    const { ledger, accounts } = world();
    const made = await accounts.create('Acme', ada, 1);
    const assigned = await ledger.address(made.account.id);

    /*
     * BOTH HALVES ASSERTED TOGETHER, and the first is what makes the second
     * matter. If the shape check could tell these apart, `C140` would not
     * exist and neither would this file.
     */
    expect(assigned?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(assigned?.source).toBe('simulated');
  });

  it('THE SOURCE IS WRITTEN ON THE RECORD IN THE SAME BREATH AS THE ADDRESS', async () => {
    const { store, accounts } = world();
    const made = await accounts.create('Acme', ada, 1);

    expect(made.account.addressSource).toBe('simulated');
    /* On the stored record too, in the clear beside the address. A source that
     * only ever lived on the opened account would need the viewing key to
     * read, and this decision is taken before any key is supplied. */
    expect(store.getAccount(made.account.id)!.addressSource).toBe('simulated');
  });

  it('AND THE SOURCE SURVIVES A RE-SEAL — dropping it is dropping the guard', async () => {
    /*
     * `save()` rebuilds the stored record from an opened account on every
     * write. `PI2a` learned this the expensive way with `contractAddress`; the
     * source sits beside it and is dropped by the same line if that line
     * forgets it.
     *
     * **PUT THERE INDEPENDENTLY OF THE WRITE PATH BEING TESTED**, for the
     * reason `PI2a`'s first version of this test was wrong: comparing the
     * re-sealed record against the stored one compares two values the mutated
     * line produced, and agrees just as happily when it writes nothing.
     */
    const { store, accounts } = world();
    const made = await accounts.create('Acme', ada, 1);
    store.putAccount({
      ...store.getAccount(made.account.id)!,
      contractAddress: DEPLOYED, addressSource: 'chain',
    });
    const rec = store.getAccount(made.account.id)!;

    const round = sealAccount(
      openAccount(rec, made.viewingKey), made.viewingKey, rec.pendingSigners, rec.keyEpoch);
    expect(round.addressSource).toBe('chain');
    expect(round.contractAddress).toBe(DEPLOYED);
  });
});

describe('§2 — A COMPANY WHOSE ADDRESS NO CHAIN ASSIGNED IS REFUSED BY NAME', () => {
  it('A SIMULATED COMPANY IS REFUSED, AND THE REFUSAL SAYS WHICH KIND OF NOTHING IT IS',
    async () => {
      const { store, accounts } = world();
      const made = await accounts.create('Acme', ada, 1);

      const refused = refusalOf(() => companyForSession(store, 'usr_1', made.account.id));
      expect(refused.code).toBe('company-address-not-from-a-chain');
      /*
       * A DIFFERENT CODE FROM `company-not-on-a-chain`, and the difference is
       * the whole item: that one means nothing is there, this one means
       * something is there and this server invented it. Only the second is a
       * thing a developer may deliberately work past.
       */
      expect(refused.code).not.toBe('company-not-on-a-chain');
      /* Told what is wrong, in the same register as the refusal beside it. */
      expect(refused.message).toMatch(/no chain gave it one/);
    });

  it('A COMPANY WHOSE ADDRESS A CHAIN ASSIGNED IS SERVED, canonically spelled', async () => {
    const { store, accounts } = world();
    const made = await accounts.create('Acme', ada, 1);
    /* What a deployment writes: the address the chain gave, marked as the
     * chain's. Upper-cased here because `C137` folds and two spellings of one
     * company must never become two keys. */
    store.putAccount({
      ...store.getAccount(made.account.id)!,
      contractAddress: DEPLOYED.toUpperCase(), addressSource: 'chain',
    });

    expect(companyForSession(store, 'usr_1', made.account.id)).toBe(DEPLOYED);
  });

  it('AN ACCOUNT FROM BEFORE THIS ROUND IS REFUSED, BECAUSE NOBODY CAN SAY WHAT IT WAS',
    async () => {
      /*
       * **ABSENT IS NOT `'chain'`.** Every company created before `PI2b` has no
       * source recorded, and there is no way to establish one afterwards.
       * Reading absence as a chain's would wave through exactly the records
       * nothing can vouch for — a guard that disables itself where it cannot
       * see, which is `C16`'s lesson.
       */
      const { store, accounts } = world();
      const made = await accounts.create('Acme', ada, 1);
      const { addressSource: _dropped, ...before } = store.getAccount(made.account.id)!;
      store.putAccount({ ...before, contractAddress: DEPLOYED });

      expect(refusalOf(() => companyForSession(store, 'usr_1', made.account.id)).code)
        .toBe('company-address-not-from-a-chain');
    });

  it('and a company that is not yours is still not found, before any of this is asked',
    async () => {
      /*
       * ORDER MATTERS AND IS ASSERTED. The membership answer must come first,
       * or the new refusal tells a stranger that an account id exists and what
       * kind of address it has — enumeration by reading the difference, which
       * is the thing `PI2a`'s shared 404 was for.
       */
      const { store, accounts } = world();
      const made = await accounts.create('Acme', ada, 1);
      expect(refusalOf(() => companyForSession(store, 'usr_2', made.account.id)).code)
        .toBe('company-not-yours');
    });
});

describe('§3 — DEVELOPMENT KEEPS WORKING, DELIBERATELY AND NOT BY DEFAULT', () => {
  it('WITH THE SETTING ON, A SIMULATED COMPANY IS SERVED', async () => {
    const { store, accounts } = world();
    const made = await accounts.create('Acme', ada, 1);

    vi.stubEnv('ALLOW_SIMULATED_COMPANY_ADDRESS', '1');
    expect(companyForSession(store, 'usr_1', made.account.id))
      .toBe(made.account.contractAddress);
  });

  it('WITH IT OFF THE SAME CALL REFUSES — the setting is the only difference', async () => {
    const { store, accounts } = world();
    const made = await accounts.create('Acme', ada, 1);

    vi.stubEnv('ALLOW_SIMULATED_COMPANY_ADDRESS', '1');
    expect(companyForSession(store, 'usr_1', made.account.id)).toBeTruthy();

    vi.stubEnv('ALLOW_SIMULATED_COMPANY_ADDRESS', '0');
    expect(refusalOf(() => companyForSession(store, 'usr_1', made.account.id)).code)
      .toBe('company-address-not-from-a-chain');
  });

  it('IT IS NOT A PARAMETER, SO NO REQUEST CAN REACH IT', () => {
    /*
     * `PI2a`'s rule expressed where it cannot be forgotten: this function takes
     * a store, a user and an account, and there is no fourth argument. A flag
     * saying *serve me anyway* as an argument would be one refactor from a
     * route forwarding a request field into it.
     */
    expect(companyForSession.length).toBe(3);
  });
});
