/**
 * The little box's own notes: the things the hub tells the person without a
 * model being asked at all.
 *
 * Two kinds live here, and both of them are facts the page already knows:
 *
 *   * an **alert** — a timer that has finished or a reminder that has come due,
 *     which is the one thing the assistant is allowed to raise on its own;
 *   * a **note** — a plain acknowledgement of something the box itself just
 *     did, such as hands-free switching off. No model, no key, no connection.
 *
 * They are kept apart from the conversation — which lives in the companion's
 * thread on the server, and is where anything the model said goes — for a
 * simple reason: a note here can be produced with no key, no connection and no
 * model, so timers keep working on a hub with nothing behind it.
 *
 * Spelling used to be a third kind, and it is deliberately gone: a spelling is
 * the browser's own business, in the field it was typed in — the same
 * underlining as any other text box on the machine — and a note about it in a
 * box in the corner is exactly the distance from the sentence that made
 * correcting one a chore.
 *
 * Notes are held in memory and mirrored into `localStorage`, so a reload does
 * not lose the last thing it told you. They are capped and deduplicated: the
 * same notice twice inside ten minutes is one note, not two.
 */

const STORE_KEY = "sugar:companion-notes";

/** How many notes are worth keeping. Anything older is gone on the next write. */
const KEEP = 30;

/** The longest a single note may be. The box is read at a glance. */
const TEXT_LIMIT = 800;

/** How long an identical note is left alone before it may be said again. */
const REPEAT_MS = 10 * 60 * 1000;

export type CompanionNoteKind = "alert" | "note";

export type CompanionNote = {
  id: string;
  at: number;
  kind: CompanionNoteKind;
  text: string;
  /** Pages worth opening for this note, already checked as http(s). */
  links: string[];
  read: boolean;
};

let notes: CompanionNote[] = load();

/**
 * A listener is handed the note that arrived, when one did.
 *
 * The note is optional because most changes are not new news — reading the box,
 * dismissing a line, emptying it — and a caller that only wants to draw the
 * list does not care either way. The little box itself does: a note arriving
 * from anywhere in the app is the one thing that opens it without being asked.
 */
export type NoteListener = (note?: CompanionNote | null) => void;

const listeners = new Set<NoteListener>();

/** The notes as they stand. The array identity only changes when it changes. */
export function notesSnapshot(): CompanionNote[] {
  return notes;
}

export function subscribeNotes(listener: NoteListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(note?: CompanionNote | null) {
  for (const listener of listeners) listener(note);
}

function read(text: string) {
  return String(text ?? "")
    .trim()
    .slice(0, TEXT_LIMIT);
}

/** Only real pages, and never one with no scheme. */
function cleanLinks(links: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of links ?? []) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    } catch {
      continue;
    }
    seen.add(value);
    out.push(value);
  }

  return out.slice(0, 4);
}

function load(): CompanionNote[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (row): row is CompanionNote =>
          Boolean(row) &&
          typeof row === "object" &&
          typeof (row as CompanionNote).text === "string" &&
          typeof (row as CompanionNote).at === "number",
      )
      .slice(-KEEP);
  } catch {
    // An unreadable store is simply an empty one — a note is not worth failing
    // a page load for.
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(notes.slice(-KEEP)));
  } catch {
    // The store is full or refused; the notes stay in memory for this tab.
  }
}

/**
 * Add a note, unless the very same one was added a moment ago.
 *
 * The dedupe is by kind and text, because the same sentence arriving twice in
 * two minutes is what the person sees as a glitch — the page can ask again on
 * every keystroke, and this is what makes that cheap.
 */
export function pushNote(note: {
  kind: CompanionNoteKind;
  text: string;
  links?: string[];
}): CompanionNote | null {
  const text = read(note.text);
  if (!text) return null;

  const now = Date.now();
  const duplicate = notes.find(
    (row) =>
      row.kind === note.kind && row.text === text && now - row.at < REPEAT_MS,
  );
  if (duplicate) return duplicate;

  const fresh: CompanionNote = {
    id: `note-${now}-${Math.random().toString(36).slice(2, 8)}`,
    at: now,
    kind: note.kind,
    text,
    links: cleanLinks(note.links),
    read: false,
  };

  notes = [...notes, fresh].slice(-KEEP);
  save();
  announce(fresh);
  return fresh;
}

/** Everything in the box has been looked at. */
export function markNotesRead(): void {
  if (!notes.some((note) => !note.read)) return;
  notes = notes.map((note) => (note.read ? note : { ...note, read: true }));
  save();
  announce();
}

/** Take one note out of the box — the one that was dealt with. */
export function dismissNote(id: string): void {
  const next = notes.filter((note) => note.id !== id);
  if (next.length === notes.length) return;
  notes = next;
  save();
  announce();
}

/** Empty the box. The conversation is cleared separately, and on purpose. */
export function clearNotes(): void {
  if (!notes.length) return;
  notes = [];
  save();
  announce();
}

/** How many notes nobody has seen yet. */
export function unreadNotes(list: CompanionNote[]): number {
  return list.filter((note) => !note.read).length;
}
