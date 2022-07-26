import { Configuration, AtomicComponent } from "./../../util/component";
import { Port } from "../../util/engine";
import { RunConfiguration } from "./../../exec-types";
import { CommOption, CommunicationTech } from "./../comm-tech";
import {
  computeConnectionsFromLocalToExternal,
  decodeAndPushEvent,
  logStates,
  restrictConfigurationStateToConfiguration,
} from "../comm-util";
import { computeLocallyDeployedConfiguration } from "../comm-util";
import { executeAndCommunicate, outDemux } from "../comm-engine";
import express from "express";
import * as http from "http";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import * as net from "net";
import * as https from "https";
import * as fs from "fs";
import { SSL_OP_TLS_ROLLBACK_BUG } from "constants";
import _ from "lodash";

sorrirLogger.configLogger({ area: "execution" });

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
    "deployedConfiguration in rest/setup.ts",
    {
      deployedConfiguration: {
        components: deployedConfiguration.components,
        connections: deployedConfiguration.connections,
      },
    }
  );
  sorrirLogger.info(Stakeholder.SYSTEM, "toExecute in rest/setup.ts", {
    toExecute: runConfig.toExecute,
  });
  logStates(runConfig);

  const app = express();
  app.use(express.json());

  const setupEndPoint: () => Promise<void> = async function () {
    // calculate connection from local to external
    const toExternalConnections =
      computeConnectionsFromLocalToExternal(runConfig);
    // Create post route for every connection from external to local
    targets.forEach(({ targetComponent, targetPort }) => {
      const path = `/${runConfig.toExecute}/${targetComponent.name}/${targetPort.name}`;
      sorrirLogger.info(Stakeholder.SYSTEM, "add POST route for path", {
        path: path,
      });
      const appPath = app.post(path, function (req, res) {
        sorrirLogger.info(Stakeholder.SYSTEM, "received REST message", {
          message: req.body,
        });
        const success = decodeAndPushEvent(
          runConfig,
          req.body,
          targetPort,
          targetComponent
        );

        if (!success) {
          res.status(401).send("Malformed Request");
          return;
        }

        //TODO: don't execute if event could not be decoded and return different statuscode
        executeAndCommunicate(
          runConfig,
          deployedConfiguration,
          toExternalConnections
        );
        res.status(200).send({});
      });
      runConfig.shutdownFunctions?.push({
        type: "commPort",
        description: `REST-Port '${path}'`,
        commOption: CommOption.REST,
        component: targetComponent,
        port: targetPort,
        path: path,
        fn: () => {
          _.remove(app._router.stack, (obj: any) => obj.route?.path === path);
        },
      });
    });
  };

  let server: net.Server;
  let protocol = "http";
  if (runConfig.securityConfiguration && runConfig.securityConfiguration.ssl) {
    try {
      const sslOptions = {
        key: fs.readFileSync(runConfig.securityConfiguration.privateKey),
        cert: fs.readFileSync(runConfig.securityConfiguration.certificate),
        passphrase: runConfig.securityConfiguration.passphrase,
      };
      server = https.createServer(sslOptions, app);
      protocol = "https";
    } catch (e: any) {
      sorrirLogger.info(Stakeholder.SYSTEM, `unable to setup rest server`, e);
      process.exit(1);
    }
  } else {
    server = http.createServer(app);
  }

  const bootStrap = function () {
    server = server.listen(
      runConfig.hostConfiguration[runConfig.toExecute].port,
      () => {
        sorrirLogger.info(Stakeholder.SYSTEM, `${protocol} server started at`, {
          url: runConfig.hostConfiguration[runConfig.toExecute].host,
          port: runConfig.hostConfiguration[runConfig.toExecute].port,
        });
      }
    );
    // append server.close() to runConfig shutdown array
    runConfig.shutdownFunctions?.push({
      type: "generic",
      description: "REST-Server",
      fn: () => {
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
