import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createTheme, dark, fonts, light } from "./email/theme";
import type { Theme } from "./email/theme";
import type { Settings } from "./settings";

// Server-rendered pages people reach from the signup form and from links in
// emails. They carry the list's branding, not Sendoff's.

const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";

const css = (theme: Theme): string => `
:root {
  color-scheme: light dark;
  --bg: ${light.background}; --text: ${light.text}; --heading: ${light.heading};
  --muted: ${light.muted}; --border: ${light.border}; --subtle: ${light.subtle};
  --accent: ${theme.accent}; --on-accent: ${theme.onAccent}; --link: ${theme.link};
  --error: #b91c1c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: ${dark.background}; --text: ${dark.text}; --heading: ${dark.heading};
    --muted: ${dark.muted}; --border: ${dark.border}; --subtle: ${dark.subtle};
    --link: ${theme.linkDark}; --error: #f87171;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.6 ${fonts.sans}; -webkit-font-smoothing: antialiased;
}
main { max-width: 440px; margin: 0 auto; padding: 14vh 24px 48px; }
.masthead { display: block; margin: 0 0 40px; color: var(--heading); font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.masthead img { display: block; height: auto; max-width: 100%; }
h1 { margin: 0 0 12px; color: var(--heading); font-size: 28px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.25; text-wrap: balance; }
p { margin: 0 0 24px; }
a { color: var(--link); }
.muted { color: var(--muted); font-size: 14px; }
label { display: block; margin: 0 0 6px; color: var(--heading); font-size: 14px; font-weight: 500; }
input[type="email"] {
  display: block; width: 100%; margin: 0 0 12px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--heading); font: inherit;
}
input[type="email"]:focus { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 0; }
input[aria-invalid="true"] { border-color: var(--error); }
button {
  padding: 11px 18px; border: 0; border-radius: 8px; cursor: pointer;
  background: var(--accent); color: var(--on-accent); font: inherit; font-size: 15px; font-weight: 600;
}
button.secondary { border: 1px solid var(--border); background: transparent; color: var(--heading); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.full { width: 100%; }
.error { margin: -4px 0 12px; color: var(--error); font-size: 14px; }
.turnstile { min-height: 65px; margin: 0 0 12px; }
.honeypot { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
footer { max-width: 440px; margin: 0 auto; padding: 0 24px 40px; color: var(--muted); font-size: 13px; }
`;

const Masthead = ({ settings }: { settings: Settings }) => {
  const { logo, name } = settings;

  if (!logo) {
    return <span className="masthead">{name}</span>;
  }

  return (
    <picture className="masthead">
      {logo.darkUrl ? (
        <source media="(prefers-color-scheme: dark)" srcSet={logo.darkUrl} />
      ) : null}
      <img alt={name} height={logo.height} src={logo.url} width={logo.width} />
    </picture>
  );
};

interface PageProps {
  children: ReactNode;
  /** Pages reached from private links shouldn't be indexed. */
  noindex?: boolean;
  scripts?: string[];
  settings: Settings;
  /** Hide the text masthead when the page heading already shows the name. */
  showMasthead?: boolean;
  title: string;
}

const Page = ({
  children,
  noindex,
  scripts = [],
  settings,
  showMasthead = true,
  title,
}: PageProps) => (
  <html dir="ltr" lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
      {noindex ? <meta content="noindex" name="robots" /> : null}
      <title>{`${title} · ${settings.name}`}</title>
      <style>{css(createTheme(settings))}</style>
      {scripts.map((src) => (
        <script async defer key={src} src={src} />
      ))}
    </head>
    <body>
      <main>
        {showMasthead ? <Masthead settings={settings} /> : null}
        {children}
      </main>
      {settings.address ? <footer>{settings.address}</footer> : null}
    </body>
  </html>
);

const toDocument = (page: ReactNode): string =>
  `<!doctype html>${renderToStaticMarkup(page)}`;

export const subscribePage = ({
  email = "",
  error,
  settings,
  siteKey,
}: {
  email?: string;
  error?: string | undefined;
  settings: Settings;
  siteKey: string;
}): string =>
  toDocument(
    <Page
      scripts={[TURNSTILE_SCRIPT]}
      settings={settings}
      showMasthead={settings.logo !== undefined}
      title="Subscribe"
    >
      <h1>{settings.name}</h1>
      <p>{settings.description ?? "Get new issues straight to your inbox."}</p>
      <form action="/subscribe" method="post" noValidate>
        <label htmlFor="email">Email address</label>
        <input
          aria-describedby={error ? "email-error" : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="email"
          defaultValue={email}
          id="email"
          name="email"
          placeholder="you@example.com"
          required
          type="email"
        />
        {error ? (
          <p className="error" id="email-error" role="alert">
            {error}
          </p>
        ) : null}
        <div aria-hidden="true" className="honeypot">
          <label htmlFor="website">Leave this empty</label>
          <input
            autoComplete="off"
            id="website"
            name="website"
            tabIndex={-1}
            type="text"
          />
        </div>
        <div
          className="cf-turnstile turnstile"
          data-sitekey={siteKey}
          data-theme="auto"
        />
        <button className="full" type="submit">
          Subscribe
        </button>
      </form>
    </Page>
  );

export interface PageAction {
  /** Where the button POSTs. */
  action: string;
  label: string;
  secondary?: boolean;
}

export const messagePage = ({
  action,
  body,
  link,
  settings,
  title,
}: {
  action?: PageAction | undefined;
  body: string;
  link?: { href: string; label: string } | undefined;
  settings: Settings;
  title: string;
}): string =>
  toDocument(
    <Page noindex settings={settings} title={title}>
      <h1>{title}</h1>
      <p>{body}</p>
      {action ? (
        <form action={action.action} method="post">
          <button
            className={action.secondary ? "secondary" : undefined}
            type="submit"
          >
            {action.label}
          </button>
        </form>
      ) : null}
      {link ? (
        <p className="muted">
          <a href={link.href}>{link.label}</a>
        </p>
      ) : null}
    </Page>
  );
