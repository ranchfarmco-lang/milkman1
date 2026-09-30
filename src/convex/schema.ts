import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

/** The three boxes that hold a conversation. `family` is a roster, not a room. */
export const roomValidator = v.union(
  v.literal("assistant"),
  v.literal("builder"),
  v.literal("messenger"),
);
export type Room = Infer<typeof roomValidator>;

/**
 * The five things the calendar can hold. Each one is a layer that can be
 * switched off without deleting anything: what a person brought in, what they
 * are working, what is for dinner, what they need a hand with, and everything
 * the AI Assistant and the [LIVE] board put there themselves.
 */
export const calendarLayerValidator = v.union(
  v.literal("personal"),
  v.literal("community"),
  v.literal("meals"),
  v.literal("bulletin"),
  v.literal("assistant"),
);
export type CalendarLayer = Infer<typeof calendarLayerValidator>;

/**
 * What a calendar entry actually is. A long list on purpose: the kind is what
 * the card, the layer and the auto-written title all key off, and a family
 * would rather pick "Horse care" than type it into a generic entry.
 *
 * The order here is the order the page offers them in.
 */
export const CALENDAR_KIND_VALUES = [
  // health
  "appointment",
  "medical",
  "dentist",
  "therapy",
  "medication",
  "veterinary",
  // work and school
  "work",
  "shift",
  "meeting",
  "training",
  "volunteering",
  "school",
  "school_event",
  "parent_teacher",
  "class",
  "exam",
  // kids and family
  "kids_activity",
  "sports",
  "practice",
  "game",
  "lesson",
  "playdate",
  "sleepover",
  "camp",
  "family_time",
  "date_night",
  "adult_time",
  "birthday",
  "party",
  "holiday",
  // meals
  "meal",
  "meal_prep",
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "baking",
  "potluck",
  // the house
  "chores",
  "cleaning",
  "laundry",
  "repairs",
  "maintenance",
  "yard_work",
  "garden",
  // animals
  "livestock",
  "horse_care",
  "pet_care",
  "feeding",
  // travel and errands
  "travel",
  "flight",
  "road_trip",
  "camping",
  "vacation",
  "errand",
  "shopping",
  "grocery",
  // getting things and people from place to place
  "delivery",
  "pickup",
  "dropoff",
  "fuel",
  // requests for a hand
  "ride",
  "childcare",
  "hauling",
  "help",
  "moving",
  "babysitting",
  // faith and community
  "church",
  "worship",
  "community_event",
  // money
  "bill",
  "payday",
  "budget",
  "expense",
  // everything else
  "other",
  "quiet_time",
  "rest",
] as const;

export type CalendarKind = (typeof CALENDAR_KIND_VALUES)[number];

/**
 * Written out rather than built from the list above, so the validator is a
 * literal union TypeScript can read off directly.
 */
export const calendarKindValidator = v.union(
  v.literal("appointment"),
  v.literal("medical"),
  v.literal("dentist"),
  v.literal("therapy"),
  v.literal("medication"),
  v.literal("veterinary"),
  v.literal("work"),
  v.literal("shift"),
  v.literal("meeting"),
  v.literal("training"),
  v.literal("volunteering"),
  v.literal("school"),
  v.literal("school_event"),
  v.literal("parent_teacher"),
  v.literal("class"),
  v.literal("exam"),
  v.literal("kids_activity"),
  v.literal("sports"),
  v.literal("practice"),
  v.literal("game"),
  v.literal("lesson"),
  v.literal("playdate"),
  v.literal("sleepover"),
  v.literal("camp"),
  v.literal("family_time"),
  v.literal("date_night"),
  v.literal("adult_time"),
  v.literal("birthday"),
  v.literal("party"),
  v.literal("holiday"),
  v.literal("meal"),
  v.literal("meal_prep"),
  v.literal("breakfast"),
  v.literal("lunch"),
  v.literal("dinner"),
  v.literal("snack"),
  v.literal("baking"),
  v.literal("potluck"),
  v.literal("chores"),
  v.literal("cleaning"),
  v.literal("laundry"),
  v.literal("repairs"),
  v.literal("maintenance"),
  v.literal("yard_work"),
  v.literal("garden"),
  v.literal("livestock"),
  v.literal("horse_care"),
  v.literal("pet_care"),
  v.literal("feeding"),
  v.literal("travel"),
  v.literal("flight"),
  v.literal("road_trip"),
  v.literal("camping"),
  v.literal("vacation"),
  v.literal("errand"),
  v.literal("shopping"),
  v.literal("grocery"),
  v.literal("delivery"),
  v.literal("pickup"),
  v.literal("dropoff"),
  v.literal("fuel"),
  v.literal("ride"),
  v.literal("childcare"),
  v.literal("hauling"),
  v.literal("help"),
  v.literal("moving"),
  v.literal("babysitting"),
  v.literal("church"),
  v.literal("worship"),
  v.literal("community_event"),
  v.literal("bill"),
  v.literal("payday"),
  v.literal("budget"),
  v.literal("expense"),
  v.literal("other"),
  v.literal("quiet_time"),
  v.literal("rest"),
);

/**
 * Who an entry is for. Three tiers, and they are enforced on every read rather
 * than only hidden on screen: `private` is its owner's alone, `group` is the
 * people named on it and nobody else, and `family` is the whole household.
 */
export const calendarAudienceValidator = v.union(
  v.literal("private"),
  v.literal("group"),
  v.literal("family"),
);
export type CalendarAudience = Infer<typeof calendarAudienceValidator>;

/**
 * How much an entry wants to be noticed. Left alone it is `normal`, which is
 * the quiet case and what every row written before this existed reads as.
 */
export const calendarPriorityValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("urgent"),
);
export type CalendarPriority = Infer<typeof calendarPriorityValidator>;

/** Where the money on an entry stands. */
export const calendarCostStatusValidator = v.union(
  v.literal("unpaid"),
  v.literal("paid"),
  v.literal("reimbursement"),
);
export type CalendarCostStatus = Infer<typeof calendarCostStatusValidator>;

/** Who wrote a message: the person typing, the model, or another family member. */
export const messageRoleValidator = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("member"),
);
export type MessageRole = Infer<typeof messageRoleValidator>;

/**
 * One line in the thinking pane beside an AI box.
 *
 * The kinds are the shapes a person watches for, not the tools behind them:
 *
 * * `reasoning` — the model's own raw reasoning, when the model offers one.
 *   Only some do (DeepSeek's reasoner, xAI's reasoning models, Gemini's thought
 *   parts), so this is the bonus rather than the mechanism.
 * * `think` — what the agent wrote with its `think` tool: the plan and the
 *   deliberation. This is the one that is always there, on every model.
 * * `tool` — something it used, and what came back.
 * * `step` — the frame around the work: which system answered, a self-check.
 * * `answer` — the reply as it is being written.
 * * `error` — a turn that failed, said plainly.
 */
export const traceStepKindValidator = v.union(
  v.literal("reasoning"),
  v.literal("think"),
  v.literal("tool"),
  v.literal("step"),
  v.literal("answer"),
  v.literal("error"),
);
export type TraceStepKind = Infer<typeof traceStepKindValidator>;

export const traceStatusValidator = v.union(
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
);

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
      // the family this person belongs to. nobody outside it can read the
      // messenger or see them in the family box.
      familyId: v.optional(v.id("families")),
      // which of the eight voices the AI speaks with for this person
      voice: v.optional(v.string()),
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // a family is the unit that can talk to each other
    families: defineTable({
      // the invite code, the only way in
      code: v.string(),
      createdBy: v.id("users"),
      createdAt: v.number(),
      // the family's standing video room, so a second person joining at the
      // same instant as the first lands in the same room instead of opening a
      // second one. Reading and writing this row is what serialises the join.
      roomCallId: v.optional(v.id("calls")),
    }).index("by_code", ["code"]),

    // every message in every box
    messages: defineTable({
      room: roomValidator,
      role: messageRoleValidator,
      text: v.string(),
      // set on everything that belongs to a family, so the messenger can be
      // scoped to it
      familyId: v.optional(v.id("families")),
      // short plain-english summary of what the assistant actually did
      note: v.optional(v.string()),
      // What the turn was thinking on its way to this reply: its reasoning, its
      // plan, and every step it took, in the order it took them. It rides with
      // the reply rather than living in a pane of its own, so the working stays
      // under the answer it produced — which is where somebody looks for it a
      // week later, and what lets the whole thing survive the trace being
      // pruned. The reply itself is not in here; it is the message.
      feed: v.optional(
        v.object({
          /** Which system and model wrote it, when one answered. */
          by: v.optional(v.string()),
          /** How long the turn took, in milliseconds. */
          ms: v.number(),
          steps: v.array(
            v.object({
              kind: traceStepKindValidator,
              text: v.string(),
              at: v.number(),
            }),
          ),
        }),
      ),
      // the person the thread belongs to (the author, or the person an AI reply is for)
      ownerId: v.id("users"),
      // who actually wrote it, for the family messenger
      authorId: v.optional(v.id("users")),
      authorName: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_room", ["room", "createdAt"])
      .index("by_room_owner", ["room", "ownerId", "createdAt"])
      .index("by_family", ["familyId", "createdAt"])
      // so renaming yourself can carry the new name onto what you already sent
      .index("by_author", ["authorId", "createdAt"]),

    // One turn of an AI box, written as it happens.
    //
    // A turn is a long thing: the model is asked, tools run, it thinks again,
    // sometimes for a minute or more. The chat only ever learns the finished
    // reply, so without this there is nothing to show while the work is going
    // on, and the reasoning the agent writes with its `think` tool has nowhere
    // to live. This is the pane's whole source: the row is created before the
    // first model call and appended to as the turn proceeds, so the panel is a
    // reactive read of work in progress rather than a spinner.
    //
    // It is kept once the turn ends — the thinking stays readable next to the
    // thing it produced — and only the newest few turns per box are retained,
    // because the pane shows the live turn rather than a history of them.
    aiTraces: defineTable({
      room: roomValidator,
      // the person the thread belongs to, exactly as on their messages
      ownerId: v.id("users"),
      status: traceStatusValidator,
      // which system and model actually answered, once one has
      by: v.optional(v.string()),
      error: v.optional(v.string()),
      startedAt: v.number(),
      updatedAt: v.number(),
      steps: v.array(
        v.object({
          kind: traceStepKindValidator,
          text: v.string(),
          at: v.number(),
        }),
      ),
    }).index("by_room_owner", ["room", "ownerId", "startedAt"]),

    /**
     * The work nobody asked for.
     *
     * `aiTraces` above is one turn of one box, and the next turn begins a new
     * one. This is the other half of having an AI behind the hub: the assistant
     * deciding to speak up on its own, the [LIVE] board going out to every feed
     * on its timer, the morning job putting the board on the calendar. None of
     * that is triggered by a person, and none of it would otherwise leave a
     * mark — so there was no way to tell what the hub had done since you last
     * looked, or whether it had done anything at all.
     *
     * A separate table, deliberately, rather than more rows in `aiTraces`: a
     * turn's trace belongs to the reply it produced and is pruned with it,
     * whereas this is the hub's own background work and outlives any box.
     */
    aiBehind: defineTable({
      /** When it started. The feed reads newest first. */
      at: v.number(),
      /** Which job this was: nudge, board, calendar. */
      source: v.string(),
      /** One line a person can read without knowing anything about the system. */
      label: v.string(),
      /** What it found or decided — the closest thing to its thinking. */
      detail: v.optional(v.string()),
      status: v.union(
        v.literal("running"),
        v.literal("done"),
        v.literal("failed"),
      ),
      endedAt: v.optional(v.number()),
      /** Set when the work belonged to one person, as a nudge does. */
      ownerId: v.optional(v.id("users")),
    }).index("by_at", ["at"]),

    // a phone or video call between family members. The media never comes
    // near this table — only the handshake that lets two devices find each
    // other does.
    calls: defineTable({
      familyId: v.id("families"),
      kind: v.union(v.literal("audio"), v.literal("video")),
      startedBy: v.id("users"),
      state: v.union(
        v.literal("ringing"),
        v.literal("active"),
        v.literal("ended"),
      ),
      /**
       * A standing room rather than a call. Nobody is rung and nobody is
       * invited — everyone joins the same open room and waits for the rest.
       */
      room: v.optional(v.boolean()),
      createdAt: v.number(),
      endedAt: v.optional(v.number()),
    })
      .index("by_family", ["familyId", "createdAt"])
      .index("by_state", ["state", "createdAt"]),

    // who is in a call, and how far they have got
    callMembers: defineTable({
      callId: v.id("calls"),
      userId: v.id("users"),
      state: v.union(
        v.literal("ringing"),
        v.literal("joined"),
        v.literal("declined"),
        v.literal("left"),
      ),
      at: v.number(),
    })
      .index("by_call", ["callId"])
      .index("by_user", ["userId"]),

    // the handshake in transit: offers, answers and network candidates
    callSignals: defineTable({
      callId: v.id("calls"),
      fromId: v.id("users"),
      toId: v.id("users"),
      kind: v.union(
        v.literal("offer"),
        v.literal("answer"),
        v.literal("ice"),
      ),
      payload: v.string(),
      createdAt: v.number(),
    }).index("by_call_to", ["callId", "toId", "createdAt"]),

    // a file someone attached to a box. The bytes live in Convex storage; this
    // row is the label on them, so a box can list, open and remove its own.
    attachments: defineTable({
      room: roomValidator,
      // who put it there, for the private AI boxes
      ownerId: v.id("users"),
      // set on anything attached to the shared family room
      familyId: v.optional(v.id("families")),
      storageId: v.id("_storage"),
      name: v.string(),
      contentType: v.string(),
      size: v.number(),
      createdAt: v.number(),
    })
      .index("by_room_owner", ["room", "ownerId", "createdAt"])
      .index("by_family", ["familyId", "createdAt"])
      // a file shared into another box is a second row over the same bytes, so
      // this is how the bytes are known to be unreferenced before being deleted
      .index("by_storage", ["storageId"]),

    // who has typed the family password on this account. The password itself
    // lives in the deployment's environment, never in here and never in the
    // browser — this row is only the record that it was answered correctly.
    access: defineTable({
      userId: v.id("users"),
      unlockedAt: v.optional(v.number()),
      // wrong guesses since the last right one, for the cooldown below
      attempts: v.number(),
      blockedUntil: v.optional(v.number()),
    }).index("by_user", ["userId"]),

    // a heartbeat per signed-in family member, so the family box can show who is online
    presence: defineTable({
      userId: v.id("users"),
      lastSeenAt: v.number(),
    }).index("by_user", ["userId"]),

    // the Control Room switches, stored per person
    settings: defineTable({
      userId: v.id("users"),
      values: v.record(v.string(), v.boolean()),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    // what the assistant has been told to remember about you
    memories: defineTable({
      userId: v.id("users"),
      text: v.string(),
      createdAt: v.number(),
    }).index("by_user", ["userId", "createdAt"]),

    // timers and reminders, so they survive a reload and fire on any device
    reminders: defineTable({
      userId: v.id("users"),
      text: v.string(),
      kind: v.union(v.literal("timer"), v.literal("reminder")),
      dueAt: v.number(),
      done: v.boolean(),
      createdAt: v.number(),
    }).index("by_user", ["userId", "dueAt"]),

    // the AI Builder's own workbench: real files it wrote, kept between turns
    // so it can build a project up instead of retyping it every time. Nothing
    // here touches this app's own source — that is what self_source.ts is for.
    files: defineTable({
      ownerId: v.id("users"),
      path: v.string(),
      content: v.string(),
      language: v.optional(v.string()),
      updatedAt: v.number(),
    })
      .index("by_owner", ["ownerId", "path"])
      .index("by_owner_time", ["ownerId", "updatedAt"]),

    // one calendar entry: an appointment, a shift, a dinner, or a request for
    // help. Times are stored as instants, never as wall-clock strings, so the
    // same row reads correctly in whichever timezone the page is switched to.
    calendarEvents: defineTable({
      ownerId: v.id("users"),
      // the name to show on the card, captured when it was written, so a card
      // still reads properly after somebody renames themselves
      ownerName: v.string(),
      // set when the entry is shared with the family. Imports are personal and
      // leave this empty, which is what keeps a work feed off everyone's page.
      familyId: v.optional(v.id("families")),
      shared: v.boolean(),
      // who the entry is for, and — for a group one — the people it is for.
      // Rows written before this existed have neither, and read as `family`,
      // which is what their `shared` flag always meant.
      audience: v.optional(calendarAudienceValidator),
      attendees: v.optional(v.array(v.id("users"))),
      attendeeNames: v.optional(v.array(v.string())),
      layer: calendarLayerValidator,
      kind: calendarKindValidator,
      title: v.string(),
      startsAt: v.number(),
      endsAt: v.number(),
      allDay: v.boolean(),
      // the zone the person was thinking in when they wrote it
      timeZone: v.string(),
      location: v.optional(v.string()),
      notes: v.optional(v.string()),
      // a meal card can carry the link to the recipe, and the ingredient list
      // the shopping generator reads
      recipeUrl: v.optional(v.string()),
      ingredients: v.optional(v.array(v.string())),
      // the two halves of a transport request: "a ride to X for Y"
      place: v.optional(v.string()),
      appointmentType: v.optional(v.string()),
      // how much the entry wants to be noticed, if it said anything at all
      priority: v.optional(calendarPriorityValidator),
      // the money side: what it cost, whether it is settled, and who paid
      cost: v.optional(v.number()),
      costStatus: v.optional(calendarCostStatusValidator),
      paidBy: v.optional(v.string()),
      // a booking portal, a video call, or the recipe a meal came from
      link: v.optional(v.string()),
      // a single emoji to sit beside the title, if the family wants one
      emoji: v.optional(v.string()),
      // how long before it starts the alarm rings; 0 rings at the start, and
      // absent means there is no alarm at all
      alarmMinutes: v.optional(v.number()),
      // the reminder this entry set, so changing or removing the entry can move
      // or take the alarm with it instead of leaving a stray one behind
      reminderId: v.optional(v.id("reminders")),
      source: v.union(
        v.literal("manual"),
        v.literal("import"),
        v.literal("ai"),
      ),
      feedId: v.optional(v.id("calendarFeeds")),
      // the UID out of an imported file, so re-syncing updates rather than
      // duplicates
      externalId: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_family_start", ["familyId", "startsAt"])
      .index("by_owner_start", ["ownerId", "startsAt"])
      .index("by_external", ["feedId", "externalId"]),

    // an offer of help against a bulletin card: "I can drive"
    calendarReplies: defineTable({
      eventId: v.id("calendarEvents"),
      userId: v.id("users"),
      name: v.string(),
      answer: v.string(),
      createdAt: v.number(),
    })
      .index("by_event", ["eventId"])
      .index("by_event_user", ["eventId", "userId"]),

    // an outside calendar being streamed in: a .ics file, or a live Google or
    // Outlook address
    calendarFeeds: defineTable({
      ownerId: v.id("users"),
      name: v.string(),
      url: v.string(),
      provider: v.union(
        v.literal("ics"),
        v.literal("google"),
        v.literal("outlook"),
      ),
      enabled: v.boolean(),
      lastSyncedAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
      createdAt: v.number(),
    }).index("by_owner", ["ownerId", "createdAt"]),

    // the timezone the calendar is read in, and which layers are switched off
    calendarPrefs: defineTable({
      userId: v.id("users"),
      timeZone: v.string(),
      hiddenLayers: v.array(v.string()),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    // the [LIVE] page's briefing. Every reading on that page — weather,
    // alerts, air, market prices, orbit, seismic — is fetched here on the
    // server and cached as one row, so the page shows real numbers instead of
    // a grid of embedded pages waiting on somebody else's website.
    briefings: defineTable({
      // one row, named, so the cron and the page agree on which it is
      key: v.string(),
      // the whole briefing, in the shape `briefing.ts` built it
      data: v.any(),
      updatedAt: v.number(),
    }).index("by_key", ["key"]),

    // the shopping list the meal plan feeds
    shoppingItems: defineTable({
      ownerId: v.id("users"),
      familyId: v.optional(v.id("families")),
      text: v.string(),
      done: v.boolean(),
      fromEventId: v.optional(v.id("calendarEvents")),
      createdAt: v.number(),
    }).index("by_owner", ["ownerId", "createdAt"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
