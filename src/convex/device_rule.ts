/**
 * The device rule, written once — for the server and for the screen.
 *
 * A device is an installation rather than a person: the owner authorises them,
 * the server records them, and `guard.isUnlocked` refuses every private
 * function to one that is not in. Whether a row *stands open* is the same
 * question in both places, so it is asked in one place.
 *
 * It matters that it is one place. A screen that lets somebody in while the
 * server refuses them — or the other way round — is exactly how a hub that
 * promises "sign in and you are in" starts demanding a second approval that
 * nobody can give: the person is signed in, the door is shut, and the sentence
 * on the screen points at a button they cannot reach.
 *
 *   * **`authorized`** is open.
 *   * **`pending`** means *registered, waiting for the family password to be
 *     answered*. On a hub with no password in force there is nothing to wait
 *     for, so a row left `pending` by a hub that used to have one is not a gate
 *     — it is a row the rule has moved on from.
 *   * **`revoked`** is never open. That is the owner's decision, and a device
 *     that could reopen itself would make revoking one meaningless.
 */
export type DeviceStatus = "authorized" | "pending" | "revoked";

/** Whether one device row is allowed to use the hub. */
export function deviceStandsOpen(
  status: DeviceStatus | null,
  passwordRequired: boolean,
): boolean {
  if (status === "authorized") return true;
  return status === "pending" && !passwordRequired;
}

/**
 * The whole decision the device gate makes, so the screen and the server are
 * reading the same rule rather than two that agree today.
 *
 * Two of the ways past it belong to the hub rather than the device: a hub with
 * no owner yet is still being set up, and the screens that do the setting up
 * have to be reachable — that is where the first device is claimed and where a
 * password, when there is one, is answered. Revoked is checked first: it is the
 * one status nothing else overrides.
 */
export function deviceGatePasses(input: {
  status: DeviceStatus | null;
  passwordRequired: boolean;
  ownerExists: boolean;
}): boolean {
  if (input.status === "revoked") return false;
  if (!input.ownerExists) return true;
  return deviceStandsOpen(input.status, input.passwordRequired);
}
