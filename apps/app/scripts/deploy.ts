// `bun run deploy`: apply migrations and deploy your instance.

import { deploy } from "./setup/deploy";

try {
  const { output } = deploy();

  process.stdout.write(output);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
