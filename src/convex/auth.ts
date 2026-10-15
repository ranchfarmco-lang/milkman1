// The hub's sign-in.
//
// Four providers are *possible*; which ones are in force is the list below, and
// it is short on purpose.
//
//   * `password` — **the hub's own way in.** A name (or an email address) and a
//     password, hashed with scrypt and stored in this hub's own database, with
//     the session issued by this deployment's own signing keys. No email is
//     sent, no gateway is called, nothing outside the machine is involved, and
//     it works with the network cable unplugged. This is the provider to use on
//     a hub you run yourself: it is a sign-in that belongs to the deployment it
//     signs you in to.
//
//   * `anonymous` — a device account, made silently on first load. This is what
//     the hub is built around and what `src/pages/Auth.tsx` takes when somebody
//     is only here to join the family: the account is created behind the scenes,
//     then the family password (`src/convex/guard.ts`) and the device rule
//     (`src/convex/device_rule.ts`) decide whether it may read anything. It
//     needs no credential at all, so it needs no service either.
//
//   * `email-otp` — sign-in codes by email, sent through Freebuff's gateway,
//     which is the one thing in this project that asks Freebuff for anything.
//     It is therefore registered **only when `VLY_INTEGRATION_KEY` is actually
//     set on the deployment**, which it never is on a hub you run yourself.
//     Nothing else in the project — and no screen — depends on it.
//
//   * Nothing else. There is no provider that calls out to the internet.
//
// A hub with no key set can still sign people in two ways, and neither of them
// can be switched off by anybody: an account it stores itself, and a device
// account it makes itself.

import { convexAuth } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";
import type { Value } from "convex/values";
import { emailOtp } from "./auth/emailOtp";

/**
 * The identifier rule for an account, in one place.
 *
 * Two things matter and both are deliberate:
 *
 * * **An email address is not required.** The hub never sends email, so it has
 *   no use for one; what it needs is something a person can type again on the
 *   other device. A bare name is therefore accepted, and stored under a suffix
 *   of this hub's own (`.hub.local`) that no real domain can collide with. An
 *   address that does look like an email is kept as it was typed, so both work
 *   and neither is special.
 * * **Names are compared lowercased and trimmed**, because "Mum" and "mum "
 *   typed on two devices are the same person, and the database should agree
 *   with the family about that.
 *
 * The suffix is not a domain the hub can or will ever send to. It exists so one
 * column (`users.email`, the one the auth tables index) can hold both kinds of
 * identifier without a second table.
 */
export const ACCOUNT_SUFFIX = "@hub.local";

/** The stored identifier for what somebody typed. Shared with the sign-in page. */
export function accountIdentifier(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (clean.includes("@")) return clean;
  return `${clean}${ACCOUNT_SUFFIX}`;
}

const password = Password({
  id: "password",
  // What is written against the account. Only the identifier, normalized; the
  // password itself never reaches this function.
  profile: (params: Record<string, Value | undefined>) => {
    const typed = String(params.email ?? params.username ?? "").trim();
    if (typed.length < 3) {
      throw new Error("That name is too short — use at least three characters.");
    }
    return { email: accountIdentifier(typed) };
  },
  // Short passwords are the one thing an offline hub cannot make up for: there
  // is no email to reset through and no support desk, so the rule is here.
  validatePasswordRequirements: (value: string) => {
    if (value.length < 8) {
      throw new Error("Use at least 8 characters for the password.");
    }
  },
  // No `reset`, on purpose: a reset is a code delivered somewhere else, and the
  // hub has nowhere else to deliver it. Saying that plainly is better than a
  // button that quietly needs an email service.
});

const providers = [
  password,
  Anonymous,
  ...(process.env.VLY_INTEGRATION_KEY?.trim() ? [emailOtp] : []),
];

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers,
});
