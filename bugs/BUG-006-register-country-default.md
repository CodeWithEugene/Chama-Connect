<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-006 — Register page country selector defaults to `International`

| Field | Value |
|---|---|
| Severity | Low |
| Surface | Signup / UX / conversion |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl of `/register`) |

## Evidence

From `/tmp/cc_register.html`, the `<select>` for country begins with `International` and then lists ~240 countries alphabetically. `Kenya` is in the middle of the list. No geo-based default, no search, no `KE` pinned to the top.

## User impact

The site self-describes as "designed specifically for Kenyan chama groups with local currency support". 95%+ of signups will be Kenyan. Forcing them to scroll past Afghanistan, Albania, Algeria, etc. to reach Kenya is pointless friction at the moment of highest conversion risk. Measured lift from defaulting to the expected value on dropdowns is typically 2–5% conversion.

## Root cause

Generic country list component (likely imported from `country-list` or similar) used without configuring a default or sort order.

## Proposed fix

```tsx
// components/CountrySelect.tsx — before
<select>
  <option>International</option>
  {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
</select>

// after
const PRIMARY = ["KE", "UG", "TZ", "RW", "BI", "SS", "ET"]; // EAC first
const sorted = [
  ...countries.filter(c => PRIMARY.includes(c.code))
              .sort((a, b) => PRIMARY.indexOf(a.code) - PRIMARY.indexOf(b.code)),
  { code: "__sep__", name: "───────────" },
  ...countries.filter(c => !PRIMARY.includes(c.code))
              .sort((a, b) => a.name.localeCompare(b.name)),
];

<select defaultValue="KE">
  {sorted.map(c =>
    c.code === "__sep__"
      ? <option key={c.code} disabled>{c.name}</option>
      : <option key={c.code} value={c.code}>{c.name}</option>
  )}
</select>
```

Bonus: pair with a phone-number input that also defaults to `+254` and validates MSISDN with `libphonenumber-js`.

## Verification

- Load `/register` — `Kenya` should be pre-selected.
- Test Plan: open `/register` from a Kenyan IP → Kenya selected; phone input prefilled with `+254`.
