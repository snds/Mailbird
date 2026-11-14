import { useDemoUpdate } from "@/app/update-mark"

import type { DemoScenarios } from "../demo-scenarios"

/** The shell's scenarios (ADR-0081): who is signed in, and what the app around the areas shows. */
export const shell: DemoScenarios = {
  /** A team member on the owner's gateway (ADR-0063): Mail only. */
  member: ({ flags }) => {
    flags.member = { id: "member-noor", name: "Noor Haddad", role: "member" }
  },
  /** A newer version is downloaded and waits for a restart: the update mark shows on the way into Settings (ADR-0083). */
  "update-ready": () => {
    useDemoUpdate.setState({ offered: "0.1.0-main.20261112081500" })
  },
}
