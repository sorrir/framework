import { AtomicComponent, ConfigurationState } from "./../util/component";
import * as _ from "lodash";
import { RunConfiguration } from "./../exec-types";
import { Configuration, Connection } from "../util/component";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { decodeRawEvent } from "./decoding";
import { Event, Port } from "../util/engine";
import { encodeEvent } from "./encoding";
import * as crypto from "crypto-js";
import {
  preparePartialShadowMapToSend,
  setComponentUnreachable,
  setUnitUnreachable,
  updateShadowMap,
} from "../util/degradation";
import {
  AgentComponent,
  ShadowAgentEventTypeInternal,
  shadowAgentName,
  shadowAgentPerformEvent,
} from "../agents";
import { raw } from "express";

enum LOCAL_EXTERNAL {
  LOCAL,
  EXTERNAL,
}

function restrictConnections(
  runConfig: RunConfiguration,
  sourceType: LOCAL_EXTERNAL,
  targetType: LOCAL_EXTERNAL,
  conn: Connection<unknown>
): Connection<unknown> | undefined {
  const localComps =
    runConfig.deploymentConfiguration[runConfig.toExecute].components;

  let newConn: Connection<unknown> | undefined = undefined;

  let isReplicatedTarget = false;
  let isReplicatedSource = false;

  // Return the connection if target or source is replicated:
  // Keep these to set up endpoints to communicate with replicas
  // this is necessary if a local replica exists
  runConfig.resilienceConfiguration?.components?.forEach((component) => {
    if (
      conn.target.targetComponent.id === component.id &&
      component.mechanisms?.activeReplication?.enabled
    ) {
      isReplicatedTarget = true;
    }
    if (
      conn.source.sourceComponent.id === component.id &&
      component.mechanisms?.activeReplication?.enabled
    ) {
      isReplicatedSource = true;
    }
  });

  // Dont report a local but replicated target component as one of the local connections, because it must be treated
  // like an external connection with events passing through the TOM layer
  if (
    (isReplicatedTarget || isReplicatedSource) &&
    targetType === LOCAL_EXTERNAL.LOCAL &&
    sourceType === LOCAL_EXTERNAL.LOCAL
  ) {
    return undefined;
  }

  if (
    (isReplicatedTarget || isReplicatedSource) &&
    targetType === LOCAL_EXTERNAL.LOCAL &&
    sourceType === LOCAL_EXTERNAL.EXTERNAL
  ) {
    newConn =
      (targetType === LOCAL_EXTERNAL.LOCAL) ===
      _.includes(localComps, conn.target.targetComponent)
        ? conn
        : undefined;
  } else if (
    (isReplicatedTarget || isReplicatedSource) &&
    targetType === LOCAL_EXTERNAL.EXTERNAL &&
    sourceType === LOCAL_EXTERNAL.LOCAL
  ) {
    newConn =
      (sourceType === LOCAL_EXTERNAL.LOCAL) ===
      _.includes(localComps, conn.source.sourceComponent)
        ? conn
        : undefined;
  } else if (!(isReplicatedTarget || isReplicatedSource)) {
    // TODO: this description does not fit the code
    // is the target supposed to be EXTERNAL or LOCAL? original code said LOCAL
    // filter sources and targets
    // keep connections where source is local and target is external
    // sourceType === "LOCAL" ==> source of connections shall be a localComp
    // sourceType === "EXTERNAL" ==> source of connections shall NOT be a localComp
    // target is analoguous
    newConn =
      (sourceType === LOCAL_EXTERNAL.LOCAL) ===
        _.includes(localComps, conn.source.sourceComponent) &&
      (targetType === LOCAL_EXTERNAL.LOCAL) ===
        _.includes(localComps, conn.target.targetComponent)
        ? conn
        : undefined;
  }

  return newConn;
}

export function computeLocallyDeployedConfiguration(
  runConfig: RunConfiguration
): Configuration {
  // just take the components which are to be executed
  // and keep only the connections between those components
  const localComps =
    runConfig.deploymentConfiguration[runConfig.toExecute].components;
  return {
    components: localComps,
    connections: _.compact(
      runConfig.lsa.connections.map((c) =>
        restrictConnections(
          runConfig,
          LOCAL_EXTERNAL.LOCAL,
          LOCAL_EXTERNAL.LOCAL,
          c
        )
      )
    ),
  };
}

export function restrictConfigurationStateToConfiguration(
  conf: Configuration,
  state: ConfigurationState
): ConfigurationState {
  const newState = new Map(
    [...state.componentState].filter(([key, value]) =>
      conf.components.some((c) => c === key)
    )
  );
  return { ...state, componentState: newState };
}

export function computeConnectionsFromLocalToExternal(
  runConfig: RunConfiguration
): Connection<unknown>[] {
  return _.compact(
    runConfig.lsa.connections.map((c) =>
      restrictConnections(
        runConfig,
        LOCAL_EXTERNAL.LOCAL,
        LOCAL_EXTERNAL.EXTERNAL,
        c
      )
    )
  );
}

export function computeConnectionsToLocalFromExternal(
  runConfig: RunConfiguration
): Connection<unknown>[] {
  return _.compact(
    runConfig.lsa.connections.map((c) =>
      restrictConnections(
        runConfig,
        LOCAL_EXTERNAL.EXTERNAL,
        LOCAL_EXTERNAL.LOCAL,
        c
      )
    )
  );
}

// Logs current state of each component to console
export function logStates(runConf: RunConfiguration): void {
  const agents: AgentComponent<any, any>[] = [];
  console.log("\n<<< COMPONENT STATES >>>\n");
  for (const component of runConf.confState.componentState.keys() as IterableIterator<
    AgentComponent<any, any>
  >) {
    if (component.isAgent !== true) {
      sorrirLogger.info(
        Stakeholder.USER,
        "",
        {
          componentState:
            runConf.confState.componentState.get(component)?.state,
          events: runConf.confState.componentState.get(component)?.events,
          operatingMode:
            runConf.confState.componentState.get(component)?.operatingMode,
        },
        {
          unit: runConf.toExecute,
          component: component.name,
          degradationMode: "operational",
        }
      );
    } else if ((<any>component).isExternalMock !== true) {
      agents.push(component);
    }
  }
  console.log("<<< END OF COMPONENT STATES >>>");
  if (agents.length > 0) {
    console.log("<<< AGENT STATES >>>");
    for (const component of agents) {
      sorrirLogger.info(
        Stakeholder.USER,
        "",
        {
          componentState:
            runConf.confState.componentState.get(component)?.state,
          events: runConf.confState.componentState.get(component)?.events,
          degradationMode:
            runConf.confState.componentState.get(component)?.operatingMode,
        },
        {
          unit: runConf.toExecute,
          component: component.name,
          degradationMode: "operational",
        }
      );
    }
    console.log("<<< END OF AGENT STATES >>>");
  }
}

export function isDuplicatedMessage(
  runConfig: RunConfiguration,
  targetComponent: AtomicComponent<any, any, any>,
  sender: string,
  timestamp: number
): boolean {
  // Filter out duplicated messages with old (already used) sequence number per sender
  let lastReceivedSeq: number | undefined = runConfig.clockStates
    .get(targetComponent)
    ?.memorizedRcvdMsgs.get(sender);
  if (lastReceivedSeq === undefined) {
    lastReceivedSeq = -1;
  }

  if (
    sender !== undefined &&
    lastReceivedSeq !== -1 &&
    lastReceivedSeq >= timestamp &&
    targetComponent.name !== "Consolidator" //  == Instance "type"
  ) {
    // Duplicate! Dont deliver the message.
    sorrirLogger.warn(
      Stakeholder.SYSTEM,
      "!! Warning: Duplicated message arrived! sender:" +
        sender +
        " sequence: " +
        timestamp,
      {},
      { area: "execution" }
    );
    return true;
  } else {
    if (sender !== undefined && sender !== "") {
      // A sender is known
      runConfig.clockStates
        .get(targetComponent)
        ?.memorizedRcvdMsgs.set(sender, timestamp || 0);
    }
    return false;
  }
}

export function connectionsForComponent(
  connections: Connection<any>[],
  component: AtomicComponent<any, any, undefined>
): string[] {
  const connectionsComponentIsIn: Connection<any>[] = [];
  connections.forEach((entry) => {
    if (entry.source.sourceComponent.name === component.name) {
      connectionsComponentIsIn.push(entry);
    }
    if (entry.target.targetComponent.name === component.name) {
      connectionsComponentIsIn.push(entry);
    }
  });
  const connArr = JSON.stringify(connectionsComponentIsIn).split(",");
  return connArr;
}

export function decryptEvent(
  runConfig: RunConfiguration,
  cipherText: unknown,
  secret: Record<string, string>
): Record<string, unknown> | null {
  try {
    const decrypted = crypto.AES.decrypt(cipherText, secret["secret"]).toString(
      crypto.enc.Utf8
    );
    return JSON.parse(decrypted);
  } catch (e) {
    // console.log(e);
    return null;
  }
}

export function encryptEventIfEnabled(
  runConfig: RunConfiguration,
  unencryptedEvent: Record<string, unknown>,
  targetContainer: string
): Record<string, unknown> {
  if (runConfig.securityConfiguration) {
    const commSecret = runConfig.securityConfiguration.communicationSecret.find(
      (e) => e["from"] === runConfig.toExecute && e["to"] === targetContainer
    );
    if (commSecret) {
      return {
        content: crypto.AES.encrypt(
          JSON.stringify(unencryptedEvent),
          commSecret["secret"]
        ).toString(),
        from: runConfig.toExecute,
      };
    } else {
      return unencryptedEvent;
    }
  } else {
    return unencryptedEvent;
  }
}

export function decodeAndPushEvent(
  runConfig: RunConfiguration,
  rawEvent: Record<string, unknown>,
  targetPort: Port<any, any>,
  targetComponent: AtomicComponent<any, any, undefined>
): boolean {
  let sourceComponent = "";
  let encypted = false;
  if (rawEvent["from"]) {
    if (runConfig.securityConfiguration) {
      const commSecret =
        runConfig.securityConfiguration.communicationSecret.find(
          (e) =>
            e["from"] === rawEvent["from"] && e["to"] === runConfig.toExecute
        );

      //secret found, then we have to decrypt it
      if (commSecret !== undefined) {
        const decrypted = decryptEvent(
          runConfig,
          rawEvent["content"],
          commSecret
        );
        if (decrypted !== null) {
          rawEvent = decrypted;
          encypted = true;
        } else {
          sorrirLogger.error(
            Stakeholder.SYSTEM,
            `Receiving - unable to decrypt - from ${rawEvent["from"]}`,
            {}
          );
          return false;
        }
      }
    }
  }

  // does source component fit the source unit
  sourceComponent =
    typeof rawEvent["sender"] === "string" ? rawEvent["sender"] : "UNKNOWN";
  let sourceContainer = "ext"; //we assume that everyhing is external for now, since ext is not exist on DeploymentConfiguration for sensor
  for (const a in runConfig.deploymentConfiguration) {
    const exist = runConfig.deploymentConfiguration[a].components.find(
      (e) => e.name === sourceComponent || e.id === sourceComponent
    );
    if (exist !== undefined) {
      sourceContainer = a;
      break;
    }
  }

  //check whether actually should be encrypted
  if (!encypted) {
    if (runConfig.securityConfiguration) {
      const commSecret =
        runConfig.securityConfiguration.communicationSecret.find(
          (e) =>
            e["from"] === sourceContainer && e["to"] === runConfig.toExecute
        );
      if (commSecret !== undefined) {
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          `Receiving - should be encrypted - from ${sourceContainer}`,
          {}
        );
        return false;
      }
    }
  }

  // does source port fit source component
  const connection = runConfig.lsa.connections.find(
    (e) =>
      // e.source.sourceContainer.name === sourceContainer &&
      e.target.targetPort.name === targetPort.name &&
      e.target.targetComponent.name === targetComponent.name &&
      (e.source.sourceComponent.name === sourceComponent ||
        e.source.sourceComponent.id === sourceComponent)
  );
  if (connection === undefined) {
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "The sender not allowed to communicate to here",
      {
        type: rawEvent.eventType,
        rawEvent: rawEvent,
        sourceContainer: sourceContainer,
        targetPort: targetPort.name,
        sourceComponent: sourceComponent,
        targetComponent: targetComponent.name,
      }
    );
    return false;
  } else {
    //check whether the claim of source component exist on the source container
    if (sourceContainer !== "ext") {
      const sourceComponentCheck = runConfig.deploymentConfiguration[
        sourceContainer
      ].components.find(
        (e) => e.name === sourceComponent || e.id === sourceComponent
      );
      if (sourceComponentCheck === undefined) {
        sorrirLogger.error(Stakeholder.SYSTEM, "The sender claim is invalid", {
          type: rawEvent.eventType,
          rawEvent: rawEvent,
          sourceContainer: sourceContainer,
          targetPort: targetPort.name,
          targetComponent: targetComponent.name,
        });
        return false;
      }
    }
  }

  let knownEventType = false;
  for (const eventType of Object.values(targetPort.eventTypes)) {
    if (rawEvent.type === eventType) {
      knownEventType = true;
      sorrirLogger.info(Stakeholder.SYSTEM, "Known event type", {
        type: eventType,
      });

      const decoderOutput = decodeRawEvent(runConfig, rawEvent);

      const event = decoderOutput.event;
      if (event !== undefined) {
        sorrirLogger.info(Stakeholder.SYSTEM, "Event decoded", {
          event: Object.values(event),
        });

        sorrirLogger.debug(
          sorrirLogger.Stakeholder.SYSTEM,
          "Decoded incoming message",
          { event: event }
        );

        // Filter out duplicated messages with old (already used) sequence number per sender
        if (
          !isDuplicatedMessage(
            runConfig,
            targetComponent,
            <string>rawEvent.sender,
            <number>rawEvent.timestamp
          )
        ) {
          const message = {
            ...event,
            port: targetPort.name,
            timestamp: <number>rawEvent.timestamp,
          };
          // apply shadow modes
          updateShadowMap(
            runConfig,
            decoderOutput.extraData?.shadowMap ?? new Map()
          );

          // Deliver
          sorrirLogger.debug(
            sorrirLogger.Stakeholder.SYSTEM,
            "Deliver incoming message ",
            { message: message, targetComponent: targetComponent.id }
          );
          const compState =
            runConfig.confState.componentState.get(targetComponent);
          if (compState) {
            compState.events.push(message);
          } else {
            sorrirLogger.warn(
              sorrirLogger.Stakeholder.SYSTEM,
              "Could not find component state for message delivery ",
              {
                targetComponent: targetComponent,
                statesLength: runConfig.confState.componentState.size,
                componentStates: _.map(
                  Array.from(runConfig.confState.componentState.keys()),
                  (c) => c.id
                ),
              }
            );
          }
        }
      } else {
        sorrirLogger.error(Stakeholder.SYSTEM, "could not decode event", {});
      }
      break;
    }
  }
  if (!knownEventType) {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Unknown event type, could not decode event",
      {
        type: rawEvent.eventType,
        rawEvent: rawEvent,
      }
    );
    return false;
  }
  return true;
}

export function encodeEventWithNewTimestamp(
  runConfiguration: RunConfiguration,
  event: Event<unknown, unknown>,
  sourceComponent: AtomicComponent<any, any, undefined>,
  targetContainer: string
): Record<string, unknown> {
  sorrirLogger.info(Stakeholder.SYSTEM, "Encoding event", {
    event: event,
  });
  const timestamp: number | undefined =
    runConfiguration.clockStates.get(sourceComponent)?.myLocalClock.seq;
  const lastCheckpoint: number | undefined =
    runConfiguration.clockStates.get(sourceComponent)?.myLatestCheckpoint.seq;
  sorrirLogger.info(Stakeholder.SYSTEM, "Clockstate parameters", {
    timestamp: timestamp,
    lastCheckpoint: lastCheckpoint,
  });

  const shadowModeConfig =
    runConfiguration.shadowModeConfiguration?.[runConfiguration.toExecute]
      ?.inMessageSharing;
  const shadowMap =
    shadowModeConfig !== undefined &&
    (shadowModeConfig?.enabled === true ||
      sourceComponent.name === shadowAgentName)
      ? preparePartialShadowMapToSend(
          runConfiguration,
          shadowModeConfig.content,
          shadowModeConfig.limit
        )
      : undefined;

  const unencryptedEvent = encodeEvent(
    event,
    sourceComponent,
    lastCheckpoint,
    timestamp,
    shadowMap
  );

  return encryptEventIfEnabled(
    runConfiguration,
    unencryptedEvent,
    targetContainer
  );
}

/**
 * Is called when an error occurs during communication.
 *
 * @param runConfig
 * @param sourceComponent
 * @param targetComponent
 * @param targetUnit
 */
export function onCommError(
  runConfig: RunConfiguration,
  sourceComponent: AtomicComponent<any, any>,
  targetComponent: AtomicComponent<any, any>,
  targetUnit: string
): void {
  // if target is a shadow-agent, mark all components of target unit as unreachable.
  // Alternatively, do the same if shadow-agents are unavailable either generally or for the target unit.
  if (
    targetComponent.name === shadowAgentName ||
    runConfig.engineRoomState.shadowAgentEnabled !== true ||
    !runConfig.engineRoomState.shadowAgentTargets?.includes(targetUnit)
  ) {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Target unit could not be reached, marking as unreachable.",
      {
        component: targetComponent,
        unit: targetUnit,
      }
    );
    setUnitUnreachable(runConfig, targetUnit);
  }
  // mark component as unreachable and try to contact the units shadow-agent
  else {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Target component could not be reached, marking as unreachable.",
      {
        component: targetComponent,
        unit: targetUnit,
      }
    );
    setComponentUnreachable(runConfig, targetComponent.name);
    shadowAgentPerformEvent(runConfig, ShadowAgentEventTypeInternal.DO_PULL, {
      target: targetUnit,
    });
  }

  // update shadow modes
  updateShadowMap(runConfig);
}
