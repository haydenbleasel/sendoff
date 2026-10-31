import { Hono } from "hono";

import { getConfig } from "../config";
import { createDb } from "../db/client";
import { parseJsonWith } from "../json";
import { handleSesEvent, sesEventSchema } from "../ses-events";
import { isSnsUrl, snsMessageSchema, verifySnsMessage } from "../sns";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;

export const webhookRoutes = new Hono<{ Bindings: Env }>();

// SES configuration set -> SNS topic -> this endpoint. SNS retries on non-2xx
// responses, so only return an error when a retry could help.
webhookRoutes.post("/webhooks/ses", async (c) => {
  const config = getConfig(c.env);

  if (!config.sesEventsTopicArn) {
    return c.text("SES events topic isn't configured", HTTP_UNAVAILABLE);
  }

  const parsed = parseJsonWith(snsMessageSchema, await c.req.text());

  if (!parsed.success) {
    return c.text("Not an SNS message", HTTP_BAD_REQUEST);
  }

  const message = parsed.data;

  if (
    message.TopicArn !== config.sesEventsTopicArn ||
    !(await verifySnsMessage(message))
  ) {
    return c.text("Forbidden", HTTP_FORBIDDEN);
  }

  if (message.Type === "SubscriptionConfirmation") {
    if (!message.SubscribeURL || !isSnsUrl(message.SubscribeURL)) {
      return c.text("Invalid SubscribeURL", HTTP_BAD_REQUEST);
    }

    const response = await fetch(message.SubscribeURL);

    return response.ok
      ? c.text("Subscribed")
      : c.text("Couldn't confirm subscription", HTTP_BAD_GATEWAY);
  }

  if (message.Type !== "Notification") {
    return c.text("OK");
  }

  const event = parseJsonWith(sesEventSchema, message.Message);

  if (!event.success) {
    // Not an event we understand; retrying won't change that.
    console.warn("Ignoring unrecognized SES event", message.MessageId);

    return c.text("Ignored");
  }

  const result = await handleSesEvent(createDb(c.env.DB), event.data, {
    snsMessageId: message.MessageId,
  });

  return c.json(result);
});
