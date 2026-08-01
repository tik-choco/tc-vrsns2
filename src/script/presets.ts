// Ready-made behaviours a user can attach to a placed object without touching
// a node graph directly. Each preset is a complete, self-contained ScriptGraph
// (plus a TriggerVolume when the behaviour needs one) built from the node
// catalogue in nodes.ts — nothing here is special-cased by the VM or the
// validator, so a preset is exactly as trustworthy as any other graph and
// MUST pass validate() with zero errors (see presets.test.ts, which is the
// actual contract: a preset that fails validate() must fail CI, because a
// broken preset silently doing nothing in someone's world is the worst
// failure mode this feature has).
//
// This file stays in src/script/ (a base layer other layers depend on, per
// ir.ts's header) and deliberately does NOT import from src/i18n or src/ui:
// `nameKey`/`descKey` are plain strings that happen to be valid i18n keys
// (see src/i18n/locales/en.ts's `presets.*` entries) — the UI layer is the
// one that knows what a TranslationKey is, so it does the cast at the call
// site instead of this file importing the UI's types.
import type { ScriptGraph, TriggerVolume } from './ir'

export type ScriptPresetId = 'rotate' | 'bob' | 'greeter' | 'toggle'

export type ScriptPreset = {
  id: ScriptPresetId
  /** i18n key for the preset's display name. */
  nameKey: string
  /** i18n key for its one-line description. */
  descKey: string
  graph: ScriptGraph
  /** Trigger volume the preset needs attached alongside the graph, if any. */
  trigger?: TriggerVolume
}

/**
 * Slowly rotates the object in place, forever. `angle = time * speed` rather
 * than accumulating a delta each tick, so the heading is a pure function of
 * elapsed time — no drift, and trivially resumable after a script restart.
 */
const rotatePreset: ScriptPreset = {
  id: 'rotate',
  nameKey: 'presets.rotate.name',
  descKey: 'presets.rotate.desc',
  graph: {
    v: 1,
    name: 'rotate',
    nodes: [
      // 0: every frame...
      { op: 'event/onTick', next: { out: 1 } },
      // 1: ...face the heading computed below.
      { op: 'world/setRotationY', in: { angle: { k: 'out', n: 2, s: 'out' } } },
      // 2: heading = elapsed seconds * angular speed (rad/s).
      { op: 'math/mul', in: { a: { k: 'out', n: 3, s: 'out' }, b: { k: 'lit', v: 0.6 } } },
      // 3: elapsed seconds.
      { op: 'time/now' },
    ],
    vars: [],
  },
}

/**
 * Bobs gently up and down around wherever the object was placed. The base
 * position is captured once on start into a persistent vec3 var (rather than
 * re-read from world/getPosition every tick, which would compound: once the
 * object's Y already carries last frame's offset, reading it back as the new
 * "base" would let the offset drift outward frame over frame). Every tick
 * then recomputes an absolute position from that fixed base plus a sine wave,
 * which is stable no matter how long the script runs.
 */
const bobPreset: ScriptPreset = {
  id: 'bob',
  nameKey: 'presets.bob.name',
  descKey: 'presets.bob.desc',
  graph: {
    v: 1,
    name: 'bob',
    nodes: [
      // 0: once, when placed...
      { op: 'event/onStart', next: { out: 1 } },
      // 1: ...remember the starting position.
      { op: 'flow/setVar', cfg: { var: 'basePos' }, in: { value: { k: 'out', n: 2, s: 'pos' } } },
      // 2: the object's position at the moment it started.
      { op: 'world/getPosition' },

      // 3: every frame...
      { op: 'event/onTick', next: { out: 4 } },
      // 4: ...move to base position with Y offset by the wave below.
      { op: 'world/setPosition', in: { pos: { k: 'out', n: 5, s: 'out' } } },
      // 5: (base.x, base.y + wave, base.z).
      {
        op: 'vec3/make',
        in: {
          x: { k: 'out', n: 6, s: 'x' },
          y: { k: 'out', n: 7, s: 'out' },
          z: { k: 'out', n: 6, s: 'z' },
        },
      },
      // 6: the remembered base position, split into components.
      { op: 'vec3/split', in: { v: { k: 'var', name: 'basePos' } } },
      // 7: base.y + wave amplitude.
      { op: 'math/add', in: { a: { k: 'out', n: 6, s: 'y' }, b: { k: 'out', n: 8, s: 'out' } } },
      // 8: wave = sin(t) * amplitude (metres).
      { op: 'math/mul', in: { a: { k: 'out', n: 9, s: 'out' }, b: { k: 'lit', v: 0.3 } } },
      // 9: sin of elapsed seconds — one full bob roughly every 6 seconds.
      { op: 'math/sin', in: { a: { k: 'out', n: 10, s: 'out' } } },
      // 10: elapsed seconds.
      { op: 'time/now' },
    ],
    vars: [{ name: 'basePos', type: 'vec3', init: { x: 0, y: 0, z: 0 } }],
  },
}

/**
 * Shows a styled window while a player is inside the object's trigger sphere,
 * hides it when they leave. The entering player's name flows straight from
 * event/onTriggerEnter's payload output into ui/showWindow's `text` input,
 * which the template below picks up via the {{text}} token — no var needed
 * to carry it. The `ui` template is deliberately styled (background, border,
 * radius, padding) rather than left plain, so this preset also demonstrates
 * that CSS-like styling works end to end.
 */
const greeterPreset: ScriptPreset = {
  id: 'greeter',
  nameKey: 'presets.greeter.name',
  descKey: 'presets.greeter.desc',
  graph: {
    v: 1,
    name: 'greeter',
    nodes: [
      // 0: a player walks into range...
      { op: 'event/onTriggerEnter', next: { out: 1 } },
      // 1: ...show the greeting, addressed to them by name.
      {
        op: 'ui/showWindow',
        cfg: { window: 'greet', template: 'greet', oy: 2.2 },
        in: { text: { k: 'out', n: 0, s: 'player' } },
      },
      // 2: a player leaves...
      { op: 'event/onTriggerExit', next: { out: 3 } },
      // 3: ...take the greeting down.
      { op: 'ui/hideWindow', cfg: { window: 'greet' } },
    ],
    vars: [],
    ui: {
      greet: {
        t: 'stack',
        dir: 'col',
        style: {
          background: '#1b1f2bee',
          color: '#f5f5f5',
          padding: '10px 16px',
          border: '1px solid #4b5563',
          'border-radius': '10px',
          'font-family': 'sans-serif',
        },
        children: [
          {
            t: 'text',
            text: 'Welcome, {{text}}!',
            style: { 'font-size': '15px', 'font-weight': '600' },
          },
        ],
      },
    },
  },
  trigger: { shape: 'sphere', r: 2.5 },
}

/**
 * Toggles between normal and enlarged scale each time the object is clicked.
 * The `big` var is both the memory of which state we're in and the branch
 * condition — flow/branch reads it to pick which world/setScale to run, then
 * flow/setVar flips it via logic/not for next time.
 */
const togglePreset: ScriptPreset = {
  id: 'toggle',
  nameKey: 'presets.toggle.name',
  descKey: 'presets.toggle.desc',
  graph: {
    v: 1,
    name: 'toggle',
    nodes: [
      // 0: clicked...
      { op: 'event/onInteract', next: { out: 1 } },
      // 1: ...currently big? shrink : grow.
      { op: 'flow/branch', in: { cond: { k: 'var', name: 'big' } }, next: { true: 2, false: 3 } },
      // 2: shrink back to normal size, then flip the flag.
      { op: 'world/setScale', in: { scale: { k: 'lit', v: 1 } }, next: { out: 4 } },
      // 3: grow, then flip the flag.
      { op: 'world/setScale', in: { scale: { k: 'lit', v: 1.6 } }, next: { out: 4 } },
      // 4: remember the new state for next click.
      { op: 'flow/setVar', cfg: { var: 'big' }, in: { value: { k: 'out', n: 5, s: 'out' } } },
      // 5: not(big) — the state we're switching to.
      { op: 'logic/not', in: { a: { k: 'var', name: 'big' } } },
    ],
    vars: [{ name: 'big', type: 'bool', init: false }],
  },
}

/** Every built-in preset, in the order offered to the user. */
export const SCRIPT_PRESETS: readonly ScriptPreset[] = [
  rotatePreset,
  bobPreset,
  greeterPreset,
  togglePreset,
]

/** Preset lookup by id. */
export const SCRIPT_PRESET_MAP: ReadonlyMap<ScriptPresetId, ScriptPreset> = new Map(
  SCRIPT_PRESETS.map((p) => [p.id, p]),
)

export function scriptPreset(id: ScriptPresetId): ScriptPreset | undefined {
  return SCRIPT_PRESET_MAP.get(id)
}

/**
 * The preset id a placement is currently running, if its script is exactly
 * one of the built-ins. Presets stamp their id into ScriptGraph.name (an
 * otherwise-free-text label field) purely so the attach UI can show which
 * preset — if any — is currently selected; nothing in validate.ts or vm.ts
 * gives that field any meaning.
 */
export function presetIdOf(graphName: string | undefined): ScriptPresetId | null {
  if (!graphName) return null
  return SCRIPT_PRESET_MAP.has(graphName as ScriptPresetId) ? (graphName as ScriptPresetId) : null
}
