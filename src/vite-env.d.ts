/// <reference types="vite/client" />
declare module '*.css';

/**
 * WHERE THE IDENTITY WALLET IS SERVED FROM. `PI1`.
 *
 * The page opens this origin and refuses to listen to any other, so it is
 * configuration rather than something a link can carry: a URL that could name
 * the wallet is a URL that could name somebody else's wallet.
 */
interface ImportMetaEnv {
  readonly VITE_WALLET_ORIGIN?: string;
  /**
   * WHETHER THE PAGE KEEPS A RECORD OF WHAT IT SAID. `X4`, and it is `C140`'s
   * shape: declared by the `dev` script in `package.json` and by nothing a
   * person types. `src/web/error-sink.ts` also requires `import.meta.env.DEV`,
   * so setting this in a production build ships nothing.
   */
  readonly VITE_DEV_ERROR_SINK?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
