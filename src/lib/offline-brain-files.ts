/**
 * Every file in the packaged `offline-ai-coding-brain/`, exactly as served from
 * `/offline-brain/`. The bundle and the one-file installer carry all of these,
 * so nothing an installer script needs is left behind (notably `scripts/lib.sh`,
 * which every installer sources, and `scripts/download-models.sh`).
 *
 * Keep this in step with `public/offline-brain/` if the package changes.
 *
 * Everything here is text, which is why the one-file installer can write it out
 * as here-documents. The one file that is not text — the reference source
 * archive — is in `PACKAGE_BINARY_FILES` below, and carries its own handling.
 */
export const PACKAGE_FILES: string[] = [
  "GET-EVERYTHING.sh",
  "README.md",
  "agents/README.md",
  "browser-tools/README.md",
  "coding-tools/README.md",
  "configuration/README.md",
  "configuration/catalog.json",
  "configuration/env.sh",
  "configuration/litellm.example.yaml",
  "context/README.md",
  "databases/README.md",
  "documentation/ARCHITECTURE.md",
  "documentation/CAPABILITY-MAP.md",
  "documentation/LICENSES.md",
  "documentation/OFFLINE-GUIDE.md",
  "documentation/README.md",
  "embeddings/README.md",
  "file-tools/README.md",
  "libraries/README.md",
  "memory/README.md",
  "model-runtimes/README.md",
  "models/README.md",
  "models/manifest.json",
  "orchestration/README.md",
  "reasoning/README.md",
  "research-tools/README.md",
  "runtimes/README.md",
  "scripts/README.md",
  "scripts/capture-freebuff-source.sh",
  "scripts/download-models.sh",
  "scripts/install-agents.sh",
  "scripts/install-browser-tools.sh",
  "scripts/install-coding-tools.sh",
  "scripts/install-context-memory.sh",
  "scripts/install-file-tools.sh",
  "scripts/install-libraries.sh",
  "scripts/install-orchestration.sh",
  "scripts/install-reasoning.sh",
  "scripts/install-research-tools.sh",
  "scripts/install-runtimes.sh",
  "scripts/install-supporting.sh",
  "scripts/install-terminal-tools.sh",
  "scripts/lib.sh",
  "scripts/serve-local-model.sh",
  "scripts/setup-all.sh",
  "scripts/verify.sh",
  "search/README.md",
  "source/README.md",
  "terminal-tools/README.md",
  "tests/README.md",
  "tests/smoke.sh",
  // The local brain, the runnable half of the system. It is in the bundle
  // because the package is incomplete without it: install everything above and
  // you still have nothing to *run* until brain.py is on the drive too.
  "brain/README.md",
  "brain/brain.py",
  "brain/src/__init__.py",
  "brain/src/agent.py",
  "brain/src/capabilities.py",
  "brain/src/config.py",
  "brain/src/connectors.py",
  "brain/src/diagnostics.py",
  "brain/src/info.py",
  "brain/src/providers.py",
  "brain/src/scheduler.py",
  "brain/src/server.py",
  "brain/src/store.py",
  "brain/src/tools.py",
  "brain/src/updater.py",
  "brain/tests/test_brain.py",
];

/**
 * The packaged files that are not text, so they travel as bytes.
 *
 * One file: the untouched upstream archive of the Freebuff (Codebuff) reference
 * source (Apache-2.0). It ships *inside* the package — `source/README.md`, the
 * package README and every document that points at `source/freebuff/` all
 * describe it — so a download is complete when it lands and no installer has to
 * reach the network for it.
 *
 * A fetch of `/offline-brain/source/freebuff-source.zip` returns the bytes
 * exactly; `scripts/pack-freebuff-source.mjs` is what builds it.
 */
export const PACKAGE_BINARY_FILES: string[] = [
  "source/freebuff-source.zip",
];

/**
 * The whole package: text and archive together. This is what a complete
 * download holds, and what the counts on the Offline Brain page mean.
 */
export const PACKAGE_ALL_FILES: string[] = [
  ...PACKAGE_FILES,
  ...PACKAGE_BINARY_FILES,
];
