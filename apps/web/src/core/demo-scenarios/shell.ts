import type { DemoScenarios } from "../demo-scenarios"

/** The shell's scenarios (ADR-0081): who is signed in, and what the app around the areas shows. */
export const shell: DemoScenarios = {
  /** A team member on the owner's gateway (ADR-0063): Mail only. */
  member: ({ flags }) => {
    flags.member = { id: "member-noor", name: "Noor Haddad", role: "member" }
  },
}
