import ts from 'tsapi';
import { readFileSync } from 'node:fs';

/** An assertion in a per-seed loop that does not say which seed it read. */
export interface Unlabelled {
  file: string;
  line: number;
  text: string;
}

/** Whether a loop walks the seeds of the sweep: it binds `seed`, or reads `seeds`. */
function walksSeeds(loop: ts.ForOfStatement, source: ts.SourceFile): boolean {
  const bound = loop.initializer.getText(source);
  return /\bseed\b/.test(bound) || /\bseeds\b/.test(loop.expression.getText(source));
}

/**
 * Every `expect` inside a loop over the sweep's seeds that carries no message.
 * A sweep check reads every seed in one `it`, so a failure names the check and
 * the two values; the message is the only place the seed can appear, and the
 * seed is what a session needs to run the failure again (issue #560).
 */
export function unlabelledExpects(file: string, text = readFileSync(file, 'utf8')): Unlabelled[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Unlabelled[] = [];
  const visit = (node: ts.Node, inSeedLoop: boolean): void => {
    const inside = inSeedLoop || (ts.isForOfStatement(node) && walksSeeds(node, source));
    if (inside && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
      if (node.arguments.length < 2) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({ file, line: line + 1, text: node.getText(source) });
      }
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(source, false);
  return found;
}
