/** How a note's text points at its own images (ADR-0044): `![alt](note-file:ID)`. */
export const NOTE_FILE = "note-file:"

export const noteFileId = (src: string) => (src.startsWith(NOTE_FILE) ? src.slice(NOTE_FILE.length) : null)
