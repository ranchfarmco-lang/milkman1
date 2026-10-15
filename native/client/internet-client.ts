/**
 * §6 Built-in Internet client, §30 Internet agent.
 *
 * This is the host's own outbound networking layer. It does not need Chrome,
 * Edge, Firefox or Safari to be open, and it never borrows a browser's session:
 * it makes the requests itself, over Node's HTTP stack, with TLS validated by
 * the platform trust store and redirects followed deliberately rather than
 * blindly.
 *
 * Every failure mode the specification lists is a named outcome here —
 * `timeout`, `dns`, `connection`, `http`, `redirect-loop`, `auth`,
 * `rate-limit`, `offline`, `tls` — because a caller that only receives "it
 * failed" cannot show anyone a useful sentence (§21).
 *
 * §30's rules about other people's servers are part of the contract: the agent
 * identifies itself, it does not retry a 429 until told to, and it refuses to
 * walk into a private address range on behalf of a remote caller (see
 * `isPublicTarget`), so the portal cannot be used to probe the host's own
 * network.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { log } from "../core/log.ts";

export type FailureKind =
  | "timeout"
  | "dns"
  | "connection"
  | "tls"
  | "http"
  | "auth"
  | "rate-limit"
  | "redirect-loop"
  | "offline"
  | "refused"
  | "too-large";

export type ClientResult<T> = {
  ok: boolean;
  status: number | null;
  ms: number;
  /** The URL the response finally came from, after any redirects. */
  finalUrl: string;
  headers: Record<string, string>;
  redirects: string[];
  failure: { kind: FailureKind; message: string } | null;
  body: T;
};

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Seconds. Defaults to 20. */
  timeoutSeconds?: number;
  /** How many redirects to follow. Set 0 to be told instead. */
  maxRedirects?: number;
  /** Bytes to keep. Anything past this is reported as `too-large`. */
  maxBytes?: number;
  /** Send the caller's own Authorization header through (§30, authenticated calls). */
  authorization?: string;
  /** Treat any non-2xx as a failure with `ok: false`. On by default. */
  throwOnHttpError?: boolean;
};

const UA = "SUGAR/1.0 (+native host; outbound internet client)";
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * §65 — the portal must never become a way to reach the host's own network.
 * The client will only follow a request to a public address; loopback,
 * link-local, and the private ranges answer with `refused`.
 */
export function isPublicTarget(hostname: string, addresses: string[]): boolean {
  const privateV4 = /^(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|0\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.18\.|192\.0\.2\.)/;
  const name = hostname.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) {
    return false;
  }
  if (addresses.length === 0) return true;
  for (const address of addresses) {
    if (privateV4.test(address)) return false;
    const lower = address.toLowerCase();
    if (
      lower === "::1" ||
      lower.startsWith("fe80:") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower === "::ffff:127.0.0.1"
    ) {
      return false;
    }
  }
  return true;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * One outbound request, with the whole failure taxonomy attached.
 *
 * `force` exists for exactly one call site: the local reachability probe, which
 * must be allowed to talk to 127.0.0.1. Every request that originates from a
 * remote portal caller goes through the public-target check.
 */
export async function request<T = string>(
  url: string,
  options: RequestOptions & { force?: boolean } = {},
): Promise<ClientResult<T | string>> {
  const started = Date.now();
  const {
    method = "GET",
    headers = {},
    body,
    timeoutSeconds = 20,
    maxRedirects = 5,
    maxBytes = DEFAULT_MAX_BYTES,
    authorization,
    throwOnHttpError = true,
    force = false,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);

  const base: ClientResult<T | string> = {
    ok: false,
    status: null,
    ms: 0,
    finalUrl: url,
    headers: {},
    redirects: [],
    failure: null,
    body: "",
  };

  const fail = (kind: FailureKind, message: string): ClientResult<T | string> => ({
    ...base,
    ms: Date.now() - started,
    failure: { kind, message },
  });

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return fail("refused", `"${url}" is not a URL the client can use.`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return fail("refused", `The client only speaks HTTP and HTTPS, not ${target.protocol.replace(":", "")}.`);
  }

  if (!force) {
    let addresses: string[] = [];
    try {
      addresses = (await dnsLookup(target.hostname, { all: true })).map((entry) => entry.address);
    } catch {
      // A name that does not resolve is answered by the request itself, with a
      // better error than this check could give; only refuse a resolvable name
      // that points inward.
      addresses = [];
    }
    if (!isPublicTarget(target.hostname, addresses)) {
      log.warn("security", "Refused an outbound request aimed at a private address.", { url });
      return fail(
        "refused",
        "That address is on this machine's own network. The host will not make requests to private addresses on behalf of a remote caller (§65).",
      );
    }
  }

  const sentHeaders: Record<string, string> = {
    "user-agent": UA,
    accept: "*/*",
    ...headers,
  };
  if (authorization) sentHeaders.authorization = authorization;

  try {
    const response = await fetch(target, {
      method,
      headers: sentHeaders,
      // The body is a string or bytes; RequestInit's own type covers both, and
      // casting through it avoids depending on which lib defines BodyInit.
      body: (body ?? undefined) as RequestInit["body"],
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: true,
          status: response.status,
          ms: Date.now() - started,
          finalUrl: target.toString(),
          headers: headersToObject(response.headers),
          redirects: [],
          failure: null,
          body: "",
        };
      }
      const next = new URL(location, target).toString();
      if (maxRedirects <= 0) {
        return {
          ok: true,
          status: response.status,
          ms: Date.now() - started,
          finalUrl: next,
          headers: headersToObject(response.headers),
          redirects: [next],
          failure: null,
          body: "",
        };
      }
      // The same public-target rule applies to wherever the redirect points.
      const followed = await request<T>(next, { ...options, maxRedirects: maxRedirects - 1 });
      return {
        ...followed,
        redirects: [next, ...followed.redirects],
        ms: Date.now() - started,
      };
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared && declared > maxBytes) {
      return fail("too-large", `That file is ${Math.round(declared / 1024 / 1024)} MB, past the client's ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
    }

    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength > maxBytes) {
      return fail("too-large", `The response passed the client's ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = contentType.includes("json") || contentType.startsWith("text/") || contentType.includes("xml") || contentType === ""
      ? new TextDecoder().decode(raw)
      : "";

    const kind: FailureKind | null =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 429
          ? "rate-limit"
          : response.status >= 400
            ? "http"
            : null;

    const asError = throwOnHttpError && kind !== null && kind !== "rate-limit";
    const ok = !asError && (response.status < 400 || !throwOnHttpError);

    return {
      ok,
      status: response.status,
      ms: Date.now() - started,
      finalUrl: target.toString(),
      headers: headersToObject(response.headers),
      redirects: [],
      failure: asError && kind ? { kind, message: `The server answered ${response.status}.` } : null,
      body: (contentType.includes("json") ? safeJson(text) : (text || raw)) as T | string,
    };
  } catch (error) {
    if (controller.signal.aborted) return fail("timeout", `No answer within ${timeoutSeconds} seconds.`);
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return fail("dns", "That name could not be found on the Internet.");
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(message)) {
      return fail("connection", "The connection could not be made.");
    }
    if (/certificate|CERT|self.signed|unable to verify|TLS/i.test(message)) {
      return fail("tls", "The secure certificate for that site did not validate, so the client stopped.");
    }
    return fail("connection", message);
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ------------------------------------------------- the §30 agent interface --- */

export type AgentCall = {
  url: string;
  method?: RequestOptions["method"];
  headers?: Record<string, string>;
  body?: string;
  authorization?: string;
};

export class InternetAgent {
  get(url: string, options: Omit<RequestOptions, "method"> = {}) {
    return request(url, { ...options, method: "GET" });
  }
  post(url: string, body: string, options: Omit<RequestOptions, "method"> = {}) {
    return request(url, { ...options, method: "POST", body });
  }
  put(url: string, body: string, options: Omit<RequestOptions, "method"> = {}) {
    return request(url, { ...options, method: "PUT", body });
  }
  patch(url: string, body: string, options: Omit<RequestOptions, "method"> = {}) {
    return request(url, { ...options, method: "PATCH", body });
  }
  delete(url: string, options: Omit<RequestOptions, "method"> = {}) {
    return request(url, { ...options, method: "DELETE" });
  }
  json<T>(url: string, options: RequestOptions = {}) {
    return request<T>(url, {
      ...options,
      method: options.method ?? "GET",
      headers: { accept: "application/json", ...(options.headers ?? {}) },
    });
  }
  call(call: AgentCall) {
    return request(call.url, {
      method: call.method ?? "GET",
      headers: call.headers,
      body: call.body,
      authorization: call.authorization,
    });
  }
}

/** Download to a file, in one place, with the same failure taxonomy. */
export async function download(
  url: string,
  destination: (bytes: Uint8Array) => Promise<void> | void,
  options: RequestOptions = {},
  maxBytes = 256 * 1024 * 1024,
): Promise<ClientResult<Uint8Array>> {
  const result = await request<Uint8Array>(url, {
    ...options,
    method: options.method ?? "GET",
    maxBytes: options.maxBytes ?? maxBytes,
  });
  if (result.ok && result.body instanceof Uint8Array) {
    await destination(result.body);
    log.info("network", "Download complete.", { url: result.finalUrl, bytes: result.body.byteLength });
  }
  return result as ClientResult<Uint8Array>;
}

export const agent = new InternetAgent();
