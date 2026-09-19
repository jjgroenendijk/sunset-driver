# Camera

The gotchas of the game camera: the top-down view, the moves it makes when a building stands in
the way, and the two chase views. `spec.md` section 10.7 is the design. The developer free camera is
in `docs/dev-tooling.md`.

## Contents

- The views
- Buildings in the way
- Walking in a turned view

## The views

- `FollowCamera` (`src/render/camera.ts`) is the one camera the game is played through. It takes
  the view and the building moves as one `CameraLook` each frame. `camera-view.ts` holds the chase
  views and the turn; `camera.ts` re-exports its types.
- A change of view snaps the camera rather than sliding it across the city. It also swaps the near
  plane: 1 m top down, 0.1 m in a chase view, since first person stands a hand's width from the
  head. The sun's cascades are cut to the camera's frustum, so `frame.ts` refits them then.
- First person stands the eyes a little ahead of the middle of the head. At the middle, the inside
  of the head fills the view. At the wheel it stands them over the bonnet, or the bonnet fills half
  the frame.
- `node scripts/render-preview.ts <seed> out.png --view=third-person` draws a chase view, and
  `--on-foot` follows the character instead of the car.

## Buildings in the way

- The Buildings setting picks See-through, Pull back, Turn or Off. The cut of `cutaway.ts` stays on
  under Pull back and Turn, for what the move does not clear.
- The turn tests the sight line to the player every metre against the roof boxes of `roofs.ts`. A
  coarser step lets a building corner fall between two points.
- A player inside a footprint, or deep in an alley between towers, has no clear heading at all.
  The camera then keeps its heading and the cut does the work. A preview at such a spot shows no
  turn, which is correct: pick a place on a street beside one tall building to see it.

## Walking in a turned view

- `walk` (`src/sim/walker-body.ts`) moves the player in the map's own axes. `Keyboard.sample` turns
  the two walking axes by `Keyboard.turn`, the camera's heading, which `frame.ts` writes each frame
  while the player is on foot. `W` then walks up the screen in every view. A car ignores it, since
  its keys already steer.
- The turn happens in the input frame, before the record. A replay or a peer therefore reads the
  turned axes and needs no camera.
- In a chase view the camera turns after the player, and the player turns to face the way they
  walk. Holding `A` therefore walks a circle. That is how the view steers on foot.
