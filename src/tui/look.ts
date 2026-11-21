import type { CliRenderer, SyntaxStyle } from "@opentui/core";
import { glowPalette, glowSyntaxStyle } from "../ui/glow";
import { type Theme, syntaxStyleFor, themeFor } from "../ui/theme";
import type { Settings } from "./settings";

/** The theme in use, and the syntax styles made from it. */
export class Look {
  th!: Theme;
  syntax!: SyntaxStyle;
  glowSyntax!: SyntaxStyle;

  private constructor(
    private renderer: CliRenderer,
    private settings: Settings,
    /** The terminal's own background, when it reports one. */
    private termBg: string | null,
  ) {
    this.reload();
  }

  static async create(renderer: CliRenderer, settings: Settings) {
    // Dialogs must cover what is behind them even when the theme's background is off.
    const termBg = await Promise.race([
      renderer
        .getPalette()
        .then((p) => (p.defaultBackground as string) || null)
        .catch(() => null),
      Bun.sleep(400).then(() => null),
    ]);
    return new Look(renderer, settings, termBg);
  }

  /** Picks the theme again, after the setting or the terminal's light or dark mode changed. */
  reload() {
    this.th = themeFor(this.settings.theme, this.renderer.themeMode);
    this.syntax = syntaxStyleFor(this.th, this.renderer.nativeScene);
    this.glowSyntax = glowSyntaxStyle(this.glow, this.renderer.nativeScene);
  }

  /** glow's colors for replies, dark or light by the theme. */
  get glow() {
    return glowPalette(this.th.light);
  }

  /**
   * The color behind everything: the theme's, or the terminal's. Terminals that do not
   * report theirs get plain white under a light theme and the theme's own dark otherwise.
   */
  surface() {
    return this.settings.background ? this.th.bg : (this.termBg ?? (this.th.light ? "#ffffff" : this.th.bg));
  }
}
