import { AbstractState, AtomicComponent, createPort, Event, Port } from "../..";
import * as fp from "lodash/fp";
import * as _ from "lodash";
import { Maybe, Just, Nothing } from "@typed/maybe";

export type CFTConsolidatorState<P> = {
  readonly inPorts: [P, number][];
  readonly outPort: [P, number];
  lastAcceptedSequence: number; // used to reject duplicated events from replicas sent over different ports
};

/**
 * Implementation of the CFT Consolidator: accept first event obtained for a specific sequence number
 *
 * @param state
 */
function consolidateStep<E, P>(
  state: AbstractState<CFTConsolidatorState<P>, E, [P, number], undefined>
): Maybe<AbstractState<CFTConsolidatorState<P>, E, [P, number], undefined>> {
  const newState: AbstractState<
    CFTConsolidatorState<P>,
    E,
    [P, number],
    undefined
  > = {
    state: _.cloneDeep(state.state),
    events: [],
    tsType: "State",
  };

  let hasChanged = false;

  let lastAcceptedSeq = state.state.lastAcceptedSequence;

  // in event queue only contains "fresh" events of IN-Ports and these events get ordered by their sequence nr
  const inEventQueue = state.events
    .filter(
      (e) =>
        e.timestamp !== undefined &&
        e.timestamp > lastAcceptedSeq &&
        e.port &&
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

  // separate out queue
  const outEventQueue: Event<E, [P, number]>[] = state.events.filter(
    (e) => e.port && e.port[0] === state.state.outPort[0]
  );

  // Begin the consolidation loop: accept fresh events one after another sorted by sequence, do not accept any out-of-order
  // events. Accept only once.
  const accepted: Event<E, [P, number]>[] = [];
  inEventQueue.forEach((event) => {
    // Todo Revise the exact behavior of this loop
    if (event.timestamp !== undefined && event.timestamp > lastAcceptedSeq) {
      accepted.push({
        ...event,
        port: state.state.outPort,
        timestamp: event.timestamp,
      } as Event<E, [P, number]>);
      lastAcceptedSeq = event.timestamp;
      newState.state.lastAcceptedSequence = event.timestamp;
      hasChanged = true;
    }
  });

  newState.events.push(...outEventQueue, ...accepted);

  if (newState.events.length !== state.events.length) {
    hasChanged = true;
  }

  return hasChanged ? Just.of(newState) : Nothing;
}

/**
 * Create a new instance of a CFT Consolidator component
 *
 * @param inPorts port FROM the replicated sending component
 * @param outPort port TO the receiving compoonent
 */
export function createCFTConsolidatorComponent<E, P>(
  inPorts: Port<E, [P, number]>[],
  outPort: Port<E, [P, number]>,
  name?: string
): [
  AtomicComponent<E, [P, number], undefined>,
  AbstractState<CFTConsolidatorState<P>, E, [P, number], undefined>
] {
  const step = (
    currentState: AbstractState<
      CFTConsolidatorState<P>,
      E,
      [P, number],
      undefined
    >
  ): Maybe<AbstractState<CFTConsolidatorState<P>, E, [P, number], undefined>> =>
    consolidateStep(currentState);

  return [
    {
      ports: [...inPorts, outPort].map((p) =>
        createPort(p.name, p.eventTypes, p.direction)
      ),
      step: step,
      allSteps: fp.compose(Array.from, step),
      prepareStateForSnapshot: (
        state: AbstractState<CFTConsolidatorState<P>, E, [P, number]>
      ): AbstractState<any, E, [P, number]> => state,
      prepareStateAfterRecovery: (
        state: AbstractState<any, E, [P, number]>
      ): AbstractState<CFTConsolidatorState<P>, E, [P, number]> => state,
      name: name !== undefined ? name : "CFT_Consolidator",
      tsType: "Component",
    },
    {
      state: {
        inPorts: inPorts.map((p) => p.name),
        outPort: outPort.name,
        lastAcceptedSequence: -1,
      },
      events: [],
      tsType: "State",
    },
  ];
}
