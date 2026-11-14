/** Settings > AI: environments, consent, models, test. Lazy chunk, built the first time the AI section is shown.
 *  Rust owns every decision (consent, validation, what may connect); this only asks and displays. Opening this
 *  section reads the saved config and makes no connection. Connections happen only on the buttons below. */
import "./settings.css";
import { modal } from "../editor/dialog";
import * as api from "./api";
import type { AiKind, AiView, EnvView, StreamEvent } from "./types";

const KIND_LABEL: Record<AiKind, string> = {
  ollama: "Ollama",
  openai_compatible: "OpenAI-compatible",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

const PRESETS: { label: string; kind: AiKind; name: string; url: string }[] = [
  { label: "Ollama (this computer)", kind: "ollama", name: "Ollama", url: "http://localhost:11434" },
  { label: "LM Studio (this computer)", kind: "openai_compatible", name: "LM Studio", url: "http://localhost:1234/v1" },
  { label: "OpenAI", kind: "openai_compatible", name: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "OpenRouter", kind: "openai_compatible", name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "Anthropic", kind: "anthropic", name: "Anthropic", url: "https://api.anthropic.com" },
  { label: "Google Gemini", kind: "gemini", name: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta" },
  { label: "Other OpenAI-compatible server", kind: "openai_compatible", name: "", url: "" },
  { label: "Other Ollama server", kind: "ollama", name: "", url: "" },
];

type Note = { err: boolean; text: string };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const button = (label: string, onclick: () => void, className = "btn") => {
  const b = el("button", className, label);
  b.type = "button";
  b.onclick = onclick;
  return b;
};

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** Short text in bold inside a sentence, built with DOM calls (never innerHTML). */
function sentence(parts: (string | { b: string })[], className = "note"): HTMLElement {
  const p = el("p", className);
  for (const part of parts) {
    if (typeof part === "string") p.append(part);
    else p.append(el("strong", "", part.b));
  }
  return p;
}

export function mountAi(host: HTMLElement): () => void {
  let alive = true;
  let view: AiView | null = null;
  /** Result of the Enable AI click, shown at the top while AI is on. */
  let top: Note | null = null;
  let ollamaMissing = false;
  let loadError: string | null = null;
  const notes = new Map<string, Note>();
  const busy = new Set<string>();
  let adding = false;
  let draft = { preset: 0, name: PRESETS[0].name, url: PRESETS[0].url };

  const say = (id: string, text: string, err = false) => notes.set(id, { err, text });

  /** Runs one action for an environment (or the whole AI section when `id` is ""). Shows its error, if any. */
  async function run(id: string, action: () => Promise<AiView | void>) {
    busy.add(id);
    notes.delete(id);
    render();
    try {
      const v = await action();
      if (v && alive) view = v;
    } catch (e) {
      say(id, String(e), true);
    } finally {
      busy.delete(id);
      if (alive) render();
    }
  }

  /* ---------- environment card ---------- */

  function consentBlock(e: EnvView): HTMLElement {
    const box = el("div", "consent");
    const local = e.local;
    const plainOllama = e.kind === "ollama" && local;
    const keyInput = el("input");
    keyInput.type = "password";
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    keyInput.placeholder = e.keyRequired ? "API key" : "API key (optional)";
    const locked = busy.has(e.id);

    if (e.consent === "denied") {
      box.append(sentence(["You chose not to allow this. No connection is made to ", { b: e.host }, " until you allow it."]));
    }
    if (plainOllama) {
      box.append(el("p", "ask", `Allow My Note to connect to Ollama at ${originOf(e.baseUrl)}?`));
      box.append(
        el(
          "p",
          "note",
          "Connecting only asks Ollama which models are installed. Text is sent only when you run an AI action, and it stays on this computer.",
        ),
      );
    } else {
      box.append(sentence(["Allow connections to ", { b: e.host }, "?"], "ask"));
      box.append(
        sentence([
          "Selected text (or the whole file when nothing is selected) will be sent to ",
          { b: e.host },
          local ? " (this computer)" : " (another machine)",
          " when you run an AI action. Nothing is sent until then.",
        ]),
      );
      if (!e.secure && !local) {
        box.append(
          el("p", "note err", "This address uses plain http. Anything sent, including your API key, is not encrypted."),
        );
      }
      const row = el("div", "keyrow");
      row.append(keyInput);
      box.append(row);
      if (e.hasKey) box.append(el("p", "note", "A key is already saved in the OS keychain. Leave this empty to keep it."));
    }

    const allow = button(plainOllama ? "Allow" : "Allow and load models", () => {
      void run(e.id, async () => {
        const typed = keyInput.value.trim();
        keyInput.value = "";
        if (e.keyRequired && !typed && !e.hasKey) throw "Enter an API key first.";
        let insecure = false;
        if (e.needsInsecureOk) {
          const r = await modal({
            message: `${e.host} uses plain http, which is not encrypted. Your API key and the text you send could be read by anyone on the network between you and that server.\n\nAllow it anyway?`,
            buttons: ["Don't allow", "Allow anyway", "Cancel"],
          });
          if (r.button !== "Allow anyway") throw "Not allowed. No connection was made.";
          insecure = true;
        }
        if (typed) await api.setKey(e.id, typed); // after the warning, so a refused warning saves nothing
        await api.setConsent(e.id, true, insecure);
        // The user allowed it: load the models now. A failure here is shown, but the permission stays.
        try {
          return await api.listModels(e.id);
        } catch (err) {
          say(e.id, String(err), true);
          return api.getAi();
        }
      });
    }, "btn primary");
    allow.disabled = locked;
    const deny = button("Don't allow", () => void run(e.id, () => api.setConsent(e.id, false)));
    deny.disabled = locked;
    const actions = el("div", "actions");
    actions.append(allow, deny);
    box.append(actions);
    return box;
  }

  function keyRow(e: EnvView): HTMLElement {
    const row = el("div", "row");
    const label = el("span", "lbl", "API key");
    label.append(
      el("span", "hint", e.hasKey ? "Saved in the OS keychain. It is never shown again." : "Saved in the OS keychain only."),
    );
    const input = el("input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = e.hasKey ? "Enter a new key to replace it" : "API key";
    const save = button("Save key", () => {
      const k = input.value.trim();
      input.value = "";
      if (k) void run(e.id, () => api.setKey(e.id, k));
    });
    const wrap = el("span", "ctl");
    wrap.append(input, save);
    if (e.hasKey) wrap.append(button("Remove key", () => void run(e.id, () => api.clearKey(e.id))));
    row.append(label, wrap);
    return row;
  }

  function modelRow(e: EnvView): HTMLElement {
    const row = el("div", "row");
    const label = el("span", "lbl", "Model");
    const when = e.modelsAt ? new Date(e.modelsAt * 1000).toLocaleString() : "";
    label.append(
      el(
        "span",
        "hint",
        e.models.length
          ? `${e.models.length} available, as returned by ${e.host}. Updated ${when}.`
          : e.modelsAt
            ? `${e.host} returned no models.`
            : "No list yet. Press Refresh.",
      ),
    );
    const select = el("select");
    if (!e.model) select.append(new Option(e.models.length ? "Select a model" : "No models", "", true, true));
    for (const m of e.models) select.append(new Option(m, m, false, m === e.model));
    select.disabled = !e.models.length || busy.has(e.id);
    select.onchange = () => void run(e.id, () => api.setModel(e.id, select.value || null));
    const refresh = button("Refresh", () => void run(e.id, () => api.listModels(e.id)));
    refresh.disabled = busy.has(e.id);
    const wrap = el("span", "ctl");
    wrap.append(select, refresh);
    row.append(label, wrap);
    return row;
  }

  /** Lists the models, then (if one is selected) streams a tiny fixed prompt and stops after the first piece. */
  async function testConnection(e: EnvView): Promise<AiView> {
    const v = await api.listModels(e.id);
    const env = v.environments.find((x) => x.id === e.id)!;
    const n = env.models.length;
    if (!env.model) {
      say(e.id, `Connected to ${env.host}. ${n} model${n === 1 ? "" : "s"} available. Select a model to test a reply too.`);
      return v;
    }
    const started = performance.now();
    const requestId = api.newRequestId();
    const outcome = await new Promise<string>((resolve, reject) => {
      let got = false;
      const onEvent = (ev: StreamEvent) => {
        if (ev.event === "chunk" && !got) {
          got = true;
          void api.cancelChat(requestId); // the first piece proves it works; stop the request now
        } else if (ev.event === "error") reject(ev.message);
        else if (ev.event === "done" || ev.event === "cancelled") {
          resolve(got ? "ok" : "The model finished without returning any text.");
        }
      };
      api
        .streamChat(e.id, requestId, [{ role: "user", content: "Reply with the single word: ok" }], onEvent, 16)
        .catch(reject);
    });
    const ms = Math.round(performance.now() - started);
    say(
      e.id,
      outcome === "ok"
        ? `Connected to ${env.host}. ${n} model${n === 1 ? "" : "s"} available. ${env.model} replied in ${ms} ms.`
        : outcome,
      outcome !== "ok",
    );
    return v;
  }

  function card(e: EnvView, active: boolean): HTMLElement {
    const c = el("div", `env${active ? " active" : ""}`);
    const locked = busy.has(e.id);

    const head = el("div", "env-head");
    const name = el("input", "name");
    name.type = "text";
    name.value = e.name;
    name.maxLength = 60;
    name.setAttribute("aria-label", "Environment name");
    name.onchange = () => void run(e.id, () => api.updateEnv(e.id, { name: name.value }));
    const badge = el("span", `badge ${e.local ? "local" : "remote"}`, e.local ? "Local" : "Remote");
    const kind = el("span", "kind", KIND_LABEL[e.kind]);
    const use = active
      ? el("span", "badge on", "Active")
      : button("Use this", () => void run(e.id, () => api.setActive(e.id)));
    const remove = button("Remove", async () => {
      const r = await modal({
        message: `Remove "${e.name}"?${e.hasKey ? " Its saved API key is deleted from the OS keychain." : ""}`,
        buttons: ["Remove", "Cancel"],
      });
      if (r.button === "Remove") void run(e.id, () => api.removeEnv(e.id));
    });
    remove.disabled = locked;
    head.append(name, kind, badge, use, remove);
    c.append(head);

    const urlRow = el("div", "row");
    const urlLabel = el("span", "lbl", "Base URL");
    urlLabel.append(el("span", "hint", "Changing the host asks for permission again."));
    const url = el("input", "wide");
    url.type = "text";
    url.value = e.baseUrl;
    url.spellcheck = false;
    url.onchange = () => {
      if (url.value.trim() !== e.baseUrl) void run(e.id, () => api.updateEnv(e.id, { baseUrl: url.value }));
    };
    const urlWrap = el("span", "grow");
    urlWrap.append(url);
    urlRow.append(urlLabel, urlWrap);
    c.append(urlRow);

    if (!e.consentValid) {
      c.append(consentBlock(e));
    } else {
      c.append(
        sentence(
          [
            "Allowed: ",
            { b: e.host },
            e.local ? " (this computer). " : " (another machine). ",
            "Text is sent there only when you run an AI action.",
          ],
          "note ok",
        ),
      );
      const revoke = button("Don't allow anymore", () => void run(e.id, () => api.setConsent(e.id, false)));
      revoke.disabled = locked;
      const r = el("div", "actions");
      r.append(revoke);
      c.append(r);
      if (!(e.kind === "ollama" && e.local)) c.append(keyRow(e));
      c.append(modelRow(e));
      const test = button("Test connection", () => void run(e.id, () => testConnection(e)));
      test.disabled = locked;
      const t = el("div", "actions");
      t.append(test);
      if (e.kind === "ollama" && !e.models.length && e.modelsAt) {
        t.append(el("span", "hint", "Nothing is installed yet. Install a model with Ollama, then press Refresh."));
      }
      c.append(t);
    }
    const note = notes.get(e.id);
    if (note) c.append(el("p", `note ${note.err ? "err" : "ok"}`, note.text));
    if (locked) c.append(el("p", "note", "Working..."));
    return c;
  }

  /* ---------- add environment ---------- */

  function addForm(): HTMLElement {
    const f = el("div", "env add");
    const preset = el("select");
    PRESETS.forEach((p, i) => preset.append(new Option(p.label, String(i), false, i === draft.preset)));
    const name = el("input", "wide");
    name.type = "text";
    name.placeholder = "Name";
    name.value = draft.name;
    name.maxLength = 60;
    const url = el("input", "wide");
    url.type = "text";
    url.placeholder = "Base URL, for example https://api.example.com/v1";
    url.value = draft.url;
    url.spellcheck = false;
    preset.onchange = () => {
      const p = PRESETS[Number(preset.value)];
      draft = { preset: Number(preset.value), name: p.name, url: p.url };
      name.value = p.name;
      url.value = p.url;
    };
    const rows: [string, HTMLElement][] = [
      ["Type", preset],
      ["Name", name],
      ["Base URL", url],
    ];
    for (const [label, control] of rows) {
      const r = el("div", "row");
      r.append(el("span", "lbl", label));
      const w = el("span", "grow");
      w.append(control);
      r.append(w);
      f.append(r);
    }
    f.append(el("p", "note", "Adding an environment does not connect to it. You will be asked for permission first."));
    const actions = el("div", "actions");
    actions.append(
      button(
        "Add",
        () => {
          const p = PRESETS[Number(preset.value)];
          void run("", async () => {
            const v = await api.addEnv(p.kind, name.value, url.value);
            adding = false;
            return v;
          });
        },
        "btn primary",
      ),
      button("Cancel", () => {
        adding = false;
        render();
      }),
    );
    f.append(actions);
    const note = notes.get("");
    if (note?.err) f.append(el("p", "note err", note.text));
    return f;
  }

  /* ---------- section ---------- */

  function render() {
    if (!alive) return;
    const root = el("div", "ai");
    host.replaceChildren(root);
    if (!view) {
      root.append(el("p", "note", loadError ?? "Loading..."));
      return;
    }
    const v = view;

    if (!v.enabled) {
      root.append(
        el(
          "p",
          "note",
          "AI is off. Nothing is sent anywhere, and My Note makes no AI connections until you turn it on. " +
            "Turning it on looks for an Ollama installation by checking for its files. It never starts Ollama.",
        ),
      );
      const on = button("Enable AI", () => {
        void run("", async () => {
          const r = await api.enableAi();
          ollamaMissing = r.ollama === "not_found";
          top =
            r.ollama === "found"
              ? { err: false, text: "Ollama is installed on this computer. Choose whether My Note may connect to it below." }
              : null;
          return r.view;
        });
      }, "btn primary");
      on.disabled = busy.has("");
      const a = el("div", "actions");
      a.append(on);
      root.append(a);
      const n = notes.get("");
      if (n) root.append(el("p", `note ${n.err ? "err" : "ok"}`, n.text));
      return;
    }

    // AI is on.
    const head = el("div", "row");
    const lbl = el("span", "lbl", "AI is on");
    lbl.append(el("span", "hint", "Text leaves this computer only when you run an AI action."));
    const off = button("Turn AI off", () => {
      top = null;
      ollamaMissing = false;
      void run("", () => api.disableAi());
    });
    head.append(lbl, off);
    root.append(head);

    if (ollamaMissing) {
      const p = el("p", "note");
      p.append("Ollama was not found on this computer, so nothing was set up. You can get it at ");
      const link = el("button", "link", "ollama.com");
      link.type = "button";
      link.onclick = () => void api.openOllamaSite().catch(() => undefined);
      p.append(link, ". You can still add other environments below.");
      root.append(p);
    }
    if (top) root.append(el("p", `note ${top.err ? "err" : "ok"}`, top.text));

    if (v.environments.length) {
      const row = el("div", "row");
      row.append(el("span", "lbl", "Active environment"));
      const sel = el("select");
      for (const e of v.environments) sel.append(new Option(e.name, e.id, false, e.id === v.active));
      sel.onchange = () => void run("", () => api.setActive(sel.value));
      row.append(sel);
      root.append(row);
    } else {
      root.append(el("p", "note", "No environments yet. Add one below."));
    }

    for (const e of v.environments) root.append(card(e, e.id === v.active));

    if (adding) root.append(addForm());
    else {
      const a = el("div", "actions");
      a.append(
        button("Add environment...", () => {
          adding = true;
          render();
        }),
      );
      root.append(a);
    }
    const n = notes.get("");
    if (n && !adding) root.append(el("p", `note ${n.err ? "err" : "ok"}`, n.text));
  }

  render();
  api
    .getAi()
    .then((v) => {
      view = v;
      render();
    })
    .catch((e) => {
      loadError = `Could not load AI settings: ${String(e)}`;
      render();
    });

  return () => {
    alive = false;
    host.replaceChildren();
  };
}
