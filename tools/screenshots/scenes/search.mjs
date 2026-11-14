// Search, the command menu (⌘K) and the keys list (`?`).

export const scenes = [
  { name: "mail-search", run: (app) => app.page.getByRole("textbox", { name: "Search mail" }).fill("cabin") },
  { name: "mail-search-none", run: (app) => app.page.getByRole("textbox", { name: "Search mail" }).fill("zeppelin") },
  { name: "command-menu", run: (app) => app.page.keyboard.press("Control+KeyK") },
  { name: "keyboard-shortcuts", run: (app) => app.page.keyboard.press("?") },
]
