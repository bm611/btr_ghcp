import { type CliRenderer, type MarkdownOptions, RGBA, type Renderable, StyledText, SyntaxStyle, TextRenderable, bg, bold, fg } from "@opentui/core";
import { styled } from "./text";

// Replies styled after glow's default "dark" and "light" styles, so they read the way
// `glow` renders a document. The renderer is still OpenTUI's; nothing runs glow.

export type MarkdownStyle = "glow" | "btr";

export type GlowPalette = {
  text: string;
  heading: string;
  h1Fg: string;
  h1Bg: string;
  h6: string;
  codeFg: string;
  codeBg: string;
  link: string;
  linkText: string;
  rule: string;
  quote: string;
  bullet: string;
  // Code blocks
  comment: string;
  keyword: string;
  keywordReserved: string;
  type: string;
  operator: string;
  punctuation: string;
  builtin: string;
  tag: string;
  attribute: string;
  func: string;
  number: string;
  string: string;
  escape: string;
  decorator: string;
};

/** glow's "dark" style. */
const glowDark: GlowPalette = {
  text: "#d0d0d0",
  heading: "#00afff",
  h1Fg: "#ffff87",
  h1Bg: "#5f5fff",
  h6: "#00af87",
  codeFg: "#ff5f5f",
  codeBg: "#303030",
  link: "#008787",
  linkText: "#00af87",
  rule: "#585858",
  quote: "#8a8a8a",
  bullet: "#d0d0d0",
  comment: "#676767",
  keyword: "#00aaff",
  keywordReserved: "#ff5fd2",
  type: "#6e6ed8",
  operator: "#ef8080",
  punctuation: "#e8e8a8",
  builtin: "#ff8ec7",
  tag: "#b083ea",
  attribute: "#7a7ae6",
  func: "#00d787",
  number: "#6eefc0",
  string: "#c69669",
  escape: "#afffd7",
  decorator: "#ffff87",
};

/** glow's "light" style. */
const glowLight: GlowPalette = {
  text: "#262626",
  heading: "#005fff",
  h1Fg: "#ffff87",
  h1Bg: "#5f5fff",
  h6: "#00875f",
  codeFg: "#d7005f",
  codeBg: "#e4e4e4",
  link: "#008787",
  linkText: "#00875f",
  rule: "#b2b2b2",
  quote: "#6c6c6c",
  bullet: "#262626",
  comment: "#8d8d8d",
  keyword: "#279efc",
  keywordReserved: "#d7008f",
  type: "#5f5fd7",
  operator: "#d75f5f",
  punctuation: "#4e4e4e",
  builtin: "#cd4b76",
  tag: "#8700d7",
  attribute: "#5f5fd7",
  func: "#00875f",
  number: "#008787",
  string: "#a0522d",
  escape: "#005f5f",
  decorator: "#875f00",
};

/**
 * The glow markdown style is glow's own colors whatever the theme, by the theme's lightness;
 * the plain "btr" style is the one that follows the theme (monochrome under fx).
 */
export const glowPalette = (light: boolean): GlowPalette => (light ? glowLight : glowDark);

export function glowSyntaxStyle(g: GlowPalette, scene: Parameters<typeof SyntaxStyle.fromStyles>[1]) {
  const heading = { fg: g.heading, bold: true };
  return SyntaxStyle.fromStyles(
    {
      default: { fg: g.text },
      "markup.heading": heading,
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`markup.heading.${n}`, heading])),
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.strikethrough": { dim: true },
      "markup.raw": { fg: g.codeFg, bg: g.codeBg },
      "markup.raw.block": { fg: g.text },
      "markup.link.label": { fg: g.linkText, bold: true },
      "markup.link.url": { fg: g.link, underline: true },
      "markup.link": { fg: g.link, underline: true },
      "markup.list": { fg: g.bullet },
      "markup.quote": { fg: g.quote, italic: true },
      conceal: { fg: g.rule },
      comment: { fg: g.comment },
      keyword: { fg: g.keyword },
      "keyword.return": { fg: g.keywordReserved },
      "keyword.import": { fg: g.keywordReserved },
      "keyword.export": { fg: g.keywordReserved },
      "keyword.function": { fg: g.keyword },
      type: { fg: g.type },
      "type.builtin": { fg: g.type },
      operator: { fg: g.operator },
      punctuation: { fg: g.punctuation },
      "punctuation.bracket": { fg: g.punctuation },
      "punctuation.delimiter": { fg: g.punctuation },
      "variable.builtin": { fg: g.builtin },
      "function.builtin": { fg: g.builtin },
      constant: { fg: g.number },
      "constant.builtin": { fg: g.builtin },
      tag: { fg: g.tag },
      attribute: { fg: g.attribute },
      function: { fg: g.func },
      "function.method": { fg: g.func },
      "function.call": { fg: g.func },
      number: { fg: g.number },
      boolean: { fg: g.number },
      string: { fg: g.string },
      "string.escape": { fg: g.escape },
      "string.special": { fg: g.escape },
      property: { fg: g.text },
      variable: { fg: g.text },
      "variable.parameter": { fg: g.text },
      decorator: { fg: g.decorator },
    },
    scene,
  );
}

/**
 * The parts of glow's look that styles alone cannot give: headings keep their
 * `##` markers (a level-1 heading is a colored band), code blocks are indented,
 * and inline code is padded on a background.
 */
export function glowHooks(renderer: CliRenderer, g: GlowPalette): Pick<MarkdownOptions, "renderBlock" | "inlineHook"> {
  const codeFg = RGBA.fromHex(g.codeFg);
  const codeBg = RGBA.fromHex(g.codeBg);
  return {
    renderBlock(block, context) {
      if (block.kind === "heading") {
        const level = block.level ?? 1;
        const content =
          level === 1
            ? styled(bold(bg(g.h1Bg)(fg(g.h1Fg)(` ${block.text} `))))
            : level === 6
              ? styled(fg(g.h6)(`${"#".repeat(level)} ${block.text}`))
              : styled(bold(fg(g.heading)(`${"#".repeat(level)} ${block.text}`)));
        return new TextRenderable(renderer, { content, flexShrink: 0, wrapMode: "word" });
      }
      if (block.kind === "code") {
        const code = context.defaultRender();
        if (code) code.marginLeft = 2;
        return code;
      }
      return undefined;
    },
    inlineHook: (spans) => spans.map((sp) => (sp.code ? { ...sp, text: ` ${sp.text} `, fg: codeFg, bg: codeBg } : sp)),
  };
}

/**
 * Draws list bullets as glow does, "•" in place of "-". OpenTUI fixes the marker text,
 * so this rewrites the markers it built; it runs again after every change of content,
 * since a change to a list draws its markers anew.
 */
export function glowBullets(node: Renderable) {
  for (const child of node.getChildren() as Renderable[]) {
    if (child instanceof TextRenderable && child.id.endsWith("-marker")) {
      const chunks = child.content.chunks;
      const first = chunks[0];
      if (first && first.text.startsWith("-")) child.content = new StyledText([{ ...first, text: "•" + first.text.slice(1) }, ...chunks.slice(1)]);
    } else glowBullets(child);
  }
}
