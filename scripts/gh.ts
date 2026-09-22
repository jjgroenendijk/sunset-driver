/**
 * Stop early, and say what to do, when the `gh` CLI is missing.
 *
 * `file-issue.ts` and `pr-wait.ts` are both `gh` and nothing else. The cloud
 * image ships no `gh`, so both used to fail on `spawnSync gh ENOENT` after the
 * duplicate search had already returned nothing, which reads like a repository
 * with no matching issue rather than like a missing tool.
 *
 * `scripts/setup-cloud.sh` installs `gh` and logs it in, so this should not be
 * reached. When it is, the message names the two ways out.
 */
import { execFileSync } from 'node:child_process';

/**
 * Exit with an explanation unless `gh` runs. `instead` says what to do without
 * it, since the caller knows which job was being asked for.
 */
export function requireGh(instead: string): void {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return;
  } catch {
    console.error('gh is not on the PATH, so this script cannot run.');
    console.error(
      '\nA cloud session installs gh in scripts/setup-cloud.sh. Its result is cached in a\n' +
        'snapshot, so after that script changed, re-save the setup script field at\n' +
        'claude.ai/code to rebuild it.',
    );
    console.error(`\n${instead}`);
    process.exit(1);
  }
}
