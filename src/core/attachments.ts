import type * as acp from "@agentclientprotocol/sdk";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readImage } from "./clipboard";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** A paste becomes a placeholder past either limit. */
const PASTE_LINES = 4;
const PASTE_CHARS = 1200;

const PASTE_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;
const IMAGE_RE = /\[Image #(\d+)\]/g;
const MENTION_RE = /(^|\s)@("[^"]+"|[^\s]+)/g;

/** The path an `@` mention names: its quotes and any trailing punctuation dropped. */
const mentionPath = (raw: string) => raw.replace(/^"(.*)"$/, "$1").replace(/[.,;:!?)]+$/, "");

/**
 * What a prompt carries besides its typed text: long pastes folded into
 * placeholders, images, and files mentioned with `@`.
 */
export class Attachments {
  private pastes = new Map<number, { text: string; lines: number }>();
  private images = new Map<number, { data: string; mimeType: string }>();
  private nextPaste = 1;
  private nextImage = 1;

  /** The text to insert for a paste: the paste itself when short, else a placeholder for it. */
  paste(text: string): string {
    const lines = text.split("\n").length;
    if (lines <= PASTE_LINES && text.length <= PASTE_CHARS) return text;
    const id = this.nextPaste++;
    this.pastes.set(id, { text, lines });
    return `[Pasted text #${id} +${lines} lines]`;
  }

  /** The placeholder for an image, given its bytes. */
  image(bytes: Uint8Array, mimeType: string): string {
    const id = this.nextImage++;
    this.images.set(id, { data: Buffer.from(bytes).toString("base64"), mimeType });
    return `[Image #${id}]`;
  }

  /** The placeholder for the image at `path` when a paste is just that path, as a dragged file is. */
  async imageFromPath(text: string): Promise<string | null> {
    const path = text.trim().replace(/^'(.*)'$/, "$1").replace(/\\ /g, " ");
    const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mimeType || path.includes("\n") || !isAbsolute(path)) return null;
    try {
      return this.image(new Uint8Array(await Bun.file(path).arrayBuffer()), mimeType);
    } catch {
      return null;
    }
  }

  /** The image on the system clipboard as a placeholder, or null when there is none. */
  async imageFromClipboard(): Promise<string | null> {
    const bytes = await readImage();
    return bytes ? this.image(bytes, "image/png") : null;
  }

  /** The prompt as the agent should see it: placeholders expanded, images and mentioned files attached. */
  async blocks(text: string, cwd: string, canImage: boolean): Promise<acp.ContentBlock[]> {
    const images: acp.ContentBlock[] = [];
    const body = text
      .replace(PASTE_RE, (whole, id) => this.pastes.get(Number(id))?.text ?? whole)
      .replace(IMAGE_RE, (whole, id) => {
        const img = this.images.get(Number(id));
        if (!img || !canImage) return whole;
        images.push({ type: "image", data: img.data, mimeType: img.mimeType });
        return whole;
      });

    const links: acp.ContentBlock[] = [];
    const seen = new Set<string>();
    for (const m of body.matchAll(MENTION_RE)) {
      const rel = mentionPath(m[2]!);
      const abs = resolve(cwd, rel);
      if (seen.has(abs)) continue;
      const info = await stat(abs).catch(() => null);
      if (!info) continue;
      seen.add(abs);
      links.push({ type: "resource_link", uri: pathToFileURL(abs).href, name: basename(abs) || rel, ...(info.isFile() ? { size: info.size } : {}) });
    }
    return [{ type: "text", text: body }, ...links, ...images];
  }

  /** Summarizes placeholders and `@` mentions currently present in `text` for UI chips. */
  describe(text: string): { mentions: string[]; pastes: { id: number; lines: number }[]; images: { id: number; mimeType: string }[] } {
    const pastes: { id: number; lines: number }[] = [];
    const seenPaste = new Set<number>();
    for (const m of text.matchAll(PASTE_RE)) {
      const id = Number(m[1]);
      if (seenPaste.has(id)) continue;
      const paste = this.pastes.get(id);
      if (!paste) continue;
      seenPaste.add(id);
      pastes.push({ id, lines: paste.lines });
    }
    const images: { id: number; mimeType: string }[] = [];
    const seenImage = new Set<number>();
    for (const m of text.matchAll(IMAGE_RE)) {
      const id = Number(m[1]);
      if (seenImage.has(id)) continue;
      const img = this.images.get(id);
      if (!img) continue;
      seenImage.add(id);
      images.push({ id, mimeType: img.mimeType });
    }
    const mentions: string[] = [];
    const seenMention = new Set<string>();
    for (const m of text.matchAll(MENTION_RE)) {
      const rel = mentionPath(m[2]!);
      if (!rel || seenMention.has(rel)) continue;
      seenMention.add(rel);
      mentions.push(rel);
    }
    return { mentions, pastes, images };
  }
}

/** The `@partial` being typed just before the cursor, if any. */
export function mentionAt(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const m = /(^|\s)@([^\s]*)$/.exec(before);
  return m ? { start: before.length - m[2]!.length - 1, query: m[2]! } : null;
}

/** The `/command` token being typed at the start of the prompt when the cursor is inside it. */
export function slashAt(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const m = /^\/([^\s]*)$/.exec(before);
  if (!m) return null;
  // Only complete while still on the command name (before any whitespace).
  if (/\s/.test(text.slice(cursor))) return null;
  return { start: 0, query: m[1]! };
}
