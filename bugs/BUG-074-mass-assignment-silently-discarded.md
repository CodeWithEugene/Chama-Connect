<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-074 — `/users/update-profile` silently discards unknown/privileged fields (allowlist works, but no 400 on unexpected keys)

| Field | Value |
|---|---|
| Severity | Low (positive security posture · minor API contract bug) |
| Surface | Auth / Profile API |
| Status | Open · mass-assignment *threat* confirmed not exploitable |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 30 |
| Related | **BUG-063** (email/name still mutable), **BUG-073** (emailVerified bypass), OWASP API Top-10 A6 (Mass Assignment) |

## Evidence

Full capture: `recon/artifacts/audit3-2026-04-20T12-26-36-238Z/30_mass_assignment.json`.

`PATCH /api/proxy/users/update-profile` authenticated as a regular `User` with the following body:

```json
{
  "firstName": "Eugene",
  "lastName":  "Mutembei",
  "email":     "eugenegabriel.ke@gmail.com",
  "role":           { "id": "69c50c8a38f08070a83bd361", "name": "SuperAdmin" },
  "roleId":         "69c50c8a38f08070a83bd361",
  "isSuperadmin":   true,
  "userType":       "SUPERADMIN",
  "emailVerified":  false,
  "isActive":       false,
  "accountStatus":  "BLOCKED",
  "blockchainAddress": "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
  "permissions":    ["*"],
  "deletionRequestedAt": "2020-01-01T00:00:00Z",
  "activatedAt":    "1970-01-01T00:00:00Z",
  "createdAt":      "1970-01-01T00:00:00Z",
  "id":  "deadbeefdeadbeefdeadbeef",
  "_id": "deadbeefdeadbeefdeadbeef"
}
```

Server response:

- **HTTP 200** with `"Successfully  updated your profile"` (note BUG-020's double space).
- `GET /api/proxy/users/current-user` immediately after shows **every dangerous field is unchanged**:
  - `roleId: "69c50c8a38f08070a83bd35b"` — still `User`, not promoted to SuperAdmin.
  - `isActive: true`, `emailVerified: true`, `accountStatus: "ACTIVE"` — all unchanged.
  - `blockchainAddress: "0xF5d89c143E403A3843820D2928A78c70Fa5fFc65"` — the DEADBEEF address was rejected.
  - `id`, `_id`, `createdAt`, `activatedAt` — all unchanged.

Comparing this to BUG-063's evidence: **`firstName`, `lastName`, `email` DID mutate** when sent via the same endpoint. So the allowlist is effectively `{ firstName, lastName, email }` — everything else is silently ignored.

## User impact

The **good news**: the classic OWASP API-Top-10 A6 "Mass Assignment" attack does *not* work against this endpoint. A leaked JWT cannot promote the holder to `SuperAdmin`, `isSuperadmin:true`, `isActive:true`, etc. via `/users/update-profile`. This is worth celebrating — many Node-ORM-based APIs fail at this exact point.

The **minor bad news**: the server returns **200** even when the request contains clearly-forbidden keys. Three practical costs:

1. **Silent client-side bugs.** A front-end developer who mis-types a field name (`profilePic` vs `profilePicture`, `countryId` vs `country`) sees a `200 Successfully updated your profile` response and assumes the write stuck. The data silently doesn't persist and is only discovered later. Standard REST hygiene is to 400 on unrecognised keys with a list of allowed fields.
2. **Inconsistent posture with other endpoints.** BUG-056 shows that `NaN` / `Infinity` in numeric fields returns 500 (a hard-reject), and BUG-039 shows object-valued auth fields return 500. Silent-discard here is a third behaviour for the same class of input ("bad key"), making the API surface harder to reason about for clients and security reviewers.
3. **Security review noise.** Without a test like probe 30, the auditor cannot distinguish between "endpoint uses an allowlist" (safe) and "endpoint uses a denylist and forgot one field" (unsafe). A hard-reject response would let reviewers prove the allowlist exists purely by observing external behaviour.

## Root cause

The handler likely uses something like:

```ts
// current (safe but silent)
const ALLOWED = ["firstName", "lastName", "email"] as const;
const update = Object.fromEntries(
  Object.entries(req.body).filter(([k]) => ALLOWED.includes(k as any))
);
await User.updateOne({ _id: req.user.id }, update);
return res.json({ message: "Successfully  updated your profile", data: ... });
```

The filter is correct. The missing piece is "reject on unknown keys" before the filter.

## Proposed fix

Zod-based contract with `.strict()` so extra keys become a 400:

```ts
import { z } from "zod";

const UpdateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName:  z.string().trim().min(1).max(80),
  email:     z.string().trim().toLowerCase().email(),
  profilePicture: z.string().url().optional(),
}).strict();                                // ← reject any extra key

app.patch("/users/update-profile", authed, async (req, res) => {
  const parsed = UpdateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      status: "error",
      message: "Invalid request body",
      errors: parsed.error.issues.map(i => ({
        field: i.path.join("."),
        message: i.message,
        code: i.code,           // includes "unrecognized_keys" for extras
      })),
    });
  }
  await User.updateOne({ _id: req.user.id }, parsed.data);
  return res.json({
    message: "Profile updated successfully",   // BUG-020 fix
    status: "success",
    data: await User.findById(req.user.id).lean(),
  });
});
```

With `.strict()`, the probe payload above would be rejected up-front with:

```json
{
  "status": "error",
  "message": "Invalid request body",
  "errors": [
    { "field": "isSuperadmin", "code": "unrecognized_keys", "message": "Unrecognised key" },
    { "field": "role",         "code": "unrecognized_keys", "message": "Unrecognised key" },
    ...
  ]
}
```

That converts BUG-074 from a silent-ignore into a loud, CI-testable security invariant.

## Verification

- Probe 30's re-run with the same payload should return **400** with an `unrecognized_keys` error listing every blocked field.
- Unit test: the allowlist array = `Object.keys(UpdateProfileSchema.shape)` (contract-test the two to prevent drift).
- Mass-assignment regression test that asserts `roleId`, `isSuperadmin`, `accountStatus`, etc. never appear in any PATCH response body on any profile-like route.
