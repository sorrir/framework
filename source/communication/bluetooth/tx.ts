import { Event, Port } from "../../util/engine";
import { RunConfiguration } from "../../exec-types";
import { AtomicComponent } from "../../util/component";
import * as _ from "lodash";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { encodeEventWithNewTimestamp } from "../comm-util";
import axios from "axios";

sorrirLogger.configLogger({ area: "execution" });

export function communicate<E>(
  runConfiguration: RunConfiguration,
  msgsToMove: Event<any, any>[],
  sourceComponent: AtomicComponent<any, any>,
  sourcePort: Port<E, any>,
  targetComponent: AtomicComponent<any, any>,
  targetPort: Port<E, any>
): void {
  const container = Object.keys(
    runConfiguration.deploymentConfiguration
  ).filter((c) =>
    _.some(
      runConfiguration.deploymentConfiguration[c].components,
      (comp) => comp === targetComponent
    )
  )[0];
  sorrirLogger.debug(Stakeholder.SYSTEM, "", { container: container });

  const proxy = runConfiguration.bleConfiguration?.[runConfiguration.toExecute];
  sorrirLogger.debug(Stakeholder.SYSTEM, "", { proxy: proxy?.sendHost });

  const axiosInstance = axios.create({
    baseURL: `http://${proxy?.sendHost}:${proxy?.sendPort}/`,
  });

  const address = `/${container}/${targetComponent.name}/${targetPort.name}`;
  const sender = `/${runConfiguration.toExecute}/${sourceComponent.name}/${sourcePort.name}`;

  sorrirLogger.debug(Stakeholder.SYSTEM, "", {
    msgsToMove: msgsToMove.length,
    sourcePort: sourcePort,
    targetURI: address,
  });
  msgsToMove.forEach((event: Event<unknown, unknown>) => {
    sorrirLogger.info(Stakeholder.SYSTEM, "Sending over Bluetooth", {
      eventType: event.type,
    });

    const message = encodeEventWithNewTimestamp(
      runConfiguration,
      event,
      sourceComponent,
      container
    );

    axiosInstance
      .post(`ble`, {
        action: "sendEvent",
        targetAddress: address,
        targetUnit: container,
        senderAddress: sender,
        ...message,
      })
      .catch(function (error) {
        sorrirLogger.error(Stakeholder.SYSTEM, "Bluetooth TX", error);
      });
  });
}
