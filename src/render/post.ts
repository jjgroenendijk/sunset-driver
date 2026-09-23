/**
 * The post chain of spec section 10.6.
 *
 * Deliberately minimal: the game's look comes from geometry, lighting and
 * materials, and this adds three things over them.
 *
 * - Bloom, so neon, lit windows and headlights spill light the way a camera
 *   sees them.
 * - SMAA, so a kerb seen from 60 m up is a line rather than a staircase.
 * - The colour grade of `grade.ts`, as a 3D lookup table generated at runtime
 *   and rebuilt as the day and the weather turn.
 *
 * The order they run in is the whole of the design. The scene is drawn into a
 * texture in real light, where the sun is thousands of times the strength of a
 * street lamp; bloom reads that frame, because what glows is decided in real
 * light and not in film. Tone mapping then brings the frame down to the 0..1 a
 * display can show, and only then is it graded: a lookup table has nowhere to
 * put a colour brighter than white. SMAA comes after the grade and before the
 * encode, because it wants linear colour and the grade may sharpen an edge it
 * has to find.
 *
 * `renderer.ts` owns the exposure, so the frame is multiplied by it here before
 * anything reads it and the tone mapping is then asked for none. That is what
 * makes {@link BLOOM_THRESHOLD} a number about the frame the player sees rather
 * than about the sky's absolute brightness.
 *
 * `PostQuality` is the part of a quality tier of spec section 9.2 this file
 * owns: the render scale, and a switch for each effect. `quality.ts` holds the
 * table of tiers and the frame-time monitor that walks it; `world-scene.ts`
 * owns the rest of what a tier changes.
 *
 * A graph is built once and kept. Building one costs a WGSL program, which
 * three.js generates on the frame thread: a chain rebuilt on every tier change
 * held the game still for about half a second each time, and never got cheaper,
 * because a fresh node is a fresh cache key however many times the same effects
 * have been compiled before. So each combination of effects is built once and
 * kept in {@link PostChain.chains}, `warm.ts` builds every tier's behind the
 * loading screen, and a tier change swaps the pipeline's output node to one
 * the renderer has already compiled. A tier that moves only the render scale changes no node at all.
 */
import { Data3DTexture, DataUtils, HalfFloatType, LinearFilter, NoToneMapping } from 'three';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import type { Camera, Scene } from 'three';
import { START_TICK } from '../sim/simulation.ts';
import { weatherAt, type Weather } from '../sim/weather.ts';
import { daylightAt } from './daylight.ts';
import { uploadLut } from './lut-upload.ts';
import {
  gradeAt,
  gradeStep,
  writeLut,
  LUT_GAMMA,
  LUT_LENGTH,
  LUT_SIZE,
} from './grade.ts';
import { setRenderScale } from './renderer.ts';
import {
  bloom,
  float,
  lut3D,
  luminance,
  max,
  mix,
  pass,
  renderOutput,
  smaa,
  step,
  texture3D,
  toneMapping,
  toneMappingExposure,
  vec4,
  type TslNode,
} from './tsl.ts';

/**
 * How much light is spread, how far it reaches as a fraction of the screen, and
 * how bright a thing has to be before it spreads any. The threshold is measured
 * on the exposed frame, so 1 is a surface that would burn out on its own: a
 * little under it catches the lit windows and the lamp lenses and leaves the
 * daylit street alone.
 *
 * The bloom reads only the light over the threshold, not the whole of a pixel
 * that passes it. The addon passes the whole pixel, so a facade of windows just
 * over the line spread as much light as a lamp lens far over it, and after dark
 * a tower seen from the street washed the frame beige. The radius is small for
 * the same reason: a glow stays around the light that throws it.
 */
const BLOOM_STRENGTH = 0.45;
const BLOOM_RADIUS = 0.2;
const BLOOM_THRESHOLD = 0.8;

/**
 * The share of the sky's light the bloom reads. The Preetham dome answers in
 * real sky brightness, and most of a clear sky by day is over
 * {@link BLOOM_THRESHOLD} once exposed: read whole, it spread a white glare
 * over every tower that stood against it. At this share only the sun's disc is
 * still over the threshold, so the sun glows and the sky does not.
 */
const SKY_BLOOM_SHARE = 0.1;

/**
 * The linear depth, 0 at the near plane and 1 at the far one, past which a
 * pixel is sky. The dome writes no depth, so the sky keeps the cleared far
 * depth, and nothing the city draws stands anywhere near the 2 km far plane.
 */
const SKY_DEPTH = 0.999;

/** What the frame may be drawn at, and what the tier system may step it to. */
export interface PostQuality {
  /**
   * Fraction of the display's pixels the frame is drawn at (spec section 9.2).
   * Below 1 the whole frame, post chain included, costs that share of what it
   * did, and the browser scales the result up to the canvas.
   */
  renderScale: number;
  bloom: boolean;
  smaa: boolean;
  grade: boolean;
}

/**
 * One graph of the chain, built once and kept for every tier that draws it.
 * The effects are held because each owns render targets. The targets of a
 * graph not drawn are shrunk to a pixel; they are released with the chain.
 */
interface Chain {
  /** What the pipeline draws the frame through. */
  output: TslNode;
  effects: TslNode[];
  /** The SMAA node, where this graph has one. */
  antialias: TslNode | undefined;
  /** Whether a frame has been drawn through this graph, which is what sets its effects up. */
  drawn: boolean;
}

/** Everything on, at the display's own resolution. */
export const FULL_QUALITY: PostQuality = { renderScale: 1, bloom: true, smaa: true, grade: true };

/** The frame, drawn through the effects of spec section 10.6. */
export class PostChain {
  private readonly renderer: WebGPURenderer;
  private readonly pipeline: RenderPipeline;
  /** The scene drawn into a texture. Built once: it is what every effect reads. */
  private readonly scenePass: TslNode;
  private readonly colour: TslNode;
  /** What the bloom reads: the light over {@link BLOOM_THRESHOLD}, the sky turned down to {@link SKY_BLOOM_SHARE}. */
  private readonly glare: TslNode;
  /** The colour grade, as a cube of colours the frame is looked up in. */
  private readonly lut: Data3DTexture;
  /** The cube in linear light, before it is packed into the texture's half floats. */
  private readonly graded = new Float32Array(LUT_LENGTH);
  /** Every graph built so far, by the effects it draws, so a tier change reuses one. */
  private readonly chains = new Map<string, Chain>();
  /** The graph the pipeline draws through. */
  private current: Chain | undefined;
  private settings: PostQuality;
  /** Which rebuild of the grade the table holds. */
  private step = -1;
  /**
   * Whether the cube reaches the GPU. False takes the grade out of the graph
   * drawn, because a grade that cannot be uploaded reads a cube of zeros and
   * turns every pixel black.
   */
  private gradable = true;
  /** The world's seed, which with the tick is what the weather is read from. */
  private readonly seed: number;
  /**
   * A weather to grade by instead of the seed's, as `WorldScene.fixedWeather`.
   * Call {@link PostChain.regrade} after setting it, or the table stays as it was.
   */
  fixedWeather: Weather | undefined = undefined;

  constructor(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: Camera,
    quality: PostQuality = FULL_QUALITY,
    seed = 0,
  ) {
    this.renderer = renderer;
    this.seed = seed;
    this.settings = { ...quality };
    this.pipeline = new RenderPipeline(renderer);
    // The chain tone maps and encodes the frame itself, at the point in the
    // order the grade and SMAA need. Left on, the pipeline would do both again
    // after everything here had run.
    this.pipeline.outputColorTransform = false;

    this.scenePass = pass(scene, camera);
    this.colour = vec4(this.scenePass.getTextureNode().rgb.mul(toneMappingExposure), 1);
    const sky = step(SKY_DEPTH, this.scenePass.getLinearDepthNode());
    const light = this.colour.rgb.mul(mix(float(1), float(SKY_BLOOM_SHARE), sky));
    // The excess is taken off the brightness rather than off each channel, so
    // a warm window glows warm rather than orange.
    const bright = max(luminance(light), 1e-4);
    this.glare = vec4(light.mul(max(bright.sub(BLOOM_THRESHOLD), 0).div(bright)), 1);

    this.lut = new Data3DTexture(new Uint16Array(LUT_LENGTH), LUT_SIZE, LUT_SIZE, LUT_SIZE);
    this.lut.type = HalfFloatType;
    // The table is read between its entries rather than at them, and half
    // floats are what keeps a night sky smooth: eight bits of linear light
    // band visibly once the frame is encoded for the display.
    this.lut.minFilter = LinearFilter;
    this.lut.magFilter = LinearFilter;
    // Mipmaps of a 3D texture are built through 2D views, which WebGPU refuses.
    // three.js 0.186 asks for them anyway, and every frame then fills the
    // console with errors. Nothing reads them: the cube is sampled at one size.
    this.lut.generateMipmaps = false;
    // The renderer allocates the texture and transfers nothing into it;
    // `lut-upload.ts` writes the cube itself, in one copy rather than the
    // sixteen slices three.js would write and some Dawn builds refuse.
    this.lut.source.dataReady = false;
    this.lut.needsUpdate = true;

    // A session starts at 08:00, as the scene does, so the first frame is graded.
    this.time = START_TICK;
    setRenderScale(this.renderer, this.settings.renderScale);
    this.select();
  }

  /**
   * Grade the frame as the light and the weather stand at a tick (spec sections
   * 10.5, 10.6, 13.4). The table is rebuilt a fixed number of times a day and
   * not otherwise, so the weather reaches the grade within six seconds of
   * changing rather than on the frame it changes.
   */
  set time(tick: number) {
    const step = gradeStep(tick);
    if (step === this.step) return;
    this.step = step;
    const light = daylightAt(tick);
    writeLut(gradeAt(light, this.fixedWeather ?? weatherAt(this.seed, tick)), this.graded);
    const texels = this.lut.image.data as Uint16Array;
    for (let i = 0; i < LUT_LENGTH; i++) texels[i] = DataUtils.toHalfFloat(this.graded[i] ?? 0);
    if (!this.gradable) return;
    if (uploadLut(this.renderer, this.lut)) return;
    // Drawn through a cube that never arrived, the frame is black. Say so once
    // and draw the rest of the chain without the grade.
    this.gradable = false;
    console.warn('PostChain: the colour grade could not be uploaded; the frame is drawn ungraded.');
    this.select();
  }

  /**
   * Forget the grade, so the next {@link PostChain.time} writes the table for
   * its own tick. A chain grades a step by the first tick it is shown, so one
   * kept across two pictures of the same step would grade the second as the first.
   */
  regrade(): void {
    this.step = -1;
  }

  /**
   * What the frame is drawn at (spec section 9.2). Setting it hands the render
   * scale to the renderer, and draws through the graph the effects ask for,
   * which is built the first time a tier asks for it and reused after that.
   */
  get quality(): PostQuality {
    return { ...this.settings };
  }

  set quality(quality: PostQuality) {
    const standing = graphKey(this.effective());
    this.settings = { ...quality };
    setRenderScale(this.renderer, quality.renderScale);
    // The render scale is handed to the renderer and nothing else. A tier that
    // moves only that keeps the graph it is drawn through, which is what makes
    // the cheapest tier change cost no compile at all.
    if (standing === graphKey(this.effective())) return;
    this.select();
  }

  /**
   * Wait for the tables SMAA is built on.
   *
   * `SMAANode` decodes two of them from data URLs, and an image given a source
   * that way arrives a turn of the event loop later however small it is. A
   * frame drawn before they land is antialiased against nothing, so anything
   * that wants its first frame to be its best waits here first.
   */
  async ready(): Promise<void> {
    for (const [, chain] of this.chains) {
      const node = chain.antialias;
      if (node === undefined) continue;
      for (const table of [node._areaTexture, node._searchTexture]) {
        const image = table.image as HTMLImageElement;
        if (!image.complete) await image.decode();
        table.needsUpdate = true;
      }
    }
  }

  /** Draw the frame. This replaces `renderer.render`, which draws no effects. */
  render(): void {
    this.pipeline.render();
    if (this.current !== undefined) this.current.drawn = true;
  }

  dispose(): void {
    for (const [, chain] of this.chains) {
      for (const effect of chain.effects) effect.dispose();
    }
    this.chains.clear();
    this.scenePass.dispose();
    this.pipeline.dispose();
    this.lut.dispose();
  }

  /**
   * Draw through the graph the settings ask for, building it if this is the
   * first tier to ask. The pipeline is handed a node it may have drawn before,
   * so the renderer answers out of its own caches and compiles nothing.
   */
  private select(): void {
    const key = graphKey(this.effective());
    let chain = this.chains.get(key);
    if (chain === undefined) {
      chain = this.build();
      this.chains.set(key, chain);
    }
    this.current = chain;
    this.pipeline.outputNode = chain.output;
    this.pipeline.needsUpdate = true;
    // Only the graph drawn needs its targets. Each graph holds its own at the
    // frame's size — nine half-float targets are 99 MB at 1600x900 — so the
    // others are shrunk to a pixel, which frees their textures. An effect sizes
    // its targets to the frame before it draws, so a graph taken up again gets
    // them back without a compile.
    //
    // A graph never drawn is skipped: its targets are still a pixel, and bloom
    // makes its blur materials on its first draw, so sizing it before throws.
    // A phone meets this, because it starts on a lower tier than the graph the
    // chain is built with.
    for (const [other, kept] of this.chains) {
      if (other === key || !kept.drawn) continue;
      for (const effect of kept.effects) effect.setSize(1, 1);
    }
  }

  /**
   * The effects actually drawn: what the settings ask for, less the grade where
   * the cube never reached the GPU.
   */
  private effective(): PostQuality {
    return { ...this.settings, grade: this.settings.grade && this.gradable };
  }

  /** Build one graph of the effects the settings stand at. */
  private build(): Chain {
    const settings = this.effective();
    const effects: TslNode[] = [];
    let antialias: TslNode | undefined;

    let colour = this.colour;
    if (settings.bloom) {
      const glow = bloom(this.glare, BLOOM_STRENGTH, BLOOM_RADIUS, 0);
      effects.push(glow);
      colour = vec4(colour.rgb.add(glow.rgb), 1);
    }
    // The exposure is already in the frame, so the mapping is asked for none.
    colour = toneMapping(this.renderer.toneMapping, 1, colour);
    if (settings.grade) colour = this.lookUp(colour);
    if (settings.smaa) {
      const edges = smaa(colour);
      effects.push(edges);
      antialias = edges;
      colour = edges;
    }

    // The tone mapping above is the frame's; this is the encode the display
    // asks for, and nothing else.
    return { output: renderOutput(colour, NoToneMapping), effects, antialias, drawn: false };
  }

  /**
   * Look every colour of the frame up in the grade's cube.
   *
   * `Lut3DNode` does the reading. The sampler interpolates all three axes at
   * once, so the grade is one texture fetch a pixel. The node insets the
   * reading by half a texel, so a colour at the edge of the cube reads the
   * entry there rather than half of it and half of nothing.
   *
   * The frame is light and the cube is display values, so the colour is encoded
   * on the way in and the answer decoded on the way out. The clamp is what
   * keeps a colour brighter than white from reading off the end of the cube.
   */
  private lookUp(colour: TslNode): TslNode {
    const encoded = vec4(colour.rgb.clamp(0, 1).pow(1 / LUT_GAMMA), colour.a);
    const graded = lut3D(encoded, texture3D(this.lut), LUT_SIZE, 1);
    return vec4(graded.rgb.pow(LUT_GAMMA), colour.a);
  }
}

/**
 * What a graph is built from: the effects, and not the size the frame is drawn
 * at. Two tiers that draw the same effects share one chain.
 */
function graphKey(quality: PostQuality): string {
  return `${quality.bloom ? 'b' : '-'}${quality.grade ? 'g' : '-'}${quality.smaa ? 's' : '-'}`;
}

/**
 * The distinct graphs a list of quality settings asks for, in the order they
 * first appear. The four tiers of `quality.ts` come to three graphs, so warming
 * the chain behind the loading screen is three frames rather than four.
 */
export function postGraphs(qualities: readonly PostQuality[]): readonly PostQuality[] {
  const seen = new Set<string>();
  const graphs: PostQuality[] = [];
  for (const quality of qualities) {
    const key = graphKey(quality);
    if (seen.has(key)) continue;
    seen.add(key);
    graphs.push({ ...quality });
  }
  return graphs;
}
