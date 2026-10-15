import { useCallApi } from "@/components/CallProvider";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useChat } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import {
  Loader2,
  MessageCircle,
  Mic,
  Phone,
  Send,
  Square,
  Upload,
  Video,
  X,
} from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

type FileRow = FunctionReturnType<typeof api.files.list>[number];
type Mode = "none" | "chat" | "calls" | "files";

/**
 * The browser's dock: the app's live surfaces, on the page while you browse.
 *
 * The point of the browser being part of the hub rather than beside it is that
 * the messenger, the calls and the files are here — you can send a voice note
 * about the page you are reading, take the call, or hand over a file, without
 * leaving what you are looking at. Everything below is the app's own machinery:
 * the same thread, the same call picker, the same storage.
 */
export function BrowserDock() {
  const [mode, setMode] = useState<Mode>("none");

  return (
    <div className="shrink-0 rounded-xl border border-border/70 bg-card/60">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <DockTab
          active={mode === "chat"}
          onClick={() => setMode(mode === "chat" ? "none" : "chat")}
          icon={<MessageCircle className="size-3" />}
          label="Chat"
        />
        <DockTab
          active={mode === "calls"}
          onClick={() => setMode(mode === "calls" ? "none" : "calls")}
          icon={<Phone className="size-3" />}
          label="Calls"
        />
        <DockTab
          active={mode === "files"}
          onClick={() => setMode(mode === "files" ? "none" : "files")}
          icon={<Upload className="size-3" />}
          label="Transfers"
        />
        {mode !== "none" ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close the dock"
            onClick={() => setMode("none")}
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>

      {mode === "chat" ? <ChatDock /> : null}
      {mode === "calls" ? <CallsDock /> : null}
      {mode === "files" ? <FilesDock /> : null}
    </div>
  );
}

function DockTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
      className="h-7 cursor-pointer rounded-lg text-[10px]"
    >
      {icon}
      {label}
    </Button>
  );
}

/* ------------------------------------------------------------------- chat */

function ChatDock() {
  const chat = useChat("messenger");
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const attachFile = useMutation(api.files.attach);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const sendVoiceNote = useCallback(
    async (blob: Blob) => {
      setBusy(true);
      try {
        const uploadUrl = await generateUploadUrl({});
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": blob.type || "audio/webm" },
          body: blob,
        });
        if (!response.ok) throw new Error(`The upload failed with HTTP ${response.status}.`);
        const { storageId } = (await response.json()) as { storageId: string };
        await attachFile({
          room: "messenger",
          storageId: storageId as Id<"_storage">,
          name: `voice-note-${Date.now()}.webm`,
          contentType: blob.type || "audio/webm",
          size: blob.size,
        });
        await chat.sendMessage(`🎤 voice note (${Math.max(1, Math.round(blob.size / 1024))} KB)`);
        toast.success("Voice note sent to the family.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not send that note.");
      } finally {
        setBusy(false);
      }
    },
    [attachFile, chat, generateUploadUrl],
  );

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("This browser cannot record audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const machine = new MediaRecorder(stream);
      chunks.current = [];
      machine.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      machine.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        const blob = new Blob(chunks.current, {
          type: machine.mimeType || "audio/webm",
        });
        if (blob.size) void sendVoiceNote(blob);
      };
      machine.start();
      recorder.current = machine;
      setRecording(true);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `The microphone could not be opened: ${error.message}`
          : "The microphone could not be opened.",
      );
    }
  }, [sendVoiceNote]);

  const stopRecording = useCallback(() => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }, []);

  const send = useCallback(async () => {
    const message = text.trim();
    if (!message) return;
    setText("");
    await chat.sendMessage(message);
  }, [chat, text]);

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 px-2.5 py-2">
      <div className="flex max-h-56 min-h-[80px] flex-col gap-1 overflow-y-auto">
        {chat.messages.length ? (
          chat.messages.slice(-40).map((message) => (
            <div
              key={message.id}
              className={cn(
                "max-w-[80%] rounded-lg border px-2 py-1 text-[11px] leading-4",
                message.mine
                  ? "self-end border-white/20 bg-white/[0.08]"
                  : "self-start border-border/60 bg-background/50",
              )}
            >
              {!message.mine && message.authorName ? (
                <span className="block text-[9px] text-muted-foreground">
                  {message.authorName}
                </span>
              ) : null}
              <span className="whitespace-pre-wrap">{message.text}</span>
            </div>
          ))
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Nothing said yet. Messages here are the same thread as the Messenger
            tab, and the AI replies land in the Assistant box.
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Message the family…"
          spellCheck
          className="h-8 min-w-0 flex-1 rounded-lg border border-border/60 bg-background/60 px-2 text-[11px] outline-none placeholder:text-muted-foreground"
        />
        <Button
          type="button"
          size="icon-sm"
          variant={recording ? "destructive" : "outline"}
          aria-label={recording ? "Stop recording" : "Record a voice note"}
          title={recording ? "Stop and send" : "Record a voice note"}
          disabled={busy}
          onClick={() => (recording ? stopRecording() : void startRecording())}
          className="shrink-0"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : recording ? (
            <Square className="size-3" />
          ) : (
            <Mic className="size-3" />
          )}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          aria-label="Send"
          disabled={!text.trim()}
          onClick={() => void send()}
          className="shrink-0"
        >
          <Send className="size-3" />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ calls */

function CallsDock() {
  const callApi = useCallApi();
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-2.5 py-2">
      <Button
        type="button"
        variant="outline"
        onClick={() => callApi.openPicker("audio")}
        className="h-7 cursor-pointer rounded-lg text-[10px]"
      >
        <Phone className="size-3" />
        Phone call
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => callApi.openPicker("video")}
        className="h-7 cursor-pointer rounded-lg text-[10px]"
      >
        <Video className="size-3" />
        Video call
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => callApi.ringEveryone("audio")}
        className="h-7 cursor-pointer rounded-lg text-[10px]"
      >
        <Phone className="size-3" />
        Ring everyone
      </Button>
      <p className="w-full text-[10px] leading-4 text-muted-foreground">
        Calls run over the app's own live media — the relay when one is
        configured, otherwise straight between the devices. A call keeps running
        while you browse.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- transfers */

function FilesDock() {
  const files = useQuery(api.files.list, { room: "messenger" });
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const attachFile = useMutation(api.files.attach);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const uploadUrl = await generateUploadUrl({});
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!response.ok) throw new Error(`The upload failed with HTTP ${response.status}.`);
        const { storageId } = (await response.json()) as { storageId: string };
        await attachFile({
          room: "messenger",
          storageId: storageId as Id<"_storage">,
          name: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        });
        toast.success(`${file.name} is in the family files.`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "The upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [attachFile, generateUploadUrl],
  );

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="h-7 cursor-pointer rounded-lg text-[10px]"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
          Send a file
        </Button>
        <input
          ref={input}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
        <span className="text-[10px] text-muted-foreground">
          Files are shared with the family thread.
        </span>
      </div>

      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {files?.length ? (
          files
            .slice(-30)
            .reverse()
            .map((row: FileRow) => (
              <div key={row._id} className="flex items-center gap-2">
                <a
                  href={row.url ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-[11px]"
                  title={row.name}
                >
                  {row.name}
                </a>
                <span className="shrink-0 text-[9px] text-muted-foreground">
                  {Math.max(1, Math.round(row.size / 1024))} KB
                </span>
              </div>
            ))
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Nothing shared yet. A file sent here is on every device, and the
            browser's own downloads live under Transfers in its toolbar.
          </p>
        )}
      </div>
    </div>
  );
}
