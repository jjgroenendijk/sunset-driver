/**
 * The claimants of one place, as the carve asks each road and junction that
 * reaches it (`carve.ts`, `RoadCarve.claim`). One tally is kept per carve and
 * reset for every place, so asking allocates nothing.
 */
export class ClaimTally {
  /** The lowest and highest bed the claims ask for, which say if they differ. */
  asked = Infinity;
  askedHigh = -Infinity;
  /** The best claimant so far. */
  bestClaimed = 0;
  bestWeight = 0;
  bestDistance = Infinity;
  bestHeight = 0;
  bestRoad = -1;
  /** The junction whose cover holds the place, which owns it whatever else reaches it; -1 for none. */
  ownerHeight = 0;
  ownerRoad = -1;

  /** Forget the last place. */
  reset(): void {
    this.asked = Infinity;
    this.askedHigh = -Infinity;
    this.bestClaimed = 0;
    this.bestWeight = 0;
    this.bestDistance = Infinity;
    this.bestHeight = 0;
    this.bestRoad = -1;
    this.ownerHeight = 0;
    this.ownerRoad = -1;
  }

  /** Note a bed a claimant asks for, whether or not it wins the place. */
  ask(bed: number): void {
    this.asked = Math.min(this.asked, bed);
    this.askedHigh = Math.max(this.askedHigh, bed);
  }

  /**
   * Take a claimant where it beats the best so far. `claimed` is how wide the
   * road that claims the place is, and zero where the place is outside the
   * ground it claims.
   */
  offer(claimed: number, weight: number, distance: number, bed: number, road: number): void {
    if (claimed > 0) this.ask(bed);
    if (claimed > 0 || this.bestClaimed > 0) {
      if (!this.claimBeats(claimed, distance, bed)) return;
    } else if (weight < this.bestWeight || (weight === this.bestWeight && distance >= this.bestDistance)) {
      return;
    }
    this.bestClaimed = claimed;
    this.bestWeight = weight;
    this.bestDistance = distance;
    this.bestHeight = bed;
    this.bestRoad = road;
  }

  /**
   * True where a claimant beats the best so far, one of the two being a claim.
   * A claim always beats ground merely reached; between two claims the lower
   * bed wins, then the wider road, then the nearer one.
   */
  private claimBeats(claimed: number, distance: number, bed: number): boolean {
    if (this.bestClaimed > 0) {
      const worse =
        claimed === 0 ||
        bed > this.bestHeight ||
        (bed === this.bestHeight &&
          (claimed < this.bestClaimed || (claimed === this.bestClaimed && distance >= this.bestDistance)));
      return !worse;
    }
    return true;
  }
}
