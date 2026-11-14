# create-sendoff

## 1.0.2

### Patch Changes

- a751ef1: The commands `bun create sendoff` prints at the end work in any shell, Windows PowerShell and `cmd` included: they use `bun run --cwd <folder> …` instead of `cd … && …`. Shipping an update now points at `bun run update`, which moves your folder to the latest release, instead of `git pull`, which can be ahead of it.
- 9eca4fe: On a Node.js older than 20.12, `bun create sendoff` says which version it needs instead of crashing with an error about a missing `styleText` export.

## 1.0.1

### Patch Changes

- a34290b: `--repo` can't pass options to `git clone`: a value that starts with a dash is always read as the repository.
- c310d74: `bun create sendoff` shows the right path to your Sendoff folder when it's on another Windows drive (`D:\news`, not `./D:\news`), and when its name starts with two dots.
- 55c0c52: `bun create sendoff` and its README describe what the `apps/app/.sendoff` folder holds as your instance's config, since your settings live in Sendoff's database. The README also says setup adds your DNS records only when your DNS is on Cloudflare, and lists them for you to add otherwise.

## 1.0.0

### Major Changes

- 9386d29: First release. `bun create sendoff` clones Sendoff into `./sendoff` (or a folder you name), installs it and runs setup, which deploys it into your own Cloudflare and AWS accounts. Run it again in the same place to pick up where setup stopped. Pass `--repo <url>` to clone from another repo, such as your fork.
