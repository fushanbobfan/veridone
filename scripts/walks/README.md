# Release walks

Playwright runs the dev server and the unit tests build their own fixtures. These scripts run the built app from a clone, on a real public repository and on workspaces the real v1.1.0 and v1.2.0 builds wrote: the first-workspace and removal walks through a browser, the other two through the API. While v1.2.0 was prepared, the first-workspace walk found a font the content security policy blocked on every page load and a pytest 9 summary line the packet could not read. The upgrade, dead-end, and removal walks hold the upgrade path, the stuck states v1.2.0 removed, and the removal of records.

## Run them

From a fresh clone:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
python -m pip install pytest
pnpm walk:first-workspace
pnpm walk:upgrade
pnpm walk:dead-ends
pnpm walk:removal
```

On Linux, `pnpm exec playwright install --with-deps chromium` also brings Chromium's system libraries.

| Command                     | What it walks                                                                                                                                                                                                                                                                                 | Needs besides the [installation prerequisites](../../docs/INSTALLATION.md)                                                               | Checks at v1.2.0                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `pnpm walk:first-workspace` | A real browser takes the built app from an empty workspace through a public repository to a verdict and a packet that verifies and holds no local path, then through a restart and a restored backup.                                                                                         | Playwright's Chromium, Python 3.10 or newer with pytest, and network access to clone two public repositories from GitHub.                | 27                                   |
| `pnpm walk:upgrade`         | A workspace made by the real v1.1.0 build opens in the clone under test and goes through the upgrade: migration, pinning, refused runs, a new run, a verdict on the old chain, and packets and backups of both schema versions.                                                               | Python 3.10 or newer with pytest, network access to clone one public repository, and the v1.1.0 tag, which the walk installs and builds. | 44                                   |
| `pnpm walk:dead-ends`       | The stuck states v1.2.0 removed, through the API, to a recorded decision or a working workspace: checks that cannot pin or pass, folders that went away, Git that cannot start, a backup past the old 25 MB limit.                                                                            | The v1.1.0 tag, which the walk installs and builds. It makes its own small repositories.                                                 | 78 on Windows, 76 on Linux and macOS |
| `pnpm walk:removal`         | A workspace made by the real v1.2.0 build opens in the built app, and a real browser removes a root, a repository, and a work item from it and puts each back. Every verdict and evidence row is compared before and after, both builds verify the packets, and that build's backup restores. | Playwright's Chromium. The walk builds the v1.2.0 tag itself and makes its own small repositories.                                       | Added after v1.2.0: CHECKS_COUNT     |

Each check prints `PASS` or `FAIL`, and a walk prints its verdict at the end, such as `UPGRADE WALK: PASS`. The exit code is 0 for a pass, 1 for a fail, and 2 when it could not start, with the reason. A walk takes from under a minute to a few minutes, longer the first time it builds v1.1.0.

The first-workspace and upgrade walks need `python` or `python3` on `PATH`, at version 3.10 or newer, which is what the repository they review declares, with pytest installed in that interpreter, and they check this before they start. VeriDone pins the file a link leads to, so where a virtual environment's `python` is a link, as on Linux, the packages in that environment are out of reach.

## Options

- `--ref REF` walks a clone of `REF`, installed and built on the side, with the scripts of the current tree. Without it, a walk builds the clone it runs in and walks that. A commit this clone lacks is fetched from origin, which takes its full hash.
- `--root DIR` holds the clones, logs, and workspaces a walk makes. The default is `output/walks`, which Git ignores. The v1.1.0 build stays there between runs.

The deepest file of a prepared clone sits 179 characters below its folder. On Windows without long paths enabled, a root that keeps the clone's folder under 80 characters avoids the 260-character limit.

`pnpm walk:release --ref COMMIT` runs the local gates at one commit: a fresh clone, every step of `pnpm quality`, all Playwright projects, and the four walks, with each step's output in a log. It ends with `ALL: PASS`, `ALL: FAIL` with the steps that failed, or `ALL: COULD NOT START` with the reason. It also needs Firefox and WebKit, from `pnpm exec playwright install`. It runs a failing unit test up to twice more, for a busy machine, and lists every retry.

## Systems

The walks are written for Windows, Linux, and macOS, and the workflow below runs them on all three. They run below normal priority. The one difference in what they check is that `npm` is a `.cmd` on Windows, which VeriDone cannot pin, so scenario B of the dead-end walk has that form on Windows alone.

## CI

The [Release walks](https://github.com/fushanbobfan/veridone/actions/workflows/walks.yml) workflow runs all four on Ubuntu, Windows, and macOS after each merge to main, every Monday, on demand, and on pull requests that change the walks. It stays off other pull requests and is not a required check. The whole job took about 2 minutes on Ubuntu and macOS and 8 on Windows in its first run, with three walks, and the walks depend on GitHub for their public repositories and on the newest Python and pytest, so a required run would slow every pull request and could block one for reasons outside its diff.

Running them only at release time finds problems late: the inlined font had shipped in v1.1.0. The merge runs are there to catch a regression soon after it lands, and the weekly run covers what changes with no commit here: the newest Python and pytest, and the runner images.

## Show that a walk still catches what it should

A walk that passes proves little until it fails on code with the defect. After changing a walk, run it on a commit from before the fix:

| Command                                   | The commit lacks                                            | What must fail                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm walk:dead-ends --ref 5e4455b`       | A way out of each stuck state                               | 58 of 78 checks on Windows, in all 11 scenarios                                                                        |
| `pnpm walk:upgrade --ref dc2db6b`         | The refusal of `INSERT OR REPLACE` on verdicts and evidence | `the migrated database refuses replacing evidence` and `the migrated database refuses replacing a verdict`             |
| `pnpm walk:first-workspace --ref 5e4455b` | Font files the content security policy allows               | `no page error, console error or server error along the way`, and the walk stops at the restore from the first screen  |
| `pnpm walk:first-workspace --ref 560a5c6` | A reader for pytest 9's `subtests passed` summary           | `the packet gives the test counts pytest printed`                                                                      |
| `pnpm walk:removal --ref 48c6d6d`         | Removal                                                     | `every record of the old workspace is there and none is removed`, and the walk stops at the first **Remove work item** |

The packet scan needs a seeded fault, since those commits redact the paths the walk plants: in `apps/server/src/redaction.ts`, make `sanitizeForPacket` return its input and `createPacketSanitizer` return a function that does, and the three `holds no local path` checks must fail.
