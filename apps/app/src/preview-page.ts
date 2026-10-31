// The live preview page: Sendoff's own UI (not the newsletter's branding).
// A tiny inline script polls for changes and swaps in the new render.

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const POLL_MS = 1500;

const css = `
:root {
  color-scheme: light dark;
  --bg: #f4f4f2; --panel: #ffffff; --text: #0d0d0d; --muted: #6b6b6b; --border: #e4e4e1;
  --signal: #ffc20e; --error: #b91c1c; --error-bg: #fef2f2;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #111111; --panel: #1a1a1a; --text: #f4f4f2; --muted: #9a9a9a; --border: #2a2a2a; --error: #f87171; --error-bg: #2a1414; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
header { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
.title { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 240px; font-weight: 600; }
.title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--signal); }
.live.stale { background: var(--muted); }
.controls { display: flex; flex-wrap: wrap; gap: 8px; }
.segmented { display: inline-flex; padding: 2px; border: 1px solid var(--border); border-radius: 8px; }
.segmented button { padding: 4px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
.segmented button[aria-pressed="true"] { background: var(--text); color: var(--panel); }
.segmented button:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
.meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
.inbox { margin: 0 auto 16px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); }
.inbox .from { font-weight: 600; }
.inbox .from small { color: var(--muted); font-weight: 400; }
.inbox .subject { margin-top: 2px; }
.inbox .preheader { color: var(--muted); }
.problems { margin: 0 0 16px; padding: 12px 16px; border-radius: 12px; background: var(--error-bg); color: var(--error); }
.problems ul { margin: 6px 0 0; padding-left: 18px; }
.frame { margin: 0 auto; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: #fff; transition: max-width 150ms ease-out; }
.frame.mobile { max-width: 390px; }
.frame.stale { opacity: 0.45; }
iframe { display: block; width: 100%; min-height: 480px; border: 0; }
pre.text { margin: 0; padding: 20px; overflow-x: auto; background: var(--panel); color: var(--text); font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
@media (prefers-reduced-motion: reduce) { .frame { transition: none; } }
`;

const script = (basePath: string) => `
const base = ${JSON.stringify(basePath)};
const $ = (id) => document.getElementById(id);
const state = { version: null, view: "email", width: "desktop", scheme: "light", rendered: false };
let failures = 0;

const setPressed = (group, value) => {
  for (const button of document.querySelectorAll('[data-group="' + group + '"]')) {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
};

const layout = () => {
  const frame = $("frame");
  frame.classList.toggle("mobile", state.width === "mobile");
  $("email").hidden = state.view !== "email";
  $("text").hidden = state.view !== "text";
  $("email").style.colorScheme = state.scheme;
  frame.style.background = state.scheme === "dark" ? "#0b0b0d" : "#fff";
};

const fit = () => {
  const doc = $("email").contentDocument;
  if (doc && doc.documentElement) $("email").style.height = doc.documentElement.scrollHeight + "px";
};

const render = async () => {
  const response = await fetch(base + "/render", { cache: "no-store" });
  if (!response.ok) throw new Error("render " + response.status);
  const data = await response.json();
  $("subject").textContent = data.subject || "(no subject)";
  $("title").textContent = data.subject || "Untitled draft";
  $("preheader").textContent = data.preheader || "";
  $("from").textContent = data.from.name;
  $("from-email").textContent = "<" + data.from.email + ">";
  $("version").textContent = "v" + data.version + (data.status === "draft" ? "" : " · " + data.status);
  $("sample").hidden = !data.sampleSettings;
  const problems = $("problems");
  problems.hidden = data.ok;
  // Keep the last good render on screen (dimmed) so the layout doesn't jump.
  $("frame").classList.toggle("stale", !data.ok);
  $("frame").hidden = !data.ok && !state.rendered;
  $("stale-note").hidden = data.ok || !state.rendered;
  if (!data.ok) {
    $("problem-list").replaceChildren(...data.problems.map((p) => {
      const li = document.createElement("li");
      li.textContent = "Line " + p.line + ": " + p.message;
      return li;
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
    $("live").classList.remove("stale");
    $("live").title = "Live: updates as the draft changes";
  } catch {
    failures += 1;
    if (failures > 2) {
      $("live").classList.add("stale");
      $("live").title = "Can't reach Sendoff; retrying";
    }
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

$("email").addEventListener("load", fit);
window.addEventListener("resize", fit);
document.addEventListener("visibilitychange", poll);
layout();
poll();
setInterval(poll, ${POLL_MS});
`;

const segmented = (
  group: string,
  label: string,
  options: [string, string][],
  selected: string
) =>
  `<div class="segmented" role="group" aria-label="${label}">${options
    .map(
      ([value, text]) =>
        `<button type="button" data-group="${group}" data-value="${value}" aria-pressed="${value === selected}">${text}</button>`
    )
    .join("")}</div>`;

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
<header>
  <div class="title"><span class="live" id="live" role="status" title="Connecting"></span><span id="title">${escapeHtml(subject || "Untitled draft")}</span></div>
  <div class="controls">
    ${segmented(
      "view",
      "Format",
      [
        ["email", "Email"],
        ["text", "Text"],
      ],
      "email"
    )}
    ${segmented(
      "width",
      "Width",
      [
        ["desktop", "Desktop"],
        ["mobile", "Mobile"],
      ],
      "desktop"
    )}
    ${segmented(
      "scheme",
      "Color scheme",
      [
        ["light", "Light"],
        ["dark", "Dark"],
      ],
      "light"
    )}
  </div>
  <span class="meta" id="version"></span>
</header>
<main>
  <p class="problems" id="sample" hidden>Using sample settings. Set the newsletter's name, sender and address with update_settings.</p>
  <div class="inbox">
    <div class="from"><span id="from"></span> <small id="from-email"></small></div>
    <div class="subject" id="subject"></div>
    <div class="preheader" id="preheader"></div>
  </div>
  <div class="problems" id="problems" hidden><strong>This draft can't render yet.</strong> <span id="stale-note" hidden>Below is the last version that did.</span><ul id="problem-list"></ul></div>
  <div class="frame" id="frame">
    <iframe id="email" title="Email preview" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
    <pre class="text" id="text" hidden></pre>
  </div>
</main>
<script>${script(basePath)}</script>
</body>
</html>`;
