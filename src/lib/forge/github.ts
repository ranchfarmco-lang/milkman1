/**
 * GitHub, from the browser: a personal access token kept in the vault, and
 * the four things the Control Room's box promises — test the token, create a
 * repository, push the project, pull a repository down into the project.
 *
 * Push already exists in the hub (`@/lib/github-export`); this file wraps it
 * beside the rest so the box has one place to reach for, and adds what was
 * missing: the identity check, repo creation, and a pull.
 */
import { pushToGithub, type GithubFile } from "@/lib/github-export";
import { getSecret, putSecret } from "./crypto";
import { recordError } from "./db";

export const GITHUB_SECRET = "github";

export type GithubTest = { ok: boolean; detail: string; login: string | null };

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // The raw body is the best it gets.
    }
    throw new Error(`${response.status} — ${message}`);
  }
  return (await response.json()) as T;
}

/** Who the token belongs to, and whether GitHub accepts it at all. */
export async function testGithub(token?: string | null): Promise<GithubTest> {
  const key = (token ?? (await getSecret(GITHUB_SECRET)))?.trim();
  if (!key) return { ok: false, detail: "No token saved yet — paste a personal access token.", login: null };
  try {
    const user = await gh<{ login: string }>(key, "/user");
    return { ok: true, detail: `Signed in as ${user.login}.`, login: user.login };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError("github test", error);
    return { ok: false, detail: `GitHub refused the token (${message}).`, login: null };
  }
}

/** Remember a token in the encrypted vault. */
export async function saveGithubToken(token: string): Promise<void> {
  await putSecret(GITHUB_SECRET, token);
}

/** Create a repository under the token's account (or an org, `org/repo`). */
export async function createRepo(
  token: string,
  name: string,
  description: string,
): Promise<{ ok: boolean; detail: string; repo: string | null }> {
  const clean = name.trim().replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!clean) return { ok: false, detail: "Give the repository a name first.", repo: null };
  try {
    const repo = await gh<{ full_name: string }>(token, "/user/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: clean, description, private: true, auto_init: false }),
    });
    return { ok: true, detail: `Created ${repo.full_name}.`, repo: repo.full_name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError("github create", error);
    return {
      ok: false,
      detail: /already exists/i.test(message)
        ? `${clean} already exists on this account.`
        : `Could not create it (${message}).`,
      repo: null,
    };
  }
}

type TreeEntry = { path: string; type: string; sha?: string };
type BlobObject = { content?: string; encoding?: string };

/** Pull a repository's text files down — the tree, then each blob. */
export async function pullRepo(
  token: string,
  repo: string,
  branch = "main",
): Promise<{ ok: boolean; detail: string; files: GithubFile[] }> {
  const clean = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  try {
    const tree = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
      token,
      `/repos/${clean}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const blobs = tree.tree
      .filter((entry) => entry.type === "blob")
      .slice(0, 300);
    if (!blobs.length) return { ok: false, detail: "That branch has no files.", files: [] };

    const files: GithubFile[] = [];
    for (const entry of blobs) {
      const blob = await gh<BlobObject>(token, `/repos/${clean}/git/blobs/${entry.sha ?? ""}`);
      if (blob.encoding === "base64" && blob.content) {
        const binary = atob(blob.content.replace(/\s/g, ""));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        files.push({ path: entry.path, content: new TextDecoder().decode(bytes) });
      } else if (blob.content) {
        files.push({ path: entry.path, content: blob.content });
      }
    }
    return {
      ok: true,
      detail: `Pulled ${files.length} file(s)${tree.truncated ? " (large repo, first 300)" : ""} from ${clean}.`,
      files,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError("github pull", error);
    return { ok: false, detail: `Could not pull (${message}).`, files: [] };
  }
}

/** Push files into a repository — the hub's own writer, given a token. */
export async function pushRepo(input: {
  token: string;
  repo: string;
  branch: string;
  files: GithubFile[];
  message: string;
}): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await pushToGithub(input);
    return {
      ok: true,
      detail: `Pushed ${result.files} file(s) to ${input.repo}, branch ${result.branch} (${result.url}).`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError("github push", error);
    return { ok: false, detail: message };
  }
}
