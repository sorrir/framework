import { Event, Port } from "../../util/engine";
import { MqttClient } from "mqtt";
import { RunConfiguration } from "../../exec-types";
import { AtomicComponent } from "../../util/component";
import * as _ from "lodash";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { encodeEventWithNewTimestamp } from "../comm-util";

sorrirLogger.configLogger({ area: "execution" });

export function communicate<E>(
  runConfig: RunConfiguration,
  msgsToMove: Event<any, any>[],
  targetComponent: AtomicComponent<any, any>,
  targetPort: Port<E, any>,
  mqttClient: MqttClient,
  sourceComponent: AtomicComponent<any, any>,
  toExternal = false
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

  const topic = `${targetComponent.name}/${targetPort.name}`;

  sorrirLogger.debug(Stakeholder.SYSTEM, "", {
    msgsToMove: msgsToMove.length,
    topic: topic,
  });
  msgsToMove.forEach((event: Event<unknown, unknown>) => {
    if (toExternal) {
      const payload = JSON.stringify(_.omit(event, ["type", "port"]));
      mqttClient.publish(`${targetComponent.name}/${event.type}`, `${payload}`);
    } else {
      sorrirLogger.info(Stakeholder.SYSTEM, "Sending over MQTT", {
        eventType: event.type,
      });

      const message = encodeEventWithNewTimestamp(
        runConfig,
        event,
        sourceComponent,
        container
      );

      mqttClient.publish(topic, JSON.stringify(message));
    }
  });
}
