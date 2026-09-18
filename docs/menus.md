# The menus and the screens around play

The gotchas of the interface the player meets before and beside the street: the title screen, the
wait after Start, the pause menu and the saves. What the game draws while it is being played — the
HUD, the map and the rest — is in `docs/sim-and-ui.md`. `spec.md` section 12 is the design.

## Contents

- The title screen, the settings and the menu walk
- The loading screen
- Saves
- The scene behind the menu
- On a phone

## The title screen, the settings and the menu walk

- `src/ui/title.ts` is the title screen as a main menu of pages: the main page, New game
  (`title-setup.ts`), Settings, and Controls, Camera and Sound under Settings
  (`title-controls.ts`, `title-camera.ts`, `title-sound.ts`). `PARENT` says
  where Escape and Back go from each page. A menu item with no action is drawn disabled; Load game
  and Graphics wait for what they open. The arrow keys walk the elements with `data-nav`, in
  DOM order, and skip a disabled one. The pointer moves the same focus, so only one item is lit. A
  character row takes the focus itself and changes on left and right; its two buttons carry no
  `data-nav`. The look lives in `title.css`, which `style.css` imports.
- `src/ui/settings.ts` holds the settings that belong to the browser rather than to a save, in
  `localStorage` under one key. A value it does not know falls back to the default. The Camera page
  (`title-camera.ts`) and the Sound page (`title-sound.ts`) are shared by the title screen and the
  pause menu, and a choice takes effect on the next frame. Muting throws the whole audio graph away
  rather than turning it down — `docs/audio.md` says why.
- `src/ui/menu-pages.ts` is the page walk both menus share: `parent`, the arrow keys, the pointer
  focus, and Escape going up a page. `src/ui/pause.ts` is the pause menu of spec section 12, drawn
  with the title's classes and the few rules of `pause.css`. It listens to no key: Escape both opens
  and closes it, so `main.ts` hands it every key while it is open. While it is open the frame loop
  takes no steps and the clock keeps its place between two ticks — unless a room is open, because a
  session in company cannot stop the city (`docs/multiplayer.md`).
- `src/ui/party.ts` is the Open game to others page of spec section 21: the room code, the invite
  link and who is in the city. It holds no networking and is redrawn from one state object, which
  `main.ts` hands it through `PauseMenu.refresh` whenever the room changes under it.

## The loading screen

- `src/ui/loading.ts` is the screen between Start and the street. It names the step being taken —
  the world, the ground under the player, the shaders of the first frame — and shows how far
  through the whole wait it is. `main.ts` drives it, and every step it shows is a real one: the
  chunk count comes from `settle`, not from a guess.
- Nothing on that path blocks the frame loop any more, which is what lets the screen draw its own
  progress: the world is built in the worker of `world-source.ts`, and Rapier is fetched beside the
  renderer rather than in front of it and waited for where the physics is first built.
- The screen is opaque, so the scene behind the menu is never seen once Start is pressed, and it
  hands the city over by waiting for the first frame of the session to be drawn under it and then
  fading off it. A player who asked the browser for less motion gets no fade.

## Saves

- A save (`src/sim/save.ts`) is the record and the seed text, nothing else, so a field added to
  `SimState` is saved with no change there. Raise `SAVE_VERSION` when you add one all the same: an
  older save has no such field, is refused either way, and the version is the only refusal a player
  can read. It is read against a fresh record: a missing field or a
  wrong type is refused, and an unknown field is dropped. Raise `SAVE_VERSION` when a field changes
  meaning. `src/ui/saves.ts` keeps one save per seed in `localStorage`.
- A load writes the save into the live record in place, because every closure in `main.ts` holds
  that record, and then builds a new `SimPhysics` from it. Never `adopt` a loaded record into the
  old physics: the traffic bodies keep their cursors and their promoted bodies from before the load.
- A save of another seed needs another world, so an import of one, and Regenerate, load the page
  again. The note in `sessionStorage` from `setPendingStart` tells the next boot to skip the title
  and start that seed, from its save or afresh.

## The scene behind the menu

- `src/render/scene.ts` is the scene behind the menu: a parked car, a lit street lamp and the
  driver, with no world. The camera swings over the front of the car and never goes all the way
  round, because the lamp post stands on the far side. The lamp is the game's own `LampLight`, so
  the scene draws only through a renderer from `createRenderer`, which registers that light.
- `src/ui/seed-preview.ts` draws the map of the seed on the title screen, through the same `MapArt`,
  so the picture the player picks a seed from is the map they will play on. A build takes a second
  or more and runs in the worker of `world-source.ts`, so the scene behind the menu keeps turning;
  it still happens only when the player asks for it — the dice button, the Show the map button, or
  Enter in the seed box — and never on a key press in the box.
  `MapDrawOptions.player` is null there: the preview is the map alone, with no arrow on it. The
  world it built travels back in `TitleChoice.world`, and `main.ts` reuses it rather than
  generating the same seed twice.
- `src/ui/controls.ts` is the one list of key bindings. It is shown on the title screen and copied
  into the README; `Keyboard.sample` must stay in step with the rows that are part of the input
  frame, and `main.ts` listens for the rows after them itself.

## On a phone

- `src/ui/touch.ts` decides whether this is a touch browser, and it takes two answers to say yes:
  the screen reports fingers and `(pointer: coarse)` matches. A touchscreen laptop reports fingers
  and is played with the keys; an iPad claims to be a desktop in every other way and is caught by
  the fingers. `main.ts` asks once, before the title screen, and passes the answer down.
- A phone reaches none of the keys of `controls.ts`, so it is offered the city rather than the game:
  the main menu gains **Explore the city** at the top, which starts the seed the New game page holds
  and detaches the free camera before the first frame. `FreeCamera.survey` lifts it `SURVEY_HEIGHT`
  over the ground it was let go at and tips the view down, so the screen the loading screen fades
  off is already the flight.
- `src/ui/touch-fly.ts` is the pad: a stick under the left thumb, the whole screen behind it as a
  surface the right thumb turns the view on, a pinch that sets the speed, and three keys down the
  right edge. It reads pointer events, never `TouchEvent`, because iOS Safari reports a touch as a
  pointer. The arithmetic — the dead zone, the stick's range, what a pinch is worth — is in
  `touch.ts` and tested there; the pad is the browser half alone.
- The stick takes its centre from wherever the thumb lands, not from the middle of the pad: the
  thumb cannot see the spot it is covering. A key is held rather than clicked, and captures its
  pointer, so a thumb resting on Rise keeps rising while the other thumb turns the view.
- `src/ui/touch-bar.ts` is the three buttons a session is driven from — Menu, Map and Fly — and
  `markTouchUi`, which sets `body.touch` and blocks Safari's own pinch zoom of the page.
  `FreeCameraControls` sets `body.flying` while the camera is detached; `touch.css` hangs the rest
  on those two classes.
- `src/ui/touch.css` holds the pad and everything `body.touch` changes: tap targets at 44 px, the
  key hints hidden, the safe-area insets of the notch and the home bar, and a 16 px font on every
  field, because Safari zooms the page in on a smaller one and never zooms back out.
- A touch session starts at `TOUCH_START_TIER` rather than at full quality (`main.ts`). The monitor
  would find that level within a second anyway, but the frames it spends getting there are the first
  frames of the flight, and the warm-up compiles at whatever tier is standing.
