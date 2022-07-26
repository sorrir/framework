import {
  Configuration,
  configurationStep,
  AtomicComponent,
  Connection,
  Component,
} from "./../../util/component";
import { MqttClient, connect, Packet } from "mqtt";
import { Event, Port } from "../../util/engine";
import { RunConfiguration } from "./../../exec-types";
import { CommunicationTech, errorSetup, CommOption } from "./../comm-tech";
import {
  computeConnectionsFromLocalToExternal,
  computeConnectionsToLocalFromExternal,
  decodeAndPushEvent,
  isDuplicatedMessage,
  logStates,
  restrictConfigurationStateToConfiguration,
} from "../comm-util";
import { computeLocallyDeployedConfiguration } from "../comm-util";
import { getMqttClient, executeAndCommunicate } from "../comm-engine";

import * as _ from "lodash";
import { snapshotAll } from "../../util/checkpoints";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";

export async function setup<E>(
  runConfig: RunConfiguration,
  targets: Array<{
    readonly targetComponent: AtomicComponent<any, any>;
    readonly targetPort: Port<any, any>;
  }>
): Promise<CommunicationTech> {
  const deployedConfiguration: Configuration =
    computeLocallyDeployedConfiguration(runConfig);
  runConfig.confState = restrictConfigurationStateToConfiguration(
    deployedConfiguration,
    runConfig.confState
  );

  sorrirLogger.info(
    Stakeholder.SYSTEM,
    "Init of MQTT Component. Overview deployedConfiguration:",
    {
      deployedConfiguration: {
        components: deployedConfiguration.components,
        connections: deployedConfiguration.connections,
      },
    }
  );
  sorrirLogger.info(Stakeholder.SYSTEM, "Init of MQTT Component. To execute:", {
    toExecute: runConfig.toExecute,
  });

  const mqttClient = getMqttClient(runConfig);

  // This is a look up table responsible for mapping of subscribed topics
  // to target component and target client.
  const mqttTopicToPort: Map<
    string,
    { component: Component<any, any, any>; port: Port<any, any> }
  > = new Map();

  if (mqttClient === undefined) {
    return errorSetup(CommOption.MQTT);
  }

  const setupEndPoint: () => Promise<void> = async function () {
    const toExternalConnections =
      computeConnectionsFromLocalToExternal(runConfig);

    targets.forEach(({ targetComponent, targetPort }) => {
      const topic_ = `${targetComponent.name}/${targetPort.name}`;
      mqttTopicToPort.set(topic_, {
        component: targetComponent,
        port: targetPort,
      });
      sorrirLogger.info(Stakeholder.SYSTEM, "add Subscription for topic", {
        topic: topic_,
      });

      runConfig.shutdownFunctions?.push({
        type: "commPort",
        description: "MQTT-Port",
        commOption: CommOption.MQTT,
        component: targetComponent,
        port: targetPort,
        path: runConfig.toExecute + "/" + topic_,
        fn: () => {
          mqttTopicToPort.delete(topic_);
        },
      });

      mqttClient.on("connect", () => {
        mqttClient.subscribe(topic_, { qos: 2 }, (err, granted) => {
          if (!err) {
            sorrirLogger.info(
              Stakeholder.SYSTEM,
              "Successfully subscribed to topic",
              { topic: topic_ }
            );
          } else {
            sorrirLogger.warn(Stakeholder.SYSTEM, "Cannot subscribe to topic", {
              topic: topic_,
            });
          }
        });
      });

      mqttClient.on(
        "message",
        (topic: string, payload: Buffer, packet: Packet) => {
          sorrirLogger.info(Stakeholder.SYSTEM, "Received raw mqtt message", {
            topic: topic,
            payload: payload.toString(),
          });

          const rawEvent = JSON.parse(payload.toString());

          // Get target port and component from previously defined look up table
          const target = mqttTopicToPort.get(topic);

          if (target) {
            const success = decodeAndPushEvent(
              runConfig,
              rawEvent,
              target.port,
              target.component
            );
          } else {
            sorrirLogger.error(
              Stakeholder.SYSTEM,
              "Could not decode MQTT payload, because of unregistered topic",
              { topic: topic }
            );
          }

          executeAndCommunicate(
            runConfig,
            deployedConfiguration,
            toExternalConnections
          );
        }
      );
    });
  };

  const bootStrap: () => Promise<void> = async function () {
    mqttClient.on("connect", () => {
      sorrirLogger.info(Stakeholder.SYSTEM, "MQTT Client is connected!", {});
    });
  };

  // Shutdown MQTT Client
  runConfig.shutdownFunctions?.push({
    type: "generic",
    description: "MQTT-Client",
    fn: () => {
      mqttClient.end();
    },
  });

  return {
    setupEndPoint: setupEndPoint,
    bootStrap: bootStrap,
    isConnected: () => mqttClient.connected,
    onDisconnect: () =>
      new Promise<void>((resolve) => mqttClient.on("end", resolve)),
    onConnect: () =>
      new Promise<void>((resolve) => mqttClient.on("connect", resolve)),
  };
}
