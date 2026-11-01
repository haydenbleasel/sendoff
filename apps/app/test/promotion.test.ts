import { describe, expect, it } from "vitest";

import type { IssuePromotionCheck } from "../src/db/schema";
import {
  PROMOTION_INSTRUCTIONS,
  PROMOTION_MODEL,
  createPromotionClassifier,
  describePromotion,
  parseAssessment,
} from "../src/promotion";
import type {
  ModelReply,
  PromotionAssessment,
  PromotionModel,
} from "../src/promotion";

const ASSESSMENT: PromotionAssessment = {
  commercialMentions: true,
  fixes: ["Move the launch below your update."],
  reasons: ["The subject announces a paid product."],
  verdict: "commercial",
};

const chat = (content: string): ModelReply => ({
  choices: [{ message: { content } }],
});

/** A stand-in for the Workers AI binding that records its calls. */
const fakeModel = (reply: ModelReply | { unexpected: boolean }) => {
  const calls: Parameters<PromotionModel["run"]>[] = [];

  const model: PromotionModel = {
    run: (...args) => {
      calls.push(args);

      return Promise.resolve(reply);
    },
  };

  return { calls, model };
};

describe("parseAssessment", () => {
  it("reads the Chat Completions and Responses shapes, with text around the JSON", () => {
    expect(
      parseAssessment(chat(`\`\`\`json\n${JSON.stringify(ASSESSMENT)}\n\`\`\``))
    ).toStrictEqual(ASSESSMENT);

    expect(
      parseAssessment({
        output: [
          {
            content: [{ text: "thinking", type: "reasoning_text" }],
            type: "reasoning",
          },
          {
            content: [
              { text: JSON.stringify(ASSESSMENT), type: "output_text" },
            ],
            type: "message",
          },
        ],
      })
    ).toStrictEqual(ASSESSMENT);
  });

  it("refuses replies without a valid assessment", () => {
    expect(() => parseAssessment(chat("I think it's fine."))).toThrow(
      "didn't return an assessment"
    );
    expect(() =>
      parseAssessment(chat(JSON.stringify({ ...ASSESSMENT, verdict: "maybe" })))
    ).toThrow();
  });

  it("refuses a reply in neither shape", async () => {
    const { model } = fakeModel({ unexpected: true });

    await expect(
      createPromotionClassifier(model)({ body: "Hi", subject: "Hi" })
    ).rejects.toThrow();
  });
});

describe("createPromotionClassifier", () => {
  it("asks the model with the criteria, the email and a JSON schema", async () => {
    const { calls, model } = fakeModel(chat(JSON.stringify(ASSESSMENT)));

    const assessment = await createPromotionClassifier(model)({
      body: 'We launched **Tersa Pro**.\n\n::button[Buy now]{href="https://example.com"}',
      preheader: null,
      subject: "Tersa Pro is here",
    });

    const [modelId, input] = calls[0] ?? [];

    expect(assessment).toStrictEqual(ASSESSMENT);
    expect(modelId).toBe(PROMOTION_MODEL);
    expect(input).toMatchObject({
      // The default (256 tokens) cuts the JSON off after the reasoning.
      max_completion_tokens: 4000,
      messages: [
        { content: PROMOTION_INSTRUCTIONS, role: "system" },
        { role: "user" },
      ],
      response_format: { type: "json_schema" },
    });
    expect(JSON.stringify(input)).toContain("Subject: Tersa Pro is here");
    expect(JSON.stringify(input)).toContain("Preheader: (none)");
  });
});

describe("describePromotion", () => {
  const check: IssuePromotionCheck = {
    ...ASSESSMENT,
    checkedAt: "2026-11-01T00:00:00.000Z",
    contentHash: "hash",
    model: PROMOTION_MODEL,
  };

  it("explains the verdict and how to change it", () => {
    expect(describePromotion(check)).toBe(
      [
        "This reads as commercial email, which must include a postal address.",
        "- The subject announces a paid product.",
        "To make it read as not commercial:",
        "- Move the launch below your update.",
      ].join("\n")
    );
  });

  it("notes Canada's broader test when the US one passes", () => {
    expect(
      describePromotion({ ...check, fixes: [], verdict: "not_commercial" })
    ).toContain("Canada's anti-spam law (CASL)");
  });
});
