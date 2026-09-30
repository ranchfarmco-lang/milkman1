/**
 * Turns the packaged files into ONE self-contained shell script.
 *
 * The point: the person downloads a single file to their external drive, runs
 * it, and everything lands on that drive — the package, the software, and the
 * model weights. No second file to fetch, nothing to unzip.
 *
 * The text payload is written with here-documents rather than base64, because
 * nearly every packaged file is text. That keeps the script readable and needs
 * no `unzip`, no `base64`, and no Python to unpack it — just bash. The two
 * exceptions are written as base64 instead: the archive of the reference
 * source, which ships inside the package as real bytes (see
 * `PACKAGE_BINARY_FILES`), and anything else that is ever added there.
 */

export type BundleFile = { path: string; text: string };

/** A packaged file that is not text: its bytes, wrapped as base64. */
export type BinaryBundleFile = { path: string; base64: string };

/**
 * `btoa` in chunks — a 19 MB array cannot become one string in a single call,
 * and every chunk is a multiple of three bytes so they concatenate cleanly.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 3 * 8192;
  let encoded = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    const slice = bytes.subarray(at, Math.min(at + CHUNK, bytes.length));
    encoded += btoa(String.fromCharCode(...slice));
  }
  return encoded;
}

/** Wrapped at 76 columns, which is what every `base64 -d` expects to read. */
function wrapBase64(encoded: string): string {
  const lines = encoded.match(/.{1,76}/g) ?? [];
  return `${lines.join("\n")}\n`;
}

/** A here-document delimiter that appears in none of the files. */
function pickDelimiter(files: BundleFile[]): string {
  let delimiter = "OFFLINE_BRAIN_FILE_END";
  while (files.some((file) => file.text.includes(delimiter))) {
    delimiter += "_X";
  }
  return delimiter;
}

/** Reject anything that would escape the target directory or break the script. */
export function safeBundlePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !path.includes("\n") &&
    !path.includes("'")
  );
}

export function buildSelfInstaller(
  files: BundleFile[],
  modelSet: string,
  source: string,
  requiredGb = 0,
  binaryFiles: BinaryBundleFile[] = [],
): string {
  const delimiter = pickDelimiter(files);
  const usable = files.filter((file) => safeBundlePath(file.path));
  const usableBinary = binaryFiles.filter((file) => safeBundlePath(file.path));

  const header = [
    "#!/usr/bin/env bash",
    "# ============================================================",
    "#  offline-ai-coding-brain — one-file installer",
    "# ============================================================",
    "#",
    "# Save this file on the drive you want everything to live on,",
    "# then run it there:",
    "#",
    "#     bash install-offline-brain.sh",
    "#",
    "# It installs every prerequisite it needs (base tools first), unpacks",
    "# the whole package next to itself, installs the software, and puts the",
    "# Python environments and the model weights on that same drive.",
    "#",
    "# Change the model set without editing anything:",
    "#     MODEL_SET=small bash install-offline-brain.sh",
    "#     SKIP_MODELS=1  bash install-offline-brain.sh   # software only",
    "#",
    `# Downloaded from: ${source}`,
    "set -euo pipefail",
    "",
    'HERE="$(cd "$(dirname "$BASH_SOURCE")" && pwd)"',
    'DEST="$HERE/offline-ai-coding-brain"',
    `MODEL_SET="\${MODEL_SET:-${modelSet}}"`,
    `NEED_GB="\${NEED_GB:-${requiredGb}}"`,
    "export MODEL_SET",
    "",
    'echo "=============================================================="',
    'echo " offline-ai-coding-brain"',
    'echo "   unpacking to: $DEST"',
    'echo "   model set:    $MODEL_SET"',
    'echo "--------------------------------------------------------------"',
    'echo " On this drive:   package, Python environments, model weights"',
    'echo " On this computer: base tools, compilers, system packages, runtimes"',
    'echo "=============================================================="',
    "",
    "# The base tools the installer itself needs before it can install anything.",
    "# Everything below this line is installed on the computer, not the drive.",
    "install_base_tools() {",
    '  echo "==> Base tools (curl, git, tar, python3 + venv) on this computer"',
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    sudo apt-get update -qq',
    '    sudo apt-get install -y curl git tar ca-certificates python3 python3-venv python3-pip',
    '  elif command -v dnf >/dev/null 2>&1; then',
    '    sudo dnf install -y curl git tar ca-certificates python3 python3-pip',
    '  elif command -v pacman >/dev/null 2>&1; then',
    '    sudo pacman -S --noconfirm curl git tar ca-certificates python',
    '  elif command -v zypper >/dev/null 2>&1; then',
    '    sudo zypper install -y curl git tar ca-certificates python3 python3-pip',
    '  elif command -v brew >/dev/null 2>&1; then',
    '    brew install curl git python',
    '  else',
    '    echo "No supported package manager found." >&2',
    '    echo "Install curl, git, tar and python3 (with venv) yourself, then re-run." >&2',
    "    return 1",
    "  fi",
    "}",
    "",
    "check_space() {",
    '  [ "$NEED_GB" -gt 0 ] 2>/dev/null || return 0',
    '  local avail_kb avail_gb',
    '  avail_kb="$(df -Pk "$HERE" 2>/dev/null | awk \'NR==2 {print $4}\')"',
    '  [ -n "${avail_kb:-}" ] || return 0',
    '  avail_gb=$(( avail_kb / 1024 / 1024 ))',
    '  echo "==> Free space on this drive: ${avail_gb} GB (about ${NEED_GB} GB needed)"',
    '  if [ "$avail_gb" -lt "$NEED_GB" ]; then',
    '    echo "WARNING: not enough free space — the download will stop partway." >&2',
    "  fi",
    "}",
    "",
    'mkdir -p "$DEST"',
    'cd "$DEST"',
    "",
    "unpack() {",
    '  mkdir -p "$(dirname "$1")"',
    '  cat > "$1"',
    "}",
    "",
    "# The files that are not text come back as base64. Decoding differs by",
    "# system — GNU base64 (Linux) takes -d, the BSD one (macOS) always took",
    "# -D, and python3, which this package needs for the brain anyway, works",
    "# everywhere — so all three are tried in turn. A decoder that is missing",
    "# or refuses must never stop the install: the last resort is to leave the",
    "# file encoded intact and say so, which the installer scripts then report.",
    "unpack_b64() {",
    '  local dest="$1"',
    '  local encoded="$1.b64"',
    '  mkdir -p "$(dirname "$dest")"',
    '  cat > "$encoded"',
    "  if command -v base64 >/dev/null 2>&1; then",
    '    base64 -d "$encoded" > "$dest" 2>/dev/null && [ -s "$dest" ] && { rm -f "$encoded"; return 0; }',
    '    base64 -D "$encoded" > "$dest" 2>/dev/null && [ -s "$dest" ] && { rm -f "$encoded"; return 0; }',
    "  fi",
    "  if command -v python3 >/dev/null 2>&1; then",
    "    if python3 - \"$encoded\" \"$dest\" 2>/dev/null <<'PY'",
    "import base64, sys",
    "with open(sys.argv[1], 'rb') as src, open(sys.argv[2], 'wb') as out:",
    "    out.write(base64.b64decode(src.read()))",
    "PY",
    "    then",
    '      [ -s "$dest" ] && { rm -f "$encoded"; return 0; }',
    "    fi",
    "  fi",
    '  rm -f "$dest"',
    '  echo "    warn: nothing here could decode $dest; it is kept encoded in $encoded." >&2',
    "}",
    "",
  ].join("\n");

  // A here-document needs its delimiter on its own line, so the payload must end
  // with exactly one newline. Files that already end with one stay byte-identical;
  // files that do not gain a single trailing newline.
  const body = usable
    .map((file) => {
      const text = file.text.endsWith("\n") ? file.text : `${file.text}\n`;
      return `unpack "${file.path}" <<'${delimiter}'\n${text}${delimiter}`;
    })
    .join("\n");

  // Base64 cannot contain an underscore, and the delimiter always does, so an
  // encoded file can never close the here-document early.
  const binaryBody = usableBinary
    .map(
      (file) =>
        `unpack_b64 "${file.path}" <<'${delimiter}'\n${wrapBase64(file.base64)}${delimiter}`,
    )
    .join("\n");

  const footer = [
    "",
    'chmod +x GET-EVERYTHING.sh scripts/*.sh tests/*.sh 2>/dev/null || true',
    "",
    'echo "Package unpacked into: $DEST"',
    `echo "Unpacked ${usable.length} files${usableBinary.length ? ` and ${usableBinary.length} archive` : ""}."`,
    "",
    "if [ ! -x ./GET-EVERYTHING.sh ]; then",
    '  echo "GET-EVERYTHING.sh is missing or not executable — unpacking failed." >&2',
    "  exit 1",
    "fi",
    "",
    'if [ "${UNPACK_ONLY:-0}" = "1" ]; then',
    '  echo "UNPACK_ONLY=1 — package left unpacked; nothing installed."',
    "  exit 0",
    "fi",
    "",
    "install_base_tools || exit 1",
    "check_space",
    "",
    'echo "Starting the install. This can take a long time and many gigabytes."',
    "echo",
    "./GET-EVERYTHING.sh",
    "",
  ].join("\n");

  return `${header}${body}\n${binaryBody}\n${footer}`;
}
