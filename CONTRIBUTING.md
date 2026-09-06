# Contributing to StellarSettle API

## Commits: Conventional Commits (enforced)

All commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by **Husky** (`commit-msg` hook) and the **Commitlint** GitHub Action on pull requests.

### Format

```
<type>(<optional scope>): <short description>

[optional body]
```

### Common types

| Type       | Use for |
|-----------|---------|
| `feat`    | New feature |
| `fix`     | Bug fix |
| `docs`    | Documentation only |
| `chore`   | Maintenance, tooling, deps |
| `refactor`| Code change that neither fixes a bug nor adds a feature |
| `test`    | Adding or updating tests |
| `ci`      | CI / workflow changes |


### Examples

- `feat(auth): add wallet challenge endpoint`
- `fix(invoices): correct net amount rounding`
- `chore: bump typescript to 5.7.2`

### Bypass (emergency only)

Avoid skipping hooks. If absolutely required: `git commit --no-verify` — maintainers may reject such PRs.

### Hook fails with “[input] is required”

Recent **npm** versions can swallow `--edit` when invoked via `npx`. The repo’s `.husky/commit-msg` uses `npx --no -- commitlint --edit "$1"` so the flag reaches Commitlint. If you changed that file locally, restore the `--` before `commitlint`.

---

## Secrets and credentials

- **Never commit** `.env`, `.env.local`, private keys (`.pem`, `.key`), JWT secrets, database URLs with passwords, API keys, or Stellar seed phrases.
- Use **`.env.example`** (or README) for variable *names* only, with placeholder values.
- If you accidentally commit a secret: rotate the credential immediately and ask maintainers to purge it from git history.
- Prefer running a local secret scanner (e.g. [Gitleaks](https://github.com/gitleaks/gitleaks) CLI) before pushing if you use one; it is optional for this repo.

---

## Pull requests

- **All GitHub Actions workflows must pass** (green) before a PR is merged — **API CI** and **Commitlint**.
- Link issues with `Closes #123` in the PR description where applicable.
- Match existing code style; run `npm run lint` and `npm run type-check` locally (also run on pre-commit via Husky).

---

## Local setup

```bash
npm install
```

`npm install` runs the `prepare` script and installs **Husky** hooks automatically.

## 🌿 Branching & Pull Request Workflow

### Default Branch: `dev`
All active development happens on the `dev` branch. The `main` branch is reserved
for stable, production-ready releases only.

### How to Contribute
1. **Fork** the repository (external contributors) or create a branch (team members).
2. **Branch off `dev`**:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes**, commit using [Conventional Commits](https://www.conventionalcommits.org/).
4. **Push to your fork/branch** and open a Pull Request **targeting `dev`**.
5. **Wait for CI checks** to pass (automated via GitHub Actions).
6. **Address review feedback** if requested.
7. **Merge** after approval (maintainers only).

### Branch Protection Rules
- ❌ Direct pushes to `main` are **not allowed**.
- ❌ Direct pushes to `dev` are **not allowed**.
- ✅ All changes must go through a Pull Request.
- ✅ CI status checks must pass before merging.
- ✅ At least 1 maintainer approval is required.

### Branch Naming Convention
- `feature/` — New features
- `fix/` — Bug fixes
- `docs/` — Documentation changes
- `test/` — Test additions/modifications
- `refactor/` — Code refactoring
- `chore/` — Maintenance tasks

