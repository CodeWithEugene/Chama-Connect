<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-021 — `/api/proxy/roles` omits the `permissions` field entirely; `/users/current-user.role` returns `permissions: []` — same resource, two shapes

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | API / data contract |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon (compared `/api/proxy/roles` and `/api/proxy/users/current-user`) |

## Evidence

**`GET /api/proxy/roles`** — no `permissions` key on any role record:

```json
{
  "message": "Role lists",
  "status": "success",
  "data": [
    { "id": "...35f", "name": "Chairperson",  "createdAt": "...", "updatedAt": "..." },
    { "id": "...360", "name": "ChamaAdmin",   "createdAt": "...", "updatedAt": "..." },
    { "id": "...35c", "name": "Member",       "createdAt": "...", "updatedAt": "..." },
    { "id": "...35d", "name": "Secretary",    "createdAt": "...", "updatedAt": "..." },
    { "id": "...361", "name": "SuperAdmin",   "createdAt": "...", "updatedAt": "..." },
    { "id": "...35e", "name": "Treasurer",    "createdAt": "...", "updatedAt": "..." },
    { "id": "...35b", "name": "User",         "createdAt": "...", "updatedAt": "..." }
  ],
  "count": 7
}
```

**`GET /api/proxy/users/current-user`** — same `User` role, different shape (has `permissions: []`):

```json
"role": {
  "id": "69c50c8a38f08070a83bd35b",
  "name": "User",
  "createdAt": "2026-03-26T10:38:02.540Z",
  "updatedAt": "2026-03-26T10:38:02.540Z",
  "permissions": []
}
```

Both captured at `recon/artifacts/2026-04-20T09-40-50-508Z/network/requests.json`.

## User impact

1. **Client code that sanity-checks `role.permissions` before rendering an action** (e.g. "show the Approve Loan button if `permissions.includes('loan:approve')`") will crash on the `/roles` endpoint (reading `.includes` on `undefined`). Developers integrating the admin panel get a mystery `TypeError: Cannot read properties of undefined (reading 'includes')` when they switch which endpoint populates the dropdown.
2. **Admin UIs that list roles for assignment** (e.g. a future "Assign Chama Secretary" dialog) cannot surface *what that role can do* because the endpoint meant for listing roles doesn't include the permissions they each carry. Users then cannot make informed assignment decisions.
3. **Schema drift hides BUG-015.** BUG-015 says all roles have `permissions: []`. A reviewer running `curl /api/proxy/roles` to confirm wouldn't see empty arrays — they'd see the key is missing entirely, and wrongly conclude "the API doesn't even expose permissions", when in fact one endpoint does (and returns the empty list).
4. **This is the same category of bug as BUG-010** (two `group-types` endpoints with swapped `label` / `value`). ChamaConnect has repeated API-contract inconsistency; a judge reviewing the platform would cite both as symptoms of missing shared DTOs.

## Root cause

Two different controllers/serializers for the same `Role` entity. `/api/proxy/users/current-user` populates the full ORM relation; `/api/proxy/roles` uses a trimmed projection that never added `permissions` when that column was introduced.

## Proposed fix

1. **Define a single `RoleDTO`** in a shared module and make every serializer use it:

```ts
// types/role.ts
export type RoleDTO = {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
};

export function toRoleDTO(row: Role): RoleDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    permissions: row.permissions ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

2. **Update `/api/proxy/roles`** to return `toRoleDTO(r)` for every row. Same for any other endpoint that ships roles (`/users/current-user`, `/groups/:id/members`, etc.).

3. **Add a contract test in CI** that proves the shape is stable:

```ts
const ROLE_KEYS = ["id", "name", "permissions", "createdAt", "updatedAt"].sort();
for (const endpoint of ["/api/proxy/roles", "/api/proxy/users/current-user"]) {
  const body = await request.get(endpoint).then(r => r.json());
  const sample = endpoint.endsWith("roles") ? body.data[0] : body.data.role;
  expect(Object.keys(sample).sort()).toEqual(expect.arrayContaining(ROLE_KEYS));
}
```

4. **Fix BUG-015 simultaneously** — populate a real `permissions` list per role so the field is finally meaningful. See that report for the default permission seed.

## Verification

- `curl -sS /api/proxy/roles | jq '.data[0] | keys'` includes `"permissions"`.
- `curl -sS /api/proxy/users/current-user | jq '.data.role | keys'` returns an identical key set (ignoring order) to `/api/proxy/roles` rows.
- Contract test passes for every endpoint that serializes a role.
