// The node catalogue: every operation a user-authored script may perform.
//
// This table is the contract shared by four consumers, and it is the reason
// they cannot drift apart:
//   - the VM        executes one `op` per descriptor (vm.ts)
//   - the validator type-checks a graph against these signatures (validate.ts)
//   - the LLM       is handed these docs as a JSON Schema (schema.ts)
//   - the editor    draws sockets from these names and types
//
// Adding a capability means adding a descriptor here and an implementation in
// the VM — nothing else needs to know. `doc` strings are not decoration: they
// are the entire specification the LLM sees, so write each one as a complete
// sentence about what the node does, not what it is called.
//
// Naming: `namespace/verb`, borrowing glTF KHR_interactivity's convention so
// the core arithmetic/flow vocabulary lines up with the standard, with a
// `world/`, `player/`, `ui/`, `chat/` layer on top for things specific to a
// shared 3D room.

import type { NodeDesc } from './ir'
import { SELF_TARGET } from './ir'

/** cfg shared by every op that acts on an object: which object it acts on. */
const TARGET_CFG = {
  name: 'target',
  type: 'string',
  doc: `Id of the object to act on, or "${SELF_TARGET}" for the object this script is attached to.`,
  def: SELF_TARGET,
} as const

const VEC3_ZERO = { x: 0, y: 0, z: 0 }

export const NODE_DESCS: readonly NodeDesc[] = [
  // --- events --------------------------------------------------------------
  {
    op: 'event/onStart',
    kind: 'event',
    doc: 'Runs once when the script starts, which is when its object is placed or when the room is joined.',
    next: ['out'],
  },
  {
    op: 'event/onTick',
    kind: 'event',
    doc: 'Runs every frame. Use it for continuous motion; prefer a trigger or interaction event for anything that happens once.',
    next: ['out'],
    out: [{ name: 'dt', type: 'number', doc: 'Seconds elapsed since the previous frame.' }],
  },
  {
    op: 'event/onTriggerEnter',
    kind: 'event',
    doc: "Runs when a player walks into this object's trigger volume. Does nothing if the object has no trigger volume.",
    next: ['out'],
    out: [{ name: 'player', type: 'string', doc: 'Display name of the player who entered.' }],
  },
  {
    op: 'event/onTriggerExit',
    kind: 'event',
    doc: "Runs when a player leaves this object's trigger volume.",
    next: ['out'],
    out: [{ name: 'player', type: 'string', doc: 'Display name of the player who left.' }],
  },
  {
    op: 'event/onInteract',
    kind: 'event',
    doc: 'Runs when a player clicks this object.',
    next: ['out'],
    out: [{ name: 'player', type: 'string', doc: 'Display name of the player who clicked.' }],
  },
  {
    op: 'event/onUiEvent',
    kind: 'event',
    doc: 'Runs when a button inside one of this script\'s windows is pressed. Matches the button\'s "event" name.',
    next: ['out'],
    cfg: [{ name: 'event', type: 'string', doc: 'Button event name to listen for.' }],
    out: [{ name: 'player', type: 'string', doc: 'Display name of the player who pressed the button.' }],
  },
  {
    op: 'event/onCustom',
    kind: 'event',
    doc: 'Runs when any script in the room emits a custom event with this name.',
    next: ['out'],
    cfg: [{ name: 'event', type: 'string', doc: 'Custom event name to listen for.' }],
    out: [{ name: 'payload', type: 'string', doc: 'Text the emitting script attached to the event.' }],
  },

  // --- flow control --------------------------------------------------------
  {
    op: 'flow/branch',
    kind: 'flow',
    doc: 'Continues along "true" or "false" depending on the condition. Point one branch back at an earlier node to make a loop.',
    in: [{ name: 'cond', type: 'bool', doc: 'Which branch to take.' }],
    next: ['true', 'false'],
  },
  {
    op: 'flow/setVar',
    kind: 'flow',
    doc: 'Stores a value in a variable, then continues. Variables keep their value between frames.',
    in: [{ name: 'value', type: 'number', doc: 'Value to store. Must match the variable\'s declared type.' }],
    cfg: [{ name: 'var', type: 'string', doc: 'Name of a variable declared in the graph.' }],
    next: ['out'],
  },
  {
    op: 'flow/delay',
    kind: 'flow',
    doc: 'Waits the given number of seconds, then continues. The rest of the script keeps running meanwhile.',
    in: [{ name: 'seconds', type: 'number', doc: 'How long to wait. Clamped to a sane maximum.', def: 1 }],
    next: ['out'],
  },
  {
    op: 'flow/stop',
    kind: 'flow',
    doc: 'Ends this flow. Equivalent to leaving a flow output unconnected, but explicit.',
  },

  // --- world: reading ------------------------------------------------------
  {
    op: 'world/getPosition',
    kind: 'value',
    doc: 'The current world position of an object.',
    cfg: [TARGET_CFG],
    out: [{ name: 'pos', type: 'vec3', doc: 'World position. Zero if the object is gone.' }],
  },
  {
    op: 'world/getRotationY',
    kind: 'value',
    doc: 'The current heading of an object, in radians around the vertical axis.',
    cfg: [TARGET_CFG],
    out: [{ name: 'angle', type: 'number', doc: 'Heading in radians.' }],
  },
  {
    op: 'world/getScale',
    kind: 'value',
    doc: 'The current uniform scale of an object.',
    cfg: [TARGET_CFG],
    out: [{ name: 'scale', type: 'number', doc: 'Uniform scale factor.' }],
  },

  // --- world: writing ------------------------------------------------------
  {
    op: 'world/setPosition',
    kind: 'flow',
    doc: 'Moves an object to a world position.',
    cap: 'transform',
    in: [{ name: 'pos', type: 'vec3', doc: 'Target world position.', def: VEC3_ZERO }],
    cfg: [TARGET_CFG],
    next: ['out'],
  },
  {
    op: 'world/translate',
    kind: 'flow',
    doc: 'Moves an object by an offset from where it is now.',
    cap: 'transform',
    in: [{ name: 'delta', type: 'vec3', doc: 'Offset to add to the current position.', def: VEC3_ZERO }],
    cfg: [TARGET_CFG],
    next: ['out'],
  },
  {
    op: 'world/setRotationY',
    kind: 'flow',
    doc: 'Turns an object to face a heading, in radians around the vertical axis.',
    cap: 'transform',
    in: [{ name: 'angle', type: 'number', doc: 'Heading in radians.', def: 0 }],
    cfg: [TARGET_CFG],
    next: ['out'],
  },
  {
    op: 'world/setScale',
    kind: 'flow',
    doc: 'Resizes an object. The scale is uniform on all three axes.',
    cap: 'transform',
    in: [{ name: 'scale', type: 'number', doc: 'Uniform scale factor.', def: 1 }],
    cfg: [TARGET_CFG],
    next: ['out'],
  },
  {
    op: 'world/setVisible',
    kind: 'flow',
    doc: 'Shows or hides an object without removing it.',
    cap: 'transform',
    in: [{ name: 'visible', type: 'bool', doc: 'True to show, false to hide.', def: true }],
    cfg: [TARGET_CFG],
    next: ['out'],
  },

  // --- player --------------------------------------------------------------
  {
    op: 'player/position',
    kind: 'value',
    doc: "The local player's current world position.",
    out: [{ name: 'pos', type: 'vec3', doc: 'World position of the player.' }],
  },
  {
    op: 'player/name',
    kind: 'value',
    doc: "The local player's display name.",
    out: [{ name: 'name', type: 'string', doc: 'Display name.' }],
  },
  {
    op: 'player/distance',
    kind: 'value',
    doc: 'Distance in metres from the local player to an object.',
    cfg: [TARGET_CFG],
    out: [{ name: 'distance', type: 'number', doc: 'Distance in metres.' }],
  },

  // --- windows -------------------------------------------------------------
  {
    op: 'ui/showWindow',
    kind: 'flow',
    doc: 'Displays a window using one of the graph\'s named layouts. Showing the same window id again replaces its contents.',
    cap: 'ui',
    in: [{ name: 'text', type: 'string', doc: 'Substituted wherever the layout contains {{text}}.', def: '' }],
    cfg: [
      { name: 'window', type: 'string', doc: 'Id for this window, so it can be updated or hidden later.', def: 'main' },
      { name: 'template', type: 'string', doc: 'Name of a layout in the graph\'s ui table.' },
      {
        name: 'anchor',
        type: 'string',
        doc: 'Where to draw it: "object" follows the target object in 3D, "screen" pins it to the viewport.',
        def: 'object',
        choices: ['object', 'screen'],
      },
      {
        name: 'oy',
        type: 'number',
        doc: 'With anchor "object": how far above the object to float the window, in metres.',
        def: 0,
      },
      {
        name: 'ax',
        type: 'number',
        doc: 'With anchor "screen": horizontal position, 0 at the left edge, 1 at the right.',
        def: 0.5,
      },
      {
        name: 'ay',
        type: 'number',
        doc: 'With anchor "screen": vertical position, 0 at the top edge, 1 at the bottom.',
        def: 0.5,
      },
      TARGET_CFG,
    ],
    next: ['out'],
  },
  {
    op: 'ui/hideWindow',
    kind: 'flow',
    doc: 'Closes a window this script opened.',
    cap: 'ui',
    cfg: [{ name: 'window', type: 'string', doc: 'Id given to ui/showWindow.', def: 'main' }],
    next: ['out'],
  },

  // --- sound, chat, custom events -----------------------------------------
  {
    op: 'audio/play',
    kind: 'flow',
    doc: 'Plays an audio asset positioned at an object.',
    cap: 'audio',
    cfg: [{ name: 'cid', type: 'string', doc: 'Content id of the audio in the shared store.' }, TARGET_CFG],
    next: ['out'],
  },
  {
    op: 'chat/say',
    kind: 'flow',
    doc: 'Posts a chat line attributed to this object. Rate limited.',
    cap: 'chat',
    in: [{ name: 'text', type: 'string', doc: 'What to say.', def: '' }],
    next: ['out'],
  },
  {
    op: 'event/emit',
    kind: 'flow',
    doc: 'Fires a custom event that every script in the room can react to with event/onCustom.',
    cap: 'event',
    in: [{ name: 'payload', type: 'string', doc: 'Text to attach to the event.', def: '' }],
    cfg: [{ name: 'event', type: 'string', doc: 'Name of the event to fire.' }],
    next: ['out'],
  },
  {
    op: 'debug/log',
    kind: 'flow',
    doc: "Writes a line to the script editor's console. Has no effect in the world.",
    in: [{ name: 'text', type: 'string', doc: 'Text to log.', def: '' }],
    next: ['out'],
  },

  // --- arithmetic ----------------------------------------------------------
  {
    op: 'math/add',
    kind: 'value',
    doc: 'Adds two numbers.',
    in: [
      { name: 'a', type: 'number', doc: 'First number.', def: 0 },
      { name: 'b', type: 'number', doc: 'Second number.', def: 0 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'a + b' }],
  },
  {
    op: 'math/sub',
    kind: 'value',
    doc: 'Subtracts the second number from the first.',
    in: [
      { name: 'a', type: 'number', doc: 'Number to subtract from.', def: 0 },
      { name: 'b', type: 'number', doc: 'Number to subtract.', def: 0 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'a - b' }],
  },
  {
    op: 'math/mul',
    kind: 'value',
    doc: 'Multiplies two numbers.',
    in: [
      { name: 'a', type: 'number', doc: 'First number.', def: 0 },
      { name: 'b', type: 'number', doc: 'Second number.', def: 0 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'a * b' }],
  },
  {
    op: 'math/div',
    kind: 'value',
    doc: 'Divides the first number by the second. Dividing by zero gives zero rather than infinity.',
    in: [
      { name: 'a', type: 'number', doc: 'Dividend.', def: 0 },
      { name: 'b', type: 'number', doc: 'Divisor.', def: 1 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'a / b, or 0 when b is 0.' }],
  },
  {
    op: 'math/mod',
    kind: 'value',
    doc: 'Remainder of dividing the first number by the second. Useful for wrapping values around.',
    in: [
      { name: 'a', type: 'number', doc: 'Dividend.', def: 0 },
      { name: 'b', type: 'number', doc: 'Divisor.', def: 1 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'a mod b, or 0 when b is 0.' }],
  },
  {
    op: 'math/min',
    kind: 'value',
    doc: 'The smaller of two numbers.',
    in: [
      { name: 'a', type: 'number', doc: 'First number.', def: 0 },
      { name: 'b', type: 'number', doc: 'Second number.', def: 0 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'The smaller value.' }],
  },
  {
    op: 'math/max',
    kind: 'value',
    doc: 'The larger of two numbers.',
    in: [
      { name: 'a', type: 'number', doc: 'First number.', def: 0 },
      { name: 'b', type: 'number', doc: 'Second number.', def: 0 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'The larger value.' }],
  },
  {
    op: 'math/clamp',
    kind: 'value',
    doc: 'Restricts a number to a range.',
    in: [
      { name: 'value', type: 'number', doc: 'Number to restrict.', def: 0 },
      { name: 'min', type: 'number', doc: 'Lower bound.', def: 0 },
      { name: 'max', type: 'number', doc: 'Upper bound.', def: 1 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'The clamped value.' }],
  },
  {
    op: 'math/abs',
    kind: 'value',
    doc: 'Absolute value of a number.',
    in: [{ name: 'a', type: 'number', doc: 'Number.', def: 0 }],
    out: [{ name: 'out', type: 'number', doc: 'The value without its sign.' }],
  },
  {
    op: 'math/floor',
    kind: 'value',
    doc: 'Rounds a number down to a whole number.',
    in: [{ name: 'a', type: 'number', doc: 'Number.', def: 0 }],
    out: [{ name: 'out', type: 'number', doc: 'The largest whole number not above a.' }],
  },
  {
    op: 'math/sqrt',
    kind: 'value',
    doc: 'Square root of a number. Negative input gives zero.',
    in: [{ name: 'a', type: 'number', doc: 'Number.', def: 0 }],
    out: [{ name: 'out', type: 'number', doc: 'The square root.' }],
  },
  {
    op: 'math/pow',
    kind: 'value',
    doc: 'Raises the first number to the power of the second.',
    in: [
      { name: 'a', type: 'number', doc: 'Base.', def: 0 },
      { name: 'b', type: 'number', doc: 'Exponent.', def: 1 },
    ],
    out: [{ name: 'out', type: 'number', doc: 'a to the power of b.' }],
  },
  {
    op: 'math/sin',
    kind: 'value',
    doc: 'Sine of an angle in radians. Combine with time/now for smooth back-and-forth motion.',
    in: [{ name: 'a', type: 'number', doc: 'Angle in radians.', def: 0 }],
    out: [{ name: 'out', type: 'number', doc: 'Sine, between -1 and 1.' }],
  },
  {
    op: 'math/cos',
    kind: 'value',
    doc: 'Cosine of an angle in radians.',
    in: [{ name: 'a', type: 'number', doc: 'Angle in radians.', def: 0 }],
    out: [{ name: 'out', type: 'number', doc: 'Cosine, between -1 and 1.' }],
  },
  {
    op: 'math/random',
    kind: 'value',
    doc: 'A random number from 0 up to but not including 1. Re-rolled every time it is read.',
    out: [{ name: 'out', type: 'number', doc: 'Random value in [0,1).' }],
  },

  // --- comparison and logic ------------------------------------------------
  {
    op: 'compare/eq',
    kind: 'value',
    doc: 'True when two numbers are equal.',
    in: [
      { name: 'a', type: 'number', doc: 'First number.', def: 0 },
      { name: 'b', type: 'number', doc: 'Second number.', def: 0 },
    ],
    out: [{ name: 'out', type: 'bool', doc: 'a equals b' }],
  },
  {
    op: 'compare/lt',
    kind: 'value',
    doc: 'True when the first number is less than the second.',
    in: [
      { name: 'a', type: 'number', doc: 'First number.', def: 0 },
      { name: 'b', type: 'number', doc: 'Second number.', def: 0 },
    ],
    out: [{ name: 'out', type: 'bool', doc: 'a < b' }],
  },
  {
    op: 'compare/gt',
    kind: 'value',
    doc: 'True when the first number is greater than the second.',
    in: [
      { name: 'a', type: 'number', doc: 'First number.', def: 0 },
      { name: 'b', type: 'number', doc: 'Second number.', def: 0 },
    ],
    out: [{ name: 'out', type: 'bool', doc: 'a > b' }],
  },
  {
    op: 'compare/strEq',
    kind: 'value',
    doc: 'True when two pieces of text are exactly the same.',
    in: [
      { name: 'a', type: 'string', doc: 'First text.', def: '' },
      { name: 'b', type: 'string', doc: 'Second text.', def: '' },
    ],
    out: [{ name: 'out', type: 'bool', doc: 'a equals b' }],
  },
  {
    op: 'logic/and',
    kind: 'value',
    doc: 'True when both conditions are true.',
    in: [
      { name: 'a', type: 'bool', doc: 'First condition.', def: false },
      { name: 'b', type: 'bool', doc: 'Second condition.', def: false },
    ],
    out: [{ name: 'out', type: 'bool', doc: 'a and b' }],
  },
  {
    op: 'logic/or',
    kind: 'value',
    doc: 'True when at least one condition is true.',
    in: [
      { name: 'a', type: 'bool', doc: 'First condition.', def: false },
      { name: 'b', type: 'bool', doc: 'Second condition.', def: false },
    ],
    out: [{ name: 'out', type: 'bool', doc: 'a or b' }],
  },
  {
    op: 'logic/not',
    kind: 'value',
    doc: 'Inverts a condition.',
    in: [{ name: 'a', type: 'bool', doc: 'Condition.', def: false }],
    out: [{ name: 'out', type: 'bool', doc: 'not a' }],
  },

  // --- text ----------------------------------------------------------------
  {
    op: 'string/concat',
    kind: 'value',
    doc: 'Joins two pieces of text together.',
    in: [
      { name: 'a', type: 'string', doc: 'First text.', def: '' },
      { name: 'b', type: 'string', doc: 'Second text.', def: '' },
    ],
    out: [{ name: 'out', type: 'string', doc: 'a followed by b.' }],
  },
  {
    op: 'string/fromNumber',
    kind: 'value',
    doc: 'Turns a number into text, rounded to the given number of decimal places.',
    in: [
      { name: 'value', type: 'number', doc: 'Number to convert.', def: 0 },
      { name: 'digits', type: 'number', doc: 'Decimal places to keep.', def: 0 },
    ],
    out: [{ name: 'out', type: 'string', doc: 'The number as text.' }],
  },

  // --- vectors -------------------------------------------------------------
  {
    op: 'vec3/make',
    kind: 'value',
    doc: 'Builds a position or direction from three numbers. Y is up.',
    in: [
      { name: 'x', type: 'number', doc: 'East-west component.', def: 0 },
      { name: 'y', type: 'number', doc: 'Vertical component.', def: 0 },
      { name: 'z', type: 'number', doc: 'North-south component.', def: 0 },
    ],
    out: [{ name: 'out', type: 'vec3', doc: 'The assembled vector.' }],
  },
  {
    op: 'vec3/split',
    kind: 'value',
    doc: 'Takes a position or direction apart into its three numbers.',
    in: [{ name: 'v', type: 'vec3', doc: 'Vector to split.', def: VEC3_ZERO }],
    out: [
      { name: 'x', type: 'number', doc: 'East-west component.' },
      { name: 'y', type: 'number', doc: 'Vertical component.' },
      { name: 'z', type: 'number', doc: 'North-south component.' },
    ],
  },
  {
    op: 'vec3/add',
    kind: 'value',
    doc: 'Adds two vectors component by component.',
    in: [
      { name: 'a', type: 'vec3', doc: 'First vector.', def: VEC3_ZERO },
      { name: 'b', type: 'vec3', doc: 'Second vector.', def: VEC3_ZERO },
    ],
    out: [{ name: 'out', type: 'vec3', doc: 'a + b' }],
  },
  {
    op: 'vec3/sub',
    kind: 'value',
    doc: 'Subtracts the second vector from the first. Use it to get the direction from one point to another.',
    in: [
      { name: 'a', type: 'vec3', doc: 'Vector to subtract from.', def: VEC3_ZERO },
      { name: 'b', type: 'vec3', doc: 'Vector to subtract.', def: VEC3_ZERO },
    ],
    out: [{ name: 'out', type: 'vec3', doc: 'a - b' }],
  },
  {
    op: 'vec3/scale',
    kind: 'value',
    doc: 'Multiplies a vector by a number, making it longer or shorter.',
    in: [
      { name: 'v', type: 'vec3', doc: 'Vector to scale.', def: VEC3_ZERO },
      { name: 'k', type: 'number', doc: 'Factor to multiply by.', def: 1 },
    ],
    out: [{ name: 'out', type: 'vec3', doc: 'The scaled vector.' }],
  },
  {
    op: 'vec3/length',
    kind: 'value',
    doc: 'How long a vector is.',
    in: [{ name: 'v', type: 'vec3', doc: 'Vector to measure.', def: VEC3_ZERO }],
    out: [{ name: 'out', type: 'number', doc: 'The length.' }],
  },
  {
    op: 'vec3/distance',
    kind: 'value',
    doc: 'Distance between two points.',
    in: [
      { name: 'a', type: 'vec3', doc: 'First point.', def: VEC3_ZERO },
      { name: 'b', type: 'vec3', doc: 'Second point.', def: VEC3_ZERO },
    ],
    out: [{ name: 'out', type: 'number', doc: 'Distance between a and b.' }],
  },
  {
    op: 'vec3/normalize',
    kind: 'value',
    doc: 'Shortens or lengthens a vector to exactly length 1, keeping its direction. A zero vector stays zero.',
    in: [{ name: 'v', type: 'vec3', doc: 'Vector to normalize.', def: VEC3_ZERO }],
    out: [{ name: 'out', type: 'vec3', doc: 'The unit-length direction.' }],
  },

  // --- time ----------------------------------------------------------------
  {
    op: 'time/now',
    kind: 'value',
    doc: 'Seconds since this script started running.',
    out: [{ name: 'out', type: 'number', doc: 'Elapsed seconds.' }],
  },
]

/** Descriptor lookup by op name. */
export const NODE_CATALOG: ReadonlyMap<string, NodeDesc> = new Map(
  NODE_DESCS.map((desc) => [desc.op, desc]),
)

/** Every op name, in catalogue order. */
export const OP_NAMES: readonly string[] = NODE_DESCS.map((desc) => desc.op)

export function nodeDesc(op: string): NodeDesc | undefined {
  return NODE_CATALOG.get(op)
}
