import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import {
  backupZip,
  dataAsJson,
  linuxKit,
  sourceAsText,
  stampOf,
  type HubBackup,
  type SourceMap,
} from "@/lib/backup";
import { downloadBlob, downloadText, readableSize } from "@/lib/download";
import { useConvex } from "convex/react";
import {
  Archive,
  Container,
  Database,
  FileCode,
  Loader2,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Taking the hub with you.
 *
 * Four ways out, each built here in the browser from what the hub already
 * holds — nothing is uploaded to make a file:
 *
 *   - everything: the app *and* its data, in one zip
 *   - the app alone, with a Dockerfile that runs it on your own computer
 *   - the whole code as one readable text file
 *   - the data alone, as JSON
 *
 * The heavy reads happen only when a button is pressed, so opening the page
 * never drags a megabyte across the wire.
 *
 * It also has to work when the hub's database does not. This page can be opened
 * without signing in (see `PublicShell`), so it asks the live database for the
 * newest copy — the app *with* the AI Builder's changes merged in — and, if the
 * database will not answer, falls back to the copy of the app bundled into this
 * very page (`src/convex/self_source.ts`). The data export is the one thing that
 * genuinely needs the database, and it says so rather than pretending.
 */
type Job = "everything" | "program" | "text" | "data" | "steps" | null;

type SourceResult = { at: string; files: SourceMap; patched?: string[] };
type Manifest = { files: number; bytes: number; at: string; changed?: number };

/** How long to wait for the live database before using the bundled copy. */
const LIVE_TIMEOUT_MS = 4000;

export function BackupPanel() {
  const convex = useConvex();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  /** null while we are still finding out; false means the bundled copy. */
  const [live, setLive] = useState<boolean | null>(null);
  const [job, setJob] = useState<Job>(null);
  const [note, setNote] = useState<string | null>(null);

  // The hub's own address, so the kit it builds points back at the same place.
  const address = (import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "";

  // Ask the live database for its numbers once. A disabled deployment, a sign
  // out or a slow answer all land on the bundled copy, so a download still
  // works rather than the panel sitting dead.
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      if (alive) setLive((value) => value ?? false);
    }, LIVE_TIMEOUT_MS);

    convex
      .query(api.backup.manifest, {})
      .then((result) => {
        if (!alive) return;
        setManifest((result as Manifest | null) ?? null);
        setLive(true);
      })
      .catch(() => {
        if (!alive) return;
        setManifest(null);
        setLive(false);
      });

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [convex]);

  const getSource = async (): Promise<SourceResult> => {
    if (live !== false) {
      try {
        return (await convex.query(api.backup.source, {})) as SourceResult;
      } catch {
        // Fall through to the copy bundled into this page.
      }
    }

    const bundled = await import("@/convex/self_source");
    return {
      at: bundled.SELF_SNAPSHOT_AT,
      files: bundled.SELF_SOURCE as SourceMap,
      patched: [],
    };
  };

  const getData = async (): Promise<HubBackup | null> => {
    if (live === false) return null;
    try {
      return (await convex.query(api.backup.data, {})) as HubBackup;
    } catch {
      return null;
    }
  };

  async function take(kind: Exclude<Job, null>) {
    setJob(kind);
    setNote(null);

    try {
      if (kind === "text") {
        const snapshot = await getSource();
        downloadText(
          `private-hub-source-${stampOf(snapshot.at)}`,
          sourceAsText(snapshot.files, snapshot.at),
        );
        setNote("Saved the whole app as one text file.");
        toast.success("Saved the whole app as one text file.");
        return;
      }

      if (kind === "data") {
        const exportData = await getData();
        if (!exportData) {
          const message =
            "The data copy needs the live hub database, and it is not answering right now. Try again once it is back.";
          setNote(message);
          toast.error(message);
          return;
        }
        downloadBlob(
          `private-hub-data-${stampOf(exportData.at)}.json`,
          new Blob([dataAsJson(exportData)], { type: "application/json" }),
        );
        setNote("Saved everything the hub has written down.");
        toast.success("Saved everything the hub has written down.");
        return;
      }

      if (kind === "steps") {
        const kit = linuxKit(address);
        const text = [
          kit["INSTALL.md"],
          "\n\n------------------------------------------------------------\n",
          "Dockerfile\n\n",
          kit["Dockerfile"],
          "\n\n------------------------------------------------------------\n",
          "docker-compose.yml\n\n",
          kit["docker-compose.yml"],
          "\n\n------------------------------------------------------------\n",
          "nginx.conf\n\n",
          kit["nginx.conf"],
        ].join("");
        downloadText("private-hub-linux-steps", text);
        setNote("Saved the Linux steps and the three files they mention.");
        toast.success("Saved the Linux steps.");
        return;
      }

      const [snapshot, exportData] = await Promise.all([
        getSource(),
        getData(),
      ]);
      const blob = backupZip({
        at: snapshot.at,
        files: snapshot.files,
        data: exportData,
        convexUrl: address,
        includeSource: true,
        includeData: kind === "everything" && exportData !== null,
      });
      const stamp = stampOf(snapshot.at);
      const name =
        kind === "everything"
          ? `private-hub-backup-${stamp}.zip`
          : `private-hub-app-${stamp}.zip`;
      downloadBlob(name, blob);
      const message =
        kind === "everything"
          ? exportData
            ? "Saved the app and its data in one zip."
            : "Saved the app and its code in one zip. The data copy needs the live database, so it is not in there."
          : "Saved a copy you can run with Docker.";
      setNote(message);
      toast.success(message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "That backup could not be made.";
      setNote(message);
      toast.error(message);
    } finally {
      setJob(null);
    }
  }

  const busy = job !== null;
  // The bundled copy is always there, so a download is possible the moment we
  // know the live database is not — and only once it has answered when it is.
  const ready = live === false || Boolean(manifest);

  const rows: Array<{
    id: Exclude<Job, null>;
    icon: typeof Archive;
    title: string;
    body: string;
    action: string;
    primary?: boolean;
  }> = [
    {
      id: "everything",
      icon: Archive,
      title: "Everything — the app and its data",
      body: "One zip holding the whole app, any fix the AI Builder has made to it, a Dockerfile that runs it on your own computer, and a JSON copy of everything the hub has written down. This is the one to keep.",
      action: "Save .zip",
      primary: true,
    },
    {
      id: "program",
      icon: Container,
      title: "The app, ready to run",
      body: "The same zip without the data: the code, the generated Convex types, and the Docker files. On a Linux laptop, unzip it and run docker compose up --build.",
      action: "Save .zip",
    },
    {
      id: "text",
      icon: FileCode,
      title: "The code, readable",
      body: "Every file the hub is made of, one after another in a single text file. Opens in any editor, needs nothing installed, and can be split back into files by hand.",
      action: "Save .txt",
    },
    {
      id: "data",
      icon: Database,
      title: "The data alone",
      body: "Messages, calendar, shopping list, memories, reminders, the Builder's files and links to attachments — as plain JSON that a person or a script can read. Needs the live database.",
      action: "Save .json",
    },
    {
      id: "steps",
      icon: TerminalSquare,
      title: "The Linux steps",
      body: "The install guide with the Dockerfile, compose file and nginx config it refers to, so you can follow it without unzipping anything first.",
      action: "Save .txt",
    },
  ];

  return (
    <>
      <p className="text-[10px] leading-4 text-muted-foreground">
        Everything here is made on this device from what the hub already holds —
        nothing is uploaded to produce a file, and the hub keeps running exactly
        as it is afterwards.
      </p>

      {live === false ? (
        <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
          The live hub database is not answering, so the code downloads below are
          built from the copy of the app that ships inside this page. They still
          work — only the data copy needs the database.
        </p>
      ) : manifest ? (
        <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
          Ready:{" "}
          <span className="text-foreground">
            {manifest.files} files, {readableSize(manifest.bytes)}
          </span>{" "}
          of code, snapshotted{" "}
          {new Date(manifest.at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
          .
          {manifest.changed ? (
            <>
              {" "}
              <span className="text-foreground">
                {manifest.changed} file{manifest.changed === 1 ? "" : "s"} changed
                by the AI Builder
              </span>{" "}
              {manifest.changed === 1 ? "is" : "are"} included in every download
              below.
            </>
          ) : null}
        </p>
      ) : null}

      <ul className="mt-1.5 divide-y divide-border/60">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start gap-4 py-3">
            <row.icon
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium">{row.title}</p>
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                {row.body}
              </p>
            </div>

            <div className="shrink-0 pt-0.5">
              <Button
                type="button"
                size="sm"
                variant={row.primary ? "default" : "outline"}
                disabled={busy || !ready}
                onClick={() => void take(row.id)}
                className="h-8 cursor-pointer rounded-lg text-[10px]"
              >
                {job === row.id ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <row.icon className="size-3" />
                )}
                {job === row.id ? "Working" : row.action}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {note ? (
        <p className="mt-2 text-[9px] leading-4 text-muted-foreground">{note}</p>
      ) : null}

      <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
        Where this lives: the downloads go straight to this device — the hub
        never sees them. The data copy is capped at the most recent few thousand
        rows per table and lists what it left out, so it says what it is rather
        than pretending to be everything.
      </p>
    </>
  );
}

export default BackupPanel;
