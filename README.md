<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="companion logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/getcompanion-ai/co-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/getcompanion-ai/co-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://companion.dev">companion.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# companion

> **Looking for the companion coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and running the companion coding agent.

## Packages

| Package                                                    | Description                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| **[@mariozechner/companion-ai](packages/ai)**                     | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/companion-agent-core](packages/agent)**          | Agent runtime with tool calling and state management             |
| **[@mariozechner/companion-coding-agent](packages/coding-agent)** | Interactive coding agent CLI                                     |
| **[@mariozechner/companion-tui](packages/tui)**                   | Terminal UI library with differential rendering                  |
| **[@mariozechner/companion-web-ui](packages/web-ui)**             | Web components for AI chat interfaces                            |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Install

### Public (binary)

Use this for users on production machines where you don't want to expose source.

```bash
curl -fsSL https://raw.githubusercontent.com/getcompanion-ai/co-mono/main/public-install.sh | bash
```

Install everything and keep it always-on (recommended for new devices):

```bash
curl -fsSL https://raw.githubusercontent.com/getcompanion-ai/co-mono/main/public-install.sh | bash -s -- --daemon --start
```

This installer:

- Downloads the latest release (or falls back to source when needed),
- writes `~/.local/bin/companion` launcher,
- populates `~/.companion/agent/settings.json` with package list,
- installs packages (if `npm` is available),
- and can install a user service for `companion daemon` so it stays alive (`systemd` on Linux, `launchd` on macOS).

Preinstalled package sources are:

```json
["npm:@e9n/companion-channels", "npm:companion-teams"]
```

If `npm` is available, it also installs these packages during install.

If no release asset is found, the installer falls back to source.

```bash
COMPANION_FALLBACK_TO_SOURCE=0 \
  curl -fsSL https://raw.githubusercontent.com/getcompanion-ai/co-mono/main/public-install.sh | bash -s -- --daemon --start
```

`public-install.sh` options:

```bash
curl -fsSL https://raw.githubusercontent.com/getcompanion-ai/co-mono/main/public-install.sh | bash -s -- --help
```

### Local (source)

```bash
git clone https://github.com/getcompanion-ai/co-mono.git
cd co-mono
./install.sh
```

Run:

```bash
./companion
```

Run in background with extensions active:

```bash
./companion daemon
```

For a user systemd setup, create `~/.config/systemd/user/companion.service` with:

```ini
[Unit]
Description=companion daemon
After=network-online.target

[Service]
Type=simple
Environment=CO_MONO_AGENT_DIR=%h/.companion/agent
Environment=COMPANION_CODING_AGENT_DIR=%h/.companion/agent
ExecStart=/absolute/path/to/repo/companion daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now companion
```

On macOS, `public-install.sh --daemon --start` now provisions a per-user `launchd` agent automatically.

Optional:

```bash
npm run build   # build all packages
npm run check   # lint/format/typecheck
```

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./companion-test.sh         # Run companion from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
