import { SyntaxStyle, bold as boldText, fg, type TextChunk } from "@opentui/core";

export type ThemeName = "fx" | "fx-light" | "charm" | "daylight";

export type Theme = {
  name: ThemeName;
  /** A light background. */
  light: boolean;
  /** Monochrome chrome in the style of Vercel's fx: plain titles instead of gradients and hatching. */
  mono: boolean;
  /** Brand colors: dialog borders, selections, gradients run from primary to secondary. */
  primary: string;
  secondary: string;
  accent: string;
  /** Text on a primary background. */
  onPrimary: string;
  /** Text, from most to least prominent. */
  fg: string;
  fgSubtle: string;
  fgMuted: string;
  fgFaint: string;
  /** Surfaces, from the page to the most raised. */
  bg: string;
  bgPanel: string;
  bgRaised: string;
  separator: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  busy: string;
  yolo: string;
  plan: string;
  bash: string;
  memory: string;
  diffAdded: string;
  diffRemoved: string;
  diffAddedFg: string;
  diffRemovedFg: string;
  code: string;
  keyword: string;
  string: string;
  number: string;
  func: string;
  type: string;
};

// xterm-256 grays, as fx draws with them: 235 #262626, 239 #4e4e4e, 240 #585858,
// 245 #8a8a8a, 250 #bcbcbc, 252 #d0d0d0, 255 #eeeeee. Diff markers are fx's green and red.
export const themes: Record<ThemeName, Theme> = {
  fx: {
    name: "fx",
    light: false,
    mono: true,
    primary: "#eeeeee",
    secondary: "#d0d0d0",
    accent: "#eeeeee",
    onPrimary: "#262626",
    fg: "#eeeeee",
    fgSubtle: "#d0d0d0",
    fgMuted: "#8a8a8a",
    fgFaint: "#585858",
    bg: "#000000",
    bgPanel: "#121212",
    bgRaised: "#4e4e4e",
    separator: "#3a3a3a",
    success: "#d0d0d0",
    error: "#e5484d",
    warning: "#d0d0d0",
    info: "#5fafff",
    busy: "#eeeeee",
    yolo: "#eeeeee",
    plan: "#eeeeee",
    bash: "#eeeeee",
    memory: "#eeeeee",
    diffAdded: "#0b1a12",
    diffRemoved: "#1f0d0e",
    diffAddedFg: "#30a46c",
    diffRemovedFg: "#e5484d",
    code: "#eeeeee",
    keyword: "#eeeeee",
    string: "#bcbcbc",
    number: "#bcbcbc",
    func: "#d0d0d0",
    type: "#d0d0d0",
  },
  "fx-light": {
    name: "fx-light",
    light: true,
    mono: true,
    primary: "#262626",
    secondary: "#444444",
    accent: "#262626",
    onPrimary: "#eeeeee",
    fg: "#262626",
    fgSubtle: "#444444",
    fgMuted: "#767676",
    fgFaint: "#9e9e9e",
    bg: "#ffffff",
    bgPanel: "#f3f3f3",
    bgRaised: "#c6c6c6",
    separator: "#d0d0d0",
    success: "#444444",
    error: "#cd2b31",
    warning: "#444444",
    info: "#005faf",
    busy: "#262626",
    yolo: "#262626",
    plan: "#262626",
    bash: "#262626",
    memory: "#262626",
    diffAdded: "#e9f6ef",
    diffRemoved: "#fcecec",
    diffAddedFg: "#30a46c",
    diffRemovedFg: "#e5484d",
    code: "#262626",
    keyword: "#262626",
    string: "#626262",
    number: "#626262",
    func: "#444444",
    type: "#444444",
  },
  charm: {
    name: "charm",
    light: false,
    mono: false,
    primary: "#6b50ff",
    secondary: "#ff60ff",
    accent: "#68ffd6",
    onPrimary: "#fffaf1",
    fg: "#dfdbdd",
    fgSubtle: "#bfbcc8",
    fgMuted: "#858392",
    fgFaint: "#605f6b",
    bg: "#201f26",
    bgPanel: "#2d2c35",
    bgRaised: "#3a3943",
    separator: "#3a3943",
    success: "#12c78f",
    error: "#eb4268",
    warning: "#f5ef34",
    info: "#00a4ff",
    busy: "#e8ff27",
    yolo: "#e8fe96",
    plan: "#8b75ff",
    bash: "#8b75ff",
    memory: "#00a4ff",
    diffAdded: "#283a2c",
    diffRemoved: "#3b272c",
    diffAddedFg: "#629657",
    diffRemovedFg: "#a45c59",
    code: "#68ffd6",
    keyword: "#ff84ff",
    string: "#12c78f",
    number: "#ffb65c",
    func: "#00a4ff",
    type: "#a594ff",
  },
  daylight: {
    name: "daylight",
    light: true,
    mono: false,
    primary: "#6b50ff",
    secondary: "#d33ed3",
    accent: "#0a9c77",
    onPrimary: "#fffaf1",
    fg: "#201f26",
    fgSubtle: "#3a3943",
    fgMuted: "#605f6b",
    fgFaint: "#858392",
    bg: "#fffaf1",
    bgPanel: "#f1efef",
    bgRaised: "#dfdbdd",
    separator: "#dfdbdd",
    success: "#0a9c77",
    error: "#d3254e",
    warning: "#a18800",
    info: "#0077cc",
    busy: "#a18800",
    yolo: "#8f9a00",
    plan: "#6b50ff",
    bash: "#6b50ff",
    memory: "#0077cc",
    diffAdded: "#d8f0d6",
    diffRemoved: "#f8d7d9",
    diffAddedFg: "#3c7a34",
    diffRemovedFg: "#a43f3c",
    code: "#0a7c66",
    keyword: "#b02fb0",
    string: "#0a7c55",
    number: "#b35c00",
    func: "#0062b3",
    type: "#6b50ff",
  },
};

/** The glyphs the interface is drawn with. Every one is a single cell wide. */
export const G = {
  hatch: "╱",
  check: "✓",
  cross: "×",
  dot: "●",
  pending: "•",
  arrow: "→",
  model: "◇",
  diamond: "◆",
  radioOn: "◉",
  radioOff: "○",
  thick: "▌",
  thin: "│",
  rule: "─",
  ellipsis: "…",
  prompt: ">",
  more: ":::",
  thought: "∴",
  rail: "┃",
  fail: "✗",
  select: "›",
  stop: "▪",
  warn: "⚠",
  todo: "○",
  closed: "▸",
  open: "▾",
  // A folded turn's summary. Text-presentation symbols, one cell wide, in most fonts.
  tools: "⚙",
  read: "≡",
  search: "⌕",
  shell: "$",
  edit: "✎",
  write: "✚",
  del: "⌫",
  move: "⇢",
  fetch: "⇣",
};

/** Characters the working indicator scrambles through. */
export const SCRAMBLE = "0123456789abcdefABCDEF~!@#$%^&*()+=_";

export const PLACEHOLDERS = [
  "Ready for instructions",
  "What are we building?",
  "Ask anything · @ mentions a file",
  "ctrl+p for commands",
  "Type a prompt, or / for commands",
];

export const TIPS = [
  "ctrl+p opens the command palette",
  "Type @ to mention a file and attach it to your prompt",
  "Start a line with ! to run a shell command yourself",
  "shift+tab cycles between agent, plan and autopilot modes",
  "ctrl+d shows tool output and thinking in full",
  "ctrl+r searches your prompt history",
  "ctrl+s lists earlier sessions to resume",
  "ctrl+o writes a long prompt in your $EDITOR",
  "Keep typing while the agent works: enter queues your next message",
  "ctrl+b toggles the sidebar",
  "Run btr -c to continue your most recent conversation",
];

/** A color between `a` and `b`; `t` runs from 0 to 1. */
export function blend(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i]! - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, "0")).join("");
}

/** `text` with each character colored along a gradient. `offset` and `span` place it inside a longer gradient. */
export function gradient(text: string, from: string, to: string, opts: { bold?: boolean; offset?: number; span?: number } = {}): TextChunk[] {
  const chars = [...text];
  const span = opts.span ?? chars.length;
  const offset = opts.offset ?? 0;
  return chars.map((ch, i) => {
    const c = fg(blend(from, to, span <= 1 ? 0 : (offset + i) / (span - 1)))(ch);
    return opts.bold ? boldText(c) : c;
  });
}

/** A title followed by a hatched band that fills `width` cells, all on one gradient. Monochrome themes draw the title alone. */
export function hatchedTitle(th: Theme, title: string, width: number, trailing = 0): TextChunk[] {
  if (th.mono) return [boldText(fg(th.fg)(title))];
  const fill = Math.max(0, width - title.length - 1 - trailing);
  const span = title.length + 1 + fill;
  return [
    ...gradient(title, th.primary, th.secondary, { bold: true, span }),
    fg(th.bg)(" "),
    ...gradient(G.hatch.repeat(fill), th.primary, th.secondary, { offset: title.length + 1, span }),
  ];
}

export function syntaxStyleFor(th: Theme, scene: Parameters<typeof SyntaxStyle.fromStyles>[1]) {
  const heading = { fg: th.secondary, bold: true };
  return SyntaxStyle.fromStyles(
    {
      default: { fg: th.fg },
      "markup.heading": heading,
      "markup.heading.1": { fg: th.onPrimary, bg: th.primary, bold: true },
      ...Object.fromEntries([2, 3, 4, 5, 6].map((n) => [`markup.heading.${n}`, heading])),
      "markup.strong": { fg: th.fg, bold: true },
      "markup.italic": { italic: true },
      "markup.strikethrough": { dim: true },
      "markup.raw": { fg: th.code },
      "markup.raw.block": { fg: th.fg },
      "markup.link.label": { fg: th.info, underline: true },
      "markup.link.url": { fg: th.fgMuted },
      "markup.link": { fg: th.info },
      "markup.list": { fg: th.primary },
      "markup.quote": { fg: th.fgMuted, italic: true },
      conceal: { fg: th.fgFaint },
      keyword: { fg: th.keyword },
      string: { fg: th.string },
      comment: { fg: th.fgMuted, italic: true },
      number: { fg: th.number },
      constant: { fg: th.number },
      function: { fg: th.func },
      "function.method": { fg: th.func },
      type: { fg: th.type },
      property: { fg: th.fg },
      variable: { fg: th.fg },
      operator: { fg: th.fgSubtle },
      punctuation: { fg: th.fgMuted },
      tag: { fg: th.keyword },
      attribute: { fg: th.func },
    },
    scene,
  );
}

// ── glow-style Markdown ─────────────────────────────────────────────────────
// Colors after glow's default "dark" and "light" styles, so replies read the way
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
export const glowPalettes: Record<ThemeName, GlowPalette> = {
  fx: glowDark,
  "fx-light": glowLight,
  charm: glowDark,
  daylight: glowLight,
};

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
