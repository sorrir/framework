import {
  Configuration,
  configurationStep,
  Connection,
} from "./../util/component";
import { CommunicationConfiguration, RunConfiguration } from "./../exec-types";
import { AtomicComponent } from "../util/component";
import { Event, OutPort, Port } from "../util/engine";
import { CommOption, CommunicationTech } from "./comm-tech";
import { connectionsForComponent, decodeAndPushEvent } from "./comm-util";
import {
  computeConnectionsToLocalFromExternal,
  computeLocallyDeployedConfiguration,
  logStates,
  restrictConfigurationStateToConfiguration,
} from "./comm-util";
import { communicate as restCommunicate } from "./rest/tx";
import { communicate as mqttCommunicate } from "./mqtt/tx";
import { communicate as bluetoothCommunicate } from "./bluetooth/tx";
import { connect, MqttClient } from "mqtt";
import { communicate as tomCommunicate, initFrontend } from "./tom/frontend";

import * as rest from "./rest/setup";
import * as mqtt from "./mqtt/setup";
import * as bluetooth from "./bluetooth/setup";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import * as tom from "./tom/replica";
import * as logger from "winston";
import { Socket } from "net";
import { snapshotAll } from "../util/checkpoints";
import * as _ from "lodash";
import { v4 as uuidv4 } from "uuid";

sorrirLogger.configLogger({ area: "execution" });
const tomClients: Map<AtomicComponent<any, any>, Socket | undefined> = new Map<
  AtomicComponent<any, any>,
  Socket | undefined
>();

export function executeAndCommunicate<E>(
  runConfig: RunConfiguration,
  deployedConfiguration: Configuration,
  externalConnections: Connection<E>[]
): void {
  // function for onTransition-callback of configurationStep
  // whenever a transition happens for a component, it's clockstate shall be incremented
  const incrementClockState = (component: AtomicComponent<any, any, any>) => {
    runConfig.clockStates.get(component)?.myLocalClock.increment();
  };

  runConfig.confState = configurationStep(
    deployedConfiguration,
    runConfig.confState,
    true,
    incrementClockState
  );

  // Snapshot all components
  snapshotAll(runConfig);

  logStates(runConfig);

  commEngineCommunicate(runConfig, externalConnections);
}

export function commEngineCommunicate<E>(
  runConfig: RunConfiguration,
  externalConnections: Connection<E>[]
): void {
  const msgsMoved: Record<string, Event<any, any>[]> = {};
  externalConnections.forEach(({ source, target }) => {
    const { sourceComponent, sourcePort } = source;
    const msgsToMove =
      msgsMoved[sourceComponent.name + "->" + sourcePort.name] ??
      _.remove(
        runConfig.confState.componentState.get(sourceComponent)
          ?.events as Event<any, any>[],
        (event) =>
          event.port === sourcePort.name ||
          (Array.isArray(event.port) &&
            Array.isArray(sourcePort.name) &&
            event.port[0] === sourcePort.name[0] &&
            event.port[1] === sourcePort.name[1])
      );
    if (msgsToMove.length > 0) {
      msgsMoved[sourceComponent.name + "->" + sourcePort.name] = msgsToMove;
      outDemux(runConfig, msgsToMove, sourceComponent, sourcePort, target);
    }
  });
}

// todo: make port type-safe, i.e. in-port
export async function setupCommLayers(
  runConfig: RunConfiguration
): Promise<CommunicationTech[]> {
  const commTechs: CommunicationTech[] = [];
  const endPointsForTech: EndPointsForTech = getEndPointsForTech(
    computeConnectionsToLocalFromExternal(runConfig),
    runConfig.communicationConfiguration
  );

  for (const commOptionStr in endPointsForTech) {
    const commOption: CommOption = (<any>CommOption)[commOptionStr];

    switch (commOption) {
      case CommOption.REST: {
        const tech: CommunicationTech = await rest.setup(
          runConfig,
          endPointsForTech[commOptionStr].endPoints
        );
        commTechs.push(tech);
        break;
      }
      case CommOption.MQTT_EXTERNAL:
      case CommOption.MQTT: {
        initClient(runConfig);
        const tech: CommunicationTech = await mqtt.setup(
          runConfig,
          endPointsForTech[commOptionStr].endPoints
        );
        commTechs.push(tech);
        break;
      }
      case CommOption.BLUETOOTH: {
        const tech: CommunicationTech = await bluetooth.setup(
          runConfig,
          endPointsForTech[commOptionStr].endPoints
        );
        commTechs.push(tech);
        break;
      }
      case CommOption.TOM: {
        const tech: CommunicationTech = await tom.setup(
          runConfig,
          endPointsForTech[commOptionStr].endPoints
        );
        commTechs.push(tech);
        break;
      }
      default: {
        const tech: CommunicationTech = await rest.setup(
          runConfig,
          endPointsForTech[commOptionStr].endPoints
        );
        commTechs.push(tech);
      }
    }
  }

  return commTechs;
}

export function outDemux<E>(
  runConfig: RunConfiguration,
  msgsToMove: Event<any, any>[],
  sourceComponent: AtomicComponent<any, any>,
  sourcePort: Port<E, any>,
  target: {
    readonly targetComponent: AtomicComponent<any, any>;
    readonly targetPort: Port<E, any>;
  }
): void {
  const { targetComponent, targetPort } = target;

  let commOption: CommOption = getCommOptionForConnection(
    sourceComponent,
    sourcePort,
    targetComponent,
    targetPort,
    runConfig.communicationConfiguration
  );

  if (commOption === undefined) {
    sorrirLogger.warn(
      Stakeholder.SYSTEM,
      "No comm-option set, defaulting to rest",
      {}
    );
    commOption = CommOption.REST;
  }

  switch (commOption) {
    case CommOption.REST: {
      restCommunicate(
        runConfig,
        msgsToMove,
        targetComponent,
        targetPort,
        sourceComponent
      );
      break;
    }
    case CommOption.MQTT:
    case CommOption.MQTT_EXTERNAL: {
      const mqttClient = getMqttClient(runConfig);

      if (mqttClient === undefined) {
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          "Cannot connect to mqtt broker",
          {}
        );
        break;
      }

      mqttCommunicate(
        runConfig,
        msgsToMove,
        targetComponent,
        targetPort,
        mqttClient,
        sourceComponent,
        commOption === CommOption.MQTT_EXTERNAL
      );
      break;
    }
    case CommOption.BLUETOOTH: {
      bluetoothCommunicate(
        runConfig,
        msgsToMove,
        sourceComponent,
        sourcePort,
        targetComponent,
        targetPort
      );
      break;
    }
    case CommOption.TOM: {
      const tomClient = getTOMClient(runConfig, targetComponent);
      if (tomClient === undefined) {
        logger.error("Cannot connect to TOM broker");
        break;
      }
      tomCommunicate(
        runConfig,
        msgsToMove,
        targetComponent,
        targetPort,
        sourceComponent,
        tomClient
      );

      break;
    }
    default:
      sorrirLogger.error(Stakeholder.SYSTEM, "CommOption not valid.", {
        commOption,
      });
  }
}

function initClient(runConfig: RunConfiguration): MqttClient | undefined {
  if (
    runConfig.mqttConfiguration === undefined ||
    runConfig.mqttState?.mqttClient !== undefined
  ) {
    return undefined;
  }

  const mqttURL = "mqtt://" + runConfig.mqttConfiguration.host;
  const shortenedUUID = uuidv4().split("-")[0];
  const clientId = `sorrir_${runConfig.toExecute}_${shortenedUUID}`;
  const useCreds =
    runConfig.mqttConfiguration.username !== undefined &&
    runConfig.mqttConfiguration.username !== "" &&
    runConfig.mqttConfiguration.password !== undefined &&
    runConfig.mqttConfiguration.password !== "";
  const mqttClient = useCreds
    ? connect(mqttURL, {
        username: runConfig.mqttConfiguration.username,
        password: runConfig.mqttConfiguration.password,
        clean: true,
        clientId: clientId,
      })
    : connect(mqttURL, {
        clientId: clientId,
      });

  mqttClient.on("connect", () => {
    sorrirLogger.info(Stakeholder.SYSTEM, "MQTT Client is connected!", {});
  });

  runConfig.mqttState = {
    mqttClient: mqttClient,
  };

  return mqttClient;
}

export function getMqttClient(
  runConfig: RunConfiguration
): MqttClient | undefined {
  return runConfig.mqttState?.mqttClient ?? initClient(runConfig);
}

export function getTOMClient(
  runConfig: RunConfiguration,
  target: AtomicComponent<any, any>
): Socket | undefined {
  let tomClient = tomClients.get(target);

  if (tomClient === undefined) {
    tomClient = initFrontend(runConfig, target, tomClients);
  }
  return tomClient;
}

export function initConnectionLess(runConfig: RunConfiguration): void {
  const deployedConfiguration: Configuration =
    computeLocallyDeployedConfiguration(runConfig);
  runConfig.confState = restrictConfigurationStateToConfiguration(
    deployedConfiguration,
    runConfig.confState
  );

  // function for onTransition-callback of configurationStep
  // whenever a transition happens for a component, it's clockstate shall be incremented
  const incrementClockState = (component: AtomicComponent<any, any, any>) => {
    runConfig.clockStates.get(component)?.myLocalClock.increment();
  };

  runConfig.confState = configurationStep(
    deployedConfiguration,
    runConfig.confState,
    true,
    incrementClockState
  );
  // Initiate initial execution step, has no effect if no prepared event is stored within event queue
  logStates(runConfig);

  for (const component of deployedConfiguration.components) {
    const connsForComp = JSON.stringify(
      connectionsForComponent(deployedConfiguration.connections, component)
    );
    sorrirLogger.info(
      Stakeholder.USER,
      "",
      { connections: connsForComp, toExecute: runConfig.toExecute },
      {
        unit: runConfig.toExecute,
        component: component.name,
        degradationMode: "operational",
      }
    );
  }
}

export function getCommOptionForConnection<E>(
  sourceComponent: AtomicComponent<any, any>,
  sourcePort: Port<E, any>,
  targetComponent: AtomicComponent<any, any>,
  targetPort: Port<E, any>,
  communicationConfiguration: CommunicationConfiguration
): CommOption {
  for (const connectionTech of communicationConfiguration.connectionTechs) {
    if (
      connectionTech.sourceComponent === sourceComponent &&
      connectionTech.sourcePort.name === sourcePort.name &&
      connectionTech.targetComponent === targetComponent &&
      connectionTech.targetPort.name === targetPort.name
    ) {
      return connectionTech.commOption;
    }
  }

  sorrirLogger.error(
    Stakeholder.SYSTEM,
    "Cannot find commTech for connection:" +
      sourceComponent.name +
      "::" +
      sourcePort.name +
      "---->" +
      targetPort.name +
      "::" +
      targetComponent.name +
      "  defaulting to rest ...",
    { targetComponent: targetComponent, targetPort: targetPort }
  );
  return CommOption.REST;
}

function getEndPointsForTech(
  connections: Connection<any>[],
  communicationConfiguration: CommunicationConfiguration
): EndPointsForTech {
  const endPointsForTech: EndPointsForTech = {};

  for (const c of connections) {
    const { sourceComponent, sourcePort } = c.source;
    const { targetComponent, targetPort } = c.target;

    // if multiple connections have same tech, start one listener-instance, e.g. rest-server
    let commOptionStr = getCommOptionForConnection(
      sourceComponent,
      sourcePort,
      targetComponent,
      targetPort,
      communicationConfiguration
    ).toString();

    if (commOptionStr === undefined) {
      sorrirLogger.warn(
        Stakeholder.SYSTEM,
        "No comm-option set, defaulting to rest",
        {}
      );
      commOptionStr = "REST";
    }

    if (endPointsForTech[commOptionStr] === undefined) {
      endPointsForTech[commOptionStr] = { endPoints: new Array(1) };
      endPointsForTech[commOptionStr].endPoints[0] = {
        targetComponent: targetComponent,
        targetPort: targetPort,
      };
    } else if (
      endPointsForTech[commOptionStr].endPoints.findIndex(
        (x) =>
          x.targetComponent === targetComponent && x.targetPort === targetPort
      ) < 0
    ) {
      endPointsForTech[commOptionStr].endPoints.push({
        targetComponent: targetComponent,
        targetPort: targetPort,
      });
    }
  }

  return endPointsForTech;
}

type EndPointsForTech = {
  [commOption: string]: {
    endPoints: Array<{
      targetComponent: AtomicComponent<any, any>;
      targetPort: Port<any, any>;
    }>;
  };
};
