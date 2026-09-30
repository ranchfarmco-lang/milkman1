/**
 * The offline-ai-coding-brain catalog.
 *
 * Every entry is one downloadable thing. Some are real files that ship with the
 * project (served from `/offline-brain/...`); the rest are components that are
 * installed on your own machine, and for those the button hands you a ready
 * shell script that installs exactly that component.
 *
 * Nothing here talks to a cloud service. The scripts fetch open-source packages
 * and open-weight models from their official sources on your computer.
 */

/** Where the packaged files are served from (see `public/offline-brain/`). */
export const BRAIN_BASE = "/offline-brain";

/**
 * Your VPN link. It sits at the top of the Offline Brain page, and the Control
 * Room's VPN switch opens it. Change these two lines to point at your own link
 * and name.
 */
export const VPN_URL = "https://protonvpn.com/";
export const VPN_NAME = "Proton VPN";

/** Your email link — creating a Proton account. Sits just under the VPN card. */
export const EMAIL_URL = "https://account.proton.me/mail";
export const EMAIL_NAME = "Proton Mail";

/**
 * "Everything" is one self-extracting shell script, packed in the browser from
 * the package the hub serves. Download it to the drive, run it there, and the
 * package, the software and the models all land on that drive.
 */
export const FULL_PACKAGE = "install-offline-brain.sh";

/**
 * Its weight: the whole package (68 files — the brain, every installer and the
 * Freebuff source archive) plus the unpacking wrapper. It is one script, not a
 * zip: the text files go in as here-documents and the archive as base64, so
 * running it needs nothing but bash and `base64`. It still fetches the software
 * and the model weights, because those are tens of gigabytes and belong on the
 * machine, not in a download.
 */
export const FULL_PACKAGE_SIZE = "~27 MB";

/**
 * The three editions, and what each one is for.
 *
 * Every download on the Offline Brain page is one of these, so "which one do I
 * want" has one answer that is the same everywhere it is asked. `both` is the
 * complete system — the web edition AND the local edition in one archive —
 * which is what the Offline Brain page calls "Everything".
 */
export type EditionId = "web" | "local" | "both";

export type Edition = {
  id: EditionId;
  label: string;
  /** One sentence: what you get, and what it runs on. */
  what: string;
  /** What it holds, as short names the page can list. */
  includes: string[];
  /** Where its download is built. */
  build: "web-zip" | "local-installer" | "everything-zip";
};

export const EDITIONS: Edition[] = [
  {
    id: "web",
    label: "Web browser (online)",
    what: "The whole hub as a web app — every page, the assistant and the builder, the browser brain with its offline memory and workspace, and the 27-language compiler runner through the web.",
    includes: ["the app", "browser brain", "offline workspace", "compiler runner", "your data"],
    build: "web-zip",
  },
  {
    id: "local",
    label: "Local (offline)",
    what: "The Python brain and every installer — coding, browser, terminal and research tools, model runtimes, and the model downloader — for a machine you own.",
    includes: ["Python brain", "all installers", "model sets", "capability map", "smoke tests"],
    build: "local-installer",
  },
  {
    id: "both",
    label: "Everything — web + local",
    what: "Both editions in one archive: the app and the browser brain, AND the local Python brain with every installer and the model downloader. This is the complete system.",
    includes: ["the app", "browser brain", "Python brain", "all installers", "model sets", "your data"],
    build: "everything-zip",
  },
];

/** The model sets the installer can fetch, and what each one costs in disk. */
export const MODEL_SETS: {
  id: string;
  label: string;
  size: string;
  /** Rough disk need in GB — models plus the Python environments. */
  gb: number;
  note: string;
}[] = [
  { id: "tiny", label: "Tiny", size: "~62 GB", gb: 72, note: "5 models · CPU or 8 GB VRAM" },
  { id: "small", label: "Small", size: "~102 GB", gb: 112, note: "4 models · 16 GB VRAM" },
  {
    id: "recommended",
    label: "Recommended",
    size: "~445 GB",
    gb: 455,
    note: "14 models · 24 GB VRAM",
  },
  { id: "all", label: "Everything", size: "~1.7 TB", gb: 1720, note: "32 models · multi-GPU" },
];

/**
 * Everything the stack needs in order to run, split by where each piece lives.
 *
 * "drive" — written next to the installer, so it travels with the external disk:
 *           the package, the Python environments and the model weights.
 * "host"  — installed by the OS package manager on the computer that runs it:
 *           base tools, compilers, system packages and language runtimes.
 *
 * `GET-EVERYTHING.sh` (and the one-file installer before it) installs or
 * downloads every row below — this is the checklist, not a wish list.
 */
export type Requirement = {
  name: string;
  blurb: string;
  where: "drive" | "host";
  size: string;
  required: boolean;
};

export const REQUIREMENTS: Requirement[] = [
  {
    name: "Model weights",
    blurb:
      "Open-weight safetensors + tokenizers, one folder per model. The set you pick decides how much.",
    where: "drive",
    size: "~62 GB – 1.7 TB",
    required: true,
  },
  {
    name: "Python environments",
    blurb:
      "A venv per component (runtimes, reasoning, agents, libraries), created by the installers beside the models.",
    where: "drive",
    size: "~8–12 GB",
    required: true,
  },
  {
    name: "Package + Freebuff source",
    blurb:
      "The extracted package, its docs and the full Freebuff/Codebuff reference source tree.",
    where: "drive",
    size: "~25 MB",
    required: true,
  },
  {
    name: "Base tools",
    blurb:
      "bash, curl, git, tar, python3 + venv and CA certificates — what the installer needs before it can install anything.",
    where: "host",
    size: "~150 MB",
    required: true,
  },
  {
    name: "System packages",
    blurb:
      "ripgrep, fd, fzf, ctags, global, jq, tmux, sqlite3, archives and the build toolchain (gcc/clang, make, cmake, ninja, pkg-config).",
    where: "host",
    size: "~2–5 GB",
    required: true,
  },
  {
    name: "Language runtimes",
    blurb: "Python + uv, Node.js, Bun, Deno, Rust and Go — installed by install-supporting.sh.",
    where: "host",
    size: "~3–5 GB",
    required: true,
  },
  {
    name: "Container runtime (Docker)",
    blurb:
      "Optional. Runs the page's self-hosted services as images — SearXNG search, Qdrant/Milvus/Weaviate, Meilisearch, Open WebUI and DevDocs. Everything else runs natively.",
    where: "host",
    size: "~500 MB – 2 GB",
    required: false,
  },
  {
    name: "GPU driver / CUDA or Metal",
    blurb:
      "Comes with your OS or the NVIDIA driver. CPU-only installs skip it; GPU inference needs it.",
    where: "host",
    size: "varies",
    required: false,
  },
  {
    name: "Browsers for automation",
    blurb: "Chromium, Firefox and WebKit downloaded by Playwright for the browser-use agents.",
    where: "host",
    size: "~1–2 GB",
    required: false,
  },
  {
    name: "Databases & engines",
    blurb:
      "SQLite always; PostgreSQL + pgvector, Redis and Qdrant are optional server-mode pieces.",
    where: "host",
    size: "~1–2 GB",
    required: false,
  },
];

/** Everything the installer needs, grouped by where it lands. */
export const REQUIREMENTS_BY_PLACE = {
  drive: REQUIREMENTS.filter((r) => r.where === "drive"),
  host: REQUIREMENTS.filter((r) => r.where === "host"),
};

/** Every file the catalog references, for the "everything" bundle. */
export function allPackagedFiles(): string[] {
  const files = new Set<string>();
  for (const group of BRAIN_GROUPS) {
    if (group.file) files.add(group.file);
    for (const item of group.items) if (item.file) files.add(item.file);
  }
  return [...files];
}

/**
 * Exact sizes of the packaged files, so every button can say what it hands you
 * before you press it.
 */
export const FILE_SIZES: Record<string, string> = {
  "GET-EVERYTHING.sh": "2.6 KB",
  "README.md": "5.0 KB",
  "agents/README.md": "1.3 KB",
  "browser-tools/README.md": "934 B",
  "coding-tools/README.md": "1.0 KB",
  "configuration/README.md": "429 B",
  "configuration/catalog.json": "4.6 KB",
  "configuration/env.sh": "217 B",
  "configuration/litellm.example.yaml": "1.1 KB",
  "context/README.md": "957 B",
  "databases/README.md": "1.1 KB",
  "documentation/ARCHITECTURE.md": "5.1 KB",
  "documentation/CAPABILITY-MAP.md": "5.6 KB",
  "documentation/LICENSES.md": "2.4 KB",
  "documentation/OFFLINE-GUIDE.md": "2.4 KB",
  "documentation/README.md": "355 B",
  "embeddings/README.md": "718 B",
  "file-tools/README.md": "649 B",
  "libraries/README.md": "711 B",
  "memory/README.md": "838 B",
  "model-runtimes/README.md": "1.1 KB",
  "models/README.md": "1.0 KB",
  "models/manifest.json": "9.4 KB",
  "orchestration/README.md": "928 B",
  "reasoning/README.md": "1.0 KB",
  "research-tools/README.md": "720 B",
  "runtimes/README.md": "844 B",
  "scripts/README.md": "1.4 KB",
  "scripts/capture-freebuff-source.sh": "1.1 KB",
  "scripts/download-models.sh": "3.9 KB",
  "scripts/install-agents.sh": "2.8 KB",
  "scripts/install-browser-tools.sh": "2.2 KB",
  "scripts/install-coding-tools.sh": "3.0 KB",
  "scripts/install-context-memory.sh": "2.3 KB",
  "scripts/install-file-tools.sh": "1.5 KB",
  "scripts/install-libraries.sh": "1.1 KB",
  "scripts/install-orchestration.sh": "1.5 KB",
  "scripts/install-reasoning.sh": "1.7 KB",
  "scripts/install-research-tools.sh": "1.4 KB",
  "scripts/install-runtimes.sh": "3.4 KB",
  "scripts/install-supporting.sh": "3.4 KB",
  "scripts/install-terminal-tools.sh": "1.7 KB",
  "scripts/lib.sh": "3.5 KB",
  "scripts/serve-local-model.sh": "2.8 KB",
  "scripts/setup-all.sh": "998 B",
  "scripts/verify.sh": "2.4 KB",
  "source/freebuff-source.zip": "18.9 MB",
  "brain/README.md": "17.1 KB",
  "brain/brain.py": "28.6 KB",
  "brain/src/__init__.py": "523 B",
  "brain/src/agent.py": "24.8 KB",
  "brain/src/capabilities.py": "14.9 KB",
  "brain/src/config.py": "10.4 KB",
  "brain/src/connectors.py": "20.5 KB",
  "brain/src/diagnostics.py": "18.0 KB",
  "brain/src/info.py": "24.1 KB",
  "brain/src/providers.py": "12.6 KB",
  "brain/src/scheduler.py": "11.4 KB",
  "brain/src/server.py": "32.1 KB",
  "brain/src/store.py": "26.1 KB",
  "brain/src/tools.py": "31.6 KB",
  "brain/src/updater.py": "14.8 KB",
  "brain/tests/test_brain.py": "31.7 KB",
  "search/README.md": "742 B",
  "source/README.md": "1.7 KB",
  "terminal-tools/README.md": "668 B",
  "tests/README.md": "508 B",
  "tests/smoke.sh": "3.3 KB",
  [FULL_PACKAGE]: FULL_PACKAGE_SIZE,
};

/** The size shown beside an item's button, when the catalog knows it. */
export function sizeOf(item: BrainItem): string | undefined {
  return item.size ?? (item.file ? FILE_SIZES[item.file] : undefined);
}

/** The size shown beside a category installer. */
export function groupSize(group: BrainGroup): string | undefined {
  return group.file ? FILE_SIZES[group.file] : undefined;
}

export type BrainItem = {
  name: string;
  blurb: string;
  /** License, parameters or other one-line note. */
  meta?: string;
  /** How big the download is — what lands on your disk. */
  size?: string;
  /** A file under `/offline-brain/` — downloaded as-is. */
  file?: string;
  /** Shell commands — handed to you as a runnable `.sh`. */
  script?: string;
  /** Upstream project page. */
  repo?: string;
};

export type BrainGroup = {
  id: string;
  title: string;
  /** Key into the icon map in the page component. */
  icon: string;
  summary: string;
  /** The installer that covers the whole group, if one exists. */
  file?: string;
  items: BrainItem[];
};

/* ------------------------------------------------------------------ helpers */

function script(title: string, body: string) {
  return `#!/usr/bin/env bash
# offline-ai-coding-brain \u2014 ${title}
# Run this from the folder that holds your models/ and scripts/ directories.
set -euo pipefail
${body.trim()}
`;
}

function pip(name: string, packages: string) {
  return script(
    `install ${name}`,
    `python3 -m venv "${name}" 2>/dev/null || true
. "./${name}/bin/activate"
python -m pip install -q -U pip
python -m pip install -U ${packages}
echo "done: ${name}"`,
  );
}

function apt(name: string, pkg: string, brew = pkg) {
  return script(
    `install ${name}`,
    `if command -v apt-get >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y ${pkg}
elif command -v brew >/dev/null; then brew install ${brew}
elif command -v dnf >/dev/null; then sudo dnf install -y ${pkg}
else echo "install ${name} with your package manager"; fi`,
  );
}

function npm(name: string, pkg: string) {
  return script(
    `install ${name}`,
    `command -v bun >/dev/null && PM=bun || PM=npm
$PM install -g ${pkg}
echo "done: ${name}"`,
  );
}

function repo(name: string, ownerRepo: string, branch = "main") {
  return script(
    `fetch ${name} source`,
    `mkdir -p "${name}" && cd "${name}"
curl -sSL "https://codeload.github.com/${ownerRepo}/tar.gz/refs/heads/${branch}" \\
  | tar xz --strip-components=1
echo "fetched ${ownerRepo} into ./${name}"`,
  );
}

/** A model download script (official weights from Hugging Face). */
function hfModel(
  id: string,
  repo_: string,
  gated: boolean,
  needsPip = true,
) {
  return script(
    `download model ${id}`,
    `${
      gated
        ? `echo ">>> ${id} is gated: accept its license on huggingface.co, then run 'hf auth login'."`
        : ""
    }
${needsPip ? `python3 -m pip install --user -q -U "huggingface_hub[cli]" || true` : ""}
CLI=huggingface-cli; command -v hf >/dev/null 2>&1 && CLI=hf
mkdir -p "models/${id}"
$CLI download "${repo_}" --local-dir "models/${id}"
echo "saved to models/${id}"`,
  );
}

/* -------------------------------------------------------------------- models */

const MODELS: Array<[string, string, string, string, boolean, string]> = [
  ["qwen3-coder-30b-a3b", "Qwen/Qwen3-Coder-30B-A3B-Instruct", "30B MoE (3B active)", "Apache-2.0", false, "agentic coding, tool use, long context"],
  ["qwen2.5-coder-32b", "Qwen/Qwen2.5-Coder-32B-Instruct", "32B", "Apache-2.0", false, "coding, analysis, debugging, review"],
  ["qwen2.5-coder-14b", "Qwen/Qwen2.5-Coder-14B-Instruct", "14B", "Apache-2.0", false, "coding, laptop friendly"],
  ["qwen2.5-coder-7b", "Qwen/Qwen2.5-Coder-7B-Instruct", "7B", "Apache-2.0", false, "coding, smallest useful"],
  ["deepseek-r1", "deepseek-ai/DeepSeek-R1", "671B MoE", "MIT", false, "frontier deep reasoning"],
  ["deepseek-r1-distill-qwen-32b", "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", "32B", "MIT", false, "deep reasoning on one GPU"],
  ["deepseek-r1-distill-qwen-14b", "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B", "14B", "MIT", false, "deep reasoning, small"],
  ["deepseek-r1-distill-qwen-7b", "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", "7B", "MIT", false, "deep reasoning, tiny"],
  ["qwq-32b", "Qwen/QwQ-32B", "32B", "Apache-2.0", false, "reasoning + tool use"],
  ["qwq-32b-preview", "Qwen/QwQ-32B-Preview", "32B", "Apache-2.0", false, "earlier reasoning preview"],
  ["phi-4", "microsoft/phi-4", "14B", "MIT", false, "reasoning + code"],
  ["qwen3-32b", "Qwen/Qwen3-32B", "32B", "Apache-2.0", false, "reasoning, planning, tool use"],
  ["qwen3-8b", "Qwen/Qwen3-8B", "8B", "Apache-2.0", false, "reasoning, tool use, small"],
  ["llama-3.3-70b-instruct", "meta-llama/Llama-3.3-70B-Instruct", "70B", "Llama-3.3 Community", true, "general reasoning, planning"],
  ["llama-3.1-8b-instruct", "meta-llama/Llama-3.1-8B-Instruct", "8B", "Llama-3.1 Community", true, "tool use"],
  ["hermes-3-llama-3.1-8b", "NousResearch/Hermes-3-Llama-3.1-8B", "8B", "Llama-3.1 Community", false, "function calling"],
  ["qwen2.5-72b-instruct", "Qwen/Qwen2.5-72B-Instruct", "72B", "Qwen License", false, "general reasoning"],
  ["qwen2.5-7b-instruct-1m", "Qwen/Qwen2.5-7B-Instruct-1M", "7B", "Apache-2.0", false, "1M-token long context"],
  ["qwen2.5-vl-7b-instruct", "Qwen/Qwen2.5-VL-7B-Instruct", "7B", "Apache-2.0", false, "vision + code"],
  ["llama-3.2-11b-vision-instruct", "meta-llama/Llama-3.2-11B-Vision-Instruct", "11B", "Llama-3.2 Community", true, "vision"],
  ["gemma-3-27b-it", "google/gemma-3-27b-it", "27B", "Gemma Terms", true, "reasoning + vision"],
  ["starcoder2-15b", "bigcode/starcoder2-15b-instruct-v0.1", "15B", "BigCode OpenRAIL-M", false, "code completion"],
  ["codellama-13b-instruct", "codellama/CodeLlama-13b-Instruct-hf", "13B", "Llama-2 Community", false, "code generation"],
  ["bge-m3", "BAAI/bge-m3", "568M", "MIT", false, "embeddings (dense + sparse)"],
  ["bge-large-en-v1.5", "BAAI/bge-large-en-v1.5", "335M", "MIT", false, "embeddings"],
  ["e5-large-v2", "intfloat/e5-large-v2", "335M", "MIT", false, "embeddings"],
  ["nomic-embed-text-v1.5", "nomic-ai/nomic-embed-text-v1.5", "137M", "Apache-2.0", false, "long-context embeddings"],
  ["minilm-l6", "sentence-transformers/all-MiniLM-L6-v2", "22M", "Apache-2.0", false, "fast CPU embeddings"],
  ["jina-embeddings-v3", "jinaai/jina-embeddings-v3", "570M", "CC-BY-NC-4.0", false, "non-commercial embeddings"],
  ["bge-reranker-v2-m3", "BAAI/bge-reranker-v2-m3", "568M", "Apache-2.0", false, "reranking"],
  ["bge-reranker-large", "BAAI/bge-reranker-large", "560M", "MIT", false, "reranking"],
  ["mxbai-rerank-large-v1", "mixedbread-ai/mxbai-rerank-large-v1", "435M", "Apache-2.0", false, "reranking"],
];

/** How much each model puts on your disk (full precision weights). */
const MODEL_SIZES: Record<string, string> = {
  "qwen3-coder-30b-a3b": "~61 GB",
  "qwen2.5-coder-32b": "~65 GB",
  "qwen2.5-coder-14b": "~29 GB",
  "qwen2.5-coder-7b": "~15 GB",
  "deepseek-r1": "~685 GB",
  "deepseek-r1-distill-qwen-32b": "~65 GB",
  "deepseek-r1-distill-qwen-14b": "~29 GB",
  "deepseek-r1-distill-qwen-7b": "~15 GB",
  "qwq-32b": "~65 GB",
  "qwq-32b-preview": "~65 GB",
  "phi-4": "~29 GB",
  "qwen3-32b": "~65 GB",
  "qwen3-8b": "~16 GB",
  "llama-3.3-70b-instruct": "~141 GB",
  "llama-3.1-8b-instruct": "~16 GB",
  "hermes-3-llama-3.1-8b": "~16 GB",
  "qwen2.5-72b-instruct": "~145 GB",
  "qwen2.5-7b-instruct-1m": "~15 GB",
  "qwen2.5-vl-7b-instruct": "~17 GB",
  "llama-3.2-11b-vision-instruct": "~22 GB",
  "gemma-3-27b-it": "~54 GB",
  "starcoder2-15b": "~31 GB",
  "codellama-13b-instruct": "~26 GB",
  "bge-m3": "~2.3 GB",
  "bge-large-en-v1.5": "~1.3 GB",
  "e5-large-v2": "~1.3 GB",
  "nomic-embed-text-v1.5": "~550 MB",
  "minilm-l6": "~90 MB",
  "jina-embeddings-v3": "~2.3 GB",
  "bge-reranker-v2-m3": "~2.3 GB",
  "bge-reranker-large": "~2.2 GB",
  "mxbai-rerank-large-v1": "~1.7 GB",
};

const modelItems: BrainItem[] = MODELS.map(
  ([id, repo_, params, license, gated, caps]) => ({
    name: id,
    blurb: caps,
    meta: `${params} · ${license}${gated ? " · gated" : ""}`,
    size: MODEL_SIZES[id] ?? "~15 GB",
    script: hfModel(id, repo_, gated),
    repo: `https://huggingface.co/${repo_}`,
  }),
);

/* --------------------------------------------------------------------- groups */

export const BRAIN_GROUPS: BrainGroup[] = [
  {
    id: "start",
    title: "Start here",
    icon: "rocket",
    summary:
      "The package itself: how it fits together, what it licenses, and the two scripts that install and verify everything.",
    items: [
      { name: "GET-EVERYTHING.sh", blurb: "One command: installs all the software and downloads every model into the folder you run it from. This is the one for an external drive.", meta: "run inside the extracted package", file: "GET-EVERYTHING.sh" },
      { name: "README.md", blurb: "What the package is and the five commands to run it.", file: "README.md" },
      { name: "Architecture", blurb: "How model → reasoning → agents → tools → files → terminal → review connect.", file: "documentation/ARCHITECTURE.md" },
      { name: "Capability map", blurb: "Every capability mapped to the component and source file that provides it.", file: "documentation/CAPABILITY-MAP.md" },
      { name: "Licenses", blurb: "License summary for the source, the models and every tool.", file: "documentation/LICENSES.md" },
      { name: "Offline guide", blurb: "Running fully offline, plus hardware sizing per model size.", file: "documentation/OFFLINE-GUIDE.md" },
      { name: "Catalog (JSON)", blurb: "Machine-readable index of installers and capabilities.", file: "configuration/catalog.json" },
      { name: "Models manifest (JSON)", blurb: "Every model with its repo, license, size and capability tags.", file: "models/manifest.json" },
      { name: "setup-all.sh", blurb: "Runs every installer in order. Idempotent.", file: "scripts/setup-all.sh" },
      { name: "verify.sh", blurb: "Reports which components and models are present.", file: "scripts/verify.sh" },
      { name: "smoke.sh", blurb: "Checks structure, JSON and script syntax.", file: "tests/smoke.sh" },
    ],
  },
  {
    id: "runtime",
    title: "The brain itself",
    icon: "circuit",
    summary:
      "The runnable half: a complete, offline-first AI in Python 3 and nothing else. No packages, no virtual environment, no account, no key. Start it with `python3 brain/brain.py serve` and pair the hub with it once — this is the piece that keeps working with the network unplugged.",
    items: [
      {
        name: "brain/README.md",
        blurb:
          "How it fits together: one brain and two hosts, every module explained, the API, the settings, and why each dependency was avoided.",
        meta: "read this first",
        file: "brain/README.md",
      },
      {
        name: "brain.py",
        blurb:
          "The whole system from a terminal: serve, ask, caps, doctor, tools, memory, connectors, schedule, update, repair. Every command works with no network.",
        meta: "python3 brain.py serve",
        file: "brain/brain.py",
      },
      {
        name: "Reasoning — agent.py",
        blurb:
          "plan → act → verify → record, with a local model or, when none is running, by choosing the tools itself and saying what it could not do.",
        meta: "with or without a model",
        file: "brain/src/agent.py",
      },
      {
        name: "Memory — store.py",
        blurb:
          "One SQLite file: memory, conversations, events, tool runs, capability snapshots, connectors, credentials and the task schedule. Full-text when SQLite has FTS5, plain matching when it does not.",
        meta: "sqlite3, from the standard library",
        file: "brain/src/store.py",
      },
      {
        name: "Capability discovery — capabilities.py",
        blurb:
          "CPU and instruction sets, memory, disk, GPUs, installed tools, languages, model servers and the network — cached, diffed, and used to decide.",
        meta: "knows the machine it is on",
        file: "brain/src/capabilities.py",
      },
      {
        name: "Model providers — providers.py",
        blurb:
          "Ollama, llama.cpp, vLLM, LM Studio, text-generation-webui and LiteLLM on one interface, all on loopback; plus any endpoint you add. No vendor SDK.",
        meta: "local first, keyed services last",
        file: "brain/src/providers.py",
      },
      {
        name: "Tools — tools.py",
        blurb:
          "The registry and the built-ins (files, shell, code, tests, memory, lookup), the guard rails, and loading tools the brain wrote for itself.",
        meta: "it can extend itself",
        file: "brain/src/tools.py",
      },
      {
        name: "Information access — info.py",
        blurb:
          "memory → workspace → cache → public → free → configured: the hierarchy, the on-disk cache with dates, and one urllib client with no dependency behind it.",
        meta: "no account needed for the first five",
        file: "brain/src/info.py",
      },
      {
        name: "Connectors — connectors.py",
        blurb:
          "Every external capability behind one replaceable slot, ranked local before free before keyed, with credentials resolved from the environment or a 0600 store.",
        meta: "swap a provider without a refactor",
        file: "brain/src/connectors.py",
      },
      {
        name: "The clock — scheduler.py",
        blurb:
          "Recurring work it runs without being asked: `every 15 minutes`, `hourly`, `daily at 07:30`. The schedule is a row in the database, a task is a question or a tool call, and a missed run is counted from now rather than replayed as a backlog.",
        meta: "a clock it owns, not cron",
        file: "brain/src/scheduler.py",
      },
      {
        name: "Packages — updater.py",
        blurb:
          "What is installed and what moved since last time, the package's own installers, and every connector currently in use next to the local or self-hosted thing that could replace it.",
        meta: "update check · update run",
        file: "brain/src/updater.py",
      },
      {
        name: "Self-diagnostics — diagnostics.py",
        blurb:
          "Findings with a suggested repair each, tool health, the independence gaps worth closing, and what changed since the last snapshot.",
        meta: "brain.py doctor",
        file: "brain/src/diagnostics.py",
      },
      {
        name: "API — server.py",
        blurb:
          "The endpoints both halves share — including the schedule and the package report — token auth, CORS, and the private-network header that lets the hub, served over https, reach loopback.",
        meta: "protocol brain/1",
        file: "brain/src/server.py",
      },
      {
        name: "Configuration — config.py",
        blurb:
          "Where the data and workspace live, what the brain is allowed to do, and the pairing token, created once and stored 0600.",
        meta: "BRAIN_HOME moves everything",
        file: "brain/src/config.py",
      },
      {
        name: "Tests — tests/test_brain.py",
        blurb:
          "62 tests, standard library only, no network: the store, the guard rails, a tool the brain writes for itself, the hierarchy, the agent with no model at all, the schedule, the package inventory, and the API over a real socket.",
        meta: "python3 -m unittest discover -s brain/tests",
        file: "brain/tests/test_brain.py",
      },
    ],
  },
  {
    id: "models",
    title: "Brains — models",
    icon: "brain",
    summary:
      "Open-weight models for reasoning, coding, agentic coding, planning, tool use, long context, vision, embeddings and reranking. Weights, tokenizers and configs download together.",
    items: modelItems,
  },
  {
    id: "model-runtimes",
    title: "Model runtimes",
    icon: "cpu",
    summary: "The software that actually runs local models.",
    file: "scripts/install-runtimes.sh",
    items: [
      { name: "llama.cpp", blurb: "GGUF inference on CPU, CUDA, Metal and Vulkan; ships llama-server.", meta: "MIT", script: repo("llama.cpp", "ggml-org/llama.cpp") },
      { name: "Ollama", blurb: "One-command local model manager and server.", meta: "MIT", script: script("install Ollama", 'curl -fsSL https://ollama.com/install.sh | sh') },
      { name: "Transformers", blurb: "Reference Python runtime for any Hugging Face repo.", meta: "Apache-2.0", script: pip("hf-runtime", '"transformers[torch]" accelerate sentencepiece safetensors "huggingface_hub[cli]"') },
      { name: "vLLM", blurb: "High-throughput GPU serving with PagedAttention.", meta: "Apache-2.0", script: pip("vllm-runtime", "vllm") },
      { name: "SGLang", blurb: "Fast serving with structured/constrained generation.", meta: "Apache-2.0", script: pip("sglang-runtime", '"sglang[all]"') },
      { name: "MLX / mlx-lm", blurb: "Apple-silicon native inference.", meta: "MIT", script: pip("mlx-runtime", "mlx mlx-lm") },
      { name: "llamafile", blurb: "Single-file model + runtime, nothing to install.", meta: "Apache-2.0", script: script("fetch llamafile", 'curl -fsSL -o llamafile https://github.com/Mozilla-Ocho/llamafile/releases/latest/download/llamafile && chmod +x llamafile && ./llamafile --version') },
      { name: "HF Text Embeddings Inference", blurb: "Serving endpoint for embedding and reranker models.", meta: "Apache-2.0", script: script("run TEI", 'docker run --rm -p 8080:80 -v "$PWD/models:/data" ghcr.io/huggingface/text-embeddings-inference:cpu-latest --model-id /data/bge-m3') },
      { name: "Tokenizers", blurb: "tokenizers, sentencepiece and tiktoken for every model family.", script: pip("tokenizers", "tokenizers sentencepiece tiktoken") },
    ],
  },
  {
    id: "reasoning",
    title: "Reasoning system",
    icon: "lightbulb",
    summary: "Planning, decomposition, multi-step reasoning, tool selection, verification and code review.",
    file: "scripts/install-reasoning.sh",
    items: [
      { name: "LangGraph", blurb: "Graph/state-machine agent loops, reflection, checkpoints.", meta: "MIT", script: pip("reasoning-langgraph", "langgraph langgraph-checkpoint-sqlite langchain langchain-core langchain-community") },
      { name: "DSPy", blurb: "Program/prompt optimisation to improve reasoning quality.", meta: "MIT", script: pip("reasoning-dspy", "dspy-ai") },
      { name: "Structured output", blurb: "Instructor, Outlines and guidance force valid tool calls and JSON.", script: pip("reasoning-structured", '"instructor[anthropic,google-genai]" pydantic "outlines[transformers]" guidance jsonschema') },
      { name: "Verification", blurb: "Guardrails AI, pyright, pytest and hypothesis for self-checking.", script: pip("reasoning-verify", "guardrails-ai pyright basedpyright pytest hypothesis") },
      { name: "Code review engines", blurb: "semgrep, reviewdog, bandit, ruff — static analysis for review agents.", script: script("install review tools", 'command -v semgrep >/dev/null || pip install -U semgrep\ncommand -v ruff >/dev/null || pip install -U ruff\ncommand -v bandit >/dev/null || pip install -U bandit\ncurl -sfL https://raw.githubusercontent.com/reviewdog/reviewdog/master/install.sh | sh -s -- -b ./bin') },
      { name: "Multi-agent frameworks", blurb: "AutoGen, CrewAI, PydanticAI, smolagents, Agno, CAMEL, MetaGPT and the OpenAI Agents SDK.", script: pip("reasoning-multiagent", '"autogen-agentchat" "autogen-ext[openai]" "crewai[tools]" pydantic-ai "smolagents[toolkit]" agno atomic-agents camel-ai metagpt openai-agents') },
    ],
  },
  {
    id: "agents",
    title: "Coding agents",
    icon: "bot",
    summary:
      "Downloadable agents for coding, planning, file discovery, research, testing, debugging, review and documentation. Point them at your local model with OPENAI_BASE_URL.",
    file: "scripts/install-agents.sh",
    items: [
      { name: "aider", blurb: "Terminal pair-programmer that edits a git repo.", meta: "Apache-2.0", script: pip("agents-aider", "aider-chat"), repo: "https://aider.chat" },
      { name: "OpenHands", blurb: "Full autonomous software-agent platform.", meta: "MIT", script: repo("OpenHands", "All-Hands-AI/OpenHands") },
      { name: "SWE-agent", blurb: "Autonomous issue and pull-request solving.", meta: "MIT", script: pip("agents-sweagent", "sweagent") },
      { name: "Goose", blurb: "Extensible local coding agent.", meta: "Apache-2.0", script: repo("goose", "block/goose") },
      { name: "Cline", blurb: "Autonomous IDE agent (VS Code).", meta: "Apache-2.0", script: repo("cline", "cline/cline") },
      { name: "Continue", blurb: "IDE agent for VS Code and JetBrains.", meta: "Apache-2.0", script: repo("continue", "continuedev/continue") },
      { name: "Roo Code", blurb: "IDE agent with modes and approval gates.", meta: "Apache-2.0", script: repo("Roo-Code", "RooCodeInc/Roo-Code") },
      { name: "Plandex", blurb: "Agent for large multi-file tasks.", meta: "MIT", script: repo("plandex", "plandex-ai/plandex") },
      { name: "gpt-engineer", blurb: "Turns a prompt into a working project.", meta: "MIT", script: pip("agents-gpt-engineer", "gpt-engineer") },
      { name: "gptme", blurb: "Local agent with shell, Python and browser tools.", meta: "MIT", script: pip("agents-gptme", "gptme") },
      { name: "Open Interpreter", blurb: "Natural-language code execution.", meta: "MIT", script: pip("agents-open-interpreter", "open-interpreter") },
      { name: "Shell-GPT", blurb: "Natural-language shell commands.", meta: "MIT", script: pip("agents-shell-gpt", "shell-gpt") },
      { name: "Mentat", blurb: "Terminal coding agent over your repo.", meta: "Apache-2.0", script: pip("agents-mentat", "mentat") },
      { name: "smol-developer", blurb: "Compact project-building agent.", meta: "MIT", script: pip("agents-smol-developer", "smol-developer") },
      { name: "Devika", blurb: "Agentic software engineer with research.", meta: "MIT", script: repo("devika", "stitionai/devika") },
      { name: "Tabby", blurb: "Self-hosted code completion server.", meta: "Apache-2.0", script: repo("tabby", "TabbyML/tabby") },
      { name: "Codex CLI", blurb: "Open-source OpenAI coding agent CLI.", meta: "Apache-2.0", script: npm("codex-cli", "@openai/codex") },
      { name: "Gemini CLI", blurb: "Google's open-source terminal agent.", meta: "Apache-2.0", script: npm("gemini-cli", "@google/gemini-cli") },
      { name: "opencode", blurb: "Terminal coding agent.", meta: "MIT", script: npm("opencode", "opencode-ai") },
    ],
  },
  {
    id: "source",
    title: "Freebuff source",
    icon: "package",
    summary:
      "The complete Freebuff (Codebuff) TypeScript/Bun monorepo — the reference implementation of every layer here. Apache-2.0.",
    items: [
      { name: "Freebuff source", blurb: "Unpacks the full source tree that ships in the package: agents, SDK, CLI, agent-runtime, code-map, tools, docs and tests. Nothing is downloaded.", meta: "Apache-2.0 · 18.9 MB", repo: "https://github.com/CodebuffAI/freebuff", script: script("unpack Freebuff source", 'bash scripts/capture-freebuff-source.sh\necho "extracted to ./source/freebuff"') },
      { name: "freebuff-source.zip", blurb: "The upstream archive itself, exactly as it ships inside this package: the whole Freebuff (Codebuff) monorepo, 1,773 files.", file: "source/freebuff-source.zip", size: "18.9 MB" },
      { name: "capture-freebuff-source.sh", blurb: "Unpacks the archive above onto the drive, then runs bun install inside it.", file: "scripts/capture-freebuff-source.sh" },
      { name: "Source README", blurb: "A map of the tree, pointing at the tools and agents.", file: "source/README.md" },
    ],
  },
  {
    id: "orchestration",
    title: "Orchestration",
    icon: "network",
    summary: "Connects model → reasoning → agents → tools → files → terminal → testing → review. Tool calling, routing, parallel agents and task management.",
    file: "scripts/install-orchestration.sh",
    items: [
      { name: "MCP / FastMCP", blurb: "Model Context Protocol: standard tool calling and agent-to-agent communication.", meta: "MIT", script: pip("orch-mcp", "mcp fastmcp") },
      { name: "mcpo", blurb: "Exposes MCP tools as an OpenAPI service.", script: pip("orch-mcpo", "mcpo") },
      { name: "LiteLLM", blurb: "One OpenAI-compatible endpoint in front of many local models; model routing.", meta: "MIT", script: pip("orch-litellm", '"litellm[proxy]" llm openai anthropic') },
      { name: "Ray", blurb: "Run many agents in parallel across cores.", meta: "Apache-2.0", script: pip("orch-ray", "ray") },
      { name: "Celery", blurb: "Distributed task queue for agent jobs.", meta: "BSD", script: pip("orch-celery", "celery") },
      { name: "Dask", blurb: "Parallel compute for batch agent work.", meta: "BSD", script: pip("orch-dask", '"dask[distributed]"') },
      { name: "Prefect", blurb: "Workflow orchestration with retries and observability.", meta: "Apache-2.0", script: pip("orch-prefect", "prefect") },
      { name: "Dagster", blurb: "Data/agent asset graphs.", meta: "Apache-2.0", script: pip("orch-dagster", "dagster") },
      { name: "APScheduler", blurb: "In-process scheduling for recurring agent tasks.", meta: "MIT", script: pip("orch-schedule", "apscheduler") },
      { name: "Open WebUI", blurb: "Local chat workspace in front of your models.", meta: "MIT", file: "orchestration/README.md" },
    ],
  },
  {
    id: "coding-tools",
    title: "Coding tools",
    icon: "code",
    summary: "The tools agents call: search, symbols, diffs, patches, build, test, lint, format and language servers.",
    file: "scripts/install-coding-tools.sh",
    items: [
      { name: "ripgrep", blurb: "Fast text and code search; the engine behind code-search tools.", meta: "MIT", script: apt("ripgrep", "ripgrep") },
      { name: "ast-grep", blurb: "Structural (AST) code search and rewrite.", meta: "MIT", script: npm("ast-grep", "@ast-grep/cli") },
      { name: "fd", blurb: "Fast file discovery.", meta: "MIT", script: apt("fd", "fd-find", "fd") },
      { name: "fzf", blurb: "Interactive filter over files and search results.", meta: "MIT", script: apt("fzf", "fzf") },
      { name: "universal-ctags", blurb: "Symbol index for jump-to-definition.", meta: "GPL-2.0", script: apt("universal-ctags", "universal-ctags") },
      { name: "GNU global", blurb: "Cross-reference index across a codebase.", meta: "GPL-3.0", script: apt("global", "global") },
      { name: "cscope", blurb: "C-family symbol cross-reference.", meta: "BSD", script: apt("cscope", "cscope") },
      { name: "tree-sitter CLI", blurb: "Parse code into syntax trees for code maps.", meta: "MIT", script: npm("tree-sitter", "tree-sitter-cli") },
      { name: "diff & patch", blurb: "Apply and inspect edits.", meta: "GPL-3.0", script: script("install diff/patch", 'sudo apt-get update -qq && sudo apt-get install -y diffutils patch || brew install gpatch') },
      { name: "git-delta", blurb: "Readable diffs for review.", meta: "MIT", script: script("install git-delta", 'brew install git-delta || (curl -sSL https://github.com/dandavison/delta/releases/latest/download/delta-0.18.2-x86_64-unknown-linux-gnu.tar.gz | tar xz)') },
      { name: "difftastic", blurb: "Structural diff that understands syntax.", meta: "MIT", script: script("install difftastic", 'brew install difftastic || cargo install difftastic') },
      { name: "ruff", blurb: "Fast Python linter and formatter.", meta: "MIT", script: pip("tools-ruff", "ruff") },
      { name: "biome", blurb: "JS/TS lint and format.", meta: "MIT", script: npm("biome", "@biomejs/biome") },
      { name: "prettier", blurb: "Opinionated formatter for many languages.", meta: "MIT", script: npm("prettier", "prettier") },
      { name: "shellcheck / shfmt", blurb: "Shell lint and format.", meta: "GPL-3.0", script: script("install shell tools", 'sudo apt-get update -qq && sudo apt-get install -y shellcheck || brew install shellcheck shfmt') },
      { name: "clang-format", blurb: "C/C++/ObjC formatting.", meta: "Apache-2.0", script: apt("clang-format", "clang-format") },
      { name: "pyright", blurb: "Python type checker used as a language server.", meta: "MIT", script: pip("tools-pyright", "pyright") },
      { name: "typescript-language-server", blurb: "TS/JS language server for navigation.", meta: "MIT", script: npm("tsserver", "typescript typescript-language-server") },
      { name: "build tools", blurb: "make, cmake, ninja, just and hyperfine.", script: script("install build tools", 'sudo apt-get update -qq && sudo apt-get install -y make cmake ninja-build || brew install cmake ninja just hyperfine') },
      { name: "jq & yq", blurb: "JSON and YAML processing for agent plumbing.", meta: "MIT", script: script("install jq/yq", 'sudo apt-get update -qq && sudo apt-get install -y jq || brew install jq yq') },
    ],
  },
  {
    id: "terminal-tools",
    title: "Terminal tools",
    icon: "terminal",
    summary: "Shells, multiplexers, process and log inspection, debugging.",
    file: "scripts/install-terminal-tools.sh",
    items: [
      { name: "tmux", blurb: "Persistent terminal sessions agents can attach to.", meta: "ISC", script: apt("tmux", "tmux") },
      { name: "zellij", blurb: "Modern terminal workspace.", meta: "MIT", script: script("install zellij", 'cargo install --locked zellij || brew install zellij') },
      { name: "expect", blurb: "Drive interactive terminal programs.", meta: "Public domain", script: apt("expect", "expect") },
      { name: "htop", blurb: "Process and resource inspection.", meta: "GPL-2.0", script: apt("htop", "htop") },
      { name: "lsof", blurb: "See which process holds a file or port.", meta: "BSD", script: apt("lsof", "lsof") },
      { name: "strace", blurb: "Trace system calls for debugging.", meta: "GPL-2.0", script: apt("strace", "strace") },
      { name: "gdb", blurb: "Debugger for compiled languages.", meta: "GPL-3.0", script: apt("gdb", "gdb") },
      { name: "watch / entr", blurb: "Re-run commands on a timer or file change.", script: script("install watchers", 'sudo apt-get update -qq && sudo apt-get install -y procps entr || brew install watch entr') },
      { name: "asciinema", blurb: "Record terminal sessions for review.", meta: "GPL-3.0", script: script("install asciinema", 'pip install -U asciinema') },
    ],
  },
  {
    id: "file-tools",
    title: "File tools",
    icon: "folder",
    summary: "Read, write, edit, traverse, archive and sync files.",
    file: "scripts/install-file-tools.sh",
    items: [
      { name: "coreutils & findutils", blurb: "find, tree, file, stat.", meta: "GPL-3.0", script: script("install file basics", 'sudo apt-get update -qq && sudo apt-get install -y coreutils findutils tree file || brew install coreutils findutils tree') },
      { name: "sd", blurb: "Simple stream editing for in-place replacement.", meta: "MIT", script: script("install sd", 'cargo install sd || brew install sd') },
      { name: "archives", blurb: "tar, zip, unzip, zstd, xz and 7z.", script: script("install archives", 'sudo apt-get update -qq && sudo apt-get install -y tar zip unzip zstd xz-utils p7zip-full || brew install zstd xz sevenzip') },
      { name: "curl & wget", blurb: "Fetch files and talk to local services.", meta: "MIT", script: apt("curl", "curl wget") },
      { name: "rsync & rclone", blurb: "Sync and copy trees.", meta: "GPL-3.0 / MIT", script: script("install sync tools", 'sudo apt-get update -qq && sudo apt-get install -y rsync || brew install rsync rclone') },
      { name: "watchers", blurb: "inotify-tools for reacting to file changes.", meta: "GPL-2.0", script: apt("inotify-tools", "inotify-tools") },
    ],
  },
  {
    id: "browser-tools",
    title: "Browser & research",
    icon: "globe",
    summary: "Browser automation, page inspection, screenshots, local-site testing and technical research.",
    file: "scripts/install-browser-tools.sh",
    items: [
      { name: "Playwright", blurb: "Drives Chromium, Firefox and WebKit; screenshots and console.", meta: "Apache-2.0", script: script("install Playwright", 'python3 -m venv playwright && . ./playwright/bin/activate && pip install -U playwright && playwright install --with-deps chromium firefox webkit') },
      { name: "Puppeteer", blurb: "Node browser automation with Chromium.", meta: "Apache-2.0", script: npm("puppeteer", "puppeteer") },
      { name: "Selenium", blurb: "Cross-browser automation with drivers.", meta: "Apache-2.0", script: pip("selenium", "selenium") },
      { name: "Chrome DevTools Protocol", blurb: "Speak to a browser directly — network, console, DOM.", meta: "Apache-2.0", script: npm("cdp", "chrome-remote-interface") },
      { name: "browser-use", blurb: "LLM-driven browser agent.", meta: "MIT", script: pip("browser-use", "browser-use") },
      { name: "Stagehand", blurb: "Composable browser automation for agents.", meta: "MIT", script: repo("Stagehand", "browserbase/stagehand") },
      { name: "LaVague", blurb: "Open-source web agent framework.", meta: "Apache-2.0", script: repo("LaVague", "lavague-ai/LaVague") },
      { name: "Skyvern", blurb: "Browser workflow automation with vision.", meta: "AGPL-3.0", script: repo("skyvern", "Skyvern-AI/skyvern") },
      { name: "lynx / w3m", blurb: "Text browsers for reading pages without a GUI.", meta: "GPL-2.0", script: apt("lynx", "lynx w3m") },
      { name: "htmlq / xmllint", blurb: "Slice and validate HTML/XML from the shell.", script: script("install HTML tools", 'sudo apt-get update -qq && sudo apt-get install -y libxml2-utils tidy || brew install htmlq libxml2 tidy-html5') },
      { name: "extraction", blurb: "trafilatura, readability and newspaper3k turn pages into clean text.", script: pip("page-extract", "trafilatura readability-lxml newspaper3k beautifulsoup4 lxml html5lib") },
    ],
  },
  {
    id: "research-tools",
    title: "Research tools",
    icon: "search",
    summary: "Self-hosted search and offline documentation, so research works without an account.",
    file: "scripts/install-research-tools.sh",
    items: [
      { name: "SearXNG", blurb: "Self-hosted meta search on http://localhost:8888 — no cloud API.", meta: "AGPL-3.0", script: script("run SearXNG", 'mkdir -p searxng && cat > searxng/docker-compose.yml <<\'YAML\'\nservices:\n  searxng:\n    image: searxng/searxng:latest\n    ports: ["8888:8080"]\n    restart: unless-stopped\nYAML\ncd searxng && docker compose up -d') },
      { name: "ddgr & googler", blurb: "Search from the terminal.", meta: "GPL-3.0", script: pip("search-cli", "ddgr googler duckduckgo-search") },
      { name: "tldr & cheat", blurb: "Offline command cheatsheets.", meta: "MIT", script: npm("tldr", "tldr") },
      { name: "DevDocs", blurb: "Offline API documentation bundle.", meta: "MPL-2.0", script: repo("devdocs", "freeCodeCamp/devdocs") },
      { name: "doc extraction", blurb: "trafilatura and markdownify capture docs as clean markdown.", script: pip("doc-extract", "trafilatura markdownify newspaper3k") },
    ],
  },
  {
    id: "context",
    title: "Context",
    icon: "layers",
    summary: "Codebase indexing, semantic retrieval and task state.",
    file: "scripts/install-context-memory.sh",
    items: [
      { name: "Codebase indexing", blurb: "tree-sitter, language pack, ctags and LlamaIndex retrievers (dense + BM25).", file: "context/README.md" },
      { name: "Zoekt", blurb: "Fast trigram code search engine.", meta: "Apache-2.0", script: repo("zoekt", "sourcegraph/zoekt") },
      { name: "livegrep", blurb: "Regex code search across many repos.", meta: "Apache-2.0", script: repo("livegrep", "sourcegraph/livegrep") },
      { name: "Vector stores", blurb: "Chroma, Qdrant, LanceDB, FAISS, Weaviate and Milvus clients.", script: pip("context-vectors", "chromadb qdrant-client lancedb faiss-cpu weaviate-client pymilvus") },
      { name: "Lexical search", blurb: "bm25s, rank-bm25, whoosh and tantivy.", script: pip("context-search", "bm25s rank-bm25 whoosh tantivy") },
      { name: "RAG frameworks", blurb: "Haystack and txtai retrieval pipelines.", script: pip("context-rag", "haystack-ai txtai") },
      { name: "Task state", blurb: "LangGraph SQLite checkpoints and sqlite-utils.", script: pip("context-tasks", "langgraph-checkpoint-sqlite sqlite-utils") },
    ],
  },
  {
    id: "memory",
    title: "Memory",
    icon: "archive",
    summary: "Project and conversation memory across turns and sessions.",
    file: "scripts/install-context-memory.sh",
    items: [
      { name: "mem0", blurb: "Extract and store durable facts and preferences.", meta: "Apache-2.0", script: pip("memory-mem0", "mem0ai") },
      { name: "Letta (MemGPT)", blurb: "Long-term memory with self-editing memory blocks.", meta: "Apache-2.0", script: pip("memory-letta", "letta") },
      { name: "cognee", blurb: "Build a knowledge graph from your project.", meta: "Apache-2.0", script: pip("memory-cognee", "cognee") },
      { name: "GPTCache", blurb: "Cache model responses to avoid repeat work.", meta: "MIT", script: repo("GPTCache", "zilliztech/GPTCache") },
    ],
  },
  {
    id: "embeddings",
    title: "Embeddings",
    icon: "braces",
    summary: "Embedding models and servers for semantic search over code and docs.",
    items: [
      { name: "sentence-transformers", blurb: "Local embedding runtime.", meta: "Apache-2.0", script: pip("embeddings", "sentence-transformers FlagEmbedding fastembed optimum") },
      { name: "bge-m3", blurb: "Multilingual dense + sparse + colBERT embeddings.", meta: "MIT", script: hfModel("bge-m3", "BAAI/bge-m3", false) },
      { name: "nomic-embed-text-v1.5", blurb: "8192-token embeddings that run fast on CPU.", meta: "Apache-2.0", script: hfModel("nomic-embed-text-v1.5", "nomic-ai/nomic-embed-text-v1.5", false) },
      { name: "all-MiniLM-L6-v2", blurb: "Tiny, quick embeddings.", meta: "Apache-2.0", script: hfModel("minilm-l6", "sentence-transformers/all-MiniLM-L6-v2", false) },
      { name: "bge-reranker-v2-m3", blurb: "Cross-encoder reranker for retrieval.", meta: "Apache-2.0", script: hfModel("bge-reranker-v2-m3", "BAAI/bge-reranker-v2-m3", false) },
    ],
  },
  {
    id: "search",
    title: "Search engines",
    icon: "search",
    summary: "Lexical, structural and vector search engines.",
    items: [
      { name: "Meilisearch", blurb: "Fast typo-tolerant document search.", meta: "MIT", script: script("run Meilisearch", 'docker run --rm -p 7700:7700 getmeili/meilisearch:latest') },
      { name: "Typesense", blurb: "Typo-tolerant search with vector support.", meta: "GPL-3.0", script: script("run Typesense", 'docker run --rm -p 8108:8108 typesense/typesense:latest --data-dir /data --api-key=local') },
      { name: "OpenSearch", blurb: "Full-text and vector search at scale.", meta: "Apache-2.0", script: script("run OpenSearch", 'docker run --rm -p 9200:9200 -e discovery.type=single-node opensearchproject/opensearch:latest') },
      { name: "tantivy", blurb: "Rust full-text search library.", meta: "MIT", script: script("install tantivy", 'cargo install tantivy-cli || pip install tantivy') },
    ],
  },
  {
    id: "databases",
    title: "Databases",
    icon: "database",
    summary: "Local stores for state, memory and vectors.",
    file: "scripts/install-supporting.sh",
    items: [
      { name: "SQLite", blurb: "Everything local: task state, memory, metadata.", meta: "Public domain", script: apt("sqlite3", "sqlite3") },
      { name: "PostgreSQL + pgvector", blurb: "Memory and RAG at scale.", meta: "PostgreSQL / PostgreSQL", script: script("install Postgres", 'sudo apt-get update -qq && sudo apt-get install -y postgresql postgresql-contrib || brew install postgresql pgvector') },
      { name: "DuckDB", blurb: "Analytical queries over local files.", meta: "MIT", script: pip("duckdb", "duckdb") },
      { name: "Redis", blurb: "Caching, queues and short-term state.", meta: "BSD", script: apt("redis", "redis-server") },
      { name: "Qdrant", blurb: "Vector search server.", meta: "Apache-2.0", script: script("run Qdrant", 'docker run --rm -p 6333:6333 qdrant/qdrant') },
      { name: "Chroma", blurb: "Embedded vector store.", meta: "Apache-2.0", script: pip("chroma", "chromadb") },
      { name: "Milvus / Weaviate", blurb: "Large-scale vector and hybrid search.", meta: "Apache-2.0 / BSD", script: script("vector servers", 'echo "Milvus: docker run -p 19530:19530 milvusdb/milvus:latest"\necho "Weaviate: docker run -p 8080:8080 cr.weaviate.io/semitechnologies/weaviate:latest"') },
      { name: "LanceDB & FAISS", blurb: "Embedded columnar vector store and ANN index.", meta: "Apache-2.0 / MIT", script: pip("vector-embedded", "lancedb faiss-cpu") },
    ],
  },
  {
    id: "runtimes",
    title: "Runtimes & supporting software",
    icon: "cpu",
    summary: "The language runtimes, compilers and package managers everything else needs.",
    file: "scripts/install-supporting.sh",
    items: [
      { name: "Python + uv", blurb: "Runs the agents, reasoning frameworks and embeddings.", script: script("install Python + uv", 'sudo apt-get update -qq && sudo apt-get install -y python3 python3-venv python3-pip || brew install python\ncurl -LsSf https://astral.sh/uv/install.sh | sh') },
      { name: "Node.js", blurb: "Runs npm-based agents and tools.", script: script("install Node", 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs || brew install node') },
      { name: "Bun", blurb: "The Freebuff runtime and fast JS tooling.", meta: "MIT", script: script("install Bun", 'curl -fsSL https://bun.sh/install | bash') },
      { name: "Deno", blurb: "Sandboxed TypeScript execution.", meta: "MIT", script: script("install Deno", 'curl -fsSL https://deno.land/install.sh | sh') },
      { name: "Rust", blurb: "Builds llama.cpp helpers and Rust tools.", script: script("install Rust", 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y') },
      { name: "Go", blurb: "gopls and Go tooling.", script: apt("Go", "golang") },
      { name: "git", blurb: "Clones repos, records edits and lets agents diff their own work.", meta: "GPL-2.0", script: apt("git", "git") },
      { name: "pipx", blurb: "Isolated CLI tools (used as a fallback installer for the Hugging Face CLI).", meta: "MIT", script: script("install pipx", 'python3 -m pip install --user -U pipx\npython3 -m pipx ensurepath') },
      { name: "Docker & Compose", blurb:
          "Optional container runtime for the self-hosted services: SearXNG, Qdrant, Meilisearch, Open WebUI and DevDocs.",
        meta: "Apache-2.0",
        script: script("install Docker", 'curl -fsSL https://get.docker.com | sh\nsudo usermod -aG docker "$USER" || true') },
      { name: "Compilers & build tools", blurb: "gcc/clang, make, cmake, ninja, pkg-config.", script: script("install build essentials", 'sudo apt-get update -qq && sudo apt-get install -y build-essential cmake ninja-build pkg-config || xcode-select --install') },
      { name: "JDK", blurb: "Java language servers.", script: apt("JDK", "default-jdk") },
    ],
  },
  {
    id: "libraries",
    title: "Libraries",
    icon: "package",
    summary: "Common Python and Node libraries the stack imports.",
    file: "scripts/install-libraries.sh",
    items: [
      { name: "Python libraries", blurb: "requests, httpx, pydantic, pyyaml, rich, typer, numpy, pandas, tiktoken, tenacity, gitpython, pathspec.", script: pip("lib-python", "requests httpx pydantic pydantic-settings pyyaml toml rich typer click tqdm numpy pandas regex tiktoken tenacity python-dotenv gitpython pathspec") },
      { name: "LLM client SDKs", blurb: "openai, anthropic, google-genai, ollama, llama-cpp-python — all can target a local server.", script: pip("lib-prompts", "jinja2 openai anthropic google-genai ollama llama-cpp-python") },
      { name: "llama-cpp-python", blurb: "Bindings that load a GGUF model straight into Python, with no server process.", meta: "MIT", script: pip("lib-llama-cpp", "llama-cpp-python") },
      { name: "Parsing", blurb: "tree-sitter + language pack for parsing many languages.", script: pip("lib-parsing", "tree-sitter tree-sitter-language-pack") },
      { name: "Node libraries", blurb: "zod, axios, express, fast-glob, ignore, chokidar, minimatch.", script: npm("lib-node", "zod axios express fast-glob ignore chokidar minimatch") },
    ],
  },
];

/** Every group, flattened, with the group it came from — for search. */
export const BRAIN_INDEX = BRAIN_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ group, item })),
);

export const BRAIN_STATS = {
  groups: BRAIN_GROUPS.length,
  items: BRAIN_INDEX.length,
  files: BRAIN_GROUPS.filter((g) => g.file).length,
};

/**
 * What "everything" actually weighs, so nobody guesses. Model figures are the
 * full-precision weights `download-models.sh` fetches; the software figure is
 * the installed footprints of the runtimes, tools and agent environments.
 */
export const SIZE_SUMMARY: { label: string; value: string; note: string }[] = [
  {
    label: "Every model (all 32)",
    value: "~1.7 TB",
    note: "DeepSeek-R1 alone is 685 GB",
  },
  { label: "Recommended set", value: "~445 GB", note: "14 models" },
  { label: "Small set", value: "~102 GB", note: "4 models" },
  { label: "Tiny set", value: "~62 GB", note: "5 models" },
  {
    label: "Python environments",
    value: "~8–12 GB",
    note: "on the drive, beside the models",
  },
  {
    label: "System packages",
    value: "~5–10 GB",
    note: "on the computer: tools, runtimes, compilers",
  },
  {
    label: "The brain itself",
    value: "~318 KB",
    note: "Python 3 and nothing else — no packages to install",
  },
  {
    label: "The installer file",
    value: "~27 MB",
    note: "one script — it carries the package and the source, and fetches the software and weights",
  },
];

/** A runnable shell script for one item, ready to save. */
export function itemScript(item: BrainItem): string | null {
  if (item.script) return item.script;
  if (item.file) {
    return script(
      item.name,
      `# This one is a file: download it from the same button (${item.file}).`,
    );
  }
  return null;
}

/** One script that installs everything a group holds. */
export function groupScript(group: BrainGroup): string {
  const parts = group.items
    .map((item) => (item.script ? item.script.replace(/^#!.*\n/, "").trim() : null))
    .filter((part): part is string => Boolean(part));
  return script(
    `${group.title} — the whole group`,
    parts.join("\n\n"),
  );
}
