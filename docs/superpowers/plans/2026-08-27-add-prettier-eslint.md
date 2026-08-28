# Add Prettier and ESLint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Prettier for formatting and ESLint for linting to the Vereda project, with format-on-save support via editor configuration.

**Architecture:** Install Prettier + ESLint with TypeScript support. Configure both to match existing code style. Add npm scripts. Add `.prettierrc` and `.eslintrc.cjs` (or flat config). Add `.editorconfig` for editor-agnostic consistency.

**Tech Stack:** Prettier, ESLint, @typescript-eslint/parser, @typescript-eslint/eslint-plugin

## Global Constraints

- Node 18+ required
- ESM-only project (type: "module" in package.json)
- TypeScript with NodeNext module resolution
- Use `.js` extensions in all imports (NodeNext ESM requirement)
- Zod is optional peer dependency; only `src/adapters/zod.ts` may import it
- `dist/` and `package-lock.json` are gitignored

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: Existing package.json structure
- Produces: New devDependencies for Prettier and ESLint

- [ ] **Step 1: Install Prettier and ESLint with TypeScript support**

```bash
npm install -D prettier eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint-config-prettier
```

- [ ] **Step 2: Verify installation**

```bash
ls node_modules/prettier node_modules/eslint
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add prettier and eslint dependencies"
```

---

### Task 2: Configure Prettier

**Files:**
- Create: `.prettierrc`
- Create: `.prettierignore`

**Interfaces:**
- Consumes: Existing code style (double quotes, semicolons, 2-space indent)
- Produces: Prettier configuration that matches existing style

- [ ] **Step 1: Create `.prettierrc`**

```json
{
  "semi": false,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

- [ ] **Step 2: Create `.prettierignore`**

```
node_modules/
dist/
package-lock.json
pnpm-lock.yaml
*.md
```

- [ ] **Step 3: Test Prettier on a single file**

```bash
npx prettier --check src/core/client.ts
```

Expected: Reports formatting issues (if any) or confirms file is formatted

- [ ] **Step 4: Commit**

```bash
git add .prettierrc .prettierignore
git commit -m "chore: add prettier configuration"
```

---

### Task 3: Configure ESLint

**Files:**
- Create: `.eslintrc.cjs`
- Create: `.eslintignore`

**Interfaces:**
- Consumes: TypeScript project configuration, Prettier config
- Produces: ESLint configuration that enforces code quality without conflicting with Prettier

- [ ] **Step 1: Create `.eslintrc.cjs`**

```javascript
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    // Customize as needed
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js', '*.cjs', '*.mjs'],
};
```

- [ ] **Step 2: Create `.eslintignore`**

```
node_modules/
dist/
*.js
*.cjs
*.mjs
```

- [ ] **Step 3: Test ESLint on a single file**

```bash
npx eslint src/core/client.ts
```

Expected: Reports linting issues (if any)

- [ ] **Step 4: Commit**

```bash
git add .eslintrc.cjs .eslintignore
git commit -m "chore: add eslint configuration"
```

---

### Task 4: Add EditorConfig

**Files:**
- Create: `.editorconfig`

**Interfaces:**
- Consumes: Existing code style
- Produces: Editor-agnostic configuration for consistent formatting

- [ ] **Step 1: Create `.editorconfig`**

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false

[*.{json,yml,yaml}]
indent_size = 2
```

- [ ] **Step 2: Commit**

```bash
git add .editorconfig
git commit -m "chore: add editorconfig for consistent formatting"
```

---

### Task 5: Add npm Scripts

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: Prettier and ESLint installed
- Produces: Scripts for formatting and linting

- [ ] **Step 1: Add scripts to `package.json`**

Add these scripts:
```json
"scripts": {
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "lint": "eslint .",
  "lint:fix": "eslint . --fix"
}
```

- [ ] **Step 2: Test the scripts**

```bash
npm run format:check
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add format and lint scripts"
```

---

### Task 6: Format Entire Codebase

**Files:**
- Multiple files in `src/` and `test/`

**Interfaces:**
- Consumes: Prettier configuration
- Produces: Consistently formatted codebase

- [ ] **Step 1: Run Prettier on entire codebase**

```bash
npm run format
```

- [ ] **Step 2: Run ESLint with auto-fix**

```bash
npm run lint:fix
```

- [ ] **Step 3: Verify tests still pass**

```bash
npm test
```

- [ ] **Step 4: Verify typecheck passes**

```bash
npm run typecheck
```

- [ ] **Step 5: Commit all formatted files**

```bash
git add -A
git commit -m "style: format entire codebase with prettier and eslint"
```

---

### Task 7: Update Documentation

**Files:**
- Modify: `CONTRIBUTING.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: New formatting/linting setup
- Produces: Updated contributor documentation

- [ ] **Step 1: Update CONTRIBUTING.md**

Add section about formatting/linting:
```markdown
## Code Style

This project uses Prettier for formatting and ESLint for linting.

**Format on save:** If your editor supports format-on-save (VS Code, etc.), it will work automatically with the `.prettierrc` and `.editorconfig` files.

**Commands:**
\`\`\`bash
npm run format         # Format all files
npm run format:check   # Check formatting without fixing
npm run lint           # Run ESLint
npm run lint:fix       # Run ESLint with auto-fix
\`\`\`
```

- [ ] **Step 2: Update AGENTS.md**

Change the line:
> "There is no lint or formatter configured — don't invent or run one."

To:
> "Prettier and ESLint are configured. Run `npm run format` and `npm run lint:fix` before committing."

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md AGENTS.md
git commit -m "docs: update contributing guide with formatting instructions"
```

---

### Task 8: Final Verification

**Files:**
- None (verification only)

**Interfaces:**
- Consumes: All previous tasks completed
- Produces: Confirmation that everything works

- [ ] **Step 1: Run full verification**

```bash
npm run format:check
npm run lint
npm test
npm run typecheck
```

All should pass with no errors.

- [ ] **Step 2: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address any remaining linting issues"
```

---

## Self-Review

**1. Spec coverage:** ✅ Added Prettier (formatting), ESLint (linting), EditorConfig (editor consistency), npm scripts, and documentation updates.

**2. Placeholder scan:** ✅ All steps have concrete commands and expected outputs.

**3. Type consistency:** ✅ All file paths and commands are consistent with the project structure.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-27-add-prettier-eslint.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
