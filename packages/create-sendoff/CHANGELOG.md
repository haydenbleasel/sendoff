# create-sendoff

## 1.0.0

### Major Changes

- 9386d29: First release. `bun create sendoff` clones Sendoff into `./sendoff` (or a folder you name), installs it and runs setup, which deploys it into your own Cloudflare and AWS accounts. Run it again in the same place to pick up where setup stopped. Pass `--repo <url>` to clone from another repo, such as your fork.
