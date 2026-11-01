// The live preview page: Sendoff's own UI (not the list's branding). A
// sidebar holds everything about the email; the canvas holds only the email.
// A tiny inline script polls for changes and swaps in the new render.

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const POLL_MS = 1500;

// Lucide icons (the docs site's icon set), from @iconify-json/lucide.
const ICONS = {
  "chevron-down":
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 9l6 6l6-6"/>',
  "circle-alert":
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></g>',
  "file-text":
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8"/></g>',
  info: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></g>',
  mail: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m22 7l-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect width="20" height="16" x="2" y="4" rx="2"/></g>',
  monitor:
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8m-4-4v4"/></g>',
  moon: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  smartphone:
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></g>',
  sun: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></g>',
} as const;

type IconName = keyof typeof ICONS;

const icon = (name: IconName) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// The departure tile (apps/web/public/icon.svg), with the hairline split.
const MARK = `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect class="mark-tile" width="64" height="64" rx="15"/><path class="mark-arrow" d="M20.5 15.5L48.5 15.5L48.5 43.5L39.5 43.5L39.5 30.86L19 51.36L12.64 45L33.14 24.5L20.5 24.5Z"/><rect class="mark-split" y="31.25" width="64" height="1.5"/></svg>`;

const css = `
:root {
  color-scheme: light dark;
  --page: #ffffff; --canvas: #f3f3f1; --text: #0d0d0d; --muted: #6b6b68;
  --line: rgb(13 13 13 / 0.08); --control: rgb(13 13 13 / 0.12);
  --flap: #f3f3f1; --flap-shade: #e9e9e6; --mark-tile: #0d0d0d;
  --signal: #ffc20e; --signal-shade: #f2b80d; --ink: #0d0d0d;
  --error: #b42318; --error-soft: rgb(180 35 24 / 0.06);
  --mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0e0e0e; --canvas: #161616; --text: #f1eee4; --muted: #a3a29c;
    --line: rgb(255 255 255 / 0.08); --control: rgb(255 255 255 / 0.14);
    --flap: #1f1f1f; --flap-shade: #191919; --mark-tile: #2a2a2a;
    --error: #ff8a7a; --error-soft: rgb(255 138 122 / 0.08);
  }
}
* { box-sizing: border-box; }
html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
body { margin: 0; background: var(--page); color: var(--text); font: 16px/1.5 Inter, InterVariable, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
h1, h2, p, ol, dl, dd { margin: 0; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
[hidden] { display: none !important; }

.app { isolation: isolate; min-height: 100dvh; }
.sidebar { display: flex; flex-direction: column; gap: 24px; padding: 20px 16px 24px; border-bottom: 1px solid var(--line); }
.canvas { min-width: 0; padding: 12px; background: var(--canvas); }
@media (min-width: 64rem) {
  .app { display: grid; grid-template-columns: 22rem minmax(0, 1fr); }
  .sidebar { position: sticky; top: 0; height: 100dvh; overflow-y: auto; padding: 24px; border-bottom: 0; border-right: 1px solid var(--line); }
  .canvas { padding: 40px 32px; }
}

/* Brand row: the tile, the name, and the live flaps. */
.brand { display: flex; align-items: center; gap: 10px; }
.mark { width: 24px; height: 24px; flex-shrink: 0; }
.mark-tile { fill: var(--mark-tile); }
.mark-arrow { fill: var(--signal); }
.mark-split { fill: var(--page); }
.brand-name { flex: 1; min-width: 0; font-weight: 600; }
.brand-name span { color: var(--muted); font-weight: 400; }
.live { display: flex; gap: 2px; flex-shrink: 0; }
.flap { display: inline-grid; place-items: center; width: 18px; height: 22px; border-radius: 3px; font: 600 12px/1 var(--mono); color: var(--muted);
  background: linear-gradient(var(--flap-top, var(--flap)) 0 calc(50% - 0.5px), var(--page) calc(50% - 0.5px) calc(50% + 0.5px), var(--flap-bottom, var(--flap-shade)) calc(50% + 0.5px) 100%); }
.live[data-state="live"] .flap { --flap-top: var(--signal); --flap-bottom: var(--signal-shade); color: var(--ink); }

/* The issue: subject and status. */
.issue { display: flex; flex-direction: column; gap: 10px; }
.issue h1 { font-size: 20px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; text-wrap: balance; overflow-wrap: anywhere; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; background: var(--flap); color: var(--muted); font: 500 12px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.04em; font-variant-numeric: tabular-nums; }

/* Notices: sample settings and Markdown problems. */
.notice { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border-radius: 10px; background: var(--flap); font-size: 15px; line-height: 1.45; }
.notice .icon { margin-top: 2px; color: var(--muted); }
.notice-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.notice.error { background: var(--error-soft); color: var(--error); }
.notice.error .icon { color: var(--error); }
.notice strong { font-weight: 600; }
.problem-list { display: flex; flex-direction: column; gap: 6px; padding: 0; list-style: none; }
.problem-list li { display: flex; gap: 8px; align-items: baseline; color: var(--text); }
.line-number { flex-shrink: 0; font: 500 12px/1.4 var(--mono); color: var(--error); font-variant-numeric: tabular-nums; }

/* Groups of controls and details. */
.group { display: flex; flex-direction: column; gap: 12px; padding-top: 20px; border-top: 1px solid var(--line); }
.eyebrow { font: 500 12px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.control { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; }
.control-label { font-size: 15px; }
@media (max-width: 39.99rem) { .control[data-group-row="width"] { display: none; } }

.segmented { display: inline-flex; flex-shrink: 0; gap: 2px; padding: 2px; border-radius: 9px; box-shadow: inset 0 0 0 1px var(--control); }
.segmented button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; min-width: 36px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 15px; cursor: pointer; }
.segmented button.with-label { padding: 0 12px 0 8px; }
.segmented button:hover { color: var(--text); }
.segmented button[aria-pressed="true"] { background: var(--text); color: var(--page); }
.icon { width: 16px; height: 16px; flex-shrink: 0; }

/* The inbox summary, collapsible. */
.inbox summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; list-style: none; cursor: pointer; }
.inbox summary::-webkit-details-marker { display: none; }
.inbox summary .icon { color: var(--muted); transition: transform 150ms cubic-bezier(0.23, 1, 0.32, 1); }
.inbox[open] summary .icon { transform: rotate(180deg); }
.inbox dl { display: flex; flex-direction: column; gap: 14px; padding-top: 12px; }
.inbox dt { font-size: 15px; font-weight: 500; }
.inbox dd { color: var(--muted); font-size: 15px; overflow-wrap: anywhere; }
/* Above the email on phones, the live flaps say enough. */
.footnote { display: none; margin-top: auto; color: var(--muted); font-size: 13px; text-wrap: pretty; }
@media (min-width: 64rem) { .footnote { display: block; } }

@media (min-width: 40rem) {
  .control-label, .notice, .inbox dt, .inbox dd, .segmented button { font-size: 14px; }
  .segmented button { height: 28px; min-width: 28px; }
  .control { min-height: 32px; }
}

/* The email itself. */
.frame { margin: 0 auto; max-width: 45rem; overflow: hidden; border-radius: 12px; background: #fff; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.05), 0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -12px rgb(0 0 0 / 0.12); transition: max-width 200ms cubic-bezier(0.23, 1, 0.32, 1); }
.frame[data-width="mobile"] { max-width: 24.375rem; }
.frame[data-scheme="dark"] { background: #0b0b0d; }
.frame.stale { opacity: 0.45; }
@media (prefers-color-scheme: dark) { .frame { box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08); } }
iframe { display: block; width: 100%; min-height: 480px; border: 0; }
pre.text { margin: 0; padding: 24px; overflow-x: auto; background: var(--page); color: var(--text); font: 13px/1.65 var(--mono); white-space: pre-wrap; }
@media (prefers-reduced-motion: reduce) { .frame, .inbox summary .icon { transition: none; } }
`;

const script = (basePath: string) => `
const base = ${JSON.stringify(basePath)};
const $ = (id) => document.getElementById(id);
const state = { version: null, view: "email", width: "desktop", scheme: "light", rendered: false };
const STATUS = { cancelled: "Cancelled", draft: "Draft", imported: "Imported", sending: "Sending", sent: "Sent" };
let failures = 0;
let live = null;

const setPressed = (group, value) => {
  for (const button of document.querySelectorAll('[data-group="' + group + '"]')) {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
};

// The split-flap status: yellow only while the preview is live.
const setLive = (next) => {
  if (next === live) return;
  live = next;
  const word = next === "offline" ? "RETRY" : "LIVE";
  const flaps = $("live");
  flaps.dataset.state = next;
  flaps.replaceChildren(...[...word].map((letter) => {
    const flap = document.createElement("span");
    flap.className = "flap";
    flap.textContent = letter;
    return flap;
  }));
  flaps.setAttribute("aria-label", next === "live" ? "Live: updates as the draft changes" : next === "offline" ? "Can't reach Sendoff; retrying" : "Connecting");
};

const layout = () => {
  const frame = $("frame");
  frame.dataset.width = state.width;
  frame.dataset.scheme = state.scheme;
  $("email").hidden = state.view !== "email";
  $("text").hidden = state.view !== "text";
  $("email").style.colorScheme = state.scheme;
};

const fit = () => {
  const doc = $("email").contentDocument;
  if (doc && doc.documentElement) $("email").style.height = doc.documentElement.scrollHeight + "px";
};

const render = async () => {
  const response = await fetch(base + "/render", { cache: "no-store" });
  if (!response.ok) throw new Error("render " + response.status);
  const data = await response.json();
  $("title").textContent = data.subject || "Untitled draft";
  $("subject").textContent = data.subject || "No subject yet";
  $("preheader").textContent = data.preheader || "None";
  $("from").textContent = data.from.name;
  $("from-email").textContent = "<" + data.from.email + ">";
  $("status").textContent = STATUS[data.status] || data.status;
  $("version").textContent = "v" + data.version;
  $("version").hidden = false;
  $("sample").hidden = !data.sampleSettings;
  $("problems").hidden = data.ok;
  // Keep the last good render on screen (dimmed) so the layout doesn't jump.
  $("frame").classList.toggle("stale", !data.ok);
  $("frame").hidden = !data.ok && !state.rendered;
  $("stale-note").hidden = data.ok || !state.rendered;
  if (!data.ok) {
    $("problem-list").replaceChildren(...data.problems.map((p) => {
      const item = document.createElement("li");
      const line = document.createElement("span");
      line.className = "line-number";
      line.textContent = "L" + p.line;
      item.append(line, document.createTextNode(p.message));
      return item;
    }));
    return;
  }
  $("text").textContent = data.text;
  $("email").srcdoc = data.html;
  state.rendered = true;
};

const poll = async () => {
  if (document.hidden) return;
  try {
    const response = await fetch(base + "/state", { cache: "no-store" });
    if (!response.ok) throw new Error("state " + response.status);
    const { version } = await response.json();
    if (version !== state.version) {
      await render();
      state.version = version;
    }
    failures = 0;
    setLive("live");
  } catch {
    failures += 1;
    if (failures > 2) setLive("offline");
  }
};

for (const button of document.querySelectorAll("[data-group]")) {
  button.addEventListener("click", () => {
    state[button.dataset.group] = button.dataset.value;
    setPressed(button.dataset.group, button.dataset.value);
    layout();
    fit();
  });
}

// The inbox details start open beside the email, and closed above it on phones.
$("inbox").open = window.matchMedia("(min-width: 64rem)").matches;

$("email").addEventListener("load", fit);
window.addEventListener("resize", fit);
document.addEventListener("visibilitychange", poll);
setLive("connecting");
layout();
poll();
setInterval(poll, ${POLL_MS});
`;

interface Option {
  icon: IconName;
  label: string;
  value: string;
}

/** A labelled row with a segmented control. Icon-only buttons keep their label for screen readers. */
const control = (
  group: string,
  label: string,
  options: Option[],
  { withLabels = false } = {}
) =>
  `<div class="control" data-group-row="${group}"><span class="control-label" id="${group}-label">${label}</span><div class="segmented" role="group" aria-labelledby="${group}-label">${options
    .map(
      (option, index) =>
        `<button type="button" data-group="${group}" data-value="${option.value}" aria-pressed="${index === 0}"${withLabels ? ' class="with-label"' : ` aria-label="${option.label}" title="${option.label}"`}>${icon(option.icon)}${withLabels ? `<span>${option.label}</span>` : ""}</button>`
    )
    .join("")}</div></div>`;

export const previewPage = ({
  basePath,
  subject,
}: {
  basePath: string;
  subject: string;
}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Preview · ${escapeHtml(subject || "Untitled draft")}</title>
<style>${css}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar" aria-label="About this email">
    <div class="brand">
      ${MARK}
      <p class="brand-name">Sendoff <span>Preview</span></p>
      <div class="live" id="live" role="status" aria-label="Connecting"></div>
    </div>

    <div class="issue">
      <h1 id="title">${escapeHtml(subject || "Untitled draft")}</h1>
      <p class="badges"><span class="badge" id="status">Draft</span><span class="badge" id="version" hidden></span></p>
    </div>

    <div class="notice" id="sample" hidden>${icon("info")}<p class="notice-body">Showing sample settings. Your agent sets the real ones with update_settings.</p></div>

    <div class="notice error" id="problems" hidden>${icon("circle-alert")}<div class="notice-body"><p><strong>This draft can't render yet.</strong> <span id="stale-note" hidden>Showing the last version that did.</span></p><ol class="problem-list" id="problem-list"></ol></div></div>

    <section class="group" aria-labelledby="view-heading">
      <h2 class="eyebrow" id="view-heading">View</h2>
      ${control(
        "view",
        "Format",
        [
          { icon: "mail", label: "Email", value: "email" },
          { icon: "file-text", label: "Text", value: "text" },
        ],
        { withLabels: true }
      )}
      ${control("width", "Width", [
        { icon: "monitor", label: "Desktop", value: "desktop" },
        { icon: "smartphone", label: "Mobile", value: "mobile" },
      ])}
      ${control("scheme", "Theme", [
        { icon: "sun", label: "Light", value: "light" },
        { icon: "moon", label: "Dark", value: "dark" },
      ])}
    </section>

    <details class="group inbox" id="inbox" open>
      <summary><h2 class="eyebrow">Inbox</h2>${icon("chevron-down")}</summary>
      <dl>
        <div><dt>From</dt><dd><span id="from"></span> <span id="from-email"></span></dd></div>
        <div><dt>Subject</dt><dd id="subject"></dd></div>
        <div><dt>Preview text</dt><dd id="preheader"></dd></div>
      </dl>
    </details>

    <p class="footnote">This page updates on its own as your agent edits the draft.</p>
  </aside>

  <main class="canvas">
    <div class="frame" id="frame" data-width="desktop" data-scheme="light">
      <iframe id="email" title="Email preview" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
      <pre class="text" id="text" hidden></pre>
    </div>
  </main>
</div>
<script>${script(basePath)}</script>
</body>
</html>`;
