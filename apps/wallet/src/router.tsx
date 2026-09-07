import { useEffect, useState } from 'react';
import { parseRoute } from './routes.js';
import type { Route } from './routes.js';

/** The current route, live. `routes.ts` owns what a hash means. */
export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseRoute(hash);
}
