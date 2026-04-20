<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-022 — Login form inputs have no `name` and no `autocomplete` — password managers break, accessibility weakens

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Auth / UX / a11y |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon — DOM snapshot of `/get-started` |

## Evidence

From `recon/artifacts/2026-04-20T09-40-50-508Z/html/login_filled__chamaconnect_io_get_started.html`:

```html
<input aria-label="Email"
       placeholder="thekimpeople@gmail.com"
       class="w-full rounded-md border px-3 py-2 text-sm font-semibold"
       type="email"
       value="eugenegabriel.ke@gmail.com"
       style="">

<input aria-label="Password"
       placeholder="•••••••••••••"
       class="w-full rounded-md border px-3 py-2 text-sm font-semibold pr-10"
       type="password"
       value="1nw8e@E-3k0dhJ@W"
       style="">
```

Both inputs are missing:

- `name` attribute
- `id` attribute
- `autocomplete="username"` / `autocomplete="current-password"`

Neither input is inside a `<form>` with an `action`/`method` — the submit flow is handled entirely by a React click handler.

## User impact

1. **Password managers don't reliably save or fill the login.** Chrome's built-in password manager, 1Password, Bitwarden, Dashlane — all of them rely on `name` / `id` / `autocomplete` hints to decide "this looks like a login form". Without those, they either don't offer to save credentials at all, or save them under the wrong site entry, or offer to autofill but then fill the wrong field on the wrong page. For a money platform whose users are expected to use strong unique passwords, broken password managers are the actual cause of most account lockouts and "forgot password" support tickets.
2. **Users who *do* get the password manager to fill the login once will not get autofill on re-visit** — the manager can't re-identify the fields without `autocomplete` metadata, so subsequent logins become manual typing. Annoying enough to push users toward re-using short passwords they can remember.
3. **Accessibility is thinner than it looks.** `aria-label` gives a screen reader name, but missing `id` prevents any associated `<label for>` implementation, and missing `autocomplete` prevents AT / browser heuristics from describing the field's purpose. WCAG 2.2 SC 1.3.5 ("Identify Input Purpose") requires `autocomplete` for fields collecting user-information types like `username` and `current-password`.
4. **Form posts fail semantically** — if a user submits the form with the "Enter" key and React hydration has not yet attached the submit handler (common on cold loads / slow 3G), the browser's default form submission sends an empty POST body because there are no `name`d fields. The user sees a blank reload.
5. **Combined with BUG-005** (no MFA) and **BUG-018** (weak rate limits): ChamaConnect actively makes strong-password UX worse while providing no second factor to compensate. The sum of these bugs nudges users toward weak-and-reused passwords, which then get brute-forced.

## Root cause

React team skipped form attributes because the component is fully controlled (state + setState) and `name` isn't needed for the React submit handler. That shortcut is fine for an intranet demo, not for a consumer login.

## Proposed fix

```tsx
// app/get-started/page.tsx — the login form
<form
  method="post"
  action="/api/proxy/users/signin"
  onSubmit={handleSubmit}
  noValidate
>
  <label htmlFor="signin-email" className="block text-sm font-medium">Email</label>
  <input
    id="signin-email"
    name="email"
    type="email"
    autoComplete="username"
    inputMode="email"
    autoCapitalize="none"
    autoCorrect="off"
    spellCheck={false}
    required
    value={email}
    onChange={e => setEmail(e.target.value)}
    className="..."
  />

  <label htmlFor="signin-password" className="block text-sm font-medium">Password</label>
  <input
    id="signin-password"
    name="password"
    type="password"
    autoComplete="current-password"
    required
    minLength={8}
    value={password}
    onChange={e => setPassword(e.target.value)}
    className="..."
  />

  <button type="submit">Log in</button>
</form>
```

And on the registration form use `autoComplete="new-password"` so password managers offer to generate a strong password instead of suggesting the old one.

While fixing this, also:

- Replace the `thekimpeople@gmail.com` placeholder with a neutral one like `you@example.com` — shipping a real-looking email as placeholder looks careless and borderline PII-adjacent (flagged in BUG-005 too).
- Wrap the form in an actual `<form>` and handle submit server-side as a progressive-enhancement fallback, so pressing Enter before hydration still works.

## Verification

- Log in with Chrome's password manager — it offers to save credentials on first success and auto-fills on every subsequent visit without user interaction.
- `document.querySelector('input[type=email]').getAttribute('autocomplete')` → `"username"`.
- `document.querySelector('input[type=password]').getAttribute('autocomplete')` → `"current-password"`.
- Axe-core / Lighthouse a11y audit — zero warnings of type "Form elements must have labels" or "Ensures inputs have autocomplete hints".
- Playwright regression:

```ts
test("login form is autocomplete/name-correct", async ({ page }) => {
  await page.goto("/get-started");
  for (const [sel, auto, name] of [
    ['input[type=email]',    'username',         'email'],
    ['input[type=password]', 'current-password', 'password'],
  ] as const) {
    const el = page.locator(sel);
    await expect(el).toHaveAttribute('autocomplete', auto);
    await expect(el).toHaveAttribute('name', name);
  }
});
```
