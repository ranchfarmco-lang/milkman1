/**
 * The eight voices, walked rather than read.
 *
 * The voice list is the one part of the hub whose promise is entirely about
 * people: that a name on the page is a person with an accent, that no voice
 * sounds British, and that when the machine cannot give her accent it says so
 * instead of quietly handing over whoever it had. All three can be wrong in ways
 * a typecheck cannot see — a hint that never matches, a language tag that
 * catches the wrong voices, a fallback that reaches for the one accent the list
 * exists to avoid.
 *
 * So this walks the real functions, imported from `src/lib/voices.ts`: the
 * resolutions against invented device lists, the UK refusals, the delivery
 * clamping, and the planner that decides how a reply is said. A few wiring
 * checks follow in the same spirit as `scripts/browser-check.ts`, because "the
 * server and the page agree on which voices exist" is exactly the property an
 * innocuous-looking edit can undo — and a roster that drifts apart is how a
 * person presses Use on a voice the server then refuses.
 *
 * Run with: bun scripts/voice-check.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_DELIVERY,
  DEFAULT_VOICE_ID,
  DELIVERY_LIMITS,
  VOICE_IDS,
  VOICE_PROFILES,
  deliveryFrom,
  describeVoice,
  isDefaultDelivery,
  isKnownVoiceId,
  isUkVoice,
  phrasesOf,
  planUtterances,
  profileById,
  resolveVoice,
  usableVoices,
  voiceLabel,
} from "../src/lib/voices";
import {
  STUDIO_INSTRUCTIONS,
  STUDIO_PROVIDERS,
  base64FromBytes,
  bytesFromBase64,
  isKnownStudioVoice,
  pickStudioProvider,
  splitStudioVoice,
  studioChunks,
  studioClip,
  studioRequestBody,
} from "../src/lib/voice-studio";

const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const read = (path: string) => readFile(join(ROOT, path), "utf8");

/** A device voice, with only the fields the resolver ever reads. */
function voice(
  name: string,
  lang: string,
  extra: Partial<SpeechSynthesisVoice> = {},
): SpeechSynthesisVoice {
  return {
    name,
    lang,
    localService: true,
    default: false,
    voiceURI: name,
    ...extra,
  } as SpeechSynthesisVoice;
}

/**
 * Long enough to need more than one utterance, short enough to read at a
 * glance. Two sentences of it are the sort a person speaks in one breath.
 */
const LONG_REPLY =
  "The clinic called while you were out. They have moved the appointment to Thursday, and the letter will not reach you in time. Take the nine o'clock slot if you can, because the ten is a vaccination clinic and the waiting room will be full.";

/* ------------------------------------------------------------- the roster -- */

check(
  "there are eight, and every one of them is a name somebody would answer to",
  VOICE_PROFILES.length === 8 &&
    VOICE_PROFILES.every(
      (profile) =>
        profile.name.length > 2 &&
        profile.accent.includes(" — ") &&
        profile.about.length > 20 &&
        profile.sample.length > 20,
    ),
  `${VOICE_PROFILES.map((profile) => profile.name).join(", ")}`,
);

check(
  "the ids are unique and the default is one of them",
  new Set(VOICE_IDS).size === VOICE_IDS.length &&
    isKnownVoiceId(DEFAULT_VOICE_ID),
);

check(
  "an unknown id is refused rather than resolved to the first",
  isKnownVoiceId("female-1") === false &&
    isKnownVoiceId("male-4") === false &&
    isKnownVoiceId("") === false &&
    isKnownVoiceId(null) === false &&
    isKnownVoiceId(" AVA ") === true,
  "the old female-1/male-4 names are not voices any more",
);

check(
  "every accent on the list is a different one",
  new Set(VOICE_PROFILES.map((profile) => profile.accent)).size === 8,
);

check(
  "no profile asks for a British accent, by language or by name",
  VOICE_PROFILES.every(
    (profile) =>
      !profile.langs.some((lang) => lang.startsWith("en-gb") || lang.startsWith("en-ie")) &&
      !profile.hints.some((hint) => isUkVoice({ name: hint, lang: "" })),
  ),
);

check(
  "the labels name the person and the accent, for anything writing a sentence",
  voiceLabel("colette") === "Colette — French — soft, rounded vowels" &&
    voiceLabel("nobody") === voiceLabel(DEFAULT_VOICE_ID),
);

/* --------------------------------------------------------- what is refused -- */

check(
  "a British voice is refused by its language tag",
  isUkVoice(voice("Some Voice", "en-GB")) &&
    isUkVoice(voice("Some Voice", "en_GB")) &&
    isUkVoice(voice("Some Voice", "en-IE")),
);

check(
  "a British voice is refused by its name even when tagged American",
  ["Daniel", "Kate", "Serena", "Fiona", "Moira", "Hazel", "Sonia", "Oliver", "Arthur"].every(
    (name) => isUkVoice(voice(`Microsoft ${name} Online (Natural)`, "en-US")),
  ),
);

check(
  "a name that merely contains a British one is not thrown out",
  !isUkVoice(voice("Alexandra", "en-US")) && !isUkVoice(voice("Samantha", "en-US")),
  "Alexandra holds Alex; she is American and stays",
);

check(
  "the novelty voices are refused too",
  usableVoices([
    voice("Bubbles", "en-US"),
    voice("Zarvox", "en-US"),
    voice("espeak", "en-US"),
    voice("Ava", "en-US"),
  ]).length === 1,
);

/* -------------------------------------------------- finding her on a device -- */

/** A plausible American machine: every voice on it, and none of them British. */
const AMERICAN_DEVICE = [
  voice("Samantha", "en-US"),
  voice("Google US English", "en-US", { localService: false }),
  voice("Microsoft Zira", "en-US"),
  voice("Karen", "en-AU"),
  voice("Amelie", "fr-FR"),
  voice("Alice", "it-IT"),
  voice("Monica", "es-ES"),
  voice("Luciana", "pt-BR"),
  voice("Veena", "en-IN"),
];

check(
  "an American profile gets a real American voice, and knows it",
  (() => {
    const one = resolveVoice(profileById("ava"), AMERICAN_DEVICE);
    return one.voice?.lang.startsWith("en-US") === true && one.fit === "her own accent";
  })(),
  "Samantha rather than a stand-in",
);

check(
  "every accent the device really has is found by its own language",
  (
    [
      ["colette", "fr"],
      ["giulia", "it"],
      ["valentina", "es"],
      ["isabela", "pt"],
      ["sasha", "en-AU"],
      ["priya", "en-IN"],
    ] as const
  ).every(([id, tag]) => {
    const one = resolveVoice(profileById(id), AMERICAN_DEVICE);
    return one.fit === "her own accent" && one.voice?.lang.startsWith(tag) === true;
  }),
);

check(
  "an accent the device does not have is said to be a stand-in",
  (() => {
    const one = resolveVoice(profileById("scarlett"), AMERICAN_DEVICE);
    return one.fit === "standing in" && one.note.includes("stands in");
  })(),
  "no operating system tags a Southern voice, so she never claims one",
);

check(
  "a stand-in is slowed or quickened and moved in pitch, so she is still herself",
  (() => {
    const scarlett = resolveVoice(profileById("scarlett"), AMERICAN_DEVICE);
    const ava = resolveVoice(profileById("ava"), AMERICAN_DEVICE);
    return scarlett.rate < ava.rate && scarlett.pitch < ava.pitch;
  })(),
  "Scarlett's drawl is slower and lower than Ava's own voice",
);

check(
  "a device with only British voices offers the truth, not a British voice",
  (() => {
    const one = resolveVoice(
      profileById("ava"),
      [voice("Daniel", "en-GB"), voice("Kate", "en-GB"), voice("Serena", "en-GB")],
    );
    return (
      one.voice === null &&
      one.fit === "nothing to offer" &&
      one.note.includes("British Isles")
    );
  })(),
  "and she still resolves to a rate and a pitch for the engine's own default",
);

check(
  "a voice that is not English never stands in while an English one exists",
  (() => {
    const one = resolveVoice(profileById("scarlett"), [
      voice("Google español", "es-ES", { localService: false }),
      voice("Microsoft Zira", "en-US"),
    ]);
    return describeVoice(one) === "Microsoft Zira" && one.fit === "standing in";
  })(),
  "a Spanish voice reading American English is the worst outcome there is",
);

check(
  "the eight do not all land on one voice",
  (() => {
    const device = [
      voice("Samantha", "en-US"),
      voice("Karen", "en-AU"),
      voice("Microsoft Zira", "en-US"),
    ];
    const names = ["scarlett", "colette", "giulia", "valentina"].map((id) =>
      describeVoice(resolveVoice(profileById(id), device)),
    );
    return new Set(names).size >= 3;
  })(),
  "eight names that sound like one woman is worse than eight stand-ins",
);

check(
  "engines that read words rather than speak them are refused",
  usableVoices([
    voice("eSpeak", "en-US"),
    voice("Festival", "en-US"),
    voice("flite", "en-US"),
    voice("English (America)+f3", "en-US"),
    voice("Microsoft Aria Online (Natural)", "en-US", { localService: false }),
  ]).length === 1,
  "a machine with nothing else falls through to the engine's own default",
);

check(
  "a British voice is never the stand-in when anything else exists",
  (() => {
    const one = resolveVoice(profileById("giulia"), [
      voice("Daniel", "en-GB"),
      voice("Moira", "en-IE"),
      voice("Zira", "en-US"),
    ]);
    return describeVoice(one) === "Zira" && one.fit === "standing in";
  })(),
);

check(
  "the women of a device are chosen ahead of the men",
  (() => {
    const one = resolveVoice(profileById("ava"), [
      voice("Microsoft David", "en-US"),
      voice("Microsoft Zira", "en-US"),
    ]);
    return describeVoice(one) === "Microsoft Zira";
  })(),
  "David is American and is not one of the eight",
);

check(
  "nothing named at all is not a crash",
  (() => {
    const one = resolveVoice(profileById("sasha"), []);
    return one.voice === null && one.fit === "nothing to offer" && one.rate > 0;
  })(),
  "a browser that has not answered yet still resolves",
);

/* -------------------------------------------------------------- delivery -- */

check(
  "the four numbers are clamped into the sliders' own ranges",
  (() => {
    const wild = deliveryFrom({ speed: 99, warmth: -99, volume: 4, expressiveness: -2 });
    return (
      wild.speed === DELIVERY_LIMITS.speed.max &&
      wild.warmth === DELIVERY_LIMITS.warmth.min &&
      wild.volume === DELIVERY_LIMITS.volume.max &&
      wild.expressiveness === DELIVERY_LIMITS.expressiveness.min
    );
  })(),
);

check(
  "nothing stored means her own defaults, whatever was stored",
  deliveryFrom(null).speed === DEFAULT_DELIVERY.speed &&
    deliveryFrom(undefined).volume === DEFAULT_DELIVERY.volume &&
    deliveryFrom({ speed: Number.NaN }).speed === DEFAULT_DELIVERY.speed &&
    isDefaultDelivery(deliveryFrom(null)),
);

check(
  "warmth moves her pitch, and speed moves her rate — on every one of the eight",
  VOICE_PROFILES.every((profile) => {
    const cool = resolveVoice(profile, AMERICAN_DEVICE, {
      ...DEFAULT_DELIVERY,
      warmth: -0.2,
      speed: 0.8,
    });
    const bright = resolveVoice(profile, AMERICAN_DEVICE, {
      ...DEFAULT_DELIVERY,
      warmth: 0.2,
      speed: 1.2,
    });
    return bright.pitch > cool.pitch && bright.rate > cool.rate;
  }),
);

check(
  "volume is hers alone, and silence is silence",
  resolveVoice(profileById("ava"), AMERICAN_DEVICE, {
    ...DEFAULT_DELIVERY,
    volume: 0.4,
  }).volume === 0.4,
);

/* ------------------------------------------------------- saying it out loud -- */

check(
  "a reply is broken where a person would breathe",
  (() => {
    const phrases = phrasesOf(
      "Right. Two things are true here, and only one of them matters today. Ask me again after lunch!",
    );
    return (
      phrases.length === 2 &&
      phrases[0] === "Right. Two things are true here, and only one of them matters today." &&
      phrases[1].endsWith("!")
    );
  })(),
  "a fragment rides with the sentence before it",
);

check(
  "a heading's marker goes and its words stay",
  phrasesOf("### The plan\n- Call the clinic").join(" ") === "The plan Call the clinic",
);

check(
  "a very long sentence is cut at a comma, not in the middle of a word",
  (() => {
    const long = `${"and then a great deal more of it, ".repeat(12)}and the end.`;
    const phrases = phrasesOf(long);
    return phrases.length > 1 && phrases.every((phrase) => phrase.length <= 221);
  })(),
);

check(
  "at zero expressiveness every line lands identically",
  (() => {
    const plan = planUtterances(LONG_REPLY, { rate: 0.98, pitch: 1, volume: 1 }, 0);
    return (
      plan.length >= 2 &&
      plan.every(
        (piece) => piece.rate === 0.98 && piece.pitch === 1 && piece.volume === 1,
      )
    );
  })(),
  "flat is a real setting, not a decoration",
);

check(
  "a few short sentences are read as one breath, not stitched together",
  (() => {
    const plan = planUtterances(
      "The clinic called. They moved it to Thursday. Ten past nine.",
      { rate: 0.98, pitch: 1, volume: 1 },
      0.45,
    );
    return plan.length === 1;
  })(),
  "every utterance is a fresh start for the engine's prosody, so fewer is better",
);

check(
  "a long reply still breathes, and every utterance stays under Chromium's cut-off",
  (() => {
    const plan = planUtterances(LONG_REPLY, { rate: 0.98, pitch: 1, volume: 1 }, 0.45);
    return plan.length >= 2 && plan.every((piece) => piece.text.length <= 181);
  })(),
  "about fifteen seconds of speech is the ceiling being respected",
);

check(
  "a question is lifted, a joke is quickened, and the words are the same words",
  (() => {
    const base = { rate: 0.97, pitch: 0.9, volume: 1 };

    const asking = "Is the door open? I could not tell from where I was standing.";
    const askingPlan = planUtterances(asking, base, 0.8);
    const askingWords = askingPlan
      .map((piece) => piece.text)
      .join(" ")
      .replace(/\s+/g, " ");

    const joking =
      "That is marvellous! It can wait a moment, but the door will need closing before the evening.";
    const jokingPlan = planUtterances(joking, base, 0.8);
    const jokingWords = jokingPlan
      .map((piece) => piece.text)
      .join(" ")
      .replace(/\s+/g, " ");

    return (
      askingPlan[0].pitch > base.pitch &&
      askingWords === asking &&
      jokingPlan[0].rate > base.rate &&
      jokingPlan[0].pitch > base.pitch &&
      jokingWords === joking
    );
  })(),
  "the sentences are the same sentences, said differently",
);

check(
  "the movement stays inside what an engine will accept",
  (() => {
    const plan = planUtterances(
      "Is it? It is! It might be… yes it certainly is, and here is a longer line to move around inside of.",
      { rate: 1.4, pitch: 1.6, volume: 1 },
      1,
    );
    return plan.every(
      (piece) =>
        piece.rate >= 0.3 &&
        piece.rate <= 2 &&
        piece.pitch >= 0.1 &&
        piece.pitch <= 2 &&
        piece.volume <= 1,
    );
  })(),
  "a shout in a fast voice cannot leave the range",
);

/* ----------------------------------------------------------- studio voice -- */

check(
  "every speech provider is a real endpoint with a real key name",
  STUDIO_PROVIDERS.every(
    (provider) =>
      provider.keyEnv.endsWith("_API_KEY") &&
      provider.baseUrl.startsWith("https://") &&
      provider.models.length > 0 &&
      provider.voices.length >= 2 &&
      provider.maxChars > 60 &&
      provider.docs.startsWith("https://") &&
      provider.note.length > 20,
  ),
  STUDIO_PROVIDERS.map((provider) => `${provider.label} (${provider.models[0]})`).join(", "),
);

check(
  "a request carries the model, the words, the voice and the format",
  (() => {
    const provider = STUDIO_PROVIDERS[0];
    const body = studioRequestBody(provider, "Hello there.", provider.voices[0].id);
    return (
      body.model === provider.models[0] &&
      body.input === "Hello there." &&
      body.voice === provider.voices[0].id &&
      body.response_format === provider.format
    );
  })(),
);

check(
  "the delivery instruction goes only to a model that honours one",
  STUDIO_PROVIDERS.every((provider) => {
    const body = studioRequestBody(provider, "Hello.", provider.voices[0].id) as {
      instructions?: string;
    };
    return provider.instructions
      ? body.instructions === STUDIO_INSTRUCTIONS
      : body.instructions === undefined;
  }),
  "claiming it steers a model that ignores it would be a setting that does nothing",
);

check(
  "the persona names the voice the whole feature exists for",
  STUDIO_INSTRUCTIONS.includes("low-mid") &&
    STUDIO_INSTRUCTIONS.includes("smoky") &&
    STUDIO_INSTRUCTIONS.includes("never shrill") &&
    STUDIO_INSTRUCTIONS.length > 400,
);

check(
  "nothing longer than a provider accepts is ever sent",
  STUDIO_PROVIDERS.every((provider) => {
    const long = "word ".repeat(400);
    const body = studioRequestBody(provider, long, provider.voices[0].id) as {
      input: string;
    };
    return body.input.length <= provider.maxChars;
  }),
  "Groq's English voice caps a request at 200 characters",
);

check(
  "a long reply is cut into pieces that provider will take, words intact",
  (() => {
    const groq = STUDIO_PROVIDERS.find((provider) => provider.id === "groq")!;
    const chunks = studioChunks(LONG_REPLY, groq.maxChars);
    const words = chunks.join(" ").replace(/\s+/g, " ");
    return (
      chunks.length >= 2 &&
      chunks.every((chunk) => chunk.length <= groq.maxChars) &&
      words === LONG_REPLY.replace(/\s+/g, " ")
    );
  })(),
  "three calls to Groq are three breaths, not three half-sentences",
);

check(
  "a studio choice is a provider and a voice that both exist",
  isKnownStudioVoice("openrouter:sage") &&
    isKnownStudioVoice("groq:hannah") &&
    !isKnownStudioVoice("openrouter:nope") &&
    !isKnownStudioVoice("nope:sage") &&
    !isKnownStudioVoice("sage") &&
    !isKnownStudioVoice("") &&
    !isKnownStudioVoice(null),
);

check(
  "an unknown voice falls back to the provider's own first rather than nowhere",
  splitStudioVoice("groq:nobody").voiceId === STUDIO_PROVIDERS[1].voices[0].id &&
    splitStudioVoice("openrouter:sage").providerId === "openrouter",
);

check(
  "the provider used is the chosen one when it is keyed, else the best keyed one",
  pickStudioProvider("groq", ["openrouter", "groq"])?.id === "groq" &&
    pickStudioProvider("groq", ["openrouter"])?.id === "openrouter" &&
    pickStudioProvider("openrouter", []) === null,
);

check(
  "audio survives the trip as base64, byte for byte",
  (() => {
    const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff, 0x48, 0x69]);
    const encoded = base64FromBytes(bytes);
    const decoded = bytesFromBase64(encoded);
    return (
      encoded === "AAF/gP9IaQ==" &&
      decoded.length === bytes.length &&
      decoded.every((byte, index) => byte === bytes[index])
    );
  })(),
  "an encoder that drops a byte is an audio file that will not play",
);

check(
  "a provider that sends no content type still produces something playable",
  studioClip(new Uint8Array([1, 2, 3]), null).mimeType === "audio/mpeg" &&
    studioClip(new Uint8Array([1, 2, 3]), "audio/wav").mimeType === "audio/wav" &&
    studioClip(new Uint8Array([1, 2, 3]), "").bytes === 3,
);

/* ---------------------------------------------------------------- wiring -- */

const server = await read("src/convex/voice.ts");
const prompts = await read("src/convex/ai_prompts.ts");
const turn = await read("src/convex/ai_turn.ts");
const hook = await read("src/hooks/use-voice.ts");
const speech = await read("src/hooks/use-speech.ts");
const room = await read("src/pages/ControlRoom.tsx");
const schema = await read("src/convex/schema.ts");
const speechServer = await read("src/convex/speech.ts");
const speaker = await read("src/hooks/use-speech.ts");
const settings = await read("src/lib/device-settings.ts");
const studioHook = await read("src/hooks/use-studio-voice.ts");

check(
  "the server checks a voice against this roster rather than a copy of it",
  server.includes('from "../lib/voices"') &&
    server.includes("isKnownVoiceId") &&
    !/female-[1-4]|male-[1-4]/.test(server),
  "one list, so the page and the server cannot disagree",
);

check(
  "the AI is still allowed to change its own voice, and knows the new names",
  turn.includes("internal.voice.setForUser") &&
    prompts.includes('"type":"set_voice","voice":"ava"') &&
    VOICE_PROFILES.every((profile) => prompts.includes(profile.id)),
);

check(
  "the choice and the four numbers are both stored, and read back",
  schema.includes("voiceDelivery") &&
    server.includes("setDelivery") &&
    server.includes("resetDelivery") &&
    hook.includes("saveDelivery") &&
    hook.includes("clearDelivery"),
);

check(
  "what is spoken goes through the planner, per sentence",
  speech.includes("planUtterances(") &&
    speech.includes("utterance.volume = piece.volume") &&
    speech.includes("utterance.pitch = piece.pitch"),
);

check(
  "the Control Room draws the roster itself rather than a copy of it",
  room.includes("voiceProfiles.map(") &&
    room.includes("{profile.name}") &&
    room.includes("{profile.accent}") &&
    room.includes("{one.note}") &&
    room.includes("resolveVoiceById("),
  "so a name cannot be right on the page and wrong in the roster",
);

check(
  "the Control Room offers all eight, both buttons, and the four sliders",
  room.includes("previewVoice(") &&
    room.includes("chooseVoice(") &&
    room.includes("VOICE_SLIDERS") &&
    room.includes("setVoiceDelivery(") &&
    room.includes("resetVoiceDelivery()") &&
    room.includes("DELIVERY_LIMITS["),
);

check(
  "the studio voice goes through the shared catalog and the shared guard",
  speechServer.includes('from "../lib/voice-studio"') &&
    speechServer.includes("studioRequestBody(") &&
    speechServer.includes("internal.access.unlocked") &&
    !speechServer.includes("console.log") &&
    !speechServer.includes("ctx.db.insert") &&
    // The key is read by name from the deployment and never sent anywhere
    // except to the provider it belongs to.
    speechServer.includes("process.env[provider.keyEnv]"),
  "a key that is read and used, never stored, never returned and never logged",
);

check(
  "a reply is spoken by the studio voice when it can be, and never dropped when it cannot",
  speaker.includes("if (speaker?.ready)") &&
    speaker.includes("speakDeviceRef.current(left)") &&
    speaker.includes("speaker.chunks(text)") &&
    speaker.includes("createClipPlayer()"),
  "the device engine takes over mid-reply rather than the answer going silent",
);

check(
  "the page offers the studio voice, the test, and both providers' voices",
  room.includes("useStudioVoice()") &&
    room.includes("studio.test()") &&
    room.includes("studio.chooseVoice(") &&
    room.includes("studio.providers.map(") &&
    room.includes("studio.setSwitchedOn(") &&
    studioHook.includes("STUDIO_SAMPLE") &&
    // The test button has to play what it fetched, or it is a button that
    // proves nothing while looking like it proved something.
    studioHook.includes("player.current?.play(clip.audio"),
);

check(
  "the switch is a real setting, so Reset and the settings list own it",
  settings.includes("voice_studio") &&
    studioHook.includes("STUDIO_SETTING") &&
    studioHook.includes("api.speech.say") &&
    studioHook.includes("api.speech.status"),
);

check(
  "the page says nothing that sounds like a light it does not have",
  !/fake|placeholder|simulat/i.test(room.slice(room.indexOf("id=\"section-voice\""))),
  "no mock status text in the voice section",
);

console.log(
  failures === 0
    ? "\nEvery voice check passed."
    : `\n${failures} voice check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
