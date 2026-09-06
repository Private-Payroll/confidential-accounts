/**
 * THE SCREEN GUARD, AND THE PHASE CLOCK.
 *
 * The guard is the one that matters: `C236` says a vault's raw address must
 * never reach a screen, and the difference between that being a rule and it
 * being a promise is whether something refuses. Watched failing — the tests
 * below drive lines that a careful person would have written and that would
 * have destroyed a vault's money.
 */
import { describe, it, expect } from 'vitest';
import {
  createScreen, WouldHaveShownASecret, phaseClock, withTimeout, describeError, SECRET_WINDOW,
} from './deploy-report.js';

const VAULT = '7c'.repeat(32);

const screenOver = (secrets: Array<{ what: string; value: string }>) => {
  const shown: string[] = [];
  return { shown, say: createScreen(() => secrets, (l) => shown.push(l)) };
};

describe('C236: a report cannot print a vault address, even by accident', () => {
  it('prints ordinary lines', () => {
    const { shown, say } = screenOver([{ what: "the vault's address", value: VAULT }]);
    say('vault  payroll-uk');
    say();
    expect(shown).toEqual(['vault  payroll-uk', '']);
  });

  it('refuses the whole address', () => {
    const { say } = screenOver([{ what: "the vault's address", value: VAULT }]);
    expect(() => say(`contract address  ${VAULT}`)).toThrow(WouldHaveShownASecret);
  });

  it('refuses a TRUNCATED address, which is the line somebody actually writes', () => {
    const { say } = screenOver([{ what: "the vault's address", value: VAULT }]);
    // Every one of these is a line a careful person writes to be helpful.
    expect(() => say(`vault ${VAULT.slice(0, 8)}…`)).toThrow(WouldHaveShownASecret);
    expect(() => say(`vault ${VAULT.slice(0, 16)}…`)).toThrow(WouldHaveShownASecret);
    expect(() => say(`…${VAULT.slice(-12)}`)).toThrow(WouldHaveShownASecret);
    // And from the middle, which is what a "fingerprint" looks like.
    expect(() => say(`ref ${VAULT.slice(20, 30)}`)).toThrow(WouldHaveShownASecret);
  });

  it('says why, so the next person does not widen the rule to get past it', () => {
    const { say } = screenOver([{ what: "the vault's address", value: VAULT }]);
    const failure = (() => { try { say(VAULT); return null; } catch (e) { return e as Error; } })();
    expect(failure!.message).toMatch(/C236/);
    expect(failure!.message).toMatch(/nobody can spend/);
    expect(failure!.message).toMatch(/say the name/);
  });

  it('lets through a window SHORTER than the guard, because a rule with no edge is not a rule', () => {
    const { shown, say } = screenOver([{ what: "the vault's address", value: VAULT }]);
    say(`x${VAULT.slice(0, SECRET_WINDOW - 1)}x`);
    expect(shown).toHaveLength(1);
  });

  it('guards every secret it is given, and only while it has them', () => {
    let address: string | null = null;
    const shown: string[] = [];
    const say = createScreen(
      () => (address ? [{ what: "the vault's address", value: address }] : []),
      (l) => shown.push(l));
    // Before the deploy there is no address, so nothing is forbidden.
    say(`about to deploy ${VAULT}`);
    expect(shown).toHaveLength(1);
    // The address exists from the deploy onward, and every later line is guarded.
    address = VAULT;
    expect(() => say(`deployed ${VAULT}`)).toThrow(WouldHaveShownASecret);
  });

  it('ignores a secret too short to be one, rather than refusing everything', () => {
    const { shown, say } = screenOver([{ what: 'nothing much', value: 'abc' }]);
    say('abc appears here and this is fine');
    expect(shown).toHaveLength(1);
  });
});

describe('the phase clock', () => {
  it('labels the phase that did not finish, and never gives it a completed row', () => {
    const shown: string[] = [];
    const clock = phaseClock((l = '') => shown.push(l));
    clock.begin(1, 2, 'Preparing');
    clock.begin(2, 2, 'Deploying');
    const rows = clock.rows('stopped');
    expect(rows.map((r) => r.name)).toEqual(['startup', 'Preparing', 'Deploying  (did not finish)']);
    expect(clock.rows('finished').map((r) => r.name))
      .toEqual(['startup', 'Preparing', 'Deploying']);
  });

  it('names the current stage, which is what a failure block prints', () => {
    const clock = phaseClock(() => {});
    expect(clock.stage).toBe('startup');
    clock.begin(1, 1, 'Deploying the vault');
    expect(clock.stage).toBe('Deploying the vault');
  });
});

describe('silence is turned into an error', () => {
  it('gives up out loud on a promise that never settles', async () => {
    await expect(withTimeout('the thing', 20, new Promise(() => {})))
      .rejects.toThrow(/the thing did not answer within/);
  });

  it('returns the value when it arrives', async () => {
    expect(await withTimeout('the thing', 1_000, Promise.resolve(7))).toBe(7);
  });
});

describe('an error is walked rather than printed', () => {
  it('reaches a cause two deep and annotates a node code through the table it was given', () => {
    const explain = (t: string) => (/170/.test(t) ? 'InvalidDustSpendProof' : null);
    const inner = new Error('Custom error: 170');
    const outer = new Error('Transaction submission error', { cause: inner });
    const text = describeError(outer, explain);
    expect(text).toContain('Transaction submission error');
    expect(text).toContain('Custom error: 170');
    expect(text).toContain('InvalidDustSpendProof');
  });

  it('says a dropped socket means the chain never saw the transaction', () => {
    expect(describeError(new Error('1000:: Normal Closure'), () => null))
      .toMatch(/never submitted, so this is worth retrying/);
  });
});
