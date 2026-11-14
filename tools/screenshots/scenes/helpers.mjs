// Steps every lane's scenes share. A helper that knows one area's screens
// lives in that area's file, so the lane that changes the screen fixes it.

/** Clicks, then waits for what it opened to finish arriving, so the next step acts on a still screen. */
export const press = async (app, locator) => {
  await locator.click()
  await app.settle()
}

export const button = (page, name) => page.getByRole("button", { name, exact: true })

/** Opens an area (Mail, Calendar, Contacts, Notes) from the app's navigation. */
export const area = (app, name) => press(app, app.page.getByRole("navigation", { name: "Apps" }).getByRole("button", { name, exact: true }))

/** A toast that a step raised on its way: wait for it to come and go, so it isn't in the picture by chance. */
export const toastGone = async ({ page }) => {
  const toast = page.locator("[data-sonner-toast]").first()
  await toast.waitFor()
  await toast.waitFor({ state: "detached", timeout: 15_000 })
}

/** For a scene's `assert`: fails the picture with `message` unless `ok`. */
export const ensure = (ok, message) => {
  if (!ok) throw new Error(message)
}
