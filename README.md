<p align="center">
  <a href="https://clanker.dev">
    <img src="https://clanker.dev/logo.svg" alt="clanker logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/harivansh-afk/clanker-agent/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/harivansh-afk/clanker-agent/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://clanker.dev">clanker.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# clanker-agent

> **Looking for the clanker coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and running the clanker coding agent.

## Packages

| Package                                                    | Description                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| **[@mariozechner/clanker-ai](packages/ai)**                     | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/clanker-agent-core](packages/agent)**          | Agent runtime with tool calling and state management             |
| **[@mariozechner/clanker-coding-agent](packages/coding-agent)** | Interactive coding agent CLI                                     |
| **[@mariozechner/clanker-tui](packages/tui)**                   | Terminal UI library with differential rendering                  |
| **[@mariozechner/clanker-web-ui](packages/web-ui)**             | Web components for AI chat interfaces                            |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Install

### Public (binary)

Use this for users on production machines where you don't want to expose source.

```bash
curl -fsSL https://raw.githubusercontent.com/harivansh-afk/clanker-agent/main/public-install.sh | bash
```

Install everything and keep it always-on (recommended for new devices):

```bash
curl -fsSL https://raw.githubusercontent.com/harivansh-afk/clanker-agent/main/public-install.sh | bash -s -- --daemon --start
```

This installer:

- Downloads the latest release (or falls back to source when needed),
- writes `~/.local/bin/clanker` launcher,
- populates `~/.clanker/agent/settings.json` with package list,
- installs packages (if `npm` is available),
- and can install a user service for `clanker daemon` so it stays alive (`systemd` on Linux, `launchd` on macOS).

Preinstalled package sources are:

```json
["npm:@e9n/clanker-channels", "npm:clanker-teams"]
```

If `npm` is available, it also installs these packages during install.

If no release asset is found, the installer falls back to source.

```bash
CLANKER_FALLBACK_TO_SOURCE=0 \
  curl -fsSL https://raw.githubusercontent.com/harivansh-afk/clanker-agent/main/public-install.sh | bash -s -- --daemon --start
```

`public-install.sh` options:

```bash
curl -fsSL https://raw.githubusercontent.com/harivansh-afk/clanker-agent/main/public-install.sh | bash -s -- --help
```

### Local (source)

```bash
git clone https://github.com/harivansh-afk/clanker-agent.git
cd clanker-agent
./install.sh
```

Run:

```bash
./clanker
```

Run in background with extensions active:

```bash
./clanker daemon
```

For a user systemd setup, create `~/.config/systemd/user/clanker.service` with:

```ini
[Unit]
Description=clanker daemon
After=network-online.target

[Service]
Type=simple
Environment=CLANKER_MONO_AGENT_DIR=%h/.clanker/agent
Environment=CLANKER_CODING_AGENT_DIR=%h/.clanker/agent
ExecStart=/absolute/path/to/repo/clanker daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now clanker
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
./clanker-test.sh         # Run clanker from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
