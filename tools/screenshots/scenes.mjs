// The screens `pnpm shots` takes a picture of, joined from one file per lane
// in scenes/. A scene lives in the file of the lane that owns the screen it
// drives, so each lane fixes its own scenes and helpers. Each scene starts
// from a fresh page on sample data and gets there the way a person would: by
// the names things have on screen. When a screen changes, fix its scene; keep
// its name, so before and after pictures pair up by file name.
//
// A scene is { name, run?, path?, sizes?, viewport?, scenario?, offline?, loading?, assert?, sean? }:
//   run(app)    steps from the app's first screen (Mail's inbox). app is
//               { page, size, phone, touch, viewport, theme, settle }:
//               Playwright's page, the size's name, whether this is the phone
//               size, whether the size is touch, the window's size, "light" or
//               "dark", and a wait until the screen stops changing
//   path        a different address to open ("/?mini")
//   sizes       the sizes this scene has, from desktop, phone, medium and
//               landscape. Without it: desktop and phone. --size picks among them
//   viewport    { width, height } for every size of this scene (a small window)
//   scenario    a demo scenario's name, or a list of them
//               (apps/web/src/core/demo-scenarios.ts), set before the app loads
//   offline     the connection drops once the app has loaded. A read the app
//               hasn't made yet then waits (React Query pauses offline), so a
//               scene that opens something new also sets loading
//   loading     the picture is of a loading screen: skeletons and aria-busy
//               don't hold it back
//   assert(app) runs on the still screen, before the picture; a throw fails
//               the picture (helpers.mjs has `ensure`)
//   sean        { kind: "drawn" | "undrawn", area, screen }: --sean exports it
//               as <area>--<screen>__<size>__<graphite|stone>.png
//
// Text a scene types is the scene's own. Sample data stays in
// apps/web/src/core/demo*.ts and its scenarios, never in a scene.

import { scenes as calendar } from "./scenes/calendar.mjs"
import { scenes as contacts } from "./scenes/contacts.mjs"
import { scenes as mail } from "./scenes/mail.mjs"
import { scenes as notes } from "./scenes/notes.mjs"
import { scenes as outside } from "./scenes/outside.mjs"
import { scenes as search } from "./scenes/search.mjs"
import { scenes as settings } from "./scenes/settings.mjs"
import { scenes as shell } from "./scenes/shell.mjs"

export const scenes = [...shell, ...mail, ...search, ...calendar, ...contacts, ...notes, ...settings, ...outside]
