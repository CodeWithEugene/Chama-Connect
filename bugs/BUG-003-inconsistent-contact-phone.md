<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-003 — Contact phone number inconsistent across pages + hackathon brief

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Public site / trust |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

Three different numbers are in circulation for the same company:

| Surface | Number |
|---|---|
| Every footer on chamaconnect.io | `+254-718-540-760` |
| `/contact` page "Phone" section | `+254-723-655011` |
| Hackathon brief (this repo's root prompt) | `+254 714 731 015` |
| `/faqs` page "Still need help?" | `+254-718-540-760` |

Captured from `/tmp/cc_contact.html` and `/tmp/cc_home.html`.

## User impact

- A chama treasurer who calls the `/contact` number gets a different person than one who calls the footer number. Support load is split, and complaints are lost.
- Inconsistency on a money platform is a trust red flag — users googling the company will find three numbers and assume phishing / that MUIAA is not a single entity.
- Marketing campaigns (hackathon flyer vs website) drive leads to different phones, making attribution impossible.

## Root cause

No single source of truth for company contact info. Each page hard-codes its own string. Likely a `siteConfig` or `companyInfo` constant was never introduced.

## Proposed fix

1. Create a single config file:

```ts
// config/site.ts
export const siteConfig = {
  name: "ChamaConnect",
  legalEntity: "MUIAA Ltd",
  email: "support@muiaa.com",
  phonePrimary: "+254-718-540-760", // decide which is canonical
  phoneSupport: "+254-714-731-015",
  phoneSales: "+254-723-655-011",
  address: "57610 00200 — City Square, Nairobi, Kenya",
  domain: "chamaconnect.io",
} as const;
```

2. Replace every hard-coded phone string in `Footer.tsx`, `app/contact/page.tsx`, `app/faqs/page.tsx`, etc. with `siteConfig.phonePrimary` (or the appropriate role).

3. Decide which number is canonical (recommend reconciling with MUIAA directly — we've flagged both `+254-718-540-760` and `+254-723-655-011` in this ticket).

## Verification

- `grep -r "+254" app/ components/ config/` should return only references to `siteConfig.*`.
- Add a contract test:

```ts
test("contact info is consistent", async ({ page }) => {
  await page.goto("/");
  const footerNumber = await page.locator('footer').getByText(/\+254/).first().textContent();
  await page.goto("/contact");
  const contactNumber = await page.getByRole("region", { name: /phone/i }).textContent();
  expect(contactNumber).toContain(footerNumber);
});
```
