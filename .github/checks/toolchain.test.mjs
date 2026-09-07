/**
 * WHAT HOLDS THE CHOICE IN `toolchain.mjs`.
 *
 * The compiler is fetched over the network by a step nobody can run twice for
 * free, so what is checked here is everything about that step that is decidable
 * without fetching anything: which asset, from where, unpacked to where, and
 * what happens when the compiler that arrives is not the one that was asked
 * for.
 *
 * Every test below names ONE clause. Change that clause and this test, and no
 * other, fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACTC_REPORTS,
  COMPACTC_VERSION,
  installDir,
  releaseAsset,
  releaseUrl,
  targetFor,
  versionProblem,
} from './toolchain.mjs';

test('THE POSITIVE CONTROL: the machine the checks run on has a published compiler', () => {
  // A refusal for every machine would satisfy every other test here.
  assert.equal(releaseAsset('linux', 'x64'), `compactc_v${COMPACTC_VERSION}_x86_64-unknown-linux-musl.zip`);
  assert.equal(releaseAsset('darwin', 'arm64'), `compactc_v${COMPACTC_VERSION}_aarch64-darwin.zip`);
});

test('every machine this is written for names a distinct release target', () => {
  const seen = new Set();
  for (const [platform, arch] of [
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
  ]) {
    const target = targetFor(platform, arch);
    assert.ok(target.length > 0, `${platform}/${arch} named nothing`);
    assert.ok(!seen.has(target), `${platform}/${arch} names the same target as another machine: ${target}`);
    seen.add(target);
  }
  assert.equal(seen.size, 4);
});

test('a machine with no published compiler is refused, and told the way through', () => {
  assert.throws(
    () => releaseAsset('win32', 'x64'),
    (error) => {
      assert.ok(/COMPACT_HOME/.test(error.message), `the refusal did not say what resolves it: ${error.message}`);
      return true;
    },
  );
});

test('the download URL is the pinned release and carries the asset unchanged', () => {
  const asset = releaseAsset('linux', 'x64');
  const url = releaseUrl(asset);
  assert.ok(url.startsWith('https://'), `a compiler is fetched over a protected connection: ${url}`);
  assert.ok(url.endsWith(`/${asset}`), `the URL does not end in the asset it names: ${url}`);
  assert.ok(url.includes(`compactc-v${COMPACTC_VERSION}`), `the URL is not the pinned release: ${url}`);
});

test('the version is in the path a compiler is unpacked to, so two cannot be confused', () => {
  const dir = installDir('/somewhere', 'linux', 'x64');
  assert.ok(dir.startsWith('/somewhere/'), `unpacked outside the directory it was given: ${dir}`);
  assert.ok(dir.includes(COMPACTC_VERSION), `the version is not in the path: ${dir}`);
  assert.notEqual(
    installDir('/somewhere', 'linux', 'x64'),
    installDir('/somewhere', 'darwin', 'arm64'),
    'two machines unpack to the same place',
  );
});

test('the version a compiler reports is what is checked, and a wrong one is refused', () => {
  assert.equal(versionProblem(COMPACTC_REPORTS), null);
  assert.equal(versionProblem(`compactc version ${COMPACTC_REPORTS}\n`), null);
  const problem = versionProblem('0.31.1');
  assert.equal(typeof problem, 'string');
  assert.ok(/0\.31\.1/.test(problem), `the refusal did not say what it found: ${problem}`);
  assert.ok(/COMPACT_HOME/.test(problem), `the refusal did not say what resolves it: ${problem}`);
});

test('a compiler that says nothing at all is refused rather than accepted', () => {
  // A launcher that runs and prints nothing is a real state and it used to look
  // like success.
  for (const silence of ['', '   ', undefined, null]) {
    assert.equal(typeof versionProblem(silence), 'string', `silence of ${JSON.stringify(silence)} was accepted`);
  }
});
