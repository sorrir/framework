import * as convict from "convict";
import * as _ from "lodash";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { CommOption } from "../communication/comm-tech";
import {
  BLEConfiguration,
  CommunicationConfiguration,
  ConnectionTech,
  DebuggingConfiguration,
  DegradationConfiguration,
  DeploymentConfiguration,
  HostConfiguration,
  ResilienceConfiguration,
  RunConfiguration,
  SecurityConfiguration,
} from "../exec-types";
import {
  AtomicComponent,
  attachIDtoComponent,
  Configuration,
  ConfigurationState,
  createConnection,
} from "../util/component";
import { AbstractState } from "../util/engine";
import { setDecoder, basicEventDecoder } from "../communication/decoding";
import {
  getAppConfig,
  getSetupConfig,
  getSecurityConfig,
  getDegradationConfig,
} from "../config";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { getSetupInfo, getReflectableModules } from "../util/reflect";
import { EngineRoomState, ShadowModeConfiguration } from "..";

export function setupRunConfig(): RunConfiguration {
  const setupConfigJSON = <Record<string, any>>getSetupConfig().getProperties();
  const modules = getReflectableModules();
  const appConfig = getAppConfig();
  const securityConfig = getSecurityConfig();
  const degradationConfig = getDegradationConfig();

  // init components and their states
  const components: Record<string, AtomicComponent<any, any>> = {};
  const states: Record<string, AbstractState<any, any, any>> = {};
  for (const componentName of Object.keys(setupConfigJSON.componentInstances)) {
    const instances = setupConfigJSON.componentInstances[componentName];
    instances.forEach(
      (instance: {
        name: string;
        startState?: string;
        startStateGenerator?: string;
        startStateArgs?: {
          [arg: string]: "number" | "boolean" | "string";
        };
      }) => {
        const component = modules.components[componentName];
        // prefer start state generator if available
        let state: AbstractState<any, any, any> | undefined;
        if (instance.startStateGenerator !== undefined) {
          const startStateGenerator =
            modules.stateGenerators[instance.startStateGenerator];
          if (startStateGenerator === undefined) {
            sorrirLogger.error(
              Stakeholder.SYSTEM,
              "Cannot set up state, no exported StateGenerator found with the given name.",
              {
                componentName: componentName,
                instanceName: instance.name,
                StateGeneratorName: instance.startStateGenerator,
              }
            );
            exitProcess();
          }
          const argTypes = startStateGenerator.argTypes;
          const startStateArgs = instance.startStateArgs ?? {};
          if (
            !_.every(
              Object.entries(argTypes),
              ([argName, argType]) => typeof startStateArgs[argName] === argType
            )
          ) {
            sorrirLogger.error(
              Stakeholder.SYSTEM,
              "Cannot set up component, arguments are missing or given argument types do not fit the given start state generator.",
              {
                componentName: componentName,
                instance: instance.name,
                args: instance.startStateArgs,
                expectedArgTypes: startStateGenerator.argTypes,
              }
            );
            exitProcess();
          }
          state = startStateGenerator.generate(startStateArgs);
        } else if (instance.startState !== undefined) {
          state = modules.states[instance.startState];
          if (state === undefined) {
            sorrirLogger.error(
              Stakeholder.SYSTEM,
              "Cannot set up state, no exported State found with the given name.",
              {
                componentName: componentName,
                instanceName: instance.name,
                StateName: instance.startState,
              }
            );
            exitProcess();
          }
        } else {
          sorrirLogger.error(
            Stakeholder.SYSTEM,
            "Cannot set up state, neither startState nor startStateGenerator given.",
            {
              componentName: componentName,
              instanceName: instance.name,
            }
          );
          exitProcess();
        }

        if (state === undefined) {
          sorrirLogger.error(Stakeholder.SYSTEM, "Error setting up state.", {
            componentName: componentName,
            instanceName: instance.name,
          });
          exitProcess();
        } else if (component === undefined) {
          sorrirLogger.error(
            Stakeholder.SYSTEM,
            "Cannot set up component, no export found with the given name.",
            {
              componentName: componentName,
            }
          );
          exitProcess();
        } else if (
          !(instance.name !== undefined && typeof instance.name === "string")
        ) {
          sorrirLogger.error(
            Stakeholder.SYSTEM,
            "Cannot set up component, no name defined",
            {
              componentName: componentName,
            }
          );
          exitProcess();
        } else if (component.tsType !== "Component") {
          sorrirLogger.error(
            Stakeholder.SYSTEM,
            "Cannot set up component, object needs to be type 'AtomicComponent'",
            {
              componentName: componentName,
              instanceName: instance.name,
            }
          );
          exitProcess();
        } else if (
          state.tsType !== "State" ||
          state.state === undefined ||
          !(state.events instanceof Array)
        ) {
          sorrirLogger.error(
            Stakeholder.SYSTEM,
            "Cannot set up component, state needs to implement 'AbstractState'",
            {
              componentName: componentName,
              instanceName: instance.name,
              stateName: instance.startState,
            }
          );
          exitProcess();
        } else {
          components[instance.name] = {
            ...attachIDtoComponent(component, instance.name),
            name: instance.name,
          };
          states[instance.name] = { ...state };
        }
      }
    );
  }

  // Create application configuration consisting of
  // components and their connections in between.
  const configuration: Configuration = {
    components: _.values(components),
    connections: _.map(setupConfigJSON.connections, (c) => {
      const target = components[c.targetComponent];
      const source = components[c.sourceComponent];
      try {
        return createConnection(source, c.sourcePort, target, c.targetPort);
      } catch (e) {
        // return any object to avoid ts complaining, this function exits the process
        return <any>exitProcess();
      }
    }),
  };

  // Conf state holds for each component its state. At this point,
  // an initial state is assigned.
  const confState: ConfigurationState = {
    componentState: new Map(
      _.map(Object.keys(components), (componentName) => [
        components[componentName],
        states[componentName],
      ])
    ),
  };

  // Deployment configuration holds the components that should run within a container
  const deploymentConfiguration: DeploymentConfiguration = appConfig.get(
    "DeploymentConfiguration"
  );
  // resolve components
  for (const unit in deploymentConfiguration) {
    for (const componentName in deploymentConfiguration[unit].components) {
      for (const componentKey in configuration.components) {
        if (
          configuration.components[componentKey].name ===
          deploymentConfiguration[unit].components[componentName].toString()
        ) {
          // override component string representation with component
          deploymentConfiguration[unit].components[componentName] =
            configuration.components[componentKey];
        }
      }
    }
  }

  // Host configuration holds for each group the hostname as well as port number
  const hostConfig: HostConfiguration = appConfig.get("HostConfiguration");

  // workaround for some port numbers being NaN when deployed in a container via the generator
  // all data is in production/development.json byte-for-byte, but parsing fails for no reason
  // most likely source is a bug in convict
  let needsWorkaround = false;
  for (const key of Object.keys(hostConfig)) {
    if (!Number.isInteger(hostConfig[key].port)) {
      needsWorkaround = true;
      break;
    }
  }
  if (needsWorkaround) {
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "At least one port is not a number; Convict seems to have failed. Trying to correct...",
      {
        hostConfig: hostConfig,
      }
    );
    // reads the location of the deployment config relative to execution path
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const data = require(`${process.cwd()}/config/${appConfig.get(
      "env"
    )}.json`);
    Object.keys(hostConfig).forEach((key) => {
      if (!Number.isInteger(hostConfig[key].port)) {
        hostConfig[key].port = data.HostConfiguration[key].port;
      }
    });
  }

  const communicationConfiguration: CommunicationConfiguration = appConfig.get(
    "CommunicationConfiguration"
  );
  // resolve connTechs
  // todo: those casts might be error-prone
  for (const connectionTech of communicationConfiguration.connectionTechs) {
    // override commOption string representation with enum-val
    // default to rest
    const stringRep = (<ConnectionTech>connectionTech).commOption.toString();
    connectionTech.commOption = (<any>CommOption)[stringRep];
    const confSourceComp = (<ConnectionTech>(
      connectionTech
    )).sourceComponent.toString();
    const confSourcePort = (<ConnectionTech>(
      connectionTech
    )).sourcePort.toString();
    const confTargetComp = (<ConnectionTech>(
      connectionTech
    )).targetComponent.toString();
    const confTargetPort = (<ConnectionTech>(
      connectionTech
    )).targetPort.toString();

    let found = false;

    for (const connection of configuration.connections) {
      const appSourceComp = connection.source.sourceComponent.name;
      const appSourcePort = connection.source.sourcePort.name;
      const appTargetComp = connection.target.targetComponent.name;
      const appTargetPort = connection.target.targetPort.name;

      if (
        confSourceComp === appSourceComp &&
        confSourcePort === appSourcePort &&
        confTargetComp === appTargetComp &&
        confTargetPort === appTargetPort
      ) {
        connectionTech.sourceComponent = connection.source.sourceComponent;
        connectionTech.sourcePort = connection.source.sourcePort;
        connectionTech.targetComponent = connection.target.targetComponent;
        connectionTech.targetPort = connection.target.targetPort;
        found = true;
      }
    }

    if (!found) {
      sorrirLogger.error(
        Stakeholder.SYSTEM,
        "Configuration mismatch for ConnectionTech",
        {
          connectionTech: connectionTech,
        }
      );
    }
  }

  const bleConfig: BLEConfiguration = appConfig.get("BLEConfiguration");

  const shadowModeConfig: ShadowModeConfiguration = appConfig.get(
    "ShadowModeConfiguration"
  );

  const degradationConfiguration: DegradationConfiguration = degradationConfig
    ? degradationConfig["_instance"]
    : null;

  const debuggingConfig: DebuggingConfiguration = appConfig.get(
    "DebuggingConfiguration"
  );

  const resilienceConfiguration: ResilienceConfiguration = {
    components: appConfig.get("ResilienceConfiguration").components,
  };

  const securityConfiguration: SecurityConfiguration = securityConfig
    ? securityConfig["_instance"]
    : null;

  const engineRoomState: EngineRoomState = {
    shadowMap: new Map(),
  };

  // encapsulates all configuration objects defined before
  let runConfig: RunConfiguration = {
    lsa: configuration,
    toExecute: appConfig.get("toExecute"),
    // the document
    deploymentConfiguration: deploymentConfiguration,
    communicationConfiguration: communicationConfiguration,
    hostConfiguration: hostConfig,
    bleConfiguration: bleConfig,
    shadowModeConfiguration: shadowModeConfig,
    degradationConfiguration: degradationConfiguration,
    debuggingConfiguration: debuggingConfig,
    confState: confState,
    clockStates: new Map(),
    resilienceConfiguration: resilienceConfiguration,
    engineRoomState: engineRoomState,
    securityConfiguration: securityConfiguration,
    mqttState: {},
    shutdownFunctions: [],
  };

  if (
    appConfig.get("MQTTConfiguration") &&
    appConfig.get("MQTTConfiguration") !== ""
  ) {
    runConfig.mqttConfiguration = appConfig.get("MQTTConfiguration");
  }

  // Assign decoder for each event
  // TODO: allow specific decoders
  const allEventTypes = _.uniq(
    _.flatMap(
      _.flatMap(components, (c) => c.ports),
      (port) => port.eventTypes
    )
  );
  allEventTypes.forEach((eventType) => {
    runConfig = setDecoder(runConfig, eventType, basicEventDecoder);
  });

  if (runConfig.decodeEventFunctions) {
    sorrirLogger.info(Stakeholder.SYSTEM, "", {
      decodeFunctions: Object.keys(runConfig.decodeEventFunctions),
    });
  }

  return runConfig;
}

/**
 * Function to be called if the setup fails.
 */
function exitProcess() {
  sorrirLogger.error(
    Stakeholder.SYSTEM,
    "Failed setting up RunConfiguration. Exiting process.",
    {}
  );
  process.exit(1);
}
