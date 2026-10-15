import { api } from "@/convex/_generated/api";
import { useAgentActions } from "@/hooks/use-agent-actions";
import { useChat } from "@/hooks/use-chat";
import { useDictation, useSpeechSynthesis } from "@/hooks/use-speech";
import { useStudioVoice } from "@/hooks/use-studio-voice";
import { useSettings } from "@/hooks/use-settings";
import { useVoice } from "@/hooks/use-voice";
import {
  clearNotes,
  dismissNote,
  markNotesRead,
  notesSnapshot,
  pushNote,
  subscribeNotes,
} from "@/lib/companion/notes";
import {
  describeScreen,
  screenSnapshot,
  subscribeScreen,
} from "@/lib/companion/screen";
import { useAction } from "convex/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "react-router";

/**
 * The companion: the small voice that lives in the corner of every page.
 *
 * It is the Assistant's family — the same brain, the same tools, the same
 * actions, the same memory — with two things of its own:
 *
 *   * **It is told what is on the screen.** The page writes a digest down (the
 *     route, the heading, the field being typed in, anything selected) and it
 *     travels with each turn, so "fix this", "how much is that", "make it
 *     shorter" mean the thing in front of them.
 *   * **It is brief, and it speaks first when something is genuinely worth
 *     saying.** Anything it says unprompted is rate-limited here and again on
 *     the server, because the difference between a companion and a nuisance is
 *     entirely a matter of how often it opens its mouth.
 *
 * Everything else — the conversation itself, the tools, the model calls — is
 * the machinery that already existed, reached through `useChat` and the same
 * action runner the two boxes on the AI pages use.
 *
 * The rules this holds to:
 *
 *   * Nothing is captured. There is no screenshot anywhere in this hub — the
 *     digest is a few lines of text the page wrote about itself, and it is only
 *     ever sent as part of a turn.
 *   * Timers and reminders need no model at all. They are done here, on the
 *     device, so they keep working with nothing behind the hub. Spelling is
 *     not one of its jobs either way: that is the browser's own checker, in
 *     the field itself, and nothing about it is ever said in this box.
 *   * It never speaks unprompted while Do Not Disturb is on, and it never
 *     speaks twice about the same thing.
 */

/** How long they must stay on a page before it offers a word about it. */
const HINT_SETTLE_MS = 6_000;

/** The least time between two lines it speaks first. */
const HINT_GAP_MS = 2 * 60 * 1000;

/** Where the moment the box was last looked at is kept, across reloads. */
const SEEN_KEY = "sugar:companion-seen-at";

/**
 * How often a note may open the box by itself.
 *
 * A real alert always shows itself — a timer going off is news whatever else
 * has happened. A hint is not news, and the box popping open on every one would
 * be the opposite of help; so hints and hints alone have to wait their turn.
 */
const AUTO_OPEN_GAP_MS = 45_000;

/** One line in the box: something said, or something the hub noticed. */
export type CompanionLine = {
  id: string;
  at: number;
  /** Written by the person, rather than to them. */
  mine: boolean;
  text: string;
  /** What was actually done, in plain english — shown under the line. */
  note: string | null;
  kind: "reply" | "alert" | "note";
  /** Pages worth opening, taken out of the words themselves. */
  links: string[];
};

/**
 * Every page the voice can be told to open, and the ways it might be named.
 *
 * These are anchored to the whole remainder of the sentence on purpose. "Open
 * the calendar" is a thing done here and now, without a model; "open the
 * calendar and put a dentist appointment in for Tuesday" is a job, and a job
 * belongs to the model, which can do all of it rather than half of it.
 */
const PAGES: { match: RegExp; to: string; name: string }[] = [
  {
    match: /^(the |my )?(web |sugar )?browser$/,
    to: "/browser",
    name: "the browser",
  },
  {
    match: /^(the )?(ai )?assistant$/,
    to: "/assistant",
    name: "the AI Assistant",
  },
  { match: /^(the )?(ai )?builder$/, to: "/builder", name: "the AI Builder" },
  { match: /^(the )?messenger$/, to: "/messenger", name: "the messenger" },
  {
    match: /^(the |my )?(calendar|day|schedule)$/,
    to: "/calendar",
    name: "the calendar",
  },
  {
    match: /^(the )?(control room|settings|keys)$/,
    to: "/control-room",
    name: "the Control Room",
  },
  { match: /^(the )?(live|live board|board)$/, to: "/live", name: "[LIVE]" },
];

/** "open the calendar" — the verb, and then the whole of the rest. */
const GOING =
  /^(?:open|open up|go|go to|go on|show me|take me to|bring up)\s+(.+)$/;

/** "stop listening", and nothing else after it. */
const STOPPING =
  /^(?:please |hey |ok )?(?:stop listening(?: to me)?|stop the mic|mute the mic|(?:turn )?hands[- ]?free off)$/;

/**
 * What a sentence is asking for, when it is one of the few things done here.
 *
 * It is exported because it is a pure rule with one dangerous edge — a phrase
 * that swallows a longer sentence — and `scripts/companion-check.ts` walks real
 * sentences through it to prove that edge is where it should be.
 */
export type LocalCommand =
  | { kind: "stop" }
  | { kind: "go"; to: string; name: string };

/**
 * The handful of things done on the device rather than by the model.
 *
 * These exist because they are the things a person says over and over, and
 * answering them locally is instant and works with no key at all: stop
 * listening, and take me to a page. Everything else goes to the model, which is
 * the whole point of having one.
 *
 * Every one of them matches a whole short sentence and nothing longer, which is
 * the rule that keeps this from eating real work: "open the calendar" is done
 * here, and "open the calendar and put a dentist appointment in for Tuesday" is
 * handed to the model, which can do both halves.
 */
export function localCommand(text: string): LocalCommand | null {
  const said = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/, "")
    .replace(/\s+/g, " ");

  if (STOPPING.test(said)) return { kind: "stop" };

  const going = GOING.exec(said);
  if (going) {
    const target = going[1].replace(/\s+(page|box|tab|screen)$/, "").trim();
    for (const page of PAGES) {
      if (page.match.test(target))
        return { kind: "go", to: page.to, name: page.name };
    }
  }

  return null;
}

/** Every web address written in a line, so the box can make it pressable. */
function linksIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>()"']+/g) ?? [];
  return [...new Set(found.map((url) => url.replace(/[.,;:]+$/, "")))].slice(
    0,
    4,
  );
}

export function useCompanion() {
  const navigate = useNavigate();
  const { values, update, isReady } = useSettings();
  const { resolved } = useVoice();
  const { run, problem, setProblem } = useAgentActions();

  // The same sender every other box uses — with the screen described along with
  // each question, which only the companion's prompt reads.
  const { messages, thinking, error, sendMessage, clearRoom, aiReady } =
    useChat("companion", { context: describeScreen });
  const askHint = useAction(api.ai_turn.hint);

  const digest = useSyncExternalStore(subscribeScreen, screenSnapshot);
  const notes = useSyncExternalStore(subscribeNotes, notesSnapshot);

  const [open, setOpen] = useState(false);

  const silence = values.silence ?? false;
  const speakReplies = values.companion_speak ?? true;
  const hintsOn = values.companion_hints ?? true;
  const quiet = values.do_not_disturb ?? false;
  // One studio voice for the whole app: the assistant on its page and the little
  // box in the corner are the same person, so they share one speaker.
  const studio = useStudioVoice();

  const {
    speak,
    speaking,
    stop: hush,
    supported: canTalk,
  } = useSpeechSynthesis({
    enabled: !silence,
    resolved,
    studio,
  });

  /* ---------------------------------------------------------- hands free */

  // The switch lives in the Control Room — the same one, on every device — and
  // the local copy is what makes pressing the microphone instant rather than a
  // round trip. The settings are read once, when they arrive.
  const [handsFree, setHandsFreeState] = useState(false);
  const loadedSwitches = useRef(false);

  useEffect(() => {
    if (!isReady || loadedSwitches.current) return;
    loadedSwitches.current = true;
    setHandsFreeState(values.companion_hands_free ?? false);
  }, [isReady, values.companion_hands_free]);

  const setHandsFree = useCallback(
    (on: boolean) => {
      setHandsFreeState(on);
      update("companion_hands_free", on);
    },
    [update],
  );

  /** Read a line out, when the Control Room has not switched that off. */
  const sayIt = useCallback(
    (text: string) => {
      if (!canTalk || !speakReplies) return;
      speak(text);
    },
    [canTalk, speak, speakReplies],
  );

  /* ------------------------------------------------------ what it is told */

  /**
   * A sentence said or typed to it: a local command, or a question for the
   * model. The local ones are checked first because they are the things people
   * say most, and they are answered without a thought.
   */
  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      const command = localCommand(text);
      if (command?.kind === "stop") {
        setHandsFree(false);
        pushNote({
          kind: "note",
          text: "Hands-free is off. Press the microphone in the corner when you want me listening again.",
        });
        return;
      }
      if (command?.kind === "go") {
        navigate(command.to);
        pushNote({ kind: "note", text: `Opened ${command.name}.` });
        return;
      }

      setProblem(null);
      const result = await sendMessage(text);
      if (!result?.ok) return;

      // Said from across the room with the box shut: the answer is worth
      // looking at, so the box comes up with it.
      setOpen(true);
      if (result.say) sayIt(result.say);
      await run(result.actions);
    },
    [navigate, run, sayIt, sendMessage, setHandsFree, setProblem],
  );

  /* ------------------------------------------------------------- the ear */

  // Hands-free means the microphone stays open wherever they are, on every
  // page, until they switch it off — the Control Room switch is what keeps it
  // on across a reload and across devices. It shuts itself while the model is
  // thinking and while the answer is being read out, because the microphone
  // picking up its own voice is how a companion ends up talking to itself.
  const dictation = useDictation({
    active: handsFree,
    muted: thinking || speaking,
    onFinal: (text) => void ask(text),
  });

  /* ------------------------------------------------- speaking up on its own */

  const hintAt = useRef(0);
  const hintPath = useRef<string | null>(null);

  /**
   * A word on arrival.
   *
   * It waits before saying anything, because a page that has only just opened
   * is often a page being passed through — and then asks the server for one
   * short line about what is in front of them. Silence is a perfectly good
   * answer, and the prompt is written to allow it: the server refuses to spend
   * a second line inside three minutes, and this refuses to ask even that often
   * — one page in, one question, and then two minutes of quiet.
   */
  useEffect(() => {
    const path = digest?.path;
    if (!path || path === hintPath.current) return;

    // Nothing is offered while the house is quiet, or when there is no model to
    // offer it with. Marking the page as done keeps it from asking again the
    // moment either of those changes.
    if (!hintsOn || quiet || !aiReady) {
      hintPath.current = path;
      return;
    }

    const timer = window.setTimeout(() => {
      hintPath.current = path;
      if (Date.now() - hintAt.current < HINT_GAP_MS) return;
      hintAt.current = Date.now();

      void askHint({
        why: `They have just arrived on ${path} and have not asked anything yet.`,
        context: describeScreen() ?? undefined,
      })
        .then((result) => {
          if (!result.ok) return;
          sayIt(result.say);
          setOpen(true);
        })
        .catch(() => {
          // A model that cannot be reached is not worth reporting here: the
          // box still answers anything they ask it.
        });
    }, HINT_SETTLE_MS);

    return () => window.clearTimeout(timer);
  }, [aiReady, askHint, digest?.path, hintsOn, quiet, sayIt]);

  /* ------------------------------------------------------------ the thread */

  const lines = useMemo<CompanionLine[]>(() => {
    const spoken: CompanionLine[] = messages.map((message) => ({
      id: message.id,
      // A line with no timestamp came from a box that does not keep one; it is
      // placed with the notes that arrived around it.
      at: message.at ?? 0,
      mine: message.mine,
      text: message.text,
      note: message.note ?? null,
      kind: "reply",
      links: linksIn(message.text),
    }));

    const noticed: CompanionLine[] = notes.map((note) => ({
      id: note.id,
      at: note.at,
      mine: false,
      text: note.text,
      note: null,
      kind: note.kind,
      links: note.links,
    }));

    return [...spoken, ...noticed].sort((a, b) => a.at - b.at);
  }, [messages, notes]);

  /* --------------------------------------------------------------- unread */

  const [seenAt, setSeenAt] = useState(() => {
    try {
      return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
    } catch {
      return 0;
    }
  });

  /**
   * Everything in the box has been looked at.
   *
   * Deliberately a thing that happens when a person does something — opening
   * it, closing it, or touching it — rather than an effect watching the state.
   * A badge is a fact about attention, and the moment of attention is the only
   * honest place to record it.
   */
  const markSeen = useCallback(() => {
    const now = Date.now();
    setSeenAt(now);
    markNotesRead();
    try {
      localStorage.setItem(SEEN_KEY, String(now));
    } catch {
      // Nothing to remember it with; it is only a badge.
    }
  }, []);

  const openBox = useCallback(() => {
    setOpen(true);
    markSeen();
  }, [markSeen]);

  const closeBox = useCallback(() => {
    setOpen(false);
    markSeen();
  }, [markSeen]);

  const toggle = useCallback(() => {
    if (open) closeBox();
    else openBox();
  }, [closeBox, open, openBox]);

  /**
   * What has arrived and not been looked at: the conversation's own lines since
   * the box was last open, plus the notes nobody has read. The two are counted
   * apart on purpose — a note is a line in the box and would otherwise be
   * counted twice.
   */
  const unread = useMemo(
    () =>
      messages.filter((message) => !message.mine && (message.at ?? 0) > seenAt)
        .length + notes.filter((note) => !note.read).length,
    [messages, notes, seenAt],
  );

  // It pops open when there is something new to say — which is the whole idea
  // of it: a little box that arrives with a line in it, rather than one that
  // has to be remembered. Subscribing to the notes themselves is what makes
  // this work for a note from anywhere in the app — a timer that has gone off —
  // and the callback form is deliberate: this is state
  // changing in an outside system, not something to be watched for in a render.
  const autoOpenedAt = useRef(0);

  useEffect(
    () =>
      subscribeNotes((note) => {
        // Reading the box, dismissing a line and emptying it all announce
        // themselves too, and none of them is news: only a note that has just
        // arrived opens anything.
        if (!note) return;

        const now = Date.now();
        if (
          note.kind !== "alert" &&
          now - autoOpenedAt.current < AUTO_OPEN_GAP_MS
        ) {
          return;
        }
        autoOpenedAt.current = now;
        setOpen(true);
      }),
    [],
  );

  const clear = useCallback(() => {
    clearRoom();
    clearNotes();
  }, [clearRoom]);

  return {
    open,
    openBox,
    closeBox,
    toggle,
    /** Looked at: called when a hand or an eye reaches the box. */
    markSeen,
    /** Everything in the box, oldest first. */
    lines,
    unread,
    ask,
    thinking,
    error,
    problem,
    setProblem,
    dismiss: dismissNote,
    clear,
    aiReady,

    /* the voice */
    handsFree,
    setHandsFree,
    listening: dictation.listening,
    interim: dictation.interim,
    micSupported: dictation.supported,
    micError: dictation.error,
    clearMicError: dictation.clearError,
    speak: canTalk,
    speaking,
    hush,
    speakReplies,
    setSpeakReplies: (on: boolean) => update("companion_speak", on),
    hintsOn,
    setHintsOn: (on: boolean) => update("companion_hints", on),
    /** What it currently believes is on their screen. Shown in the box. */
    screen: digest,
  };
}
