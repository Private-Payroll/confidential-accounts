/* Types for the viewing-key tripwire's trigger, so the pins that hold it
 * typecheck with the rest of this project rather than under an implicit `any`.
 * The implementation is plain JS because the network probe loads it at runtime
 * from a Node process and Node does not read TypeScript. Same arrangement, and
 * the same reason, as `scripts/probe-verdict.d.mts`. */

/* DELIBERATELY `string` AND NOT A LITERAL TYPE. A literal type would spell the
 * field out a second time, in a second file, which is exactly what the
 * implementation next door exists to prevent — and this file is inside the
 * source scan, so it would turn the scan red as well. The value's spelling is
 * pinned by the test, against the implementation, where there is only one of
 * it. */
export declare const VIEWING_KEY_FIELD: string;

export declare function mentionsViewingKey(text: unknown): boolean;
