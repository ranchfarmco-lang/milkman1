/**
 * Eight voices for the AI — four female, four male.
 *
 * The voices themselves come from the device. Every browser ships its own
 * speech engine, and those are the only voices available without sending your
 * words off to a paid service, so each profile takes the best voice the device
 * actually has: Female 1 takes the best female voice, Female 2 the next best,
 * and so on.
 *
 * Nothing is faked. Where a device has fewer than four voices of a gender, the
 * extra profiles borrow one and are nudged a little, so they still sound like
 * different people rather than breaking.
 */

export type VoiceGender = "female" | "male";

export type VoiceProfile = {
  id: string;
  label: string;
  gender: VoiceGender;
  /** Which female (or male) voice to take, best first. */
  slot: number;
};

export const VOICE_PROFILES: VoiceProfile[] = [
  { id: "female-1", label: "Female 1", gender: "female", slot: 0 },
  { id: "female-2", label: "Female 2", gender: "female", slot: 1 },
  { id: "female-3", label: "Female 3", gender: "female", slot: 2 },
  { id: "female-4", label: "Female 4", gender: "female", slot: 3 },
  { id: "male-1", label: "Male 1", gender: "male", slot: 0 },
  { id: "male-2", label: "Male 2", gender: "male", slot: 1 },
  { id: "male-3", label: "Male 3", gender: "male", slot: 2 },
  { id: "male-4", label: "Male 4", gender: "male", slot: 3 },
];

export const DEFAULT_VOICE_ID = "female-1";

export function profileById(id: string | null | undefined): VoiceProfile {
  return (
    VOICE_PROFILES.find((profile) => profile.id === id) ?? VOICE_PROFILES[0]
  );
}

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
  "kathy",
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

/** Names that read as a female voice, most specific first. */
const FEMALE_HINTS = [
  "alexandra",
  "samantha",
  "karen",
  "moira",
  "tessa",
  "fiona",
  "serena",
  "victoria",
  "allison",
  "susan",
  "zoe",
  "niki",
  "nicky",
  "kate",
  "veena",
  "alice",
  "amelie",
  "anna",
  "zira",
  "hazel",
  "aria",
  "jenny",
  "michelle",
  "monica",
  "catherine",
  "emma",
  "olivia",
  "joanna",
  "salli",
  "kimberly",
  "kendra",
  "rupali",
  "mia",
  "yuna",
  "kyoko",
  "ting-ting",
  "sin-ji",
  "mei-jia",
  "linh",
  "ellen",
  "nora",
  "paulina",
  "selena",
  "clara",
  "sonia",
  "libby",
  "natasha",
  "martha",
  "rosie",
  "maisie",
  "ava",
  "shelley",
  "sandy",
  "female",
  "woman",
  "girl",
  "google us english",
  "google uk english female",
];

/** Names that read as a male voice. */
const MALE_HINTS = [
  "daniel",
  "aaron",
  "arthur",
  "alex",
  "fred",
  "oliver",
  "rishi",
  "thomas",
  "george",
  "gordon",
  "david",
  "mark",
  "guy",
  "ryan",
  "eric",
  "andrew",
  "brian",
  "christopher",
  "matthew",
  "joey",
  "justin",
  "liam",
  "lee",
  "reed",
  "diego",
  "jorge",
  "juan",
  "james",
  "john",
  "nathan",
  "nolan",
  "roger",
  "steffan",
  "jacques",
  "yannick",
  "xander",
  "evan",
  "logan",
  "tom",
  "male",
  "man",
  "boy",
  "google uk english male",
];

function classify(name: string): VoiceGender | null {
  const lower = name.toLowerCase();
  if (NOVELTY.some((hint) => lower.includes(hint))) return null;
  if (FEMALE_HINTS.some((hint) => lower.includes(hint))) return "female";
  if (MALE_HINTS.some((hint) => lower.includes(hint))) return "male";
  return null;
}

/**
 * The voices known to sound best, so the first slots get the good ones rather
 * than whichever name happens to sort first alphabetically.
 */
const BEST = [
  "samantha",
  "aria",
  "jenny",
  "michelle",
  "ava",
  "sonia",
  "google us english",
  "google uk english female",
  "alex",
  "guy",
  "ryan",
  "christopher",
  "eric",
  "daniel",
  "google uk english male",
];

const GOOD = [
  "karen",
  "moira",
  "tessa",
  "serena",
  "fiona",
  "zira",
  "hazel",
  "david",
  "mark",
  "oliver",
  "steffan",
  "rishi",
  "fred",
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
  else if (GOOD.some((hint) => name.includes(hint))) points += 6;
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

function ranked(
  voices: SpeechSynthesisVoice[],
  gender: VoiceGender,
): SpeechSynthesisVoice[] {
  const english = voices.filter((voice) =>
    voice.lang?.toLowerCase().startsWith("en"),
  );
  const pool = english.length ? english : voices;

  return pool
    .filter((voice) => classify(voice.name) === gender)
    .sort((a, b) => quality(b) - quality(a) || a.name.localeCompare(b.name));
}

export type ResolvedVoice = {
  voice: SpeechSynthesisVoice | null;
  rate: number;
  pitch: number;
};

/**
 * Turn a chosen profile into a real voice on this device, plus the small
 * rate/pitch nudge used only when a device is too thin to give each profile its
 * own voice.
 */
export function resolveVoice(
  profile: VoiceProfile,
  voices: SpeechSynthesisVoice[],
): ResolvedVoice {
  const mine = ranked(voices, profile.gender);
  const theirs = ranked(
    voices,
    profile.gender === "female" ? "male" : "female",
  );

  const voice = mine.length
    ? mine[profile.slot % mine.length]
    : (theirs[profile.slot % Math.max(1, theirs.length)] ?? voices[0] ?? null);

  // Nothing to nudge when this profile got a voice of its own.
  const reuse = mine.length ? Math.floor(profile.slot / mine.length) : 1;
  if (reuse === 0) return { voice, rate: 1.03, pitch: 1 };

  // Sharing a voice, so give every one of the eight its own pitch and pace —
  // close enough to sound like the same person, far enough apart to tell apart.
  const index = VOICE_PROFILES.findIndex((one) => one.id === profile.id);
  return {
    voice,
    rate: index % 2 === 0 ? 1.06 : 0.94,
    pitch: Number((0.9 + index * 0.035).toFixed(3)),
  };
}

/** The device voice behind a profile, for showing what you actually got. */
export function describeVoice(resolved: ResolvedVoice): string | null {
  return resolved.voice?.name ?? null;
}
