import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { getConfig } from "../src/config";
import { runDoctor } from "../src/doctor";
import type { CheckStatus } from "../src/doctor";
import { saveSettings } from "../src/settings";
import { importSubscribers } from "../src/subscribers";
import { HEALTHY_SES, db, mockNetwork, testSettings } from "./helpers";
import type { NetworkOptions } from "./helpers";

let network: ReturnType<typeof mockNetwork> | undefined;

afterEach(() => network?.restore());

beforeAll(async () => {
  await saveSettings(db(), testSettings);
  await importSubscribers(db(), [
    { email: "reader@example.com", status: "active" },
  ]);
});

const statuses = async (options: NetworkOptions) => {
  network = mockNetwork(options);
  const report = await runDoctor({ config: getConfig(env), db: db() });

  return {
    ok: report.ok,
    status: (name: string): CheckStatus | undefined =>
      report.checks.find((check) => check.name === name)?.status,
  };
};

describe("runDoctor", () => {
  it("passes a healthy setup", async () => {
    const report = await statuses(HEALTHY_SES);

    expect(report.ok).toBe(true);
    expect(report.status("DMARC")).toBe("pass");
    expect(report.status("Bounce and complaint tracking")).toBe("pass");
  });

  it("blocks sending from the SES sandbox, a shut-down account or too small a quota", async () => {
    const sandbox = await statuses({
      ...HEALTHY_SES,
      account: { ProductionAccessEnabled: false },
    });

    network?.restore();

    const shutdown = await statuses({
      ...HEALTHY_SES,
      account: { EnforcementStatus: "SHUTDOWN" },
    });

    network?.restore();

    const quota = await statuses({
      ...HEALTHY_SES,
      account: {
        SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 200 },
      },
    });

    expect(sandbox).toMatchObject({ ok: false });
    expect(sandbox.status("SES production access")).toBe("fail");
    expect(shutdown.status("SES account health")).toBe("fail");
    expect(quota.status("Sending quota")).toBe("fail");
  });

  it("blocks unverified senders and missing DMARC", async () => {
    const missing = await statuses({ ...HEALTHY_SES, identity: "missing" });
    network?.restore();
    const pending = await statuses({ ...HEALTHY_SES, identity: "pending" });
    network?.restore();
    const noDmarc = await statuses({ ...HEALTHY_SES, dmarc: null });

    expect(missing.status("Sender identity")).toBe("fail");
    expect(pending.status("Sender identity")).toBe("fail");
    expect(noDmarc.status("DMARC")).toBe("fail");
  });

  it("finds DMARC on the parent domain of a subdomain sender", async () => {
    await saveSettings(db(), {
      ...testSettings,
      from: { email: "hello@news.example.com", name: "Tester" },
    });

    const report = await statuses({
      ...HEALTHY_SES,
      dmarcByName: { "_dmarc.example.com": "v=DMARC1; p=quarantine" },
    });

    await saveSettings(db(), testSettings);
    expect(report.status("DMARC")).toBe("pass");
  });

  it("warns when bounces and complaints aren't wired up, and fails if the configuration set is gone", async () => {
    const unwired = await statuses({ ...HEALTHY_SES, eventDestinations: [] });
    network?.restore();
    const gone = await statuses({ ...HEALTHY_SES, eventDestinations: null });

    expect(unwired).toMatchObject({ ok: true });
    expect(unwired.status("Bounce and complaint tracking")).toBe("warn");
    expect(gone.status("Bounce and complaint tracking")).toBe("fail");
  });
});
