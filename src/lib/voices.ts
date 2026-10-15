/**
 * The eight voices the assistant speaks with — eight women, eight accents,
 * none of them British.
 *
 * The voices themselves come from the device. Every browser ships its own
 * speech engine, and those are the only voices available without sending your
 * words off to a paid service, so a profile does not hold a voice: it holds an
 * *accent*, and takes the best voice on this device that really has it —
 * French, Italian, Spanish, Brazilian, Australian, Indian, or one of the two
 * American ones.
 *
 * Two rules run through the whole file.
 *
 * **Nothing from the British Isles is ever offered.** `isUkVoice` refuses
 * `en-GB` and `en-IE` by language tag and refuses the voices that carry those
 * accents by name (Daniel, Kate, Serena, Fiona, Moira, Oliver, Hazel, Sonia
 * and the rest), because a device that decides an English voice must be
 * British is exactly what this list exists to get away from. A voice that
 * sounds like the person's grandmother reading the news is not her. The one
 * exception is deliberate and is stated out loud: when there is *nothing* else
 * on the device, the list says so rather than quietly breaking, and the
 * assistant speaks in whatever the device would have used anyway.
 *
 * **Nothing is faked.** A profile says plainly whether the device really has
 * her accent or whether it is standing in with a voice that is not quite her —
 * see `fit` on a `ResolvedVoice`. A stand-in is still a different person from
 * the next profile down the list, because each one has its own pace and its own
 * tone, which is what keeps eight names from collapsing into one voice.
 */

export type VoiceProfile = {
  id: string;
  /** The name she goes by, so the eight read as eight people. */
  name: string;
  /** The accent, as it appears beside her name. */
  accent: string;
  /** One line about how she sounds, in the app's own voice. */
  about: string;
  /**
   * The language tags that really are this accent, best first — `"fr-fr"`,
   * `"es-mx"`. Empty when no operating system tags the accent at all, which is
   * what makes a Southern drawl always a stand-in rather than a promise.
   */
  langs: string[];
  /** Device voice names that carry this accent, when a device names one. */
  hints: string[];
  /** How much slower or faster she stands in, when the accent is missing. */
  pace: number;
  /** How much lower or higher she stands in, when the accent is missing. */
  tone: number;
  /** What she says when somebody presses Hear it. */
  sample: string;
};

/**
 * The roster, in the order it is shown. The first one is the default: a low,
 * warm American — the voice the assistant is meant to be when nobody has
 * chosen otherwise.
 */
export const VOICE_PROFILES: VoiceProfile[] = [
  {
    id: "ava",
    name: "Ava",
    accent: "American — low and warm",
    about:
      "The voice the assistant is by default: low-mid, unhurried, a little smoky, warm rather than sweet.",
    langs: ["en-us"],
    hints: [
      "samantha",
      "ava",
      "aria",
      "jenny",
      "michelle",
      "allison",
      "zira",
      "kendra",
      "kimberly",
      "joanna",
      "salli",
      "zoe",
      "nicky",
    ],
    pace: 1,
    tone: 0,
    sample:
      "Hi, I'm Ava. Warm, a little low, and very glad to be useful — ask me anything.",
  },
  {
    id: "scarlett",
    name: "Scarlett",
    accent: "Southern — slow, honeyed drawl",
    about:
      "Unhurried and honeyed, the kind of voice that takes its time and means it. No operating system tags a Southern voice, so on most machines she is a stand-in rather than a promise.",
    langs: [],
    hints: ["southern", "dixie", "louisiana", "texas"],
    pace: 0.95,
    tone: -0.035,
    sample:
      "Well hey — I'm Scarlett. Sit down, tell me what you need, there's no rush here.",
  },
  {
    id: "colette",
    name: "Colette",
    accent: "French — soft, rounded vowels",
    about:
      "Soft and rounded, with the vowels a French speaker gives English. Cool, precise, faintly amused.",
    langs: ["fr-fr", "fr-ca", "fr-be"],
    hints: ["amelie", "amélie", "audrey", "marie", "denise", "celine", "céline", "vivienne"],
    pace: 0.98,
    tone: 0.015,
    sample:
      "Bonjour — I'm Colette. Rounded vowels, a cool head, and a very good memory.",
  },
  {
    id: "giulia",
    name: "Giulia",
    accent: "Italian — musical, expressive",
    about:
      "Musical and expressive, with an Italian lift on the ends of words. She sounds pleased about almost everything.",
    langs: ["it-it"],
    hints: ["alice", "elsa", "giulia", "lucia", "alba"],
    pace: 0.99,
    tone: 0.012,
    sample:
      "Ciao — Giulia here. Musical, direct, and much better company than a form to fill in.",
  },
  {
    id: "valentina",
    name: "Valentina",
    accent: "Spanish — smoky and dry",
    about:
      "Smoky, dry and unhurried, with a Spanish-English rhythm. She delivers a joke and lets it land.",
    langs: ["es-es", "es-mx", "es-us", "es-ar", "es-co"],
    hints: ["monica", "mónica", "paulina", "helena", "sabina", "catalina", "soledad", "laura"],
    pace: 1.02,
    tone: -0.012,
    sample:
      "Hola — Valentina. Smoky, dry, and entirely on your side. What are we doing today?",
  },
  {
    id: "isabela",
    name: "Isabela",
    accent: "Brazilian — sunlit, playful",
    about:
      "Sunlit and playful, Brazilian Portuguese warmth under the English. The lightest of the eight, never shrill.",
    langs: ["pt-br"],
    hints: ["luciana", "fernanda", "joana", "francisca", "vitoria", "vitória", "ines", "inês"],
    pace: 1.01,
    tone: 0.006,
    sample:
      "Oi — Isabela. Bright, quick, and quietly delighted that you're here. Let's get into it.",
  },
  {
    id: "sasha",
    name: "Sasha",
    accent: "Australian — easy, teasing",
    about:
      "Easy and teasing, Australian vowels, warm under the dryness. Never earnest for longer than it needs to be.",
    langs: ["en-au", "en-nz"],
    hints: ["karen", "matilda", "nicole", "waveney"],
    pace: 0.99,
    tone: -0.018,
    sample:
      "Hiya — Sasha. Easy, dry, and I'll tell you straight when something's a bad idea.",
  },
  {
    id: "priya",
    name: "Priya",
    accent: "Indian — precise, warm",
    about:
      "Precise and warm, Indian English, a touch brighter than the rest and completely unbothered by detail.",
    langs: ["en-in", "hi-in", "en-sg"],
    hints: ["veena", "heera", "ravi", "lekha", "neerja", "swara", "kalpana", "asha"],
    pace: 1.02,
    tone: 0.018,
    sample:
      "Namaste — Priya. Precise, warm, and very good at the part you didn't want to do yourself.",
  },
];

/** The ids alone, in the same order — what the server checks a choice against. */
export const VOICE_IDS: string[] = VOICE_PROFILES.map((profile) => profile.id);

export const DEFAULT_VOICE_ID = "ava";

/**
 * Whether an id really is one of the eight.
 *
 * Used wherever a voice arrives from outside — the server checking a choice, or
 * the AI naming one for itself — so that an unknown id is refused by the one
 * piece of code that knows the roster, rather than being quietly resolved to
 * whoever happens to be first.
 */
export function isKnownVoiceId(id: string | null | undefined): boolean {
  return typeof id === "string" && VOICE_IDS.includes(id.trim().toLowerCase());
}

export function profileById(id: string | null | undefined): VoiceProfile {
  return (
    VOICE_PROFILES.find((profile) => profile.id === id) ?? VOICE_PROFILES[0]
  );
}

/** Her name and her accent, for a sentence somebody else is writing. */
export function voiceLabel(id: string | null | undefined): string {
  const profile = profileById(id);
  return `${profile.name} — ${profile.accent}`;
}

/* ------------------------------------------------------------- delivery --- */

/**
 * How she speaks, as opposed to which of the eight she is.
 *
 * Four numbers, each its own slider in the Control Room, and each one applied
 * to real `SpeechSynthesisUtterance` fields — none of them is decoration.
 *
 * `speed` is the words per second (the engine's own rate, nudged a little slow
 * of 1 by default, because her register wants room). `warmth` moves her pitch;
 * negative is lower and deeper, which is where she starts. `volume` is hers
 * alone: it never touches the rest of the hub's audio. `expressiveness` is how
 * much she moves *within* a reply — the pitch lift on a question, the quicker
 * step on a joke, the small drop before a serious sentence — and at zero she
 * reads every sentence on the same note, deliberately flat.
 */
export type VoiceDelivery = {
  speed: number;
  warmth: number;
  volume: number;
  expressiveness: number;
};

export const DELIVERY_LIMITS = {
  speed: { min: 0.6, max: 1.4, step: 0.01 },
  warmth: { min: -0.3, max: 0.3, step: 0.01 },
  volume: { min: 0, max: 1, step: 0.01 },
  expressiveness: { min: 0, max: 1, step: 0.01 },
} as const;

export const DEFAULT_DELIVERY: VoiceDelivery = {
  speed: 0.98,
  // No pitch shift at all by default. A device voice is somebody's recorded
  // work, and shifting it is what makes a good voice sound wrong: engines on
  // some platforms resample rather than re-synthesise, so even a few percent
  // turns a warm voice muddy and a bright one metal. She starts as herself, and
  // the warmth slider is there for anyone who wants her lower.
  warmth: 0,
  volume: 1,
  expressiveness: 0.45,
};

function between(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Whatever was stored, brought into range and completed from the defaults. */
export function deliveryFrom(raw: Partial<VoiceDelivery> | null | undefined): VoiceDelivery {
  const one = (key: keyof VoiceDelivery) => {
    const limits = DELIVERY_LIMITS[key];
    const value = raw?.[key];
    return typeof value === "number" && Number.isFinite(value)
      ? Number(between(value, limits.min, limits.max).toFixed(3))
      : DEFAULT_DELIVERY[key];
  };
  return {
    speed: one("speed"),
    warmth: one("warmth"),
    volume: one("volume"),
    expressiveness: one("expressiveness"),
  };
}

/** True when nothing has been moved off her own defaults. */
export function isDefaultDelivery(delivery: VoiceDelivery) {
  return (Object.keys(DEFAULT_DELIVERY) as (keyof VoiceDelivery)[]).every(
    (key) => Math.abs(delivery[key] - DEFAULT_DELIVERY[key]) < 0.005,
  );
}

/* --------------------------------------------------- which voices, where -- */

/**
 * The novelty voices operating systems ship — Bubbles, Zarvox and friends.
 * They are great fun and completely wrong for reading an answer out loud.
 */
const NOVELTY = [
  "albert",
  "bad news",
  "bahh",
  "bells",
  "boing",
  "bubbles",
  "cellos",
  "deranged",
  "good news",
  "hysterical",
  "jester",
  "junior",
  "pipe organ",
  "princess",
  "ralph",
  "superstar",
  "trinoids",
  "wobble",
  "zarvox",
  "novelty",
  "compact",
  "espeak",
];

/**
 * The voices that sound like the British Isles.
 *
 * The language tag is the reliable half of this and is checked first, but
 * devices mislabel their own voices often enough — and a good few of these ship
 * under a bare "en-US" on one platform and "en-GB" on another — that the names
 * have to be refused as well. `UK_PHRASES` are matched inside a name, which is
 * how the engines spell their own accents; `UK_NAMES` are matched as whole
 * words, so that "Alexandra" is not thrown out for containing "Alex".
 *
 * Moira, Fiona and the rest are Irish and Scottish rather than English and are
 * here for the same reason as the English ones, by the request that built this
 * list: nothing that sounds like it comes from those islands. Tessa and the
 * South African voices are left out with them — the accent is close enough to
 * the ear that offering it would answer a request nobody made.
 */
const UK_PHRASES = [
  "uk english",
  "united kingdom",
  "british",
  "en-gb",
  "en_gb",
  "scottish",
  "irish english",
  "welsh english",
];

const UK_NAMES = [
  "daniel",
  "kate",
  "serena",
  "fiona",
  "moira",
  "tessa",
  "oliver",
  "arthur",
  "gordon",
  "malcolm",
  "hazel",
  "sonia",
  "libby",
  "maisie",
  "thomas",
  "george",
  "emily",
  "amy",
  "charlotte",
  "ryan",
  "graham",
  "catherine",
  "alex",
  "pixie",
  "shaun",
  "shelley",
  "loch",
  "sean",
  "niamh",
  "orla",
  "eimear",
  "geraint",
  "susan",
];

/** One whole-word test for all of them, built once. */
const UK_WORD = new RegExp(`\\b(${UK_NAMES.join("|")})\\b`, "i");

/** Names that read as a female voice, most specific first. */
const FEMALE_HINTS = [
  "alexandra",
  "samantha",
  "ava",
  "aria",
  "jenny",
  "michelle",
  "allison",
  "kendra",
  "kimberly",
  "joanna",
  "salli",
  "zoe",
  "nicky",
  "zira",
  "susan",
  "anna",
  "amelie",
  "amélie",
  "audrey",
  "marie",
  "celine",
  "céline",
  "alice",
  "elsa",
  "giulia",
  "lucia",
  "monica",
  "mónica",
  "paulina",
  "helena",
  "catalina",
  "soledad",
  "luciana",
  "fernanda",
  "joana",
  "vitoria",
  "vitória",
  "matilda",
  "nicole",
  "veena",
  "heera",
  "lekha",
  "neerja",
  "kalpana",
  "female",
  "woman",
  "girl",
];

/**
 * True for anything that is, or sounds like, the British Isles. Nothing in this
 * list is ever handed to a profile.
 */
export function isUkVoice(voice: {
  name?: string | null;
  lang?: string | null;
}): boolean {
  const lang = (voice.lang ?? "").toLowerCase().replace("_", "-");
  if (lang.startsWith("en-gb") || lang.startsWith("en-uk")) return true;
  if (lang.startsWith("en-ie")) return true;
  if (lang.startsWith("gd") || lang.startsWith("cy") || lang.startsWith("ga"))
    return true;

  const name = (voice.name ?? "").toLowerCase();
  if (UK_PHRASES.some((hint) => name.includes(hint))) return true;
  return UK_WORD.test(name);
}

function isNovelty(voice: { name?: string | null }) {
  const name = (voice.name ?? "").toLowerCase();
  return NOVELTY.some((hint) => name.includes(hint));
}

/**
 * Engines that read words rather than speak them.
 *
 * eSpeak, Festival and Flite are remarkable pieces of software and they sound
 * like a 1980s lift. A machine that has nothing else still has to be given
 * something, so they are refused here and the resolver falls through to the
 * engine's own default — which is at least a voice somebody chose.
 */
const POOR = ["espeak", "festival", "flite", "compact", "low quality", "very low"];

function isPoorEngine(voice: { name?: string | null }) {
  const name = (voice.name ?? "").toLowerCase();
  if (POOR.some((hint) => name.includes(hint))) return true;
  // eSpeak names its voices "English (America)+f3" — the variant suffix is the
  // giveaway, and it is the spelling that shows up on a bare Linux desktop.
  return /\+[fm]\d$/.test(name);
}

function soundsFemale(voice: { name?: string | null }) {
  const name = (voice.name ?? "").toLowerCase();
  return FEMALE_HINTS.some((hint) => name.includes(hint));
}

/**
 * The voices known to sound best, so a profile gets a good voice rather than
 * whichever name happens to sort first alphabetically.
 */
const BEST = [
  "samantha",
  "ava",
  "aria",
  "jenny",
  "michelle",
  "allison",
  "amelie",
  "amélie",
  "monica",
  "paulina",
  "luciana",
  "matilda",
  "veena",
  "google us english",
  "google australia",
  "microsoft",
];

/**
 * Roughly how pleasant a voice is likely to be. The cloud and "natural" voices
 * every modern browser and operating system ships score highest, and the
 * well-known good ones break the ties.
 */
function quality(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();
  let points = 0;
  if (BEST.some((hint) => name.includes(hint))) points += 14;
  // Apple's Siri voices are the best a Mac or an iPhone has, they cost nothing,
  // and they are named "Siri Voice 1" and nothing else — so they are worth more
  // than the human names a device happens to ship by default.
  if (name.startsWith("siri")) points += 70;
  if (name.includes("natural")) points += 60;
  if (name.includes("neural")) points += 55;
  if (name.includes("premium") || name.includes("enhanced")) points += 50;
  if (name.includes("online")) points += 45;
  if (name.includes("google")) points += 30;
  if (name.includes("siri")) points += 25;
  if (name.includes("microsoft")) points += 10;
  // Cloud voices cost a round trip but sound markedly better than the local ones.
  if (voice.localService === false) points += 8;
  if (voice.default) points += 2;
  return points;
}

function tag(voice: SpeechSynthesisVoice) {
  return (voice.lang ?? "").toLowerCase().replace("_", "-");
}

/**
 * The voices this list is allowed to use at all: no novelty voices, and nothing
 * from the British Isles. Everything below is chosen out of this pool.
 */
export function usableVoices(voices: SpeechSynthesisVoice[]) {
  return voices.filter(
    (voice) =>
      !isNovelty(voice) && !isPoorEngine(voice) && !isUkVoice(voice),
  );
}

/**
 * Best first, with the women of a pool lifted to the front.
 *
 * The rest stay on the list rather than being dropped. A voice the hints do not
 * recognise is still a voice — Karen is Australian and nobody's list says she
 * is a woman — and keeping her means the eight have somewhere else to stand in.
 */
function ranked(pool: SpeechSynthesisVoice[]) {
  const by = (one: SpeechSynthesisVoice, two: SpeechSynthesisVoice) =>
    quality(two) - quality(one) || one.name.localeCompare(two.name);

  const women = pool.filter(soundsFemale).sort(by);
  const rest = pool.filter((voice) => !soundsFemale(voice)).sort(by);
  return [...women, ...rest];
}

export type VoiceFit = "her own accent" | "standing in" | "nothing to offer";

export type ResolvedVoice = {
  /** Which of the eight this is. */
  profile: VoiceProfile;
  /** The real device voice behind her, or null when the device has none to give. */
  voice: SpeechSynthesisVoice | null;
  rate: number;
  pitch: number;
  volume: number;
  /** The four numbers this was resolved with, so a speaker can phrase with them. */
  delivery: VoiceDelivery;
  /** Whether the device really has her accent, is standing in, or has nothing. */
  fit: VoiceFit;
  /** One sentence saying which of those it is, ready to be shown. */
  note: string;
};

/**
 * Her register, before the warmth slider moves it — which is the voice's own.
 *
 * This was 0.95 for one afternoon and it was the wrong idea: on the engines
 * that resample rather than re-synthesise, taking five percent off the pitch of
 * a good recorded voice is exactly what makes it sound cheap. She is deep
 * because of the voice she was given, and the warmth slider is there for anyone
 * who wants her lower still.
 */
const PITCH_BASE = 1;

/** The list rotated so the nth profile starts at the nth voice. */
function slide<T>(list: T[], slot: number): T[] {
  if (list.length < 2) return list;
  const at = slot % list.length;
  return [...list.slice(at), ...list.slice(0, at)];
}

/**
 * Turn one profile into the voice this device will actually use for her.
 *
 * The order is the honest one. A voice whose language really is her accent is
 * taken first, and takes her exactly as she is: no nudge, no pretending. Failing
 * that, a voice *named* for her accent (some devices tag everything `en-US` and
 * leave the accent to the name). Failing that, the best voice the device has
 * that is not British or Irish goes in her place, slowed or quickened and
 * lowered or lifted by her own pace and tone — which is what keeps eight
 * profiles from collapsing into one. And if the device has nothing but British
 * voices, nothing is pretended at all: she gets the engine's own default and
 * the note says why.
 */
export function resolveVoice(
  profile: VoiceProfile,
  voices: SpeechSynthesisVoice[],
  delivery: VoiceDelivery = DEFAULT_DELIVERY,
): ResolvedVoice {
  const pool = usableVoices(voices);

  // Nothing that is not English is ever used to read English aloud while an
  // English voice exists. A German voice reading an American sentence is a far
  // worse outcome than an American voice standing in for a French accent, and
  // without this the best-scoring voice on the device could be one of the two.
  const english = pool.filter((voice) => tag(voice).startsWith("en"));
  const preferred = english.length ? english : pool;

  // An accent match is looked for across every voice the device has — a French
  // voice is the whole point of Colette, and it is a French voice whether or not
  // the device files it in English. The English-first rule above is about the
  // stand-in, not about her.
  const byLang = ranked(
    pool.filter((voice) => profile.langs.some((lang) => tag(voice).startsWith(lang))),
  );
  const byName = ranked(
    pool.filter((voice) => {
      const name = voice.name.toLowerCase();
      return profile.hints.some((hint) => name.includes(hint));
    }),
  );

  // Which of the eight this is, so that when the accent is missing each one
  // starts at a different voice instead of all eight landing on the same one.
  // Eight names that all sound like the same woman is worse than eight names
  // that are all standing in for their accents and each sound like somebody.
  const slot = Math.max(
    0,
    VOICE_PROFILES.findIndex((one) => one.id === profile.id),
  );
  const standIn = slide(ranked(preferred), slot);

  const native = byLang[0] ?? byName[0] ?? null;
  const voice = native ?? standIn[0] ?? null;

  const rate = between(delivery.speed * (native ? 1 : profile.pace), 0.4, 1.9);
  const pitch = between(
    PITCH_BASE + delivery.warmth + (native ? 0 : profile.tone),
    0.1,
    2,
  );
  const volume = between(delivery.volume, 0, 1);
  const rounded = {
    rate: Number(rate.toFixed(3)),
    pitch: Number(pitch.toFixed(3)),
    volume: Number(volume.toFixed(3)),
    delivery,
  };

  if (native) {
    return {
      profile,
      voice,
      ...rounded,
      fit: "her own accent",
      note: `${voice.name} on this device really is ${profile.accent.split(" — ")[0]} — no stand-in, no nudge.`,
    };
  }

  if (voice) {
    return {
      profile,
      voice,
      ...rounded,
      fit: "standing in",
      note: `This device has no ${profile.accent.split(" — ")[0]} voice, so ${voice.name} stands in — ${profile.pace < 1 ? "slower" : profile.pace > 1 ? "quicker" : "the same pace"}, ${profile.tone < 0 ? "lower" : profile.tone > 0 ? "a shade higher" : "the same pitch"}, so she is still nobody else on this list.`,
    };
  }

  return {
    profile,
    voice: null,
    ...rounded,
    fit: "nothing to offer",
    note: "Every voice this device offers sounds like the British Isles, and this list does not use those. She will speak in the engine's own default instead, until a device voice in her accent is added.",
  };
}

/** The device voice behind a resolved profile, for showing what you really got. */
export function describeVoice(resolved: ResolvedVoice): string | null {
  return resolved.voice?.name ?? null;
}

/* ------------------------------------------------------- saying it aloud -- */

export type Utterance = {
  text: string;
  rate: number;
  pitch: number;
  volume: number;
};

/**
 * Longest run of words she says on one note before the phrasing moves on.
 *
 * Sentences are the natural unit, but a long one is broken at a comma so that
 * the variation inside a sentence is heard rather than only between sentences,
 * and a fragment is joined to its neighbour so she never clips out "Right." as
 * its own breathless little utterance.
 *
 * 180 characters is not a style choice: Chromium cuts an utterance off after
 * roughly fifteen seconds, and short sentences joining into one utterance is
 * what keeps a reply inside it — which is also why it sounds better. Every
 * utterance is a fresh start for the engine's own prosody, so three sentences
 * read as three sentences sound like three recordings stitched together, while
 * three sentences read as one breath sound like somebody talking.
 */
const MIN_CHARS = 24;
const MAX_CHARS = 180;
const MAX_UTTERANCE = 180;

/** A gentle arc, so the movement sounds like speech and not like a siren. */
const PITCH_WAVE = [1, -0.55, 0.7, -0.3, 0.9, -0.45];
const RATE_WAVE = [1, -0.6, 0.5, -0.25];

/** Break a reply into the pieces she says in one breath. */
export function phrasesOf(text: string): string[] {
  const cleaned = text
    .replace(/\r/g, "")
    // A heading or a bullet is not a sentence: the marker goes, the words stay.
    .replace(/^[ \t]*(#{1,6}|[-*•]|\d+\.)[ \t]+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!cleaned) return [];

  const blocks = cleaned
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, " ").trim())
    .filter(Boolean);

  const pieces: string[] = [];

  for (const block of blocks) {
    // A sentence ender takes its spaces with it; nothing else does, so an
    // abbreviation stays in one piece rather than being cut in half.
    const sentences = block.match(/[^.!?…]+[.!?…]*/g) ?? [block];

    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;

      const previous = pieces[pieces.length - 1];
      // A fragment rides with the sentence beside it: the one before it when
      // there is one, so that a clipped "Right." opens the sentence it belongs
      // to rather than standing alone like a hiccup, and a short piece of a
      // long sentence is joined back onto it by the same rule read the other
      // way round.
      if (
        previous !== undefined &&
        (sentence.length < MIN_CHARS || previous.length < MIN_CHARS)
      ) {
        pieces[pieces.length - 1] = `${previous} ${sentence}`;
        continue;
      }
      pieces.push(sentence);
    }
  }

  // Very long sentences are cut at a comma, or a space, so no single utterance
  // runs into the engine's own ceiling for one.
  const cut: string[] = [];
  for (const piece of pieces) {
    let rest = piece;
    while (rest.length > MAX_CHARS) {
      const window = rest.slice(0, MAX_CHARS);
      const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
      const where = at > MAX_CHARS * 0.5 ? at + 1 : window.lastIndexOf(" ");
      if (where <= 0) break;
      cut.push(rest.slice(0, where).trim());
      rest = rest.slice(where).trim();
    }
    if (rest) cut.push(rest);
  }

  return cut;
}

/**
 * Consecutive sentences run together until one utterance is worth breathing at.
 *
 * This is the difference between a reply being read and a reply being recited.
 */
export function groupUnder(pieces: string[], maxChars = MAX_UTTERANCE): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + piece.length + 1 <= maxChars) {
      out[out.length - 1] = `${last} ${piece}`;
    } else {
      out.push(piece);
    }
  }
  return out;
}

/**
 * How she says a reply, sentence by sentence: the whole of the delivery in one
 * pure function, so what is spoken can be read and tested without a browser.
 *
 * `expressiveness` is the only thing that varies anything: at zero every piece
 * comes back on exactly the base note, and at one a question lifts, an
 * exclamation quickens, a trailing thought slows down, and the pieces within a
 * paragraph each sit a little differently. It never changes what is said — only
 * how it lands.
 */
export function planUtterances(
  text: string,
  base: { rate: number; pitch: number; volume: number },
  expressiveness: number,
): Utterance[] {
  const w = between(expressiveness, 0, 1);

  return groupUnder(phrasesOf(text)).map((piece, index) => {
    // The marks are read anywhere inside the piece rather than only at the end,
    // because a piece can be several sentences that were joined for one breath.
    // "That is marvellous! It can wait a moment" still has the marvellous in it,
    // and losing that would make the join audible as a flattening.
    const asking = /\?/.test(piece);
    const exclaiming = /!/.test(piece) && !asking;
    const trailing = /…/.test(piece);

    const pitchWave = PITCH_WAVE[index % PITCH_WAVE.length];
    const rateWave = RATE_WAVE[index % RATE_WAVE.length];

    const pitch =
      base.pitch +
      w * 0.07 * pitchWave +
      (asking ? w * 0.06 : exclaiming ? w * 0.03 : 0) +
      (trailing ? -w * 0.025 : 0);

    const rate =
      base.rate *
      (1 + w * 0.035 * rateWave) *
      (asking ? 1 - w * 0.02 : exclaiming ? 1 + w * 0.04 : 1) *
      (trailing ? 1 - w * 0.03 : 1);

    return {
      text: piece,
      rate: Number(between(rate, 0.3, 2).toFixed(3)),
      pitch: Number(between(pitch, 0.1, 2).toFixed(3)),
      volume: Number(between(base.volume, 0, 1).toFixed(3)),
    };
  });
}
