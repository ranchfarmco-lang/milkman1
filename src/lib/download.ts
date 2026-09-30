/**
 * Saving something from the hub onto the device in front of you.
 *
 * Everything here is local: a Blob, an object URL and one click. Nothing is
 * uploaded to produce the file, and nothing leaves the hub.
 */

function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser the moment it needs to start the save before letting the
  // URL go.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A name that is safe on every device and still says what it is. */
export function safeFileName(name: string) {
  const cleaned = name
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-");
  return cleaned.replace(/^-|-$/g, "").slice(0, 60) || "private-hub";
}

/**
 * Save a file that was built here — a zip backup, say. The name should carry
 * its own extension, since what it holds is already decided. A file with
 * nothing in it is refused rather than saved as an empty download.
 */
export function downloadBlob(name: string, blob: Blob) {
  if (blob.size === 0) return false;
  saveBlob(safeFileName(name), blob);
  return true;
}

/** Save text as a .txt file. Returns false when there is nothing to save. */
export function downloadText(name: string, text: string) {
  if (!text.trim()) return false;
  saveBlob(
    `${safeFileName(name)}.txt`,
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  return true;
}

/**
 * Save a file that lives in the hub's own storage. Convex serves it from
 * another host, where the `download` attribute is ignored, so it is fetched
 * into a blob first and saved from here.
 */
export async function downloadUrl(name: string, url: string) {
  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error(String(response.status));
    saveBlob(safeFileName(name), await response.blob());
    return true;
  } catch {
    // If the fetch is refused, open it instead so it can still be saved by hand.
    window.open(url, "_blank", "noopener");
    return false;
  }
}

/** "12 KB" — enough to know whether it is worth opening. */
export function readableSize(bytes: number) {
  if (!bytes) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
