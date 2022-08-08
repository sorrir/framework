import { Event, Port } from "../../util/engine";
import { RunConfiguration } from "../../exec-types";
import { AtomicComponent } from "../../util/component";
import * as _ from "lodash";
import * as logger from "winston";
import { Socket } from "net";
import * as spawn from "child_process";
import * as net from "net";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { encodeEventWithNewTimestamp } from "../comm-util";

/**
 *  Sends messages to a locally deployed frontend, which will broadcast these to all replicas for some specific
 *  target component. There is a separate frontend for each target component.
 *  Only call this method when communicating (sending to) a replicated component.
 *
 * @param runConfig the RunConfiguration object
 * @param msgsToMove Array of events to be sent
 * @param targetComponent the receiving component
 * @param targetPort the target Port
 * @param sourceComponent the sender
 * @param frontend the socket to forward these messages to
 */
export function communicate<E>(
  runConfig: RunConfiguration,
  msgsToMove: Event<any, any>[],
  targetComponent: AtomicComponent<any, any>,
  targetPort: Port<E, any>,
  sourceComponent: AtomicComponent<any, any>,
  frontend: Socket
): void {
  sorrirLogger.debug(
    sorrirLogger.Stakeholder.SYSTEM,
    "=> Forwarding to Frontend ",
    { message: msgsToMove }
  );

  const container = Object.keys(runConfig.deploymentConfiguration).filter((c) =>
    _.some(
      runConfig.deploymentConfiguration[c].components,
      (comp) => comp === targetComponent
    )
  )[0];
  const host = runConfig.hostConfiguration[container];

  logger.debug({ container: container });
  logger.debug({ host: host });
  logger.debug({
    msgsToMove: msgsToMove.length,
    //"sourcePort": sourcePort,
  });

  // For each message: send it to local frontend
  msgsToMove.forEach((event: Event<unknown, unknown>) => {
    sorrirLogger.info(sorrirLogger.Stakeholder.SYSTEM, "Sending over TOM", {
      eventType: event.type,
    });

    const extendedPayload = JSON.stringify(
      encodeEventWithNewTimestamp(runConfig, event, sourceComponent, container)
    );

    // Custom protocol over Tcp:
    // 1. Write 32-bit Integer: total message length
    // 2. Write 32-bit Integer: length of message payload
    // 3. Write Bytes of JSON-parsed (UTF-8) message
    const payload: Buffer = Buffer.from(extendedPayload);
    const toWrite: Buffer = Buffer.alloc(4 + 4 + payload.byteLength);
    toWrite.writeInt32BE(4 + payload.byteLength, 0);
    toWrite.writeInt32BE(payload.byteLength, 4);
    toWrite.write(extendedPayload, 8, "utf8");
    frontend.write(toWrite);
  });
}

/**
 * Creates a new Frontend for a specific target
 *
 * @param runConfiguration
 * @param target
 * @param frontends list of maintained frontends
 */
export function initFrontend(
  runConfiguration: RunConfiguration,
  target: AtomicComponent<any, any>,
  frontends: Map<AtomicComponent<any, any>, Socket | undefined>
): Socket | undefined {
  // Set up the local Java frontend
  // A frontend is spawned in a distinct child process and its stdout is appended to the console of the NodeJS process
  const this_unit = runConfiguration.toExecute;

  // stackoverflow-magic for simple injective hashcode function
  const hashCode = (s) =>
    s.split("").reduce((a, b) => {
      a = (a << 5) - a + b.charCodeAt(0);
      return a & a;
    }, 0);

  const id = 1001 + parseInt(hashCode(this_unit));
  const port = runConfiguration.hostConfiguration[this_unit].port + 3; // increase per component proxy
  const path = process.cwd();
  const resilienceLibraryPath =
    runConfiguration.deploymentConfiguration[runConfiguration.toExecute]
      ?.resilienceLibrary?.directoryPath ?? "./resilience_library/";

  const java = spawn.spawn(
    "java",
    [
      "-Dlogback.configurationFile=./config/logback.xml",
      "-Djava.security.properties=" +
        path +
        "/replicationConfigs/" +
        target.id +
        "/java.security",
      "-jar",
      "Frontend.jar",
      "" + id,
      "" + port,
      path + "/replicationConfigs/" + target.id,
      "false",
      "nosig",
    ],
    {
      cwd: resilienceLibraryPath + "/bft_smart/",
      shell: true,
      stdio: "inherit",
    }
  );
  java.on("close", function (code) {
    sorrirLogger.info(
      sorrirLogger.Stakeholder.SYSTEM,
      "child process exited with code",
      { code: code }
    );
  });

  sorrirLogger.info(
    sorrirLogger.Stakeholder.SYSTEM,
    "Started a local Frontend on port " +
      port +
      " for target " +
      target.id +
      " with own id " +
      id,
    {}
  );

  // Set up the connection to the previously replica local frontend
  // a net socket is created to write message to the local frontend, which acts as a proxy for sending events to some
  // specific target (target is the replicated receiving component)
  const tomClient: Socket = new net.Socket();
  const connect: () => Socket = () => {
    sorrirLogger.info(
      sorrirLogger.Stakeholder.SYSTEM,
      " Establishing connection to a local frontend for target  ${target.id}",
      {}
    );

    return tomClient.connect(port, "127.0.0.1");
  };

  let reconnect: NodeJS.Timeout;

  // On(Error) might be called, if the java frontend terminates unexpectedly or if it has not yet finished setting up its
  // server socket at the time we try connecting to it :)
  tomClient.on("error", function (error) {
    sorrirLogger.info(
      sorrirLogger.Stakeholder.SYSTEM,
      "Ups, something happened: ",
      { info: error }
    );

    // Let's just periodically try to reconnect to our frontend each interval
    reconnect = setInterval(connect, 2000);
  });

  // Upon successful connection, we need to add this connection to our list of managed frontends, called tomClients
  tomClient.on("connect", function () {
    sorrirLogger.info(
      sorrirLogger.Stakeholder.SYSTEM,
      "tomClient Connected successfully to target  ${target.id} ",
      {}
    );

    frontends.set(target, tomClient);

    if (reconnect) {
      clearInterval(reconnect);
    }
  });

  try {
    tomClient.connect(port, "127.0.0.1");
  } catch (e) {
    sorrirLogger.error(
      sorrirLogger.Stakeholder.SYSTEM,
      "Ups, something happened: ",
      { error: e }
    );
  }

  return tomClient;
}
