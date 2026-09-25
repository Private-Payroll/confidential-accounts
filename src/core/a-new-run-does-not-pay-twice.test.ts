/**
 * **A NEW RUN DOES NOT PAY SOMEBODY AGAIN FOR A MONTH THEY ARE ALREADY PAID, OR
 * MAY STILL BE PAID, FOR - UNLESS SOMEBODY CONFIRMS IT BY NAMING WHAT IT REPEATS.**
 *
 * Every run derives its people's payment secrets from its own id, so a second run
 * for the same person and month is, to the account, a different payment: the
 * account's once-ever record is keyed on the payment itself and cannot connect the
 * two. What stops the second one is asked here, before a run is raised.
 *
 * **AND IT IS ASKED OF THE CHAIN AS WELL AS OF THIS SERVICE'S RECORDS.** A service
 * restored from an older copy of its records has no trace of a run raised after
 * that copy was taken. The chain still holds the round while it is open, and holds
 * every payment it made for ever, so a raise is refused while the chain holds a
 * round or a payment the service cannot account for.
 *
 * **WHAT IS NOT REFUSED IS PINNED TOO**: next month's payroll for the same people,
 * and a leg raised again as itself.
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService, approvalMessage } from './account.js';
import { PayrollService } from './payroll.js';
import { SimulatedLedger, SimulatedProofSystem, type Ledger } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { runMaterialFor } from '../midnight/run-material.js';
import { vaultDetails } from '../testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { FileStore } from './store-file.js';
import { sign, toHex, type Hex } from './crypto.js';
import type { RosterEmployee } from './types.js';

const PAYROLL_VAULT = toHex(new Uint8Array(32).fill(0xa1));
const NOW = Math.floor(Date.now() / 1000);
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const SEPTEMBER = '2026-09';
const OCTOBER = '2026-10';

/**
 * A chain shared by every service built over it, whose payment record can be
 * set by the test. The simulated ledger records no payments, so what the chain
 * says it has paid is this file's to say.
 */
const aChain = () => {
  const inner = new SimulatedLedger(MidnightCommitments);
  const control: {
    paid: Set<string> | null; cannotSay: boolean; raises: number; landThenThrow: boolean;
    status: 'answers' | 'throws' | 'null';
  } = { paid: null, cannotSay: false, raises: 0, landThenThrow: false, status: 'answers' };
  const ledger = new Proxy(inner, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop === 'status') {
        return async (id: string) => {
          if (control.status === 'throws') throw new Error('the indexer did not answer');
          if (control.status === 'null') return null;
          const s = await inner.status(id);
          return s && control.paid ? { ...s, movementCount: control.paid.size } : s;
        };
      }
      if (prop === 'paidAmong') {
        return async (id: string, leaves: Hex[]) => control.cannotSay
          ? { known: false, paid: [] }
          : control.paid
            ? { known: true, paid: leaves.filter(l => control.paid!.has(l.toLowerCase())) }
            : inner.paidAmong(id, leaves);
      }
      if (prop === 'proposeRun') {
        return async (...args: unknown[]) => {
          const throwing = control.landThenThrow;
          control.landThenThrow = false;
          control.raises++;
          const raised = await value.apply(target, args);
          if (throwing) throw new Error('the socket closed after sending');
          return raised;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Ledger;
  return { inner, ledger, control };
};

/** The services over one records file and one chain. */
const servicesOver = (chain: ReturnType<typeof aChain>, file: string) => {
  const store = new FileStore(file);
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(store, chain.ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  return { store, accounts, payroll };
};

async function aCompany(people = 3) {
  const chain = aChain();
  const dir = mkdtempSync(join(tmpdir(), 'mn-s210-'));
  const file = join(dir, 'db.json');
  const s = servicesOver(chain, file);
  const created = await s.accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;
  const account = created.account.id;
  const hired: RosterEmployee[] = [];
  for (let i = 0; i < people; i++) {
    hired.push(s.payroll.hireDirect(account, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey).employee);
  }
  const by = created.secrets[0]!.signerId;
  const openRounds = async () => (await chain.inner.status(account))!.openProposals.length;

  /** Material the way a product route builds it, for the services it is asked of. */
  const materialFor = async (p: PayrollService, runId: string, opensAt = OPENS, closesAt = CLOSES) => {
    const i = await p.runMaterialInputs(runId, viewingKey);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts,
      opensAt, closesAt, vault: PAYROLL_VAULT, detailsOf: vaultDetails,
      ...(i.epoch !== undefined ? { epoch: i.epoch } : {}),
    });
  };
  const raise = async (p: PayrollService, runId: string) =>
    p.proposeRun(runId, viewingKey, by, await materialFor(p, runId));

  /** A copy of the records as they stand now, to restore later. */
  const snapshot = () => {
    const copy = join(dir, `copy-${Math.random().toString(36).slice(2)}.json`);
    copyFileSync(file, copy);
    return () => {
      const restored = join(dir, `restored-${Math.random().toString(36).slice(2)}.json`);
      copyFileSync(copy, restored);
      return servicesOver(chain, restored);
    };
  };
  return { ...s, chain, created, viewingKey, account, hired, by, openRounds, materialFor, raise, snapshot };
}

/** Moves a roster entry's address, which nothing in the product does in place today. */
const moveAddress = (
  c: Awaited<ReturnType<typeof aCompany>>, who: RosterEmployee, to: RosterEmployee | RosterEmployee['address'],
) => {
  const now = c.payroll.person(who.id, c.viewingKey)!;
  const address = to !== null && typeof to === 'object' && 'id' in to
    ? c.payroll.person(to.id, c.viewingKey)!.address : to;
  (c.payroll as unknown as { putPerson(e: RosterEmployee, vk: Hex): void })
    .putPerson({ ...now, address }, c.viewingKey);
};

/** A run as the records hold it, to show a refusal wrote nothing. */
const recordOf = (store: { getRun(id: string): unknown }, id: string) => JSON.stringify(store.getRun(id));

describe('a service whose records have lost the earlier run', () => {
  it('refuses to raise a second run while the chain holds a round the records cannot account for',
    async () => {
      const c = await aCompany();
      const before = c.snapshot();
      const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
      await c.raise(c.payroll, run.id);
      expect(await c.openRounds()).toBe(1);

      const restored = before();
      const runsBefore = restored.store.listRuns(c.account).length;
      /* RED WHEN the roster door asks only this service's records whether the month is drawn. */
      await expect(restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey))
        .rejects.toThrow(new RegExp(`the chain holds 1 open round \\(${
          (await c.chain.inner.status(c.account))!.openProposals[0]!.id.toLowerCase()}\\)`));
      /* RED WHEN the refusal comes after a run has been written down. */
      expect(restored.store.listRuns(c.account)).toHaveLength(runsBefore);
      expect(await c.openRounds()).toBe(1);
    });

  it('and refuses AT THE RAISE a run drawn before the round it cannot see reached the chain', async () => {
    const c = await aCompany();
    const restored = c.snapshot()();
    /* Two copies of the records, each drawing September while the chain holds nothing. */
    const theirs = await restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(c.payroll, run.id);
    const material = await c.materialFor(restored.payroll, theirs.run.id);
    const before = recordOf(restored.store, theirs.run.id);
    /* RED WHEN a raise asks only this service's records whether these people are paid. */
    await expect(restored.payroll.proposeRun(theirs.run.id, c.viewingKey, c.by, material))
      .rejects.toThrow(/the chain holds 1 open round/);
    /* RED WHEN the refusal comes after the run's payments or payslips are written down. */
    expect(recordOf(restored.store, theirs.run.id)).toBe(before);
    /* RED WHEN the refusal lets a second round reach the chain anyway. */
    expect(await c.openRounds()).toBe(1);
    expect(c.chain.control.raises).toBe(1);
  });

  it('refuses while the chain holds a payment the records cannot account for, after the round closed',
    async () => {
      const c = await aCompany();
      const before = c.snapshot();
      const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
      const first = await c.materialFor(c.payroll, run.id);
      await c.payroll.proposeRun(run.id, c.viewingKey, c.by, first);
      /* The round paid everybody and was closed: nothing is open on chain any more. */
      c.chain.control.paid = new Set(first.leaves.map(l => l.toLowerCase()));
      const round = (await c.chain.inner.status(c.account))!.openProposals[0]!.id;
      (c.chain.inner as unknown as { accounts: Map<string, { openProposals: Map<Hex, unknown> }> })
        .accounts.get(c.account)!.openProposals.delete(round);
      expect(await c.openRounds()).toBe(0);

      const restored = before();
      /* RED WHEN nothing compares the chain's payments with the leaves the records know. */
      await expect(restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey))
        .rejects.toThrow(/the chain holds 3 payments/);
      expect(await c.openRounds()).toBe(0);

      /* The control: the records that DO hold the run account for all three. */
      const oct = await c.payroll.createRunFromRoster(c.account, OCTOBER, c.viewingKey);
      await c.raise(c.payroll, oct.run.id);
      expect(await c.openRounds()).toBe(1);
    });

  it('counts every payment as unaccounted when the chain cannot say which leaves it paid', async () => {
    const c = await aCompany();
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const first = await c.materialFor(c.payroll, run.id);
    await c.payroll.proposeRun(run.id, c.viewingKey, c.by, first);
    c.chain.control.paid = new Set(first.leaves.map(l => l.toLowerCase()));
    c.chain.control.cannotSay = true;
    /* RED WHEN a chain that cannot say is read as having paid only known people. */
    await expect(c.payroll.createRunFromRoster(c.account, OCTOBER, c.viewingKey))
      .rejects.toThrow(/could not say/);
    /* The control: the same chain, able to say, lets next month through. */
    c.chain.control.cannotSay = false;
    await c.payroll.createRunFromRoster(c.account, OCTOBER, c.viewingKey);
  });

  it('lets it through when somebody confirms it by naming what the chain holds', async () => {
    const c = await aCompany();
    const before = c.snapshot();
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(c.payroll, run.id);
    const round = (await c.chain.inner.status(c.account))!.openProposals[0]!.id;

    const restored = before();
    const again = await restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined,
      undefined, { runIds: [round], reason: 'the September run was lost with the old records', by: 'Ada' });
    /* RED WHEN a confirmation naming the round the chain holds does not let the raise through. */
    await c.raise(restored.payroll, again.run.id);
    expect(await c.openRounds()).toBe(2);
  });
});

describe('a leg raised again as a NEW round', () => {
  it('is asked what the chain holds, because another run may have been raised over its people meanwhile',
    async () => {
      const c = await aCompany();
      const before = c.snapshot();
      const later = [OPENS + 7_200n, CLOSES + 7_200n] as const;
      const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
      const raised = await c.payroll.proposeRun(run.id, c.viewingKey, c.by, await c.materialFor(c.payroll, run.id, ...later));
      await c.accounts.cancel(raised.id, c.viewingKey);
      expect(await c.openRounds()).toBe(0);

      /* Records restored from before any of it raise their own September run. */
      const restored = before();
      const theirs = await restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
      await c.raise(restored.payroll, theirs.run.id);
      expect(await c.openRounds()).toBe(1);

      /* RED WHEN a leg whose payments were recorded once is raised as a new round unasked. */
      await expect(c.payroll.proposeRun(run.id, c.viewingKey, c.by, await c.materialFor(c.payroll, run.id)))
        .rejects.toThrow(/the chain holds 1 open round/);
      expect(await c.openRounds()).toBe(1);
    });
});

describe('a confirmation is checked against what it confirms', () => {
  const aRestoredCompanyWithARoundItCannotSee = async () => {
    const c = await aCompany();
    const before = c.snapshot();
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(c.payroll, run.id);
    const round = (await c.chain.inner.status(c.account))!.openProposals[0]!.id;
    return { c, restored: before(), round };
  };
  const confirm = (runIds: string[], chainPayments?: number) => ({
    runIds, reason: 'the September run was lost with the old records', by: 'Ada',
    ...(chainPayments === undefined ? {} : { chainPayments }),
  });

  it('refuses one that leaves out a round the chain holds', async () => {
    const { c, restored } = await aRestoredCompanyWithARoundItCannotSee();
    /* RED WHEN a confirmation is taken without naming everything it lets through. */
    await expect(restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined,
      confirm([]))).rejects.toThrow(/this confirmation leaves out [0-9a-f]{64}\. A repeat is confirmed by naming every run/);
    expect(restored.store.listRuns(c.account)).toHaveLength(0);
  });

  it('refuses one that names something this run does not repeat', async () => {
    const { c, restored, round } = await aRestoredCompanyWithARoundItCannotSee();
    /* RED WHEN a confirmation naming more than there is, is taken as naming what there is. */
    await expect(restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined,
      confirm([round, 'run_neverdrawn']))).rejects.toThrow(/run_neverdrawn was confirmed as repeated/);
    expect(restored.store.listRuns(c.account)).toHaveLength(0);
  });

  it('refuses one that counts the chain\'s unaccounted payments wrongly', async () => {
    const { c, restored, round } = await aRestoredCompanyWithARoundItCannotSee();
    c.chain.control.paid = new Set(['0x' + 'ab'.repeat(32)]);
    /* RED WHEN a payment nobody counted is let through at the draw. */
    await expect(restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined,
      confirm([round]))).rejects.toThrow(/the confirmation counted 0\. Count them again and confirm with 1/);
    expect(restored.store.listRuns(c.account)).toHaveLength(0);
    /* The control: the same confirmation, counted right, is taken. */
    await restored.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined, undefined,
      confirm([round], 1));
  });
});

describe('a chain that cannot be read', () => {
  it('refuses at the raise, whether it throws or answers nothing, and leaves the draw alone', async () => {
    const c = await aCompany();
    c.chain.control.status = 'throws';
    /* RED WHEN a chain that cannot be read stops a run being drawn, which spends nothing. */
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const material = await c.materialFor(c.payroll, run.id);
    /* RED WHEN a raise goes ahead without an answer from the chain. */
    await expect(c.payroll.proposeRun(run.id, c.viewingKey, c.by, material)).rejects.toThrow(/indexer did not answer/);
    c.chain.control.status = 'null';
    /* RED WHEN a chain that answers nothing is read as holding nothing. */
    await expect(c.payroll.proposeRun(run.id, c.viewingKey, c.by, material)).rejects.toThrow(/the chain did not answer/);
    expect(c.chain.control.raises).toBe(0);
    c.chain.control.status = 'answers';
    await c.payroll.proposeRun(run.id, c.viewingKey, c.by, material);
    expect(c.chain.control.raises).toBe(1);
  });
});

describe('two runs for one month raised at the same moment', () => {
  it('are not both raised', async () => {
    const c = await aCompany();
    const a = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const b = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const [ma, mb] = [await c.materialFor(c.payroll, a.run.id), await c.materialFor(c.payroll, b.run.id)];
    const both = await Promise.allSettled([
      c.payroll.proposeRun(a.run.id, c.viewingKey, c.by, ma),
      c.payroll.proposeRun(b.run.id, c.viewingKey, c.by, mb),
    ]);
    /* RED WHEN each is compared with the other before either has written its round down. */
    expect(both.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await c.openRounds()).toBe(1);
  });
});

describe('the same person under two roster entries', () => {
  it('is not paid twice on one run, by position or by leg', async () => {
    const c = await aCompany(3);
    moveAddress(c, c.hired[2]!, c.hired[0]!);
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    /* RED WHEN two entries paid at one address are raised as two payments on one run. */
    await expect(c.raise(c.payroll, run.id)).rejects.toThrow(/Payee 0.*Payee 2|Payee 2.*Payee 0/);
    expect(await c.openRounds()).toBe(0);
  });

  it('is not paid again by a second run for the month that holds the other entry', async () => {
    const c = await aCompany(3);
    const a = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, [c.hired[0]!.id]);
    /* The second entry is paid where the first is, before its run is drawn, so its payslip agrees. */
    moveAddress(c, c.hired[2]!, c.hired[0]!);
    const b = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, [c.hired[2]!.id]);
    await c.raise(c.payroll, a.run.id);
    /* RED WHEN the raise matches people by their roster entry and not by where they are paid. */
    await expect(c.raise(c.payroll, b.run.id)).rejects.toThrow(
      new RegExp(`run ${a.run.id} has already been raised for ${SEPTEMBER}`));
    expect(await c.openRounds()).toBe(1);
  });
});

describe('the address an earlier run pays', () => {
  it('is the one on its payslips, not the roster\'s as it is now', async () => {
    const c = await aCompany(3);
    const a = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, [c.hired[0]!.id]);
    /* A second entry paid where the first is, drawn onto its own run for the same month. */
    moveAddress(c, c.hired[2]!, c.hired[0]!);
    const b = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, [c.hired[2]!.id]);
    await c.raise(c.payroll, a.run.id);
    /* Then the first entry moves on, after its run paid it at the old address. */
    moveAddress(c, c.hired[0]!, c.hired[1]!);
    /* RED WHEN the earlier run's people are read at the roster's address now. */
    await expect(c.raise(c.payroll, b.run.id)).rejects.toThrow(
      new RegExp(`run ${a.run.id} has already been raised for ${SEPTEMBER}`));
    expect(await c.openRounds()).toBe(1);
  });
});

describe('the roster address and the payslip address', () => {
  it('refuses the raise, by name, when the roster address is not the one on the payslip', async () => {
    const c = await aCompany(3);
    const { run } = await c.payroll.createRunFromRoster(
      c.account, SEPTEMBER, c.viewingKey, [c.hired[0]!.id, c.hired[1]!.id]);
    moveAddress(c, c.hired[1]!, c.hired[2]!);
    /* RED WHEN the raise pays the roster's address without comparing it with the payslip's. */
    await expect(c.raise(c.payroll, run.id)).rejects.toThrow(/Payee 1/);
    expect(await c.openRounds()).toBe(0);
  });
});

describe('what is not refused', () => {
  it('next month for the same people', async () => {
    const c = await aCompany();
    const sep = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(c.payroll, sep.run.id);
    const oct = await c.payroll.createRunFromRoster(c.account, OCTOBER, c.viewingKey);
    /* RED WHEN anything above compares people without the month. */
    await c.raise(c.payroll, oct.run.id);
    expect(await c.openRounds()).toBe(2);
  });

  it('next month, after this month\'s round was approved', async () => {
    const c = await aCompany();
    const sep = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    const round = await c.raise(c.payroll, sep.run.id);
    const s = c.created.secrets[0]!;
    await c.accounts.approve(round.id, s.signerId, sign(approvalMessage(round), s.signingSecret), c.viewingKey);
    expect(c.accounts.listProposals(c.account, c.viewingKey)[0]!.status).toBe('approved');
    const oct = await c.payroll.createRunFromRoster(c.account, OCTOBER, c.viewingKey);
    /* RED WHEN a round this service raised stops counting as known once it is approved. */
    await c.raise(c.payroll, oct.run.id);
    expect(await c.openRounds()).toBe(2);
  });

  it('a leg raised again as itself while the chain holds a payment the records do not', async () => {
    const c = await aCompany();
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    c.chain.control.landThenThrow = true;
    await expect(c.raise(c.payroll, run.id)).rejects.toThrow(/after sending/);
    c.chain.control.paid = new Set(['0x' + 'cd'.repeat(32)]);
    /* The control: a leg raised for the first time is refused over it. */
    const oct = await c.payroll.createRunFromRoster(c.account, OCTOBER, c.viewingKey, undefined, undefined,
      { runIds: [], reason: 'a payment made outside this product', by: 'Ada', chainPayments: 1 });
    c.chain.control.paid = new Set(['0x' + 'cd'.repeat(32), '0x' + 'ef'.repeat(32)]);
    await expect(c.raise(c.payroll, oct.run.id)).rejects.toThrow(/the chain holds 2 payments/);
    /* RED WHEN a leg that pays its own recorded payments again is refused over something it cannot pay twice. */
    await c.raise(c.payroll, run.id);
    expect(await c.openRounds()).toBe(1);
  });

  it('a leg raised again as itself after its raise threw', async () => {
    const c = await aCompany();
    const { run } = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    c.chain.control.landThenThrow = true;
    await expect(c.raise(c.payroll, run.id)).rejects.toThrow(/after sending/);
    /* RED WHEN the round this service wrote down is counted as one it cannot account for. */
    await c.raise(c.payroll, run.id);
    expect(await c.openRounds()).toBe(1);
  });

  it('a second run for the month confirmed by naming the first, through the roster door', async () => {
    const c = await aCompany();
    const sep = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey);
    await c.raise(c.payroll, sep.run.id);
    /* The control: unconfirmed, the roster door refuses it. */
    await expect(c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey))
      .rejects.toThrow(/already exists/);
    const again = await c.payroll.createRunFromRoster(c.account, SEPTEMBER, c.viewingKey, undefined,
      undefined, { runIds: [sep.run.id], reason: 'a correction paid in full on purpose', by: 'Ada' });
    /* RED WHEN a confirmation naming the earlier run is not honoured at the raise. */
    await c.raise(c.payroll, again.run.id);
    expect(await c.openRounds()).toBe(2);
  });
});
