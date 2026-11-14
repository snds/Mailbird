import { demoFlags, type CoreClient } from "./client"
import type { Account, MessageDetail, OutboxItem } from "./types"

import { calendar } from "./demo-scenarios/calendar"
import { contacts } from "./demo-scenarios/contacts"
import { mail } from "./demo-scenarios/mail"
import { notes } from "./demo-scenarios/notes"
import { settings } from "./demo-scenarios/settings"
import { shell } from "./demo-scenarios/shell"
import { status } from "./demo-scenarios/status"

// Demo scenarios (ADR-0081): named states of the in-memory demo, for the
// screenshots and for trying a state by hand, such as a sync error, a held
// sync, an empty inbox or a team member's view. The demo client reads the
// name once, at start, from sessionStorage; only that client does, never
// the desktop app's or a gateway's. In the browser's console:
//
//   sessionStorage.setItem("vale.demo.scenario", "member"); location.reload()
//
// Several names, joined by commas, run in that order. One file per area
// under demo-scenarios/ holds that area's scenarios, so a lane edits only
// its own file. Sample data in a scenario is realistic and the demo's own,
// never a design's sample content.

/** Where the demo client looks for its scenario. */
export const SCENARIO_KEY = "vale.demo.scenario"

/** A demo message: its attachments' bytes (base64) ride along, by attachment id. */
export type DemoMessage = MessageDetail & { files: Record<string, string> }

/** The demo client's own data. Change it in place: the client keeps these very lists and maps. */
export interface DemoState {
  accounts: Account[]
  messages: DemoMessage[]
  /** What is waiting to send, or failed to, by id. */
  outbox: Map<string, OutboxItem>
  /** Follow-up reminders: when each comes due (Unix seconds), by the Message-ID of your sent message. */
  followUps: Map<string, number>
}

/** The demo client with its methods open to replacement. */
export type DemoClient = { -readonly [K in keyof CoreClient]: CoreClient[K] }
type Method = { [K in keyof CoreClient]: CoreClient[K] extends (...args: never[]) => unknown ? K : never }[keyof CoreClient]

export interface Demo {
  client: DemoClient
  state: DemoState
  /**
   * `member`: a team member on a gateway (isMember(), mail only). `gatewayOwner`:
   * the gateway's owner. Either makes the client remote. `desktopApp`: UI only
   * the desktop app shows (isDesktopApp()); calls still never go to Tauri.
   */
  flags: typeof demoFlags
  /** Replaces a method with `around(original)`: hold a sync, fail a send, never answer a list. */
  wrap<K extends Method>(method: K, around: (original: CoreClient[K]) => CoreClient[K]): void
}

/** A scenario changes the demo before the app's first read. */
export type DemoScenario = (demo: Demo) => void
export type DemoScenarios = Record<string, DemoScenario>

const AREAS: Record<string, DemoScenarios> = { shell, status, mail, calendar, contacts, notes, settings }

/** Every scenario by name. Two areas can't use one name. */
function registry(): Map<string, DemoScenario> {
  const all = new Map<string, DemoScenario>()
  const area = new Map<string, string>()
  for (const [file, list] of Object.entries(AREAS)) {
    for (const [name, scenario] of Object.entries(list)) {
      if (all.has(name)) throw new Error(`two demo scenarios are named “${name}”: in demo-scenarios/${area.get(name)}.ts and ${file}.ts`)
      all.set(name, scenario)
      area.set(name, file)
    }
  }
  return all
}

function storedNames(): string[] {
  try {
    return (sessionStorage.getItem(SCENARIO_KEY) ?? "").split(",").map((n) => n.trim()).filter(Boolean)
  } catch {
    // No storage: the plain demo.
    return []
  }
}

/** The demo client, changed by the scenarios named in sessionStorage; as it was when none are. */
export function withDemoScenario(client: CoreClient, state: DemoState): CoreClient {
  const names = storedNames()
  if (!names.length) return client
  const all = registry()
  const demo: Demo = {
    client: { ...client },
    state,
    flags: demoFlags,
    wrap(method, around) {
      Object.assign(demo.client, { [method]: around(demo.client[method]) })
    },
  }
  for (const name of names) {
    const scenario = all.get(name)
    if (!scenario) throw new Error(`the demo has no scenario named “${name}” (core/demo-scenarios.ts)`)
    scenario(demo)
  }
  // A team member and the gateway's owner both reach the core through a gateway.
  return { ...demo.client, remote: client.remote || !!demoFlags.member || !!demoFlags.gatewayOwner }
}
