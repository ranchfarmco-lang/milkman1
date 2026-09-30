import { api } from "@/convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";

export function useAuth() {
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.currentUser);
  const { signIn } = useAuthActions();
  const forgetMe = useMutation(api.family.forget);
  const lockDevice = useMutation(api.access.lock);

  // Derive isLoading directly from the dependencies instead of managing separate state
  const isLoading = isAuthLoading || user === undefined;

  // Signing out gives up the name and locks this device, but keeps the account.
  //
  // Throwing the account away is what used to go wrong: the next sign-in made a
  // brand-new anonymous account, so one person became several people — the old,
  // still-named account stayed on the roster and showed up as somebody else who
  // was online. Keeping the account means a browser is always one person, and
  // because it is the same account, a new name also carries onto the messages
  // that person already sent. The password is asked for again (that is `lock`),
  // so it is still a real sign-out. Best effort throughout: leaving the screen
  // matters more than which half of the tidy-up wins a race.
  const signOut = async () => {
    try {
      await forgetMe({});
    } catch {
      // Ignore — locking below still takes us out.
    }
    try {
      await lockDevice({});
    } catch {
      // Ignore — the screen still returns to the password.
    }
  };

  return {
    isLoading,
    isAuthenticated,
    user,
    signIn,
    signOut,
  };
}
