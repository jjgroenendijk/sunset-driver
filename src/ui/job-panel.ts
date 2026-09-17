/**
 * The board at a contact's corner (spec section 18).
 *
 * The rules are in `src/sim/mission.ts` and this draws them. A player walking
 * past is told how to talk, or why the contact will not; a player talking is
 * shown the one job on offer — what it is, what it pays and how long it allows
 * — and the key that takes it. A player who already has a job is shown what is
 * left of it and the way out of it.
 *
 * It stands where the shop counter and the safehouse panel stand, and hides
 * while either of those or a deal has the screen: a player inside a shop, on
 * their own step or in the middle of a deal is not talking to a contact, and
 * the simulation shuts this board for the same reason.
 *
 * Only what changed is written, as the HUD and the other panels do: a panel
 * standing still writes nothing.
 */
import { giverAt, giverRefusal, type GiverPlace } from '../sim/giver.ts';
import { type JobOffer, type MissionJob, type MissionWorld } from '../sim/job.ts';
import { dollars } from '../sim/market.ts';
import { countdown, jobOffers, jobRows, visitingGiver } from '../sim/mission.ts';
import type { SimState } from '../sim/simulation.ts';
import { CHOICE_KEYS } from './keyboard.ts';

/** The key that opens a board, as `controls.ts` lists it. */
const TALK_KEY = 'E';

export class JobPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private shown = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'job';
    this.root.hidden = true;
    this.title = document.createElement('div');
    this.title.className = 'job-title';
    this.list = document.createElement('div');
    this.list.className = 'job-list';
    this.root.append(this.title, this.list);
    parent.append(this.root);
  }

  /**
   * Draw the board of the contact being talked to, or of the corner the player
   * is standing on. Nothing is drawn where they are at neither, and nothing
   * while a counter, a front door or a deal has the screen.
   */
  update(state: SimState, world: MissionWorld): void {
    const givers = world.givers;
    const busy = state.shop !== null || state.property.visit !== null || state.market.deal !== null;
    const talking = visitingGiver(state, givers);
    const giver = busy ? undefined : (talking ?? givers[giverAt(givers, state)]);
    if (giver === undefined) {
      this.hide();
      return;
    }
    const rows = talking === undefined ? [cornerLine(state, giver)] : board(state, world, giver);
    const text = `${giver.name}\n${rows.map((row) => row.text).join('\n')}`;
    if (text === this.shown) return;
    this.shown = text;
    this.root.hidden = false;
    this.title.textContent = giver.name;
    this.list.replaceChildren(
      ...rows.map((row) => {
        const line = document.createElement('div');
        line.className = row.className;
        line.textContent = row.text;
        return line;
      }),
    );
  }

  destroy(): void {
    this.root.remove();
  }

  private hide(): void {
    this.root.hidden = true;
    this.shown = '';
  }
}

/** One line of the board. */
interface Row {
  text: string;
  className: string;
}

/** What a player standing on the corner is told: how to talk, or why they are not being talked to. */
function cornerLine(state: SimState, giver: GiverPlace): Row {
  const refusal = giverRefusal(state, giver);
  if (refusal === null || state.missions.active?.giver === giver.id) {
    return { text: `${TALK_KEY} · talk`, className: 'job-row' };
  }
  return { text: refusal, className: 'job-refused' };
}

/** What the contact is saying: the job in hand or the job on offer, and the keys for it. */
function board(state: SimState, world: MissionWorld, giver: GiverPlace): Row[] {
  const rows: Row[] = [];
  const job = state.missions.active;
  if (job !== null && job.giver === giver.id) rows.push(...carried(state, job));
  else if (job !== null) rows.push({ text: 'Finish what you are carrying first.', className: 'job-refused' });
  else {
    const refusal = giverRefusal(state, giver);
    if (refusal !== null) rows.push({ text: refusal, className: 'job-refused' });
    else rows.push(...offered(state, world, giver));
  }
  rows.push(
    ...jobRows(state, world, giver)
      .slice(0, CHOICE_KEYS)
      .map((row, i) => ({ text: `${i + 1} · ${row.label}`, className: 'job-row' })),
  );
  const said = state.missions.visit?.said ?? '';
  if (said !== '') rows.push({ text: said, className: 'job-said' });
  rows.push({ text: `${TALK_KEY} · leave`, className: 'job-row' });
  return rows;
}

/**
 * The jobs on the board: what each is, what it pays and how long it allows. A
 * chapter of the authored chain is read first and carries a line of its own,
 * which is the contact saying what the work is for (`chain.ts`).
 */
function offered(state: SimState, world: MissionWorld, giver: GiverPlace): Row[] {
  const offers = jobOffers(state, world, giver);
  if (offers.length === 0) return [{ text: 'Nothing today.', className: 'job-refused' }];
  return offers.flatMap((offer: JobOffer) => {
    const rows: Row[] = [{ text: offer.job.title, className: 'job-offer' }];
    if (offer.note !== '') rows.push({ text: offer.note, className: 'job-brief' });
    rows.push({
      text: `${dollars(offer.job.pay)} · ${countdown(offer.job.limit)} · ${legsLine(offer.job)}`,
      className: 'job-terms',
    });
    return rows;
  });
}

/** The job in hand: the leg being worked on and what is left of the clock. */
function carried(state: SimState, job: MissionJob): Row[] {
  const leg = job.legs[job.leg];
  const left = Math.max(0, job.limit - (state.tick - job.taken));
  return [
    { text: job.title, className: 'job-offer' },
    { text: `${leg?.label ?? ''} · ${countdown(left)} left`, className: 'job-terms' },
  ];
}

/** How much of a job there is, in the words a player reads before taking it. */
function legsLine(job: MissionJob): string {
  return job.legs.length === 1 ? (job.legs[0]?.label ?? '') : `${job.legs.length} stops`;
}
