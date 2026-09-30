/**
 * Splitting a reply into prose and fenced code.
 *
 * It lives on its own because two panels need the same answer: the transcript
 * shows every message, the preview pane shows only the newest one, and neither
 * of them should own the rule for where a code fence starts.
 */
export function splitFences(text: string) {
  const blocks: { type: "text" | "code"; content: string }[] = [];
  const pattern = /```[a-zA-Z0-9]*\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      blocks.push({ type: "text", content: text.slice(cursor, match.index) });
    }
    blocks.push({ type: "code", content: match[1].replace(/\s+$/, "") });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    blocks.push({ type: "text", content: text.slice(cursor) });
  }

  return blocks
    .map((block) => ({ ...block, content: block.content.trim() }))
    .filter((block) => block.content.length > 0);
}

/**
 * A reply, split into the two halves the boxes show separately.
 *
 * The chat is the conversation and nothing else: what the AI actually said.
 * Everything it *produced* — code, documents, a whole app — is fenced, and
 * belongs in the preview pane instead. So `dialogue` is the prose around the
 * fences, and `product` is every fenced block. A reply with no fences has no
 * product: it was all conversation.
 */
export function splitArtifact(text: string) {
  const blocks = splitFences(text);

  const dialogue = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.content)
    .join("\n\n")
    .trim();

  const product = blocks.filter((block) => block.type === "code");

  return { dialogue, product };
}
