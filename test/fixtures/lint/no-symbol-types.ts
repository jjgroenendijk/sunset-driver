// Shapes whose type the checker builds without a symbol. All are order-stable and
// must lint clean; asking for their base types used to crash the lint (issue #82).
const a = { x: 1 };
const b = { x: 2 };

export function sumOfArrayLiteral(): number {
  let n = 0;
  for (const p of [a, b]) n += p.x;
  return n;
}

function box(): [number, number, number, number] {
  return [0, 1, 2, 3];
}

export function spreadTuple(): number[] {
  const out: number[] = [];
  out.push(...box());
  return out;
}

export function spreadArrayLiteralOfObjects(): { x: number }[] {
  return [...[a, b]];
}

export function forOfInlineTuple(): number {
  let n = 0;
  for (const v of box()) n += v;
  return n;
}
