import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Whether this window is phone-width.
 *
 * The answer already exists, as a media query, so it is read from the browser
 * rather than copied into state by an effect: a copy made in an effect renders
 * the component twice on every mount, and it can disagree with the window it is
 * describing for a frame afterwards.
 */
function subscribe(onChange: () => void) {
  const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function snapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}
