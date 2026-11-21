import { expect, test } from "bun:test";
import { blend, gradient, hatchedTitle } from "../src/ui/text";
import { themeFor, themes } from "../src/ui/theme";
import { chord } from "../src/tui/keys";

test("gradients blend between two colors", () => {
  expect(blend("#000000", "#ffffff", 0)).toBe("#000000");
  expect(blend("#000000", "#ffffff", 1)).toBe("#ffffff");
  expect(blend("#000000", "#ffffff", 0.5)).toBe("#808080");
  expect(gradient("abc", "#000000", "#ffffff").map((c) => c.text).join("")).toBe("abc");
  const title = hatchedTitle(themes.charm, "Commands", 20);
  expect(title.map((c) => c.text).join("")).toBe("Commands ╱╱╱╱╱╱╱╱╱╱╱");
});

test("auto picks fx by the terminal; unknown names fall back to it", () => {
  expect(themeFor("auto", "light").name).toBe("fx-light");
  expect(themeFor("auto", null).name).toBe("fx");
  expect(themeFor("charm", "light").name).toBe("charm");
  expect(themeFor("neon", "dark").name).toBe("fx");
});

test("keys are named the way bindings write them", () => {
  expect(chord({ name: "n", ctrl: true, meta: false, shift: false })).toBe("ctrl+n");
  expect(chord({ name: "s", ctrl: false, meta: true, shift: false })).toBe("alt+s");
  expect(chord({ name: "tab", ctrl: false, meta: false, shift: true })).toBe("shift+tab");
});
