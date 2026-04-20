<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-023 — `/contact` "Send Us a Message" form has untyped, unlabeled, name-less inputs

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Public site / accessibility / forms |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon — DOM snapshot of `/contact` |

## Evidence

From `recon/artifacts/2026-04-20T09-40-50-508Z/html/public_contact__chamaconnect_io_contact.html`:

```html
<!-- "Send Us a Message" form on /contact -->
<input
  class="w-full rounded-md border px-3 py-2"
  placeholder="Your name"
  value=""
  style="">

<input
  type="email"
  required
  class="w-full rounded-md border px-3 py-2"
  placeholder="you@example.com"
  value=""
  style="">
```

The first input has **no `type`** (defaults to text), **no `id`**, **no `name`**, **no `aria-label`**, and no `<label>` associated with it. The second has `type="email"` and `required` but also no `id`/`name`/`aria-label`.

A third input on the page (`#newsletter-email`) is correctly labelled — so the team *can* do it; they just didn't for the contact form.

## User impact

1. **Screen readers announce "edit text" / "edit email" with no purpose.** A blind user using NVDA or VoiceOver on the Send-Us-a-Message form gets no spoken context. This fails WCAG 2.1 SC 1.3.1 (Info and Relationships) and SC 3.3.2 (Labels or Instructions). For a money platform whose pricing page advertises "inclusive" messaging, this is a concrete miss.
2. **Browsers can't autofill "name" and "email" fields** because `autocomplete="name"` / `autocomplete="email"` aren't set. Users type both from scratch. Forms that require typing deter the casual-lead use case the page exists for.
3. **If the page ever progressively-enhances to a plain-`<form>` POST** (e.g. if the submit JS fails), the server receives `POST /contact` with **no named fields**, and the request body is empty. The form silently does nothing.
4. **The "message" textarea** (not shown above, but the same pattern is evident in the HTML) has the same defect — no `name` / `id`.
5. **Combined with BUG-004 (the `[email protected]` literal on the same page) and BUG-014 (React hydration error on the same page)**, `/contact` already had the highest bug density on the site. Form-level a11y failure cements that.

## Root cause

Controlled React form — developer relied on internal state and skipped `name` / `id` / `label` because the React submit handler reads `useState` values directly. This is the same underlying error as BUG-022 (login form), replicated on the contact form.

## Proposed fix

```tsx
// app/contact/page.tsx
<form method="post" action="/api/proxy/contact" onSubmit={handleSubmit} className="space-y-4">
  <div>
    <label htmlFor="contact-name" className="block text-sm font-medium">Your name</label>
    <input
      id="contact-name"
      name="name"
      type="text"
      autoComplete="name"
      required
      minLength={2}
      maxLength={80}
      className="w-full rounded-md border px-3 py-2"
      value={name}
      onChange={e => setName(e.target.value)}
    />
  </div>

  <div>
    <label htmlFor="contact-email" className="block text-sm font-medium">Email</label>
    <input
      id="contact-email"
      name="email"
      type="email"
      autoComplete="email"
      inputMode="email"
      autoCapitalize="none"
      autoCorrect="off"
      required
      className="w-full rounded-md border px-3 py-2"
      value={email}
      onChange={e => setEmail(e.target.value)}
    />
  </div>

  <div>
    <label htmlFor="contact-message" className="block text-sm font-medium">Message</label>
    <textarea
      id="contact-message"
      name="message"
      required
      minLength={10}
      maxLength={2000}
      rows={5}
      className="w-full rounded-md border px-3 py-2"
      value={message}
      onChange={e => setMessage(e.target.value)}
    />
  </div>

  <button type="submit" aria-disabled={submitting}>Send message</button>
</form>
```

Backend: add a `/api/proxy/contact` handler that stores the submission, sends `support@muiaa.com` an email, and returns a `204 No Content` — or re-renders with a confirmation. (Today, from the recon, no endpoint exists for this form at all.)

## Verification

- Lighthouse a11y audit on `/contact` — zero "Form elements must have labels" failures.
- `axe-core` on `/contact` — no violations in the forms section.
- Playwright regression:

```ts
test("contact form inputs are labeled + named", async ({ page }) => {
  await page.goto("/contact");
  for (const spec of [
    { role: "textbox", name: /your name/i, autocomplete: "name",    named: "name" },
    { role: "textbox", name: /email/i,     autocomplete: "email",   named: "email" },
    { role: "textbox", name: /message/i,   autocomplete: "",        named: "message" },
  ]) {
    const el = page.getByRole(spec.role, { name: spec.name });
    await expect(el).toHaveAttribute("name", spec.named);
    if (spec.autocomplete) await expect(el).toHaveAttribute("autocomplete", spec.autocomplete);
  }
});
```
