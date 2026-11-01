import type { Database } from "../db/client";
import { IssueError } from "../issues";
import {
  importSubscribers,
  isValidEmail,
  normalizeEmail,
} from "../subscribers";
import type { ImportRow, ImportStatus } from "../subscribers";

// Reads a subscriber CSV exported from any provider. The email column is
// found by its header, and name, status and unsubscribed/bounced columns are
// picked up when present. Anything unclear is skipped and reported rather than
// imported as active: wrongly emailing someone who unsubscribed is the one
// mistake an import must not make.

export const MAX_CSV_ROWS = 25_000;
export const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_NAME_LENGTH = 100;
const MAX_REPORTED_VALUES = 10;

export const suppressedStatuses = [
  "unsubscribed",
  "bounced",
  "complained",
] as const;

export type SuppressedStatus = (typeof suppressedStatuses)[number];

/** Least to most severe: when a row has several signals, the most severe wins. */
const SEVERITY: readonly ImportStatus[] = [
  "active",
  "unsubscribed",
  "bounced",
  "complained",
];

const QUOTE = '"';
const DELIMITERS = [",", ";", "\t"] as const;
const LINE_BREAK = /\r\n|\n|\r/u;
const BYTE_ORDER_MARK = /^﻿/u;
const NOT_ALPHANUMERIC = /[^a-z\d]/gu;

/** Lowercase letters and digits only, so "Email Address" and "email_address" match. */
const normalize = (value: string): string =>
  value.toLowerCase().replaceAll(NOT_ALPHANUMERIC, "");

// --- Parsing ----------------------------------------------------------------------

const detectDelimiter = (text: string): string => {
  const [firstLine = ""] = text.split(LINE_BREAK, 1);
  let best: string = DELIMITERS[0];
  let bestCount = 0;

  for (const delimiter of DELIMITERS) {
    const count = firstLine.split(delimiter).length - 1;

    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }

  return best;
};

/** Split CSV text into rows of cells: RFC 4180 quoting, any line ending. */
export const parseCsv = (text: string, delimiter = ","): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let state: "plain" | "quoted" | "closing" = "plain";
  let afterCarriageReturn = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };

  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (const character of text) {
    const crlf = afterCarriageReturn && character === "\n";

    afterCarriageReturn = false;

    if (crlf) {
      continue;
    }

    if (state === "quoted") {
      if (character === QUOTE) {
        state = "closing";
      } else {
        cell += character;
      }

      continue;
    }

    if (state === "closing") {
      state = character === QUOTE ? "quoted" : "plain";

      if (character === QUOTE) {
        cell += QUOTE;
        continue;
      }
    }

    // A quote after a space (`a, "Doe, Jane"`) still opens a quoted cell;
    // otherwise its comma would shift every column after it.
    if (character === QUOTE && cell.trim() === "") {
      cell = "";
      state = "quoted";
    } else if (character === delimiter) {
      endCell();
    } else if (character === "\n" || character === "\r") {
      endRow();
      afterCarriageReturn = character === "\r";
    } else {
      cell += character;
    }
  }

  if (cell !== "" || row.length > 0 || state !== "plain") {
    endRow();
  }

  return rows;
};

// --- Columns ----------------------------------------------------------------------

const EMAIL_HEADERS = new Set([
  "contactemail",
  "email",
  "emailaddr",
  "emailaddress",
  "mail",
  "primaryemail",
  "subscriberemail",
  "useremail",
]);

const NAME_HEADERS = new Set([
  "contactname",
  "displayname",
  "fullname",
  "name",
  "subscribername",
]);

const FIRST_NAME_HEADERS = new Set([
  "first",
  "firstname",
  "fname",
  "givenname",
]);

const LAST_NAME_HEADERS = new Set([
  "familyname",
  "last",
  "lastname",
  "lname",
  "surname",
]);

const STATUS_HEADERS = new Set([
  "emailstatus",
  "membershipstatus",
  "state",
  "status",
  "subscriberstatus",
  "subscribertype",
  "subscriptionstatus",
]);

/**
 * Columns that flag a status: "set" when any value other than false or empty
 * (a date counts) means the status applies, "unset" when false means it does.
 */
const FLAG_HEADERS = new Map<
  string,
  { status: SuppressedStatus; when: "set" | "unset" }
>([
  ["acceptsemailmarketing", { status: "unsubscribed", when: "unset" }],
  ["acceptsmarketing", { status: "unsubscribed", when: "unset" }],
  ["bounced", { status: "bounced", when: "set" }],
  ["bouncedat", { status: "bounced", when: "set" }],
  ["cleanedat", { status: "bounced", when: "set" }],
  ["cleantime", { status: "bounced", when: "set" }],
  ["complained", { status: "complained", when: "set" }],
  ["complainedat", { status: "complained", when: "set" }],
  ["donotemail", { status: "unsubscribed", when: "set" }],
  ["emaildisabled", { status: "unsubscribed", when: "set" }],
  ["emailoptin", { status: "unsubscribed", when: "unset" }],
  ["hardbounced", { status: "bounced", when: "set" }],
  ["isbounced", { status: "bounced", when: "set" }],
  ["issubscribed", { status: "unsubscribed", when: "unset" }],
  ["isunsubscribed", { status: "unsubscribed", when: "set" }],
  ["markedasspam", { status: "complained", when: "set" }],
  ["optedin", { status: "unsubscribed", when: "unset" }],
  ["optedout", { status: "unsubscribed", when: "set" }],
  ["optout", { status: "unsubscribed", when: "set" }],
  ["spamcomplaint", { status: "complained", when: "set" }],
  ["subscribed", { status: "unsubscribed", when: "unset" }],
  // Ghost's member export.
  ["subscribedtoemails", { status: "unsubscribed", when: "unset" }],
  ["unsubscribed", { status: "unsubscribed", when: "set" }],
  ["unsubscribedat", { status: "unsubscribed", when: "set" }],
  ["unsubscribedate", { status: "unsubscribed", when: "set" }],
  ["unsubscribedon", { status: "unsubscribed", when: "set" }],
  ["unsubscribetime", { status: "unsubscribed", when: "set" }],
  ["unsubtime", { status: "unsubscribed", when: "set" }],
]);

/** Status values seen in common exports. "unconfirmed" rows are skipped. */
const STATUS_VALUES = new Map<string, ImportStatus | "unconfirmed">([
  ["abuse", "complained"],
  ["active", "active"],
  ["bounce", "bounced"],
  ["bounced", "bounced"],
  ["canceled", "unsubscribed"],
  ["cancelled", "unsubscribed"],
  ["cleaned", "bounced"],
  ["complained", "complained"],
  ["complaint", "complained"],
  ["confirmed", "active"],
  ["enabled", "active"],
  ["free", "active"],
  ["gifted", "active"],
  ["hardbounce", "bounced"],
  ["inactive", "unconfirmed"],
  ["invalid", "bounced"],
  ["nonsubscribed", "unconfirmed"],
  ["notconfirmed", "unconfirmed"],
  ["optedin", "active"],
  ["optedout", "unsubscribed"],
  ["paid", "active"],
  ["pending", "unconfirmed"],
  ["premium", "active"],
  ["regular", "active"],
  ["removed", "unsubscribed"],
  ["spam", "complained"],
  ["spamcomplaint", "complained"],
  ["subscribed", "active"],
  ["unactivated", "unconfirmed"],
  ["unconfirmed", "unconfirmed"],
  ["undeliverable", "bounced"],
  ["unsubscribe", "unsubscribed"],
  ["unsubscribed", "unsubscribed"],
  ["validating", "unconfirmed"],
]);

const EMPTY_VALUES = new Set(["", "na", "none", "null"]);
const FALSE_VALUES = new Set(["0", "f", "false", "n", "no", "off"]);

interface Columns {
  email: number;
  first?: number | undefined;
  flags: { index: number; status: SuppressedStatus; when: "set" | "unset" }[];
  last?: number | undefined;
  name?: number | undefined;
  status?: number | undefined;
}

const indexOf = (headers: string[], names: ReadonlySet<string>) => {
  const index = headers.findIndex((header) => names.has(header));

  return index === -1 ? undefined : index;
};

const findColumns = (header: string[]): Columns => {
  const headers = header.map((cell) => normalize(cell));

  const email =
    indexOf(headers, EMAIL_HEADERS) ??
    headers.findIndex(
      (name) =>
        name.includes("email") &&
        !FLAG_HEADERS.has(name) &&
        !STATUS_HEADERS.has(name)
    );

  if (email === -1) {
    throw new IssueError(
      `Couldn't find an email column. The columns are: ${header.join(", ")}. Rename the one with the email addresses to "email" and import again.`
    );
  }

  const name = indexOf(headers, NAME_HEADERS);

  return {
    email,
    first:
      name === undefined ? indexOf(headers, FIRST_NAME_HEADERS) : undefined,
    flags: headers.flatMap((cell, index) => {
      const flag = FLAG_HEADERS.get(cell);

      return flag ? [{ index, ...flag }] : [];
    }),
    last: name === undefined ? indexOf(headers, LAST_NAME_HEADERS) : undefined,
    name,
    status: indexOf(headers, STATUS_HEADERS),
  };
};

// --- Rows ---------------------------------------------------------------------------

type RowOutcome =
  | { kind: "import"; row: ImportRow }
  | { kind: "noEmail" }
  | { kind: "unconfirmed" }
  | { kind: "unrecognized"; value: string };

const mostSevere = (statuses: ImportStatus[]): ImportStatus => {
  let worst: ImportStatus = "active";

  for (const status of statuses) {
    if (SEVERITY.indexOf(status) > SEVERITY.indexOf(worst)) {
      worst = status;
    }
  }

  return worst;
};

const flagged = (columns: Columns, cells: string[]): ImportStatus[] =>
  columns.flags.flatMap(({ index, status, when }) => {
    const value = normalize(cells[index] ?? "");

    if (EMPTY_VALUES.has(value)) {
      return [];
    }

    const isFalse = FALSE_VALUES.has(value);

    return isFalse === (when === "unset") ? [status] : [];
  });

const nameOf = (columns: Columns, cells: string[]): string | undefined => {
  const cell = (index: number | undefined) =>
    index === undefined ? "" : (cells[index] ?? "").trim();

  const name =
    columns.name === undefined
      ? `${cell(columns.first)} ${cell(columns.last)}`.trim()
      : cell(columns.name);

  return name ? name.slice(0, MAX_NAME_LENGTH) : undefined;
};

const readRow = (
  columns: Columns,
  cells: string[],
  forced: SuppressedStatus | undefined
): RowOutcome => {
  const email = (cells[columns.email] ?? "").trim();

  if (!email) {
    return { kind: "noEmail" };
  }

  const signals: ImportStatus[] = [...flagged(columns, cells)];

  if (forced) {
    signals.push(forced);
  }

  const raw =
    columns.status === undefined ? "" : (cells[columns.status] ?? "").trim();

  const listed = STATUS_VALUES.get(normalize(raw));
  const suppressed = signals.length > 0;

  // A suppression from any column wins over whatever the status column says.
  if (!suppressed && raw && listed === undefined) {
    return { kind: "unrecognized", value: raw };
  }

  if (!suppressed && listed === "unconfirmed") {
    return { kind: "unconfirmed" };
  }

  if (listed && listed !== "unconfirmed") {
    signals.push(listed);
  }

  return {
    kind: "import",
    row: { email, name: nameOf(columns, cells), status: mostSevere(signals) },
  };
};

export interface CsvSubscribers {
  /** The headers each field came from, to report back. */
  columns: { email: string; name: string[]; status: string[] };
  rows: ImportRow[];
  skipped: {
    noEmail: number;
    unconfirmed: number;
    /** Rows with a status Sendoff doesn't recognize. */
    unrecognized: number;
    /** The most common of those values. */
    unrecognizedValues: { count: number; value: string }[];
  };
  /** Non-blank data rows in the file. */
  total: number;
}

const isBlank = (cells: string[]) => cells.every((cell) => cell.trim() === "");

const headerNames = (header: string[], indexes: (number | undefined)[]) =>
  indexes.flatMap((index) =>
    index === undefined ? [] : [header[index]?.trim() ?? ""]
  );

/**
 * Read subscribers from CSV text. `status` marks every row as suppressed,
 * for a file that only lists unsubscribes, bounces or complaints.
 */
export const readSubscriberCsv = (
  text: string,
  { status }: { status?: SuppressedStatus | undefined } = {}
): CsvSubscribers => {
  const clean = text.replace(BYTE_ORDER_MARK, "");

  const parsed = parseCsv(clean, detectDelimiter(clean)).filter(
    (cells) => !isBlank(cells)
  );

  const [first, ...rest] = parsed;

  if (!first) {
    throw new IssueError("The file is empty.");
  }

  // A file that's just a list of addresses has no header row.
  const headerless = first.some((cell) => isValidEmail(normalizeEmail(cell)));

  const columns: Columns = headerless
    ? {
        email: first.findIndex((cell) => isValidEmail(normalizeEmail(cell))),
        flags: [],
      }
    : findColumns(first);

  const data = headerless ? parsed : rest;

  if (data.length > MAX_CSV_ROWS) {
    throw new IssueError(
      `The file has ${data.length} rows. Import at most ${MAX_CSV_ROWS} at a time: split it and import each part.`
    );
  }

  const rows: ImportRow[] = [];
  const unrecognized = new Map<string, number>();
  let unrecognizedRows = 0;
  let noEmail = 0;
  let unconfirmed = 0;

  for (const cells of data) {
    const outcome = readRow(columns, cells, status);

    if (outcome.kind === "import") {
      rows.push(outcome.row);
    } else if (outcome.kind === "noEmail") {
      noEmail += 1;
    } else if (outcome.kind === "unconfirmed") {
      unconfirmed += 1;
    } else {
      unrecognizedRows += 1;
      unrecognized.set(
        outcome.value,
        (unrecognized.get(outcome.value) ?? 0) + 1
      );
    }
  }

  return {
    columns: headerless
      ? {
          email: `column ${columns.email + 1} (no header row)`,
          name: [],
          status: [],
        }
      : {
          email: first[columns.email]?.trim() ?? "",
          name: headerNames(first, [columns.name, columns.first, columns.last]),
          status: headerNames(first, [
            columns.status,
            ...columns.flags.map((flag) => flag.index),
          ]),
        },
    rows,
    skipped: {
      noEmail,
      unconfirmed,
      unrecognized: unrecognizedRows,
      unrecognizedValues: [...unrecognized.entries()]
        .toSorted(([, a], [, b]) => b - a)
        .slice(0, MAX_REPORTED_VALUES)
        .map(([value, count]) => ({ count, value })),
    },
    total: data.length,
  };
};

// --- Import -------------------------------------------------------------------------

export interface CsvImportReport {
  columns: { email: string; name: string[]; status: string[] };
  /** Rows in the file by the status they'd be imported with. */
  counts: {
    active: number;
    bounced: number;
    complained: number;
    unsubscribed: number;
  };
  created: number;
  dryRun: boolean;
  /** Up to 20 invalid addresses. */
  invalid: string[];
  invalidCount: number;
  skipped: {
    noEmail: number;
    unconfirmed: number;
    /** Rows with a status Sendoff doesn't recognize. */
    unrecognized: number;
    /** The most common of those values. */
    unrecognizedValues: { count: number; value: string }[];
  };
  /** Existing subscribers newly suppressed by this file. */
  suppressed: number;
  /** Non-blank data rows in the file. */
  total: number;
  unchanged: number;
}

/** Read a CSV and import it (or, with dryRun, report what would happen). */
export const importCsv = async (
  db: Database,
  text: string,
  {
    dryRun = false,
    status,
  }: { dryRun?: boolean; status?: SuppressedStatus | undefined } = {}
): Promise<CsvImportReport> => {
  const csv = readSubscriberCsv(text, { status });
  const summary = await importSubscribers(db, csv.rows, { dryRun });
  const counts = { active: 0, bounced: 0, complained: 0, unsubscribed: 0 };

  for (const row of csv.rows) {
    counts[row.status] += 1;
  }

  return {
    columns: csv.columns,
    counts,
    created: summary.created,
    dryRun,
    invalid: summary.invalid,
    invalidCount: summary.invalidCount,
    skipped: csv.skipped,
    suppressed: summary.suppressed,
    total: csv.total,
    unchanged: summary.unchanged,
  };
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A readable summary of an import, for the agent to relay. */
export const describeCsvImport = (report: CsvImportReport): string => {
  const { columns, counts, skipped } = report;

  const read = [
    `emails from "${columns.email}"`,
    columns.name.length > 0
      ? `names from ${columns.name.map((name) => `"${name}"`).join(" and ")}`
      : "no name column",
    columns.status.length > 0
      ? `status from ${columns.status.map((name) => `"${name}"`).join(", ")}`
      : "no status column",
  ].join("; ");

  const notImported = [
    skipped.unconfirmed > 0 ? `${skipped.unconfirmed} never confirmed` : "",
    skipped.noEmail > 0
      ? `${plural(skipped.noEmail, "row")} without an email`
      : "",
    skipped.unrecognized > 0
      ? `${skipped.unrecognized} with a status Sendoff doesn't recognize (${skipped.unrecognizedValues.map((item) => `"${item.value}" ×${item.count}`).join(", ")})`
      : "",
    report.invalidCount > 0
      ? `${report.invalidCount} invalid address${report.invalidCount === 1 ? "" : "es"}`
      : "",
  ].filter(Boolean);

  const verb = report.dryRun ? "Would import" : "Imported";

  return [
    `Read ${plural(report.total, "row")} (${read}).`,
    `By status: ${counts.active} active, ${counts.unsubscribed} unsubscribed, ${counts.bounced} bounced, ${counts.complained} complained.`,
    notImported.length > 0 ? `Not imported: ${notImported.join("; ")}.` : "",
    `${verb}: ${report.created} new, ${report.suppressed} existing subscribers suppressed, ${report.unchanged} already there.`,
    report.dryRun
      ? "Nothing was written. Check the columns and skipped rows with the person, then run again without dryRun."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
};
