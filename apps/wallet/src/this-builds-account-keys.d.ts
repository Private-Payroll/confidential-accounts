/** Served by `apps/wallet/this-builds-account-keys.ts` when the wallet is built and when it is tested. */
declare module 'virtual:this-builds-account-keys' {
  export const first: ReadonlyArray<readonly [string, string]>;
  export const second: ReadonlyArray<readonly [string, string]>;
  export const missing: string | null;
}
