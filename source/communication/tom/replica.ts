import { Configuration, AtomicComponent } from "./../../util/component";
import { Port } from "../../util/engine";
import { RunConfiguration } from "./../../exec-types";
import { CommunicationTech } from "./../comm-tech";
import {
  computeConnectionsFromLocalToExternal,
  decodeAndPushEvent,
  isDuplicatedMessage,
  restrictConfigurationStateToConfiguration,
} from "../comm-util";
import { computeLocallyDeployedConfiguration } from "../comm-util";
import { decodeRawEvent } from "../decoding";
import { executeAndCommunicate } from "../comm-engine";
import * as _ from "lodash";
import * as logger from "winston";
import * as net from "net";
import * as spawn from "child_process";
import { sorrirLogger } from "@sorrir/sorrir-logging/dist/app";

/**
 * Set up the *Endpoints* for all components that are replicated. For instance, if this unit holds a replica of component A
 * then it needs to set up a endpoint for it. Replicated components deliver events after they passed the total order multicast layer
 * of the BFT-SMaRt middleware. It is guaranteed that a total order among events is established. This method sets up the
 * local BFT-SMaRt replica in a Java child process and creates a TCP server socket let it connect. The java replica forwards
 * messages up to the application component.
 *
 * @param runConfig the RunConfiguration object
 * @param targets *Endpoints*, e.g. components that need to deliver messages in total order
 */
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

  logger.info({ deployedConfiguration: deployedConfiguration });
  logger.info({ toExecute: runConfig.toExecute });

  const servers: Array<net.Server> = [];

  const setupEndPoint: () => Promise<void> = async function () {
    // calculate connection from local to external
    const toExternalConnections =
      computeConnectionsFromLocalToExternal(runConfig);

    // targetComponentPorts maps to each component all ports associated with it
    const targetComponentsPorts: Map<
      AtomicComponent<any, any>,
      Port<any, any>[]
    > = new Map<AtomicComponent<any, any>, Port<any, any>[]>();
    targets.forEach(({ targetComponent, targetPort }) => {
      let targetPorts = targetComponentsPorts.get(targetComponent);
      if (!targetPorts) {
        targetPorts = [];
      }
      targetPorts.push(targetPort);
      targetComponentsPorts.set(targetComponent, targetPorts);
    });

    // BFT-SMaRt replica needs to reserve two ports
    let port = runConfig.hostConfiguration[runConfig.toExecute].port + 2;

    // For each component, set up a TCP server listening to is local replica
    Array.from(targetComponentsPorts.keys()).forEach((targetComponent) => {
      // Create a new TCP server.

      sorrirLogger.info("Creating TCP server on port: ");

      const server = net.createServer();
      servers.push(server);

      // This server listens to a socket for events to be pushed from the local replica to its SORRIR component
      server.listen(port, function () {
        sorrirLogger.info("Server listening for connection requests");
      });

      // Server creates a new socket for its local replica. The local replica forwards events in total order after reaching
      // consensus with the other replicas
      server.on("connection", function (socket) {
        sorrirLogger.info("Successfully connected to local replica");

        // The server receives data by reading from this socket:

        let buffer: Buffer = Buffer.from([]);

        socket.on("data", function (chunk: Buffer) {
          sorrirLogger.debug(
            "Received message for component target from its replica" +
              targetComponent.id
          );

          // Decode TCP message and execute

          const BYTES_PER_INTEGER = 4;

          buffer = Buffer.concat([buffer, chunk]);

          // As long as there could be *complete messages* in the buffer, drain message frames from buffer
          while (buffer.byteLength > 0) {
            // First Integer decodes whole message frame length - if not present then wait for more to arrive
            if (buffer.byteLength < BYTES_PER_INTEGER) {
              return;
            }
            const frameLength: number = buffer.readInt32BE(0);

            // Second Integer decodes payload length of the actual message payload - if not fully arrived then wait
            if (buffer.length < frameLength + BYTES_PER_INTEGER) {
              return;
            }
            const payloadLength: number = buffer.readInt32BE(4);

            // Slice the complete message frame form the Byte Buffer and then parse the JSON message
            const messageBuffer: Buffer = buffer.slice(
              2 * BYTES_PER_INTEGER,
              2 * BYTES_PER_INTEGER + payloadLength
            );
            buffer = buffer.slice(
              2 * BYTES_PER_INTEGER + payloadLength,
              buffer.length
            );
            const message = JSON.parse(messageBuffer.toString("UTF8"));

            // Now, the message should have been decoded successfully:
            sorrirLogger.debug(
              "Decoded event from TCP layer " + JSON.stringify(message)
            );

            // A list of ports for the specific target component
            const ports: Port<any, any>[] =
              targetComponentsPorts.get(targetComponent) || [];

            // Check if the message can be applied to one of the ports' event types:
            Object.values(ports).forEach((targetPort) => {
              const success = decodeAndPushEvent(
                runConfig,
                message,
                targetPort,
                targetComponent
              );
              executeAndCommunicate(
                runConfig,
                deployedConfiguration,
                toExternalConnections
              );
            });
          }
        });

        // When the client requests to end the TCP connection with the server, the server
        // ends the connection.
        socket.on("end", function () {
          sorrirLogger.info("Closing connection with the client");
        });

        // Don't forget to catch error, for your own sake.
        socket.on("error", function (err) {
          sorrirLogger.error(`Error: ${err}`);
        });
      });

      // Set up the local java replica
      const replica_id = getReplicaID(runConfig, targetComponent);

      const path = process.cwd();

      const resilienceLibraryPath =
        runConfig.deploymentConfiguration[runConfig.toExecute]
          ?.resilienceLibrary?.directoryPath ?? "./resilience_library/";
      // Set up my replica if it's included in the execution sites specification
      if (replica_id !== -1) {
        const java = spawn.spawn(
          "java",
          [
            "-Dlogback.configurationFile=./config/logback.xml",
            "-Djava.security.properties=" +
              path +
              "/replicationConfigs/" +
              targetComponent.id +
              "/java.security",
            "-jar",
            "Replica.jar",
            "" + replica_id,
            "" + port,
            path + "/replicationConfigs/" + targetComponent.id,
          ],
          {
            cwd: resilienceLibraryPath + "/bft_smart/",
            shell: true,
            stdio: "inherit",
          }
        );
        java.on("close", function (code) {
          sorrirLogger.info("child process exited with code " + code);
        });
      }

      sorrirLogger.info("Finished setting up replica on port " + port);

      port = port + 2;
    });
  };

  runConfig.shutdownFunctions?.push({
    type: "generic",
    description: "TOM-Replica",
    fn: () => {
      servers.forEach((server) => server.close());
    },
  });

  const bootStrap: () => Promise<void> = async function () {
    servers.forEach((server) =>
      server.on("connect", () => logger.info("Connected to server"))
    );
  };

  return {
    setupEndPoint: setupEndPoint,
    bootStrap: bootStrap,
    isConnected: () =>
      servers
        .map((server) => server.connections > 0)
        .reduce((prev, next) => prev && next),
    onDisconnect: () =>
      new Promise<void>((resolve) =>
        servers.forEach((server) => server.on("close", resolve))
      ),
    onConnect: () =>
      new Promise<void>((resolve) =>
        servers.forEach((server) => server.on("connect", resolve))
      ),
  };
}

export function getReplicaID(
  runConfig: RunConfiguration,
  comp: AtomicComponent<any, any>
): number {
  let replica_id = -1;
  const this_unit = runConfig.toExecute;
  runConfig.resilienceConfiguration?.components?.forEach((component) => {
    // Active replication should be used with this component
    if (
      component.mechanisms?.activeReplication?.enabled &&
      comp.id === component.id
    ) {
      // Execution sites define where replicas are deployed
      const executionSites =
        component.mechanisms?.activeReplication?.executionSites;
      replica_id = executionSites.findIndex(
        (executionSite) => executionSite === this_unit
      );
    }
  });
  return replica_id;
}
