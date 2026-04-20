# Contributing to Chama-Connect

Thanks for helping improve this project. This repository is a **ChamaConnect Virtual Hackathon** submission (ChamaPay module, live-site recon, and a structured bug register). Contributions that keep the tree focused, tested, and free of secrets are especially welcome.

## Before you start

- Read the [README](README.md) for context, repository layout, and the **Quick start** for ChamaPay.
- For the judges-facing write-up, see [docs/TECHNICAL-PROPOSAL.md](docs/TECHNICAL-PROPOSAL.md). For a scripted walkthrough, see [docs/DEMO.md](docs/DEMO.md).

## Prerequisites

- **Node.js** 18 or newer (the team has also used newer LTS releases).
- **npm** (paths below use `npm`; use your preferred client only if you know the equivalent commands).

## Local setup

### ChamaPay (`chamapay/`)

This is the main Next.js application.

```bash
cd chamapay
cp .env.example .env.local
npm install
npm run db:migrate && npm run db:seed
npm run dev
```

The app listens on **port 3100** by default. Open [http://localhost:3100/chamas/ACME](http://localhost:3100/chamas/ACME) after seeding.

**Daraja, USSD/SMS, and on-chain** variables in `.env.local` can stay empty for much of the local demo; the README describes simulating a C2B payment against the dev endpoint.

### Playwright recon (`recon/`)

Used to crawl the live [chamaconnect.io](https://chamaconnect.io) app with authentication. Root [`.env.example`](.env.example) documents the variables; copy to **repository root** `.env` (gitignored) with real credentials only on your own machine—**never commit them**.

```bash
cd recon
npm install
npx playwright install chromium
npm test
```

Artifacts under `recon/artifacts/` are ignored by git at scale; do not commit large or sensitive dumps.

## What to run before opening a pull request

From `chamapay/`:

| Command | Purpose |
|--------|---------|
| `npm run lint` | ESLint (Next.js config) |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Vitest (reconciliation and related unit tests) |
| `npm run build` | Production build (catches issues `dev` can miss) |

Fix any failures in the areas you touched. If a failure is pre-existing and out of scope, say so in the PR description.

## How to contribute

### Code or docs in ChamaPay

1. **Fork** the repository and create a **short-lived branch** from the default branch (`fix/…`, `feat/…`, `docs/…`).
2. Keep changes **scoped** to the problem you are solving; avoid unrelated refactors.
3. Match existing **style** (imports, naming, formatting). Let ESLint/Prettier drive formatting where configured.
4. Add or extend **tests** when you change behavior in `src/lib/` (especially reconciliation, DB, or payment paths).
5. Open a **pull request** with a clear title and a description that explains *what* changed and *why*.

### Bug reports or findings on chamaconnect.io

1. Copy [bugs/_template.md](bugs/_template.md) to `bugs/BUG-NNN-short-slug.md` using the next free number (see [bugs/README.md](bugs/README.md) index).
2. Fill in evidence, severity, impact, root cause, proposed fix, and verification.
3. Add a row to the **Index** table in [bugs/README.md](bugs/README.md).

Use neutral, factual language and redact tokens, passwords, and personal data from pasted logs or screenshots.

### Documentation-only changes

Small README or doc fixes are fine as PRs. For larger rewrites, open an issue or PR draft first so maintainers can align on structure.

## Secrets and licensing

- **Do not commit** `.env`, `.env.local`, API keys, JWT material, private keys, or `recon/artifacts/` contents.
- **Do not** paste production credentials into issues or PRs.
- New code should remain compatible with the project [LICENSE](LICENSE) (MIT unless the file states otherwise).

## Questions

If something in this guide conflicts with the README, treat the **README as the source of truth** for hackathon-specific submission steps and prefer updating this file in a follow-up PR.
