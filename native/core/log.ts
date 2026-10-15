/**
 * §43 Logging.
 *
 * Six categories — server, network, browser, tunnel, security, application —
 * held in a bounded ring buffer so a long-running host cannot grow without
 * limit. Everything is searchable and downloadable, and every value passes
 * through `redact()` on the way in: a secret that never enters the buffer
 * cannot leak out of it.
 */

export type LogCategory =
  | "server"
  | "network"
  | "browser"
  | "tunnel"
  | "security"
  | "application";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  at: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  /** Extra facts, already redacted. */
  detail?: Record<string, string | number | boolean | null>;
};

const CATEGORIES: LogCategory[] = [
  "server",
  "network",
  "browser",
  "tunnel",
  "security",
  "application",
];

/** Whatever looks like a credential is replaced before it is stored. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "«redacted-token»"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "«redacted-key»"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "«redacted-jwt»"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer «redacted»"],
  [/\b(?:password|passwd|secret|token|apikey|api_key|authorization)\b\s*[:=]\s*\S+/gi, "$1=«redacted»"],
];

/** A URL that carries a credential in its query string keeps the shape, not the value. */
const SECRET_QUERY = /([?&](?:token|key|apikey|api_key|password|secret|access_token)=)[^&\s]*/gi;

export function redact(value: string): string {
  let out = value.replace(SECRET_QUERY, "$1«redacted»");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function redactDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!detail) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(detail)) {
    if (/password|secret|token|key|credential|authorization/i.test(key)) {
      out[key] = "«redacted»";
      continue;
    }
    if (raw === null || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = raw;
    } else {
      out[key] = redact(String(raw));
    }
  }
  return out;
}

export class LogBus {
  private entries: LogEntry[] = [];
  private readonly limit: number;
  private listeners = new Set<(entry: LogEntry) => void>();
  /** When true, entries also reach stdout — the foreground/service mode. */
  echo = false;

  constructor(limit = 2000) {
    this.limit = limit;
  }

  write(
    level: LogLevel,
    category: LogCategory,
    message: string,
    detail?: Record<string, unknown>,
  ): LogEntry {
    const entry: LogEntry = {
      at: Date.now(),
      level,
      category,
      message: redact(message),
      detail: redactDetail(detail),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    if (this.echo) {
      const line = `${new Date(entry.at).toISOString()} ${level.toUpperCase().padEnd(5)} ${category.padEnd(11)} ${entry.message}`;
      if (level === "error") console.error(line);
      else console.log(line);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* a broken listener must never break the host */
      }
    }
    return entry;
  }

  debug(c: LogCategory, m: string, d?: Record<string, unknown>) {
    return this.write("debug", c, m, d);
  }
  info(c: LogCategory, m: string, d?: Record<string, unknown>) {
    return this.write("info", c, m, d);
  }
  warn(c: LogCategory, m: string, d?: Record<string, unknown>) {
    return this.write("warn", c, m, d);
  }
  error(c: LogCategory, m: string, d?: Record<string, unknown>) {
    return this.write("error", c, m, d);
  }

  /** Newest first, optionally filtered — what the portal and CLI show. */
  search(options: {
    category?: LogCategory;
    level?: LogLevel;
    text?: string;
    limit?: number;
  } = {}): LogEntry[] {
    const { category, level, text, limit = 200 } = options;
    const needle = text?.toLowerCase();
    const found: LogEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && found.length < limit; i -= 1) {
      const entry = this.entries[i];
      if (category && entry.category !== category) continue;
      if (level && entry.level !== level) continue;
      if (needle) {
        const haystack = `${entry.message} ${JSON.stringify(entry.detail ?? {})}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      found.push(entry);
    }
    return found;
  }

  counts(): Record<LogCategory, number> {
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<
      LogCategory,
      number
    >;
    for (const entry of this.entries) counts[entry.category] += 1;
    return counts;
  }

  /** The whole buffer as one downloadable text file. */
  asText(entries?: LogEntry[]): string {
    const rows = entries ?? this.entries;
    return rows
      .map((entry) => {
        const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
        return `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase().padEnd(5)} ${entry.category.padEnd(11)} ${entry.message}${detail}`;
      })
      .join("\n");
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear() {
    this.entries = [];
  }
}

/** The process-wide bus: every module logs through this one. */
export const log = new LogBus();
