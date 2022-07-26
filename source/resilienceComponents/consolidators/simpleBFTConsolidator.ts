import { AbstractState, AtomicComponent, createPort, Event, Port } from "../..";
import * as fp from "lodash/fp";
import * as _ from "lodash";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { Maybe, Just, Nothing } from "@typed/maybe";

export type BFTConsolidatorState<P> = {
  readonly inPorts: [P, number][];
  readonly outPort: [P, number];
  lastAcceptedSequence: number;
  readonly quorum: number;
  //  InPort -> (inQueues -> (Sequence -> (Type, (Port, ReplicaId))))
  inQueues: Map<number, Map<number, Event<any, [P, number]>>>;
};

function countOccurrences(
  event: Event<any, any>,
  seq: number,
  quorum: number,
  inQueues: Map<number, Map<number, Event<any, any>>>
): number {
  let count = 0;

  for (const queue of inQueues.values()) {
    if (
      queue.get(seq) !== undefined &&
      queue.get(seq)?.type === event.type &&
      queue.get(seq)?.timestamp === event.timestamp &&
      JSON.stringify((<any>queue.get(seq))?.param) ===
        JSON.stringify((<any>event).param) // Too for later performance tuning, compare hash values instead of actual payload
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Implementation of the BFT Consolidator: accept event after gathering quorum of matching events for same sequenceNr
 *
 * @param state
 */
function consolidateStep<E, P>(
  state: AbstractState<BFTConsolidatorState<P>, E, [P, number], undefined>
): Maybe<AbstractState<BFTConsolidatorState<P>, E, [P, number], undefined>> {
  const newState: AbstractState<
    BFTConsolidatorState<P>,
    E,
    [P, number],
    undefined
  > = {
    state: state.state,
    events: [],
    tsType: "State",
  };

  let hasChanged = false;

  let lastAcceptedSeq = state.state.lastAcceptedSequence;
  const quorum: number = state.state.quorum;

  // in-event queue only contains "fresh" events of IN-Ports and these events get ordered by their sequence number
  const inEventQueue = state.events
    .filter(
      (e) =>
        e.timestamp !== undefined &&
        e.timestamp > lastAcceptedSeq &&
        e.port !== undefined &&
        e.port[0] !== state.state.outPort[0]
    )
    .sort((e1, e2) => {
      if (e1 && e1.timestamp !== undefined) {
        if (e2 && e2.timestamp !== undefined) {
          return Math.sign(e1.timestamp - e2.timestamp);
        } else {
          return 1;
        }
      } else {
        return -1;
      }
    });

  // multiple inQueues are used to more efficiently look-up an event for a specific sequence on a specific port
  inEventQueue.forEach((event) => {
    if (
      event.port &&
      event.timestamp !== undefined &&
      newState.state.inQueues.get(event.port[1])?.get(event.timestamp) ===
        undefined
    ) {
      newState.state.inQueues.get(event.port[1])?.set(event.timestamp, event);
      hasChanged = true;
    }
  });

  // separate out queue
  const outEventQueue: Event<E, [P, number]>[] = state.events.filter(
    (e) => e.port && e.port[0] === state.state.outPort[0]
  );

  // Begin the consolidation loop: accept fresh events one after another sorted by sequence, do not accept any out-of-order
  // events. Accept only if quorum of matching events on different ports exists. Proceed als long as events can be
  // successfully accepted. Put remaining events in a pending queue for subsequent step() calls.
  const accepted: Event<E, [P, number]>[] = [];
  let pending: Event<E, [P, number]>[] = [];
  let proceed = true;

  inEventQueue.forEach((event) => {
    if (event.timestamp !== undefined && event.timestamp > lastAcceptedSeq) {
      const occurrences = countOccurrences(
        event,
        event.timestamp,
        quorum,
        newState.state.inQueues
      );
      if (occurrences < quorum || !proceed) {
        pending.push(event);
        proceed = false;
      }
      if (occurrences >= quorum && proceed) {
        accepted.push({
          ...event,
          port: state.state.outPort,
          timestamp: event.timestamp,
        } as Event<E, [P, number]>);
        lastAcceptedSeq = event.timestamp;
        newState.state.lastAcceptedSequence = event.timestamp;
        hasChanged = true;
      }
    }
  });

  pending = pending.filter(
    (e) => e.timestamp !== undefined && e.timestamp > lastAcceptedSeq
  );

  newState.events.push(...outEventQueue, ...accepted, ...pending);

  if (newState.events.length !== state.events.length) {
    hasChanged = true;
  }

  return hasChanged ? Just.of(newState) : Nothing;
}

/**
 * Create a new instance of a BFT Consolidator component
 *
 * @param inPorts port FROM the replicated sending component
 * @param outPort port TO the receiving compoonent
 * @param quorum
 */
export function createBFTConsolidatorComponent<E, P>(
  inPorts: Port<E, [P, number]>[],
  outPort: Port<E, [P, number]>,
  quorum: number,
  name?: string
): [
  AtomicComponent<E, [P, number]>,
  AbstractState<BFTConsolidatorState<P>, E, [P, number], undefined>
] {
  const step = (
    currentState: AbstractState<
      BFTConsolidatorState<P>,
      E,
      [P, number],
      undefined
    >
  ) => consolidateStep(currentState);

  const inQueues = new Map();
  inPorts.forEach((port) => inQueues.set(port.name[1], new Map()));

  return [
    {
      ports: [...inPorts, outPort].map((p) =>
        createPort(p.name, p.eventTypes, p.direction)
      ),
      step: step,
      allSteps: fp.compose(Array.from, step),
      prepareStateForSnapshot: (
        state: AbstractState<BFTConsolidatorState<P>, E, [P, number]> // Todo check if default serialization works for its AbstractState (Maps may cause problems)
      ): AbstractState<any, E, [P, number]> => state,
      prepareStateAfterRecovery: (
        state: AbstractState<any, E, [P, number]>
      ): AbstractState<BFTConsolidatorState<P>, E, [P, number]> => state,
      name: name !== undefined ? name : "BFT_Consolidator",
      tsType: "Component",
    },
    {
      state: {
        inPorts: inPorts.map((p) => p.name),
        outPort: outPort.name,
        quorum: quorum,
        lastAcceptedSequence: -1,
        inQueues: inQueues,
      },
      events: [],
      tsType: "State",
    },
  ];
}
