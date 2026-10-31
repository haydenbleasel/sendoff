import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { issues } from "../src/db/schema";
import {
  applyEdits,
  createDraft,
  deleteDraft,
  editDraft,
  findIssue,
  setDraftMeta,
  slugify,
} from "../src/issues";
import { db } from "./helpers";

describe("slugify", () => {
  it("makes readable ASCII slugs", () => {
    expect(slugify("  Shipping in Public: Q4 Notes! ")).toBe(
      "shipping-in-public-q4-notes"
    );
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("🚀")).toBe("");
  });
});

describe("applyEdits", () => {
  it("applies edits in order and treats replacement text literally", () => {
    expect(
      applyEdits("Hello world. Hello again.", [
        { newText: "Hi", oldText: "Hello", replaceAll: true },
        { newText: "$& money $1", oldText: "again" },
      ])
    ).toBe("Hi world. Hi $& money $1.");
  });

  it("explains missing and ambiguous matches", () => {
    expect(() => applyEdits("abc", [{ newText: "x", oldText: "zzz" }])).toThrow(
      'Edit 1: "zzz" isn\'t in the draft'
    );
    expect(() =>
      applyEdits("a a", [
        { newText: "b", oldText: "a", replaceAll: true },
        { newText: "c", oldText: "b" },
      ])
    ).toThrow('Edit 2: "b" appears 2 times');
  });
});

describe("drafts", () => {
  it("creates drafts with unique slugs and content hashes", async () => {
    const first = await createDraft(db(), {
      body: "One",
      subject: "Same Title",
    });

    const second = await createDraft(db(), {
      body: "Two",
      subject: "Same Title",
    });

    const untitled = await createDraft(db(), { body: "Three", subject: "!!!" });

    expect(first.slug).toBe("same-title");
    expect(second.slug).toBe("same-title-2");
    expect(untitled.slug).toMatch(/^draft-[\da-f]{8}$/u);
    expect(first.contentHash).toMatch(/^[\da-f]{64}$/u);
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("bumps the version on content changes and guards concurrent edits", async () => {
    const draft = await createDraft(db(), {
      body: "Hello world",
      subject: "Versioned",
    });

    const edited = await editDraft(db(), draft.slug, {
      edits: [{ newText: "there", oldText: "world" }],
    });

    expect(edited).toMatchObject({ body: "Hello there", version: 2 });
    expect(edited.contentHash).not.toBe(draft.contentHash);

    await expect(
      editDraft(db(), draft.id, { body: "stale", expectedVersion: 1 })
    ).rejects.toThrow("version 2, not 1");
    await expect(editDraft(db(), draft.id, {})).rejects.toThrow(
      "Pass either edits"
    );
  });

  it("updates subject, preheader and slug, and rejects taken or invalid slugs", async () => {
    const draft = await createDraft(db(), { body: "Body", subject: "Meta" });
    await createDraft(db(), { body: "Body", subject: "Taken" });

    const updated = await setDraftMeta(db(), draft.id, {
      preheader: "  A preview line ",
      slug: "issue-1",
      subject: "New subject",
    });

    expect(updated).toMatchObject({
      preheader: "A preview line",
      slug: "issue-1",
      subject: "New subject",
      version: 2,
    });
    const cleared = await setDraftMeta(db(), draft.id, { preheader: null });

    expect(cleared.preheader).toBeNull();
    await expect(
      setDraftMeta(db(), draft.id, { slug: "taken" })
    ).rejects.toThrow("is taken");
    await expect(
      setDraftMeta(db(), draft.id, { slug: "Not OK" })
    ).rejects.toThrow("isn't a valid slug");
  });

  it("locks issues once they leave draft", async () => {
    const draft = await createDraft(db(), { body: "Body", subject: "Locked" });
    await db()
      .update(issues)
      .set({ status: "sent" })
      .where(eq(issues.id, draft.id));

    await expect(editDraft(db(), draft.id, { body: "x" })).rejects.toThrow(
      "is sent"
    );
    await expect(deleteDraft(db(), draft.id)).rejects.toThrow("is sent");
  });

  it("deletes drafts", async () => {
    const draft = await createDraft(db(), {
      body: "Body",
      subject: "Temporary",
    });

    await deleteDraft(db(), draft.slug);

    expect(await findIssue(db(), draft.id)).toBeUndefined();
  });
});
