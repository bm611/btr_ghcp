import { SyntaxStyle } from "@opentui/core";

export type Theme = {
  name: string;
  /** How the theme picker lists it. */
  label: string;
  hint: string;
  /** A light background. */
  light: boolean;
  /** Monochrome chrome in the style of Vercel's fx: plain titles instead of gradients and hatching. */
  mono: boolean;
  /** Brand colors: dialog borders, selections, gradients run from primary to secondary. */
  primary: string;
  secondary: string;
  /** Text on a primary background. */
  onPrimary: string;
  /** Text, from most to least prominent. Six levels give a clear reading order. */
  fg: string;
  fgSubtle: string;
  fgMuted: string;
  fgDim: string;
  fgFaint: string;
  fgGutter: string;
  /** Surfaces, from the page to the most raised. */
  bg: string;
  bgPanel: string;
  bgRaised: string;
  bgOverlay: string;
  separator: string;
  separatorSubtle: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  /** The mode names in the sidebar. */
  yolo: string;
  plan: string;
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

// xterm-256 grays, as fx draws with them: 235 #262626, 237 #3a3a3a, 239 #4e4e4e,
// 240 #585858, 243 #767676, 245 #8a8a8a, 247 #9e9e9e, 250 #bcbcbc, 252 #d0d0d0,
// 255 #eeeeee. Diff markers are fx's green and red.
// A theme added here shows up in the picker, /theme and the settings on its own.
export const themes = {
  fx: {
    name: "fx",
    label: "fx",
    hint: "monochrome dark",
    light: false,
    mono: true,
    primary: "#eeeeee",
    secondary: "#d0d0d0",
    onPrimary: "#262626",
    fg: "#eeeeee",
    fgSubtle: "#d0d0d0",
    fgMuted: "#9e9e9e",
    fgDim: "#8a8a8a",
    fgFaint: "#707070",
    fgGutter: "#585858",
    bg: "#000000",
    bgPanel: "#0d0d0d",
    bgRaised: "#2a2a2a",
    bgOverlay: "#000000cc",
    separator: "#3a3a3a",
    separatorSubtle: "#262626",
    success: "#30a46c",
    error: "#e5484d",
    warning: "#e5a93c",
    info: "#5fafff",
    yolo: "#e5a93c",
    plan: "#5fafff",
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
    label: "fx light",
    hint: "monochrome light",
    light: true,
    mono: true,
    primary: "#262626",
    secondary: "#444444",
    onPrimary: "#eeeeee",
    fg: "#262626",
    fgSubtle: "#444444",
    fgMuted: "#626262",
    fgDim: "#767676",
    fgFaint: "#8c8c8c",
    fgGutter: "#b8b8b8",
    bg: "#ffffff",
    bgPanel: "#f7f7f7",
    bgRaised: "#e8e8e8",
    bgOverlay: "#ffffffcc",
    separator: "#d0d0d0",
    separatorSubtle: "#e8e8e8",
    success: "#2b8a5a",
    error: "#cd2b31",
    warning: "#b26b00",
    info: "#005faf",
    yolo: "#b26b00",
    plan: "#005faf",
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
    label: "Charm",
    hint: "dark",
    light: false,
    mono: false,
    primary: "#6b50ff",
    secondary: "#ff60ff",
    onPrimary: "#fffaf1",
    fg: "#dfdbdd",
    fgSubtle: "#bfbcc8",
    fgMuted: "#858392",
    fgDim: "#706d7d",
    fgFaint: "#605f6b",
    fgGutter: "#3a3943",
    bg: "#201f26",
    bgPanel: "#262530",
    bgRaised: "#3a3943",
    bgOverlay: "#201f26cc",
    separator: "#3a3943",
    separatorSubtle: "#2d2c35",
    success: "#12c78f",
    error: "#eb4268",
    warning: "#f5ef34",
    info: "#00a4ff",
    yolo: "#e8fe96",
    plan: "#8b75ff",
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
    label: "Daylight",
    hint: "light",
    light: true,
    mono: false,
    primary: "#6b50ff",
    secondary: "#d33ed3",
    onPrimary: "#fffaf1",
    fg: "#201f26",
    fgSubtle: "#3a3943",
    fgMuted: "#605f6b",
    fgDim: "#767484",
    fgFaint: "#858392",
    fgGutter: "#dfdbdd",
    bg: "#fffaf1",
    bgPanel: "#f5f3f3",
    bgRaised: "#dfdbdd",
    bgOverlay: "#fffaf1cc",
    separator: "#dfdbdd",
    separatorSubtle: "#ece9e9",
    success: "#0a9c77",
    error: "#d3254e",
    warning: "#a18800",
    info: "#0077cc",
    yolo: "#8f9a00",
    plan: "#6b50ff",
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
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof themes;

/** The theme for a setting: "auto" follows the terminal, fx when it is dark and fx light when it is light. */
export function themeFor(setting: string, terminal: "light" | "dark" | null): Theme {
  if (setting === "auto" || !Object.hasOwn(themes, setting)) return terminal === "light" ? themes["fx-light"] : themes.fx;
  return themes[setting as ThemeName];
}

/** The glyphs the interface is drawn with. Every one is a single cell wide. */
export const G = {
  hatch: "╱",
  check: "✓",
  dot: "●",
  pending: "•",
  arrow: "→",
  model: "◇",
  diamond: "◆",
  thick: "▌",
  thin: "▏",
  rule: "─",
  ruleThick: "━",
  ellipsis: "…",
  prompt: ">",
  thought: "∴",
  rail: "┃",
  railThin: "│",
  fail: "✗",
  select: "›",
  stop: "▪",
  warn: "⚠",
  todo: "○",
  closed: "▸",
  open: "▾",
  bullet: "•",
  middot: "·",
  pipe: "│",
  corner: "└",
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
  down: "↓",
  wrap: "↩",
};

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
      "markup.link.url": { fg: th.fgDim },
      "markup.link": { fg: th.info },
      "markup.list": { fg: th.primary },
      "markup.quote": { fg: th.fgMuted, italic: true },
      conceal: { fg: th.fgGutter },
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
