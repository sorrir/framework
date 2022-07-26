import { CommOption } from "./communication/comm-tech";
import { DecodeEventFunction } from "./communication/decoding";
import { AtomicComponent } from "./util/component";
import { Configuration, ConfigurationState } from "./util/component";
import { ClockStates } from "./util/clocks";
import {
  PartialShadowMapContent,
  ShadowMap,
  ShadowTimestamp,
} from "./util/degradation";
import { MqttClient } from "mqtt";
import { Port } from "./util/engine";

// Interface that describes on which container a component is deployed
export type DeploymentConfiguration = {
  readonly [container: string]: {
    resilienceLibrary?: { directoryPath: string };
    components: AtomicComponent<any, any>[];
  };
};

export type HostConfiguration = {
  readonly [container: string]: {
    host: string;
    port: number;
  };
};

// todo: adapt analoguously to interface Connection definition
export type ConnectionTech = {
  readonly sourceContainer: string;
  sourceComponent: AtomicComponent<any, any>;
  sourcePort: any;
  readonly targetContainer: string;
  targetComponent: AtomicComponent<any, any>;
  targetPort: any;
  commOption: CommOption;
};

export type CommunicationConfiguration = {
  readonly connectionTechs: ConnectionTech[];
};

export type MQTTConfiguration = {
  readonly host: string;
  readonly username?: string;
  readonly password?: string;
};

export type BLEConfiguration = {
  readonly [container: string]: {
    sendHost: string;
    sendPort: number;
    listenHost: string;
    listenPort: number;
  };
};

export type ResilienceConfiguration = {
  readonly components?: any[];
};

export type SecurityConfiguration = {
  readonly ssl: boolean;
  readonly privateKey: string;
  readonly certificate: string;
  readonly passphrase: string;
  communicationSecret: any[];
};

export type ShadowAgentConfig = {
  readonly enabled: boolean;
  readonly commOptions: CommOption[];
  readonly autoUpdate: {
    readonly intervalSeconds: number;
    readonly strategy: "push" | "gossip";
    readonly content: PartialShadowMapContent;
    readonly limit: number;
  };
};

export type ShadowModeConfiguration = {
  readonly [container: string]: {
    readonly inMessageSharing: {
      readonly enabled: boolean;
      readonly content: PartialShadowMapContent;
      readonly limit: number;
    };
    readonly shadowAgent: ShadowAgentConfig;
  };
};

export type DebuggingAgentConfig = {
  readonly enabled: boolean;
  readonly isServer: boolean;
  readonly checkForChangesIntervalMs: number;
  readonly commOptions: CommOption[];
  readonly webSocketPort?: number;
};

export type DebuggingConfiguration = {
  readonly [container: string]: {
    readonly debuggingAgent: DebuggingAgentConfig;
  };
};

export type EngineRoomState = {
  shadowMap: ShadowMap<any>;
  shadowAgentEnabled?: boolean;
  shadowAgentTargets?: string[];
  debuggingAgentEnabled?: boolean;
  debuggingAgentTargets?: string[];
  debuggingAgentIsServer?: boolean;
};

export type MQTTState = {
  mqttClient?: MqttClient;
};

interface AbstractShutdownFunction {
  type: "generic" | "commPort";
  description: string;
  fn: () => void;
}

export interface GenericShutdownFunction extends AbstractShutdownFunction {
  type: "generic";
}

export interface CommPortShutdownFunction extends AbstractShutdownFunction {
  type: "commPort";
  commOption: CommOption;
  path: string;
  port: Port<unknown, unknown>;
  component: AtomicComponent<unknown, unknown>;
}

export type ShutdownFunction =
  | GenericShutdownFunction
  | CommPortShutdownFunction;

export type RunConfiguration = {
  lsa: Configuration;
  readonly hostConfiguration: HostConfiguration;
  readonly deploymentConfiguration: DeploymentConfiguration;
  readonly communicationConfiguration: CommunicationConfiguration;
  readonly toExecute: string;
  readonly decodeEventFunctions?: { [event: string]: DecodeEventFunction };
  confState: ConfigurationState;
  mqttConfiguration?: MQTTConfiguration;
  readonly bleConfiguration?: BLEConfiguration;
  readonly shutdownFunctions?: ShutdownFunction[];
  clockStates: Map<AtomicComponent<any, any>, ClockStates>;
  resilienceConfiguration?: ResilienceConfiguration;
  engineRoomState: EngineRoomState;
  securityConfiguration?: SecurityConfiguration;
  mqttState?: MQTTState;
  readonly shadowModeConfiguration?: ShadowModeConfiguration;
  readonly debuggingConfiguration?: DebuggingConfiguration;
};
