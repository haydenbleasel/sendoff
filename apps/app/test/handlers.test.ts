import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig } from "../src/config";
import { issues, sends } from "../src/db/schema";
import worker from "../src/index";
import { createDraft, findIssue } from "../src/issues";
import { confirmSend, prepareSend, sendTest } from "../src/sending";
import type { SendMessage } from "../src/sending";
import { saveSettings } from "../src/settings";
import { importSubscribers } from "../src/subscribers";
import { HEALTHY_SES, db, mockNetwork, testSettings } from "./helpers";

let network: ReturnType<typeof mockNetwork>;

beforeEach(async () => {
  network = mockNetwork(HEALTHY_SES);
  await saveSettings(db(), testSettings);
});

afterEach(() => network.restore());

/** Confirm a send, capturing its first queue message instead of queueing it. */
const confirmedSend = async (subject: string) => {
  const captured: SendMessage[] = [];

  const deps = {
    config: getConfig(env),
    db: db(),
    queue: {
      send: (message: SendMessage) => {
        captured.push(message);

        return Promise.resolve(undefined);
      },
    },
  };

  const draft = await createDraft(db(), { body: "Hello", subject });

  await sendTest(deps, draft.id);
  const prepared = await prepareSend(deps, draft.id);
  await confirmSend(deps, draft.id, prepared.confirmation);

  return { draft, message: captured[0] };
};

describe("queue handler", () => {
  it("sends a chunk and acks it, and drops malformed messages", async () => {
    await importSubscribers(db(), [
      { email: "queue-a@example.com", status: "active" },
      { email: "queue-b@example.com", status: "active" },
    ]);
    const { draft, message } = await confirmedSend("Queued issue");

    const batch = createMessageBatch<unknown>("sendoff-send", [
      { attempts: 1, body: message, id: "good", timestamp: Date.now() },
      {
        attempts: 1,
        body: { nonsense: true },
        id: "bad",
        timestamp: Date.now(),
      },
    ]);

    const ctx = createExecutionContext();

    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks.toSorted()).toStrictEqual(["bad", "good"]);
    expect(
      network.sent.filter((email) => email.subject === "Queued issue")
    ).toHaveLength(2);
    const sent = await findIssue(db(), draft.id);

    expect(sent?.status).toBe("sent");
  });
});

describe("scheduled handler", () => {
  it("finishes a stalled send with nothing left to do", async () => {
    const { draft } = await confirmedSend("Stalled issue");
    await db()
      .update(issues)
      .set({ sendHeartbeatAt: new Date(0) })
      .where(eq(issues.id, draft.id));
    // Nobody to send to: everyone in this file's snapshot already got the earlier issue.
    await db().delete(sends).where(eq(sends.issueId, draft.id));

    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);

    const finished = await findIssue(db(), draft.id);

    expect(finished?.status).toBe("sent");
  });
});
