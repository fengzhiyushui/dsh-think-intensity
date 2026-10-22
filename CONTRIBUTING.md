# Contributing to dsh-think-intensity

Thank you for your interest in contributing to `dsh-think-intensity`! We welcome bug reports, feature suggestions, documentation improvements, and pull requests.

## Development Setup

1. **Prerequisites**:
   - Node.js `^22.19.0 || >=24`
   - `pnpm` (`npm install -g pnpm`)

2. **Clone & Install**:
   ```bash
   git clone https://github.com/fengzhiyushui/dsh-think-intensity.git
   cd dsh-think-intensity
   pnpm install
   ```

3. **Build**:
   ```bash
   pnpm run build
   ```

4. **Testing**:
   ```bash
   pnpm run test
   pnpm run typecheck
   ```

## Pull Request Guidelines

1. **Keep it focused**: One bugfix or feature per PR.
2. **Include tests**: Add unit tests in `tests/` covering new scenarios.
3. **Follow the Design Principles**:
   - Explicit selection ALWAYS takes precedence over default policy.
   - Guard model capabilities before injecting any parameter.
   - Any hook exception must be swallowed to avoid crashing the user's host session.
4. **Clean Git History**: Use conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
