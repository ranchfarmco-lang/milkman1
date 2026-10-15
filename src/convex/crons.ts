import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Housekeeping for the family roster.
 *
 * A device that leaves cleanly takes itself off the family as it goes. One that
 * simply vanishes — a crash, a force-quit, a dead battery — cannot, so this
 * sweeps up anyone whose heartbeat has gone quiet. It is only the backstop:
 * coming back always rejoins, so the worst this can do is briefly drop a member
 * who was already gone.
 */
const crons = cronJobs();

crons.interval(
  "sweep members who have gone quiet",
  { minutes: 5 },
  internal.family.purgeOffline,
  { olderThanMs: 2 * 60 * 1000 },
);

/**
 * Rebuild the [LIVE] board three times a day: 5am, 8am and 2pm, Colorado time.
 *
 * It used to run every half hour — 48 rebuilds a day of the heaviest job in the
 * hub, for a board whose sources move slowly. Three is what was asked for: 5am
 * for the full check — the weather, the markets, and the hometown papers,
 * calendars and sale feeds for Grand Junction, Rifle and Cañon City — 8am to
 * write the morning rundown over that check, and 2pm for the afternoon.
 *
 * The timer fires hourly and the *handler* decides whether this is one of the
 * three hours, rather than the schedule naming an hour in UTC. Colorado is UTC-6
 * in summer and UTC-7 in winter, so a fixed UTC hour drifts by an hour twice a
 * year — 5am would quietly become 4am for half of it. Asking "what hour is it
 * in Denver" keeps the three times where they were put.
 *
 * Refresh on the page still rebuilds it immediately: a person wanting it now is
 * a different thing from a timer deciding.
 */
crons.interval(
  "check whether it is time to rebuild the live board",
  { hours: 1 },
  internal.briefing.tick,
  {},
);

/**
 * Re-read the boxes the assistant installed on the [LIVE] page.
 *
 * A box somebody asked for — a feed, a sale board, an events calendar — is
 * theirs to keep, so it is fetched on its own timer rather than only when they
 * press Refresh. It runs on the hour, between the board's three rebuilds, so
 * one box answering slowly never holds up the board itself.
 */
crons.interval(
  "re-read the boxes installed on the live page",
  { hours: 1 },
  internal.live_boxes.refreshAll,
  {},
);

/**
 * Put the board on the calendar, once every morning.
 *
 * The [LIVE] board shows the horse and equipment sales, the weather alerts and
 * the road reports, but a board is a wall somebody has to walk up to. This
 * copies what it found onto the calendar — the dated sales as entries, the
 * rest as one "Colorado & national watch" card — and leaves each person a
 * reminder, so the day starts with what affects them here rather than with
 * them having to go looking. 12:15 UTC is a little after six in Colorado,
 * early enough to be read with the morning coffee.
 */
crons.cron(
  "put the board on the calendar",
  "15 12 * * *",
  internal.calendar.syncBoard,
  {},
);

export default crons;
