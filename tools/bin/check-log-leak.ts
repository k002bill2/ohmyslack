import { runCli } from '../lib/cli.ts';
import { run } from '../check-log-leak.ts';

await runCli(run);
