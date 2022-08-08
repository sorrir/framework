import _ = require("lodash");
import * as sorrirLogger from "@sorrir/sorrir-logging";
import {
  basicEventDecoder,
  DebuggingAgentEventTypeExternal,
  debuggingAgentName,
  DebuggingAgentPort,
  getDebuggingAgentComponent,
  PartialShadowMapContent,
  setDecoder,
} from "..";
import {
  getShadowAgentComponent,
  ShadowAgentEventTypeExternal,
  shadowAgentName,
} from "../agents/shadow-agent";
import { RunConfiguration, ShadowAgentConfig } from "../exec-types";
import {
  AtomicComponent,
  Connection,
  createConnection,
} from "../util/component";
import { createPort } from "../util/engine";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { Nothing } from "@typed/maybe";

export function setupAgents(runConfig: RunConfiguration): RunConfiguration {
  runConfig = setupShadowAgent(runConfig);
  runConfig = setupDebuggingAgent(runConfig);
  return runConfig;
}

function setupShadowAgent(runConfig: RunConfiguration) {
  const localUnit = runConfig.toExecute;

  // configure shadow agent for usage as heartbeat provider
  // if debugging agent is enabled
  type ShadowModeConfigurationInternal = {
    [container: string]: {
      readonly inMessageSharing: {
        readonly enabled: boolean;
        readonly content: PartialShadowMapContent;
        readonly limit: number;
      };
      readonly shadowAgent: ShadowAgentConfig;
    };
  };
  Object.entries(runConfig.debuggingConfiguration ?? {}).forEach(
    ([unit, config]) => {
      if (config.debuggingAgent.enabled) {
        // init shadowModeConfiguration if not set at all
        (<any>runConfig.shadowModeConfiguration) =
          runConfig.shadowModeConfiguration ?? {};

        const previousConfiguration = runConfig.shadowModeConfiguration?.[unit];
        if (previousConfiguration === undefined) {
          (
            runConfig.shadowModeConfiguration as ShadowModeConfigurationInternal
          )[unit] = {
            inMessageSharing: {
              enabled: true,
              content: PartialShadowMapContent.LOCAL_ONLY,
              limit: -1,
            },
            shadowAgent: {
              enabled: true,
              autoUpdate: {
                intervalSeconds: Math.min(
                  (config.debuggingAgent.checkForChangesIntervalMs ?? 1000) /
                    100,
                  1
                ),
                strategy: "push",
                content: PartialShadowMapContent.LOCAL_ONLY,
                limit: -1,
              },
              commOptions: config.debuggingAgent.commOptions,
            },
          };
        } else {
          (<any>runConfig.shadowModeConfiguration?.[unit].shadowAgent).enabled =
            true;
        }
      }
    }
  );

  // skip this setup if the local agent is disabled
  if (
    runConfig.shadowModeConfiguration?.[localUnit]?.shadowAgent.enabled !== true
  ) {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Shadow agent is disabled. Skipping initialization.",
      {}
    );
    return runConfig;
  }

  // set shadow agent enabled
  runConfig.engineRoomState.shadowAgentEnabled = true;

  const localCommOptions =
    runConfig.shadowModeConfiguration?.[localUnit]?.shadowAgent.commOptions;

  sorrirLogger.info(Stakeholder.SYSTEM, "Shadow agent is enabled.", {});

  runConfig.engineRoomState.shadowAgentTargets = [];
  const externalUnitsWithCompatibleShadowAgent = _.compact(
    _.map(
      Object.entries(runConfig.shadowModeConfiguration),
      ([unit, config]) => {
        if (unit === localUnit || config.shadowAgent.enabled !== true)
          return undefined;
        const commonCommOptions = _.intersection(
          localCommOptions,
          config.shadowAgent.commOptions
        );
        runConfig.engineRoomState.shadowAgentTargets?.push(unit);
        return { unit: unit, commOptions: commonCommOptions };
      }
    )
  );
  const { shadowAgent, shadowAgentStartState } = getShadowAgentComponent(
    _.map(externalUnitsWithCompatibleShadowAgent, "unit")
  );
  (shadowAgent as any).id = shadowAgent.name + "_" + localUnit;
  runConfig.lsa.components.push(<AtomicComponent<any, any>>shadowAgent);
  runConfig.deploymentConfiguration[localUnit].components.push(
    <AtomicComponent<any, any>>shadowAgent
  );

  const outGoingShadowAgentConnections: Connection<any>[] = [];
  externalUnitsWithCompatibleShadowAgent.forEach(({ unit, commOptions }) => {
    // create mock component for each externally run shadow agent
    const externalAgent = {
      name: shadowAgentName,
      step: (state) => Nothing,
      allSteps: (state) => [state],
      ports: [
        createPort("IN", Object.values(ShadowAgentEventTypeExternal), "in"),
        createPort(
          "OUT_" + localUnit,
          Object.values(ShadowAgentEventTypeExternal),
          "out"
        ),
      ],
      tsType: <const>"Component",
      isExternalMock: true,
      isAgent: <const>true,
    };
    (externalAgent as any).id = externalAgent.name + "_" + unit;
    runConfig.lsa.components[externalAgent.name] =
      runConfig.lsa.components.push(externalAgent);
    runConfig.deploymentConfiguration[unit].components.push(externalAgent);

    // first commOption of the common commOptions as priority
    const commOption = commOptions[0];

    // create incoming connection from external shadowagent
    const incomingConnection = createConnection(
      externalAgent,
      "OUT_" + localUnit,
      <AtomicComponent<any, any>>shadowAgent,
      "IN"
    );
    runConfig.communicationConfiguration.connectionTechs.push({
      sourceContainer: unit,
      ...incomingConnection.source,
      targetContainer: localUnit,
      ...incomingConnection.target,
      commOption: commOption,
    });

    // create outgoing connection to external shadowagent
    const outgoingConnection = createConnection(
      <AtomicComponent<any, any>>shadowAgent,
      "OUT_" + unit,
      externalAgent,
      "IN"
    );
    runConfig.communicationConfiguration.connectionTechs.push({
      sourceContainer: localUnit,
      ...outgoingConnection.source,
      targetContainer: unit,
      ...outgoingConnection.target,
      commOption: commOption,
    });

    // add connections to runconfig
    runConfig.lsa.connections.push(incomingConnection);
    runConfig.lsa.connections.push(outgoingConnection);

    // add outgoing connection to list that is auto-executed by the agent
    outGoingShadowAgentConnections.push(outgoingConnection);
  });

  // set decoder for shadow-agent events
  Object.keys(ShadowAgentEventTypeExternal).forEach((eventType) => {
    runConfig = setDecoder(runConfig, eventType, basicEventDecoder);
  });

  runConfig.confState.componentState.set(shadowAgent, shadowAgentStartState);

  return runConfig;
}

function setupDebuggingAgent(runConfig: RunConfiguration) {
  const localUnit = runConfig.toExecute;
  const debuggingAgentConfig =
    runConfig.debuggingConfiguration?.[localUnit]?.debuggingAgent;

  // skip this setup if the local agent is disabled
  if (
    runConfig.debuggingConfiguration === undefined ||
    debuggingAgentConfig?.enabled !== true
  ) {
    sorrirLogger.info(
      Stakeholder.SYSTEM,
      "Debugging agent is disabled. Skipping initialization.",
      {}
    );
    return runConfig;
  }

  // set debugging agent enabled
  runConfig.engineRoomState.debuggingAgentEnabled = true;
  runConfig.engineRoomState.debuggingAgentIsServer =
    debuggingAgentConfig.isServer;

  const localCommOptions =
    runConfig.debuggingConfiguration?.[localUnit]?.debuggingAgent.commOptions;

  sorrirLogger.info(Stakeholder.SYSTEM, "Debugging agent is enabled.", {});

  // calculate target units for connections
  runConfig.engineRoomState.debuggingAgentTargets = [];
  const externalUnitsWithCompatibleDebuggingAgent = _.compact(
    _.map(
      Object.entries(runConfig.debuggingConfiguration),
      ([unit, config]) => {
        // only allow units that are not local unit and that have a debugging
        // agent enabled
        if (unit === localUnit || config.debuggingAgent.enabled !== true)
          return undefined;

        // only allow connections from agent to server and from server to agent
        if (config.debuggingAgent.isServer === debuggingAgentConfig.isServer)
          return undefined;

        // determine common comm options
        const commonCommOptions = _.intersection(
          localCommOptions,
          config.debuggingAgent.commOptions
        );

        // add target unit to list
        runConfig.engineRoomState.debuggingAgentTargets?.push(unit);
        return { unit: unit, commOptions: commonCommOptions };
      }
    )
  );
  sorrirLogger.debug(
    Stakeholder.SYSTEM,
    "Debugging agent External Components.",
    {
      localUnit: localUnit,
      externalUnits: externalUnitsWithCompatibleDebuggingAgent.map(
        (value) => value.unit
      ),
    }
  );
  const { debuggingAgent, debuggingAgentStartState } =
    getDebuggingAgentComponent(runConfig, debuggingAgentConfig.isServer);

  (debuggingAgent as any).id = debuggingAgent.name + "_" + localUnit;

  runConfig.lsa.components.push(<AtomicComponent<any, any>>debuggingAgent);
  runConfig.deploymentConfiguration[localUnit].components.push(
    <AtomicComponent<any, any>>debuggingAgent
  );

  // determine outgoing connections
  const outGoingDebuggingAgentConnections: Connection<any>[] = [];
  externalUnitsWithCompatibleDebuggingAgent.forEach(({ unit, commOptions }) => {
    // create mock component for each externally run debugging agent
    const externalAgent = {
      name: debuggingAgentName,
      step: (state) => Nothing,
      allSteps: (state) => [state],
      ports: [
        createPort(
          debuggingAgentConfig.isServer
            ? DebuggingAgentPort.CONTROL_IN
            : DebuggingAgentPort.DATA_IN,
          Object.values(DebuggingAgentEventTypeExternal),
          "in"
        ),
        createPort(
          debuggingAgentConfig.isServer
            ? DebuggingAgentPort.DATA_OUT
            : DebuggingAgentPort.CONTROL_OUT,
          Object.values(DebuggingAgentEventTypeExternal),
          "out"
        ),
      ],
      tsType: <const>"Component",
      id: debuggingAgentName + "_" + unit,
      isExternalMock: true,
      isAgent: <const>true,
    };
    runConfig.lsa.components[externalAgent.name] =
      runConfig.lsa.components.push(externalAgent);
    runConfig.deploymentConfiguration[unit].components.push(externalAgent);

    // first commOption of the common commOptions as priority
    const commOption = commOptions[0];

    // create incoming connection from external debuggingagent
    const incomingConnection = createConnection(
      externalAgent,
      debuggingAgentConfig.isServer
        ? DebuggingAgentPort.DATA_OUT
        : DebuggingAgentPort.CONTROL_OUT,
      <AtomicComponent<any, any>>debuggingAgent,
      debuggingAgentConfig.isServer
        ? DebuggingAgentPort.DATA_IN
        : DebuggingAgentPort.CONTROL_IN
    );
    sorrirLogger.debug(
      Stakeholder.SYSTEM,
      "Debugging agent create incoming connection.",
      { incomingConnection: incomingConnection }
    );
    runConfig.communicationConfiguration.connectionTechs.push({
      sourceContainer: unit,
      ...incomingConnection.source,
      targetContainer: localUnit,
      ...incomingConnection.target,
      commOption: commOption,
    });

    // create outgoing connection to external debuggingagent
    const outgoingConnection = createConnection(
      <AtomicComponent<any, any>>debuggingAgent,
      debuggingAgentConfig.isServer
        ? DebuggingAgentPort.CONTROL_OUT
        : DebuggingAgentPort.DATA_OUT,
      externalAgent,
      debuggingAgentConfig.isServer
        ? DebuggingAgentPort.CONTROL_IN
        : DebuggingAgentPort.DATA_IN
    );
    sorrirLogger.debug(
      Stakeholder.SYSTEM,
      "Debugging agent create outgoing connection.",
      { outgoingConnection: outgoingConnection }
    );
    runConfig.communicationConfiguration.connectionTechs.push({
      sourceContainer: localUnit,
      ...outgoingConnection.source,
      targetContainer: unit,
      ...outgoingConnection.target,
      commOption: commOption,
    });

    // add connections to runconfig
    runConfig.lsa.connections.push(incomingConnection);
    runConfig.lsa.connections.push(outgoingConnection);

    // add outgoing connection to list that is auto-executed by the agent
    outGoingDebuggingAgentConnections.push(outgoingConnection);
  });

  // set decoder for debugging-agent events
  Object.keys(DebuggingAgentEventTypeExternal).forEach((eventType) => {
    runConfig = setDecoder(runConfig, eventType, basicEventDecoder);
  });

  runConfig.confState.componentState.set(
    debuggingAgent,
    debuggingAgentStartState
  );

  return runConfig;
}
