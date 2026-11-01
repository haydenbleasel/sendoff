import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

// Sendoff's own pages for connecting an app (claude.ai, Claude Desktop):
// sign in with the admin token, then approve or deny. Everything that comes
// from the client (name, domain, redirect host) is attacker-controlled and
// escaped.

const ESCAPES = new Map([
  ['"', "&quot;"],
  ["&", "&amp;"],
  ["'", "&#39;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

const UNSAFE = /[&<>"']/gu;

export const escapeHtml = (value: string): string =>
  value.replaceAll(UNSAFE, (character) => ESCAPES.get(character) ?? character);

const css = `
:root { color-scheme: light dark; --bg: #f4f4f2; --panel: #fff; --text: #0d0d0d; --muted: #6b6b6b; --border: #e4e4e1; --warn-bg: #fff7e0; --error: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --panel: #1a1a1a; --text: #f4f4f2; --muted: #9a9a9a; --border: #2a2a2a; --warn-bg: #2a2410; --error: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 440px; margin: 12vh auto 48px; padding: 28px; border: 1px solid var(--border); border-radius: 16px; background: var(--panel); }
h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.3; }
p { margin: 0 0 16px; }
.muted { color: var(--muted); font-size: 14px; }
.warn { padding: 10px 12px; border-radius: 10px; background: var(--warn-bg); font-size: 14px; }
.error { color: var(--error); font-size: 14px; }
label { display: block; margin: 0 0 6px; font-size: 14px; font-weight: 500; }
input[type="password"] { display: block; width: 100%; margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
input:focus-visible, button:focus-visible { outline: 2px solid #ffc20e; outline-offset: 2px; }
.actions { display: flex; gap: 8px; }
button { flex: 1; padding: 10px 16px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
button.primary { border-color: var(--text); background: var(--text); color: var(--panel); }
`;

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Sendoff</title>
<style>${css}</style>
</head>
<body><main>${body}</main></body>
</html>`;

export const signInPage = ({
  error,
  returnTo,
}: {
  error?: string | undefined;
  returnTo: string;
}): string =>
  page(
    "Sign in",
    `<h1>Connect an app to Sendoff</h1>
<p class="muted">Enter your admin token to continue. It's the MCP token setup printed.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/authorize/sign-in">
  <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
  <label for="token">Admin token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
  <div class="actions"><button class="primary" type="submit">Continue</button></div>
</form>`
  );

export const consentPage = (
  details: ConsentDescription,
  handle: string
): string => {
  const name = escapeHtml(details.clientName);

  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";

  const loopback = details.redirectIsLoopback
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";

  return page(
    `Allow ${details.clientName}`,
    `<h1>Allow ${name} to run your Sendoff?</h1>
<p>${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p class="muted">It will be able to draft and edit issues, manage subscribers and settings, and send to your list once you confirm a send.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="actions">
    <button type="submit" name="decision" value="deny">Deny</button>
    <button class="primary" type="submit" name="decision" value="approve">Allow</button>
  </div>
</form>`
  );
};

export const messagePage = (title: string, message: string): string =>
  page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
