import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactNode } from "react";

import type { Settings } from "../settings";
import { CONTENT_WIDTH, darkClass, darkModeCss, fonts, light } from "./theme";
import type { Theme } from "./theme";

export interface IssueEmailProps {
  children: ReactNode;
  preheader?: string | undefined;
  settings: Settings;
  subject: string;
  theme: Theme;
  unsubscribeUrl: string;
}

const footerText: CSSProperties = {
  color: light.muted,
  fontSize: 13,
  lineHeight: "20px",
  margin: "0 0 6px",
};

const footerLink: CSSProperties = {
  color: light.muted,
  textDecoration: "underline",
};

const Masthead = ({ settings }: { settings: Settings }) => {
  const { logo, name } = settings;

  if (!logo) {
    return (
      <Text
        className={darkClass.heading}
        style={{
          color: light.heading,
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          lineHeight: "24px",
          margin: 0,
        }}
      >
        {name}
      </Text>
    );
  }

  const image = (
    <Img
      alt={name}
      height={logo.height}
      src={logo.url}
      style={{ border: 0, display: "block", outline: "none" }}
      width={logo.width}
    />
  );

  // Apple Mail and iOS Mail pick the dark source; other clients show the
  // fallback <img>.
  return logo.darkUrl ? (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={logo.darkUrl} />
      {image}
    </picture>
  ) : (
    image
  );
};

const FooterRule = () => (
  <Hr
    className={darkClass.border}
    style={{
      border: "none",
      borderTop: `1px solid ${light.border}`,
      margin: "0 0 24px",
    }}
  />
);

const Address = ({ settings }: { settings: Settings }) =>
  settings.address ? (
    <Text className={darkClass.muted} style={{ ...footerText, margin: 0 }}>
      {settings.address}
    </Text>
  ) : null;

const IssueFooter = ({
  settings,
  unsubscribeUrl,
}: {
  settings: Settings;
  unsubscribeUrl: string;
}) => (
  <Section style={{ marginTop: 48 }}>
    <FooterRule />
    <Text className={darkClass.muted} style={footerText}>
      You're receiving this because you subscribed to {settings.name}.{" "}
      <Link
        className={darkClass.muted}
        href={unsubscribeUrl}
        style={footerLink}
      >
        Unsubscribe
      </Link>
    </Text>
    {settings.links.length > 0 ? (
      <Text className={darkClass.muted} style={footerText}>
        {settings.links.map((link, index) => (
          <span key={link.url}>
            {index > 0 ? " · " : null}
            <Link
              className={darkClass.muted}
              href={link.url}
              style={footerLink}
            >
              {link.label}
            </Link>
          </span>
        ))}
      </Text>
    ) : null}
    <Address settings={settings} />
  </Section>
);

export const NoticeFooter = ({
  children,
  settings,
}: {
  children: ReactNode;
  settings: Settings;
}) => (
  <Section style={{ marginTop: 40 }}>
    <FooterRule />
    <Text className={darkClass.muted} style={footerText}>
      {children}
    </Text>
    <Address settings={settings} />
  </Section>
);

export interface EmailShellProps {
  children: ReactNode;
  footer: ReactNode;
  preheader?: string | undefined;
  settings: Settings;
  subject: string;
  theme: Theme;
}

/** Document, masthead and dark-mode styles shared by every email. */
export const EmailShell = ({
  children,
  footer,
  preheader,
  settings,
  subject,
  theme,
}: EmailShellProps) => (
  <Html dir="ltr" lang="en">
    <Head>
      <meta content="light dark" name="color-scheme" />
      <meta content="light dark" name="supported-color-schemes" />
      <title>{subject}</title>
      <style>{darkModeCss(theme)}</style>
    </Head>
    {preheader ? <Preview>{preheader}</Preview> : null}
    <Body
      className={darkClass.background}
      style={{
        WebkitFontSmoothing: "antialiased",
        backgroundColor: light.background,
        color: light.text,
        fontFamily: fonts.sans,
        margin: 0,
        padding: 0,
      }}
    >
      {/*
       * Body wraps everything in a full-width cell with the light background
       * but not the dark-mode class, which left white edges beside the column
       * in dark mode. This full-width table carries the dark background over it.
       */}
      <Section
        className={darkClass.background}
        style={{ backgroundColor: light.background }}
      >
        <Container
          className={darkClass.background}
          style={{
            backgroundColor: light.background,
            margin: "0 auto",
            maxWidth: CONTENT_WIDTH + 48,
            padding: "48px 24px 56px",
          }}
        >
          <Section style={{ marginBottom: 40 }}>
            <Masthead settings={settings} />
          </Section>
          <Section>{children}</Section>
          {footer}
        </Container>
      </Section>
    </Body>
  </Html>
);

export const IssueEmail = ({
  children,
  preheader,
  settings,
  subject,
  theme,
  unsubscribeUrl,
}: IssueEmailProps) => (
  <EmailShell
    footer={<IssueFooter settings={settings} unsubscribeUrl={unsubscribeUrl} />}
    preheader={preheader}
    settings={settings}
    subject={subject}
    theme={theme}
  >
    {children}
  </EmailShell>
);
