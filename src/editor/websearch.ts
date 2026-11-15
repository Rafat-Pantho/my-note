/** Ctrl+E: first use asks which search engine to use. Lazy chunk (only needed once). */
import { setAppearance } from "../theme/appearance";
import { modal } from "./dialog";

const ENGINES: Record<string, string> = { Bing: "bing", Google: "google", DuckDuckGo: "duckduckgo" };

/** Asks for an engine and remembers it (Rust validates and saves it). Returns true if one is now set. */
export async function chooseEngine(): Promise<boolean> {
  const r = await modal({
    message:
      "Which search engine should Ctrl+E use?\n\nThe text you select is sent to it, in your browser, each time you search. You can change this in Settings.",
    buttons: ["Bing", "Google", "DuckDuckGo", "Custom...", "Cancel"],
  });
  let engine = ENGINES[r.button];
  if (r.button === "Custom...") {
    const c = await modal({
      message: "Search address (http or https). Use %s where the selected text goes.",
      input: "https://example.com/search?q=%s",
      buttons: ["Save", "Cancel"],
    });
    if (c.button !== "Save") return false;
    engine = c.value.trim();
    if (!/^https?:\/\/\S*%s\S*$/.test(engine)) {
      await modal({ message: "That is not a usable address. It must start with http:// or https:// and contain %s.", buttons: ["OK"] });
      return false;
    }
  }
  if (!engine) return false;
  const a = await setAppearance({ searchEngine: engine }).catch(() => null);
  if (a?.settings.searchEngine !== engine) {
    await modal({ message: "The search address was not accepted.", buttons: ["OK"] });
    return false;
  }
  return true;
}
