#!/usr/bin/env node
/**
 * Put this app's source into a GitHub repository — through the GitHub REST API,
 * so it works even where the `git` binary is unavailable.
 *
 *   GITHUB_TOKEN=github_pat_... node scripts/push-to-github.mjs
 *
 * Optional:
 *   GITHUB_REPO=owner/name     (default: ranchfarmco-lang/WEB-LOCAL-BUILD)
 *   GITHUB_CREATE_REPO=1       create the target repo if it does not exist yet
 *   GITHUB_BRANCH=main
 *   GITHUB_MESSAGE="..."
 *   GITHUB_CREATE_REPO=1       create the target repo if it does not exist yet
 *   DRY_RUN=1                  list what would be uploaded, upload nothing
 *
 * Files are chosen by the rules in `.gitignore`, so `node_modules/`, local
 * Convex state, keys and the vendored reference tree stay out. The commit is
 * layered on the branch tip, so existing history is kept.
 *
 * GitHub allows only ~80 content-creating requests per minute, so this does NOT
 * create one blob per file. Text files ride inside a handful of tree requests;
 * only genuinely binary files get their own blob. After pushing it reads the
 * tree back and compares every file's git object id, so a green run means the
 * bytes on GitHub are identical to the bytes here.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
// The repo the app is published to. It is named here rather than derived from a
// remote because there is no remote to derive it from: `git` is not available in
// this environment, which is the whole reason this script talks to the API
// directly. A name that does not exist is the failure mode to avoid — the run
// would get as far as a 404 on its first request — so this is a repo that was
// created for the app and left empty, waiting for exactly this.
const REPO = process.env.GITHUB_REPO ?? "ranchfarmco-lang/WEB-LOCAL-BUILD";
const BRANCH = process.env.GITHUB_BRANCH ?? "main";
const MESSAGE =
  process.env.GITHUB_MESSAGE ??
  "The Family Chat Hub app\n\nFull source: every page, every Convex function, the self-host kit,\nthe offline brain package and the Vercel deploy config.";
const DRY_RUN = process.env.DRY_RUN === "1";
// Off by default: creating a repo is a lasting change, so it happens only when
// the run explicitly asks for it. GitHub allows only [A-Za-z0-9._-] in a repo
// name, so a name with a space has to be spelled with a hyphen.
const CREATE_REPO = process.env.GITHUB_CREATE_REPO === "1";
const API = "https://api.github.com";
/** Raw text per tree request. Keeps each request body comfortably small. */
const CHUNK_BYTES = 800_000;

if (!TOKEN && !DRY_RUN) {
  console.error("GITHUB_TOKEN is not set — nothing to authenticate with.");
  process.exit(1);
}

// ---------------------------------------------------------------- ignore rules

/** Turn one `.gitignore` line into a matcher. Supports the subset used here. */
function rule(line) {
  const negated = line.startsWith("!");
  const body = (negated ? line.slice(1) : line).replace(/\/+$/, "");
  if (!body) return null;
  const anchored = body.includes("/");
  const source = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return {
    negated,
    // A bare name like `dist` matches at any depth; one with a slash is a path.
    re: new RegExp(anchored ? `^${source}(/|$)` : `(^|/)${source}(/|$)`),
  };
}

async function loadRules() {
  let text = "";
  try {
    text = await readFile(".gitignore", "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(rule)
    .filter(Boolean);
}

function ignored(path, rules) {
  let verdict = false;
  for (const r of rules) if (r.re.test(path)) verdict = !r.negated;
  return verdict;
}

// ------------------------------------------------------------------- file walk

async function walk(dir, rules, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = relative(".", join(dir, entry.name)).split(sep).join("/");
    if (entry.name === ".git") continue;
    if (ignored(rel, rules)) continue;
    if (entry.isDirectory()) await walk(join(dir, entry.name), rules, found);
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

// ------------------------------------------------------------------ github api

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "private-hub-push",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (res.ok) return body;

    const retryable = res.status === 429 || res.status >= 500;
    const wait = Number(res.headers.get("retry-after")) || attempt * 5;
    if (retryable && attempt <= 3 && wait <= 60) {
      console.log(`  ${res.status} — retrying in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(
      `${init.method ?? "GET"} ${path} → ${res.status} ${body?.message ?? res.statusText}`,
    );
  }
}

// ------------------------------------------------------------------------ main

const rules = await loadRules();
const paths = (await walk(".", rules)).sort();

const files = [];
for (const path of paths) {
  const buf = await readFile(path);
  const info = await stat(path);
  files.push({
    path,
    buf,
    // Git's own object id: sha1("blob <bytes>\0" + content).
    sha: createHash("sha1")
      .update(`blob ${buf.length}\0`)
      .update(buf)
      .digest("hex"),
    binary: buf.includes(0),
    mode: info.mode & 0o111 ? "100755" : "100644",
  });
}

const total = files.reduce((sum, f) => sum + f.buf.length, 0);
const binaries = files.filter((f) => f.binary);
console.log(
  `${files.length} files, ${(total / 1048576).toFixed(2)} MB ` +
    `(${binaries.length} binary, ${files.length - binaries.length} text)`,
);

if (DRY_RUN) {
  for (const f of files) console.log(`  ${f.path}`);
  process.exit(0);
}

const [owner, name] = REPO.split("/");
let repo;
try {
  repo = await api(`/repos/${owner}/${name}`);
} catch (error) {
  if (!CREATE_REPO) throw error;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error(
      `cannot create ${REPO}: "${name}" has characters GitHub does not allow in ` +
        `a repository name (letters, digits, . - _ only).`,
    );
    process.exit(1);
  }
  repo = await api("/user/repos", {
    method: "POST",
    body: {
      name,
      description: MESSAGE.split("\n")[0].slice(0, 120),
      private: false,
      auto_init: false,
    },
  });
  console.log(`created ${repo.full_name} (public, empty)`);
}
console.log(`repo: ${repo.full_name} (${repo.private ? "private" : "public"})`);

// The branch tip becomes the parent commit, so existing history is preserved.
let tree = null;
const parents = [];
try {
  const ref = await api(`/repos/${owner}/${name}/git/ref/heads/${BRANCH}`);
  parents.push(ref.object.sha);
  tree = (await api(`/repos/${owner}/${name}/git/commits/${ref.object.sha}`)).tree.sha;
  console.log(`branch ${BRANCH} exists at ${ref.object.sha.slice(0, 7)}`);
} catch {
  console.log(`branch ${BRANCH} does not exist yet — this run creates it`);
}

/** Grow the tree a chunk at a time. Each call is one content-creating request. */
async function addToTree(entries) {
  const result = await api(`/repos/${owner}/${name}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      ...(tree ? { base_tree: tree } : {}),
      tree: entries,
    }),
  });
  tree = result.sha;
}

// Binary files need an explicit, unambiguous encoding, so blob them directly.
// There are only a handful, so this stays far below the content-creation limit.
for (const file of binaries) {
  const blob = await api(`/repos/${owner}/${name}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: file.buf.toString("base64"), encoding: "base64" }),
  });
  await addToTree([
    { path: file.path, mode: file.mode, type: "blob", sha: blob.sha },
  ]);
  console.log(`blob: ${file.path}`);
}

// Text rides inside the tree request itself: one request per ~800 KB.
let chunk = [];
let batch = 0;
let size = 0;
for (const file of files.filter((f) => !f.binary)) {
  chunk.push({
    path: file.path,
    mode: file.mode,
    type: "blob",
    content: file.buf.toString("utf8"),
  });
  size += file.buf.length;
  if (size >= CHUNK_BYTES) {
    await addToTree(chunk);
    console.log(`tree: ${++batch} (${chunk.length} files, ${(size / 1024) | 0} KB)`);
    chunk = [];
    size = 0;
  }
}
if (chunk.length) {
  await addToTree(chunk);
  console.log(`tree: ${++batch} (${chunk.length} files, ${(size / 1024) | 0} KB)`);
}

const commit = await api(`/repos/${owner}/${name}/git/commits`, {
  method: "POST",
  body: JSON.stringify({ message: MESSAGE, tree, parents }),
});

if (parents.length) {
  await api(`/repos/${owner}/${name}/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
} else {
  await api(`/repos/${owner}/${name}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
  });
}

// Read it back and compare every object id, so "pushed" means "identical".
const pushed = await api(
  `/repos/${owner}/${name}/git/trees/${commit.sha}?recursive=1`,
);
const onGithub = new Map(
  pushed.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]),
);

const missing = [];
const wrong = [];
for (const file of files) {
  const sha = onGithub.get(file.path);
  if (!sha) missing.push(file.path);
  else if (sha !== file.sha) wrong.push(file.path);
}

console.log("");
if (missing.length || wrong.length || pushed.truncated) {
  console.log(`VERIFY FAILED — ${missing.length} missing, ${wrong.length} different`);
  for (const p of [...missing, ...wrong].slice(0, 20)) console.log(`  ${p}`);
  if (pushed.truncated) console.log("  (GitHub truncated the tree listing)");
  process.exit(1);
}

console.log(`pushed ${files.length} files → ${commit.sha.slice(0, 7)} on ${BRANCH}`);
console.log(`verified: all ${files.length} files match byte for byte`);
console.log(`https://github.com/${REPO}/commit/${commit.sha}`);
