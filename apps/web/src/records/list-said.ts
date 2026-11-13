import { useLanguage } from 'vaults-ui';

/**
 * Names listed inside a sentence, as the person's language writes a short list: in English, separated by commas. The
 * browser's own list formatter writes it, so no separator is typed here.
 */
export function useListSaid(): (items: readonly string[]) => string {
  const language = useLanguage();
  return (items) => new Intl.ListFormat(language, { type: 'unit', style: 'short' }).format(items);
}
