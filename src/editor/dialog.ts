/** Small DOM helpers: modal dialog and popup menu. */

export interface ModalOptions {
  message: string;
  /** Last button is also what Escape picks. First button is the default (Enter). */
  buttons: string[];
  /** If set, shows a text input with this initial value. */
  input?: string;
}

export function modal(opts: ModalOptions): Promise<{ button: string; value: string }> {
  const previous = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    const box = document.createElement("div");
    box.className = "modal";
    box.setAttribute("role", "dialog");
    const p = document.createElement("p");
    p.textContent = opts.message;
    box.append(p);
    let input: HTMLInputElement | undefined;
    if (opts.input !== undefined) {
      input = document.createElement("input");
      input.type = "text";
      input.value = opts.input;
      box.append(input);
    }
    const row = document.createElement("div");
    row.className = "buttons";
    const done = (button: string) => {
      bg.remove();
      previous?.focus();
      resolve({ button, value: input?.value ?? "" });
    };
    opts.buttons.forEach((label, i) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (i === 0) b.className = "default";
      b.addEventListener("click", () => done(label));
      row.append(b);
    });
    box.append(row);
    bg.append(box);
    // Pressing a button must not move the browser's text selection: clicking one used to collapse the
    // editor's selection behind the dialog.
    bg.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    });
    bg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done(opts.buttons[opts.buttons.length - 1]);
      else if (e.key === "Enter" && (input || (e.target as HTMLElement).tagName !== "BUTTON")) done(opts.buttons[0]);
    });
    document.body.append(bg);
    if (input) {
      input.focus();
      input.select();
    } else {
      (row.firstElementChild as HTMLElement).focus();
    }
  });
}

export interface MenuItem {
  label: string;
  value: string;
}

/** Popup list opened above `anchor`. Closes on pick, outside click or Escape. */
export function showMenu(anchor: HTMLElement, items: MenuItem[], current: string, pick: (v: string) => void): void {
  document.querySelector(".menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.textContent = it.label;
    if (it.value === current) b.className = "on";
    b.addEventListener("click", () => {
      close();
      pick(it.value);
    });
    menu.append(b);
  }
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${r.top - menu.offsetHeight - 4}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
}
