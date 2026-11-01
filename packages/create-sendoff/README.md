# create-sendoff

Deploy [Sendoff](https://sendoff.dev), which emails your list (newsletters, launches, announcements) from Claude or Codex, into your own Cloudflare and AWS accounts.

```bash
bun create sendoff
```

It clones Sendoff into `./sendoff`, installs it and runs setup, which creates the database, queue and SES identity, adds your DNS records (or lists them, if your DNS isn't on Cloudflare), deploys the Worker and asks AWS for production access. Pass a folder name to use another folder. Run it again in the same place to pick up where setup stopped.

You need a Cloudflare account on Workers Paid with your domain on it, an AWS account, Bun, Git and, ideally, the AWS CLI logged in. See the [quickstart](https://sendoff.dev/docs/quickstart).

## Options

| Option         | What it does                                   |
| -------------- | ---------------------------------------------- |
| `[folder]`     | Where to clone Sendoff. Defaults to `sendoff`. |
| `--repo <url>` | Clone from another repo, such as your fork.    |
| `-h`, `--help` | Show help.                                     |

Keep the folder: `apps/app/.sendoff/` holds your instance's config, and updates (`git pull && bun install && bun run deploy`) deploy from it.

## License

MIT © [Hayden Bleasel](https://github.com/haydenbleasel)
