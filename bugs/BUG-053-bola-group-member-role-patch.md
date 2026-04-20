<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-053 — BOLA: Any authenticated user can change the role of ANY member in ANY chama

| Field | Value |
|---|---|
| Severity | **Critical (Broken Object-Level Authorization — privilege escalation in any chama)** |
| Surface | API / authz |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# I am NOT a member of "Carl Group" (69c511e1a8a7e71e0cdeab38)
# Agnes Njeri's group-member record ID: 69c521fba8a7e71e0cdeab75
# Agnes's current role: Member (69c50c8a38f08070a83bd35c)

$ curl -sS -X PATCH \
    -H "authorization: Bearer $MY_USER_TOKEN" \
    -H 'content-type: application/json' \
    --data-raw '{"roleId":"69c50c8a38f08070a83bd35d"}' \
    https://chamaconnect.io/api/proxy/groups/69c511e1a8a7e71e0cdeab38/members/69c521fba8a7e71e0cdeab75
{"message":"Member updated successfully","status":"success","data":{...}}
# HTTP 200 — Agnes Njeri's role just changed from Member → Secretary
# WITHOUT me being a member or admin of that chama
```

All three tests confirmed:

| Target | Member ID | New Role | Result |
|---|---|---|---|
| Carl Group — Carl Codey | `69c51d50a8a7e71e0cdeab54` | Secretary | ✅ 200 OK |
| Carl Group — Agnes Njeri | `69c521fba8a7e71e0cdeab75` | Secretary | ✅ 200 OK |
| Other group member (null user) | `69c52406a8a7e71e0cdeab77` | Any | ❌ 500 (null dereference — user field was null) |

The only authorization check is that the `groupId` and `memberId` combination exists — there is no check that the authenticated user belongs to that group, is an officer of that group, or has any administrative relationship to it.

An attacker who discovers a `memberId` (trivial via BUG-029 which returns all members of any chama) can:
1. Promote themselves to `Treasurer` or `ChamaAdmin` in any group they want access to.
2. Demote legitimate officers (remove the group admin) to `Member` or a custom role with no permissions.
3. Cycle through all group member IDs and change every member's role to a meaningless custom role, effectively disrupting all chamas on the platform.

## User impact

Complete loss of chama governance integrity. Any attacker gains effective officer-level access to every chama on the platform, enabling them to approve transactions, block legitimate approvals, and lock out real admins. On a financial collective managing real money, this is a catastrophic trust failure.

## Root cause

```ts
// server/controllers/groups.ts (inferred)
export const updateGroupMember = asyncHandler(async (req, res) => {
  const { groupId, memberId } = req.params;
  // Only checks: does (groupId, memberId) exist?
  const member = await GroupMember.findOne({ id: memberId, groupId });
  if (!member) return notFound(res);
  // Missing: is req.user.id in this group? Is req.user an officer/admin?
  member.roleId = req.body.roleId;
  await member.save();
  return res.json({ message: 'Member updated successfully', status: 'success', data: member });
});
```

## Proposed fix

```ts
export const updateGroupMember = asyncHandler(async (req, res) => {
  const { groupId, memberId } = req.params;
  const callerId = req.user!.id;
  const isPlatformAdmin = req.user!.role?.name === 'SuperAdmin';

  // Verify caller is an officer (ChamaAdmin or Chairperson) of this specific group
  const callerMembership = await GroupMember.findOne({ groupId, userId: callerId, isActive: true })
    .populate('role');
  const isOfficer = callerMembership?.role?.name &&
    ['ChamaAdmin', 'Chairperson'].includes(callerMembership.role.name);

  if (!isPlatformAdmin && !isOfficer) {
    return forbidden(res, 'Only group officers can update member roles');
  }

  const member = await GroupMember.findOne({ id: memberId, groupId });
  if (!member) return notFound(res);

  member.roleId = req.body.roleId;
  await member.save();
  return res.json({ message: 'Member updated successfully', status: 'success', data: member });
});
```

Additional controls:
- Do not allow an officer to assign a role higher than their own (prevent self-escalation to `ChamaAdmin` from `Treasurer`).
- Log all role changes with actor, target, old role, and new role.
- Notify the affected member by email/SMS when their role changes.

## Verification

1. As a non-member, `PATCH /api/proxy/groups/:id/members/:memberId` → `403 Forbidden`.
2. As a `Member` (not an officer), same request → `403 Forbidden`.
3. As a `ChamaAdmin` of a **different** group, same request → `403 Forbidden`.
4. As a `ChamaAdmin` of the **same** group → `200 OK`.
5. Regression test in `/recon/tests/group-member-role.spec.ts`.
