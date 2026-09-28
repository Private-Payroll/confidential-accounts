import { directionOf } from 'vaults-ui/i18n/languages';
import { useLanguage } from 'vaults-ui/i18n/provider';

/**
 * THE SIDE A POPUP OPENS ON, FOR THE WAY THE LANGUAGE SHOWN IS WRITTEN.
 *
 * The kit places by start and end, so a right-to-left language needs nothing
 * redrawn. The popup library places only by left and right, so this is the one
 * place the two meet: the end of a line is the right in English and the left
 * in Arabic.
 */
const POPUP_SIDE = {
  ltr: { start: 'left', end: 'right' },
  rtl: { start: 'right', end: 'left' },
} as const;

/** The popup library's sides for the start and the end of a line, in the language shown. */
export function usePopupSide(): (typeof POPUP_SIDE)[keyof typeof POPUP_SIDE] {
  return POPUP_SIDE[directionOf(useLanguage())];
}
