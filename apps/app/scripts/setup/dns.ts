// The DNS records SES needs to send from your domain.

export interface DnsRecord {
  content: string;
  name: string;
  priority?: number;
  purpose: string;
  type: "CNAME" | "MX" | "TXT";
}

const MX_PRIORITY = 10;

export const mailFromDomainFor = (domain: string): string => `bounce.${domain}`;

export const sesDnsRecords = ({
  dkimTokens,
  dmarc,
  domain,
  mailFromDomain,
  region,
}: {
  dkimTokens: string[];
  /** Include a DMARC record (only when the domain doesn't have one yet). */
  dmarc: boolean;
  domain: string;
  mailFromDomain: string;
  region: string;
}): DnsRecord[] => [
  ...dkimTokens.map((token): DnsRecord => ({
    content: `${token}.dkim.amazonses.com`,
    name: `${token}._domainkey.${domain}`,
    purpose: "DKIM: proves SES may sign mail for your domain",
    type: "CNAME",
  })),
  {
    content: `feedback-smtp.${region}.amazonses.com`,
    name: mailFromDomain,
    priority: MX_PRIORITY,
    purpose: "Custom MAIL FROM: bounces come back to SES",
    type: "MX",
  },
  {
    content: "v=spf1 include:amazonses.com ~all",
    name: mailFromDomain,
    purpose: "SPF for the MAIL FROM domain, so SPF aligns with yours",
    type: "TXT",
  },
  ...(dmarc
    ? [
        {
          content: "v=DMARC1; p=none",
          name: `_dmarc.${domain}`,
          purpose: "DMARC: required by Gmail, Yahoo and Outlook for bulk mail",
          type: "TXT" as const,
        },
      ]
    : []),
];

export const formatRecords = (records: DnsRecord[]): string =>
  records
    .map(
      (record) =>
        `${record.type.padEnd(5)} ${record.name}\n      ${record.priority === undefined ? "" : `${record.priority} `}${record.content}\n      (${record.purpose})`
    )
    .join("\n");
