/**
 * WHICH COMPACT COMPILER THIS REPOSITORY IS WRITTEN AGAINST, AND WHERE TO GET
 * IT.
 *
 * Kept apart from the program that fetches it so the choice can be read, and
 * checked, without downloading anything.
 *
 * -- WHY A CLONE NEEDS THIS AT ALL -------------------------------------------
 *
 * The compiled contracts are build output and are not in this repository. The
 * TypeScript imports them by path, so nothing typechecks and no test runs until
 * they exist, and they cannot exist without a compiler. The compiler is not on
 * anybody's PATH by default and is not on npm: it is published as a release
 * asset, one per machine. So the first thing a clone does is get the right one,
 * and "the right one" is a single version written down here.
 *
 * -- WHY THE VERSION IS PINNED RATHER THAN "THE NEWEST" ----------------------
 *
 * A contract built by one compiler expects the runtime that compiler targets.
 * Build with a different one and everything here still passes: the mismatch is
 * reported by the chain, at a deploy, in a message about a version nobody
 * chose. The refusal below is the alternative, and it costs a second.
 */

/** The pinned release. */
export const COMPACTC_VERSION = '0.33.0-rc.2';

/**
 * What the compiler reports when asked. It is not the release name: the
 * candidate suffix is part of how the release is published and not part of what
 * the binary calls itself, so the two are written down separately rather than
 * derived from one another and hoped about.
 */
export const COMPACTC_REPORTS = '0.33.0';

const RELEASE = 'https://github.com/LFDT-Minokawa/compact/releases/download';

/** The machine names the release uses, keyed the way Node names the same thing. */
const TARGETS = {
  'darwin/arm64': 'aarch64-darwin',
  'darwin/x64': 'x86_64-darwin',
  'linux/arm64': 'aarch64-unknown-linux-musl',
  'linux/x64': 'x86_64-unknown-linux-musl',
};

/**
 * The release target for a machine, or a refusal naming what would resolve it.
 *
 * A machine with no published compiler is a real answer rather than an error:
 * there is a way through it, and the refusal says what it is instead of leaving
 * somebody to find out that the environment variable exists.
 */
export function targetFor(platform, arch) {
  const target = TARGETS[`${platform}/${arch}`];
  if (target === undefined) {
    throw new Error(
      `no Compact compiler ${COMPACTC_VERSION} is published for ${platform}/${arch}. ` +
        'Install a compiler of that version by hand and point COMPACT_HOME at the directory holding it; ' +
        'every build step here reads that variable first.',
    );
  }
  return target;
}

/** The asset that target is published as. */
export function releaseAsset(platform, arch) {
  return `compactc_v${COMPACTC_VERSION}_${targetFor(platform, arch)}.zip`;
}

/** Where that asset is published. */
export function releaseUrl(asset) {
  return `${RELEASE}/compactc-v${COMPACTC_VERSION}/${asset}`;
}

/**
 * Where a fetched compiler is unpacked.
 *
 * Under the directory the Compact devtools already use, and laid out the way
 * they lay it out, so a compiler fetched here is found by every build step
 * without anything being told where it went. The version is in the path, so a
 * second version installed later neither overwrites this one nor is mistaken
 * for it.
 */
export function installDir(home, platform, arch) {
  return `${home}/.compact/versions/${COMPACTC_VERSION}/${targetFor(platform, arch)}`;
}

/**
 * What is wrong with the version a compiler reports, or null if nothing is.
 *
 * Matched on what the binary says rather than on the release name, because
 * those differ, and by containment rather than equality, because a build
 * carrying extra words about itself is still that build.
 */
export function versionProblem(reported) {
  if (typeof reported !== 'string' || reported.trim() === '') {
    return 'the compiler did not say which version it is, so it cannot be the pinned one';
  }
  if (!reported.includes(COMPACTC_REPORTS)) {
    return (
      `this repository is written against Compact compiler ${COMPACTC_VERSION} and found "${reported.trim()}". ` +
      'A contract built by another compiler expects another runtime, and nothing says so until it is deployed. ' +
      'Remove the fetched compiler and fetch it again, or point COMPACT_HOME at one of the pinned version.'
    );
  }
  return null;
}
