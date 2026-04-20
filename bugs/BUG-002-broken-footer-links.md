<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-002 — Footer Quick Links and Resources point to `#`

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Public site / UX / SEO (internal linking) |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

From `/tmp/cc_home.html` (and identical on every public page — footer is shared), the footer contains:

```html
<h4 class="... text-green-600">Quick Links</h4>
<ul>
  <li><a href="/about">About Us</a></li>
  <li><a href="#">Features</a></li>         <!-- broken -->
  <li><a href="#">Pricing</a></li>          <!-- broken -->
  <li><a href="/contact">Contact Us</a></li>
</ul>

<h4 class="... text-green-600">Resources</h4>
<ul>
  <li><a href="#">Resources</a></li>        <!-- broken (and meta) -->
  <li><a href="#">Blog</a></li>             <!-- broken -->
  <li><a href="/faqs">FAQ's</a></li>
  <li><a href="#">Community</a></li>        <!-- broken — /community exists -->
  <li><a href="#">Events</a></li>           <!-- broken -->
</ul>
```

The routes `/features`, `/pricing`, and `/community` **do exist** on the site (header links work); the footer simply ships with placeholders.

## User impact

1. Users reaching the footer — typically the ones doing due-diligence before signing up — silently jump to top-of-page and assume the section is broken or the company is half-built.
2. Search engines treat the site as having zero internal links from the footer. Internal linking is one of the cheapest on-page SEO wins; this wastes it.
3. A chama treasurer (a typical target user) who expects a "Pricing" link at the bottom of the page cannot find it without scrolling back up.

## Root cause

Footer component (likely `components/Footer.tsx`) hard-codes `href="#"` placeholders that were never replaced before shipping. Same pattern as BUG-001: production-grade infrastructure used, but polish items missed.

## Proposed fix

```tsx
// components/Footer.tsx
// Before
<li><a href="#">Features</a></li>
<li><a href="#">Pricing</a></li>
// ...
<li><a href="#">Resources</a></li>
<li><a href="#">Blog</a></li>
<li><a href="#">Community</a></li>
<li><a href="#">Events</a></li>

// After
<li><Link href="/features">Features</Link></li>
<li><Link href="/pricing">Pricing</Link></li>
// ...
<li><Link href="/resources">Resources</Link></li>          {/* create route or map to /community */}
<li><Link href="/blog">Blog</Link></li>                    {/* create route or map to /community#blog */}
<li><Link href="/community">Community</Link></li>
<li><Link href="/community#events">Events</Link></li>
```

For any link whose target route does not yet exist, prefer pointing to the nearest existing page with an anchor (`/community#events`) so the user never hits a dead end. If a route is truly not ready, remove the item rather than pointing at `#`.

Also: replace raw `<a>` with `next/link` so client-side navigation is used and the inconsistent mix in the header (Link) vs footer (a) goes away.

## Verification

- `curl -sSL https://chamaconnect.io/ | grep -E 'href="#"'` should return zero footer matches.
- Playwright regression:

```ts
test("footer has no dead links", async ({ page }) => {
  await page.goto("/");
  const deadLinks = await page.locator('footer a[href="#"]').count();
  expect(deadLinks).toBe(0);
});
```
