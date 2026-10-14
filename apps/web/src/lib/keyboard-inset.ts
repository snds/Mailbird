/**
 * Keeps `--keyboard-inset` on the root element equal to how much of the
 * screen the on-screen keyboard covers.
 *
 * Android (Chrome and its WebView) resizes the page for the keyboard, because
 * index.html asks for `interactive-widget=resizes-content`, so the inset
 * stays 0 there. iOS overlays the keyboard on the page instead and only
 * shrinks the visual viewport; this measures that, so the composer's
 * formatting bar and the Send button stay above the keyboard.
 */
export function watchKeyboardInset(win: Window = window) {
  const vv = win.visualViewport
  if (!vv) return
  const root = win.document.documentElement
  const update = () => {
    const covered = Math.max(0, win.innerHeight - vv.height - vv.offsetTop)
    // Ignore pinch-zoom (scale) and sub-pixel noise; keyboards are tall.
    root.style.setProperty("--keyboard-inset", `${vv.scale > 1.01 || covered < 80 ? 0 : Math.round(covered)}px`)
  }
  vv.addEventListener("resize", update)
  vv.addEventListener("scroll", update)
  update()
}
