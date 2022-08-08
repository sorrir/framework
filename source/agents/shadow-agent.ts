import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import _ = require("lodash");
import { any } from "lodash/fp";
import { AgentComponent } from ".";
import { commEngineCommunicate } from "../communication/comm-engine";
import { communicate } from "../communication/rest/tx";
import { RunConfiguration, ShadowAgentConfig } from "../exec-types";
import {
  AtomicComponent,
  Connection,
  createStatemachineComponent,
} from "../util/component";
import {
  updateShadowMap,
  arrayToShadowMap,
  preparePartialShadowMapToSend,
  ShadowMapAsArray,
  shadowMapToArray,
  DefaultShadowMode,
} from "../util/degradation";
import {
  Internal,
  OneWayEvent,
  Port,
  PortDirection,
  RaiseEventCallBack,
  RequestEvent,
  ResolveEvent,
  StateMachine,
  StateMachineState,
} from "../util/engine";
import {
  Maybe,
  Nothing,
  Just,
  isJust,
  fromJust,
  withDefault,
} from "@typed/maybe";

export const shadowAgentName = "shadow-agent";

export enum ShadowAgentEventTypeExternal {
  PUSH = "PUSH",
  PULL = "PULL",
  PUSH_PULL = "PUSH_PULL",
}

export enum ShadowAgentEventTypeInternal {
  DO_GOSSIP = "DO_GOSSIP",
  DO_PUSH = "DO_PUSH",
  DO_PULL = "DO_PULL",
}

// TODO: evaluate if there is a better way for this
let linkedRunConfig: RunConfiguration | undefined;
let linkedShadowAgentConfig: ShadowAgentConfig | undefined;

// events
interface ShadowAgentPushEvent
  extends OneWayEvent<ShadowAgentEventTypeExternal.PUSH, any> {
  param: { shadowMap: ShadowMapAsArray<unknown> };
}
interface ShadowAgentPushResolveEvent
  extends ResolveEvent<ShadowAgentEventTypeExternal.PUSH, any> {
  param: { shadowMap: ShadowMapAsArray<unknown> };
}
interface ShadowAgentPullEvent
  extends RequestEvent<ShadowAgentEventTypeExternal.PULL, any> {
  param: { source: string };
}
interface ShadowAgentPushPullEvent
  extends RequestEvent<ShadowAgentEventTypeExternal.PUSH_PULL, any> {
  param: { source: string; shadowMap: ShadowMapAsArray<unknown> };
}
interface ShadowAgentDoPullEvent
  extends OneWayEvent<ShadowAgentEventTypeInternal.DO_PULL, any> {
  param: { target: string };
}

/**
 * Start state of the shadow agent
 */
const shadowAgentStartState: StateMachineState<
  undefined,
  undefined,
  ShadowAgentEventTypeExternal | ShadowAgentEventTypeInternal,
  any
> = {
  state: { fsm: undefined, my: undefined },
  events: [],
  tsType: "State",
};

/**
 * Returns a transition to consume an incoming push event.
 *
 * Updates the shadow map stored in the RunConfiguration.
 *
 * @param eventClass the event class of the event to be consumed
 * @returns the transition
 */
function getConsumePushEventTransition<EventClass extends "resolve" | "oneway">(
  eventClass: EventClass
) {
  return {
    sourceState: undefined,
    targetState: undefined,
    event: <any>[eventClass, ShadowAgentEventTypeExternal.PUSH, "IN"],
    action: (
      state: undefined,
      raiseEvent: RaiseEventCallBack<ShadowAgentEventTypeExternal, any>,
      event?: EventClass extends "oneway"
        ? OneWayEvent<
            ShadowAgentEventTypeExternal | ShadowAgentEventTypeInternal,
            any
          >
        : ResolveEvent<
            ShadowAgentEventTypeExternal | ShadowAgentEventTypeInternal,
            any
          >
    ) => {
      if (event !== undefined) {
        const pushEvent = event as EventClass extends "oneway"
          ? ShadowAgentPushEvent
          : ShadowAgentPushResolveEvent;
        if (
          linkedRunConfig !== undefined &&
          pushEvent.param.shadowMap !== undefined
        ) {
          updateShadowMap(
            linkedRunConfig,
            arrayToShadowMap(pushEvent.param.shadowMap)
          );
        }
      }
      return undefined;
    },
  };
}

export function getShadowAgentComponent(units: string[]): {
  shadowAgent: AgentComponent<any, any>;
  shadowAgentStartState: StateMachineState<
    undefined,
    undefined,
    ShadowAgentEventTypeExternal | ShadowAgentEventTypeInternal,
    any
  >;
} {
  const OutPorts = _.reduce(
    units,
    (obj, unit) => {
      obj["OUT_" + unit] = "OUT_" + unit;
      return obj;
    },
    {}
  );
  const InPorts = _.reduce(
    units,
    (obj, unit) => {
      obj["IN_" + unit] = "IN_" + unit;
      return obj;
    },
    {}
  );
  const ShadowAgentPorts = {
    IN: "IN",
    ...InPorts,
    ...OutPorts,
  };

  const sm: StateMachine<
    undefined,
    undefined,
    ShadowAgentEventTypeExternal | ShadowAgentEventTypeInternal,
    any
  > = {
    transitions: [
      /*
       * 'push' strategy
       * push shadow-map to all available shadow-agents
       */
      {
        sourceState: undefined,
        targetState: undefined,
        event: ["oneway", ShadowAgentEventTypeInternal.DO_PUSH, Internal],
        action: (
          state: undefined,
          raiseEvent: RaiseEventCallBack<ShadowAgentEventTypeExternal, any>
        ) => {
          if (
            linkedRunConfig !== undefined &&
            linkedShadowAgentConfig !== undefined
          ) {
            Object.keys(OutPorts).forEach((port) => {
              raiseEvent({
                eventClass: "oneway",
                type: ShadowAgentEventTypeExternal.PUSH,
                port: port,
                param: {
                  shadowMap: shadowMapToArray(
                    preparePartialShadowMapToSend(
                      <RunConfiguration>linkedRunConfig,
                      (<ShadowAgentConfig>linkedShadowAgentConfig).autoUpdate
                        .content,
                      (<ShadowAgentConfig>linkedShadowAgentConfig).autoUpdate
                        .limit
                    )
                  ),
                },
              });
            });
          }
          return undefined;
        },
      },
      /*
       * 'gossip' strategy
       * exchange shadow-map with a single random available shadow-agent
       */
      {
        sourceState: undefined,
        targetState: undefined,
        event: ["oneway", ShadowAgentEventTypeInternal.DO_GOSSIP, Internal],
        action: (
          state: undefined,
          raiseEvent: RaiseEventCallBack<ShadowAgentEventTypeExternal, any>
        ) => {
          // chooses a random port from the outports as
          // every port is related to a single shadow-agent
          const randomPort = _.sample(Object.keys(OutPorts));
          const pushPullEvent: Omit<ShadowAgentPushPullEvent, "id"> = {
            eventClass: "request",
            type: ShadowAgentEventTypeExternal.PUSH_PULL,
            port: randomPort,
            param: {
              source: linkedRunConfig?.toExecute ?? "",
              shadowMap: shadowMapToArray(
                preparePartialShadowMapToSend(
                  <RunConfiguration>linkedRunConfig,
                  (<ShadowAgentConfig>linkedShadowAgentConfig).autoUpdate
                    .content,
                  (<ShadowAgentConfig>linkedShadowAgentConfig).autoUpdate.limit
                )
              ),
            },
          };
          raiseEvent(pushPullEvent);
          return undefined;
        },
      },
      /**
       * pull request to other agent.
       */
      {
        sourceState: undefined,
        targetState: undefined,
        event: ["oneway", ShadowAgentEventTypeInternal.DO_PULL, Internal],
        action: (
          state: undefined,
          raiseEvent: RaiseEventCallBack<ShadowAgentEventTypeExternal, any>,
          event?: OneWayEvent<
            ShadowAgentEventTypeExternal | ShadowAgentEventTypeInternal,
            any
          >
        ) => {
          if (event !== undefined) {
            const doPullEvent = event as ShadowAgentDoPullEvent;
            raiseEvent(<ShadowAgentPullEvent>{
              eventClass: "request",
              type: ShadowAgentEventTypeExternal.PULL,
              port: "OUT_" + doPullEvent.param.target,
              param: {
                source: linkedRunConfig?.toExecute,
              },
            });
          }
          return undefined;
        },
      },
      /**
       * pull request by other agent.
       */
      {
        sourceState: undefined,
        targetState: undefined,
        event: ["request", ShadowAgentEventTypeExternal.PULL, "IN"],
        action: (
          state: undefined,
          raiseEvent: RaiseEventCallBack<ShadowAgentEventTypeExternal, any>,
          event?: RequestEvent<
            ShadowAgentEventTypeExternal | ShadowAgentEventTypeInternal,
            any
          >
        ) => {
          if (event !== undefined && linkedRunConfig !== undefined) {
            const pullEvent = event as ShadowAgentPullEvent;
            raiseEvent({
              eventClass: "resolve",
              type: ShadowAgentEventTypeExternal.PUSH,
              port: "OUT_" + pullEvent.param.source,
              answerToRequestID: pullEvent.id,
              rc: 0,
              param: {
                shadowMap: shadowMapToArray(
                  preparePartialShadowMapToSend(
                    <RunConfiguration>linkedRunConfig,
                    (<ShadowAgentConfig>linkedShadowAgentConfig).autoUpdate
                      .content,
                    (<ShadowAgentConfig>linkedShadowAgentConfig).autoUpdate
                      .limit
                  )
                ),
              },
            });
          }
          return undefined;
        },
      },
      /**
       * push-pull request by other agent.
       */
      {
        sourceState: undefined,
        targetState: undefined,
        event: ["request", ShadowAgentEventTypeExternal.PUSH_PULL, "IN"],
        action: (
          state: undefined,
          raiseEvent: RaiseEventCallBack<ShadowAgentEventTypeExternal, any>,
          event?: RequestEvent<
            ShadowAgentEventTypeExternal | ShadowAgentEventTypeInternal,
            any
          >
        ) => {
          if (event !== undefined && linkedRunConfig !== undefined) {
            const pushPullEvent = event as ShadowAgentPushPullEvent;
            if (
              linkedRunConfig !== undefined &&
              pushPullEvent.param.shadowMap !== undefined
            ) {
              updateShadowMap(
                linkedRunConfig,
                arrayToShadowMap(pushPullEvent.param.shadowMap)
              );
            }
            raiseEvent({
              eventClass: "resolve",
              type: ShadowAgentEventTypeExternal.PUSH,
              port: "OUT_" + pushPullEvent.param.source,
              answerToRequestID: pushPullEvent.id,
              rc: 0,
              param: {
                shadowMap: shadowMapToArray(
                  preparePartialShadowMapToSend(
                    <RunConfiguration>linkedRunConfig,
                    (<ShadowAgentConfig>linkedShadowAgentConfig).autoUpdate
                      .content,
                    (<ShadowAgentConfig>linkedShadowAgentConfig).autoUpdate
                      .limit
                  )
                ),
              },
            });
          }
          return undefined;
        },
      },
      /*
       * consume incoming push events
       */
      getConsumePushEventTransition("oneway"),
      getConsumePushEventTransition("resolve"),
    ],
  };

  const shadowAgent = {
    ...createStatemachineComponent(
      [
        // ..._.map(Object.keys(InPorts), (port) => {
        //   return {
        //     name: port,
        //     eventTypes: [ShadowAgentEventTypes.PULL, ShadowAgentEventTypes.PUSH],
        //     direction: <PortDirection>"in",
        //   };
        // }),
        {
          name: "IN",
          eventTypes: Object.values(ShadowAgentEventTypeExternal),
          direction: <PortDirection>"in",
        },
        ..._.map(Object.keys(OutPorts), (port) => {
          return {
            name: port,
            eventTypes: Object.values(ShadowAgentEventTypeExternal),
            direction: <PortDirection>"out",
          };
        }),
      ],
      sm,
      shadowAgentName
    ),
    isAgent: <const>true,
  };

  return {
    shadowAgent: shadowAgent,
    shadowAgentStartState: shadowAgentStartState,
  };
}

function getShadowAgentAndConnections(runConfig: RunConfiguration) {
  // get the shadow agent
  const shadowAgent = _.find(
    runConfig.deploymentConfiguration?.[runConfig.toExecute].components,
    (comp) => comp.name === shadowAgentName
  );

  // check for internal errors
  if (shadowAgent === undefined || shadowAgent.tsType !== "Component") {
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "Shadow Agent could not be referenced.",
      {}
    );
    return;
  }

  const outgoingConnections = _.filter(
    runConfig.lsa.connections,
    (connection: Connection<any>) =>
      connection.source.sourceComponent === shadowAgent
  );

  // check if there are any outgoing connections
  if (outgoingConnections.length === 0) {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Shadow Agent has no outgoing connections. Auto-update disabled.",
      {}
    );
    return;
  }

  return { shadowAgent: shadowAgent, outgoingConnections: outgoingConnections };
}

/**
 * Push an event into the event queue and step to completion
 *
 * @param runConfig
 * @param shadowAgent
 * @param eventType
 * @param outgoingConnections
 * @param param
 */
function performEvent(
  runConfig: RunConfiguration,
  shadowAgent: AtomicComponent<any, any, undefined>,
  eventType: ShadowAgentEventTypeInternal,
  outgoingConnections: Connection<any>[],
  param?: Record<string, unknown>
) {
  {
    // push an event into the queue
    runConfig.confState.componentState.get(shadowAgent)?.events.push({
      eventClass: "oneway",
      type: eventType,
      port: Internal,
      id: "",
      ...(param !== undefined ? { param: param } : {}),
    });

    // step to completion
    const oldState = runConfig.confState.componentState.get(shadowAgent);
    if (oldState === undefined) {
      sorrirLogger.error(
        Stakeholder.SYSTEM,
        "State of shadow agent is undefined. Cannot perform event.",
        {
          eventType: eventType,
        }
      );
      return;
    }
    let newState = shadowAgent.step(oldState);
    while (isJust(newState)) {
      runConfig.confState.componentState.set(shadowAgent, fromJust(newState));
      commEngineCommunicate(runConfig, outgoingConnections);
      newState = shadowAgent.step(fromJust(newState));
    }
  }
}

/**
 * Make the shadow agent perform an event.
 *
 * Does this by placing an internal event in the event queue of the
 * agent and stepping to completion after.
 *
 * @param runConfig the RunConfiguration
 * @param eventType specifies which action the agent shall perform
 * @param param optional parameters, if the event type requires them
 */
export function shadowAgentPerformEvent(
  runConfig: RunConfiguration,
  eventType: ShadowAgentEventTypeInternal,
  param?: Record<string, unknown>
): void {
  const res = getShadowAgentAndConnections(runConfig);
  if (res === undefined) return;
  const { shadowAgent, outgoingConnections } = res;
  performEvent(runConfig, shadowAgent, eventType, outgoingConnections, param);
}

/**
 * Starts the shadow agent. To be called from
 * agents.ts
 *
 * @param runConfig the RunConfiguration
 */
export function startShadowAgent(runConfig: RunConfiguration): void {
  const intervalMs =
    (runConfig.shadowModeConfiguration?.[runConfig.toExecute]?.shadowAgent
      .autoUpdate.intervalSeconds ?? 0) * 1000;

  const eventType = (() => {
    switch (
      runConfig.shadowModeConfiguration?.[runConfig.toExecute]?.shadowAgent
        .autoUpdate.strategy
    ) {
      case "push":
        return ShadowAgentEventTypeInternal.DO_PUSH;
      case "gossip":
        return ShadowAgentEventTypeInternal.DO_GOSSIP;
      default:
        return undefined;
    }
  })();

  // make runConfig known to the shadow-agent
  linkedRunConfig = runConfig;
  linkedShadowAgentConfig =
    runConfig.shadowModeConfiguration?.[runConfig.toExecute].shadowAgent;

  const res = getShadowAgentAndConnections(runConfig);
  if (res === undefined) return;
  const { shadowAgent, outgoingConnections } = res;

  // initialize the shadow map
  const shadowMap = runConfig.engineRoomState.shadowMap;
  Object.entries(runConfig.deploymentConfiguration).forEach(
    ([unit, config]) => {
      config.components.forEach((comp) => {
        if (
          comp.id !== undefined &&
          (<any>comp).isAgent !== true &&
          (<any>comp).isExternalMock !== true
        ) {
          shadowMap.set(comp.id, {
            mode:
              unit === runConfig.toExecute
                ? DefaultShadowMode.OK
                : DefaultShadowMode.UNREACHABLE,
          });
        }
      });
    }
  );

  // only enable auto-update for positive intervals and if a valid strategy was set
  if (intervalMs > 0 && eventType !== undefined) {
    const intervalID = setInterval(() => {
      performEvent(runConfig, shadowAgent, eventType, outgoingConnections);
    }, intervalMs);
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Shadow Agent auto-update enabled.",
      {}
    );

    // ensure clearInterval is called during shutdown to stop the infinite calls
    runConfig.shutdownFunctions!.push({
      type: "generic",
      description: "Shadow Agent Clear Interval",
      fn: () => {
        runConfig.engineRoomState.shadowAgentEnabled = false;
        clearInterval(intervalID);
      },
    });
  } else {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Shadow Agent auto-update disabled.",
      {}
    );
  }
}
