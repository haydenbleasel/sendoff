import { createSes } from "./config";
import type { Config } from "./config";
import { renderConfirmationEmail } from "./email/confirmation";
import type { Settings } from "./settings";
import { createToken } from "./tokens";

/** Send the double opt-in email for a pending subscriber. */
export const sendConfirmationEmail = async (
  config: Config,
  settings: Settings,
  subscriber: { email: string; id: string }
): Promise<void> => {
  const token = await createToken(config.tokenSecret, "confirm", subscriber.id);

  const email = await renderConfirmationEmail(
    settings,
    `${config.publicUrl}/confirm/${token}`
  );

  await createSes(config).sendEmail({
    configurationSet: config.sesConfigurationSet,
    from: settings.from,
    html: email.html,
    replyTo: settings.replyTo,
    subject: email.subject,
    tags: { type: "confirmation" },
    text: email.text,
    to: subscriber.email,
  });
};
