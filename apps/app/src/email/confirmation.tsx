import { Button, Heading, Link, Section, Text } from "@react-email/components";
import { render } from "@react-email/render";

import type { Settings } from "../settings";
import { buttonStyle, textStyle } from "./blocks";
import { EmailShell, NoticeFooter } from "./layout";
import { createTheme, darkClass, light } from "./theme";

export interface ConfirmationEmail {
  html: string;
  subject: string;
  text: string;
}

/** The double opt-in email sent after someone signs up (the form, the REST API or add_subscriber). */
export const renderConfirmationEmail = async (
  settings: Settings,
  confirmUrl: string
): Promise<ConfirmationEmail> => {
  const theme = createTheme(settings);
  const subject = `Confirm your subscription to ${settings.name}`;

  const ignore =
    "If you didn't sign up, you can ignore this email and you won't hear from us again.";

  const html = await render(
    <EmailShell
      footer={<NoticeFooter settings={settings}>{ignore}</NoticeFooter>}
      preheader="One tap to confirm, then you're on the list."
      settings={settings}
      subject={subject}
      theme={theme}
    >
      <Heading
        as="h1"
        className={darkClass.heading}
        style={{
          color: light.heading,
          fontSize: 24,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: "32px",
          margin: "0 0 12px",
        }}
      >
        Confirm your subscription
      </Heading>
      <Text
        className={darkClass.text}
        style={{ ...textStyle, margin: "0 0 24px" }}
      >
        Thanks for signing up to {settings.name}. Confirm your email address and
        you'll get the next issue when it goes out.
      </Text>
      <Section style={{ margin: "0 0 24px" }}>
        <Button href={confirmUrl} style={buttonStyle(theme)}>
          Confirm subscription
        </Button>
      </Section>
      <Text
        className={darkClass.muted}
        style={{
          color: light.muted,
          fontSize: 13,
          lineHeight: "20px",
          margin: 0,
        }}
      >
        Or paste this link into your browser:{" "}
        <Link
          className={darkClass.link}
          href={confirmUrl}
          style={{ color: theme.link, wordBreak: "break-all" }}
        >
          {confirmUrl}
        </Link>
      </Text>
    </EmailShell>
  );

  const text = [
    "Confirm your subscription",
    `Thanks for signing up to ${settings.name}. Confirm your email address and you'll get the next issue when it goes out:`,
    confirmUrl,
    "--",
    ignore,
    settings.address,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { html, subject, text };
};
