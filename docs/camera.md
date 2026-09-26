# Camera

The gotchas of the game camera: the top-down view, the moves it makes when a building stands in
the way, and the two chase views. `spec.md` section 10.7 is the design. The developer free camera is
in `docs/dev-tooling.md`.

## Contents

- The views
- First person as a shooter
- Buildings in the way
- Walking in a turned view
- Mouse look

## The views

- `FollowCamera` (`src/render/camera/camera.ts`) is the one camera the game is played through. It
  takes the view and the building moves as one `CameraLook` each frame. `camera-view.ts` holds the
  chase views and the turn; `camera.ts` re-exports its types.
- A change of view snaps the camera rather than sliding it across the city. It also swaps the near
  plane: 1 m top down, 0.1 m in a chase view, since first person stands a hand's width from the
  head. The sun's cascades are cut to the camera's frustum, so `frame.ts` refits them then.
- First person stands the eyes a little ahead of the middle of the head. At the middle, the inside
  of the head fills the view. At the wheel it stands them over the bonnet, or the bonnet fills half
  the frame.
- Inside a shop the view is first person whatever the setting (`Frame.follow`), and back to the
  setting at the door. `docs/shops.md` has the room it looks at.
- `node scripts/render-preview.ts <seed> out.png --view=third-person` draws a chase view, and
  `--on-foot` follows the character instead of the car.

## First person as a shooter

- First person on foot draws no body. The model stands behind the eyes, and its weapon hangs below
  the frame. `Frame.firstPerson` hides both after `walkPlayer` and draws `ViewModel`
  (`src/render/weapons/viewmodel.ts`) instead: the weapon and two forearms, placed in the camera's
  frame after the camera moves. It is render state only.
- A pistol is drawn `SHORT_SCALE` larger than life, and held in one hand until it is aimed. At its
  real size the hand over it hides it.
- First person on foot looks level (`FIRST_PITCH_ON_FOOT`), with a wider field of view,
  `FIRST_FOV`. Aiming zooms by `zoomOf`: a little for a pistol, most for a scope. At the wheel
  first person keeps its 6° down.
- A shot climbs with the view. `InputFrame.pitch` carries it, and only first person on foot under
  the lock sets it. `shotPitch` aims from the muzzle, below the eye, up to where the line of sight
  meets the aim plane, so the round goes where the crosshair is. The crosshair stands in the middle
  of the screen.
- `render-preview.ts --view=first-person --on-foot --weapon=<id>` draws it. Add `--aim` to raise it.

## Buildings in the way

- The Buildings setting picks See-through, Pull back, Turn or Off. The cut of `cutaway.ts` stays on
  under Pull back and Turn, for what the move does not clear.
- The turn tests the sight line to the player every metre against the roof boxes of `roofs.ts`. A
  coarser step lets a building corner fall between two points.
- The turn is one way. `clearYaw` keeps the heading it is given while that heading sees, so the
  camera turns only when a roof comes between, and stays where the last turn left it. It does not
  go back to north once north is clear: that second turn moves the view when nothing asked it to.
  Switching the setting away from Turn puts the heading back to north.
- A player inside a footprint, or deep in an alley between towers, has no clear heading at all.
  The camera then keeps its heading and the cut does the work. A preview at such a spot shows no
  turn, which is correct: pick a place on a street beside one tall building to see it.

## Walking in a turned view

- `walk` (`src/sim/player/walker-body.ts`) moves the player in the map's own axes. `Keyboard.sample`
  turns the two walking axes by `Keyboard.turn`, the camera's heading, which `frame.ts` writes each
  frame while the player is on foot. `W` then walks up the screen in every view. A car ignores it,
  since its keys already steer.
- The turn happens in the input frame, before the record. A replay or a peer therefore reads the
  turned axes and needs no camera.
- In a chase view the camera turns after the player, and the player turns to face the way they
  walk. Holding `A` therefore walks a circle. That is how the view steers on foot.

## Mouse look

- `ui/input/mouse-look.ts` holds the pointer lock of the chase views and hands each movement to
  `FollowCamera.look`. The lock is asked for on the `C` press into a chase view, and on a click on
  the canvas. The browser grants it only to a gesture. That click is taken in the capture phase, so
  it does not also fire.
- `frame.ts` tells it each frame whether it is wanted. A menu, the map and a shop counter want the
  pointer, so the lock is let go under them. A touch screen has no lock and never asks.
- The browser keeps the Escape that takes the lock away. A lock it took while still wanted calls
  `onLost`, which `main.ts` points at the pause menu. A lock the frame let go is not lost: `update`
  forgets the request first. `PauseMenu.onResume` calls `resume`, which asks again on the same
  press. `PauseMenu` ignores an Escape in the first `SAME_PRESS_MS`, since a browser may deliver
  the key that took the lock as well.
- On foot the mouse steers the yaw alone: the camera stops turning after the player. At the wheel it
  adds a look aside, which goes back behind the car after `LOOK_HOLD` seconds of a still mouse.
- The free camera locks the same canvas. While it is detached the movement is its own.
- A locked pointer does not move, so the aim is laid ahead of the player along the camera's heading
  (`PointerAim.ahead`), as far as the middle of the screen meets the aim plane. In third person the
  crosshair is drawn on that point; in first person it is in the middle of the screen.
