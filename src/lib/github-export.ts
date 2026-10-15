/**
 * One-click export of the builder's bench into a GitHub repository — from the
 * browser, with a token the page never keeps.
 *
 * The whole exchange is `fetch` from this device straight to
 * `api.github.com`: the token lives in the component's state for as long as
 * the form is filled in, is sent as the Authorization header of each call,
 * and is written nowhere — not localStorage, not the hub's database, not a log.
 * That is what makes this bring-your-own-key rather than a credential the hub
 * holds on somebody's behalf.
 *
 * One push is one commit, built through GitHub's git data API rather than a
 * file-by-file contents call: blobs for every file, one tree on top of what is
 * already at the branch head, one commit, then the ref moves. Files in the
 * repository that the bench knows nothing about are left exactly where they
 * are — the tree is built with `base_tree`, so this overwrites the paths it
 * brings and touches nothing else.
 */

export type GithubFile = { path: string; content: string };

export type GithubPushResult = {
  /** The commit that moved the branch to. */
  url: string;
  files: number;
  branch: string;
};

/** How many blobs are created at once — parallel, but not a stampede. */
const BLOB_BATCH = 8;

/** A branch name that will not surprise the API. */
export function isBranchName(value: string) {
  return /^[A-Za-z0-9._/-]{1,100}$/.test(value) && !value.includes("..");
}

/** `owner/repo`, the one shape the form asks for. */
export function isRepoName(value: string) {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.trim());
}

async function gh<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token.trim()}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `GitHub said ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // The status alone will have to do; the body was not JSON.
    }

    // Said in the words a person can act on rather than the words API docs use.
    if (response.status === 401) {
      throw new Error("That token was refused — check it, and its scope.");
    }
    if (response.status === 403 || response.status === 429) {
      throw new Error(`GitHub would not let that through: ${message}`);
    }
    if (response.status === 404) {
      throw new Error(
        "GitHub cannot see that repository — check the owner/repo name and that the token may read it.",
      );
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

type GhRef = { object: { sha: string } };
type GhCommit = { tree: { sha: string }; html_url?: string };

/**
 * Push every file into the repository as a single commit.
 *
 * `repo` is `owner/repo`; `branch` is created when it does not exist yet, off
 * the repository's own default branch (or from nothing, when the repository is
 * empty). Each file becomes a blob, one tree carries them, one commit records
 * it, and the branch moves — so a failed push leaves the branch where it was.
 */
export async function pushToGithub(input: {
  token: string;
  repo: string;
  branch: string;
  files: GithubFile[];
  message: string;
}): Promise<GithubPushResult> {
  const repo = input.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").trim();
  const branch = input.branch.trim() || "main";
  const token = input.token.trim();

  if (!token) throw new Error("A token is needed first.");
  if (!isRepoName(repo)) {
    throw new Error("The repository goes as owner/repo, like sugar/my-app.");
  }
  if (!isBranchName(branch)) throw new Error("That branch name will not do.");
  if (!input.files.length) throw new Error("There is nothing on the bench to push.");

  const root = `/repos/${repo}`;

  // What the repository is, and what its default branch is called. This is
  // also the first check that the token can see the repository at all.
  await gh<{ default_branch: string }>(token, root);

  // The branch as it stands, when it stands at all: the head commit is the
  // parent of the new one, and its tree is what the new tree is built on top
  // of, so anything already in the repository survives the push.
  let headSha: string | null = null;
  let branchExists = false;
  let baseTree: string | undefined;

  try {
    const ref = await gh<GhRef>(
      token,
      `${root}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    );
    headSha = ref.object.sha;
    branchExists = true;
    const commit = await gh<GhCommit>(token, `${root}/git/commits/${headSha}`);
    baseTree = commit.tree.sha;
  } catch {
    // No such branch yet — it will be created at the end, off whatever the
    // repository's default branch holds, or from nothing in an empty repo.
  }

  if (headSha === null) {
    try {
      const info = await gh<{ default_branch: string }>(token, root);
      const def = await gh<GhRef>(
        token,
        `${root}/git/ref/heads/${info.default_branch}`,
      );
      headSha = def.object.sha;
      const commit = await gh<GhCommit>(token, `${root}/git/commits/${headSha}`);
      baseTree = commit.tree.sha;
    } catch {
      // An empty repository: no commits, no tree to build on, no parent.
      headSha = null;
    }
  }

  // Every file becomes a blob. Small batches: one commit's worth of parallel
  // requests, then the next, rather than every file at once.
  const shas: string[] = [];
  for (let at = 0; at < input.files.length; at += BLOB_BATCH) {
    const batch = input.files.slice(at, at + BLOB_BATCH);
    const made = await Promise.all(
      batch.map((file) =>
        gh<{ sha: string }>(token, `${root}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
        }),
      ),
    );
    shas.push(...made.map((blob) => blob.sha));
  }

  const tree = await gh<{ sha: string }>(token, `${root}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: input.files.map((file, index) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: shas[index],
      })),
    }),
  });

  const commit = await gh<{ sha: string; html_url: string }>(
    token,
    `${root}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: tree.sha,
        ...(headSha ? { parents: [headSha] } : {}),
      }),
    },
  );

  const refPath = `refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;

  if (branchExists) {
    await gh(token, `${root}/git/${refPath}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha }),
    });
  } else {
    await gh(token, `${root}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  }

  return { url: commit.html_url, files: input.files.length, branch };
}
