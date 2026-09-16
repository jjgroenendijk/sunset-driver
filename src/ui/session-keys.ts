/**
 * The keys of a session that open and close something on screen, rather than
 * driving the simulation: the pause menu, the map, the minimap's north lock,
 * the two debug pickers, the free camera and the debug triggers of spec
 * section 11.7.
 *
 * `controls.ts` is the one list of the bindings and `keyboard.ts` samples the
 * per-tick input frame; this is everything else a key does, in one place, so
 * `main.ts` holds the frame loop and not a switch of key codes.
 */
import type { FollowCamera } from '../render/camera.ts';
import { commitCrime } from '../sim/police.ts';
import type { SimState } from '../sim/simulation.ts';
import type { FreeCameraControls } from './free-camera.ts';
import { FREE_CAMERA_KEY } from './free-camera.ts';
import { MAP_KEY, type MapScreen } from './map-screen.ts';
import { MINIMAP_NORTH_KEY, type Minimap } from './minimap.ts';
import { PAUSE_KEY, type PauseMenu } from './pause.ts';
import { PICKER_KEY, type VehiclePicker } from './vehicle-picker.ts';
import { WEAPON_PICKER_KEY, type WeaponPicker } from './weapon-picker.ts';

/** The debug keys that end a run (spec section 11.7), until the damage does. */
const DIE_KEY = 'KeyK';
const ARREST_KEY = 'KeyB';

/**
 * The debug key that commits a crime (spec section 14), so a chase can be
 * started without shooting anybody. Each press is one assault, which is most of
 * a star.
 */
const CRIME_KEY = 'KeyL';

/** Everything a key of a session reaches. */
export interface SessionKeys {
  state: SimState;
  pause: PauseMenu;
  map: MapScreen;
  minimap: Minimap;
  picker: VehiclePicker;
  weapons: WeaponPicker;
  free: FreeCameraControls;
  camera: FollowCamera;
}

/** Listen for them on `target` for the rest of the session. */
export function listenForSessionKeys(target: Window, on: SessionKeys): void {
  target.addEventListener('keydown', (event) => {
    // The open pause menu takes every key, so nothing behind it moves.
    if (on.pause.open) {
      on.pause.key(event);
      return;
    }
    if (event.repeat) return;
    // Escape closes the map first, and opens the pause menu when nothing else is open.
    if (event.code === PAUSE_KEY && !on.map.open) {
      on.pause.show();
      return;
    }
    if (event.code === PICKER_KEY) on.picker.toggle();
    if (event.code === WEAPON_PICKER_KEY) on.weapons.toggle();
    // The debug triggers of spec section 11.7. Each writes the record between
    // two ticks, as the damage and the police will, and the next tick resolves
    // it, so a run ended this way replays like any other.
    if (event.code === DIE_KEY) on.state.player.health = 0;
    if (event.code === ARREST_KEY) on.state.arrested = true;
    if (event.code === CRIME_KEY) commitCrime(on.state, 'assault');
    if (event.code === MAP_KEY) on.map.toggle();
    if (event.code === MINIMAP_NORTH_KEY) on.minimap.toggleNorth();
    if (event.code === 'Escape' && on.map.open) on.map.toggle();
    if (on.map.open && (event.code === 'Equal' || event.code === 'NumpadAdd')) on.map.zoom(-1);
    if (on.map.open && (event.code === 'Minus' || event.code === 'NumpadSubtract')) on.map.zoom(1);
    // The developer free camera. It takes over from where the game camera
    // stands, and pointer lock needs this key press to ask for it.
    if (event.code === FREE_CAMERA_KEY) on.free.toggle(on.camera.camera);
  });
}
