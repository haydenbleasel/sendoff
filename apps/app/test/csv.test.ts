import { describe, expect, it } from "vitest";

import {
  MAX_CSV_ROWS,
  describeCsvImport,
  importCsv,
  parseCsv,
  readSubscriberCsv,
} from "../src/importers/csv";
import { importSubscribers } from "../src/subscribers";
import { db, statusOf } from "./helpers";

const statuses = (
  text: string,
  options?: Parameters<typeof readSubscriberCsv>[1]
) =>
  readSubscriberCsv(text, options).rows.map((row) => [row.email, row.status]);

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, newlines in quotes and any line ending", () => {
    const text = 'a,b\r\n"x, y","say ""hi"""\n"multi\nline",\r"",last\n';

    expect(parseCsv(text)).toStrictEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", ""],
      ["", "last"],
    ]);
  });

  it("keeps a final row without a trailing newline", () => {
    expect(parseCsv("a;b\n1;2", ";")).toStrictEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("readSubscriberCsv", () => {
  it("reads a Mailchimp-style export: quoted headers, first and last name, unsubscribe times", () => {
    const csv = readSubscriberCsv(
      [
        '"Email Address","First Name","Last Name","UNSUB_TIME"',
        "ada@example.com,Ada,Lovelace,",
        "Bob@Example.com,Bob,,2024-01-02 10:00:00",
      ].join("\n")
    );

    expect(csv.columns).toStrictEqual({
      email: "Email Address",
      name: ["First Name", "Last Name"],
      status: ["UNSUB_TIME"],
    });
    expect(csv.rows).toStrictEqual([
      { email: "ada@example.com", name: "Ada Lovelace", status: "active" },
      { email: "Bob@Example.com", name: "Bob", status: "unsubscribed" },
    ]);
  });

  it("detects semicolons and tabs, strips a byte order mark, and reads true/false flags", () => {
    expect(
      statuses(
        "﻿email;name;unsubscribed\na@example.com;A;false\nb@example.com;B;TRUE\n"
      )
    ).toStrictEqual([
      ["a@example.com", "active"],
      ["b@example.com", "unsubscribed"],
    ]);

    expect(
      statuses("email\tsubscribed\na@example.com\tyes\nb@example.com\tno")
    ).toStrictEqual([
      ["a@example.com", "active"],
      ["b@example.com", "unsubscribed"],
    ]);
  });

  it("ignores look-alike columns such as a paid subscription flag", () => {
    const csv = readSubscriberCsv(
      "email,active_subscription,email_disabled\na@example.com,false,false\nb@example.com,true,true"
    );

    expect(csv.columns.status).toStrictEqual(["email_disabled"]);
    expect(csv.rows.map((row) => row.status)).toStrictEqual([
      "active",
      "unsubscribed",
    ]);
  });

  it("maps status values, skips unconfirmed and unrecognized rows, and lets any suppression win", () => {
    const csv = readSubscriberCsv(
      [
        "email,status,bounced",
        "active@example.com,Active,",
        "cancelled@example.com,cancelled,",
        "cleaned@example.com,cleaned,",
        "spam@example.com,Spam,",
        "pending@example.com,pending,",
        "odd-1@example.com,spammy,",
        "odd-2@example.com,spammy,",
        "odd-bounced@example.com,spammy,yes",
        ",active,",
        "",
      ].join("\n")
    );

    expect(csv.rows.map((row) => [row.email, row.status])).toStrictEqual([
      ["active@example.com", "active"],
      ["cancelled@example.com", "unsubscribed"],
      ["cleaned@example.com", "bounced"],
      ["spam@example.com", "complained"],
      ["odd-bounced@example.com", "bounced"],
    ]);
    expect(csv.skipped).toStrictEqual({
      noEmail: 1,
      unconfirmed: 1,
      unrecognized: 2,
      unrecognizedValues: [{ count: 2, value: "spammy" }],
    });
    expect(csv.total).toBe(9);
  });

  it("reads a plain list of addresses with no header row", () => {
    const csv = readSubscriberCsv("a@example.com\nb@example.com\n");

    expect(csv.columns.email).toBe("column 1 (no header row)");
    expect(csv.rows.map((row) => row.email)).toStrictEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("finds an unusual email header and marks a whole file with status", () => {
    expect(
      statuses("Name,E-Mail-Adresse\nA,a@example.com", { status: "bounced" })
    ).toStrictEqual([["a@example.com", "bounced"]]);

    // The most severe signal wins over the file-wide status.
    expect(
      statuses("email,complained\na@example.com,true", {
        status: "unsubscribed",
      })
    ).toStrictEqual([["a@example.com", "complained"]]);
  });

  it("explains what's wrong with a file it can't read", () => {
    expect(() => readSubscriberCsv("")).toThrow("The file is empty.");
    expect(() => readSubscriberCsv("name,phone\nAda,123")).toThrow(
      "Couldn't find an email column. The columns are: name, phone."
    );

    const huge = [
      "email",
      ...Array.from(
        { length: MAX_CSV_ROWS + 1 },
        (_, index) => `${index}@example.com`
      ),
    ].join("\n");

    expect(() => readSubscriberCsv(huge)).toThrow(
      `Import at most ${MAX_CSV_ROWS}`
    );
  });
});

describe("importCsv", () => {
  it("dry-runs, then imports, suppressing existing subscribers but never reactivating", async () => {
    await importSubscribers(db(), [
      { email: "existing@example.com", status: "active" },
      { email: "gone@example.com", status: "unsubscribed" },
    ]);

    const text = [
      "email,first_name,unsubscribed",
      "new@example.com,New,false",
      "existing@example.com,,true",
      "gone@example.com,,false",
      "twice@example.com,,false",
      "twice@example.com,,true",
      "not-an-email,,false",
    ].join("\n");

    const dryRun = await importCsv(db(), text, { dryRun: true });

    expect(dryRun).toMatchObject({
      created: 2,
      dryRun: true,
      invalidCount: 1,
      suppressed: 1,
      unchanged: 1,
    });
    expect(describeCsvImport(dryRun)).toContain("Nothing was written");
    expect(await statusOf("new@example.com")).toBeUndefined();

    const imported = await importCsv(db(), text);

    expect(describeCsvImport(imported)).toContain(
      "Imported: 2 new, 1 existing subscribers suppressed, 1 already there."
    );
    expect(describeCsvImport(imported)).toContain("1 invalid address.");
    expect(await statusOf("new@example.com")).toBe("active");
    expect(await statusOf("existing@example.com")).toBe("unsubscribed");
    expect(await statusOf("gone@example.com")).toBe("unsubscribed");
    expect(await statusOf("twice@example.com")).toBe("unsubscribed");
  });
});
