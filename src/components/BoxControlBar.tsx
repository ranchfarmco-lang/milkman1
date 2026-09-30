import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatRoom } from "@/hooks/use-chat";
import { useBoxFiles } from "@/hooks/use-box-files";
import { downloadText, downloadUrl, readableSize } from "@/lib/download";
import {
  boxLink,
  boxTitle,
  copyText,
  otherBoxes,
  readClipboard,
  shareToBox,
} from "@/lib/internal-share";
import { cn } from "@/lib/utils";
import {
  Check,
  ClipboardPaste,
  Copy,
  Download,
  FileUp,
  ImagePlus,
  Link2,
  Loader2,
  Paperclip,
  Plus,
  Share2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

export type BoxControlBarProps = {
  /** The thing this bar sits on, in words. Every button says its name. */
  label: string;
  /** Which box these buttons act on. Decides where uploads land and who can
   *  receive a share. */
  room: ChatRoom;
  /** What copy, share and download act on — the transcript, the latest answer. */
  text?: string;
  /** Empty this box out. */
  onClear?: () => void;
  /** Put pasted clipboard text into this box's own input. Left out where there
   *  is no input to paste into. */
  onPaste?: (text: string) => void;
  /** Called when the browser refuses to hand over the clipboard, so the box can
   *  put the cursor where the person can paste it themselves. */
  onPasteFallback?: () => void;
  /** Add a new thing here. Left out where there is nothing to add. */
  onAdd?: () => void;
  className?: string;
};

/**
 * Every button a box needs, in the top-right of that box: delete, add, upload
 * an image, upload a file, share to another box, copy the box link, copy the
 * content, paste, download, and the files already attached.
 *
 * All of it stays inside the hub. Uploads go to this box's own storage, a share
 * only offers the boxes that live here, and nothing opens the device's share
 * sheet or another app.
 */
export function BoxControlBar({
  label,
  room,
  text,
  onClear,
  onPaste,
  onPasteFallback,
  onAdd,
  className,
}: BoxControlBarProps) {
  const {
    files,
    upload,
    remove,
    share: shareFile,
    clear: clearFiles,
    busy,
  } = useBoxFiles(room);

  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The button that was just pressed, so it can show a tick for a moment. */
  const [flash, setFlash] = useState<string | null>(null);

  const tick = (key: string) => {
    setFlash(key);
    window.setTimeout(
      () => setFlash((current) => (current === key ? null : current)),
      1500,
    );
  };

  const handlePick = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    // Let the same file be picked again straight afterwards.
    event.target.value = "";
    if (!picked.length) return;
    void upload(picked);
  };

  const hasText = Boolean(text?.trim());

  const copyContent = async () => {
    if (!hasText) {
      toast.error(`Nothing in ${label} to copy yet.`);
      return;
    }
    if (await copyText(text ?? "")) {
      tick("copy");
      toast.success(`Copied ${label}.`);
    } else {
      toast.error("This browser would not let the hub copy. Select it by hand.");
    }
  };

  const copyLink = async () => {
    if (await copyText(boxLink(room))) {
      tick("link");
      toast.success(`Link to ${boxTitle(room)} copied.`);
    } else {
      toast.error("This browser would not let the hub copy the link.");
    }
  };

  const pasteIn = async () => {
    const clipped = await readClipboard();
    if (!clipped?.trim()) {
      // No clipboard access — put the cursor where the person can paste it
      // themselves and say exactly how. Safari and plain http land here.
      onPasteFallback?.();
      toast.error(
        "This browser will not hand the hub your clipboard. The cursor is in the box — press Ctrl/Cmd+V, or long-press for Paste.",
      );
      return;
    }
    onPaste?.(clipped);
    tick("paste");
    toast.success(`Pasted into ${label}.`);
  };

  const download = () => {
    if (!hasText) {
      toast.error(`Nothing in ${label} to save yet.`);
      return;
    }
    downloadText(label, text ?? "");
    tick("download");
  };

  const share = (target: ChatRoom) => {
    if (!hasText) {
      toast.error(`Nothing in ${label} to share yet.`);
      return;
    }
    if (shareToBox(target, text ?? "")) {
      tick("share");
      toast.success(`Sent to ${boxTitle(target)} — open that box to finish it.`);
    } else {
      toast.error("This browser would not let the hub share.");
    }
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-1",
        className,
      )}
      role="toolbar"
      aria-label={`${label} controls`}
    >
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handlePick}
        aria-hidden="true"
        tabIndex={-1}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={handlePick}
        aria-hidden="true"
        tabIndex={-1}
      />

      <div className="inline-flex flex-wrap items-center justify-end gap-0.5 rounded-xl border border-border/60 bg-background/40 px-0.5 py-0.5">
        {onClear ? (
          // Deleting takes the box's uploads with the transcript, so it asks
          // first, and says out loud how many files are about to go.
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete — ${label}`}
                title={`Delete everything in ${label} — text, pictures and files`}
                className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="rounded-2xl border-border/70 bg-card/95 backdrop-blur-sm">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-[13px] tracking-tight">
                  Delete everything in {label}?
                </AlertDialogTitle>
                <AlertDialogDescription className="text-[11px] leading-4">
                  This clears the conversation
                  {files.length > 0
                    ? ` and ${files.length} ${files.length === 1 ? "file" : "files"}`
                    : ""}{" "}
                  in {label}. It cannot be undone — save anything you want to keep
                  first.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="cursor-pointer">
                  Keep it
                </AlertDialogCancel>
                <AlertDialogAction
                  className="cursor-pointer"
                  onClick={() => {
                    // The label promises everything, so the box's own uploads go
                    // with the transcript rather than being left behind.
                    void clearFiles();
                    onClear();
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}

        {onAdd ? (
          <BarButton
            icon={Plus}
            word="Add"
            label={label}
            hint={`Add something to ${label}`}
            onClick={onAdd}
          />
        ) : null}

        <BarButton
          icon={ImagePlus}
          word="Upload image"
          label={label}
          hint={`Upload an image into ${label}`}
          onClick={() => imageInput.current?.click()}
        />

        <BarButton
          icon={FileUp}
          word="Upload file"
          label={label}
          hint={`Upload a file into ${label}`}
          onClick={() => fileInput.current?.click()}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Share ${label}`}
              title={`Share ${label} with another box`}
              className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
            >
              {flash === "share" ? (
                <Check className="size-3.5" />
              ) : (
                <Share2 className="size-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-[11px]">
              Share inside the hub
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {otherBoxes(room).map((target) => (
              <DropdownMenuItem
                key={target}
                onSelect={() => share(target)}
                className="text-[12px]"
              >
                <Share2 className="size-3.5" />
                Send to {boxTitle(target)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <BarButton
          icon={flash === "link" ? Check : Link2}
          word="Copy link"
          label={label}
          hint={`Copy the link to ${boxTitle(room)}`}
          onClick={() => void copyLink()}
        />

        <BarButton
          icon={flash === "copy" ? Check : Copy}
          word="Copy"
          label={label}
          hint={`Copy everything in ${label}`}
          onClick={() => void copyContent()}
        />

        {onPaste ? (
          <BarButton
            icon={flash === "paste" ? Check : ClipboardPaste}
            word="Paste"
            label={label}
            hint={`Paste the clipboard into ${label}`}
            onClick={() => void pasteIn()}
          />
        ) : null}

        <BarButton
          icon={flash === "download" ? Check : Download}
          word="Download"
          label={label}
          hint={`Save ${label} to this device`}
          onClick={download}
        />

        {files.length > 0 || busy ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Files in ${label}`}
                title={`${files.length} ${files.length === 1 ? "file" : "files"} in ${label}`}
                className="h-7 w-auto gap-1 rounded-lg px-1.5 text-muted-foreground hover:text-foreground"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Paperclip className="size-3.5" />
                )}
                {files.length > 0 ? (
                  <span className="text-[10px] font-medium tabular-nums">
                    {files.length}
                  </span>
                ) : null}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-[11px]">
                Files in {label}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {files.length === 0 ? (
                <DropdownMenuItem disabled className="text-[12px]">
                  <Loader2 className="size-3.5 animate-spin" />
                  Uploading…
                </DropdownMenuItem>
              ) : (
                files.map((file) => (
                  <div
                    key={file._id}
                    className="flex items-center gap-1 rounded-sm px-1 py-0.5"
                  >
                    {file.contentType.startsWith("image/") && file.url ? (
                      <img
                        src={file.url}
                        alt=""
                        className="size-7 shrink-0 rounded-md border border-border/60 object-cover"
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        file.url
                          ? void downloadUrl(file.name, file.url)
                          : toast.error(`${file.name} has no link yet.`)
                      }
                      className="min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left text-[12px] hover:bg-accent"
                      title={`Save ${file.name} to this device`}
                    >
                      <span className="block truncate">{file.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {readableSize(file.size)}
                      </span>
                    </button>

                    {/* Send the picture or file into another box, without
                        copying the bytes or leaving the hub. */}
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        aria-label={`Share ${file.name}`}
                        title={`Share ${file.name} inside the hub`}
                        className="size-6 shrink-0 justify-center rounded-md p-0 text-muted-foreground data-[state=open]:text-foreground"
                      >
                        <Share2 className="size-3" />
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-52">
                        <DropdownMenuLabel className="truncate text-[11px]">
                          Send {file.name}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {otherBoxes(room).map((target) => (
                          <DropdownMenuItem
                            key={target}
                            onSelect={() =>
                              void shareFile(file._id, target, file.name)
                            }
                            className="text-[12px]"
                          >
                            <Share2 className="size-3.5" />
                            Send to {boxTitle(target)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${file.name}`}
                      title={`Remove ${file.name}`}
                      className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => void remove(file._id, file.name)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

/** One button of the bar. Icon only, but it always says what it does. */
function BarButton({
  icon: Icon,
  word,
  label,
  hint,
  onClick,
}: {
  icon: LucideIcon;
  word: string;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      aria-label={`${word} — ${label}`}
      title={hint}
      className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </Button>
  );
}
