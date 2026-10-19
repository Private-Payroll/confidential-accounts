/**
 * **THE PUBLIC PARAMETERS A DEVICE PROVES WITH, AND HOW THE SERVICE AND A DEVICE
 * EACH KNOW THEY ARE GENUINE.** This file imports nothing, so a device's worker
 * checks what the service hands it against the same list the service checks its
 * own files against, and there is no second copy to drift.
 *
 * Every proof on Midnight is made against one set of public parameters, the
 * output of Midnight's trusted setup, cut into one file per circuit size:
 * `bls_midnight_2p<k>`. They are the same for everybody and secret to nobody.
 * A proof made against any other parameters is not one the chain accepts.
 *
 * **WHAT A FILE IS CHECKED AGAINST IS MIDNIGHT'S OWN LIST, NOT ONE MADE HERE.**
 * Midnight's ledger carries the SHA-256 of every one of these files, k 0 to 25,
 * and refuses a file on disk or a download that does not match, from its own
 * table of the files it expects.
 * The table below is that list, copied digit for digit. The service keeps and
 * hands out a file, and a device proves with one, only when its digest is the
 * one listed for its name.
 *
 * **THE OLDER `bls_filecoin_2p<k>` FILES ARE NOT ON IT.** They are a different
 * setup - their bytes differ from the Midnight file of the same size - and
 * nothing Midnight publishes says what they should be, so the service neither
 * fetches them nor hands them out, and a device never asks for them.
 */
export const MIDNIGHT_PARAMETER_SHA256: Readonly<Record<string, string>> = Object.freeze({
  bls_midnight_2p0: '59b30b3114a34ccbbfb599376e178fb8d9b3366cae2174c2f1da20e75847f823',
  bls_midnight_2p1: 'bbe04fe3c70d0c138447cb086b4baddc30cb8bb2a004114bc02e6f739516280e',
  bls_midnight_2p2: '80e15568fa1a0117db893239be7fa5e34a6bcc3a8c3bfa7709534b9cb88eb6c1',
  bls_midnight_2p3: '4be827a6472193df80d8f08b4b25a85baef436fdd1965d89b6af89f4ec4e99e2',
  bls_midnight_2p4: '232f401fad10c7ddf8828d2aa4c85c6506c5da09795998cecaeb9f75fc8f6ada',
  bls_midnight_2p5: '0a1c9229f315fc1868ff25f668fb83aec4d09f4f23a706b5197c692c619d72c6',
  bls_midnight_2p6: 'cf2ad6be7d0fedf5bec2aaa35f6be4aca33053d74268fdf5aa54fcb2891ea6df',
  bls_midnight_2p7: 'e82ae890c080188355f37feaffe91372584cd810615082d9143d4dec0453fd9d',
  bls_midnight_2p8: '909b707551eaaea79828e883cde6fc46ab15986c3b1d791bed462c9e2805c933',
  bls_midnight_2p9: 'b9009f1098bcefffec3c461ab3a5e3a17f7e5599f0f08c70fcdc55a89227bcbd',
  bls_midnight_2p10: '46b2290933cbed4c378889e4ba971f1a92888331ffb09466acd4ff61a1e2cb42',
  bls_midnight_2p11: '9901589d7956ff58be0d85569b2f455b77b58c3758026ffb5bbe4807000b96d1',
  bls_midnight_2p12: 'ef08eb3fcf62df8f72c515cffa027e681808b530cb016eea104115545ef6d5c8',
  bls_midnight_2p13: 'd3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803',
  bls_midnight_2p14: 'fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244',
  bls_midnight_2p15: '724c7c3d779148bb113c7ee9c034b2f27db16e6bdf315fde90105a9bad00b1de',
  bls_midnight_2p16: '09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6',
  bls_midnight_2p17: '4a9ef6c7c0619aab74eede44b13e753e3ba54508a02dd3b7106a949aabb73b74',
  bls_midnight_2p18: 'e8436dc5d8b598f169c127c745135d889744007e6d384ff126df8d1332522f86',
  bls_midnight_2p19: '8e8dc15c4362f05c912f1e770559a3945db3e58a374def416ed5d3e65ad5b10e',
  bls_midnight_2p20: '1cc62978558fdc1e445cd70cfd9a86ec3c2e2151b6d74811232d37faf9133ff1',
  bls_midnight_2p21: '9cf1644a87f0f027ae5fc6278f91d823a6334ff3e338a29e2f2ef57d071ed64d',
  bls_midnight_2p22: 'e8ad5eed936d657a0fb59d2a55ba19f81a3083bb3554ef88f464f5377e9b2c2f',
  bls_midnight_2p23: '09399d05f9f50875dfdd87dc9903d40c897eaafa9ec8cbb08bace853ecc36c0c',
  bls_midnight_2p24: 'b0e6fa7a4ab4a79a1e6560966f267556409db44bab6d5fab3711ad6c6b623207',
  bls_midnight_2p25: '3289a751c938988cd2f54154d8722d1eda2cd11593064afdde82099b24ff4a58',
});

/** The digest a parameter file must have, or undefined for a name nothing publishes one for. */
export type PublishedDigest = (name: string) => string | undefined;
/** The digest Midnight publishes for a parameter file's name, or undefined for a name it publishes none for. */
export const publishedByMidnight: PublishedDigest = (name) =>
  Object.hasOwn(MIDNIGHT_PARAMETER_SHA256, name) ? MIDNIGHT_PARAMETER_SHA256[name] : undefined;
