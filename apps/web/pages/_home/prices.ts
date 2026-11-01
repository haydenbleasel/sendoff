// Prices for the landing page's calculator: what sending a newsletter through
// Sendoff costs on your own Cloudflare and AWS accounts, beside the service
// you'd be moving from. Every third-party number is that vendor's monthly list
// price on its own pricing page as of `checked` (each provider's `href`, and
// `sources`), so re-verify before editing. The calculator's math lives here
// too, and ships to the browser as source (`estimateSource`), so the rendered
// page and the controls agree.

/** When the third-party prices were last verified. */
export const checked = "October 31, 2026";

/** The services the calculator compares against, in the order it offers them. */
export const providerIds = ["resend", "beehiiv", "kit", "mailchimp"] as const;

export type ProviderId = (typeof providerIds)[number];

/** One plan at one size: the most subscribers it holds and its monthly price. */
export interface Tier {
  contacts: number;
  plan: string;
  price: number;
  /** The plan's monthly email cap, where it has one. */
  sends?: number;
}

export interface Provider {
  /** The calculator's footnote on how this service is priced. */
  assumption: string;
  /** The pricing page the tiers were checked against. */
  href: string;
  name: string;
  /** The sending line's note for plans without a cap. */
  sending: string;
  /** Ascending by `contacts`, keeping only the cheapest plan at each size. */
  tiers: Tier[];
  /** What the service calls the people on a list. */
  unit: "contacts" | "subscribers";
}

export interface Prices {
  /** Workers Paid, whose included D1, Queues and request usage covers Sendoff at these volumes. */
  cloudflare: { workersPaid: number };
  providers: Record<ProviderId, Provider>;
  /** Outbound email, in dollars per 1,000. */
  ses: { perThousand: number };
}

export const prices: Prices = {
  cloudflare: { workersPaid: 5 },
  providers: {
    beehiiv: {
      assumption:
        "beehiiv is priced on its Free plan up to 2,500 subscribers, then Lite up to 100,000 and Pro above that, billed monthly with unlimited sends.",
      href: "https://www.beehiiv.com/pricing",
      name: "beehiiv",
      sending: "Unlimited email sends",
      tiers: [
        { contacts: 2500, plan: "Free", price: 0 },
        { contacts: 5000, plan: "Lite", price: 109 },
        { contacts: 10_000, plan: "Lite", price: 139 },
        { contacts: 25_000, plan: "Lite", price: 199 },
        { contacts: 50_000, plan: "Lite", price: 299 },
        { contacts: 75_000, plan: "Lite", price: 389 },
        { contacts: 100_000, plan: "Lite", price: 469 },
        { contacts: 150_000, plan: "Pro", price: 799 },
        { contacts: 200_000, plan: "Pro", price: 899 },
        { contacts: 250_000, plan: "Pro", price: 999 },
      ],
      unit: "subscribers",
    },
    kit: {
      assumption:
        "Kit is priced on its Free plan up to 10,000 subscribers, then Creator, billed monthly with unlimited broadcasts.",
      href: "https://kit.com/pricing",
      name: "Kit",
      sending: "Unlimited email broadcasts",
      tiers: [
        { contacts: 10_000, plan: "Free", price: 0 },
        { contacts: 15_000, plan: "Creator", price: 169 },
        { contacts: 20_000, plan: "Creator", price: 189 },
        { contacts: 25_000, plan: "Creator", price: 199 },
        { contacts: 35_000, plan: "Creator", price: 259 },
        { contacts: 45_000, plan: "Creator", price: 319 },
        { contacts: 55_000, plan: "Creator", price: 379 },
        { contacts: 65_000, plan: "Creator", price: 439 },
        { contacts: 75_000, plan: "Creator", price: 499 },
        { contacts: 85_000, plan: "Creator", price: 559 },
        { contacts: 95_000, plan: "Creator", price: 619 },
        { contacts: 105_000, plan: "Creator", price: 679 },
        { contacts: 115_000, plan: "Creator", price: 739 },
        { contacts: 125_000, plan: "Creator", price: 799 },
        { contacts: 135_000, plan: "Creator", price: 859 },
        { contacts: 145_000, plan: "Creator", price: 919 },
        { contacts: 155_000, plan: "Creator", price: 979 },
      ],
      unit: "subscribers",
    },
    mailchimp: {
      assumption:
        "Mailchimp is priced on Essentials up to 50,000 contacts, then Standard up to 100,000 and Premium above that, billed monthly at list price after any introductory discount. Each plan caps monthly sends at 10, 12 or 15 times its contact limit.",
      href: "https://mailchimp.com/pricing/marketing/",
      name: "Mailchimp",
      sending: "",
      tiers: [
        { contacts: 500, plan: "Essentials", price: 13, sends: 5000 },
        { contacts: 1500, plan: "Essentials", price: 26.5, sends: 15_000 },
        { contacts: 2500, plan: "Essentials", price: 45, sends: 25_000 },
        { contacts: 5000, plan: "Essentials", price: 75, sends: 50_000 },
        { contacts: 10_000, plan: "Essentials", price: 110, sends: 100_000 },
        { contacts: 15_000, plan: "Essentials", price: 180, sends: 150_000 },
        { contacts: 20_000, plan: "Essentials", price: 230, sends: 200_000 },
        { contacts: 25_000, plan: "Essentials", price: 270, sends: 250_000 },
        { contacts: 30_000, plan: "Essentials", price: 300, sends: 300_000 },
        { contacts: 40_000, plan: "Essentials", price: 340, sends: 400_000 },
        { contacts: 50_000, plan: "Essentials", price: 385, sends: 500_000 },
        { contacts: 75_000, plan: "Standard", price: 630, sends: 900_000 },
        { contacts: 100_000, plan: "Standard", price: 800, sends: 1_200_000 },
        { contacts: 130_000, plan: "Premium", price: 1150, sends: 1_950_000 },
        { contacts: 150_000, plan: "Premium", price: 1325, sends: 2_250_000 },
        { contacts: 200_000, plan: "Premium", price: 1600, sends: 3_000_000 },
      ],
      unit: "contacts",
    },
    resend: {
      assumption:
        "Resend is priced on its marketing email plans (Free, then Pro marketing), which are billed monthly by contact count with unlimited sends, and quoted individually above 150,000 contacts.",
      href: "https://resend.com/pricing",
      name: "Resend",
      sending: "Unlimited emails to your contacts",
      tiers: [
        { contacts: 1000, plan: "Free", price: 0 },
        { contacts: 5000, plan: "Pro marketing", price: 40 },
        { contacts: 10_000, plan: "Pro marketing", price: 80 },
        { contacts: 15_000, plan: "Pro marketing", price: 120 },
        { contacts: 25_000, plan: "Pro marketing", price: 180 },
        { contacts: 50_000, plan: "Pro marketing", price: 250 },
        { contacts: 100_000, plan: "Pro marketing", price: 450 },
        { contacts: 150_000, plan: "Pro marketing", price: 650 },
      ],
      unit: "contacts",
    },
  },
  ses: { perThousand: 0.1 },
};

export interface PricingInput {
  /** Issues sent a month, counting a month as four weeks. */
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
  /** The bill at the service you'd be moving from. */
  from: Receipt;
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

/** The other service's bill: its cheapest plan that holds every subscriber. */
const providerBill = (input: PricingInput, provider: Provider): Bill => {
  let tier: Tier = { contacts: 0, plan: "", price: 0 };

  for (const t of provider.tiers) {
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
        label: tier.plan,
        note: `Up to ${count(tier.contacts)} ${provider.unit}${free ? "" : ", billed monthly"}`,
      },
      {
        amount: "Included",
        label: "Sending",
        note: tier.sends
          ? `Up to ${count(tier.sends)} emails a month`
          : provider.sending,
      },
    ],
    total: tier.price,
  };
};

/** Sendoff's bill: no license fee, Workers Paid, and SES for each email. */
const sendoffBill = (input: PricingInput, p: Prices): Bill => {
  const emails = Math.round(input.subscribers * input.issues);
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
export const estimate = (
  input: PricingInput,
  from: ProviderId,
  p: Prices
): Estimate => {
  const provider = p.providers[from];
  const other = providerBill(input, provider);
  const sendoff = sendoffBill(input, p);
  const gap = money(Math.round(Math.abs(other.total - sendoff.total) * 12));
  let difference = "The same price at this size.";

  if (sendoff.total < other.total) {
    difference = `Sendoff costs ${gap} less a year.`;
  } else if (sendoff.total > other.total) {
    difference = `${provider.name} costs ${gap} less a year.`;
  }

  return {
    difference,
    from: receipt(other),
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
  providerBill,
  receipt,
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
    steps: [1 / 3, 1, 2, 4, 8],
  },
];

/** Starting points for the calculator; the middle one is what the page renders. */
export const presets: { id: string; input: PricingInput; label: string }[] = [
  {
    id: "side-project",
    input: { issues: 1, subscribers: 2500 },
    label: "Side project",
  },
  {
    id: "newsletter",
    input: { issues: 4, subscribers: 10_000 },
    label: "Weekly newsletter",
  },
  {
    id: "publication",
    input: { issues: 4, subscribers: 100_000 },
    label: "Publication",
  },
];

/** The pages Sendoff's own costs were checked against; each provider carries its own `href`. */
export const sources = [
  {
    href: "https://developers.cloudflare.com/workers/platform/pricing/",
    label: "Cloudflare",
  },
  { href: "https://aws.amazon.com/ses/pricing/", label: "Amazon SES" },
];
