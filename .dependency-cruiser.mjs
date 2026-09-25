/**
 * The directory rules of `CLAUDE.md`, as far as an import can break them. `npm run lint:deps`
 * checks them. A rule that is about what code does rather than what it imports (no wall-clock in
 * `src/sim`, `src/render` never writes to the world) is the determinism lint's or a test's.
 *
 * dependency-cruiser reads TypeScript through swc: its TypeScript parser needs the compiler API
 * that TypeScript 7 no longer ships.
 */

/** The packages that draw, simulate a body or make a sound, and so need a browser or a device. */
const DEVICE = '^node_modules/(three/build/three\\.(webgpu|tsl)|@dimforge/|tone/)';

/** The three.js renderer, which `src/sim` may not reach. */
const RENDERER = '^node_modules/three/build/three\\.(webgpu|tsl)';

/** The half of `src/audio` that owns the Web Audio graph (`docs/audio.md`). */
const AUDIO_GRAPH = '^src/audio/(beds|cries|game-audio|mixer|offline|one-shots|radio|voices)\\.ts$';

/** The modules of `src/net` that load with the game; the rest load on the press (spec section 21). */
const NET_DOORS = '^src/net/(invite|control|attach)\\.ts$';

export default {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: 'src/core is pure: three.js math at most, and nothing from the rest of src.',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: [DEVICE, '^node_modules/three/examples/', '^src/(?!core/)'] },
    },
    {
      name: 'world-runs-headless',
      comment:
        'src/world runs in Node for the sweeps: three.js math and its generators, and no renderer, ' +
        'no Rapier, no Tone.js, and none of the directories that hold them.',
      severity: 'error',
      from: { path: '^src/world/' },
      to: { path: [DEVICE, '^node_modules/three/examples/jsm/(?!generators/)', '^src/(?!core/|world/)'] },
    },
    {
      name: 'sim-draws-nothing',
      comment: 'src/sim is the plain record: it draws nothing, plays nothing and knows no screen.',
      severity: 'error',
      from: { path: '^src/sim/' },
      to: { path: [RENDERER, '^node_modules/tone/', '^src/(?!core/|world/|sim/)'] },
    },
    {
      name: 'audio-plan-is-headless',
      comment:
        'The half of src/audio that reads the record runs in Node: no Tone.js, and none of the ' +
        'files that own the graph.',
      severity: 'error',
      from: { path: '^src/audio/', pathNot: AUDIO_GRAPH },
      to: { path: ['^node_modules/tone/', AUDIO_GRAPH] },
    },
    {
      name: 'net-loads-on-the-press',
      comment:
        'Only invite.ts, control.ts and attach.ts of src/net load with the game. The rest is ' +
        'imported for its types or loaded with import(), so single player connects to nothing.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/net/' },
      to: { path: '^src/net/', pathNot: NET_DOORS, dependencyTypesNot: ['type-only', 'dynamic-import'] },
    },
    {
      name: 'resolves',
      comment: 'Every import resolves, or the rules above would pass over it unread.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    parser: 'swc',
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.js'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'default'],
    },
  },
};
