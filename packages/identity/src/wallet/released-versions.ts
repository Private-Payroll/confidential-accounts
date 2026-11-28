/**
 * **EVERY VERSION OF THE CONTRACTS THIS PRODUCT HAS RELEASED, NEWEST FIRST.**
 *
 * Built into the wallet's own release and never fetched, so a contract on chain
 * is judged against what this code itself says was released. Each version holds
 * the digest of every verifier key of the company's account, its vaults and the
 * registry, by circuit and by key slot; the versions a contract may be updated
 * to it from; whether runs still open must finish before that update; and
 * whether the version is withdrawn. A version's number is written here and
 * nowhere else.
 *
 * Each digest is SHA-256 over the key file exactly as the compiler wrote it,
 * header included, which is also exactly what the ledger hands back for the slot
 * holding it. The newest entry is this build, held equal to its compiled keys by
 * `apps/wallet/the-newest-released-version-is-this-build.test.ts`.
 */

/** A verifier-key slot of an operation: `v2` for a key of the older proving system, `v3` for the newer. */
export type KeySlot = 'v2' | 'v3';

/** The contracts a version releases. */
export const RELEASED_CONTRACTS = ['account', 'vault', 'registry'] as const;
export type ReleasedContract = (typeof RELEASED_CONTRACTS)[number];

/** The digest, hex, of the key in each slot a circuit fills; a slot not named must be empty. */
export type SlotDigests = Readonly<Partial<Record<KeySlot, string>>>;

export interface ReleasedVersion {
  readonly version: number;
  /** The versions a contract may be updated to this one from. */
  readonly reachedFrom: readonly number[];
  /** Whether runs still open must finish before a contract is updated to this version. */
  readonly openRunsFinishFirst: boolean;
  readonly withdrawn: boolean;
  readonly keys: Readonly<Record<ReleasedContract, Readonly<Record<string, SlotDigests>>>>;
}

export const RELEASED_VERSIONS: readonly ReleasedVersion[] = [
  {
    version: 1,
    reachedFrom: [],
    openRunsFinishFirst: false,
    withdrawn: false,
    keys: {
      account: {
        adopt: { v3: 'a45b20d8d74a80cec2e409e96f8a81c7f695316b9481ccb5389291de16f09045' },
        anchor: { v3: 'b3e172c04c487b92fa55005edc507837f5abb15b8af50174be3c374c8e3b81bd' },
        approve: { v3: '1c3d454df17d9ff3eca3baca7ad8ea14e9053ae1de3e9f15b6159c1237edb3bc' },
        approveVaultChange: { v3: 'd4d75c740601ee394b60d206cf4eec3a9c4a333b16bb9bcb2295cdb21e390dcf' },
        cancel: { v3: 'c2f049a1362b2d2ae9844e8e2c2fa1f58beac495f1dcc917a8aedce46d30661f' },
        clearRun: { v3: 'fefcc492aec2edf6c043e353c6c1ffe4d7df9df62a7bc271db54fe274dda71d3' },
        closeExpiredRun: { v3: 'f9cf54054f4dc2fcaedb6a86bdedff1f6940fc15032f2d74bcfd9d3801ff8e79' },
        holdRun: { v3: '8ecc3ca9bddf787a3394f96f438c1de02a7803d4f8b290507f52fb0afe7f8fbb' },
        propose: { v3: '1f7987f1bbd8955f2d6ea68dd3842fd56b37f78359c8d8d2b880d46e745717dc' },
        proposeCompanyChange: { v3: 'f074e87faa92197e0401594e473c6ac63b8f93bd62813144a9f7f87b64ea2e93' },
        recordBatchFromVault: { v3: '3a4c01f6fabe3ceb1efbdeabb2317b1f7d16bcae90f0dc0a67c6ad1f9cbfa14e' },
        recordPaymentFromVault: { v3: '4a3cc39b99dbfbdf9c87c03805cf158d789b57c27ce79ca8771c70315d0187d3' },
        recoverAnchor: { v3: 'da6d3434dc4df16a1e5b3f93314f8cf22ab7d89e6a0074addde733ba9a125be9' },
        releaseHold: { v3: 'ecf79a4a3a1e80659b8f9bdb62f88e61960fcfda95d2afd6a6a6412cf58fe43b' },
        removeSignerAndSetThreshold: { v3: 'f108b243c5b07b7a479f473d228bb632338bb9d534bf55e7031d724d3090b0ea' },
        reseatSigner: { v3: 'be00e6c54cb9c901800a81a77266401e4d12b68fd787992d00c50f54bb020fa1' },
        retireVault: { v3: '073211ecc25ddbc6913d78fe23e13c769f9f2443485b020369cbbbcd17fdcefd' },
        sealPayKey: { v3: 'deacf6b6f6c83a51767c7f8dbbd376000340fac45f776fc00a59ee4d1f78e1e5' },
        seatInvited: { v3: '79af6b9f8343c9e8f55bab9ebd09f8e43c2e6145ecd757e07895a2514e1f42e6' },
        setPolicy: { v3: 'ebd41775a67f4440e34e19656558d728d531e35fa9089fb02b8dab20e282fc75' },
        setPolicyBar: { v3: 'bbc873c2b27601c8bf27ede44bc7b8140a5517331ce7433741aaad5a6bf49b68' },
        setThreshold: { v3: 'd7f72c019c7996d6509a942ac1dd746fba1569e2bbf2de5789ded16c30ebddf8' },
        setVaultThreshold: { v3: '6ed1104fe5e007166c7cf1e7d0da39ae659198a40635eb7ea87db222710ff54e' }
      },
      vault: {
        batchPayout: { v3: '4f8fc8450b99eb66615a88fe0a8a6cbb29c0b7483fc8bf42082566ca6116d5df' },
        deposit: { v3: 'a305e9ddedd5b31896585b75823d08d1cbd157dbe1aa715445190265de6a56a8' },
        depositUnshielded: { v3: 'c6e0c00de8be264e091c2bf8ddfdc68661ca14f2d68fb6769f455dfaba5f13bc' },
        forgetUnshielded: { v3: '3939a6d3152125bbc1b9a1538421159a47034cb9663a1d30e09ca771fc7d5495' },
        mergeNotes: { v3: 'a8fc5fb4f70cf0a755632ac221a87bc814f884aa74987ea17e5d6175e60a031f' },
        payout: { v3: '72bdbe90b1c35780fe3e311d05e400a7a50647d8f4e8196648b034e2c5642cd2' },
        payoutUnshielded: { v3: '8963859292daaaa873e7f980c4eebb3ddbacbc3262791bad6ce6f2a9670e9bb8' },
        retire: { v3: 'ea2af724a821a53e55eec4abd5515549fd7735d2b8fc8d56e3d61214e6f83904' },
        setNonceSecret: { v3: '93fa853ae4b424bfb10c8dc367417d33ff62318ac03f1402a82d9258b6d3d263' },
        splitNote: { v3: '74192378e5dc0a70a43d10ee203c34d6ec745f331ba9b688e75499806630522b' },
        writeSecretCopy: { v3: '8a14bdfaccb660d5e15afd47be62031dc501527469eb2ad7a1e8dfb8ce3f1289' }
      },
      registry: {
        put: { v3: 'd6f38bc381e79f5854d9058f01a30cb1e816dbdc1208878843c6df633d7fcd75' }
      }
    }
  }
];

const SLOTS: readonly KeySlot[] = ['v2', 'v3'];
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));

/** One version's keys for one contract, as the key matcher takes them: each circuit's digests, one per filled slot. */
export function expectedKeysOf(
  version: ReleasedVersion,
  contract: ReleasedContract
): ReadonlyMap<string, readonly Uint8Array[]> {
  return new Map(
    Object.entries(version.keys[contract]).map(
      ([circuit, slots]) =>
        [
          circuit,
          SLOTS.flatMap((s) => {
            const d = slots[s];
            return d === undefined ? [] : [fromHex(d)];
          })
        ] as [string, Uint8Array[]]
    )
  );
}

const DIGEST = /^[0-9a-f]{64}$/u;

/**
 * What is wrong with a released list, or nothing: a version number used twice,
 * a list not newest first, a version reached from one that is not older and
 * listed, a contract with no circuits, or a circuit with no slot or a digest
 * that is not one.
 */
export function releasedListRefusals(list: readonly ReleasedVersion[]): string[] {
  const out: string[] = [];
  list.forEach((v, i) => {
    const older = list.slice(i + 1).map((o) => o.version);
    if (list.findIndex((o) => o.version === v.version) !== i) out.push(`version ${v.version} is listed twice`);
    if (i > 0 && v.version >= list[i - 1]!.version)
      out.push(`version ${v.version} is not older than the one before it`);
    for (const from of v.reachedFrom)
      if (!older.includes(from)) out.push(`version ${v.version} is reached from ${from}, which is no older version`);
    for (const contract of RELEASED_CONTRACTS) {
      const circuits = Object.entries(v.keys[contract] ?? {});
      if (circuits.length === 0) out.push(`version ${v.version} holds no keys for the ${contract}`);
      for (const [circuit, slots] of circuits) {
        const filled = SLOTS.flatMap((s) => {
          const d = slots[s];
          return d === undefined ? [] : [[s, d] as const];
        });
        if (filled.length === 0) out.push(`version ${v.version}: ${contract} ${circuit} fills no slot`);
        for (const [s, d] of filled)
          if (!DIGEST.test(d)) out.push(`version ${v.version}: ${contract} ${circuit} ${s} is not a digest`);
      }
    }
  });
  return out;
}
