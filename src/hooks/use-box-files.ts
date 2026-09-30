import type { ChatRoom } from "@/hooks/use-chat";
import { api } from "@/convex/_generated/api";
import { readableSize } from "@/lib/download";
import { boxTitle } from "@/lib/internal-share";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

/** Anything larger than this stays on the device. Matches the backend limit. */
const MAX_BYTES = 25 * 1024 * 1024;

export type BoxFile = {
  _id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: number;
  url: string | null;
};

/**
 * The files attached to one box: what is there, adding more, sending one to
 * another box, removing one, and emptying the box.
 *
 * The bytes go straight from the browser to Convex storage; only the label on
 * them goes through a function. The same room rules as the messages apply, so
 * the family room is shared and the two AI boxes are yours alone.
 */
export function useBoxFiles(room: ChatRoom) {
  const rows = useQuery(api.files.list, { room });
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const attach = useMutation(api.files.attach);
  const removeFile = useMutation(api.files.remove);
  const shareFile = useMutation(api.files.share);
  const clearFiles = useMutation(api.files.clear);

  const [busy, setBusy] = useState(false);

  const upload = useCallback(
    async (files: File[]) => {
      if (!files.length) return;

      setBusy(true);
      let added = 0;

      for (const file of files) {
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name} is too big — keep files under 25 MB.`);
          continue;
        }

        try {
          const uploadUrl = await generateUploadUrl({});
          const response = await fetch(uploadUrl, {
            method: "POST",
            headers: {
              "Content-Type": file.type || "application/octet-stream",
            },
            body: file,
          });
          if (!response.ok) throw new Error(String(response.status));

          const { storageId } = (await response.json()) as {
            storageId: string;
          };

          await attach({
            room,
            // The id comes back from storage as a string; the backend types it.
            storageId: storageId as never,
            name: file.name,
            contentType: file.type || "application/octet-stream",
            size: file.size,
          });
          added += 1;
        } catch {
          toast.error(`${file.name} did not finish uploading. Try it again.`);
        }
      }

      setBusy(false);
      if (added === 1) toast.success("File attached to this box.");
      if (added > 1) toast.success(`${added} files attached to this box.`);
    },
    [attach, generateUploadUrl, room],
  );

  const remove = useCallback(
    async (id: string, name: string) => {
      try {
        await removeFile({ id: id as never });
        toast.success(`${name} removed.`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not remove that file.",
        );
      }
    },
    [removeFile],
  );

  /** Send one file to another box in the hub. The bytes are not copied. */
  const share = useCallback(
    async (id: string, target: ChatRoom, name: string) => {
      if (target === room) return false;

      try {
        await shareFile({ id: id as never, room: target });
        toast.success(`${name} sent to ${boxTitle(target)} — open that box to use it.`);
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not share that file.",
        );
        return false;
      }
    },
    [room, shareFile],
  );

  /** Empty this box of its files, storage included. */
  const clear = useCallback(async () => {
    try {
      await clearFiles({ room });
    } catch {
      // The box may already be empty, or the browser may be offline.
    }
  }, [clearFiles, room]);

  const files = (rows ?? []) as BoxFile[];

  return {
    files,
    upload,
    remove,
    share,
    clear,
    busy,
    isLoading: rows === undefined,
  };
}

export { readableSize };
