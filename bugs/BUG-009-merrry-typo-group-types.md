<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-009 — `MERRRY_GO_AROUND` typo in group types (triple-R, wrong word)

| Field | Value |
|---|---|
| Severity | High |
| Surface | Customer-facing UI (Create Chama dropdown) + API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon — intercepted `/api/proxy/*group-types` |

## Evidence

Two endpoints both return the typo:

**`GET /api/proxy/onboarding/group-types`** →
```json
{
  "data": [
    { "label": "MERRRY_GO_AROUND", "value": "MERRRY GO AROUND" },
    { "label": "SACCO", "value": "SACCO" },
    { "label": "SAVING", "value": "SAVING" },
    { "label": "TABLE_BANKING", "value": "TABLE BANKING" },
    { "label": "WELFARE", "value": "WELFARE" },
    { "label": "OTHERS", "value": "OTHERS" }
  ]
}
```

**`GET /api/proxy/groups-types`** →
```json
{
  "data": [
    { "label": "merrry go around", "value": "MERRRY_GO_AROUND" },
    ...
  ]
}
```

Two things are wrong:
1. **"MERRRY"** — three Rs. The English word is "merry", two Rs.
2. **"AROUND"** — the chama type is "merry-go-round", not "merry-go-around". A "merry-go-round" is the fixture in a playground / the Kenyan rotating-credit scheme; "merry-go-around" is not a phrase.

Because both endpoints use this token as the enum `value`, any record stored for a merry-go-round chama has `chamaType = "MERRRY_GO_AROUND"` baked in.

## User impact

1. **Visible in the Create Chama → Step 2 (Group Settings) dropdown.** A user creating a merry-go-round chama sees the typo. This is their first meaningful interaction with the platform — it sets a lasting "unprofessional" impression on the primary local product type.
2. **Search, reporting, filtering** all need to match the typo forever; fixing it is a migration.
3. **Third-party integrations** consuming this API (e.g. BUG-007's M-Pesa module or our own ChamaPay) must mirror the typo or break. Propagates the bug into every integration.
4. **Translation / i18n** will carry the typo into Swahili / Kikuyu copy too.

## Root cause

Enum was hand-typed into a seed migration and never reviewed. The English mis-spelling (`AROUND`) suggests the typer wasn't familiar with the playground-fixture origin of the phrase.

## Proposed fix

1. Rename the enum value to `MERRY_GO_ROUND`. Ship a one-off backfill migration:

```sql
-- Mongo equivalent: a $set on every group with chamaType=MERRRY_GO_AROUND
UPDATE groups SET chama_type = 'MERRY_GO_ROUND' WHERE chama_type = 'MERRRY_GO_AROUND';
UPDATE groups_types SET value = 'MERRY_GO_ROUND', label = 'Merry-Go-Round' WHERE value = 'MERRRY_GO_AROUND';
```

2. For one release, accept BOTH values at API ingress (read-your-writes safety):

```ts
const GROUP_TYPE_ALIASES: Record<string, string> = {
  MERRRY_GO_AROUND: "MERRY_GO_ROUND",
  "MERRRY GO AROUND": "MERRY_GO_ROUND",
};
function normaliseGroupType(raw: string) {
  return GROUP_TYPE_ALIASES[raw] ?? raw;
}
```

3. Fix human labels too — `"Merry-Go-Round"` (title case, hyphenated) in every language file.

4. Delete the alias after two releases have been out and all clients (mobile, web, partner APIs) have updated.

## Verification

- `curl /api/proxy/onboarding/group-types` → `MERRY_GO_ROUND` present, `MERRRY_GO_AROUND` absent.
- Existing chamas listed on `/admin/chamas` correctly show "Merry-Go-Round" as their type.
- Unit test: `GROUP_TYPE_ALIASES.MERRRY_GO_AROUND === "MERRY_GO_ROUND"`.
