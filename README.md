# dsh-think-intensity

<p align="center">
  <strong>Thinking Intensity Strategy Plugin for DeepSeek Harness (DSH)</strong><br>
  Decides reasoning effort levels on top of existing model capabilities — observable, self-healing, and fully reversible.
</p>

<p align="center">
  <a href="https://github.com/fengzhiyushui/dsh-think-intensity/actions/workflows/ci.yml">
    <img src="https://github.com/fengzhiyushui/dsh-think-intensity/actions/workflows/ci.yml/badge.svg" alt="CI Status">
  </a>
  <a href="https://www.npmjs.com/package/dsh-think-intensity">
    <img src="https://img.shields.io/npm/v/dsh-think-intensity.svg" alt="npm version">
  </a>
  <a href="https://github.com/fengzhiyushui/dsh-think-intensity/releases">
    <img src="https://img.shields.io/github/v/release/fengzhiyushui/dsh-think-intensity" alt="GitHub release">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  </a>
  <img src="https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-brightgreen" alt="Node.js">
  <img src="https://img.shields.io/badge/dsh-%3E%3D0.1.7--rc.1%20%3C0.3.0-orange" alt="DSH Support">
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh.md">简体中文</a>
</p>

---

## What Problem Does It Solve?

In DeepSeek Harness (DSH), **thinking intensity is not an arbitrary runtime switch, but a strict capability declaration** (`reasoningEfforts`):

1. **Official Catalog Models** (such as DeepSeek Reasoner, OpenAI o1/o3) ship with built-in effort declarations. Opening the model selector in DSH natively reveals the second-level menu: `Reasoning Effort >`;
2. **Custom / Third-Party Models** (such as StepFun `step-5-preview`, Zhipu `glm-5.3`, or proxy gateways) do not have reasoning effort fields exposed in the DSH custom model settings UI, leaving them without `reasoningEfforts` declarations;
3. **The Result**: DSH treats them as plain text models and **hides the reasoning effort selector**; if parameters are forcefully sent, upstream gateways reject the request with `UNSUPPORTED_REASONING_EFFORT`.

**`dsh-think-intensity` solves this elegantly:**
- **Native Activation**: Backfills effort declarations into hand-declared models to **natively reveal DSH's built-in `Reasoning Effort >` menu**;
- **Explicit Choice Priority**: When a user selects a level manually in the UI, the plugin respects the choice 100% and passes it through untouched;
- **Default Strategies**: Injects configured levels (`defaultLevel`, `subagentLevel` for subagents, or `purposeLevels` for compaction) when no manual choice was made;
- **Self-Healing Fallback**: Automatically blacklists rejected levels inside the session to prevent infinite retry loops;
- **Sandboxed & Reversible**: Zero invasive hacks; clean uninstallation leaves no leftover overrides.

---

## Native UI Interaction

This plugin **fully embraces DSH's official native UI components** rather than adding intrusive floating widgets or custom sliders. In the chat composer, clicking the active model displays DSH's standard two-row menu:

```text
┌──────────────────────────────────────┐
│ Model             step-5-preview / … >│
│ Reasoning Effort  High               >│
└──────────────────────────────────────┘
```

Clicking `Reasoning Effort` expands the native choice list:
* `Off` (Disable thinking / zero parameter)
* `Low`
* `Medium`
* `High`
* `Max`

---

## Strategy Decision Flow

```text
┌───────────────────────┐
│ Agent Request Triggered│
└───────────┬───────────┘
            │
            ▼
    Explicit UI Choice? ──(Yes)──► Pass through untouched (100% User Priority)
            │ (No)
            ▼
   Origin === 'subagent'? ──(Yes)──► Apply subagentLevel
            │ (No)
            ▼
  Purpose Match (compaction)? ──(Yes)──► Apply purposeLevels mapping
            │ (No)
            ▼
   Apply defaultLevel
            │
            ▼
     Capability Guard (resolveModelInfo)
     ├── Target model supports effort? ──► Inject and proceed
     ├── Model is non-reasoning? ──► Strip inherited parameter to prevent errors
     └── Level hit gateway error blacklist? ──► Fall back cleanly
```

---

## Configuration Paths

DSH stores configuration patches in `cordis.patch.yml` under each profile:

| OS | Desktop App (`desktop` profile) | Web App (`web` profile) |
|---|---|---|
| **Windows** | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` | `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` |
| **macOS** | `~/.dsh/profiles/desktop/cordis.patch.yml` | `~/.dsh/profiles/web/cordis.patch.yml` |
| **Linux** | `~/.dsh/profiles/desktop/cordis.patch.yml` | `~/.dsh/profiles/web/cordis.patch.yml` |

---

## Configuration

In your profile's `cordis.patch.yml`, configure the plugin by entry id:

```yaml
- id: think-intensity
  config:
    defaultLevel: high        # Default effort for unselected requests; empty = pass through
    subagentLevel: max        # Dedicated level for subagent sessions; empty = fall back to defaultLevel
    providers: []             # Whitelisted provider routes; empty = all providers
    purposeLevels:            # Internal task effort mappings
      compaction: low         # Save tokens on memory compaction
      session-title: off      # Disable thinking for session titles
    backfillEnabled: true     # Automatically backfill declarations to activate the native menu
```

### Options Reference

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultLevel` | string | `""` | Global fallback level (`low`, `medium`, `high`, `max`); empty = no intervention |
| `subagentLevel` | string | `""` | Level for subagent sessions (`origin === 'subagent'`); empty = fall back to `defaultLevel` |
| `providers` | string[] | `[]` | Whitelisted provider routes; empty = all routes |
| `purposeLevels` | object | `{}` | Mapping from internal task purpose to effort level |
| `statsFlushMs` | number | `30000` | Minimum disk flush interval (ms) for `$DSH_HOME/storages/think-intensity-stats.json` |
| `backfillEnabled` | boolean | `false` | When `true`, writes missing `reasoningEfforts` declarations; default is dry-run |
| `backfillLevels` | object | `{}` | Effort to wire value table; empty falls back to `DEFAULT_BACKFILL_LEVELS` |
| `routeDefaultLevel`| string | `""` | Route default level; written only if all models in route support it |

---

## Manual Model Declaration (Without Auto-Backfill)

You can also manually declare `reasoningEfforts` under `llm-pi-ai` in `cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      stepfun:
        models:
          - id: step-5-preview
            name: step-5-preview
            contextWindow: 1024000
            reasoningEfforts:
              off: null       # off sends nothing to the wire
              low: low
              medium: medium
              high: high
              max: max
```

Restart DSH, and the native reasoning effort menu activates immediately.

---

## Installation & Uninstallation

### Option 1: Via npm (Recommended after release)
```bash
# Desktop profile
dsh plugin --profile desktop add dsh-think-intensity

# Web profile
dsh plugin --profile web add dsh-think-intensity
```

### Option 2: Via GitHub Release Tag (Pinned version)
```bash
dsh plugin --profile desktop add github:fengzhiyushui/dsh-think-intensity#v0.1.0
```

### Option 3: Local directory install
```bash
dsh plugin --profile desktop add /path/to/dsh-think-intensity
```

### Uninstallation
```bash
dsh plugin --profile desktop remove dsh-think-intensity

# Verify cleanly removed
dsh --profile desktop --dump-config
```

---

## Development & Testing

```bash
# Install dependencies
pnpm install

# Build single ESM bundle (lib/index.js) and types
pnpm run build

# Run 124 unit tests with Vitest
pnpm run test

# Type check
pnpm run typecheck
```

### Core Verified Scenarios (124 Tests)
1. **Explicit Priority**: Manual UI choices are never overridden;
2. **Default Injections**: `defaultLevel`, `subagentLevel`, and `purposeLevels` applied correctly;
3. **Capability Guard**: Models without reasoning skip injection; non-reasoning models strip inherited parameters;
4. **Wire Value Mapping**: Custom wire values (e.g., `high: ultra`) correctly delivered to upstream gateways;
5. **Self-Healing**: `UNSUPPORTED_REASONING_EFFORT` triggers in-session blacklisting to prevent request crashes;
6. **Legality Checks**: Rejects invalid effort dictionaries and non-standard keys;
7. **Concurrency & HMR Protection**: Handles hot-reloading transactions and config revision conflicts;
8. **Built-in Standard Levels**: `DEFAULT_BACKFILL_LEVELS` complies with catalog schema.

---

## Known Boundaries

* **In-Memory Blacklist**: Gateway error fallbacks are stored in memory and reset upon DSH restart to prevent transient network issues from persisting;
* **Non-Reasoning Stripping**: If an unreasoning model carries an inherited effort parameter, the plugin strips it to prevent gateway rejections (the only exception to "Explicit Priority").

---

## License

[MIT](LICENSE) © 2026 fengzhiyushui and contributors.
