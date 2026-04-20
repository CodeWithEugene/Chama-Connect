<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-029 — BOLA: any authenticated user can read any chama (+ its members' PII) by ID

| Field | Value |
|---|---|
| Severity | **Critical (Broken Object-Level Authorization, OWASP API1)** |
| Surface | API / authz |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

- URL: `GET https://chamaconnect.io/api/proxy/groups/{groupId}`
- Auth context: freshly-signed-up regular `User`, **not a member of the target chamas**, not an admin.

Reproduction with two chamas owned by another user (IDs were recovered from `/api/proxy/transactions` — see BUG-030):

```bash
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/groups/69c511e1a8a7e71e0cdeab38 \
  | jq '{name: .data.name, createdBy: .data.createdById, blockchain: .data.blockchainAddress,
         members: .data.members | map({user, role: .role.name})}'
{
  "name": "Carl Group",
  "createdBy": "69c50ee3a8a7e71e0cdeab36",
  "blockchain": "0xa111B1BdEb77589403E610F2C92C3AFf1dC5BC7d",
  "members": [
    { "user": null, "role": "Member" },
    ...
  ]
}

$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/groups/69c52706a8a7e71e0cdeab82 \
  | jq '.data.members[0]'
{
  "id":       "69c52782a8a7e71e0cdeab8f",
  "userId":   "69c51d3fa8a7e71e0cdeab4e",
  "groupId":  "69c52706a8a7e71e0cdeab82",
  "roleId":   "69c50c8a38f08070a83bd35e",
  "isActive": true,
  "lockedFunds": 0,
  "user": {
    "id":        "69c51d3fa8a7e71e0cdeab4e",
    "firstName": "Joseah",
    "lastName":  "Biwott",
    "email":     "carlbiwott@gmail.com",
    "phone":     "+254707220932"
  },
  "role": { "id": "69c50c8a38f08070a83bd35e", "name": "Treasurer" }
}
```

The response also includes `minimumContribution`, `contributionFrequency`, `meetingDay`, `meetingTime`, `finePercentageOfContribution`, `blockchainAddress`, `policies`, `issuedShareCapital`, `authorizedShares`, `issuedShares`, `status`, plus one embedded record per member.

`PATCH` and `DELETE` on the same path correctly refuse ("You can only update your own chama" / "Only the group creator or admin can close the group") — so the authz layer exists; it just isn't applied to `GET`.

## User impact

Every chama on the platform is, in practice, **publicly enumerable** by anyone who can create an account (no email/phone verification is required to reach this endpoint — sign-up alone is sufficient). From one valid ID the attacker learns:

- Full name, email address, phone number of every member (including officers: Treasurer, Secretary, Chairperson) — **the exact Personally-Identifying Information that Kenyan fraudsters use to run SIM-swap and STK-push social-engineering attacks**.
- The chama's blockchain address — enabling targeted on-chain reconnaissance and extortion.
- Meeting day/time (a physical-security concern for chamas that hold cash meetings).
- Contribution schedule + minimum contribution (so an attacker knows *exactly when* members will have money moving).

IDs are 24-char hex MongoDB ObjectIds, but they contain an embedded timestamp (first 8 hex chars = seconds since epoch), so an attacker who knows a chama was created in a given week can brute-force the remaining 64 bits per second bucket. More importantly, **one leaked ID gives the full member graph** of the platform.

This is a data-protection incident under Kenya's Data Protection Act 2019 (unlawful disclosure of personal data). It must be fixed before any production launch.

## Root cause

The backend's `getGroupById` handler runs only `authenticate()` — it does not filter on `group.createdById === req.user.id || group.members.some(m => m.userId === req.user.id)`. The authz check on `PATCH`/`DELETE` was added but the same check was never copied onto `GET`.

## Proposed fix

```ts
// server/controllers/groups.ts
export const getGroupById = asyncHandler(async (req, res) => {
  const group = await Group.findById(req.params.id).populate('members.user', 'firstName lastName email phone').lean();
  if (!group) return notFound(res, 'Chama not found');

  const userId = req.user!.id;
  const isMember =
    String(group.createdById) === userId ||
    group.members.some((m) => String(m.userId) === userId);
  const isPlatformAdmin = req.user!.role?.name === 'SuperAdmin';

  if (!isMember && !isPlatformAdmin) return forbidden(res);

  return res.json({ status: 'success', message: 'Chama retrieved successfully', data: group });
});
```

Also project-out member PII on non-officer views:

```ts
function redactMember(m, viewerRole) {
  if (viewerRole === 'Member') {
    return { ...m, user: { firstName: m.user.firstName, lastName: m.user.lastName } };
  }
  return m;
}
```

Apply the same guard to every subresource of `/groups/:id` (policies, transactions, meetings, announcements, documents…).

## Verification

1. Sign up a fresh account. `GET /api/proxy/groups/<any-valid-id>` → expect `403 Forbidden`.
2. Create a chama, invite a second test account as a `Member`. That member fetches the chama → succeeds, but treasurer/secretary/chairperson-only fields (e.g. member emails, phone numbers) are redacted.
3. Sign-in as Treasurer → all fields visible.
4. Add automated regression in `/recon/tests/bola-groups.spec.ts` that iterates the member/non-member matrix.
