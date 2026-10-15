/**
 * The device rule, walked state by state — and the proof that both sides use it.
 *
 * The app's promise is that signing in is the whole of getting in. Two things
 * enforce it: the server's guard (`src/convex/guard.ts`, through
 * `isDeviceAuthorized`) and the screen in front of the app
 * (`src/components/DeviceGate.tsx`). The failure this script exists for is the
 * one nobody sees in a screenshot: the two deciding differently. A row the
 * screen has stopped asking about but the guard still refuses — or the reverse
 * — leaves a signed-in person staring at a door that will not open, hunting for
 * an approval that does not exist.
 *
 * So there are two halves here. The first walks the rule itself: every status,
 * with and without a password in force. The second reads the two callers and
 * asserts they ask that rule rather than keeping a copy of it — which is a
 * source check on purpose, because "there is only one of this rule" is exactly
 * the property that can be lost in an innocuous-looking edit.
 *
 * Run with: bun scripts/access-check.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { deviceGatePasses, deviceStandsOpen } from "../src/convex/device_rule";

const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/* --------------------------------------------------- one row, every status */

check("an authorised device stands open", deviceStandsOpen("authorized", false));
check(
  "…whether or not a password is in force",
  deviceStandsOpen("authorized", true),
);
check(
  "a pending device stands open when there is nothing to answer",
  deviceStandsOpen("pending", false),
);
check(
  "…and waits when there is a password",
  !deviceStandsOpen("pending", true),
);
check("a revoked device never stands open", !deviceStandsOpen("revoked", false));
check(
  "…not even with a password to answer",
  !deviceStandsOpen("revoked", true),
);
check(
  "a device that has never registered does not stand open",
  !deviceStandsOpen(null, false),
);
check("…with a password either", !deviceStandsOpen(null, true));

/* -------------------------------------------------- the gate's whole decision */

const gate = (input: {
  status: "authorized" | "pending" | "revoked" | null;
  passwordRequired: boolean;
  ownerExists: boolean;
}) => deviceGatePasses(input);

check(
  "a hub with no owner yet is open — setting up needs the screens",
  gate({ status: null, passwordRequired: true, ownerExists: false }),
);
check(
  "…and even a pending device gets in to answer the password",
  gate({ status: "pending", passwordRequired: true, ownerExists: false }),
);
check(
  "but a revoked device is not opened by an ownerless hub",
  !gate({ status: "revoked", passwordRequired: false, ownerExists: false }),
);
check(
  "an owner's hub lets a pending device in when no password is asked",
  gate({ status: "pending", passwordRequired: false, ownerExists: true }),
);
check(
  "…and holds it when one is",
  !gate({ status: "pending", passwordRequired: true, ownerExists: true }),
);
check(
  "an authorised device passes either way",
  gate({ status: "authorized", passwordRequired: true, ownerExists: true }) &&
    gate({ status: "authorized", passwordRequired: false, ownerExists: true }),
);
check(
  "a device still registering waits, rather than being refused",
  !gate({ status: null, passwordRequired: false, ownerExists: true }),
);
check(
  "a revoked device waits for the owner, not for a password",
  !gate({ status: "revoked", passwordRequired: true, ownerExists: true }),
);

/* --------------------------------------------- and both sides ask that rule */

const guard = await readFile(join(ROOT, "src/convex/guard.ts"), "utf8");
const component = await readFile(
  join(ROOT, "src/components/DeviceGate.tsx"),
  "utf8",
);

check(
  "the server's guard asks the shared rule",
  guard.includes("deviceStandsOpen(") && guard.includes('from "./device_rule"'),
);
check(
  "the device gate asks the shared rule",
  component.includes("deviceGatePasses(") &&
    component.includes('from "@/convex/device_rule"'),
);
check(
  "the guard no longer decides a status for itself",
  !/row\.status === "authorized"/.test(guard),
);
check(
  "the gate no longer decides a status for itself",
  !/deviceStatus === "authorized"/.test(component),
);

/* ---------------------- the sign-in history the gate's arrivals land in */

const people = await readFile(join(ROOT, "src/convex/people.ts"), "utf8");
const signIns = await readFile(
  join(ROOT, "src/components/SignInsPanel.tsx"),
  "utf8",
);

check(
  "the gate writes an arrival once the device is known",
  component.includes("useMutation(api.people.record)") &&
    component.includes("void recordSignIn({ deviceId: id }).catch(() => undefined)"),
);
check(
  "recording an arrival asks the shared rule, not a second copy of it",
  people.includes("deviceStandsOpen(device.status, hubPassword() !== null)") &&
    !people.includes('device.status !== "authorized"'),
);
check(
  "clearing the history is bounded per call and says whether more is left",
  people.includes("const CLEAR_BATCH") &&
    people.includes("return { removed: rows.length, remaining };"),
);
check(
  "the panel keeps asking while the server says entries remain",
  signIns.includes("if (!result.remaining) break;"),
);
check(
  "every account offers a clear of its own sign-ins, even before any land",
  !signIns.includes("account.signIns > 0 ? (") &&
    signIns.includes("Clear their sign-ins"),
);

console.log(
  failures === 0
    ? "\nEvery device-access check passed."
    : `\n${failures} device-access check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
