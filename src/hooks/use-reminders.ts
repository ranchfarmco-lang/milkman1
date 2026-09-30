import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef } from "react";

export type Reminder = FunctionReturnType<
  typeof api.reminders.pending
>[number];

/**
 * Watches the timers and reminders the assistant has set and calls `onDue`
 * once for each one, the moment it comes due. They are stored on the server,
 * so they still fire after a reload or on another device.
 */
export function useReminders({ onDue }: { onDue: (reminder: Reminder) => void }) {
  const pending = useQuery(api.reminders.pending);
  const complete = useMutation(api.reminders.complete);
  const fired = useRef<Set<string>>(new Set());
  const onDueRef = useRef(onDue);

  useEffect(() => {
    onDueRef.current = onDue;
  }, [onDue]);

  useEffect(() => {
    if (!pending) return;
    const now = Date.now();

    for (const reminder of pending) {
      if (reminder.dueAt > now || fired.current.has(reminder._id)) continue;
      fired.current.add(reminder._id);
      void complete({ id: reminder._id });
      onDueRef.current(reminder);
    }
  }, [pending, complete]);

  return pending ?? [];
}
