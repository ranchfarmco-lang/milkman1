/**
 * Deployment targets: Vercel and Netlify, from the browser, with a personal
 * access token each, kept in the encrypted vault.
 *
 * Both APIs are called directly — test the token, then create a real
 * deployment from the project's files as they stand. Failures come back as
 * sentences the Control Room's light shows; nothing is pretended.
 */
import { getSecret, putSecret } from "./crypto";
import { recordError } from "./db";

export const VERCEL_SECRET = "vercel";
export const NETLIFY_SECRET = "netlify";

export type DeployTarget = "vercel" | "netlify";
export type DeployTest = { ok: boolean; detail: string };
export type DeployResult = { ok: boolean; detail: string; url: string | null };

async function call(
  url: string,
  init: RequestInit & { token: string },
): Promise<unknown> {
  const { token, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      message = parsed.error?.message ?? parsed.message ?? message;
    } catch {
      // Raw body stands.
    }
    throw new Error(`${response.status} — ${message}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Store a token for a target in the vault. */
export async function saveDeployToken(target: DeployTarget, token: string): Promise<void> {
  await putSecret(target === "vercel" ? VERCEL_SECRET : NETLIFY_SECRET, token);
}

/** Which identity the token belongs to. */
export async function testDeploy(target: DeployTarget, token?: string | null): Promise<DeployTest> {
  const key =
    (token ?? (await getSecret(target === "vercel" ? VERCEL_SECRET : NETLIFY_SECRET)))?.trim();
  if (!key) return { ok: false, detail: "No token saved yet — paste one first." };

  try {
    if (target === "vercel") {
      const user = (await call("https://api.vercel.com/v9/user", { method: "GET", token: key })) as {
        user?: { username?: string; email?: string };
      };
      const who = user.user?.username ?? user.user?.email ?? "an account";
      return { ok: true, detail: `Signed in as ${who}.` };
    }
    const accounts = (await call("https://api.netlify.com/api/v1/accounts", {
      method: "GET",
      token: key,
    })) as { slug?: string }[];
    const who = accounts[0]?.slug ?? "an account";
    return { ok: true, detail: `Signed in as ${who}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError(`deploy test:${target}`, error);
    return { ok: false, detail: `Refused (${message}).` };
  }
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "forge-app";

/** Deploy the files as a real Vercel deployment and return its URL. */
export async function deployVercel(
  token: string,
  name: string,
  files: { path: string; content: string }[],
): Promise<DeployResult> {
  try {
    const payload = {
      name: `${slugOf(name)}-${Date.now().toString(36).slice(-5)}`,
      files: files.map((file) => ({ file: file.path, data: file.content })),
      projectSettings: { framework: null },
    };
    const result = (await call("https://api.vercel.com/v13/deployments", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    })) as { url?: string; id?: string };
    const url = result.url ? `https://${result.url}` : null;
    return {
      ok: true,
      detail: url ? `Deployed — ${url}` : "Deployment created.",
      url,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError("deploy vercel", error);
    return { ok: false, detail: `Vercel refused (${message}).`, url: null };
  }
}

/** Create the site if needed, then deploy the files to Netlify. */
export async function deployNetlify(
  token: string,
  name: string,
  files: { path: string; content: string }[],
): Promise<DeployResult> {
  try {
    const slug = `${slugOf(name)}-${Date.now().toString(36).slice(-5)}`;
    let site: { id?: string; ssl_url?: string; url?: string } = {};
    try {
      site = (await call("https://api.netlify.com/api/v1/sites", {
        method: "POST",
        token,
        body: JSON.stringify({ name: slug }),
      })) as typeof site;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A name clash means the site already exists — look it up and use it.
      if (!/already|exists|conflict/i.test(message)) throw error;
      const matches = (await call(
        `https://api.netlify.com/api/v1/sites?name=${encodeURIComponent(slug)}`,
        { method: "GET", token },
      )) as (typeof site)[];
      site = matches[0] ?? {};
    }

    const siteId = site.id;
    if (!siteId) throw new Error("No site id came back from Netlify.");

    const deploy = (await call(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: "POST",
      token,
      body: JSON.stringify({
        files: files.map((file) => ({ path: file.path, content: file.content })),
      }),
    })) as { ssl_url?: string; url?: string };

    const url = deploy.ssl_url ?? deploy.url ?? null;
    return { ok: true, detail: url ? `Deployed — ${url}` : "Deploy created.", url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError("deploy netlify", error);
    return { ok: false, detail: `Netlify refused (${message}).`, url: null };
  }
}
