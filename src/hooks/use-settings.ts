import { api } from "@/convex/_generated/api";
import { DEFAULT_DEVICE_SETTINGS } from "@/lib/device-settings";
import { useMutation, useQuery } from "convex/react";
import { useCallback } from "react";

/**
 * The Control Room values, with defaults filled in for anything never touched.
 * Updating writes straight through to the database, so every page — and every
 * reload — sees the same choice.
 */
export function useSettings() {
  const stored = useQuery(api.settings.get);
  const setSetting = useMutation(api.settings.set);

  const values: Record<string, boolean> = {
    ...DEFAULT_DEVICE_SETTINGS,
    ...(stored ?? {}),
  };

  const update = useCallback(
    (key: string, value: boolean) => {
      void setSetting({ key, value });
    },
    [setSetting],
  );

  return { values, update, isReady: stored !== undefined };
}
