// The packaged entry (the Homebrew wrapper runs `node dist/cli-main.js`): runs the cocheck command and exits with its status.
import { main } from "./cli.ts";

const result = await main(process.argv.slice(2));
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exit(result.exitCode);
