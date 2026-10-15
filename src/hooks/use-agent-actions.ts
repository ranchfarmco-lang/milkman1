import { api } from "@/convex/_generated/api";
import { runActions, toActions } from "@/lib/assistant-actions";
import { useMutation } from "convex/react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

/**
 * Doing what the AI asked for, wherever the reply landed.
 *
 * An answer can carry work with it — open a page, set a timer, put something on
 * the calendar, add to the shopping list, remember a fact. The server has
 * already done its half (timers, reminders, memory, sharing); this is the half
 * that can only happen in the page the person is looking at, and it is the same
 * half for every box that shows an answer: the AI Assistant, the AI Builder,
 * and the little companion in the corner.
 *
 * Keeping it here rather than in one page is what stops the three of them
 * drifting apart — a new action added to `assistant-actions` is then wired into
 * all of them at once, because they all call this.
 */
export function useAgentActions() {
  const navigate = useNavigate();
  const setDisplayName = useMutation(api.family.setDisplayName);
  const createEvent = useMutation(api.calendar.fromAssistant);
  const planShopping = useMutation(api.calendar.shopFromAssistant);
  const [problem, setProblem] = useState<string | null>(null);

  const run = useCallback(
    async (rawActions: unknown) => {
      const actions = toActions(rawActions);
      if (!actions.length) return;

      await runActions(actions, {
        navigate: (path) => navigate(path),
        setMyName: (name) => setDisplayName({ name }),
        // Both of these go to the server, which is where the audience tiers and
        // who-is-actually-in-this-family are decided — the page is only the
        // hands that carry the action there.
        createEvent: (draft) => createEvent(draft),
        planShopping: (draft) => planShopping(draft),
        onProblem: setProblem,
      });
    },
    [navigate, setDisplayName, createEvent, planShopping],
  );

  return { run, problem, setProblem };
}
