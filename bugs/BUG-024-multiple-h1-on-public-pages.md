<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-024 — `/about` has 3 `<h1>` tags; `/contact` and `/faqs` each have 2 — breaks SEO + screen-reader outline

| Field | Value |
|---|---|
| Severity | Low |
| Surface | Public site / SEO / a11y |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon — DOM grep across public pages |

## Evidence

```
$ grep -cE '<h1[^>]*>' recon/artifacts/2026-04-20T09-40-50-508Z/html/public_*.html

public___chamaconnect_io_                          : 1
public_about__chamaconnect_io_about                : 3
public_community__chamaconnect_io_community        : 1
public_contact__chamaconnect_io_contact            : 2
public_faqs__chamaconnect_io_faqs                  : 2
public_features__chamaconnect_io_features          : 1
public_onboard-chama__chamaconnect_io_onboard_chama: 1
public_pricing__chamaconnect_io_pricing            : 1
```

The three offending `<h1>`s on `/about` are:

```
<h1 ...>Automating Chama Savings & Banking Groups with Decentralized Financial Ledge[r]</h1>
<h1 ...>Tailored Financial Solutions</h1>
<h1 ...>Meet the Experts Behind ChamaConnect</h1>
```

On `/contact`:

```
<h1 ...>Get in Touch</h1>
<h1 ...>Send Us a Message</h1>
```

On `/faqs`:

```
<h1 ...>Frequently Asked Questions</h1>      ← hero
<h1 ...>Frequently Asked Questions</h1>      ← content section (duplicate wording too)
```

## User impact

1. **SEO** — search engines use the top `<h1>` as a strong topical signal and (with `<title>`) to infer the page's primary subject. Multiple H1s dilute the signal; Google will pick one non-deterministically and may index the page under the wrong heading.
2. **Accessibility** — the document outline a screen reader or a heading-navigation bookmarklet reads is garbled. A user hitting "Next heading" on `/about` hears three "heading level 1" titles on a single page, which is wrong structurally and disorienting.
3. **Redundant copy on `/faqs`** — the hero H1 and the section H1 are both "Frequently Asked Questions", doubling the spoken opener.
4. **Inconsistent with the rest of the site** — 5 of 8 public pages use a single H1 correctly, proving the team knows the pattern. Three pages simply missed the convention.

## Root cause

Page sections were built as independent components; each hero component templated a `<h1>`. When two hero-like components were composed onto one page, the H1 rule was silently violated. No lint rule (e.g. `eslint-plugin-jsx-a11y/no-redundant-h1`) is in place to catch it.

## Proposed fix

Demote secondary `<h1>` tags on each affected page to `<h2>`, preserving visual styling via classes. For example, `/contact`:

```tsx
// before
<h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6 text-white">Get in Touch</h1>
...
<h1 className="text-3xl font-extrabold text-green-600">Send Us a Message</h1>

// after
<h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6 text-white">Get in Touch</h1>
...
<h2 className="text-3xl font-extrabold text-green-600">Send Us a Message</h2>
```

Same pattern for `/about` (keep the first hero as H1, make the other two H2) and `/faqs` (keep the hero; demote the content-section duplicate, and rename it to avoid the repetition — e.g. "Browse by topic").

Add a lint rule so it can't regress:

```json
// .eslintrc additions
"plugins": ["jsx-a11y"],
"rules": {
  "jsx-a11y/heading-has-content": "error"
}
```

And a runtime guard in CI:

```ts
test("every public page has exactly one h1", async ({ page }) => {
  for (const p of ["/", "/features", "/pricing", "/about", "/faqs", "/contact", "/community", "/onboard-chama"]) {
    await page.goto(p);
    const count = await page.locator("h1").count();
    expect(count, `h1 count on ${p}`).toBe(1);
  }
});
```

## Verification

- `curl -sSL https://chamaconnect.io/about | grep -cE '<h1'` → `1`.
- Same for `/contact`, `/faqs`.
- Lighthouse SEO audit — "Document has a `<h1>` element" passes without the multi-H1 warning.
- Heading-navigation screen reader flow on `/about` reads `H1: "Automating…"` followed by `H2: "Tailored Financial Solutions"` and `H2: "Meet the Experts…"`.
