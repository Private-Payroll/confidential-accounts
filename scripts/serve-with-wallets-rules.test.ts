/**
 * **WHAT THE STAGENET LAUNCHER REFUSES BEFORE IT BRINGS ANY WALLET UP, AND
 * THE ORDER IT DOES THINGS IN.**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { postureFrom, refuseToServe, POSTURE_REQUIRED } from './serve-with-wallets-rules.js';

const ROOT = join(import.meta.dirname, '..');
const ALL_PRESENT = {
  fundedSeed: true, companySeed: true, maintenanceAuthority: true,
  compiledContract: true, proofServer: true,
};
const DEV = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.dev);

describe('the posture is read off the development script', () => {
  /*
   * RED WHEN: `ALLOW_SIMULATED_COMPANY_ADDRESS` is carried - a server that can
   * spend would accept a company whose address this machine invented.
   */
  it('carries the origins and leaves the simulated-address allowance behind', () => {
    const p = postureFrom(DEV);
    for (const name of POSTURE_REQUIRED) expect(p[name], `${name} not read`).toBeTruthy();
    expect(p).not.toHaveProperty('ALLOW_SIMULATED_COMPANY_ADDRESS');
    expect(postureFrom('ALLOW_SIMULATED_COMPANY_ADDRESS=1 A=b sh -c x'))
      .toEqual({ A: 'b' });
  });

  /* RED WHEN: an empty assignment is carried as a value, or the command is read as posture. */
  it('reads only leading assignments with a value', () => {
    expect(postureFrom('A= B=2 tsx x.ts C=3')).toEqual({ B: '2' });
  });
});

describe('refusals before anything is brought up', () => {
  /* RED WHEN: the network check is removed. */
  it('refuses any network but stagenet', () => {
    const r = refuseToServe({ network: 'preview', present: ALL_PRESENT, posture: postureFrom(DEV) });
    expect(r).toMatch(/serves stagenet and nothing else/);
    expect(r).toMatch(/nothing has been spent/i);
  });

  /* RED WHEN: the posture check is removed. */
  it('refuses a development script that no longer declares the origins', () => {
    const r = refuseToServe({ network: 'stagenet', present: ALL_PRESENT, posture: { APP_ORIGIN: 'x' } });
    expect(r).toMatch(/WALLET_ORIGIN, VITE_WALLET_ORIGIN/);
  });

  /* RED WHEN: machine preconditions stop being asked, or only the first refusal is named. */
  it('names every missing piece at once, its own and the machine\'s', () => {
    const r = refuseToServe({
      network: 'preview', posture: {},
      present: { ...ALL_PRESENT, proofServer: false, fundedSeed: false },
    })!;
    expect(r).toMatch(/serves stagenet/);
    expect(r).toMatch(/no longer declares/);
    expect(r).toMatch(/no proof server is reachable/);
    expect(r).toMatch(/no funded wallet/);
  });

  /* RED WHEN: a complete machine is refused. */
  it('answers null when everything is in place', () => {
    expect(refuseToServe({ network: 'stagenet', present: ALL_PRESENT, posture: postureFrom(DEV) }))
      .toBeNull();
  });
});

describe('the launcher hands the pair over before the server exists', () => {
  const launcher = readFileSync(join(ROOT, 'scripts', 'serve-with-wallets.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /*
   * RED WHEN: the server is imported before the hand-in. The server reads the
   * pair once while it is evaluated, so a late hand-in serves read-only and the
   * button fails in front of whoever pressed it.
   */
  it('hands in, then imports the server', () => {
    const handIn = launcher.indexOf('handInFundedParties(');
    const serve = launcher.search(/import\(pathToFileURL\(join\(ROOT, 'src', 'server', 'index\.ts'\)\)/);
    expect(handIn).toBeGreaterThan(-1);
    expect(serve).toBeGreaterThan(-1);
    expect(handIn, 'the server is imported before the pair is handed in').toBeLessThan(serve);
  });

  /*
   * RED WHEN: the launcher builds its fee payer by hand instead of through the
   * one construction that requires a fee record and uses the dust-only payer.
   */
  it('builds the pair through the one construction and nothing else', () => {
    expect(launcher).toMatch(/handInFundedParties\(fundedPartiesOver\(/);
    expect(launcher).not.toMatch(/new WalletFeeSponsor|customerWalletOver|sponsorWalletOver/);
  });

  /*
   * RED WHEN: an allowance the launcher leaves behind is still in the
   * environment when the server is imported - inherited from the shell rather
   * than declared by the script.
   */
  it('removes the settings it does not carry before the server is imported', () => {
    const removed = launcher.indexOf('for (const n of POSTURE_NOT_CARRIED) delete process.env[n];');
    const serve = launcher.search(/import\(pathToFileURL\(join\(ROOT, 'src', 'server', 'index\.ts'\)\)/);
    expect(removed, 'the launcher does not remove them').toBeGreaterThan(-1);
    expect(removed).toBeLessThan(serve);
  });

  /* RED WHEN: the launcher stops checking the server's own account of what it can do. */
  it('refuses to report ready unless the server says it can write', () => {
    expect(launcher).toMatch(/said\.includes\('reading and writing'\)/);
  });
});
