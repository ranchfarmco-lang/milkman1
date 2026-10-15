import { readScreen, writeScreen } from "@/lib/companion/screen";
import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * How long the page waits after the last thing that happened before it writes
 * the digest down.
 *
 * Arriving somewhere is written immediately — that is a whole new page and the
 * question "what is this?" comes before anything else. Everything after it is
 * a keystroke, a click into a field, or a highlight, and those arrive in bursts:
 * a sentence typed at speed is sixty of them. Waiting for the room to go quiet
 * means the digest describes the sentence, not the third letter of it.
 */
const SETTLE_MS = 600;

/**
 * Keeps the screen digest in step with the page, for as long as the box is
 * mounted.
 *
 * It listens rather than polls: focus moving in or out of a field, anything
 * being typed, a selection being dragged out, and a change of route are the
 * only four things that can change the answer, and each of them is an event the
 * document already fires.
 */
export function useScreenReport() {
  const { pathname } = useLocation();

  useEffect(() => {
    // Arriving is written at once: a fresh page is worth describing before the
    // person has touched anything on it.
    writeScreen(readScreen(pathname));

    let timer: number | null = null;

    const settle = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        writeScreen(readScreen(pathname));
      }, SETTLE_MS);
    };

    document.addEventListener("focusin", settle);
    document.addEventListener("focusout", settle);
    document.addEventListener("input", settle);
    document.addEventListener("selectionchange", settle);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("focusin", settle);
      document.removeEventListener("focusout", settle);
      document.removeEventListener("input", settle);
      document.removeEventListener("selectionchange", settle);
    };
  }, [pathname]);
}
