import {
  Configuration,
  configurationStep,
  Connection,
  AtomicComponent,
} from "./../../util/component";
import { Event, Port } from "../../util/engine";
import { RunConfiguration } from "./../../exec-types";
import { CommOption, CommunicationTech } from "./../comm-tech";
import { executeAndCommunicate } from "../comm-engine";
import {
  computeConnectionsFromLocalToExternal,
  computeLocallyDeployedConfiguration,
  decodeAndPushEvent,
  isDuplicatedMessage,
  restrictConfigurationStateToConfiguration,
} from "../comm-util";

import express from "express";
import http from "http";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { sorrirLogger } from "@sorrir/sorrir-logging/dist/app";
import axios from "axios";

const pathsToRegister: {
  path: string;
  targetComponent: AtomicComponent<any, any>;
  targetPort: Port<any, any>;
}[] = [];

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

  sorrirLogger.info(Stakeholder.SYSTEM, "", {
    deployedConfiguration: {
      components: deployedConfiguration.components,
      connections: deployedConfiguration.connections,
    },
  });
  sorrirLogger.info(Stakeholder.SYSTEM, "", {
    toExecute: runConfig.toExecute,
  });

  const app = express();
  app.use(express.json());

  const setupEndPoint = async () => {
    const toExternalConnections =
      computeConnectionsFromLocalToExternal(runConfig);

    targets.forEach(({ targetComponent, targetPort }) => {
      const path = `/${runConfig.toExecute}/${targetComponent.name}/${targetPort.name}`;
      sorrirLogger.info(Stakeholder.SYSTEM, "add BLE route for path", {
        path: path,
      });

      // listen for messages forwarded by the BLE server
      app.post(path, function (req, res) {
        const success = decodeAndPushEvent(
          runConfig,
          req.body,
          targetPort,
          targetComponent
        );
        //TODO: don't execute if event could not be decoded and return different statuscode
        executeAndCommunicate(
          runConfig,
          deployedConfiguration,
          toExternalConnections
        );
        res.status(200).send({});
      });

      // save the path to register in bootstrap
      pathsToRegister.push({ path, targetComponent, targetPort });
    });
  };

  let server: http.Server;
  const bootStrap = async () => {
    // tell the BLE server to start forwarding the incoming messages
    const bleConfig = runConfig.bleConfiguration?.[runConfig.toExecute];
    const axiosInstance = axios.create({
      baseURL: `http://${bleConfig?.sendHost}:${bleConfig?.sendPort}/`,
    });
    for (const path of pathsToRegister) {
      await axiosInstance
        .post(`ble`, {
          action: "unregisterListener",
          address: path,
          unit: runConfig.toExecute,
        })
        .catch(function (error) {
          sorrirLogger.error(
            Stakeholder.SYSTEM,
            "BLE unregister listener",
            error
          );
        });
      await axiosInstance
        .post(`ble`, {
          action: "registerListener",
          address: path,
          port: bleConfig?.listenPort,
          host: bleConfig?.listenHost,
          unit: runConfig.toExecute,
        })
        .catch(function (error) {
          sorrirLogger.error(
            Stakeholder.SYSTEM,
            "BLE register listener",
            error
          );
        });
      sorrirLogger.info(Stakeholder.SYSTEM, "registered listener for path", {
        path: path,
      });

      // register shutdown function for path
      runConfig.shutdownFunctions?.push({
        type: "commPort",
        description: "BLUETOOTH-Port",
        commOption: CommOption.BLUETOOTH,
        path: path.path,
        component: path.targetComponent,
        port: path.targetPort,
        fn: async () => {
          await axiosInstance
            .post(`ble`, {
              action: "unregisterListener",
              address: path,
            })
            .catch(function (error) {
              sorrirLogger.error(
                Stakeholder.SYSTEM,
                "BLE Unregister listener",
                error
              );
            });

          sorrirLogger.info(
            Stakeholder.SYSTEM,
            "unregistered listener for path",
            { path: path }
          );
        },
      });
    }

    server = app.listen(
      runConfig.bleConfiguration?.[runConfig.toExecute].listenPort,
      () => {
        sorrirLogger.info(
          Stakeholder.SYSTEM,
          "started listening for BLE events at",
          {
            url: bleConfig?.listenHost,
            port: bleConfig?.listenPort,
          }
        );
      }
    );

    runConfig.shutdownFunctions?.push({
      type: "generic",
      description: "BLUETOOTH Proxy-Server",
      fn: () => {
        // close REST server
        server.close();
      },
    });
  };

  return {
    setupEndPoint: setupEndPoint,
    bootStrap: bootStrap,
    isConnected: () => server.listening,
    onDisconnect: () =>
      new Promise<void>((resolve) => server.on("close", resolve)),
    onConnect: () =>
      new Promise<void>((resolve) => server.on("listening", resolve)),
  };
}
