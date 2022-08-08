import { v4 as uuidv4 } from "uuid";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { WebSocketServer, WebSocket } from "ws";
import _ = require("lodash");
import {
  AgentComponent,
  ClockStates,
  computeConnectionsFromLocalToExternal,
  computeLocallyDeployedConfiguration,
  ConfigurationState,
  DefaultShadowMode,
} from "..";
import {
  commEngineCommunicate,
  executeAndCommunicate,
  outDemux,
} from "../communication/comm-engine";
import { DebuggingAgentConfig, RunConfiguration } from "../exec-types";
import {
  AtomicComponent,
  Connection,
  createStatemachineComponent,
} from "../util/component";
import {
  AbstractState,
  Event,
  Internal,
  OneWayEvent,
  PortDirection,
  RaiseEventCallBack,
  RequestEvent,
  ResolveEvent,
  stateHash,
  StateMachine,
  StateMachineState,
  Transition,
} from "../util/engine";
import { isJust, fromJust } from "@typed/maybe";
import {
  DebuggingAgentWebSocketConfigurationState,
  DebuggingAgentWebSocketInjectMessage,
  DebuggingAgentWebSocketInjectMessageJSONSchema,
  EnqueueEventMessage,
  SendExternalMessage,
} from "@sorrir/sorrir-framework-interface";
import Ajv, { ValidateFunction } from "ajv";
import axios from "axios";
import { encodeEvent } from "../communication/encoding";

export const debuggingAgentName = "debugging-agent";

export enum DebuggingAgentEventTypeExternal {
  PUSH_TO_SERVER = "PUSH_TO_SERVER",
  CONTROL_TO_CLIENT = "CONTROL_TO_CLIENT",
}

export enum DebuggingAgentEventTypeInternal {
  DO_PUSH_TO_SERVER = "DO_PUSH_TO_SERVER",
}

export enum DebuggingAgentPort {
  // client ports
  DATA_OUT = "DATA_OUT",
  CONTROL_IN = "CONTROL_IN",
  // server ports
  DATA_IN = "DATA_IN",
  CONTROL_OUT = "CONTROL_OUT",
}

export type DebuggingAgentStateInternal = {
  linkedRunConfig: RunConfiguration;
  linkedDebuggingAgentConfig: DebuggingAgentConfig | undefined;
  componentStates: Record<string, AbstractState<unknown, unknown, unknown>>;
  wss?: WebSocketServer;
  wsSchemaValidationFuncion?: ValidateFunction<unknown>;
};

// events
interface DebuggingAgentPushToServerEvent
  extends OneWayEvent<DebuggingAgentEventTypeExternal.PUSH_TO_SERVER, any> {
  param: {
    componentState: Record<string, AbstractState<unknown, unknown, unknown>>;
  };
}
interface DebuggingAgentPushToServerResolveEvent
  extends ResolveEvent<DebuggingAgentEventTypeExternal.PUSH_TO_SERVER, any> {
  param: {
    componentState: Record<string, AbstractState<unknown, unknown, unknown>>;
  };
}

interface DebuggingAgentControlToClientEvent
  extends OneWayEvent<
    DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
    any
  > {
  param?: {
    evt: DebuggingAgentWebSocketInjectMessage;
  };
}

/**
 * Start state of the debugging agent
 */
const debuggingAgentStartStateGenerator: (
  runConfig: RunConfiguration
) => StateMachineState<
  any,
  DebuggingAgentStateInternal,
  DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
  DebuggingAgentPort
> = (runConfig: RunConfiguration) => {
  return {
    state: {
      fsm: undefined,
      my: {
        componentStates: {},
        linkedDebuggingAgentConfig: undefined,
        linkedRunConfig: runConfig,
      },
    },
    events: [],
    tsType: "State",
  };
};

/**
 * Helper function the transform the component state embedded in
 * the RunConfiguration so it can be sent via push events.
 *
 * @param componentState the component state
 * @returns
 */
export function transformComponentState(
  componentState: Map<
    AtomicComponent<any, any, any>,
    AbstractState<any, any, any, any>
  >
): Record<string, unknown> {
  return _.reduce(
    Array.from(componentState.entries()),
    (acc, [component, state]) => {
      // ignore agents
      if ((component as AgentComponent<any, any>).isAgent === true) {
        return acc;
      }
      acc[component.name] = state;
      return acc;
    },
    {}
  );
}

function createWebSocketMessage(
  internalState: DebuggingAgentStateInternal
): DebuggingAgentWebSocketConfigurationState {
  const confState: DebuggingAgentWebSocketConfigurationState = {
    units: _.keys(internalState.linkedRunConfig.deploymentConfiguration),
    components: _.map(
      internalState.linkedRunConfig?.lsa.components.filter(
        (c) =>
          c.name !== debuggingAgentName && internalState.componentStates[c.name]
      ),
      (c) => ({
        unit:
          _.find(
            _.keys(internalState.linkedRunConfig.deploymentConfiguration),
            (unit) =>
              internalState.linkedRunConfig.deploymentConfiguration[
                unit
              ].components.includes(c)
          ) ?? "", // empty if not found, should not happen
        name: c.name,
        state: internalState.componentStates[c.name]?.state,
        operatingMode:
          internalState.linkedRunConfig.engineRoomState.shadowMap.get(
            c.id ?? c.name
          )?.mode ?? DefaultShadowMode.UNREACHABLE,
        events: _.map(
          internalState.componentStates[c.name]?.events,
          (e) => e.type
        ),
        ports: _.map(c.ports, (p) => ({
          name: p.name instanceof Array ? p.name.join() : p.name,
          eventTypes: p.eventTypes.map((e) => e),
        })),
      })
    ),
    connections: _.map(
      internalState.linkedRunConfig?.lsa.connections.filter(
        (conn) =>
          (conn.source.sourceComponent.name !== debuggingAgentName ||
            conn.target.targetComponent.name !== debuggingAgentName) &&
          internalState.componentStates[conn.source.sourceComponent.name] &&
          internalState.componentStates[conn.target.targetComponent.name]
      ),
      (conn) => ({
        source: [
          conn.source.sourceComponent.name,
          conn.source.sourcePort.name instanceof Array
            ? conn.source.sourcePort.name.join()
            : conn.source.sourcePort.name,
        ],
        target: [
          conn.target.targetComponent.name,
          conn.target.targetPort.name instanceof Array
            ? conn.target.targetPort.name.join()
            : conn.target.targetPort.name,
        ],
      })
    ),
  };

  return confState;
}

function sendWebSocketPacket(internalState: DebuggingAgentStateInternal) {
  if (internalState.wss) {
    sorrirLogger.debug(
      Stakeholder.SYSTEM,
      "debugging server. sending websocket packet.",
      {
        linkedRunConfig: internalState.linkedRunConfig,
        componentStates: internalState.componentStates,
      }
    );

    // integrate local component states with the exception of debugging agent
    internalState.linkedRunConfig?.confState.componentState.forEach(
      (state, comp, map) => {
        if (!(comp as AgentComponent<any, any>).isAgent) {
          internalState.componentStates[comp.name] = state;
        }
      }
    );

    internalState.wss.clients.forEach(function each(client) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(createWebSocketMessage(internalState)));
      }
    });
  }
}

/**
 * Returns a transition to consume an incoming push event.
 *
 * Stores the incoming component states into the internal state.
 *
 * @param eventClass the event class of the event to be consumed
 * @returns the transition
 */
function getConsumePushFromClientEventTransition<
  PushEventClass extends "resolve" | "oneway"
>(eventClass: PushEventClass) {
  return {
    sourceState: undefined,
    targetState: undefined,
    event: <any>[
      eventClass,
      DebuggingAgentEventTypeExternal.PUSH_TO_SERVER,
      DebuggingAgentPort.DATA_IN,
    ],
    action: (
      internalState: DebuggingAgentStateInternal,
      raiseEvent: RaiseEventCallBack<DebuggingAgentEventTypeExternal, any>,
      event?: PushEventClass extends "oneway"
        ? OneWayEvent<
            DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
            any
          >
        : ResolveEvent<
            DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
            any
          >
    ) => {
      if (event !== undefined) {
        const pushEvent = event as PushEventClass extends "oneway"
          ? DebuggingAgentPushToServerEvent
          : DebuggingAgentPushToServerResolveEvent;
        if (
          internalState.linkedRunConfig !== undefined &&
          pushEvent.param.componentState !== undefined
        ) {
          //integrate component states from debugging agent
          Object.entries(pushEvent.param.componentState).forEach(
            ([component, state]) => {
              internalState.componentStates[component] = state;
            }
          );

          sendWebSocketPacket(internalState);
        }
      }
      return internalState;
    },
  };
}

const createInternalPushToServer = (): Transition<
  typeof Internal,
  DebuggingAgentStateInternal,
  DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
  DebuggingAgentPort
> => {
  return {
    sourceState: undefined,
    targetState: undefined,
    event: [
      "oneway",
      DebuggingAgentEventTypeInternal.DO_PUSH_TO_SERVER,
      Internal,
    ],
    action: (
      internalState: DebuggingAgentStateInternal,
      raiseEvent: RaiseEventCallBack<
        DebuggingAgentEventTypeExternal,
        DebuggingAgentPort
      >
    ) => {
      if (
        internalState.linkedRunConfig !== undefined &&
        internalState.linkedDebuggingAgentConfig !== undefined
      ) {
        raiseEvent({
          eventClass: "oneway",
          type: DebuggingAgentEventTypeExternal.PUSH_TO_SERVER,
          port: DebuggingAgentPort.DATA_OUT,
          param: {
            componentState: transformComponentState(
              internalState.linkedRunConfig.confState.componentState
            ),
          },
        } as Omit<DebuggingAgentPushToServerEvent, "id">);
      }
      return internalState;
    },
  };
};

const createConsumeEventFromServer = (): Transition<
  typeof Internal,
  DebuggingAgentStateInternal,
  DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
  DebuggingAgentPort
> => {
  return {
    sourceState: undefined,
    targetState: undefined,
    event: [
      "oneway",
      DebuggingAgentEventTypeExternal.CONTROL_TO_CLIENT,
      DebuggingAgentPort.CONTROL_IN,
    ],
    action: (
      internalState: DebuggingAgentStateInternal,
      raiseEvent: RaiseEventCallBack<
        DebuggingAgentEventTypeExternal,
        DebuggingAgentPort
      >,
      event?: DebuggingAgentControlToClientEvent
    ) => {
      sorrirLogger.debug(
        Stakeholder.SYSTEM,
        "consume DebuggingAgentControlToClientEvent",
        { event: event }
      );
      if (
        event &&
        event.param &&
        event.param.evt.unit === internalState.linkedRunConfig.toExecute
      ) {
        const msg = event.param.evt;
        if (!internalState.wsSchemaValidationFuncion) {
          const ajv = new Ajv(); // options can be passed, e.g. {allErrors: true}
          internalState.wsSchemaValidationFuncion = ajv.compile(
            DebuggingAgentWebSocketInjectMessageJSONSchema
          );
        }
        processWebSocketIncomingMessage(
          internalState.linkedRunConfig,
          internalState.wsSchemaValidationFuncion,
          msg
        );
      }
      return internalState;
    },
  };
};

/**
 * Returns the component of the debugging agent, to be called from
 * setup-agents.ts
 *
 * @param isServer specifies if the given agent shall be a server
 * @returns
 */
export function getDebuggingAgentComponent(
  runConfig: RunConfiguration,
  isServer: boolean
): {
  debuggingAgent: AgentComponent<
    DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
    DebuggingAgentPort
  >;
  debuggingAgentStartState: StateMachineState<
    undefined,
    DebuggingAgentStateInternal,
    DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
    DebuggingAgentPort
  >;
} {
  const sm: StateMachine<
    undefined,
    DebuggingAgentStateInternal,
    DebuggingAgentEventTypeExternal | DebuggingAgentEventTypeInternal,
    DebuggingAgentPort
  > = {
    transitions: [
      /*
       * push, triggered internally
       */
      createInternalPushToServer(),
      /*
       * consume incoming push from client events
       */
      getConsumePushFromClientEventTransition("resolve"),
      getConsumePushFromClientEventTransition("oneway"),
      /*
       * consume incoming control from client events
       */
      createConsumeEventFromServer(),
    ],
    cloneStateFunction: (x) =>
      _.cloneDeepWith(x, (value, key) =>
        // we do not clone those but instead copy them by reference
        // e.g. cloning the websocketserver wss does not work
        (
          [
            "wss",
            "linkedRunConfig",
            "wsSchemaValidationFuncion",
            "linkedDebuggingAgentConfig",
          ] as (string | number | undefined)[]
        ).includes(key)
          ? value
          : undefined
      ),
  };

  const debuggingAgent = {
    ...createStatemachineComponent(
      [
        ...(isServer
          ? // server ports
            [
              {
                name: DebuggingAgentPort.DATA_IN,
                eventTypes: Object.values(DebuggingAgentEventTypeExternal),
                direction: <PortDirection>"in",
              },
              {
                name: DebuggingAgentPort.CONTROL_OUT,
                eventTypes: Object.values(DebuggingAgentEventTypeExternal),
                direction: <PortDirection>"out",
              },
            ]
          : // client ports
            [
              {
                name: DebuggingAgentPort.CONTROL_IN,
                eventTypes: Object.values(DebuggingAgentEventTypeExternal),
                direction: <PortDirection>"in",
              },
              {
                name: DebuggingAgentPort.DATA_OUT,
                eventTypes: Object.values(DebuggingAgentEventTypeExternal),
                direction: <PortDirection>"out",
              },
            ]),
      ],
      sm,
      debuggingAgentName
    ),
    isAgent: <const>true,
  };

  const state = debuggingAgentStartStateGenerator(runConfig);
  state.state.my.linkedDebuggingAgentConfig =
    runConfig.debuggingConfiguration?.[runConfig.toExecute].debuggingAgent;

  return {
    debuggingAgent: debuggingAgent,
    debuggingAgentStartState: state,
  };
}

export function getDebuggingAgentAndConnections(runConfig: RunConfiguration):
  | {
      debuggingAgent: AtomicComponent<any, any, any>;
      outgoingConnections: Connection<any>[];
    }
  | undefined {
  // get the debugging agent

  let debuggingAgent: AtomicComponent<any, any, any> | undefined = undefined;
  for (const comp of runConfig.confState.componentState.keys()) {
    if (comp.name === debuggingAgentName) debuggingAgent = comp;
  }

  // check for internal errors
  if (debuggingAgent === undefined || debuggingAgent.tsType !== "Component") {
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "Debugging Agent could not be referenced.",
      {}
    );
    return;
  }

  const outgoingConnections = _.filter(
    runConfig.lsa.connections,
    (connection: Connection<any>) =>
      connection.source.sourceComponent === debuggingAgent
  );

  // check if there are any outgoing connections
  if (outgoingConnections.length === 0) {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Debugging Agent has no outgoing connections. Auto-update disabled.",
      { unit: runConfig.toExecute }
    );
    return;
  }

  return {
    debuggingAgent: debuggingAgent,
    outgoingConnections: outgoingConnections,
  };
}

/**
 * Push an event into the event queue and step to completion
 *
 * @param runConfig
 * @param debuggingAgent
 * @param eventType
 * @param outgoingConnections
 * @param param
 */
function performEvent(
  runConfig: RunConfiguration,
  debuggingAgent: AtomicComponent<any, any, undefined>,
  eventType: DebuggingAgentEventTypeInternal,
  outgoingConnections: Connection<any>[],
  param?: Record<string, unknown>
) {
  {
    // push an event into the queue
    runConfig.confState.componentState.get(debuggingAgent)?.events.push({
      eventClass: "oneway",
      type: eventType,
      port: Internal,
      id: "",
      ...(param !== undefined ? { param: param } : {}),
    });

    // step to completion
    const oldState = runConfig.confState.componentState.get(debuggingAgent);
    if (oldState === undefined) {
      sorrirLogger.error(
        Stakeholder.SYSTEM,
        "State of debugging agent is undefined. Cannot perform event.",
        {
          eventType: eventType,
        }
      );
      return;
    }
    let newState = debuggingAgent.step(oldState);
    while (isJust(newState)) {
      runConfig.confState.componentState.set(
        debuggingAgent,
        fromJust(newState)
      );
      commEngineCommunicate(runConfig, outgoingConnections);
      newState = debuggingAgent.step(fromJust(newState));
    }
  }
}

/**
 * Make the debugging agent perform an event.
 *
 * Does this by placing an internal event in the event queue of the
 * agent and stepping to completion after.
 *
 * @param runConfig the RunConfiguration
 * @param eventType specifies which action the agent shall perform
 * @param param optional parameters, if the event type requires them
 */
export function debuggingAgentPerformEvent(
  runConfig: RunConfiguration,
  eventType: DebuggingAgentEventTypeInternal,
  param?: Record<string, unknown>
): void {
  const res = getDebuggingAgentAndConnections(runConfig);
  if (res === undefined) return;
  const { debuggingAgent, outgoingConnections } = res;
  performEvent(
    runConfig,
    debuggingAgent,
    eventType,
    outgoingConnections,
    param
  );
}

const configurationStateWithoutDebuggingAgent = (
  confState: ConfigurationState
) => {
  const states: AbstractState<unknown, unknown, unknown, unknown>[] = [];
  for (const [comp, state] of confState.componentState.entries()) {
    if (comp.name !== debuggingAgentName) states.push(state);
  }
  return states;
};

/**
 * Starts the debugging agent. To be called from
 * agents.ts
 *
 * @param runConfig the RunConfiguration
 */
export function startDebuggingAgent(runConfig: RunConfiguration): void {
  if (runConfig.debuggingConfiguration?.[runConfig.toExecute].debuggingAgent) {
    const res = getDebuggingAgentAndConnections(runConfig);

    if (res === undefined) return;

    // make runConfig known to the debugging-agent
    const debuggingAgentState: DebuggingAgentStateInternal =
      runConfig.confState.componentState.get(res.debuggingAgent)!.state.my;

    // only performs update if runConfig has changed anyway
    // this frequency just shows how frequent it is checked for an update
    const intervalMs =
      debuggingAgentState.linkedDebuggingAgentConfig?.checkForChangesIntervalMs;

    const { debuggingAgent, outgoingConnections } = res;

    // initialize the configstate
    const componentStates: Record<
      string,
      AbstractState<unknown, unknown, unknown>
    > = runConfig.confState.componentState.get(debuggingAgent)!.state.my
      .componentStates;
    Object.entries(runConfig.deploymentConfiguration).forEach(
      ([unit, config]) => {
        config.components.forEach((comp) => {
          if (
            (<any>comp).isAgent !== true &&
            (<any>comp).isExternalMock !== true
          ) {
            componentStates[comp.name] = {
              tsType: "State",
              state: { fsm: undefined, my: undefined },
              events: [],
            };
          }
        });
      }
    );

    // only enable auto-update for positive intervals and if the agent is not a server
    if (
      intervalMs !== undefined &&
      intervalMs > 0 &&
      debuggingAgentState.linkedDebuggingAgentConfig?.isServer !== true
    ) {
      // store last clock states
      let lastClockStates:
        | Map<AtomicComponent<any, any, undefined>, ClockStates>
        | undefined = undefined;
      // store last state hash
      let lastStateHash: number | undefined = undefined;

      const intervalID = setInterval(() => {
        // check if the hash of the states has changed or if clock states have changed
        // essentially, only send an update if something happened
        const currentStateHash = stateHash(
          configurationStateWithoutDebuggingAgent(runConfig.confState)
        );

        if (
          lastStateHash !== currentStateHash ||
          !_.isEqual(lastClockStates, runConfig.clockStates)
        ) {
          performEvent(
            runConfig,
            debuggingAgent,
            DebuggingAgentEventTypeInternal.DO_PUSH_TO_SERVER,
            outgoingConnections
          );
          lastClockStates = _.cloneDeep(runConfig.clockStates);
          lastStateHash = currentStateHash;
        }
      }, intervalMs);

      // ensure clearInterval is called during shutdown to stop the infinite calls
      runConfig.shutdownFunctions?.push({
        type: "generic",
        description: "Debugging Agent Clear Interval",
        fn: () => {
          runConfig.engineRoomState.debuggingAgentEnabled = false;
          clearInterval(intervalID);
        },
      });

      sorrirLogger.info(
        Stakeholder.SYSTEM,
        "Debugging Agent auto-update enabled.",
        { unit: runConfig.toExecute }
      );
    } else {
      sorrirLogger.info(
        Stakeholder.SYSTEM,
        "Debugging Agent auto-update disabled.",
        { unit: runConfig.toExecute }
      );
    }

    if (
      debuggingAgentState.linkedDebuggingAgentConfig?.isServer &&
      debuggingAgentState.linkedDebuggingAgentConfig.webSocketPort
    ) {
      debuggingAgentState.wss = new WebSocketServer({
        port: debuggingAgentState.linkedDebuggingAgentConfig.webSocketPort,
        clientTracking: true,
      });
      const ajv = new Ajv(); // options can be passed, e.g. {allErrors: true}
      const validate = ajv.compile(
        DebuggingAgentWebSocketInjectMessageJSONSchema
      );
      sorrirLogger.info(
        Stakeholder.SYSTEM,
        "Debugging Agent WebSocket server started",
        { address: debuggingAgentState.wss.address() }
      );
      debuggingAgentState.wss.on("connection", function connection(ws) {
        sorrirLogger.info(
          Stakeholder.SYSTEM,
          "Debugging Agent WebSocket new connection",
          { client: ws.url }
        );

        let lastShadowMapHash: number | undefined = undefined;

        // shadow map is updated passively
        // periodically check if it has changed
        const intervalID = setInterval(() => {
          // hash the shadow map, but ignore the timestamps
          const currentShadowMapHash = stateHash(
            _.map(
              Array.from(runConfig.engineRoomState.shadowMap.values()),
              (entry) => entry.mode
            )
          );

          // eslint-disable-next-line no-constant-condition
          if (lastShadowMapHash !== currentShadowMapHash) {
            lastShadowMapHash = currentShadowMapHash;

            sorrirLogger.info(
              Stakeholder.SYSTEM,
              "ShadowMap has changed, sending web socket message",
              {}
            );

            sendWebSocketPacket(
              runConfig.confState.componentState.get(debuggingAgent)!.state.my
            );
          }
        }, intervalMs);

        // ensure clearInterval is called during shutdown to stop the infinite calls
        runConfig.shutdownFunctions!.push({
          type: "generic",
          description: "Debugging Agent Clear Interval",
          fn: () => {
            runConfig.engineRoomState.debuggingAgentEnabled = false;
            clearInterval(intervalID);
          },
        });

        ws.onmessage = (e) => {
          sorrirLogger.info(
            Stakeholder.SYSTEM,
            "Debugging Agent WebSocket incoming message",
            { data: e.data }
          );

          processWebSocketIncomingMessage(
            runConfig.confState.componentState.get(debuggingAgent)!.state.my
              .linkedRunConfig,
            validate,
            e.type === "Buffer"
              ? JSON.parse((e.data as Buffer).toString())
              : JSON.parse(e.data as string)
          );
          executeAndCommunicate(
            runConfig,
            computeLocallyDeployedConfiguration(runConfig),
            computeConnectionsFromLocalToExternal(runConfig)
          );
        };

        // send current state
        sendWebSocketPacket(
          runConfig.confState.componentState.get(debuggingAgent)!.state.my
        );
      });

      runConfig.shutdownFunctions?.push({
        type: "generic",
        description: "Debugging Agent Web Socket",
        fn: () => {
          if (debuggingAgentState.wss) {
            debuggingAgentState.wss.close();
          }
        },
      });
    }
  } else {
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "call to startDebuggingAgent when isAgent and isServer is false.",
      {}
    );
  }
}

function createEventFromMsg(msg: EnqueueEventMessage): Event<unknown, unknown> {
  const evt: OneWayEvent<unknown, unknown> | RequestEvent<unknown, unknown> = {
    id: uuidv4(),
    eventClass: msg.event.eventClass,
    type: msg.event.type,
    param: msg.event.param,
    port: msg.port,
  };
  return evt;
}

function processOrRelayMessage<
  InjectMessage extends DebuggingAgentWebSocketInjectMessage
>(
  runConfig: RunConfiguration,
  msg: InjectMessage,
  isLocal: boolean,
  onLocal: () => void,
  logFields?: Array<keyof InjectMessage>
) {
  if (isLocal) {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      `Incoming ${msg.ts_type} to local unit.`,
      { ...(logFields ?? Object.keys(msg)) }
    );
    onLocal();
  } else if (
    runConfig.debuggingConfiguration?.[runConfig.toExecute].debuggingAgent
      ?.isServer
  ) {
    // not local and i am the debugging server, send to all debugging agents
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      `Relay ${msg.ts_type} to remote unit.`,
      { ...(logFields ?? Object.keys(msg)) }
    );
    const controlEvt: DebuggingAgentControlToClientEvent = {
      eventClass: "oneway",
      type: DebuggingAgentEventTypeExternal.CONTROL_TO_CLIENT,
      port: DebuggingAgentPort.CONTROL_OUT,
      id: uuidv4(),
      param: { evt: msg },
    };
    for (const [comp, state] of runConfig.confState.componentState) {
      if (comp.name === debuggingAgentName) {
        state.events.push(controlEvt);
        break;
      }
    }
  }
}

function processWebSocketIncomingMessage(
  runConfig: RunConfiguration,
  validateFunction: ValidateFunction,
  data: any
) {
  const valid = validateFunction(data);
  if (valid === true) {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Incoming debugging agent message valid.",
      {}
    );
    const msg: DebuggingAgentWebSocketInjectMessage = data;
    switch (msg.ts_type) {
      case "EnqueueEventMessage":
        processOrRelayMessage(
          runConfig,
          msg,
          msg.unit === runConfig.toExecute,
          () => {
            const evt = createEventFromMsg(msg);
            // add event to correct component
            for (const [comp, state] of runConfig.confState.componentState) {
              if (comp.name === msg.component) {
                state.events.push(evt);
                break;
              }
            }
            //if not found silently ignore
          },
          ["unit", "component"]
        );
        break;
      case "SendExternalMessage":
        processOrRelayMessage(
          runConfig,
          msg,
          msg.unit === runConfig.toExecute,
          () => {
            // send the external event via axios from specified unit
            const host = runConfig.hostConfiguration[msg.targetUnit];
            const targetURI = `${msg.targetUnit}/${msg.targetComponent}/${msg.targetPort}`;
            const baseURL = `http://${host.host}:${host.port}/`;
            const axiosInstance = axios.create({
              baseURL: baseURL,
            });
            axiosInstance.post(targetURI, msg.data);
          },
          ["unit", "targetUnit", "targetComponent", "targetPort"]
        );
        break;
      case "ModifyAbstractStateMessage":
        processOrRelayMessage(
          runConfig,
          msg,
          msg.unit === runConfig.toExecute,
          () => {
            // modify state of correct component
            for (const [comp, state] of runConfig.confState.componentState) {
              if (comp.name === msg.component) {
                // no path means that the state is overwritten directly
                if (msg.path === undefined) {
                  (<any>state.state) = msg.value;
                } else {
                  // split keys and remove last key, as it's the key
                  // we will modify
                  const keys = msg.path.split("/");
                  const modifyKey = keys.pop();

                  // search for the object the key belongs to
                  let modifyObj = state.state;
                  keys.forEach((key) => {
                    modifyObj = modifyObj?.[key];
                  });

                  // modify field if key, obj and value exist
                  if (
                    modifyKey !== undefined &&
                    modifyObj !== undefined &&
                    Object.keys(modifyObj).includes(modifyKey)
                  ) {
                    modifyObj[modifyKey] = msg.value;
                  }
                }
                break;
              }
            }
            //if not found silently ignore
          },
          ["unit", "component", "path"]
        );
        break;
      case "FailUnitMessage":
        processOrRelayMessage(
          runConfig,
          msg,
          msg.unit === runConfig.toExecute,
          () => {
            // fail unit by exiting the process with error code
            process.exit(1);
          },
          ["unit"]
        );
        break;
      case "DisconnectUnitMessage":
        processOrRelayMessage(
          runConfig,
          msg,
          msg.unit === runConfig.toExecute,
          () => {
            // disconnect unit by shutting down all incoming ports
            // of all components except the debugging-agent itself
            runConfig.shutdownFunctions?.forEach((shutdownFunction) => {
              if (
                shutdownFunction.type === "commPort" &&
                shutdownFunction.component.name !== debuggingAgentName
              ) {
                shutdownFunction.fn();
              }
            });

            // also disconnect all outgoing connections by invalidating their commOption
            // only exclude the debugging agent
            runConfig.communicationConfiguration.connectionTechs.forEach(
              (connTech) => {
                if (connTech.sourceComponent.name !== debuggingAgentName) {
                  (<any>connTech.commOption) = "DISABLED_BY_DEBUGGING_AGENT";
                }
              }
            );
          },
          ["unit"]
        );
        break;
      default:
        throw Error("Not implemented");
    }
  } else {
    sorrirLogger.warn(
      Stakeholder.SYSTEM,
      "incoming debugging agent message not valid",
      { error: validateFunction.errors }
    );
  }
}
