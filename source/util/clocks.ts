export interface ClockStates {
  myLocalClock: SequencerClock;
  myLatestCheckpoint: SequencerClock;
  memorizedRcvdMsgs: Map<string, number>;
}

export class SequencerClock {
  seq = 0;

  constructor(seq?: number) {
    this.seq = seq !== undefined ? seq : 0;
  }

  public increment(): number {
    return this.seq++;
  }

  public compareTo(other: SequencerClock): number {
    if (this.seq < other.seq) {
      return -1;
    } else {
      return this.seq > other.seq ? 1 : 0;
    }
  }
}

export const INIT_SEQUENCER_CLOCK_STATE: ClockStates = {
  myLocalClock: new SequencerClock(0),
  myLatestCheckpoint: new SequencerClock(0),
  memorizedRcvdMsgs: new Map(),
};

export interface VectorClockState {
  readonly clock: Map<string, number>;
  readonly myID: string;
}

export class VectorClock {
  private vectorClockState!: VectorClockState;

  /**
   * Created new vector clock for some instance
   *
   * @param identifier of that instance
   * @param clock clock (optional, if empty will be initialised)
   * @constructor
   */
  constructor(identifier: string, clock?: Map<string, number>) {
    this.vectorClockState = {
      clock: clock !== undefined ? clock : new Map<string, number>(),
      myID: identifier,
    };
  }

  /**
   * Routine that should be invoked *before* sending a new message, attach VectorClockState to message to be sent
   */
  public increment(): VectorClockState {
    const vc: VectorClockState = this.vectorClockState;
    let toBeIncremented = vc.clock.get(vc.myID) || 0;
    this.vectorClockState.clock.set(vc.myID, toBeIncremented++);
    return this.vectorClockState;
  }

  /**
   * Routine that should be invoked when receiving a new message, pass received vector clock as an argument
   *
   * @param vcReceived vector clock received in message
   */
  public update(vcReceived: VectorClockState): VectorClockState {
    const vcReceiver: VectorClockState = this.vectorClockState;
    // Receiving means incrementing local time
    this.increment();

    // Union of both vector clocks, if key exists in both the value is the one of the latter: vcReceived
    const updatedClock = new Map([...vcReceiver.clock, ...vcReceived.clock]);
    // Make sure to take the maximum of local and received value fo every entry
    updatedClock.forEach((value: number, key: string) =>
      Math.max(value, vcReceiver.clock.get(key) || 0)
    );
    this.vectorClockState = {
      clock: updatedClock,
      myID: vcReceiver.myID,
    };
    return this.vectorClockState;
  }

  /**
   * Check if *this* vector clock A happens before the other B. A->B
   *
   * @param vcOther clock state of other instance
   */
  public happendBefore(vcOther: VectorClockState): boolean {
    let singleIndexIsSmaller = false;

    // union of both vector clocks, contains all keys that exist in at least one of both clocks
    const iterateOver = new Map([
      ...this.vectorClockState.clock,
      ...vcOther.clock,
    ]);

    for (const id in iterateOver.keys()) {
      // If *this* vector clock is larger than the one of *vcOther* in a single index, it did not happen before!
      if (
        (this.vectorClockState.clock.get(id) || 0) >
        (vcOther.clock.get(id) || 0)
      ) {
        return false;
      }
      // Strictness is necessary for at least one id
      // If could have happend before then, if "<=" relation holds on all other ids
      if (
        (this.vectorClockState.clock.get(id) || 0) <
        (vcOther.clock.get(id) || 0)
      ) {
        singleIndexIsSmaller = true;
      }
    }
    return singleIndexIsSmaller;
  }

  /**
   * Check if *this* vector clock A happens after the other B. B->A
   *
   * @param vcOther clock state of other instance
   */
  public happenedAfter(vcOther: VectorClockState): boolean {
    return new VectorClock(vcOther.myID, vcOther.clock).happendBefore(
      this.vectorClockState
    );
  }

  /**
   * Check for concurrency. Return !(A->B || B->A)
   *
   * @param vcOther clock state of other instance
   */
  public isConcurrent(vcOther: VectorClockState): boolean {
    // If neither A -> B nor B -> A is true, then events are concurrent
    return !this.happendBefore(vcOther) && !this.happenedAfter(vcOther);
  }

  public isEqualTime(vcOther: VectorClockState): boolean {
    // union of both vector clocks, contains all keys that exist in at least one of both clocks
    const iterateOver = new Map([
      ...this.vectorClockState.clock,
      ...vcOther.clock,
    ]);

    if (this.vectorClockState.myID !== vcOther.myID) {
      return false;
    }
    for (const id in iterateOver.keys()) {
      if (
        (this.vectorClockState.clock.get(id) || 0) !==
        (vcOther.clock.get(id) || 0)
      ) {
        return false;
      }
    }
    return true;
  }
}
