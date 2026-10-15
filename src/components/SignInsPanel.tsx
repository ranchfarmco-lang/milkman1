import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { stampOf } from "@/lib/backup";
import { ORANGE_BUTTON, ORANGE_GHOST } from "@/lib/control-room-sections";
import { downloadBlob, safeFileName } from "@/lib/download";
import { cn } from "@/lib/utils";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
  Download,
  History,
  Loader2,
  RotateCcw,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** A time a person can read without doing arithmetic. */
function when(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(at).toLocaleDateString();
}

function errorText(caught: unknown): string {
  return caught instanceof Error
    ? caught.message
    : "That did not go through.";
}

/**
 * Who has come in, and what each person has here.
 *
 * One box with two halves, on purpose:
 *
 *   * **Sign-ins** — every arrival with its who, where, what and when, a
 *     Delete on each line and a Clear all above them. Clearing only forgets
 *     the comings and goings. No account, device or session is removed, so
 *     everyone can sign in again, and their next arrival is the first line of
 *     the new list.
 *
 *   * **People** — each account, with Save their data and Delete their data.
 *     Save writes one JSON file of everything that person wrote here; Delete
 *     removes that same work for good. Neither touches the account, the
 *     device, or their way in, so somebody can be cleaned up and still come
 *     back to a fresh page.
 *
 *     **Delete this person** takes the account itself: what they wrote, then
 *     their devices, their password answer, their sign-in sessions and the
 *     account row — so the person is gone rather than emptied, and the next
 *     sign-in in their browser makes a brand-new stranger. It is offered only
 *     where the server would allow it — your own account, anybody's if you are
 *     the owner, and nobody else's if you are not — and it asks twice.
 *
 *     **Delete all people** is that same removal for the whole roster, one
 *     account after another, your own last. It is drawn only when every row is
 *     one you may delete, which in practice means the hub's owner.
 *
 * For everybody who is in, not just the owner: anyone signed in to the hub on
 * an authorised device, with the family password answered, sees the same list
 * and the same buttons. The buttons only ever ask — every one of them is
 * checked on the server for whoever is actually pressing it, so a locked or
 * unknown device gets nothing here no matter what the screen shows.
 *
 * What stays with the owner is the security itself: authorising and revoking
 * devices, and reading the security log, over in the Security box above.
 */
export function SignInsPanel() {
  const convex = useConvex();
  const summary = useQuery(api.security.summary);

  const signIns = useQuery(api.people.list, { limit: 100 });
  const accounts = useQuery(api.people.accounts, {});

  const removeOne = useMutation(api.people.remove);
  const clearAll = useMutation(api.people.clear);
  const removeForUser = useMutation(api.people.removeForUser);
  const purgeUser = useMutation(api.people.purgeUser);
  const deleteAccount = useMutation(api.people.deleteAccount);
  // The real sign-out, which drops this browser's tokens. The app's own
  // `useAuth().signOut` deliberately keeps the account alive, which is the
  // opposite of what the button below does — so deleting your own account
  // ends with this one instead.
  const { signOut: endSession } = useAuthActions();

  const [busy, setBusy] = useState<string | null>(null);
  // Which person's Delete button has been pressed once and is waiting for the
  // second press. Removing everything is the one thing here that cannot be
  // undone, so it asks twice.
  const [armed, setArmed] = useState<string | null>(null);

  // A first press left behind should not fire an hour later: the arming fades
  // on its own.
  useEffect(() => {
    if (armed === null) return;
    const timer = window.setTimeout(() => setArmed(null), 6000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const deleteOne = async (id: Id<"signIns">) => {
    setBusy(`${id}:one`);
    try {
      await removeOne({ id });
      toast.success("That sign-in is deleted. Nothing else was touched.");
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const clearHistory = async () => {
    setBusy("clear");
    try {
      let removed = 0;
      // The server clears a bounded batch per call, each in its own
      // transaction, and says whether any entries are left. Asking again while
      // it says yes is what makes one press clear a history of any length
      // rather than stopping at the first batch.
      for (;;) {
        const result = await clearAll({});
        removed += result.removed;
        if (!result.remaining) break;
      }
      if (removed === 0) toast("There was nothing to clear.");
      else {
        toast.success(
          `${removed} ${
            removed === 1 ? "sign-in" : "sign-ins"
          } cleared. No account or device was touched.`,
        );
      }
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const clearPerson = async (userId: Id<"users">, name: string | null) => {
    setBusy(`${userId}:logins`);
    try {
      const who = name ?? "that account";
      let removed = 0;
      // The same bounded batches as Clear all above, one account at a time.
      for (;;) {
        const result = await removeForUser({ userId });
        removed += result.removed;
        if (!result.remaining) break;
      }
      if (removed === 0) toast(`There were no sign-ins recorded for ${who}.`);
      else {
        toast.success(
          `${removed} ${
            removed === 1 ? "sign-in" : "sign-ins"
          } cleared for ${who}.`,
        );
      }
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const savePerson = async (userId: Id<"users">, name: string | null) => {
    setBusy(`${userId}:save`);
    try {
      const data = await convex.query(api.people.exportData, { userId });
      const stamp = stampOf(new Date().toISOString());
      const saved = downloadBlob(
        `sugar-${safeFileName(name ?? "account")}-data-${stamp}.json`,
        new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        }),
      );
      if (!saved) toast.error("There was nothing to save.");
      else toast.success("Saved. The file is in this device's downloads.");
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const deletePerson = async (userId: Id<"users">, name: string | null) => {
    if (armed !== userId) {
      setArmed(userId);
      return;
    }
    setArmed(null);
    setBusy(`${userId}:purge`);
    try {
      const result = await purgeUser({ userId });
      toast.success(
        `Everything ${name ?? "that account"} had written is removed (${
          result.total
        } ${result.total === 1 ? "row" : "rows"}). The account and its devices
        are untouched.`,
      );
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Delete the person, not only their writing.
   *
   * Two calls in this order, and both have to land: what they wrote comes out
   * first, then the account, its devices and every session behind them. If the
   * first half fails nothing has happened at all, so nobody is ever left
   * half-deleted — writing gone, name still on the roster.
   *
   * Deleting your own account is the one case that ends somewhere else: the
   * real sign-out drops this browser's tokens, and the page is replaced rather
   * than navigated, so the next person to use this browser starts at the
   * password as the stranger they now are.
   */
  const removePerson = async (
    userId: Id<"users">,
    name: string | null,
    isMe: boolean,
  ) => {
    if (armed !== `account:${userId}`) {
      setArmed(`account:${userId}`);
      return;
    }
    setArmed(null);
    setBusy(`${userId}:account`);
    try {
      const purged = await purgeUser({ userId });
      const removed = await deleteAccount({ userId });

      if (isMe) {
        try {
          await endSession();
        } catch {
          // The account is already gone; getting off this page is what counts.
        }
        window.location.replace("/auth");
        return;
      }

      toast.success(
        `${name ?? "That account"} is deleted: everything they had written (${purged.total} ${
          purged.total === 1 ? "row" : "rows"
        }), their ${
          removed.removed.devices ?? 0
        } ${removed.removed.devices === 1 ? "device" : "devices"}, and every way in.${
          removed.wasOwner
            ? " It was the owner's account, so the hub has no owner now — the next person to answer the family password takes it over."
            : ""
        }`,
      );
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Delete every person, whole — not just their writing.
   *
   * The same removal as pressing `Delete this person` on each row in turn,
   * and deliberately one server call per account rather than one big call:
   * a hub that has been running a while cannot blow a single transaction's
   * limits, and an account that refuses (the owner's, when you are not the
   * owner) leaves the others done rather than undoing the lot.
   *
   * Your own account is deleted last, because deleting it ends this session:
   * the real sign-out drops this browser's tokens and the page is replaced, so
   * the last thing this browser sees is the password as the stranger it now
   * is. If your own account is not in the list, everyone else simply goes.
   */
  const deleteAllPeople = async () => {
    if (armed !== "all:accounts") {
      setArmed("all:accounts");
      return;
    }
    setArmed(null);
    setBusy("all:accounts");

    const list = accounts ?? [];
    const mine = list.find((account) => account.isMe) ?? null;
    // Everybody else first, so a failure on one does not leave the rest
    // standing; the account pressing the button goes last.
    const order = [
      ...list.filter((account) => !account.isMe),
      ...(mine ? [mine] : []),
    ];

    let done = 0;
    let rows = 0;
    let deletedMine = false;
    const failed: string[] = [];
    try {
      for (const account of order) {
        try {
          const removed = await deleteAccount({ userId: account.userId });
          done += 1;
          rows += removed.total;
          if (account.isMe) deletedMine = true;
        } catch (caught) {
          failed.push(
            `${account.name ?? "Unnamed account"}: ${errorText(caught)}`,
          );
        }
      }

      if (deletedMine) {
        try {
          await endSession();
        } catch {
          // The account is already gone; getting off this page is what counts.
        }
        window.location.replace("/auth");
        return;
      }

      if (done === 0 && failed.length === 0) {
        toast("There was nobody to delete.");
      } else if (failed.length === 0) {
        toast.success(
          `${done === 1 ? "The account" : `All ${done} accounts`} deleted — what each person wrote (${rows} ${
            rows === 1 ? "row" : "rows"
          }), their devices, and every way in.`,
        );
      } else {
        toast.error(
          `Deleted ${done} ${
            done === 1 ? "account" : "accounts"
          }. These could not be done: ${failed.join("; ")}`,
        );
      }
    } finally {
      setBusy(null);
    }
  };

  /**
   * Delete everybody's data, one account at a time.
   *
   * Deliberately not one big server call: each account is its own removal, so
   * a long-lived hub cannot blow a single transaction's limits, and one
   * account failing leaves the others done rather than undoing the lot. What
   * each person wrote goes; their account, their device and their way in stay
   * exactly as they are, so everyone can come back to a fresh page.
   */
  const deleteEveryone = async () => {
    if (armed !== "all") {
      setArmed("all");
      return;
    }
    setArmed(null);
    setBusy("all:purge");
    let total = 0;
    let done = 0;
    const failed: string[] = [];
    try {
      for (const account of accounts ?? []) {
        try {
          const result = await purgeUser({ userId: account.userId });
          total += result.total;
          done += 1;
        } catch (caught) {
          failed.push(
            `${account.name ?? "Unnamed account"}: ${errorText(caught)}`,
          );
        }
      }
      if (done === 0 && failed.length === 0) {
        toast("There was nothing to delete.");
      } else if (failed.length === 0) {
        toast.success(
          `Everything ${done === 1 ? "the one account" : `all ${done} accounts`} had written is removed (${total} ${
            total === 1 ? "row" : "rows"
          }). Accounts, devices and sign-ins are untouched.`,
        );
      } else {
        toast.error(
          `Removed ${total} ${total === 1 ? "row" : "rows"} from ${done} ${
            done === 1 ? "account" : "accounts"
          }. These could not be done: ${failed.join("; ")}`,
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const total = summary?.signIns ?? 0;
  const shown = signIns?.length ?? 0;

  // Offered only where the server would allow deleting every row at once:
  // when the list is non-empty and each account is one this caller may remove
  // (`canDelete` already mirrors the rule in `deleteAccount`). For anybody but
  // the hub's owner that is false on the owner's row, so the button is simply
  // not drawn rather than failing half way through.
  const canDeleteAll =
    accounts !== undefined &&
    accounts.length > 0 &&
    accounts.every((account) => account.canDelete);

  return (
    <section className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
      <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <History className="size-3" />
        Sign-ins &amp; people
      </h3>
      <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
        Every arrival is written down as it happens: who came in, on what, what
        happened, and when. Clearing the list only forgets the comings and
        goings — no account, device or session is removed, and everyone can
        sign in again. The same box saves what each person has written here,
        removes it, or removes the person along with it. Everyone who is in
        sees all of this: sign in to the hub on an authorised device, answer
        the family password, and every button below is yours.
      </p>

      {/* ---------------------------------------------------------- sign-ins */}
      <div className="mt-3 flex items-center justify-between">
        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Sign-ins
        </p>
        <span className="text-[9px] text-muted-foreground">
          {signIns === undefined
            ? "reading…"
            : total === 0
              ? "none yet"
              : shown < total
                ? `${shown} of ${total} shown`
                : `${total} recorded`}
        </span>
      </div>

      <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border/60 bg-background/30">
        {signIns === undefined ? (
          <div className="flex items-center justify-center py-3">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : signIns.length === 0 ? (
          <p className="px-3 py-2 text-[10px] text-muted-foreground">
            Nothing recorded yet. Each time someone comes in, it lands here.
          </p>
        ) : (
          signIns.map((entry) => (
            <div
              key={entry._id}
              className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3 py-1.5 first:border-t-0"
            >
              <span className="shrink-0 text-foreground/60">
                <UserRound className="size-3" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-medium">
                  {entry.name ?? "Unnamed account"}
                  <span className="font-normal text-muted-foreground">
                    {" · "}
                    {entry.deviceName ?? "unknown device"}
                    {entry.platform ? ` · ${entry.platform}` : ""}
                  </span>
                </p>
                <p className="truncate text-[9px] text-muted-foreground">
                  {entry.what}
                </p>
              </div>
              <span className="shrink-0 text-[9px] text-muted-foreground">
                {when(entry.at)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy === `${entry._id}:one`}
                onClick={() => void deleteOne(entry._id)}
                aria-label={`Delete this sign-in by ${
                  entry.name ?? "an unnamed account"
                }`}
                className="h-6 shrink-0 cursor-pointer rounded-lg px-2 text-[9px] text-destructive"
              >
                <Trash2 className="size-2.5" />
                Delete
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy === "clear" || total === 0}
          onClick={() => void clearHistory()}
          className={cn(
            "h-7 cursor-pointer rounded-lg text-[9px]",
            ORANGE_BUTTON,
          )}
        >
          {busy === "clear" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RotateCcw className="size-3" />
          )}
          Clear all sign-ins
        </Button>
        <span className="text-[9px] leading-4 text-muted-foreground">
          History only — accounts, devices and sessions stay exactly as they
          are, and everyone can sign in again.
        </span>
      </div>

      {/* ----------------------------------------------------------- people */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          People — save their data, clear their sign-ins, or take the person away
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {canDeleteAll ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy === "all:accounts"}
              onClick={() => void deleteAllPeople()}
              className={cn(
                "h-7 cursor-pointer rounded-lg text-[9px]",
                armed === "all:accounts" ? ORANGE_BUTTON : ORANGE_GHOST,
              )}
            >
              {busy === "all:accounts" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
              {armed === "all:accounts"
                ? "Press again — every account goes"
                : "Delete all people"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              busy === "all:purge" ||
              accounts === undefined ||
              accounts.length === 0
            }
            onClick={() => void deleteEveryone()}
            className={cn(
              "h-7 cursor-pointer rounded-lg text-[9px]",
              armed === "all" ? ORANGE_BUTTON : ORANGE_GHOST,
            )}
          >
            {busy === "all:purge" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
            {armed === "all"
              ? "Press again to delete everyone's data"
              : "Delete everyone's data"}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
        <span className="text-foreground/80">Save their data</span> writes one
        file holding everything that person has here: their messages, asks,
        memories, reminders, calendar entries and replies, shopping list,
        builder files, saved pages and downloads.{" "}
        <span className="text-foreground/80">Delete their data</span> removes
        that same work for good. Neither touches the account, the device, or
        the door they come in through.{" "}
        <span className="text-foreground/80">Delete everyone's data</span> does
        the same for every account in the list, one after another, so one
        account failing does not undo the others. It asks twice, and it leaves
        the sign-in list alone — that has its own Clear all above.
      </p>
      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
        <span className="text-foreground/80">Delete this person</span> is the
        one that is not reversible. It takes what they wrote, and then the
        account itself: their devices, the record that they answered the family
        password, and every sign-in session behind the browser they are using.
        They are gone rather than emptied, and the next time that browser signs
        in it starts a brand-new account like any stranger's. It is offered
        only where the server allows it — your own account, anybody's if you
        are the owner, and nobody else's if you are not — so that a family
        member cannot quietly remove the owner and take the hub over. Deleting
        the owner's account leaves the hub ownerless on purpose: the next
        person to answer the family password becomes the owner.
      </p>
      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
        <span className="text-foreground/80">Delete all people</span> is the
        same removal for every account at once — each person is taken away
        whole, one after another, so one failing does not undo the others. Your
        own account is deleted last, and that ends this session: the browser
        goes back to the password as a stranger. It appears only when every row
        is one you may delete (the hub's owner, or a hub with no owner yet), so
        a family member is never offered a wipe they cannot carry out.
      </p>

      <div className="mt-2 flex flex-col gap-1.5">
        {accounts === undefined ? (
          <div className="flex items-center justify-center py-3">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : accounts.length === 0 ? (
          <p className="py-2 text-[10px] text-muted-foreground">
            No accounts yet.
          </p>
        ) : (
          accounts.map((account) => {
            const who = account.name ?? "Unnamed account";
            return (
              <div
                key={account.userId}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background/30 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium">{who}</p>
                  <p className="truncate text-[9px] text-muted-foreground">
                    {account.lastAt
                      ? `last came in ${when(account.lastAt)}${
                          account.lastDeviceName
                            ? ` from ${account.lastDeviceName}`
                            : ""
                        }${
                          account.lastPlatform
                            ? ` (${account.lastPlatform})`
                            : ""
                        }`
                      : "no sign-ins recorded"}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy === `${account.userId}:save`}
                    onClick={() => void savePerson(account.userId, account.name)}
                    className="h-7 cursor-pointer rounded-lg text-[9px]"
                  >
                    {busy === `${account.userId}:save` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Download className="size-3" />
                    )}
                    Save their data
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy === `${account.userId}:logins`}
                    title={
                      account.signIns > 0
                        ? `Forget the ${account.signIns} recorded ${
                            account.signIns === 1 ? "sign-in" : "sign-ins"
                          } for ${who} — the account, its devices and its way in stay`
                        : `Nothing recorded for ${who} yet — the button is here anyway`
                    }
                    onClick={() =>
                      void clearPerson(account.userId, account.name)
                    }
                    className={cn(
                      "h-7 cursor-pointer rounded-lg text-[9px]",
                      ORANGE_GHOST,
                    )}
                  >
                    {busy === `${account.userId}:logins` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <History className="size-3" />
                    )}
                    Clear their sign-ins
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy === `${account.userId}:purge`}
                    onClick={() =>
                      void deletePerson(account.userId, account.name)
                    }
                    className={cn(
                      "h-7 cursor-pointer rounded-lg text-[9px]",
                      armed === account.userId ? ORANGE_BUTTON : ORANGE_GHOST,
                    )}
                  >
                    {busy === `${account.userId}:purge` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                    {armed === account.userId
                      ? "Press again to delete"
                      : "Delete their data"}
                  </Button>

                  {account.canDelete ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy === `${account.userId}:account`}
                      onClick={() =>
                        void removePerson(
                          account.userId,
                          account.name,
                          account.isMe,
                        )
                      }
                      className={cn(
                        "h-7 cursor-pointer rounded-lg text-[9px]",
                        armed === `account:${account.userId}`
                          ? ORANGE_BUTTON
                          : ORANGE_GHOST,
                      )}
                    >
                      {busy === `${account.userId}:account` ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Trash2 className="size-3" />
                      )}
                      {armed === `account:${account.userId}`
                        ? account.isMe
                          ? "Press again — your account goes too"
                          : "Press again — this person is gone"
                        : account.isMe
                          ? "Delete my account"
                          : "Delete this person"}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
        Deleting cannot be undone — save the file first if there is any doubt.
        This box shows every account on the hub, not just your own, so a delete
        here removes what that person wrote for everyone, and deleting the
        person removes them from the roster, from every device they had and
        from every call they were in.
      </p>
    </section>
  );
}