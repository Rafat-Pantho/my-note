/** File > Page setup: margins, orientation, header and footer codes. Lazy chunk, opened on demand. */
import { appearance, setAppearance } from "../theme/appearance";

/** Resolves when the dialog is closed (saved or cancelled). */
export function openPageSetup(): Promise<void> {
  const s = appearance()?.settings;
  const previous = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    const box = document.createElement("div");
    box.className = "modal setup";
    box.setAttribute("role", "dialog");
    const title = document.createElement("p");
    title.textContent = "Page setup";
    const grid = document.createElement("div");
    grid.className = "grid";
    const field = <T extends HTMLElement>(label: string, control: T): T => {
      const l = document.createElement("span");
      l.textContent = label;
      grid.append(l, control);
      return control;
    };
    const margin = field("Margins (mm)", Object.assign(document.createElement("input"), { type: "number", min: "0", max: "50", step: "1" }));
    margin.value = String(s?.printMarginMm ?? 20);
    const orient = field("Orientation", document.createElement("select"));
    orient.append(new Option("Portrait", "portrait"), new Option("Landscape", "landscape"));
    orient.value = s?.printLandscape ? "landscape" : "portrait";
    const header = field("Header", Object.assign(document.createElement("input"), { type: "text" }));
    header.value = s?.printHeader ?? "&f";
    const footer = field("Footer", Object.assign(document.createElement("input"), { type: "text" }));
    footer.value = s?.printFooter ?? "Page &p";
    const codes = document.createElement("div");
    codes.className = "codes";
    codes.textContent =
      "Codes: &f file name, &p page number, &P number of pages, &d date, &l &c &r left / centre / right, && an ampersand.";
    const row = document.createElement("div");
    row.className = "buttons";
    const done = (save: boolean) => {
      bg.remove();
      previous?.focus();
      if (!save) return resolve();
      void setAppearance({
        printMarginMm: Number(margin.value),
        printLandscape: orient.value === "landscape",
        printHeader: header.value,
        printFooter: footer.value,
      })
        .catch(() => {})
        .then(() => resolve());
    };
    for (const [label, save] of [["OK", true], ["Cancel", false]] as const) {
      const b = document.createElement("button");
      b.textContent = label;
      if (save) b.className = "default";
      b.onclick = () => done(save);
      b.onmousedown = (e) => e.preventDefault();
      row.append(b);
    }
    box.append(title, grid, codes, row);
    bg.append(box);
    bg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter") done(true);
    });
    document.body.append(bg);
    margin.focus();
    margin.select();
  });
}
