/**
 * The AI Builder's workbench.
 *
 * Convex has no filesystem, so this is a real one built out of documents: the
 * builder writes files here, reads them back on later turns, greps through
 * them, and runs them. That is what lets it build something across many turns
 * instead of retyping the whole thing every time you say hello.
 *
 * Deliberately kept separate from this app's own source. Nothing written here
 * can change the app — self-repair works off the read-only snapshot in
 * `self_source.ts`, and produces a patch for a human to apply.
 *
 * Everything written here is mirrored into the workshop (`sandbox.ts`) as well,
 * when this family has connected one, so a program on the bench can run for
 * real, and one bench file can import another.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { isUnlocked } from "./guard";
import { SELF_SOURCE } from "./self_source";

/** The ceiling on one file, and on the whole bench. */
const MAX_FILE_CHARS = 200_000;
const MAX_FILES = 800;
const MAX_TOTAL_CHARS = 8_000_000;

/** How many matching lines a search will return before it stops. */
const MAX_MATCHES = 60;

/**
 * Turn whatever the model wrote into a path a person would recognise: always
 * relative, never climbing out of the bench, never absurdly long.
 */
export function cleanPath(raw: string) {
  const parts: string[] = [];

  for (const segment of raw.trim().replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment.slice(0, 80));
  }

  return parts.join("/").slice(0, 200);
}

/** Every file on the bench, smallest first — the shape of the project. */
export const list = internalQuery({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();

    const files = rows
      .map((row) => ({
        path: row.path,
        language: row.language ?? null,
        chars: row.content.length,
        updatedAt: row.updatedAt,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      files,
      totalChars: files.reduce((sum, file) => sum + file.chars, 0),
    };
  },
});

/** One file in full, or nothing if it was never written. */
export const read = internalQuery({
  args: { ownerId: v.id("users"), path: v.string() },
  handler: async (ctx, { ownerId, path }) => {
    const clean = cleanPath(path);
    if (!clean) return null;

    const row = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("path", clean))
      .unique();

    if (!row) return null;

    return {
      path: row.path,
      content: row.content,
      language: row.language ?? null,
      updatedAt: row.updatedAt,
    };
  },
});

/** Write a file, or overwrite one that is already there. */
export const write = internalMutation({
  args: {
    ownerId: v.id("users"),
    path: v.string(),
    content: v.string(),
    language: v.optional(v.string()),
  },
  handler: async (ctx, { ownerId, path, content, language }) => {
    const clean = cleanPath(path);
    if (!clean) {
      return { ok: false as const, reason: "That is not a usable file path." };
    }

    const body = content.slice(0, MAX_FILE_CHARS);
    const truncated = content.length > MAX_FILE_CHARS;
    const now = Date.now();

    const existing = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("path", clean))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: body,
        language: language || existing.language,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.sandbox.mirror, {
        path: clean,
        content: body,
      });
      return {
        ok: true as const,
        path: clean,
        chars: body.length,
        created: false,
        truncated,
      };
    }

    const all = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();

    if (all.length >= MAX_FILES) {
      return {
        ok: false as const,
        reason: `The bench is full at ${MAX_FILES} files. Delete one first.`,
      };
    }

    const total = all.reduce((sum, row) => sum + row.content.length, 0);
    if (total + body.length > MAX_TOTAL_CHARS) {
      return {
        ok: false as const,
        reason: "The bench is full. Delete something first.",
      };
    }

    await ctx.db.insert("files", {
      ownerId,
      path: clean,
      content: body,
      language: language || undefined,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.sandbox.mirror, {
      path: clean,
      content: body,
    });

    return {
      ok: true as const,
      path: clean,
      chars: body.length,
      created: true,
      truncated,
    };
  },
});

/** Take a file off the bench. */
export const remove = internalMutation({
  args: { ownerId: v.id("users"), path: v.string() },
  handler: async (ctx, { ownerId, path }) => {
    const clean = cleanPath(path);

    const row = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("path", clean))
      .unique();

    if (!row) {
      return { ok: false as const, reason: `There is no ${clean} on the bench.` };
    }

    await ctx.db.delete(row._id);
    await ctx.scheduler.runAfter(0, internal.sandbox.mirror, { path: clean });
    return { ok: true as const, path: clean };
  },
});

/** Empty the bench. Used when the builder wants a clean slate. */
export const clear = internalMutation({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();

    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});

/**
 * Change one file on the bench by replacing exact text. This is what makes a
 * large file — a whole module, a page of the project — editable without
 * rewriting all of it, which is the difference between rebuilding something
 * real and only ever writing snippets.
 */
export const patch = internalMutation({
  args: {
    ownerId: v.id("users"),
    path: v.string(),
    search: v.string(),
    replace: v.string(),
  },
  handler: async (ctx, { ownerId, path, search, replace }) => {
    const clean = cleanPath(path);

    const row = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("path", clean))
      .unique();

    if (!row) {
      return {
        ok: false as const,
        path: clean,
        message: `There is no ${clean} on the bench. Write it first, or scaffold_project to get this app's own copy.`,
      };
    }

    let count = 0;
    let at = -1;
    let cursor = 0;

    for (;;) {
      const found = row.content.indexOf(search, cursor);
      if (found < 0) break;
      count += 1;
      if (count === 1) at = found;
      cursor = found + Math.max(1, search.length);
    }

    if (count === 0) {
      return {
        ok: false as const,
        path: clean,
        message: `That text is not in ${clean}, so nothing changed. "search" has to match character for character, whitespace included — read the file and copy the exact lines.`,
      };
    }

    if (count > 1) {
      return {
        ok: false as const,
        path: clean,
        message: `That text appears ${count} times in ${clean}, so it is not clear which one you mean. Include more of the lines around it so it is unique.`,
      };
    }

    const after = row.content.slice(0, at) + replace + row.content.slice(at + search.length);
    const body = after.slice(0, MAX_FILE_CHARS);
    const cutShort = after.length > MAX_FILE_CHARS;

    await ctx.db.patch(row._id, { content: body, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.sandbox.mirror, {
      path: clean,
      content: body,
    });

    return {
      ok: true as const,
      path: clean,
      message: `Changed ${clean} — 1 place replaced.${
        cutShort ? " It grew past the file ceiling and was cut short." : ""
      } It is on the bench and mirrored to the workshop machine, so run it or typecheck it next.`,
    };
  },
});

/** Rename or move a file on the bench. */
export const move = internalMutation({
  args: { ownerId: v.id("users"), path: v.string(), to: v.string() },
  handler: async (ctx, { ownerId, path, to }) => {
    const from = cleanPath(path);
    const target = cleanPath(to);
    if (!from || !target) {
      return { ok: false as const, path: from, message: "That is not a usable file path." };
    }

    const row = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("path", from))
      .unique();

    if (!row) {
      return { ok: false as const, path: from, message: `There is no ${from} on the bench.` };
    }

    const clash = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("path", target))
      .unique();

    if (clash) {
      return {
        ok: false as const,
        path: from,
        message: `${target} is already on the bench. Delete it first if you mean to overwrite it.`,
      };
    }

    await ctx.db.patch(row._id, { path: target, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.sandbox.mirror, { path: from });
    await ctx.scheduler.runAfter(0, internal.sandbox.mirror, {
      path: target,
      content: row.content,
    });

    return { ok: true as const, path: target, message: `Moved ${from} to ${target}.` };
  },
});

/**
 * Put this whole project on the bench: every file of the snapshot, exactly as
 * it ships. That is what lets the builder rebuild or rework the entire app —
 * read any file, change it with edit_file, and run the whole thing on the
 * workshop machine — instead of only writing new snippets beside it.
 *
 * Files that already match are left alone, so calling it again is cheap.
 */
export const scaffold = internalMutation({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    const names = Object.keys(SELF_SOURCE).sort();
    const existing = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    const byPath = new Map(existing.map((row) => [row.path, row] as const));

    let files = 0;
    let chars = 0;
    let skipped = 0;

    for (const name of names) {
      const clean = cleanPath(name);
      if (!clean) continue;

      const content = SELF_SOURCE[name].slice(0, MAX_FILE_CHARS);
      const row = byPath.get(clean);

      if (row && row.content === content) {
        skipped += 1;
        continue;
      }

      if (row) {
        await ctx.db.patch(row._id, { content, updatedAt: Date.now() });
      } else {
        await ctx.db.insert("files", {
          ownerId,
          path: clean,
          content,
          updatedAt: Date.now(),
        });
      }

      await ctx.scheduler.runAfter(0, internal.sandbox.mirror, {
        path: clean,
        content,
      });
      files += 1;
      chars += content.length;
    }

    return { files, chars, skipped };
  },
});

/* ------------------------------------------------------- running preview */

/** How much composed page the preview will hand to a browser. */
const MAX_PREVIEW_CHARS = 400_000;

/** The folder a file sits in, for resolving what a page links to. */
function dirOf(path: string) {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * Where a link or a script points, relative to the page that asked for it.
 *
 * Anything outside the bench is left alone: an `https://` address, a `data:`
 * URL or a `#anchor` is not ours to inline, and a link to another site must
 * still go to that site.
 */
function resolveInBench(baseDir: string, target: string) {
  const value = target.trim().split(/[?#]/)[0];
  if (!value) return null;
  if (/^(https?:)?\/\//i.test(value)) return null;
  if (/^(data|blob|mailto):/i.test(value)) return null;
  if (value.startsWith("#") || value.startsWith("/")) return null;

  const parts = (baseDir ? `${baseDir}/${value}` : value).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }

  return out.join("/") || null;
}

/**
 * The builder's project, made into one page that actually runs.
 *
 * The preview pane has to show a result rather than describe one, and a whole
 * app on the bench is several files that a browser cannot be handed directly:
 * `srcDoc` has no origin, so a relative `<link href="styles.css">` inside it
 * would resolve against the hub and 404. So the entry page is read, and each
 * stylesheet and script it points at is folded into it by hand — one document,
 * nothing left to fetch.
 *
 * It is a query, so the pane is live: every file the builder writes re-runs
 * this and the finished page redraws, with no reload and no rebuild step.
 */
export const preview = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    if (!(await isUnlocked(ctx))) return null;

    const rows = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();

    if (!rows.length) return null;

    const bench = new Map(rows.map((row) => [row.path, row.content] as const));

    // The entry page: an index.html nearest the root, or the only one there is.
    const pages = [...bench.keys()]
      .filter((path) => /\.html?$/i.test(path))
      .sort(
        (a, b) =>
          a.split("/").length - b.split("/").length || a.localeCompare(b),
      );

    const entry =
      pages.find((path) => /(^|\/)index\.html?$/i.test(path)) ??
      (pages.length === 1 ? pages[0] : null);

    if (!entry) return null;

    const base = dirOf(entry);

    let html = (bench.get(entry) ?? "")
      .replace(/<link\b[^>]*>/gi, (tag) => {
        if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        const path = href ? resolveInBench(base, href) : null;
        const css = path ? bench.get(path) : undefined;
        return css === undefined ? tag : `<style>\n${css}\n</style>`;
      })
      .replace(
        /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi,
        (tag, src: string) => {
          const path = resolveInBench(base, src);
          const js = path ? bench.get(path) : undefined;
          return js === undefined ? tag : `<script>\n${js}\n</script>`;
        },
      );

    if (html.length > MAX_PREVIEW_CHARS) {
      html = html.slice(0, MAX_PREVIEW_CHARS);
    }

    return {
      entry,
      html,
      pages: pages.slice(0, 40),
      files: rows.length,
    };
  },
});

/** Grep the bench: literal text, with line numbers, so it can find its own work. */
export const search = internalQuery({
  args: {
    ownerId: v.id("users"),
    query: v.string(),
    matchCase: v.optional(v.boolean()),
  },
  handler: async (ctx, { ownerId, query, matchCase }) => {
    const needle = query.slice(0, 200);
    if (!needle.trim()) return { matches: [], truncated: false, scanned: 0 };

    const rows = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();

    const wanted = matchCase ? needle : needle.toLowerCase();
    const matches: { path: string; line: number; text: string }[] = [];
    let scanned = 0;
    let truncated = false;

    for (const row of rows) {
      const lines = row.content.split("\n");
      scanned += row.content.length;

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const haystack = matchCase ? line : line.toLowerCase();
        if (!haystack.includes(wanted)) continue;

        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({
          path: row.path,
          line: index + 1,
          text: line.slice(0, 200),
        });
      }

      if (truncated) break;
    }

    return { matches, truncated, scanned };
  },
});
