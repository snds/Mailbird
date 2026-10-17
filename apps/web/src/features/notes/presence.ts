import { create } from "zustand"

/**
 * Who has a shared note or conversation open right now (ADR-0061): each
 * person's app says so on the shared document's connection while it's open,
 * and stops when it closes. Keyed by the shared document's id.
 */
export interface Person {
  /** Their connection, so two windows of one person count once each. */
  id: number
  name: string
}

export const usePresence = create<Record<string, Person[]>>(() => ({}))

export const setPeople = (shareId: string, people: Person[]) => usePresence.setState({ [shareId]: people })

/** "Ana is here", "Ana and Sam are here", "Ana, Sam, and 2 others are here". */
export function peopleLine(people: Person[]): string {
  const names = [...new Set(people.map((p) => p.name))]
  if (names.length === 0) return ""
  if (names.length === 1) return `${names[0]} is here`
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are here`
  return `${names[0]}, ${names[1]}, and ${names.length - 2} others are here`
}
