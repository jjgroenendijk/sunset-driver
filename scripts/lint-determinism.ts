/**
 * Determinism lint. Fails the build when generation or simulation code:
 *   - calls Math.random() anywhere under src/;
 *   - calls a Math function ECMAScript leaves to the engine (sin, cos, pow,
 *     log, hypot and the rest of the approximated set);
 *   - iterates a Set or Map (for-of, spread, Array.from, forEach, .keys/.values/.entries);
 *   - iterates object keys (for-in, Object.keys/values/entries);
 * inside the directories that must be order-stable (src/core, src/world, src/sim).
 * Math.random is forbidden everywhere under src/; the rest apply to those
 * directories only.
 *
 * Uses the TypeScript type checker so `for (const x of foo)` is judged by the
 * real type of `foo`, not by its name.
 *
 * Run as a script it lints the project. Imported it exports `lintDeterminism`,
 * which lints any file set, so the tests can check the rules on fixtures.
 */
// TypeScript 7 (tsgo) ships no JS compiler API; the 5.x API is installed under the alias 'tsapi' for this script.
import ts from 'tsapi';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export interface Finding {
  file: string;
  line: number;
  message: string;
}

const UNORDERED = new Set(['Set', 'Map', 'ReadonlySet', 'ReadonlyMap', 'WeakSet', 'WeakMap', 'SetIterator', 'MapIterator']);

/**
 * The functions of `Math` the ECMAScript specification calls
 * implementation-approximated: every engine may round them its own way, and
 * engines do. `src/core/libm.ts` holds the ones the game uses; a call here to
 * one it does not yet hold is the prompt to add it there rather than to reach
 * for `Math`. Everything left out of this set — abs, min, max, floor, ceil,
 * round, trunc, sign, sqrt, imul — is exactly specified and safe.
 */
const APPROXIMATED = new Set([
  'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt', 'cos', 'cosh', 'exp', 'expm1',
  'fround', 'hypot', 'log', 'log10', 'log1p', 'log2', 'pow', 'sin', 'sinh', 'tan', 'tanh',
]);

/**
 * Lint `fileNames` and return every violation found in them.
 *
 * @param fileNames      files to compile, absolute.
 * @param options        compiler options for the program.
 * @param orderStableDirs directories whose files must also be order-stable, absolute.
 * @param root           paths in the findings are relative to this directory.
 */
export function lintDeterminism(
  fileNames: string[],
  options: ts.CompilerOptions,
  orderStableDirs: string[],
  root: string = ROOT,
): Finding[] {
  const program = ts.createProgram(fileNames, options);
  const checker = program.getTypeChecker();
  const stableDirs = orderStableDirs.map((d) => d + path.sep);
  const wanted = new Set(fileNames);
  const findings: Finding[] = [];

  function report(node: ts.Node, message: string): void {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    findings.push({ file: path.relative(root, sf.fileName), line: line + 1, message });
  }

  function typeName(type: ts.Type): string {
    const sym = type.getSymbol() ?? type.aliasSymbol;
    return sym ? sym.getName() : '';
  }

  /**
   * The base types of `type`, or none. `checker.getBaseTypes` reads `type.symbol`,
   * so it throws on the types the checker builds without one, such as the type of an
   * array literal of object literals or of a tuple. Only a class or an interface can
   * have base types, so ask for them nowhere else. A generic type reference carries
   * its base types on its target.
   */
  function baseTypesOf(type: ts.Type): readonly ts.Type[] {
    const target = (type as ts.TypeReference).target ?? type;
    if (!target.isClassOrInterface() || !target.getSymbol()) return [];
    return checker.getBaseTypes(target);
  }

  function isUnorderedCollection(type: ts.Type): boolean {
    if (type.isUnion()) return type.types.some(isUnorderedCollection);
    const name = typeName(type);
    if (UNORDERED.has(name)) return true;
    // Iterator results of Set/Map methods carry their origin in the alias or symbol name.
    if (/^(Set|Map)Iterator$/.test(name)) return true;
    return baseTypesOf(type).some((b) => UNORDERED.has(typeName(b)));
  }

  function isObjectKeysCall(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) return false;
    const e = node.expression;
    return (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === 'Object' &&
      ['keys', 'values', 'entries'].includes(e.name.text)
    );
  }

  function checkIterationSource(expr: ts.Expression): void {
    if (isObjectKeysCall(expr)) {
      report(expr, 'iteration over object keys is order-unstable; sort the keys first');
      return;
    }
    let type: ts.Type;
    try {
      type = checker.getTypeAtLocation(expr);
    } catch {
      return;
    }
    if (isUnorderedCollection(type)) {
      report(expr, `iteration over ${typeName(type)} follows insertion order; iterate a sorted copy instead`);
    }
  }

  function isSortHelper(node: ts.Node): boolean {
    return path.relative(root, node.getSourceFile().fileName) === path.join('src', 'core', 'sort.ts');
  }

  /** The name of the `Math` method `node` calls, or undefined when it calls none. */
  function mathMethod(node: ts.Node): string | undefined {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Math'
    ) {
      return node.expression.name.text;
    }
    return undefined;
  }

  /** A call of `forEach`, `keys`, `values` or `entries` on a Set or a Map, or of `Array.from` on one. */
  function checkCollectionCall(node: ts.CallExpression): void {
    const e = node.expression;
    if (!ts.isPropertyAccessExpression(e)) return;
    const method = e.name.text;
    if ((method === 'forEach' || method === 'keys' || method === 'values' || method === 'entries') && !isSortHelper(node)) {
      const recvType = checker.getTypeAtLocation(e.expression);
      if (isUnorderedCollection(recvType)) {
        report(node, `${typeName(recvType)}.${method}() follows insertion order; use sortedEntries/sortedMembers`);
      }
    }
    if (ts.isIdentifier(e.expression) && e.expression.text === 'Array' && method === 'from' && node.arguments[0]) {
      checkIterationSource(node.arguments[0]);
    }
  }

  /** The rules that hold only where iteration order and rounding must be stable. */
  function checkOrderStable(node: ts.Node): void {
    // An approximated Math function rounds differently in Node and in the
    // browser, which is enough to build a different city (issue #243).
    const name = mathMethod(node);
    if (name !== undefined && APPROXIMATED.has(name)) {
      report(node, `Math.${name}() is rounded differently by each engine; use src/core/libm.ts`);
    }
    if (ts.isForOfStatement(node)) checkIterationSource(node.expression);
    if (ts.isForInStatement(node)) report(node, 'for-in iterates object keys in insertion order; sort the keys first');
    if (ts.isSpreadElement(node)) checkIterationSource(node.expression);
    if (ts.isCallExpression(node)) {
      checkCollectionCall(node);
      if (isObjectKeysCall(node) && !isSortHelper(node)) {
        report(node, 'Object.keys/values/entries order is unstable; use sortedKeys');
      }
    }
  }

  function visit(node: ts.Node, orderStable: boolean): void {
    // Math.random anywhere.
    if (mathMethod(node) === 'random') {
      report(node, 'Math.random() is forbidden; use rngFor(seed, tick, subsystem, id)');
    }
    if (orderStable) checkOrderStable(node);
    ts.forEachChild(node, (child) => visit(child, orderStable));
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!wanted.has(sf.fileName)) continue;
    visit(sf, stableDirs.some((d) => sf.fileName.startsWith(d)));
  }
  return findings;
}

/** Lint the project: every file under src/, order-stable under src/core, src/world and src/sim. */
export function lintProject(): Finding[] {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('tsconfig.json not found');
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, ROOT);
  const src = path.join(ROOT, 'src') + path.sep;
  const files = config.fileNames.filter((f) => f.startsWith(src));
  const stable = ['src/core', 'src/world', 'src/sim'].map((d) => path.join(ROOT, d));
  return lintDeterminism(files, config.options, stable, ROOT);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const findings = lintProject();
  if (findings.length > 0) {
    for (const f of findings) console.error(`${f.file}:${f.line}: ${f.message}`);
    console.error(`\n${findings.length} determinism violation(s).`);
    process.exit(1);
  }
  console.log('determinism lint: clean');
}
