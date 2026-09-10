/**
 * Determinism lint. Fails the build when generation or simulation code:
 *   - calls Math.random() anywhere under src/;
 *   - iterates a Set or Map (for-of, spread, Array.from, forEach, .keys/.values/.entries);
 *   - iterates object keys (for-in, Object.keys/values/entries);
 * inside the directories that must be order-stable (src/core, src/world, src/sim).
 *
 * Uses the TypeScript type checker so `for (const x of foo)` is judged by the
 * real type of `foo`, not by its name.
 */
// TypeScript 7 (tsgo) ships no JS compiler API; the 5.x API is installed under the alias 'tsapi' for this script.
import ts from 'tsapi';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ORDER_STABLE_DIRS = ['src/core', 'src/world', 'src/sim'].map((d) => path.join(ROOT, d) + path.sep);

const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('tsconfig.json not found');
const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, ROOT);
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();

interface Finding {
  file: string;
  line: number;
  message: string;
}
const findings: Finding[] = [];

function report(node: ts.Node, message: string): void {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  findings.push({ file: path.relative(ROOT, sf.fileName), line: line + 1, message });
}

function typeName(type: ts.Type): string {
  const sym = type.getSymbol() ?? type.aliasSymbol;
  return sym ? sym.getName() : '';
}

const UNORDERED = new Set(['Set', 'Map', 'ReadonlySet', 'ReadonlyMap', 'WeakSet', 'WeakMap', 'SetIterator', 'MapIterator']);

function isUnorderedCollection(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(isUnorderedCollection);
  const name = typeName(type);
  if (UNORDERED.has(name)) return true;
  // Iterator results of Set/Map methods carry their origin in the alias or symbol name.
  if (/^(Set|Map)Iterator$/.test(name)) return true;
  const base = checker.getBaseTypes(type as ts.InterfaceType);
  return Array.isArray(base) && base.some((b) => UNORDERED.has(typeName(b)));
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

function visit(node: ts.Node, orderStable: boolean): void {
  // Math.random anywhere.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Math' &&
    node.expression.name.text === 'random'
  ) {
    report(node, 'Math.random() is forbidden; use rngFor(seed, tick, subsystem, id)');
  }

  if (orderStable) {
    if (ts.isForOfStatement(node)) checkIterationSource(node.expression);
    if (ts.isForInStatement(node)) report(node, 'for-in iterates object keys in insertion order; sort the keys first');
    if (ts.isSpreadElement(node)) checkIterationSource(node.expression);
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isPropertyAccessExpression(e)) {
        const method = e.name.text;
        if (method === 'forEach' || method === 'keys' || method === 'values' || method === 'entries') {
          const inSortHelper = path.relative(ROOT, node.getSourceFile().fileName) === path.join('src', 'core', 'sort.ts');
          if (!inSortHelper) {
            const recvType = checker.getTypeAtLocation(e.expression);
            if (isUnorderedCollection(recvType)) {
              report(node, `${typeName(recvType)}.${method}() follows insertion order; use sortedEntries/sortedMembers`);
            }
          }
        }
        if (ts.isIdentifier(e.expression) && e.expression.text === 'Array' && method === 'from' && node.arguments[0]) {
          checkIterationSource(node.arguments[0]);
        }
      }
      if (isObjectKeysCall(node) && path.relative(ROOT, node.getSourceFile().fileName) !== path.join('src', 'core', 'sort.ts')) {
        report(node, 'Object.keys/values/entries order is unstable; use sortedKeys');
      }
    }
  }
  ts.forEachChild(node, (child) => visit(child, orderStable));
}

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile) continue;
  if (!sf.fileName.startsWith(path.join(ROOT, 'src') + path.sep)) continue;
  const orderStable = ORDER_STABLE_DIRS.some((d) => sf.fileName.startsWith(d));
  visit(sf, orderStable);
}

if (findings.length > 0) {
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.message}`);
  console.error(`\n${findings.length} determinism violation(s).`);
  process.exit(1);
}
console.log('determinism lint: clean');
