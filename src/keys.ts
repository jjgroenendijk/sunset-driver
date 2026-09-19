/**
 * The keys and the clicks of a session that the simulation does not sample:
 * the menus, the maps, the debug pickers and triggers, and the free camera.
 *
 * The keys that drive the player are read by `Keyboard` once a tick; these act
 * once a press, on the page. They are here rather than in `main.ts` because
 * they are one subject — what a press opens or writes — and `main.ts` is the
 * boot. `ui/controls.ts` lists them for the player.
 */
import type { FollowCamera } from './render/camera.ts';
import { nextView, type CameraView } from './render/camera-view.ts';
import { commitCrime } from './sim/police.ts';
import type { SimState } from './sim/simulation.ts';
import { FREE_CAMERA_KEY, type FreeCameraControls } from './ui/free-camera.ts';
import { DEV_INFO_KEY } from './ui/hud.ts';
import { MAP_CENTRE_KEY, MAP_KEY, MAP_LEGEND_KEY, type MapScreen } from './ui/map-screen.ts';
import type { Minimap } from './ui/minimap.ts';
import type { Choice } from './ui/settings.ts';
import { PAUSE_KEY, type PauseMenu } from './ui/pause.ts';
import { PICKER_KEY, type VehiclePicker } from './ui/vehicle-picker.ts';
import { WEAPON_PICKER_KEY, type WeaponPicker } from './ui/weapon-picker.ts';

/** The debug keys that end a run (spec section 11.7), until the damage does. */
const DIE_KEY = 'KeyK';
const ARREST_KEY = 'KeyB';

/**
 * The debug key that commits a crime (spec section 14), so a chase can be
 * started without shooting anybody. Each press is one assault, which is most of
 * a star.
 */
const CRIME_KEY = 'KeyL';

/** The key that steps the camera through its views (spec section 10.7). */
export const VIEW_KEY = 'KeyT';

/** What the keys open, toggle and write. */
export interface KeyTargets {
  state: SimState;
  pause: PauseMenu;
  map: MapScreen;
  minimap: Minimap;
  picker: VehiclePicker;
  weapons: WeaponPicker;
  free: FreeCameraControls;
  camera: FollowCamera;
  /** The view setting, which the view key steps and the menus also write. */
  view: Choice<CameraView>;
}

/** Listen on the window for the keys and the minimap clicks of a session. */
export function listenForKeys(target: Window, keys: KeyTargets): void {
  const { state, pause, map, minimap, picker, weapons, free, camera, view } = keys;
  // A click on the minimap sets a waypoint too, so a player driving does not
  // have to stop and open the full map to mark where they are going.
  target.addEventListener('pointerdown', (event) => {
    if (pause.open || map.open || !minimap.holds(event.clientX, event.clientY)) return;
    state.waypoint = event.button === 2 ? null : minimap.pointAt(event.clientX, event.clientY);
  });
  target.addEventListener('keydown', (event) => {
    // The open pause menu takes every key, so nothing behind it moves.
    if (pause.open) {
      pause.key(event);
      return;
    }
    if (event.repeat) return;
    // Escape closes the map first, and opens the pause menu when nothing else is open.
    if (event.code === PAUSE_KEY && !map.open) {
      pause.show();
      return;
    }
    if (event.code === PICKER_KEY) picker.toggle();
    if (event.code === WEAPON_PICKER_KEY) weapons.toggle();
    // The debug triggers of spec section 11.7. Each writes the record between
    // two ticks, as the damage and the police will, and the next tick resolves
    // it, so a run ended this way replays like any other.
    if (event.code === DIE_KEY) state.player.health = 0;
    if (event.code === ARREST_KEY) state.arrested = true;
    if (event.code === CRIME_KEY) commitCrime(state, 'assault');
    if (event.code === MAP_KEY) map.toggle();
    if (event.code === VIEW_KEY && !map.open) view.choose(nextView(view.current()));
    if (event.code === 'Escape' && map.open) map.toggle();
    if (map.open && (event.code === 'Equal' || event.code === 'NumpadAdd')) map.zoom(-1);
    if (map.open && (event.code === 'Minus' || event.code === 'NumpadSubtract')) map.zoom(1);
    if (map.open && event.code === MAP_CENTRE_KEY) map.centre();
    if (map.open && event.code === MAP_LEGEND_KEY) map.toggleLegend();
    // The developer free camera. It takes over from where the game camera
    // stands, and pointer lock needs this key press to ask for it.
    if (event.code === FREE_CAMERA_KEY) free.toggle(camera.camera);
    // The developer block of the HUD. F3 is the browser's find-next too.
    if (event.code === DEV_INFO_KEY) {
      event.preventDefault();
      target.document.body.classList.toggle('dev-info');
    }
  });
}
