// Steps every lane's scenes share. A helper that knows one area's screens
// lives in that area's file, so the lane that changes the screen fixes it.

/** Clicks, then waits for what it opened to finish arriving, so the next step acts on a still screen. */
export const press = async (app, locator) => {
  await locator.click()
  await app.settle()
}

export const button = (page, name) => page.getByRole("button", { name, exact: true })

/** The desktop's navigation column: the sidebar, or its rail at medium width. Not there in the phone's shells. */
export const sidebar = (page) => page.getByRole("navigation", { name: "Vale" })
/** The phone's tab bar of sections, in the bottom row (the trailing column on a short screen). Not there on a pushed screen. */
export const tabBar = (page) => page.getByRole("tablist", { name: "Sections" })

/**
 * Opens an area (Mail, Calendar, Contacts, Notes) from the app's navigation: the sidebar or its rail,
 * or the phone's tab bar. A phone's pushed screen (Settings, an open item) has no tab bar, so it goes
 * back to a section's first screen first.
 */
export const area = async (app, name) => {
  const { page } = app
  for (let i = 0; i < 3 && !(await sidebar(page).count()) && !(await tabBar(page).count()); i++) await press(app, button(page, "Back"))
  await press(app, (await sidebar(page).count()) ? sidebar(page).getByRole("button", { name, exact: true }) : tabBar(page).getByRole("tab", { name, exact: true }))
}

/** The page head as the switcher: the way to a section's groups wherever the sidebar does not list them (a phone, medium width, beside the rail). */
export const switcher = (page) => page.locator('[data-slot="page-head-switcher"]:visible')
/** The layer the page head opens: a sheet on a phone, a popover at medium width. */
export const switcherLayer = (page) => page.getByRole("dialog", { name: /^(Folders|Calendars|Groups)$/ })

/**
 * A section's second level (ADR-0084): its nav list. The sidebar where it shows the groups; otherwise
 * the page head is pressed and its sheet or popover is the list. Returns the list to look in.
 */
export const groups = async (app) => {
  const { page } = app
  if (await switcherLayer(page).count()) return switcherLayer(page)
  if (!(await switcher(page).count())) {
    // Nothing to open: the pointer leaves the row it last pressed, so no hover is in the picture by chance.
    await page.mouse.move(0, 0)
    return sidebar(page)
  }
  await press(app, switcher(page).first())
  return switcherLayer(page)
}
/** Closes the page head's layer without picking: Escape, as a sheet and a popover both take it. */
export const leaveLayer = async (app) => {
  await app.page.keyboard.press("Escape")
  await app.settle()
  // Focus returns to the page head, with the ring a key leaves: not part of the picture.
  await app.page.evaluate(() => document.activeElement?.blur())
}
/** Goes to a place of the open section (a mail folder, Tasks, a contact group, a note folder), or presses any other row of its nav list. */
export const pick = async (app, name) => {
  const list = await groups(app)
  await press(app, list.locator(`[aria-label="${name}"], [aria-label^="${name}, "]`).first())
}

/** The way into Settings: the sidebar's or the rail's item, or the phone's top-right button. An update mark adds its words to the name. */
export const settingsButton = (page) => page.getByRole("button", { name: /^Settings(, |$)/ })

/** A toast that a step raised on its way: wait for it to come and go, so it isn't in the picture by chance. */
export const toastGone = async ({ page }) => {
  const toast = page.locator("[data-sonner-toast]").first()
  await toast.waitFor()
  // On a phone a toast stands at the foot, where the control just pressed may be: a pointer resting on it would hold it there.
  await page.mouse.move(0, 0)
  await toast.waitFor({ state: "detached", timeout: 15_000 })
}

/** One item per nav list says it is the current place (brief 3.3): fails the picture otherwise. Returns that item's name. */
export const oneCurrent = async (list, where) => {
  const current = list.locator('[aria-current="page"]')
  const n = await current.count()
  if (n !== 1) throw new Error(`${where}: ${n} items say they are current, not one`)
  return current.getAttribute("aria-label")
}
/** The page head's title, as the open list column shows it. */
export const headTitle = async (page) => (await page.locator('[data-slot="page-head-title"]:visible').first().innerText()).trim()
/** The browser's Back, as a phone's back gesture or a mouse's back button makes it (ADR-0084). */
export const goBack = async (app) => {
  await app.page.goBack()
  await app.settle()
}

/** For a scene's `assert`: fails the picture with `message` unless `ok`. */
export const ensure = (ok, message) => {
  if (!ok) throw new Error(message)
}
