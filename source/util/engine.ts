import * as _ from "lodash";
import * as fp from "lodash/fp";

import { v4 as uuidv4 } from "uuid";
import { DirectedGraph } from "graphology";
import objectSorter from "node-object-hash/dist/objectSorter";
import * as xxhashjs from "xxhashjs";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { ReflectableType } from "./reflect";
import { KeyPairKeyObjectResult } from "crypto";
import { Just, Maybe, Nothing, withDefault } from "@typed/maybe";

sorrirLogger.configLogger({ area: "execution" });

export type EventClassOneWay = "oneway";
export type EventClassRequest = "request";
export type EventClassResolve = "resolve";
export type EventClassError = "error";

export type EventClass =
  | EventClassOneWay
  | EventClassRequest
  | EventClassResolve
  | EventClassError;

export type UUID = string;

export type EventSourceApplicationLayer = "ApplicationLayer";
export type EventSourceFrameworkLayer = "FrameworkLayer";

export const Internal = undefined;

export interface AbstractEvent<EVENT_TYPE, PORT_TYPE> {
  readonly eventClass: EventClass;
  readonly type: EVENT_TYPE;
  readonly port?: PORT_TYPE | typeof Internal;
  readonly timestamp?: number;
  readonly id: UUID;
}

export interface OneWayEvent<EVENT_TYPE, PORT_TYPE>
  extends AbstractEvent<EVENT_TYPE, PORT_TYPE> {
  readonly eventClass: EventClassOneWay;
  readonly param?: any;
}

export interface RequestEvent<EVENT_TYPE, PORT_TYPE>
  extends AbstractEvent<EVENT_TYPE, PORT_TYPE> {
  readonly eventClass: EventClassRequest;
  readonly param?: any;
}

export interface ResolveEvent<EVENT_TYPE, PORT_TYPE>
  extends AbstractEvent<EVENT_TYPE, PORT_TYPE> {
  readonly eventClass: EventClassResolve;
  readonly rc: number;
  readonly param?: any;
  readonly answerToRequestID: UUID;
}

export interface ErrorEvent<EVENT_TYPE, PORT_TYPE>
  extends AbstractEvent<EVENT_TYPE, PORT_TYPE> {
  readonly eventClass: EventClassError;
  readonly rc: number;
  readonly error: string;
  readonly answerToRequestID: UUID;
  readonly layer: EventSourceApplicationLayer | EventSourceFrameworkLayer;
}

export type Event<EVENT_TYPE, PORT_TYPE> =
  | OneWayEvent<EVENT_TYPE, PORT_TYPE>
  | RequestEvent<EVENT_TYPE, PORT_TYPE>
  | ResolveEvent<EVENT_TYPE, PORT_TYPE>
  | ErrorEvent<EVENT_TYPE, PORT_TYPE>;

export type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

export type EventWithoutID<EVENT_TYPE, PORT_TYPE> = DistributiveOmit<
  Event<EVENT_TYPE, PORT_TYPE>,
  "id"
>;

export type PortDirection = "in" | "out";

export type AbstractStateGenerator<
  STATE,
  EVENT_TYPE,
  PORT_TYPE,
  DEGRADATION_MODE = unknown
> = {
  readonly tsType: "StateGenerator";
  readonly argTypes: {
    [arg: string]: "string" | "number" | "boolean";
  };
  readonly generate: AbstractStateGeneratorFunction<
    STATE,
    EVENT_TYPE,
    PORT_TYPE,
    DEGRADATION_MODE
  >;
};

export type AbstractStateGeneratorFunction<
  STATE,
  EVENT_TYPE,
  PORT_TYPE,
  DEGRADATION_MODE = unknown
> = (
  args: Record<string, boolean | number | string>
) => AbstractState<STATE, EVENT_TYPE, PORT_TYPE, DEGRADATION_MODE>;

Function;

export interface AbstractState<
  STATE,
  EVENT_TYPE,
  PORT_TYPE,
  DEGRADATION_MODE = unknown
> extends ReflectableType {
  readonly state: STATE;
  readonly events: Event<EVENT_TYPE, PORT_TYPE>[];
  readonly operatingMode?: DEGRADATION_MODE;
  readonly degradationHistory?: [DEGRADATION_MODE, STATE][];
  readonly tsType: "State";
}

export type CloneStateFunction<E, P, D> = (
  currentState: AbstractState<any, E, P, D>
) => AbstractState<any, E, P, D>;

export interface DegradableState<STATE, EVENT_TYPE, PORT_TYPE, DEGRADATION_MODE>
  extends AbstractState<STATE, EVENT_TYPE, PORT_TYPE, DEGRADATION_MODE> {
  readonly operatingMode: DEGRADATION_MODE;
  readonly degradationHistory: [DEGRADATION_MODE, STATE][];
}

export type StateMachineStateGenerator<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE
> = AbstractStateGenerator<
  { fsm: DISCRETE_STATE; my: ABSTRACT_STATE },
  EVENT_TYPE,
  PORT_TYPE
>;

export type StateMachineState<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE
> = AbstractState<
  { fsm: DISCRETE_STATE; my: ABSTRACT_STATE },
  EVENT_TYPE,
  PORT_TYPE
>;

export type DegradableStateMachineState<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE,
  DEGRADATION_MODE
> = DegradableState<
  { fsm: DISCRETE_STATE; my: ABSTRACT_STATE },
  EVENT_TYPE,
  PORT_TYPE,
  DEGRADATION_MODE
>;

export interface InPort<EVENT_TYPE, PORT_TYPE>
  extends Port<EVENT_TYPE, PORT_TYPE> {
  readonly direction: "in";
}

export interface OutPort<EVENT_TYPE, PORT_TYPE>
  extends Port<EVENT_TYPE, PORT_TYPE> {
  readonly direction: "out";
}

export interface Port<EVENT_TYPE, PORT_TYPE> {
  readonly name: PORT_TYPE;
  readonly eventTypes: EVENT_TYPE[];
  readonly direction: PortDirection;
}

export function createPort<EVENT_TYPE, PORT_TYPE>(
  name: PORT_TYPE,
  eventTypes: EVENT_TYPE[],
  direction: PortDirection
): InPort<EVENT_TYPE, PORT_TYPE> | OutPort<EVENT_TYPE, PORT_TYPE> {
  return {
    name: name,
    eventTypes: eventTypes,
    direction: direction,
  };
}

export type RaiseEventCallBack<EVENT_TYPE, PORT_TYPE> = (
  newEvent: EventWithoutID<EVENT_TYPE, PORT_TYPE>
) => UUID | undefined;

export type Action<ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE, EVENT> = (
  myState: ABSTRACT_STATE,
  raiseEvent: RaiseEventCallBack<EVENT_TYPE, PORT_TYPE>,
  event?: EVENT
) => ABSTRACT_STATE;

export type Transition<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE> =
  | OneWayTransition<
      DISCRETE_STATE,
      ABSTRACT_STATE,
      EVENT_TYPE,
      PORT_TYPE,
      OneWayEvent<EVENT_TYPE, PORT_TYPE>
    >
  | RequestTransition<
      DISCRETE_STATE,
      ABSTRACT_STATE,
      EVENT_TYPE,
      PORT_TYPE,
      RequestEvent<EVENT_TYPE, PORT_TYPE>
    >
  | ResolveTransition<
      DISCRETE_STATE,
      ABSTRACT_STATE,
      EVENT_TYPE,
      PORT_TYPE,
      ResolveEvent<EVENT_TYPE, PORT_TYPE>
    >
  | ErrorTransition<
      DISCRETE_STATE,
      ABSTRACT_STATE,
      EVENT_TYPE,
      PORT_TYPE,
      ErrorEvent<EVENT_TYPE, PORT_TYPE>
    >;

export interface AbstractTransition<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE,
  EVENT extends Event<EVENT_TYPE, PORT_TYPE>
> {
  readonly sourceState: DISCRETE_STATE;
  readonly event?: [EventClass, EVENT_TYPE, PORT_TYPE?];
  readonly condition?: (myState: ABSTRACT_STATE, event?: EVENT) => boolean;
  readonly action?: Action<ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE, EVENT>;
  readonly targetState: DISCRETE_STATE;
}

export interface OneWayTransition<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE,
  EVENT extends OneWayEvent<EVENT_TYPE, PORT_TYPE>
> extends AbstractTransition<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE,
    EVENT
  > {
  event?: [EventClassOneWay, EVENT_TYPE, PORT_TYPE?];
}

export interface RequestTransition<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE,
  EVENT extends RequestEvent<EVENT_TYPE, PORT_TYPE>
> extends AbstractTransition<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE,
    EVENT
  > {
  event?: [EventClassRequest, EVENT_TYPE, PORT_TYPE?];
}

export interface ResolveTransition<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE,
  EVENT extends ResolveEvent<EVENT_TYPE, PORT_TYPE>
> extends AbstractTransition<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE,
    EVENT
  > {
  event?: [EventClassResolve, EVENT_TYPE, PORT_TYPE?];
}

export interface ErrorTransition<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE,
  EVENT extends ErrorEvent<EVENT_TYPE, PORT_TYPE>
> extends AbstractTransition<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE,
    EVENT
  > {
  event?: [EventClassError, EVENT_TYPE, PORT_TYPE?];
}

export interface StateMachine<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE
> {
  readonly transitions: Transition<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE
  >[];
  readonly cloneStateFunction?: CloneStateFunction<
    EVENT_TYPE,
    PORT_TYPE,
    unknown
  >;
}

export function eventExists<EVENT_TYPE, PORT_TYPE>(
  events: Event<EVENT_TYPE, PORT_TYPE>[],
  event: [EventClass, EVENT_TYPE, PORT_TYPE?] | undefined
): Event<EVENT_TYPE, PORT_TYPE> | undefined {
  if (!event) {
    return undefined;
  }

  return events.filter(
    (e) =>
      _.isEqual(event[0], e.eventClass) &&
      _.isEqual(event[1], e.type) &&
      _.isEqual(event[2], e.port)
  )[0];
}

export function consumeEvent<EVENT_TYPE, PORT_TYPE>(
  events: Event<EVENT_TYPE, PORT_TYPE>[],
  event: [EventClass, EVENT_TYPE, PORT_TYPE?] | undefined
): Event<EVENT_TYPE, PORT_TYPE>[] {
  let eventFound = false;
  sorrirLogger.debug(Stakeholder.SYSTEM, "eventQueue before consuming", {
    events: events,
  });
  const newEvents = events.filter((e) => {
    const include =
      eventFound ||
      event === undefined ||
      !_.isEqual(event[0], e.eventClass) ||
      !_.isEqual(event[1], e.type) ||
      !_.isEqual(event[2], e.port);
    eventFound =
      eventFound ||
      event === undefined ||
      (_.isEqual(event[0], e.eventClass) &&
        _.isEqual(event[1], e.type) &&
        _.isEqual(event[2], e.port));
    return include;
  });
  sorrirLogger.debug(Stakeholder.SYSTEM, "eventQueue after consuming", {
    events: newEvents,
  });
  return newEvents;
}

export function stateHash<STATE>(state: STATE): number {
  const buf = Buffer.from(objectSorter({ sort: false, coerce: false })(state));
  return xxhashjs.h32(buf, 0xcafecafe).toNumber();
}

// function myHash<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>(state:StateMachineState<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>):number {
// 	return 1;
// }

export function stateSpace<O, STATE>(
  sm: O,
  currentState: STATE,
  allNextSteps: (o: O, s: STATE) => STATE[],
  maxStates = 10
): DirectedGraph {
  let stateIDCounter = 0;
  const statespace = new DirectedGraph();
  const statesToProcess: Array<[STATE, number]> = [
    [currentState, stateIDCounter],
  ];
  const stateHashes = new Map<number, number[]>();
  statespace.addNode(stateIDCounter, { state: currentState });
  stateHashes.set(stateHash(currentState), [stateIDCounter]);

  while (statesToProcess.length > 0 && stateHashes.size < maxStates) {
    const x = statesToProcess.pop();
    if (x !== undefined) {
      const [s, stateID] = x;
      const newStates = allNextSteps(sm, s);
      newStates.forEach((newState) => {
        const newHash = stateHash(newState);
        let mergedWithExistingState = false;
        if (stateHashes.has(newHash)) {
          for (const existingStateID of stateHashes.get(newHash) as number[]) {
            if (
              _.isEqual(
                newState,
                statespace.getNodeAttribute(existingStateID, "state")
              )
            ) {
              // existing node, just add dependency to existing state
              statespace.addDirectedEdge(stateID, existingStateID);
              //logger.debug(`existing: ${statespace.getNodeData(stateID.toString()).state.my} => ${statespace.getNodeData(existingStateID.toString()).state.my}`);
              mergedWithExistingState = true;
              break;
            }
          }
        }
        if (mergedWithExistingState === false) {
          stateIDCounter++;
          //logger.debug(`new state ${newState.state.my}`);
          statesToProcess.push([newState, stateIDCounter]);
          const existingHashes = stateHashes.get(newHash);
          if (existingHashes !== undefined) {
            stateHashes.set(newHash, [stateIDCounter].concat(existingHashes));
          } else {
            stateHashes.set(newHash, [stateIDCounter]);
          }
          statespace.addNode(stateIDCounter, { state: newState });
          statespace.addDirectedEdge(stateID, stateIDCounter);
          //logger.debug(`${statespace.getNodeData(stateID.toString()).state.my} => ${statespace.getNodeData(stateIDCounter.toString()).state.my}`);
        }
      });
    }
  }
  return statespace;
}

export function allSteps<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>(
  sm: StateMachine<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>,
  currentState: StateMachineState<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE
  >
): StateMachineState<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>[] {
  const newStates: StateMachineState<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE
  >[] = [];
  for (const t of sm.transitions) {
    if (transitionEnabled(currentState, t)) {
      newStates.push(
        executeTransition(currentState, t, sm.cloneStateFunction ?? _.cloneDeep)
      );
    }
  }
  // no new state --> we stay in the current State
  if (newStates.length === 0) {
    newStates.push((sm.cloneStateFunction ?? _.cloneDeep)(currentState));
  }
  return newStates;
}

/**
 * Checks if the event triggers an transition from the current state
 *
 * @param currentState current state
 * @param t transition
 * @returns true if the event fits the criteria of the transition
 */
export function transitionEnabled<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE
>(
  currentState: StateMachineState<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE
  >,
  t: Transition<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>
): boolean {
  const toBeConsumedEvent = eventExists(currentState.events, t.event);
  return (
    t.sourceState === currentState.state.fsm &&
    (t.condition === undefined ||
      t.condition(currentState.state.my, <undefined>toBeConsumedEvent)) &&
    (t.event === undefined || toBeConsumedEvent !== undefined)
  );
}

function executeTransition<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE
>(
  currentState: StateMachineState<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE
  >,
  t: Transition<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>,
  cloneFunction: CloneStateFunction<EVENT_TYPE, PORT_TYPE, unknown>
): StateMachineState<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE> {
  const newState = cloneFunction(currentState);
  const toBeConsumedEvent = eventExists(newState.events, t.event);
  const toBeRaisedEvents: Event<EVENT_TYPE, PORT_TYPE>[] = [];
  const raiseEvent = (event: EventWithoutID<EVENT_TYPE, PORT_TYPE>) => {
    if (event.eventClass === undefined || event.type === undefined) {
      sorrirLogger.error(
        Stakeholder.SYSTEM,
        "Event is missing parameters, cannot be raised",
        {
          missingFields: [
            ...(!event.eventClass ? ["eventClass"] : []),
            ...(!event.type ? ["type"] : []),
          ],
        }
      );
    } else {
      const uuid = uuidv4();
      toBeRaisedEvents.push({ ..._.cloneDeep(event), id: uuid });
      return uuid;
    }
  };

  if (t.action !== undefined) {
    newState.state.my = t.action(
      newState.state.my,
      raiseEvent,
      <undefined>toBeConsumedEvent
    );
  }

  // typecast to make compiler ready since events is read-only in the type
  (newState.events as any) = consumeEvent(
    newState.events,
    toBeConsumedEvent && [
      toBeConsumedEvent.eventClass,
      toBeConsumedEvent.type,
      toBeConsumedEvent.port,
    ]
  ).concat(toBeRaisedEvents);
  newState.state.fsm = t.targetState;
  return newState;
}

/**
 * If state machine can switch, function returns new state, undefined otherwise.
 * @param sm
 * @param currentState
 */
export function step<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>(
  sm: StateMachine<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>,
  currentState: StateMachineState<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE
  >
): Maybe<
  StateMachineState<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>
> {
  sorrirLogger.debug(Stakeholder.SYSTEM, "state before step", {
    currentState: currentState,
  });
  let state:
    | StateMachineState<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>
    | undefined = undefined;

  for (const transition of sm.transitions) {
    if (transitionEnabled(currentState, transition)) {
      state = executeTransition(
        currentState,
        transition,
        sm.cloneStateFunction ?? _.cloneDeep
      );
      sorrirLogger.debug(Stakeholder.SYSTEM, "", { newState: state });
      return Just.of(state);
    }
  }

  return Nothing;
}

/**
 * Step function used for testing purposes. Instead of returning undefined if the component cannot switch,
 * the old state is returned.
 * @param sm
 * @param currentState
 */
export function singleStep<
  DISCRETE_STATE,
  ABSTRACT_STATE,
  EVENT_TYPE,
  PORT_TYPE
>(
  sm: StateMachine<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>,
  currentState: StateMachineState<
    DISCRETE_STATE,
    ABSTRACT_STATE,
    EVENT_TYPE,
    PORT_TYPE
  >
): StateMachineState<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE> {
  let newState = { ...currentState };
  newState = withDefault(newState, step(sm, currentState));
  return newState;
}

const getBody = (body: string) => {
  return body.substring(_.indexOf(body, "{"), _.lastIndexOf(body, "}") + 1);
};

function transitionLabel<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>(
  transition: Transition<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>
): string {
  const functionBody = getBody("" + transition.action);
  return functionBody;
}

function conditionLabel<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>(
  transition: Transition<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>
): string {
  const functionBody = getBody("" + transition.condition);
  return functionBody;
}

export function toDot<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>(
  sm: StateMachine<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>
): string {
  return (
    "digraph {\n" +
    sm.transitions
      .map(
        (t) =>
          t.sourceState +
          " -> " +
          t.targetState +
          ' [ taillabel="[' +
          conditionLabel(t) +
          "] /\\n " +
          transitionLabel(t) +
          '"];'
      )
      .join("\n") +
    "\n" +
    "}\n"
  );
}

export function depGraphToDot(graph: DirectedGraph): string {
  function replacer(
    this: Record<string, unknown>,
    key: string,
    value: unknown
  ) {
    const originalObject = this[key];
    if (originalObject instanceof Map) {
      return Array.from(originalObject.entries()).map(([key, value], index) => [
        key.name,
        value,
      ]);
    } else {
      return value;
    }
  }

  function stateLabel(nodeData: Map<Record<string, unknown>, unknown>): string {
    const result = Array.from(nodeData).map(([k, v]) => {
      return `{ ${k.name}| ${escape(JSON.stringify(v, replacer, 2))}}`;
    });
    return result.join("|");
  }

  const removeApp = (s: string) => s.replace(/"/g, "");
  const replaceNewline = (s: string) => s.replace(/\n/g, "\\l");
  const escapeBrackes = (s: string) =>
    s.replace(/{/g, "\\{").replace(/}/g, "\\}");
  const escape = fp.compose(removeApp, replaceNewline, escapeBrackes);

  const nodes = graph.nodes();
  let out = `digraph {\n
		node [shape = record
			fontname = "Courier" ];
		 ${nodes
       .map(
         (n) =>
           n +
           ' [label="' +
           stateLabel(graph.getNodeAttribute(n, "state").componentState) +
           '"]'
       )
       .join("\n")} \n
		 `;
  graph.forEachOutEdge((edge, attr, source, target) => {
    out = out + `${source} -> ${target}\n`;
  });
  return out + "}\n";
}

export function toTGF<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>(
  sm: StateMachine<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>
): string {
  const nodes = sm.transitions
    .map((t) => t.sourceState)
    .concat(sm.transitions.map((t) => t.targetState))
    .filter((e, index, self) => index === self.indexOf(e));

  let result = "";
  for (let i = 0; i < nodes.length; i++) {
    result = result + `${i} ${nodes[i]}\n`;
  }
  result = result + "#\n";

  const normalizeWhiteSpace = (s: string) => s.replace(/\s+/g, " ");

  return (
    result +
    sm.transitions
      .map(
        (t) =>
          nodes.indexOf(t.sourceState) +
          " " +
          nodes.indexOf(t.targetState) +
          " " +
          normalizeWhiteSpace(conditionLabel(t)) +
          "] / " +
          normalizeWhiteSpace(transitionLabel(t)) +
          ""
      )
      .join("\n") +
    "\n"
  );
}

// THIS does not work right now
/*export function toGraphML<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>(sm: StateMachine<DISCRETE_STATE, ABSTRACT_STATE, EVENT_TYPE, PORT_TYPE>) : string
{


  return `<graphml xmlns="http://graphml.graphdrawing.org/xmlns"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns
    http://www.yworks.com/xml/schema/graphml/1.1/ygraphml.xsd"
  xmlns:y="http://www.yworks.com/xml/graphml">
<key id="d0" for="node" yfiles.type="nodegraphics"/>
<key id="d1" for="edge" yfiles.type="edgegraphics"/>
     <graph id="graph" edgedefault="directed">
     ` + sm.transitions.map(t => t.sourceState).concat(sm.transitions.map(t => t.targetState)).map(
       s => `<node key="d0" id="${s}">
       <data key="d0">
       <y:ShapeNode>
         <y:Fill color="#FFFFFF" transparent="true"/>
         <y:BorderStyle type="line" width="1.0" color="#000000"/>
         <y:NodeLabel>${s}</y:NodeLabel>
         <y:Shape type="ellipse"/>
       </y:ShapeNode>
       </data>
       </node>
       \n`).join("")
     + sm.transitions.map(t => `<edge key="d1" id="${""+t.sourceState+t.targetState}" source="${t.sourceState}" target="${t.targetState}" >\n
        <data key="d1">
      <y:Label.Text>${conditionLabel(t)} /\n  ${transitionLabel(t)}</y:Label.Text>
      </data>
      </edge>`).join("")
       + "</graph>\n</graphml>";
}*/
