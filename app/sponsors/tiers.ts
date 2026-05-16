export type SponsorTier = {
  name: string;
  price: string;
  tagline: string;
  perks: string[];
  highlight?: boolean;
};

export const TIERS: SponsorTier[] = [
  {
    name: "Supporter",
    price: "$1,500",
    tagline: "Get on the board.",
    perks: [
      "Logo on the cohort dashboard",
      "Mention in the cohort newsletter",
    ],
  },
  {
    name: "Partner",
    price: "$5,000",
    tagline: "Show up where the work happens.",
    perks: [
      "Everything in Supporter",
      "One workshop slot with the cohort",
      "Direct contribution to the grant pool",
      "Demo Day attendance",
    ],
    highlight: true,
  },
  {
    name: "Lead",
    price: "$15,000",
    tagline: "Be the headline.",
    perks: [
      "Everything in Partner",
      "Presenting sponsor branding",
      'Named grant: "The [Sponsor] Founder Grant"',
      "First look at standout teens for internships and recruiting",
    ],
  },
];
