import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE SENTENCES IN `SECURITY.md` THAT ARE ABSENCES, MADE INTO A RED SUITE.
 *
 * `SECURITY.md` is addressed to strangers and it is the file a security
 * researcher opens first. Every sentence in it is either pinned by a test that
 * goes red when it stops being true, or it is cut — that is the standard the
 * document was rewritten to, and this file holds the sentences no other test
 * could hold.
 *
 * WHY THEY NEEDED THEIR OWN FILE. The other claims are about what the code
 * DOES, and a test that calls the code pins them. These four are about what
 * the code DOES NOT DO — no extended public key leaves the library, no PRF
 * call anywhere, no attestation asked for, nothing fetched when the page
 * opens. **An absence cannot be pinned by calling anything.** It is pinned by
 * scanning the source, which is the same instrument `app/balance.test.tsx`
 * already points at the indexer's viewing-key field, and the reason that one
 * exists is the reason this one does: the rule was written down and not
 * checked, and a rule that is only written down is rediscovered rather than
 * kept.
 *
 * `SECURITY.md` said of the extended-public-key rule that it is *"written down
 * to be checked rather than rediscovered"*. Until this file it was written
 * down and not checked.
 */

/* Comments out, code left alone — the stripper from `app/balance.test.tsx`,
 * and it is that shape for the reason recorded there: an allowlist of files
 * permitted to carry the string put the one file the offending call would be
 * written in outside the tripwire, because that file's own comment documented
 * the rule. Documentation stays legal everywhere; code does not.
 *
 * Line comments are recognised only when not preceded by ':' or a quote, so a
 * `https://…` inside a string survives. A tripwire needs to catch a string
 * literal, not parse TypeScript. */
const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1');

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
/** `packages/identity/src` -> the repository root. */
const REPO = path.resolve(HERE, '..', '..', '..');
const SELF = 'packages/identity/src/security-claims.test.ts';

/**
 * THE PRODUCT IS TWO FOLDERS AND THIS SWEEP READS BOTH.
 *
 * These claims are about a wallet, and a wallet is the library and the
 * application together: the key derivation lives in one and every screen that
 * shows a key lives in the other. Sweeping one of them would leave the claim
 * `SECURITY.md` makes true of half the product and unchecked of the other
 * half - which is worse than not sweeping at all, because the file would still
 * be green.
 *
 * Paths are reported from the REPOSITORY root so that a name in an expected
 * list below is a path somebody can open.
 */
const ROOTS = [
  path.join(REPO, 'packages', 'identity', 'src'),
  path.join(REPO, 'apps', 'wallet'),
];

/** Every `.ts`/`.tsx` of the product, as [repo-relative path, code without comments]. */
const sources = (): ReadonlyArray<readonly [string, string]> => {
  const found: Array<readonly [string, string]> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      /* Build output and vendored material are not source and are not swept. */
      if (name === 'node_modules' || name === 'dist' || name === 'public') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/u.test(name)) continue;
      found.push([path.relative(REPO, full), stripComments(readFileSync(full, 'utf8'))]);
    }
  };
  for (const root of ROOTS) walk(root);
  return found;
};

const carrying = (needle: RegExp): readonly string[] =>
  sources().filter(([, code]) => needle.test(code)).map(([file]) => file).sort();

describe('no extended public key above the leaf leaves this library', () => {
  /* THE PROPERTY, AND WHY IT IS SHARP RATHER THAN TIDY. Role and index are NOT
   * hardened on the SDK's path. So an extended PUBLIC key at the account or
   * role node, combined with any single child PRIVATE key beneath it, yields
   * the parent private key — and therefore every sibling. One xpub plus one
   * leaked leaf is the whole account.
   *
   * Nothing exports one today. The reason this is a test and not a comment is
   * that the features which would reach for one are ORDINARY: a watch-only
   * balance view, a server-side verifier, an address export. Whoever writes
   * one of those is not doing anything reckless, and nothing would have told
   * them. Now something does. */

  it('no source file derives or names an HD node, except the tests that walk one independently', () => {
    /* The three named files walk `@scure/bip32` DELIBERATELY, as an
     * independent check that our derivation and the SDK's agree — they are
     * the reason the money keys are pinned at all, and they export nothing.
     * Any FOURTH file is the finding.
     *
     * The needle carries no `\b` anchors deliberately: this file has to match
     * its own needle, the same way the neighbouring test does, so that the
     * expected list reads the same in both and nobody has to work out why one
     * of them names itself and the other does not. A tripwire is allowed to be
     * broader than the thing it is watching for. */
    expect(carrying(/HDKey/u)).toEqual([
      'apps/wallet/subwallets.test.ts',
      'packages/identity/src/keys/derivation.portability.test.ts',
      'packages/identity/src/profile/unlock.test.ts',
      SELF,
    ].sort());
  });

  it('the words for an extended key appear in no source file at all', () => {
    expect(carrying(/xpub|xprv|publicExtendedKey|extendedPublicKey|\.neutered\(/u)).toEqual([SELF]);
  });
});

describe('a passkey authenticates and never carries key material', () => {
  /* Deliberate, and the reason is the blast radius: if the passkey carried key
   * material, a remotely compromised platform account would be a total
   * compromise of the person's money rather than a compromise of their
   * sign-in. The mechanism by which a passkey WOULD carry key material is the
   * WebAuthn PRF extension, so the property is exactly "no PRF call". */

  it('there is no PRF call, and no WebAuthn extension is requested or read, anywhere', () => {
    expect(carrying(/(^|[^A-Za-z])prf([^A-Za-z]|$)/iu)).toEqual([SELF]);
    expect(carrying(/getClientExtensionResults|extensions\s*:/u)).toEqual([SELF]);
  });

  it("a registration asks for no attestation, and 'none' is the only value in the code", () => {
    /* Load-bearing for the sentence next to it: BECAUSE there is no signature
     * over the public key at registration, a registration proves nothing about
     * who holds it — which is why a passkey is recorded unproven until it has
     * completed one real sign-in (`passkey/verify.test.ts:85`, `:95`). If this
     * literal ever became 'direct' or 'enterprise', that sentence would be
     * wrong and nothing else would say so. */
    const withAttestation = sources()
      .filter(([file, code]) => file !== SELF && /attestation\s*:/u.test(code));
    expect(withAttestation.map(([file]) => file)).toEqual(['packages/identity/src/browser/passkey.ts']);
    expect(withAttestation[0]?.[1]).toContain("attestation: 'none'");
  });
});

describe('the wallet page asks nobody anything when it opens', () => {
  /* The request itself is the disclosure: a font CDN hit tells that party when
   * a wallet was opened and from where, which is surveillance of the one
   * moment that matters, and it happens before the person has done anything.
   *
   * SCOPE. This pins the page as it OPENS. The wallet does read balances from
   * a named indexer later, when the person presses the button — that is a
   * deliberate, disclosed request (`apps/wallet/config.ts:26-27`) and it is named on
   * screen. The claim is about opening, and so is the test. */

  it('every URL in the page shell is relative or inline — no third-party origin', () => {
    const html = readFileSync(path.join(REPO, 'apps', 'wallet', 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:href|src)\s*=\s*"([^"]*)"/gu)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(2);
    for (const url of urls) {
      /* `data:` is inline — the favicon is an SVG whose `xmlns` is an XML
       * namespace and not an address anything dials. */
      expect(url.startsWith('./') || url.startsWith('/') || url.startsWith('data:')).toBe(true);
    }
  });

  it('the whole application reaches exactly three origins, and they are named here', () => {
    /* THE ENUMERATION IS THE POINT, AND THE FIRST VERSION OF THIS FILE DID NOT
     * HAVE IT. `SECURITY.md` tried to enumerate the wallet's network activity
     * in prose and got it wrong twice in one sentence — it missed the proving
     * artefacts (`apps/wallet/key-material.ts:227`, reached from the send path via
     * `apps/wallet/proving.ts:61`) and missed `apps/wallet/facade.ts` entirely. A list in
     * prose is a list that goes stale; this is the same list, derived.
     *
     * A FOURTH FILE HERE IS A NEW PARTY THIS WALLET TALKS TO, and whoever
     * added it has to come past this test and past `SECURITY.md`. */
    const offenders = sources()
      .filter(([file]) => !/\.test\.tsx?$|\.fixtures\.ts$/u.test(file) && file !== SELF)
      .filter(([, code]) => /["'`](?:https?|wss?):\/\//u.test(code))
      .map(([file]) => file).sort();
    expect(offenders).toEqual([
      /* The indexer balances are read from, asked only when the person
       * presses the button, and named on screen for that reason. */
      'apps/wallet/config.ts',
      /* The stagenet RPC node the SDK facade talks to. */
      'apps/wallet/facade.ts',
      /* `rehearsal.invalid` — deliberately unresolvable, so a rehearsal
       * cannot reach anything. Not a party; the absence of one. */
      'apps/wallet/rehearsal.ts',
    ]);
  });

  it('the stylesheet pulls in no remote font or sheet', () => {
    const css = stripComments(readFileSync(path.join(REPO, 'apps', 'wallet', 'app.css'), 'utf8'));
    expect(css).not.toMatch(/@import\s+(?:url\()?["']?https?:/u);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@font-face/u);
  });
});

describe('the stripper keeps code and drops commentary', () => {
  /* The tripwire is only as good as this. Proved on the shapes that matter
   * rather than assumed, because a stripper that ate a string literal would
   * make every test above pass for the wrong reason. */

  it('drops both comment forms and keeps a URL inside a string', () => {
    expect(stripComments('/* prf */\nconst a = 1;')).not.toMatch(/prf/u);
    expect(stripComments('// prf\nconst a = 1;')).not.toMatch(/prf/u);
    expect(stripComments("const u = 'https://example.test/x';")).toContain('https://example.test/x');
    expect(stripComments("const k = 'prf';")).toContain('prf');
  });
});
