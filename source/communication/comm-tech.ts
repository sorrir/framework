import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";

sorrirLogger.configLogger({ area: "execution" });

export interface CommunicationTech {
  readonly setupEndPoint: () => Promise<void> | void;
  //readonly setupEndPoint: (runConfig:RunConfiguration, connection: Connection<unknown>) => void,
  readonly bootStrap: () => Promise<void> | void;
  //readonly bootStrap: (runConfig:RunConfiguration, connection: Connection<unknown>) => void
  readonly isConnected: () => boolean;
  readonly onConnect: () => Promise<void>;
  readonly onDisconnect: () => Promise<void>;
}

export enum CommOption {
  REST = "REST",
  MQTT = "MQTT",
  MQTT_EXTERNAL = "MQTT_EXTERNAL",
  BLUETOOTH = "BLUETOOTH",
  TOM = "TOM",
}

export function errorSetup(cOption: CommOption): CommunicationTech {
  return {
    setupEndPoint: async () => {
      sorrirLogger.error(Stakeholder.SYSTEM, "Cannot setup endpoint for tech", {
        CommOption: cOption.toString(),
      });
    },
    bootStrap: () => {
      sorrirLogger.error(Stakeholder.SYSTEM, "Cannot bootStrap for tech", {
        CommOption: cOption.toString(),
      });
    },
    isConnected: () => {
      sorrirLogger.error(
        Stakeholder.SYSTEM,
        "Cannot return CommObject for tech",
        { CommOption: cOption.toString() }
      );
      return false;
    },
    onConnect: () => {
      return new Promise((resolve, reject) => {
        reject();
      });
    },
    onDisconnect: () => {
      return new Promise((resolve, reject) => {
        reject();
      });
    },
  };
}
