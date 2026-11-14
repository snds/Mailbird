/**
 * Keeps `<meta name="theme-color">` (the browser's or the phone's own chrome
 * around the page) equal to the ground the page is drawn on.
 *
 * The color is never written in Vale's code: it is read from the core's
 * `--surface-ground` role, which follows the app's theme (`data-theme` on
 * the root element) and the ground (the `dark` class next-themes sets;
 * ADR-0082). So it is right on load, and again whenever either changes: the
 * theme setting, or the device's own light or dark setting under "System".
 */
export function watchThemeColor(doc: Document = document) {
  const root = doc.documentElement
  const apply = () => {
    const ground = getComputedStyle(root).getPropertyValue("--surface-ground").trim()
    if (!ground) return
    let meta = doc.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (!meta) {
      meta = doc.createElement("meta")
      meta.name = "theme-color"
      doc.head.append(meta)
    }
    if (meta.content !== ground) meta.content = ground
  }
  apply()
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] })
}
