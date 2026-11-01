// Prices for the landing page's calculator: what sending a newsletter through
// Sendoff costs on your own Cloudflare and AWS accounts, beside Resend's
// Marketing plans. Every third-party number comes from that vendor's own page
// as of `checked` (listed in `sources`), so re-verify before editing. The
// calculator's math lives here too, and ships to the browser as source
// (`estimateSource`), so the rendered page and the sliders agree.

/** When the third-party prices were last verified. */
export const checked = "October 31, 2026";

export const prices = {
  /** Workers Paid, whose included D1, Queues and request usage covers Sendoff at these volumes. */
  cloudflare: { workersPaid: 5 },
  /** Marketing plans: billed monthly by contact limit, with unlimited sends. */
  resend: {
    tiers: [
      { contacts: 1000, price: 0 },
      { contacts: 5000, price: 40 },
      { contacts: 10_000, price: 80 },
      { contacts: 15_000, price: 120 },
      { contacts: 25_000, price: 180 },
      { contacts: 50_000, price: 250 },
      { contacts: 100_000, price: 450 },
      { contacts: 150_000, price: 650 },
    ],
  },
  /** Outbound email, in dollars per 1,000. */
  ses: { perThousand: 0.1 },
};

export type Prices = typeof prices;

export interface PricingInput {
  /** Issues sent a year. */
  issues: number;
  subscribers: number;
}

export interface ReceiptLine {
  amount: string;
  label: string;
  note: string;
}

export interface Receipt {
  lines: ReceiptLine[];
  total: string;
  yearly: string;
}

export interface Estimate {
  /** One sentence on which bill is lower, and by how much a year. */
  difference: string;
  resend: Receipt;
  sendoff: Receipt;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

const count = (n: number): string => n.toLocaleString("en-US");

const money = (n: number): string => {
  const whole = Number.isInteger(n) || n >= 1000;

  return `$${n.toLocaleString("en-US", {
    maximumFractionDigits: whole ? 0 : 2,
    minimumFractionDigits: whole ? 0 : 2,
  })}`;
};

interface Bill {
  lines: ReceiptLine[];
  total: number;
}

const receipt = (bill: Bill): Receipt => ({
  lines: bill.lines,
  total: money(bill.total),
  yearly: money(cents(bill.total * 12)),
});

/** Resend's bill: the smallest Marketing plan that holds every subscriber. */
const resendBill = (input: PricingInput, p: Prices): Bill => {
  let tier = { contacts: 0, price: 0 };

  for (const t of p.resend.tiers) {
    tier = t;

    if (t.contacts >= input.subscribers) {
      break;
    }
  }

  const free = tier.price === 0;

  return {
    lines: [
      {
        amount: money(tier.price),
        label: free ? "Marketing Free" : "Marketing Pro",
        note: `Up to ${count(tier.contacts)} contacts${free ? "" : ", billed monthly"}`,
      },
      {
        amount: "Included",
        label: "Sending",
        note: "Unlimited emails to your contacts",
      },
    ],
    total: tier.price,
  };
};

/** Sendoff's bill: no license fee, Workers Paid, and SES for each email. */
const sendoffBill = (input: PricingInput, p: Prices): Bill => {
  const emails = Math.round((input.subscribers * input.issues) / 12);
  const ses = cents((emails / 1000) * p.ses.perThousand);

  return {
    lines: [
      { amount: "$0", label: "Sendoff", note: "Self-hosted, no subscription" },
      {
        amount: money(p.cloudflare.workersPaid),
        label: "Cloudflare",
        note: "Workers Paid, with D1 and Queues included",
      },
      {
        amount: money(ses),
        label: "Amazon SES",
        note: `${count(emails)} emails at $0.10 per 1,000`,
      },
    ],
    total: cents(p.cloudflare.workersPaid + ses),
  };
};

/** Both monthly bills for one newsletter, itemized, and the yearly difference. */
export const estimate = (input: PricingInput, p: Prices): Estimate => {
  const resend = resendBill(input, p);
  const sendoff = sendoffBill(input, p);
  const gap = money(Math.round(Math.abs(resend.total - sendoff.total) * 12));
  let difference = "The same price at this size.";

  if (sendoff.total < resend.total) {
    difference = `Sendoff costs ${gap} less a year.`;
  } else if (sendoff.total > resend.total) {
    difference = `Resend costs ${gap} less a year.`;
  }

  return {
    difference,
    resend: receipt(resend),
    sendoff: receipt(sendoff),
  };
};

/**
 * `estimate` and every function it calls, as source for the calculator's
 * inline script, so the page and the browser run one implementation. Each is
 * inlined as `toString()` gives it, so keep their bodies free of comments and
 * of anything but their arguments, built-ins, and each other.
 */
export const estimateSource = Object.entries({
  cents,
  count,
  estimate,
  money,
  receipt,
  resendBill,
  sendoffBill,
})
  .map(([name, fn]) => `const ${name}=${fn.toString()};`)
  .join("");

export type FieldKey = "issues" | "subscribers";

export interface Field {
  key: FieldKey;
  label: string;
  /** What the slider shows for each step. */
  labels: string[];
  steps: number[];
}

const subscriberSteps = [
  1000, 2500, 5000, 7500, 10_000, 15_000, 25_000, 50_000, 75_000, 100_000,
  150_000,
];

/** The calculator's sliders: each position is one step, so the scales can grow unevenly. */
export const fields: Field[] = [
  {
    key: "subscribers",
    label: "Subscribers",
    labels: subscriberSteps.map((step) => count(step)),
    steps: subscriberSteps,
  },
  {
    key: "issues",
    label: "How often you send",
    labels: ["Quarterly", "Monthly", "Twice a month", "Weekly", "Twice a week"],
    steps: [4, 12, 24, 52, 104],
  },
];

/** Starting points for the calculator; the middle one is what the page renders. */
export const presets: { id: string; input: PricingInput; label: string }[] = [
  {
    id: "side-project",
    input: { issues: 12, subscribers: 2500 },
    label: "Side project",
  },
  {
    id: "newsletter",
    input: { issues: 52, subscribers: 10_000 },
    label: "Weekly newsletter",
  },
  {
    id: "publication",
    input: { issues: 52, subscribers: 100_000 },
    label: "Publication",
  },
];

/** The pages each price was checked against. */
export const sources = [
  { href: "https://resend.com/pricing", label: "Resend" },
  {
    href: "https://developers.cloudflare.com/workers/platform/pricing/",
    label: "Cloudflare",
  },
  { href: "https://aws.amazon.com/ses/pricing/", label: "Amazon SES" },
];
