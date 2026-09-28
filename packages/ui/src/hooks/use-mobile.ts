import * as React from "react"

/* Narrower than a tablet held upright, where the left menu opens over the page instead of beside it. */
const NARROW_SCREEN = "(max-width: 767.98px)"

/**
 * Whether the screen is narrow, read from the browser's media query and
 * followed as it changes.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(false)

  React.useEffect(() => {
    /* A page with no media queries (a test's) is taken as wide. */
    if (typeof window.matchMedia !== 'function') return undefined
    const mql = window.matchMedia(NARROW_SCREEN)
    const onChange = () => setIsMobile(mql.matches)
    mql.onchange = onChange
    onChange()
    return () => { mql.onchange = null }
  }, [])

  return isMobile
}
