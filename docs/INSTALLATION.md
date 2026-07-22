# Installation and configuration

## Prerequisites

- Windows 10/11, current macOS, or a maintained Linux distribution.
- Node.js 22 or newer.
- Git available on `PATH`.
- pnpm 11.9.0. Corepack can activate it with `corepack prepare pnpm@11.9.0 --activate`.

`better-sqlite3` ships prebuilt binaries for common platforms. A platform without a matching binary also needs the native build toolchain required by Node-API packages.

## Development run

```bash
pnpm install --frozen-lockfile
pnpm dev
```

This one command starts the loopback API on `127.0.0.1:4317` and Vite on `127.0.0.1:4173`.

## Built local run

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

The local client and service are separate processes managed by one root command. Open `http://127.0.0.1:4173`.

## Data location

SQLite data is stored outside the repository by default:

- Windows: `%LOCALAPPDATA%\VeriDone\veridone.db`
- macOS: `~/Library/Application Support/VeriDone/veridone.db`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/veridone/veridone.db`

The database uses versioned migrations, foreign keys, WAL journaling, and normal synchronous mode. Use the in-product verified JSON backup for portability; do not copy a live WAL database as a backup.

## Environment variables

| Variable                   | Default                  | Purpose                                                                      |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `VERIDONE_HOST`            | `127.0.0.1`              | API bind address.                                                            |
| `VERIDONE_PORT`            | `4317`                   | API port.                                                                    |
| `VERIDONE_DATA_DIR`        | OS application-data path | SQLite directory.                                                            |
| `VERIDONE_ALLOWED_ORIGINS` | none beyond defaults     | Comma-separated extra browser origins.                                       |
| `VERIDONE_DEMO`            | unset                    | `1` reports demo service mode; hosted static demo normally needs no service. |
| `VERIDONE_WEB_PORT`        | `4173`                   | Vite/preview port.                                                           |
| `VERIDONE_API_PORT`        | `4317`                   | Vite proxy target.                                                           |

Remote binding, TLS termination, and multi-user authentication are deliberately unsupported in v1. The service refuses non-loopback hosts.

## Troubleshooting

- **Local service unavailable:** confirm both ports are free and `pnpm dev` still runs. The UI deliberately falls back to visibly synthetic data instead of pretending it read local evidence.
- **Repository rejected:** add its canonical parent as an approved root first. Symlinks resolving outside that root are rejected.
- **Check cannot run:** rebind the work item after any worktree change, then verify that the executable is available in the minimal environment.
- **Native SQLite install fails:** install the platform compiler toolchain or use a supported Node 22 build with a prebuilt binary.
