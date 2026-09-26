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

- `src/ui/menus/title.ts` is the title screen as a main menu of pages: the main page, New game
  (`title-setup.ts`), Load game (`title-load.ts`), Controls (`title-controls.ts`), Options
  (`title-settings.ts`), and View and Buildings under Options (`title-camera.ts`). `PARENT` says
  where Escape and Back go from each page. A menu item with no action is drawn disabled.
- Load game opens a column of the saves this browser holds, newest first: the seed as the label,
  and the day, the time of day and the money as its note. Picking one resolves the title with the
  save's seed and driver and `load: true`, and `main.ts` puts the save into the record once that
  seed's world stands — the same path a pending start takes, without a page load. The item is
  disabled where there is no save, and on an invite link, where the seed is the host's.
- Menu text is a word or two. An item carries no note line, and a page has no line under its
  heading unless the player needs it to choose. The arrow keys walk the elements with `data-nav`, in
  DOM order, and skip a disabled one. The pointer moves the same focus, so only one item is lit. A
  character row takes the focus itself and changes on left and right; its two buttons carry no
  `data-nav`. The look lives in `title.css`, which `style.css` imports.
- The look is the art style's (`docs/art-style.md`), set by the `--it-*` tokens at the top of
  `title.css`. Every panel and HUD box reads them: cream cards (`--it-ivory`, `#f4efe2`) with an
  ink border and a small drop shadow, titles in the system hand of `--it-hand`, pill buttons, and
  round yellow badges (`--it-yellow`). The game ships no font file, so the hand differs a little
  between systems; that is accepted.
- `src/ui/menus/title-open.ts` decides what a page opens on: a pending start from a save, or the
  title screen. A page opened on an invite link shows who invited it first. The main page gets a
  banner with the room and the seed, and New game becomes **Join game**. The setup page drops the
  city card, because the seed is the host's: a joiner picks only a driver.
- `src/ui/menus/settings.ts` holds the settings that belong to the browser rather than to a save, in
  `localStorage` under one key. A value it does not know falls back to the default. The Options
  column and the columns it opens are shared by the title screen and the pause menu, through one
  `MenuSettings` object that `main.ts` builds, and a choice takes effect on the next frame. A
  setting that is on or off, such as Sound or the minimap's north, is a checkbox: a `MenuItem` with
  a `toggle`. One choice of several, such as View, is a round mark on each row. A setting is
  not a key in `controls.ts`: a key is for what the player does while playing. The one exception is
  View, which `C` also steps through (`keys.ts`), since a player changes it while driving.
  Muting throws the whole audio graph away rather than turning it down — `docs/audio.md` says why.
- Gore is one choice of four, Off, Subtle, Moderate and Heavy, with Moderate the default. It opens
  a column beside Options, as View and Buildings do; `title-camera.ts` builds all three from one
  choice page. The levels live in `src/render/people/gore.ts`, because only the renderer reads them:
  `frame.ts` hands the setting to `WorldScene.gore` each frame. It never enters `SimState`, so a
  save and a replay are the same at every level.
- `src/ui/menus/title-graphics.ts` is the Graphics column of both menus: Auto, a preset and each
  knob of a tier. A knob of several steps is a `cycle` item, which names its step at the end of the
  row; a press moves it on and the side arrows move it either way. `menuList` redraws every checkbox
  and cycle on the list after a press and when the list takes the focus, because one row moves
  another: a preset sets every knob, and a knob turns Auto off from the tier Auto was drawing.
- `src/ui/menus/menu-pages.ts` is the page walk both menus share: `parent`, the arrow keys, the
  pointer focus, and Escape going up a page. A page in `columns` opens as a column beside its
  parent, and the parent stays on screen: a submenu is an accordion on its side. An item with
  `opens` opens its column, and a second press closes it. Right opens it too, and Left closes the
  column the focus is in. The columns stand in one row, `.menu-columns`, all hung from one top line,
  so opening one never moves the list it came from. A column's Back button shows only on a narrow
  screen, where one column is shown at a time. The New game page scrolls rather than shrink: its
  cards keep `min-height: auto`, or a short screen lays the Driver card and the buttons over the
  City card. `src/ui/menus/pause.ts` is the pause menu of spec
  section 12, drawn with the title's classes and the few rules of `pause.css`. Its main list is
  Resume, Multiplayer, Save game, Load game, Controls, Graphics, Options and Quit to main menu. The
  HUD, the minimap and the panels over play are hidden while it is open, so no text shows through
  beside it. It listens to no key: Escape both opens and closes it, so `keys.ts` hands it every key
  while it is open. While it is open the frame loop takes no steps and the clock keeps its place
  between two ticks — unless a room is open, because a session in company cannot stop the city
  (`docs/multiplayer.md`).
- `src/ui/menus/party.ts` is the Multiplayer column of spec section 21: the room code, the invite
  link and who is in the city. It holds no networking and is redrawn from one state object, which
  `main.ts` hands it through `PauseMenu.refresh` whenever the room changes under it.

## The loading screen

- `src/ui/menus/loading.ts` is the screen between Start and the street. It names the step being
  taken — the world, the ground under the player, the shaders of the first frame — and shows how far
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
  meaning. `src/ui/menus/saves.ts` keeps one save per seed in `localStorage`.
- `SaveSlots.write` also keeps the wall-clock time it was written under a key of its own, because
  the record is the simulation and the simulation never reads that clock. `SaveSlots.list` walks
  the store's keys and answers with a line per save for the title screen. It reads each save in
  full, so a save this version cannot play is left off the list rather than offered and then
  refused.
- A load writes the save into the live record in place, because every closure of the session holds
  that record, and then builds a new `SimPhysics` from it. Never `adopt` a loaded record into the
  old physics: the traffic bodies keep their cursors and their promoted bodies from before the load.
- A save of another seed needs another world, so an import of one, and New city, load the page
  again. The note in `sessionStorage` from `setPendingStart` tells the next boot to skip the title
  and start that seed, from its save or afresh.

## The scene behind the menu

- `src/render/title/scene.ts` is the scene behind the menu: a red sports car on a seafront at
  sunset, its door open and the driver beside it, with no world. `backdrop.ts` builds the rest from
  boxes, cones and planes: the sky, the sun, the sea, the palms and a town on a headland. The camera
  swings over the front of the car and never goes all the way round.
- The scene is drawn through its own `PostChain`, so it has the ink, the bloom and the grade of
  play. The chain grades it at a fixed hour, `HOUR`. The sky and the sun write no depth: the ink
  would outline the sun, and the bloom would read the dome as a wall. The lamps are the game's own
  `LampLight`, so the scene draws only through a renderer from `createRenderer`.
- `frameCamera` fits the car to the width of the window and shifts the view with `setViewOffset`.
  The car stands right of the menu on a wide screen and above it on an upright one, where
  `touch.css` puts the main menu at the bottom. A change to where the menu stands moves `FOCUS_*`.
  `node scripts/title-preview.ts <prefix>` takes the picture at a desktop and at a phone held both
  ways; judge a change to the scene or the menu layout from those three.
- `src/ui/menus/seed-preview.ts` draws the map of the seed on the title screen, through the same
  `MapArt`, so the picture the player picks a seed from is the map they will play on. A build takes
  a second or more and runs in the worker of `world-source.ts`, so the scene behind the menu keeps
  turning; it still happens only when the player asks for it — the dice button, the Show the map
  button, or Enter in the seed box — and never on a key press in the box. `MapDrawOptions.player` is
  null there: the preview is the map alone, with no arrow on it. The world it built travels back in
  `TitleChoice.world`, and `main.ts` reuses it rather than generating the same seed twice.
- The seed box reads one code, `money` in any case (`readSeedCode` in `src/core/seed.ts`). It is
  not a seed: the box swaps it for a random seed, and the session starts with a billion rather than
  `START_MONEY`. The amount travels in `TitleChoice.money` to `createSimState`.
- `src/ui/input/controls.ts` is the one list of key bindings. It is shown on the title screen and
  copied into the README; `Keyboard.sample` must stay in step with the rows that are part of the
  input frame, and `keys.ts` listens for the rows after them.

## On a phone

- `src/ui/input/touch.ts` decides whether this is a touch browser, and it takes two answers to say
  yes: the screen reports fingers and `(pointer: coarse)` matches. A touchscreen laptop reports
  fingers and is played with the keys; an iPad claims to be a desktop in every other way and is
  caught by the fingers. `main.ts` asks once, before the title screen, and passes the answer down.
- A phone reaches none of the keys of `controls.ts`, so a session on one is played from the pad of
  `src/ui/input/touch-play.ts`: the stick under the left thumb, and a cluster of buttons under the
  right one. The main menu also gains **Explore** at the top, which starts the seed the New game
  page holds and detaches the free camera before the first frame. `FreeCamera.survey` lifts it
  `SURVEY_HEIGHT` over the ground it was let go at and tips the view down, so the screen the loading
  screen fades off is already the flight.
- The play pad writes into `Keyboard` rather than into the input frame: the stick through
  `Keyboard.stick`, which stands in for the walking keys and is turned by the view as they are, and
  each button through `Keyboard.press` and `release` with the code of the real key. So every edge
  the keys keep — the jump, the interact, the number rows — holds for a finger too. A button takes
  its key when the finger goes down and lets go of that key, so Horn held while getting out does not
  leave the horn stuck. Space is both Jump and Brake; the fourth button is Run on foot and Horn in a
  vehicle. The frame hides the pad under the flight, a menu and the map (`SessionFrame.showPad`),
  and hiding it lets go of everything.
- While a shop's counter or a deal is open, the pad's buttons are hidden and let go, and the stick
  stays. The counter stands in their corner, and the stick still walks out of the room.
- A phone has no pointer lock, so `MouseLook` turns the first person view by a drag on the canvas
  instead, `TOUCH_LOOK_GAIN` times a mouse pixel. It reads `camera.view`, so a shop's room turns
  too. A counter does not stop the drag: a tap on a row lands on the row, not on the canvas.
- A tap presses a key for one sample through `Keyboard.pulse`. The metro, safehouse and job panels
  write the key of each numbered row into `data-key`, the interact prompt writes `KeyE`, and
  `Keyboard.listenRows` takes a click on any of them as that key. A finger aims nothing
  (`PointerAim.mouse`), so a shot goes the way the player faces.
- `src/ui/input/fullscreen.ts` is the Full button of the bar. Android Chrome and iPad Safari have
  the Fullscreen API. iPhone Safari gives it to a video alone, so a page is full screen there only
  when opened from the Home Screen, which `public/manifest.webmanifest` and the
  `apple-mobile-web-app-*` tags ask for. On an iPhone the button shows how to add the game there; a
  page already opened from the Home Screen gets no button.
- `src/ui/input/touch-fly.ts` is the fly pad: a stick under the left thumb, the whole screen behind
  it as a surface the right thumb turns the view on, a pinch that sets the speed, and three keys
  down the right edge. It reads pointer events, never `TouchEvent`, because iOS Safari reports a
  touch as a pointer. The arithmetic — the dead zone, the stick's range, what a pinch is worth — is
  in `touch.ts` and tested there; the pad is the browser half alone.
- The stick takes its centre from wherever the thumb lands, not from the middle of the pad: the
  thumb cannot see the spot it is covering. A key is held rather than clicked, and captures its
  pointer, so a thumb resting on Rise keeps rising while the other thumb turns the view.
- `src/ui/input/touch-bar.ts` is the bar in the top corner — Menu, Map, Fly and Full — and
  `markTouchUi`, which sets `body.touch` and blocks Safari's own pinch zoom of the page.
  `FreeCameraControls` sets `body.flying` while the camera is detached; `touch.css` hangs the rest
  on those two classes.
- `src/ui/input/touch.css` holds both pads and everything `body.touch` changes: tap targets at 44
  px, the key hints hidden, the safe-area insets of the notch and the home bar, and a 16 px font on
  every field, because Safari zooms the page in on a smaller one and never zooms back out. While the
  play pad is up, the minimap and the speedometer rise above it and the counters stand clear of both
  thumbs; a phone held sideways has no room for the minimap, and the Map button stands in.
- A touch session starts at `TOUCH_START_TIER` rather than at full quality (`main.ts`). The monitor
  would find that level within a second anyway, but the frames it spends getting there are the first
  frames of the flight, and the warm-up compiles at whatever tier is standing.
