/**
 * File a GitHub issue, after checking that it is not already filed.
 *
 * Usage: node scripts/file-issue.ts "<title>" [--body=- | --body="text"] [--label=bug] [--force]
 *
 * `CLAUDE.md` asks every session to file an issue for a problem it finds
 * outside the scope of its own issue, and sessions do: 38 of the last 72 filed
 * one. They also file the same problem again, which is how closed issue #88,
 * "The test tiers run over their time budgets, and every session files it
 * again", got its title.
 *
 * So the search comes first, over closed issues as well as open ones, because a
 * closed issue is the one a session is most likely to file a second time. A
 * near match stops the filing and prints what it found. `--force` files anyway,
 * which is the right answer when the old issue really is a different problem.
 *
 * `--body=-` reads the body from standard input, which is how a long body is
 * passed without quoting it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { requireGh } from './gh.ts';

interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
}

const args = process.argv.slice(2);
const title = args.find((a) => !a.startsWith('--'));
if (title === undefined || title.trim() === '') {
  console.error('usage: node scripts/file-issue.ts "<title>" [--body=-] [--label=bug] [--force]');
  process.exit(2);
}
const option = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const force = args.includes('--force');

requireGh(
  'Until gh is back, file the issue through the GitHub MCP server. Search open and closed\n' +
    'issues for the same problem first: that search is what this script is for.',
);

function gh(argv: string[], input?: string): string {
  return execFileSync('gh', argv, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  });
}

/**
 * The words worth searching for: the ones that name the problem. Short and
 * common words match everything, so they are dropped.
 */
const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'is', 'are',
  'was', 'were', 'be', 'it', 'its', 'this', 'that', 'with', 'from', 'when', 'then', 'than', 'not',
  'no', 'has', 'have', 'does', 'do', 'should', 'would', 'can', 'every', 'each', 'one', 'two',
]);

function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter((word) => word.length > 3 && !NOISE.has(word)),
    ),
  ];
}

/** Issues that share words with the title, in both states, best match first. */
function similar(): Issue[] {
  const words = terms(title!);
  if (words.length === 0) return [];
  let found: Issue[];
  try {
    // `in:title` keeps the match on the problem's name rather than on any issue
    // whose body happens to mention the same file.
    const out = gh([
      'issue', 'list', '--state', 'all', '--limit', '60', '--search',
      `${words.join(' OR ')} in:title`, '--json', 'number,title,state,url',
    ]);
    found = JSON.parse(out) as Issue[];
  } catch {
    return [];
  }
  // A word shared with half the issues in the repository says nothing: this
  // project's titles are full of `render`, `preview` and `world`. A word almost
  // no other title uses is the one that names the problem. So each word is
  // weighted by how rare it is among the titles the search returned, which
  // needs no list of common words to be kept up to date.
  const titles = found.map((issue) => new Set(terms(issue.title)));
  const weight = new Map<string, number>();
  for (const word of words) {
    const seen = titles.filter((set) => set.has(word)).length;
    weight.set(word, Math.log((found.length + 1) / (seen + 1)) + 1);
  }
  const total = words.reduce((sum, word) => sum + weight.get(word)!, 0);
  const scored = found
    .map((issue, index) => {
      const against = titles[index]!;
      const hit = words.filter((word) => against.has(word));
      const share = hit.reduce((sum, word) => sum + weight.get(word)!, 0) / total;
      return { issue, shared: hit.length, share };
    })
    // Two fifths of the naming weight in common, over at least two words. This
    // errs towards showing too much: a match you dismiss costs two lines, and a
    // match you never saw costs a duplicate issue.
    .filter((match) => match.share >= 0.4 && match.shared >= 2)
    .sort((a, b) => b.share - a.share);
  return scored.slice(0, 5).map((match) => match.issue);
}

if (!force) {
  const matches = similar();
  if (matches.length > 0) {
    console.log(`Not filed. ${matches.length} issue(s) may already cover this, closest first:`);
    for (const issue of matches) {
      console.log(`  #${issue.number}  ${issue.state.padEnd(6)}  ${issue.title}`);
      console.log(`            ${issue.url}`);
    }
    console.log('\nRead them. Comment on the one that covers it, or re-run with --force if none does.');
    process.exit(1);
  }
}

const bodyOption = option('body');
const body = bodyOption === '-' ? readFileSync(0, 'utf8') : (bodyOption ?? '');
const create = ['issue', 'create', '--title', title, '--body', body];
const label = option('label');
if (label !== undefined && label !== '') create.push('--label', label);

try {
  console.log(gh(create).trim());
} catch (error) {
  console.error(`gh issue create failed: ${(error as Error).message.split('\n')[0]}`);
  process.exit(1);
}
