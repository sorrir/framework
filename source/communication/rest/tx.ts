import { Event, Port } from "../../util/engine";
import { RunConfiguration } from "../../exec-types";
import { AtomicComponent } from "../../util/component";
import * as _ from "lodash";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { encodeEventWithNewTimestamp, onCommError } from "../comm-util";
import * as crypto from "crypto-js";
import axios from "axios";
import * as https from "https";

sorrirLogger.configLogger({ area: "execution" });

export function communicate<E>(
  runConfig: RunConfiguration,
  msgsToMove: Event<any, any>[],
  targetComponent: AtomicComponent<any, any>,
  targetPort: Port<E, any>,
  sourceComponent: AtomicComponent<any, any>
): void {
  const container = Object.keys(runConfig.deploymentConfiguration).filter((c) =>
    _.some(
      runConfig.deploymentConfiguration[c].components,
      (comp) => comp === targetComponent
    )
  )[0];
  sorrirLogger.debug(Stakeholder.SYSTEM, "", { container: container });
  const host = runConfig.hostConfiguration[container];
  sorrirLogger.debug(Stakeholder.SYSTEM, "", { host: host.host });

  const targetURI = `${container}/${targetComponent.name}/${targetPort.name}`;
  const protocol = runConfig.securityConfiguration
    ? runConfig.securityConfiguration.ssl
      ? "https"
      : "http"
    : "http";
  const axiosInstance = axios.create({
    baseURL: `${protocol}://${host.host}:${host.port}/`,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false, //TODO fix this if use real certificate
    }),
  });

  sorrirLogger.debug(Stakeholder.SYSTEM, "", {
    msgsToMove: msgsToMove.length,
    targetURI: targetURI,
  });
  msgsToMove.forEach((event: Event<unknown, unknown>) => {
    sorrirLogger.info(Stakeholder.SYSTEM, "Sending over REST", {
      eventType: event.type,
    });

    const message = encodeEventWithNewTimestamp(
      runConfig,
      event,
      sourceComponent,
      container
    );

    axiosInstance.post(targetURI, message).catch(function (error) {
      onCommError(runConfig, sourceComponent, targetComponent, container);
      sorrirLogger.error(
        Stakeholder.SYSTEM,
        "Sending over REST - Axios Error",
        error
      );
    });
  });
}
