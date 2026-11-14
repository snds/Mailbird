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

/** For a scene's `assert`: fails the picture with `message` unless `ok`. */
export const ensure = (ok, message) => {
  if (!ok) throw new Error(message)
}
