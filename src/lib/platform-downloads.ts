/**
 * A complete download for every platform.
 *
 * The Offline Brain page already offers the app, the brain and everything in
 * between — but each of those is a Linux-shaped install. This module makes the
 * *machine* the choice: Microsoft Windows, ChromeOS, Apple (macOS and iOS),
 * Android, Linux and the open-source build each get their own bundle.
 *
 * A bundle is not a note about what to install. It holds:
 *
 *   1. a bootstrap installer written in that platform's own language
 *      (PowerShell on Windows, `pkg` on Termux, `apk` on iSH, apt/Homebrew on
 *      Linux, ChromeOS and macOS) that installs the real software — git, a
 *      Python 3 with venv, Node, uv, Bun, Deno, Rust, the compilers;
 *   2. the whole package beside it: the Python brain, every installer script,
 *      the tests and the documentation, all as real files;
 *   3. the archive of the Freebuff (Codebuff) reference source, which the
 *      package documents and the installers unpack from the drive — so a build
 *      that already carries every other component is not left reaching for
 *      this one;
 *   4. a README naming, line by line, exactly what the bootstrap installs.
 *
 * As with every other download in the hub, the archive is assembled in the
 * browser from what the hub already serves. Nothing is uploaded to make it.
 */
import { stampOf } from "./backup";
import { PACKAGE_BINARY_FILES, PACKAGE_FILES } from "./offline-brain-files";
import { zipBlob, type ZipEntry } from "./zip";

export type PlatformId =
  | "windows"
  | "macos"
  | "chromeos"
  | "linux"
  | "android"
  | "ios"
  | "source";

/** One piece of real software the platform's own bootstrap installs. */
export type PlatformSoftware = { name: string; how: string };

export type Platform = {
  id: PlatformId;
  /** The name on the card. */
  label: string;
  /** A short name for chips and toasts. */
  short: string;
  /** Key into the icon map on the page. */
  icon: string;
  /** One sentence: what this build is for. */
  blurb: string;
  /** Where the bundle runs. */
  runs: string;
  /** How the real software gets onto the machine, in one line. */
  method: string;
  /** The real software this build installs, each with the route it takes. */
  software: PlatformSoftware[];
  /** The command you run first — shown on the card, and in the README. */
  start: string;
  /** The bootstrap inside the bundle; null for the source-only build. */
  boot: string | null;
  /** What kind of script the bootstrap is. */
  kind: string;
};

/* ------------------------------------------------------------------ catalog */

export const PLATFORMS: Platform[] = [
  {
    id: "windows",
    label: "Microsoft Windows",
    short: "Windows",
    icon: "laptop",
    blurb:
      "Windows 10 and 11, 64-bit. Installs the software with winget, then runs the brain's own installers inside WSL.",
    runs: "Windows 10 / 11 on a PC or laptop",
    method: "winget, plus the official Bun and Deno installers",
    software: [
      { name: "Git", how: "winget install Git.Git — brings git, bash, tar and curl" },
      { name: "Python 3", how: "winget install Python.Python.3.12 — python3 with venv" },
      { name: "Node.js LTS", how: "winget install OpenJS.NodeJS.LTS — node and npm" },
      { name: "uv", how: "winget install astral-sh.uv — the Python package runner" },
      { name: "7-Zip", how: "winget install 7zip.7zip — archives" },
      { name: "Bun", how: "the official installer, irm bun.sh/install.ps1 | iex" },
      { name: "Deno", how: "the official installer, irm deno.land/install.ps1 | iex" },
      { name: "Ubuntu on WSL", how: "wsl --install -d Ubuntu, where the bash installers run" },
    ],
    start: "powershell -ExecutionPolicy Bypass -File install-windows.ps1",
    boot: "install-windows.ps1",
    kind: "PowerShell",
  },
  {
    id: "macos",
    label: "Apple macOS",
    short: "macOS",
    icon: "apple",
    blurb:
      "macOS on Apple silicon or Intel. Installs Homebrew, then the compilers and runtimes the stack needs.",
    runs: "macOS 12 or newer, Apple silicon or Intel",
    method: "Xcode command line tools and Homebrew",
    software: [
      { name: "Xcode command line tools", how: "xcode-select --install — clang, make and the SDK" },
      { name: "Homebrew", how: "the official install script, then brew shellenv" },
      { name: "Python 3, git, Node", how: "brew install python git node" },
      { name: "Build tools", how: "brew install cmake ninja jq ripgrep fd fzf" },
      { name: "uv", how: "the official installer, astral.sh/uv/install.sh" },
      { name: "Bun", how: "the official installer, bun.sh/install" },
      { name: "Deno", how: "the official installer, deno.land/install.sh" },
      { name: "Rust", how: "rustup, sh.rustup.rs" },
    ],
    start: "bash install-macos.sh",
    boot: "install-macos.sh",
    kind: "bash",
  },
  {
    id: "chromeos",
    label: "Chromebook (ChromeOS)",
    short: "ChromeOS",
    icon: "chrome",
    blurb:
      "A Chromebook's built-in Linux container. Installs the Debian packages straight from Google's Crostini terminal.",
    runs: "ChromeOS with the Linux development environment turned on",
    method: "apt inside the Crostini container",
    software: [
      { name: "Base tools", how: "apt install curl git tar xz-utils ca-certificates" },
      { name: "Python 3", how: "apt install python3 python3-venv python3-pip" },
      { name: "Compilers", how: "apt install build-essential" },
      { name: "uv", how: "the official installer, astral.sh/uv/install.sh" },
      { name: "Bun", how: "the official installer, bun.sh/install" },
      { name: "Deno", how: "the official installer, deno.land/install.sh" },
    ],
    start: "bash install-chromeos.sh",
    boot: "install-chromeos.sh",
    kind: "bash",
  },
  {
    id: "linux",
    label: "Linux",
    short: "Linux",
    icon: "terminal",
    blurb:
      "Debian, Ubuntu, Fedora, Arch or openSUSE, on a PC, laptop or server. The full stack, natively.",
    runs: "Linux on x86-64 or arm64",
    method: "apt, dnf, pacman or zypper, whichever the machine has",
    software: [
      { name: "Base tools", how: "the distribution package manager installs curl, git, tar, xz" },
      { name: "Python 3", how: "python3, python3-venv and pip from the distribution" },
      { name: "Compilers", how: "build-essential / gcc, make — for the Python wheels that need them" },
      { name: "uv", how: "the official installer, astral.sh/uv/install.sh" },
      { name: "Bun", how: "the official installer, bun.sh/install" },
      { name: "Deno", how: "the official installer, deno.land/install.sh" },
      { name: "Rust", how: "rustup, sh.rustup.rs" },
    ],
    start: "bash install-linux.sh",
    boot: "install-linux.sh",
    kind: "bash",
  },
  {
    id: "android",
    label: "Android",
    short: "Android",
    icon: "smartphone",
    blurb:
      "A phone or tablet, through Termux. Installs a real Python 3 and Node from Termux's own repository, then runs the brain.",
    runs: "Android 7 or newer, with Termux installed from F-Droid",
    method: "pkg (Termux's apt) — the real Android packages",
    software: [
      { name: "Python 3", how: "pkg install python" },
      { name: "Node.js LTS", how: "pkg install nodejs-lts" },
      { name: "git, curl, tar, xz", how: "pkg install git curl tar xz-utils" },
      { name: "Compilers", how: "pkg install clang binutils build-essential cmake ninja" },
      { name: "Command-line tools", how: "pkg install ripgrep fd fzf jq sqlite" },
      { name: "uv", how: "python3 -m pip install -U uv" },
    ],
    start: "bash install-termux.sh",
    boot: "install-termux.sh",
    kind: "bash (Termux)",
  },
  {
    id: "ios",
    label: "Apple iPhone & iPad",
    short: "iPhone / iPad",
    icon: "smartphone",
    blurb:
      "iOS in iSH, a real Alpine Linux shell, or a-Shell, which already carries Python 3. Runs the brain; the desktop toolchain stays on a computer.",
    runs: "iOS 15 or newer, with iSH or a-Shell from the App Store",
    method: "apk inside iSH — Alpine's own package manager",
    software: [
      { name: "bash, git, curl, tar", how: "apk add --no-cache bash git curl tar xz" },
      { name: "Python 3", how: "apk add --no-cache python3 py3-pip" },
      { name: "Node.js and npm", how: "apk add --no-cache nodejs npm" },
      { name: "Compilers", how: "apk add --no-cache build-base cmake" },
      { name: "Python 3 (on a-Shell)", how: "already installed — a-Shell ships Python and JavaScript" },
    ],
    start: "sh install-ios.sh",
    boot: "install-ios.sh",
    kind: "sh (iSH / a-Shell)",
  },
  {
    id: "source",
    label: "Open source — the code itself",
    short: "Open source",
    icon: "boxes",
    blurb:
      "The hub's own source, every file, plus a Dockerfile and a compose file that build and serve it. Read it, change it, self-host it.",
    runs: "Anywhere Docker runs — a server, a NAS, a laptop",
    method: "source code and a Docker kit, built from the live app",
    software: [
      { name: "The whole app", how: "every source file as text, straight from the running copy" },
      { name: "Dockerfile and compose file", how: "docker compose up --build serves it as it is" },
      { name: "The offline brain", how: "packed beside the app so a self-host can carry it too" },
    ],
    start: "docker compose up --build",
    boot: null,
    kind: "source archive",
  },
];

export const PLATFORM_BY_ID: Record<PlatformId, Platform> = Object.fromEntries(
  PLATFORMS.map((platform) => [platform.id, platform]),
) as Record<PlatformId, Platform>;

/**
 * Which build the device in front of you probably wants, so the picker opens on
 * the right one. Only a guess — every option stays one click away.
 */
export function guessPlatform(): PlatformId {
  if (typeof navigator === "undefined") return "linux";
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  // iPadOS reports itself as a Mac, and touches were not used to switch it off.
  if (/mac/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return "ios";
  if (/cros/.test(ua)) return "chromeos";
  if (/win/.test(ua)) return "windows";
  if (/mac/.test(ua)) return "macos";
  return "linux";
}

/* --------------------------------------------------------------- bootstraps */

/**
 * The three lines every shell bootstrap needs: where it is, a way to say
 * things, and a way to check whether a command exists.
 */
function shellPreamble(shebang = "#!/usr/bin/env bash"): string[] {
  return [
    shebang,
    "set -uo pipefail",
    "",
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$HERE"',
    "",
    'say()  { printf "\\n==> %s\\n" "$*"; }',
    'warn() { printf "    warn %s\\n" "$*" >&2; }',
    'have() { command -v "$1" >/dev/null 2>&1; }',
    "as_root() {",
    '  if [ "$(id -u)" = "0" ]; then "$@";',
    '  elif have sudo; then sudo "$@";',
    '  else warn "cannot run as root: $*"; return 1; fi',
    "}",
    "",
  ];
}

/** The tail every bash build shares: hand over to the package's own installer. */
function runPackage(modelSet: string): string[] {
  return [
    'if [ ! -f ./GET-EVERYTHING.sh ]; then',
    '  warn "GET-EVERYTHING.sh is not beside this script — the package did not unpack."',
    "  exit 1",
    "fi",
    "chmod +x GET-EVERYTHING.sh scripts/*.sh tests/*.sh 2>/dev/null || true",
    "",
    `export MODEL_SET="\${MODEL_SET:-${modelSet}}"`,
    'say "Installing the brain — software first, then the $MODEL_SET models"',
    'echo "    On this computer: base tools, system packages, language runtimes."',
    'echo "    On this drive:    the package, the Python environments, the model weights."',
    "echo",
    'exec ./GET-EVERYTHING.sh',
    "",
  ];
}

function linuxScript(source: string): string {
  return [
    ...shellPreamble(),
    "# ============================================================",
    "#  offline-ai-coding-brain — complete download for Linux",
    "# ============================================================",
    "#",
    "#   bash install-linux.sh                    # the small model set",
    "#   MODEL_SET=recommended bash install-linux.sh",
    "#   SKIP_MODELS=1 bash install-linux.sh       # software only, no weights",
    "#",
    `# Downloaded from: ${source}`,
    "",
    'say "Base tools"',
    "if have apt-get; then",
    "  as_root apt-get update -qq",
    "  as_root apt-get install -y curl git tar xz-utils ca-certificates python3 python3-venv python3-pip build-essential",
    "elif have dnf; then",
    "  as_root dnf install -y curl git tar xz ca-certificates python3 python3-pip gcc gcc-c++ make",
    "elif have pacman; then",
    "  as_root pacman -Sy --noconfirm curl git tar xz ca-certificates python python-pip base-devel",
    "elif have zypper; then",
    "  as_root zypper --non-interactive install curl git tar xz ca-certificates python3 python3-pip gcc make",
    "else",
    '  warn "no known package manager — install curl, git, tar and python3 yourself, then re-run."',
    "fi",
    "",
    'say "Language runtimes, from their own installers"',
    'have uv    || curl -LsSf https://astral.sh/uv/install.sh | sh || warn "uv did not install"',
    'have bun   || curl -fsSL https://bun.sh/install | bash || warn "Bun did not install"',
    'have deno  || curl -fsSL https://deno.land/install.sh | sh || warn "Deno did not install"',
    'have rustc || curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y || warn "Rust did not install"',
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"',
    "",
    ...runPackage("small"),
  ].join("\n");
}

function macosScript(source: string): string {
  return [
    ...shellPreamble(),
    "# ============================================================",
    "#  offline-ai-coding-brain — complete download for macOS",
    "# ============================================================",
    "#",
    "#   bash install-macos.sh                     # the small model set",
    "#   MODEL_SET=recommended bash install-macos.sh",
    "#   SKIP_MODELS=1 bash install-macos.sh        # software only, no weights",
    "#",
    `# Downloaded from: ${source}`,
    "",
    'say "Xcode command line tools (the macOS compiler)"',
    'if ! xcode-select -p >/dev/null 2>&1; then',
    '  xcode-select --install || warn "if a prompt appeared, finish it and re-run this script"',
    "fi",
    "",
    'say "Homebrew (the package manager for macOS)"',
    "if ! have brew; then",
    '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || warn "Homebrew did not finish installing"',
    "fi",
    '[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"   # Apple silicon',
    '[ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"          # Intel',
    "",
    'say "Base tools and runtimes"',
    'if have brew; then',
    '  brew install python git node cmake ninja jq ripgrep fd fzf || warn "brew had trouble; carrying on"',
    "else",
    '  warn "Homebrew is not available — install python3, git and node by hand, then re-run."',
    "fi",
    "",
    'say "Language runtimes, from their own installers"',
    'have uv    || curl -LsSf https://astral.sh/uv/install.sh | sh || warn "uv did not install"',
    'have bun   || curl -fsSL https://bun.sh/install | bash || warn "Bun did not install"',
    'have deno  || curl -fsSL https://deno.land/install.sh | sh || warn "Deno did not install"',
    'have rustc || curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y || warn "Rust did not install"',
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"',
    "",
    ...runPackage("small"),
  ].join("\n");
}

function chromeosScript(source: string): string {
  return [
    ...shellPreamble(),
    "# ============================================================",
    "#  offline-ai-coding-brain — complete download for ChromeOS",
    "# ============================================================",
    "#",
    "# Runs inside the Chromebook's Linux container, run by the Terminal app.",
    "# Turn it on first: Settings → About ChromeOS → Developers → Linux.",
    "#",
    "#   bash install-chromeos.sh                   # the small model set",
    "#   SKIP_MODELS=1 bash install-chromeos.sh      # software only, no weights",
    "#",
    `# Downloaded from: ${source}`,
    "",
    'if [ -z "${CROS_USER_ID_HASH:-}" ] && [ ! -e /dev/.cros_milestone ]; then',
    '  warn "This does not look like a Chromebook."',
    '  warn "On a Chromebook: Settings → About ChromeOS → Developers →"',
    '  warn "Linux development environment → Turn on. Then open Terminal and re-run."',
    "fi",
    "",
    'say "Base tools (Debian, from Google\'s own repositories)"',
    "if have apt-get; then",
    "  as_root apt-get update -qq",
    "  as_root apt-get install -y curl git tar xz-utils ca-certificates python3 python3-venv python3-pip build-essential",
    "else",
    '  warn "apt is not here. This build expects the Linux container — see the note above."',
    "  exit 1",
    "fi",
    "",
    'say "Language runtimes, from their own installers"',
    'have uv    || curl -LsSf https://astral.sh/uv/install.sh | sh || warn "uv did not install"',
    'have bun   || curl -fsSL https://bun.sh/install | bash || warn "Bun did not install"',
    'have deno  || curl -fsSL https://deno.land/install.sh | sh || warn "Deno did not install"',
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.deno/bin:$PATH"',
    'echo "    note: the Chromebook has a small disk — keep the Linux container under 10 GB"',
    'echo "          and use MODEL_SET=small, or SKIP_MODELS=1 for the software alone."',
    "",
    ...runPackage("small"),
  ].join("\n");
}

function androidScript(source: string): string {
  return [
    "#!/data/data/com.termux/files/usr/bin/bash",
    "# ============================================================",
    "#  offline-ai-coding-brain — complete download for Android",
    "# ============================================================",
    "#",
    "# Run inside Termux. Install Termux from F-Droid: the Play Store build is",
    "# old and its packages no longer resolve.",
    "#",
    "#   bash install-termux.sh",
    "#",
    `# Downloaded from: ${source}`,
    "set -uo pipefail",
    "",
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$HERE" 2>/dev/null || true',
    'say()  { printf "\\n==> %s\\n" "$*"; }',
    'warn() { printf "    warn %s\\n" "$*" >&2; }',
    'have() { command -v "$1" >/dev/null 2>&1; }',
    "",
    'if [ ! -d /data/data/com.termux/files/usr ]; then',
    '  warn "This is the Android build: it runs in Termux, not in another terminal."',
    '  warn "Install Termux from F-Droid, open it, then run: bash install-termux.sh"',
    "  exit 1",
    "fi",
    "",
    'say "Termux packages — the real software for Android"',
    "pkg update -y || warn \"pkg update had trouble; carrying on\"",
    "pkg install -y python git nodejs-lts clang binutils build-essential cmake ninja \\",
    "  ripgrep fd fzf jq sqlite tar xz-utils curl openssl libffi zlib || \\",
    '  warn "some Termux packages did not install"',
    "",
    'say "Python tooling"',
    'python3 -m pip install -q -U pip wheel setuptools 2>/dev/null || warn "pip upgrade skipped"',
    'have uv || python3 -m pip install -q -U uv 2>/dev/null || warn "uv skipped"',
    "",
    'say "Room on this device"',
    'df -h "$HERE" 2>/dev/null || true',
    'echo "    The brain itself is small. The model weights are not: the smallest"',
    'echo "    set is tens of gigabytes, and a phone rarely has the room."',
    "echo",
    'echo "    This run installs the software and the tools only."',
    'echo "    To fetch weights anyway, edit MODEL_SET and SKIP_MODELS below."',
    "",
    'export SKIP_MODELS="${SKIP_MODELS:-1}"',
    'export MODEL_SET="${MODEL_SET:-tiny}"',
    "",
    'say "Checking the package"',
    'if [ ! -f ./brain/brain.py ]; then',
    '  warn "brain/brain.py is missing — unzip the whole download again."',
    "  exit 1",
    "fi",
    "",
    'say "The brain"',
    'python3 brain/brain.py version || warn "the brain did not run"',
    "",
    'if [ "${SKIP_MODELS}" = "1" ]; then',
    '  echo "    Models skipped (SKIP_MODELS=1). The toolchain is installed and the brain runs."',
    "else",
    '  echo "    Installing the model set: $MODEL_SET"',
    '  chmod +x GET-EVERYTHING.sh scripts/*.sh tests/*.sh 2>/dev/null || true',
    '  MODEL_SET="$MODEL_SET" SKIP_MODELS=0 ./scripts/download-models.sh || warn "the model download did not finish"',
    "fi",
    "",
    'echo',
    'echo "==> Start the brain with:"',
    'echo "      python3 brain/brain.py serve"',
    'echo "    It prints a pairing token; paste it once on the Local Brain page."',
    "",
  ].join("\n");
}

function iosScript(source: string): string {
  return [
    "#!/bin/sh",
    "# ============================================================",
    "#  offline-ai-coding-brain — complete download for iPhone & iPad",
    "# ============================================================",
    "#",
    "# Run inside iSH (a real Alpine Linux shell for iOS) or a-Shell.",
    "#",
    "#   sh install-ios.sh",
    "#",
    "# iSH cannot see your Files app directly. Copy the unpacked folder into",
    "# iSH's home first, or mount it:  mkdir -p /mnt && mount -t ios . /mnt",
    "#",
    `# Downloaded from: ${source}`,
    "set -u",
    "",
    'cd "$(dirname "$0")" 2>/dev/null || true',
    "",
    "# iOS has no Linux container of its own, so the toolchain is whatever the",
    "# shell app ships. iSH is Alpine: apk is the real package manager there.",
    "if command -v apk >/dev/null 2>&1; then",
    '  echo "==> Alpine packages (iSH)"',
    "  apk add --no-cache bash python3 py3-pip git curl tar xz nodejs npm build-base cmake || \\",
    '    echo "    warn: some packages did not install" >&2',
    "elif command -v python3 >/dev/null 2>&1; then",
    '  echo "==> a-Shell already ships Python 3 and JavaScript — nothing to install"',
    "else",
    '  echo "    warn: neither iSH (apk) nor a-Shell (python3) was found." >&2',
    '  echo "    Install iSH or a-Shell from the App Store, open this folder in it," >&2',
    '  echo "    and run this script again." >&2',
    "  exit 1",
    "fi",
    "",
    'echo',
    'echo "==> The brain (python3 brain/brain.py)"',
    'if [ -f ./brain/brain.py ]; then',
    '  python3 brain/brain.py version || echo "    warn: the brain did not run" >&2',
    "else",
    '  echo "    warn: brain/brain.py is missing — unzip the whole download again." >&2',
    "fi",
    "",
    'echo',
    'echo "==> Start it with:  python3 brain/brain.py serve"',
    'echo "    It prints a pairing token; paste it once on the Local Brain page."',
    'echo',
    'echo "    One honest limit: iOS will not run the desktop half of this stack."',
    'echo "    Apple does not allow a Linux container, GPU inference, or long"',
    'echo "    background downloads, so the model weights stay on a Mac, PC or"',
    'echo "    Linux machine. On the phone you get the brain and its tools."',
    "",
  ].join("\n");
}

function windowsScript(source: string): string {
  return [
    "# ============================================================",
    "#  offline-ai-coding-brain - complete download for Windows",
    "# ============================================================",
    "#",
    "# Open PowerShell in this folder and run:",
    "#",
    "#     powershell -ExecutionPolicy Bypass -File install-windows.ps1",
    "#",
    "# It installs the software with winget, then runs the brain's own",
    "# installers inside WSL, which is where its bash scripts belong.",
    "#",
    "#   $env:MODEL_SET = 'recommended'   before running, for a bigger set",
    "#   $env:SKIP_MODELS = '1'           for the software alone",
    "#",
    `# Downloaded from: ${source}`,
    "",
    '$ErrorActionPreference = "Continue"',
    "$here = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "Set-Location $here",
    "",
    'function Say($m)  { Write-Host "`n==> $m" -ForegroundColor Cyan }',
    'function Warn($m) { Write-Host "    warn $m" -ForegroundColor Yellow }',
    "function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }",
    "",
    'Say "The Windows package manager (winget)"',
    "if (-not (Have winget)) {",
    '  Warn "winget is missing - install App Installer from the Microsoft Store, then re-run."',
    "}",
    "",
    'Say "The software this build installs"',
    "$packages = @(",
    '  "Git.Git",             # git, plus bash, tar and curl',
    '  "Python.Python.3.12",  # python3 with venv',
    '  "OpenJS.NodeJS.LTS",   # node and npm',
    '  "astral-sh.uv",        # the Python package runner',
    '  "7zip.7zip"            # archives',
    ")",
    "foreach ($id in $packages) {",
    "  if (Have winget) {",
    '    Write-Host "    winget install $id"',
    "    winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent",
    "  }",
    "}",
    "",
    "# Bun and Deno are not on every winget channel, so they come from their own",
    "# official installers, exactly as their documentation gives them.",
    'Say "Bun and Deno"',
    'if (-not (Have bun))  { try { irm bun.sh/install.ps1 | iex } catch { Warn "Bun did not install" } }',
    'if (-not (Have deno)) { try { irm https://deno.land/install.ps1 | iex } catch { Warn "Deno did not install" } }',
    "",
    'Say "WSL - where the brain\'s installers run"',
    "if (Have wsl) {",
    '  wsl --install -d Ubuntu    # a no-op when Ubuntu is already installed',
    '  $wslPath = "/mnt/" + $here.Substring(0,1).ToLower() + $here.Substring(2).Replace("\\", "/")',
    '  Write-Host "    running the installers inside WSL at $wslPath"',
    `  $inner = 'cd ''__HERE__'' && chmod +x GET-EVERYTHING.sh scripts/*.sh tests/*.sh 2>/dev/null; MODEL_SET=\${MODEL_SET:-small} SKIP_MODELS=\${SKIP_MODELS:-0} ./GET-EVERYTHING.sh'`,
    "  $inner = $inner.Replace('__HERE__', $wslPath)",
    "  wsl -e bash -lc $inner",
    "} else {",
    '  Warn "WSL is not installed. In an Administrator PowerShell run:  wsl --install"',
    '  Warn "Restart when it asks, open Ubuntu once, then run this script again."',
    '  Warn "Everything else is installed already; only the bash installers need WSL."',
    "}",
    "",
    'Say "Done"',
    'Write-Host "    Start the brain inside WSL with:  python3 brain/brain.py serve"',
    'Write-Host "    It prints a pairing token; paste it once on the Local Brain page."',
    "",
  ].join("\n");
}

/** The bootstrap for a platform, or null when the build is source-only. */
export function platformBootstrap(
  platform: Platform,
  source: string,
): string | null {
  switch (platform.id) {
    case "windows":
      return windowsScript(source);
    case "macos":
      return macosScript(source);
    case "chromeos":
      return chromeosScript(source);
    case "linux":
      return linuxScript(source);
    case "android":
      return androidScript(source);
    case "ios":
      return iosScript(source);
    case "source":
      return null;
  }
}

/* ------------------------------------------------------------ the README */

/** The `START-HERE.md` that sits at the top of a platform bundle. */
export function platformReadme(
  platform: Platform,
  source: string,
  missing: string[],
): string {
  const lines: string[] = [
    `# offline-ai-coding-brain — the complete ${platform.label} download`,
    "",
    platform.blurb,
    "",
    `- Runs on: ${platform.runs}`,
    `- How the software arrives: ${platform.method}`,
    `- Packed from: ${source}`,
    "",
  ];

  if (platform.software.length) {
    lines.push(
      "## The software this build installs",
      "",
      "Each line below is installed by the script in this folder, from that",
      "project's own source. Nothing here is a bundled binary: the script fetches",
      "and installs each one on the machine, which is what keeps the download",
      "small and the software current.",
      "",
    );
    for (const item of platform.software) {
      lines.push(`- **${item.name}** — ${item.how}`);
    }
    lines.push("");
  }

  lines.push("## Start here", "", "```", platform.start, "```", "");

  if (platform.id === "windows") {
    lines.push(
      "Run that in PowerShell, in this folder. It installs the software above",
      "with winget, then runs the brain's bash installers through WSL — turn WSL",
      "on first if it is not already there (`wsl --install` in an Administrator",
      "PowerShell, then restart).",
      "",
    );
  } else if (platform.id === "chromeos") {
    lines.push(
      "Run that in the Chromebook's Terminal app, from this folder. If the",
      "terminal is not there yet: Settings → About ChromeOS → Developers →",
      "Linux development environment → Turn on.",
      "",
    );
  } else if (platform.id === "android") {
    lines.push(
      "Run that inside Termux, from this folder. Termux must come from F-Droid,",
      "not the Play Store. Android usually has no room for the model weights, so",
      "this build installs the software and the tools and leaves the weights",
      "alone; change `SKIP_MODELS` in the script if you want them.",
      "",
    );
  } else if (platform.id === "ios") {
    lines.push(
      "Run that inside iSH or a-Shell. iSH needs the folder copied into its own",
      "home, or mounted with `mkdir -p /mnt && mount -t ios . /mnt`. iOS runs the",
      "brain and its tools; the model weights and the desktop toolchain stay on a",
      "Mac, a PC or a Linux machine.",
      "",
    );
  } else if (platform.id === "macos") {
    lines.push(
      "Run that in Terminal, from this folder. It installs Homebrew if it is not",
      "there, which will ask for your password once.",
      "",
    );
  } else {
    lines.push(
      "Run that in a terminal, from this folder. It installs what it needs and",
      "then hands over to the package's own installer.",
      "",
    );
  }

  lines.push(
    "## What is in this folder",
    "",
    "- `START-HERE.md` — this file.",
  );
  if (platform.boot) {
    lines.push(
      `- \`${platform.boot}\` — the ${platform.kind} installer for ${platform.label}.`,
    );
  }
  lines.push(
    "- `brain/` — the Python brain: the part that runs, with no dependencies but",
    "  Python 3 itself.",
    "- `scripts/` — every installer (coding, browser, terminal and research",
    "  tools, the model runtimes and the model downloader) plus `lib.sh`.",
    "- `documentation/`, and a README for each part of the stack.",
    "- `models/manifest.json` — every model the downloader can fetch, with its",
    "  size and license.",
    "- `source/freebuff-source.zip` — the Freebuff (Codebuff) reference source",
    "  itself, Apache-2.0, in this folder. `scripts/capture-freebuff-source.sh`",
    "  unpacks it onto the drive, so nothing here is fetched when you run the",
    "  installers.",
    "",
    "## How much to download",
    "",
    "    MODEL_SET=tiny         ./install-*.sh    #  5 models, ~62 GB",
    "    MODEL_SET=small        ./install-*.sh    #  4 models, ~102 GB   (the default)",
    "    MODEL_SET=recommended  ./install-*.sh    # 14 models, ~445 GB",
    "    MODEL_SET=all          ./install-*.sh    # 32 models, ~1.7 TB",
    "    SKIP_MODELS=1          ./install-*.sh    # software only, no weights",
    "",
  );

  if (missing.length) {
    lines.push(
      "## Not in this copy",
      "",
      "These package files could not be read when the archive was made — fetch",
      "them from the hub's Offline Brain page:",
      "",
    );
    for (const path of missing) lines.push(`- ${path}`);
    lines.push("");
  } else {
    lines.push(
      "Complete: every packaged file is in this archive — the brain, every",
      "installer and the reference source archive — and the script beside this",
      "README installs the software to run them. Nothing here has to be fetched",
      "before it will work.",
      "",
    );
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------- the bundle */

/**
 * One platform's complete download: the platform's own bootstrap, a README
 * naming everything it installs, and the whole package beside them.
 *
 * `fetchFile` reads a packaged file (the page passes a fetch against
 * `/offline-brain/`) and `fetchBinary` reads the ones that are not text, so the
 * source archive travels as its own bytes. Anything that cannot be read is
 * reported rather than quietly left out.
 */
export async function platformBundleZip(
  platform: Platform,
  fetchFile: (path: string) => Promise<string | null>,
  at: string,
  source: string,
  fetchBinary: (path: string) => Promise<Uint8Array | null> = async () => null,
): Promise<{ blob: Blob; fetched: number; missing: string[] }> {
  const root = `offline-brain-${platform.id}-${stampOf(at)}`;
  const entries: ZipEntry[] = [];
  const missing: string[] = [];
  let fetched = 0;

  for (const path of PACKAGE_FILES) {
    const text = await fetchFile(path);
    if (text === null) {
      missing.push(path);
      continue;
    }
    entries.push({ path: `${root}/${path}`, data: text });
    fetched += 1;
  }

  for (const path of PACKAGE_BINARY_FILES) {
    const bytes = await fetchBinary(path);
    if (bytes === null) {
      missing.push(path);
      continue;
    }
    entries.push({ path: `${root}/${path}`, data: bytes });
    fetched += 1;
  }

  // The README first, then the platform's own installer, then the package —
  // so the archive unpacks with the two things you need on top.
  const head: ZipEntry[] = [
    { path: `${root}/START-HERE.md`, data: platformReadme(platform, source, missing) },
  ];
  const boot = platformBootstrap(platform, source);
  if (boot && platform.boot) {
    head.push({ path: `${root}/${platform.boot}`, data: boot });
  }

  return {
    blob: zipBlob([...head, ...entries], new Date(at)),
    fetched,
    missing,
  };
}

/** The file name a platform bundle arrives under. */
export function platformBundleName(platform: Platform, at: string): string {
  return `offline-brain-${platform.id}-${stampOf(at)}.zip`;
}
