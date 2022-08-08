import { ConnectionTech, RunConfiguration } from "../exec-types";
import {
  AbstractState,
  AtomicComponent,
  attachIDtoComponent,
  CommOption,
  Component,
  computeConnectionsFromLocalToExternal,
  computeLocallyDeployedConfiguration,
  Connection,
  createConnection,
  InPort,
  Port,
} from "..";
import { createBFTConsolidatorComponent } from "../resilienceComponents/consolidators/simpleBFTConsolidator";
import * as _ from "lodash";
import { createCFTConsolidatorComponent } from "../resilienceComponents/consolidators/simpleCFTConsolidator";
import { createNewReplicationConfig } from "../util/bftsmartconfigurator";
import { ConsolidatorPorts } from "../resilienceComponents/consolidators/consolidatorPorts";
import { sorrirLogger } from "@sorrir/sorrir-logging/dist/app";
import { getCommOptionForConnection } from "../communication/comm-engine";

export function setupReplication(
  runConfig: RunConfiguration
): RunConfiguration {
  // Transform a run configuration into a resilient run configuration.

  if (runConfig.resilienceConfiguration?.components?.length === 0) {
    sorrirLogger.info(
      "No resilience mechanisms specified",
      runConfig.resilienceConfiguration
    );
    return runConfig;
  }

  sorrirLogger.info(
    "START create resilient configuration",
    runConfig.resilienceConfiguration
  );

  /**  Initialization */

  const this_unit = runConfig.toExecute;

  // Maps component name -> its replica identifier (used for BFT-SMaRt) on *this_unit*
  const replicatedCompIds: Map<string, number> = new Map<string, number>();
  let seq = 0;

  const components: Record<
    string,
    {
      component: AtomicComponent<any, any>;
      state: AbstractState<any, any, any>;
      ports: any;
      eventTypes: any;
    }
  > = {};

  // Remember old connections that need to be removed when rewiring later
  const oldConnections: Connection<any>[] = [];

  // Maps consolidator component -> ([SenderPort, SenderComp], number of IN Ports, [TargetPort, TargetComp]
  const consolidatorMapping: Map<
    AtomicComponent<any, any>,
    [
      [Port<any, any>, Component<any, any, any>],
      number,
      [Port<any, any>, Component<any, any, any>]
    ]
  > = new Map();

  /** Init Resilience Components **/

  // For every component that has a resilience mechanisms specified:
  runConfig.resilienceConfiguration?.components?.forEach((comp) => {
    // First, we make sure that *replicas* of components are actually deployed in their execution sites:
    for (const unit in runConfig.deploymentConfiguration) {
      for (const component of runConfig.lsa.components) {
        if (
          comp.id === component.id &&
          comp.mechanisms?.activeReplication?.executionSites?.findIndex(
            (executionSite) => executionSite === unit
          ) > -1
        ) {
          sorrirLogger.debug("Deploy " + comp.id + " on unit " + unit);
          runConfig.deploymentConfiguration[unit].components.push(component);
        }
      }
    }

    // Check incoming connections to see if a consolidator needs to be created
    // A consolidator is created on this_unit for every replicated component it receives from
    runConfig.lsa.connections.forEach((conn) => {
      console.log(" <----------------lsa conn ---------------->");
      console.log(" conn !== undefined " + conn);
      console.log("conn.source !== undefined " + conn.source);
      if (conn.source !== undefined)
        console.log(
          "conn.source.sourceComponent.id === comp.id" +
            conn.source.sourceComponent.id +
            " === " +
            comp.id
        );

      console.log(
        "comp.mechanisms?.activeReplication?.enabled " +
          comp.mechanisms?.activeReplication?.enabled
      );
      console.log(" <----------------lsa conn ---------------->");

      if (
        conn.source !== undefined &&
        conn.source.sourceComponent.id === comp.id &&
        comp.mechanisms?.activeReplication?.enabled
      ) {
        // The name of a consolidator should be unique
        const consolidatorID =
          "Consolidator" +
          seq +
          conn.source.sourceComponent.name +
          // "+" +
          conn.source.sourcePort.name + //+
          //  "--" +
          conn.target.targetPort.name +
          //   "+"+
          conn.target.targetComponent.name;
        seq++;
        const consolidatorName = "Consolidator";

        oldConnections.push(conn);

        // Create the IN Ports of the Consolidator:
        const eventTypes = conn.target.targetPort.eventTypes;

        const faultModel: string =
          comp.mechanisms?.activeReplication?.faultModel;
        const redundancyFactor: number = faultModel === "BFT" ? 3 : 2;

        const f: number =
          comp.mechanisms?.activeReplication?.f !== undefined
            ? comp.mechanisms?.activeReplication?.f
            : 1;
        const n: number =
          comp.mechanisms?.activeReplication?.n !== undefined
            ? comp.mechanisms?.activeReplication?.n
            : redundancyFactor * f + 1;

        const inPorts: InPort<any, any>[] = [];
        for (let i = 0; i < n; i++) {
          inPorts.push({
            name: [
              conn.source.sourceComponent.name +
                conn.source.sourcePort.name +
                conn.target.targetComponent.name +
                conn.target.targetPort.name +
                ConsolidatorPorts.IN,
              i,
            ],
            eventTypes: Object.values(eventTypes),
            direction: "in",
          });
        }

        // Create the consolidator itself, depending on fault model, it will be either a BFT or CFT consolidator
        let consolidatorComponent: AtomicComponent<typeof eventTypes, any>;
        let consolidatorState: AbstractState<any, any, any>;

        if (faultModel === "BFT") {
          [consolidatorComponent, consolidatorState] =
            createBFTConsolidatorComponent<typeof eventTypes, string>(
              inPorts,
              {
                name: [
                  conn.source.sourceComponent.name +
                    conn.source.sourcePort.name +
                    conn.target.targetComponent.name +
                    conn.target.targetPort.name +
                    ConsolidatorPorts.OUT,
                  0,
                ],
                eventTypes: Object.values(eventTypes),
                direction: "out",
              },
              f + 1,
              consolidatorName
            );
        } else {
          [consolidatorComponent, consolidatorState] =
            createCFTConsolidatorComponent<typeof eventTypes, string>(
              inPorts,
              {
                name: [
                  conn.source.sourceComponent.name +
                    conn.source.sourcePort.name +
                    conn.target.targetComponent.name +
                    conn.target.targetPort.name +
                    ConsolidatorPorts.OUT,
                  0,
                ],
                eventTypes: Object.values(eventTypes),
                direction: "out",
              },
              consolidatorName
            );
        }
        consolidatorComponent = attachIDtoComponent(
          consolidatorComponent,
          consolidatorID
        );
        components[consolidatorName] = {
          component: consolidatorComponent,
          state: consolidatorState,
          ports: [
            ...inPorts,
            [
              conn.source.sourceComponent.name +
                conn.source.sourcePort.name +
                conn.target.targetComponent.name +
                conn.target.targetPort.name +
                ConsolidatorPorts.OUT,
              0,
            ],
          ],
          eventTypes: Object.values(eventTypes),
        };
        consolidatorMapping.set(consolidatorComponent, [
          [conn.source.sourcePort, conn.source.sourceComponent],
          n,
          [conn.target.targetPort, conn.target.targetComponent],
        ]);

        // Add the consolidator to the Run Configuration
        runConfig.lsa.components.push(consolidatorComponent);
        runConfig.confState.componentState.set(
          consolidatorComponent,
          consolidatorState
        );

        sorrirLogger.debug(
          "Created and Added Consolidator " + consolidatorComponent.name
        );

        const replicatedConnTechs: ConnectionTech[] = [];
        const commOption = getCommOptionForConnection(
          conn.source.sourceComponent,
          conn.source.sourcePort,
          conn.target.targetComponent,
          conn.target.targetPort,
          runConfig.communicationConfiguration
        );

        // Now we need to deploy the consolidator
        // resolve components
        for (const unit in runConfig.deploymentConfiguration) {
          for (const component of runConfig.deploymentConfiguration[unit]
            .components) {
            const target = conn.target;
            if (component.id === target.targetComponent.id) {
              sorrirLogger.info(
                "Deploying the consolidator " +
                  consolidatorID +
                  " on unit " +
                  unit
              );
              runConfig.deploymentConfiguration[unit].components.push(
                consolidatorComponent
              );

              let i = 0;
              for (const site of comp.mechanisms?.activeReplication
                ?.executionSites) {
                const connTech: ConnectionTech = {
                  sourceContainer: site,
                  sourceComponent: conn.source.sourceComponent,
                  sourcePort: conn.source.sourcePort,
                  targetContainer: unit,
                  targetComponent: consolidatorComponent,
                  targetPort: inPorts[i],
                  commOption: commOption,
                };
                sorrirLogger.debug(
                  "Adding commTech for " +
                    connTech.sourceComponent.name +
                    "::" +
                    connTech.sourcePort.name +
                    "--->" +
                    connTech.targetPort.name +
                    "::" +
                    connTech.targetComponent.name
                );
                replicatedConnTechs.push(connTech);
                i++;
              }
            }
          }
        }
        runConfig.communicationConfiguration.connectionTechs.push(
          ...replicatedConnTechs
        );
      }
    });

    /** Determine replica id for each replicated comp */

    // Active replication should be used with this component
    if (
      comp.mechanisms?.activeReplication?.enabled &&
      _.findIndex(runConfig.lsa.components, (c) => c.id === comp.id) !==
        undefined
    ) {
      let replica_id = -1;
      // Execution sites define where replicas are deployed
      const executionSites = comp.mechanisms?.activeReplication?.executionSites;
      replica_id = executionSites.findIndex(
        (executionSite) => executionSite === this_unit
      );
      replicatedCompIds.set(comp.id, replica_id);
    }
  });

  /**  Create Additional Connections */

  consolidatorMapping.forEach(
    ([[senderPort, senderComp], n, [targetPort, targetComp]], consolidator) => {
      sorrirLogger.debug(
        "[senderPort, targetPort, " +
          JSON.stringify(senderPort) +
          " " +
          JSON.stringify(targetPort)
      );

      const replicatedConnections: Connection<any>[] = [];

      for (let i = 0; i < n; i++) {
        const conn = createConnection(
          senderComp,
          senderPort.name,
          consolidator,
          [
            senderComp.name +
              senderPort.name +
              targetComp.name +
              targetPort.name +
              ConsolidatorPorts.IN,
            i,
          ]
        );
        replicatedConnections.push(conn);
      }

      const replica_id =
        replicatedCompIds.get(senderComp.id ?? "") !== undefined
          ? replicatedCompIds.get(senderComp.id ?? "")
          : -1;
      const additionalConnections: Connection<any>[] =
        replica_id === -1 // Todo may be buggy if source and target on same host? (replicated sender and non-replicated receiver)
          ? [...replicatedConnections]
          : [
              createConnection(senderComp, senderPort.name, consolidator, [
                senderComp.name +
                  senderPort.name +
                  targetComp.name +
                  targetPort.name +
                  ConsolidatorPorts.IN,
                replica_id,
              ]),
            ];

      // Overwrite configuration
      runConfig.lsa = {
        components: runConfig.lsa.components,
        connections: runConfig.lsa.connections.filter(
          (v) => !oldConnections.includes(v)
        ),
      };

      runConfig.lsa.connections.push(
        createConnection(
          consolidator,
          [
            senderComp.name +
              senderPort.name +
              targetComp.name +
              targetPort.name +
              ConsolidatorPorts.OUT,
            0,
          ],
          targetComp,
          targetPort.name
        )
      );
      runConfig.communicationConfiguration.connectionTechs.push({
        sourceContainer: this_unit,
        sourceComponent: consolidator,
        sourcePort: [
          senderComp.name +
            senderPort.name +
            targetComp.name +
            targetPort.name +
            ConsolidatorPorts.OUT,
          0,
        ],
        targetContainer: this_unit,
        targetComponent: targetComp,
        targetPort: targetPort,
        commOption: CommOption.REST,
      });

      runConfig.lsa.connections.push(...additionalConnections);
    }
  );

  /**  Enforce TOM Communication for replicated targets */

  runConfig.resilienceConfiguration?.components?.forEach((component) => {
    if (component.mechanisms?.activeReplication?.enabled) {
      runConfig.communicationConfiguration.connectionTechs.forEach(
        (connection) => {
          if (connection.targetComponent.id === component.id) {
            connection.commOption = CommOption.TOM;
          }
          // Todo for testing, remove later
          if (connection.targetPort.name === "FROM_SENSOR") {
            connection.commOption = CommOption.REST;
          }
        }
      );
    }
  });

  sorrirLogger.debug("Connections:");
  for (const conn of runConfig.lsa.connections) {
    if (
      conn !== undefined &&
      conn.source !== undefined &&
      conn.target !== undefined
    ) {
      sorrirLogger.debug(
        conn.source.sourceComponent.name +
          "::" +
          conn.source.sourcePort.name +
          "----->" +
          conn.target.targetPort.name +
          "::" +
          conn.target.targetComponent.name
      );
    }
  }

  /** Create BFT-SMaRt Configurations */

  // Create Config per
  // Replicated component which is a target (for creating Frontend)
  // Locally deployed replicated component (for creating Replica)
  const componentsWhichNeedReplicationConfig: AtomicComponent<any, any>[] = [];

  computeLocallyDeployedConfiguration(runConfig).components.forEach(
    (component) => {
      runConfig.resilienceConfiguration?.components?.forEach((compConfig) => {
        if (
          compConfig.id === component.id &&
          compConfig.mechanisms?.activeReplication?.enabled
        ) {
          componentsWhichNeedReplicationConfig.push(component);
        }
      });
    }
  );
  computeConnectionsFromLocalToExternal(runConfig).forEach((connection) => {
    runConfig.resilienceConfiguration?.components?.forEach((compConfig) => {
      if (
        compConfig.id === connection.target.targetComponent.id &&
        compConfig.mechanisms?.activeReplication?.enabled &&
        !_.includes(
          componentsWhichNeedReplicationConfig,
          connection.target.targetComponent
        )
      ) {
        componentsWhichNeedReplicationConfig.push(
          connection.target.targetComponent
        );
      }
    });
  });

  componentsWhichNeedReplicationConfig.forEach((c) =>
    sorrirLogger.debug("Needs replication: " + c.id)
  );

  componentsWhichNeedReplicationConfig.forEach((component) =>
    createNewReplicationConfig(
      "replicationConfigs/" + component.id,
      "./node_modules/@sorrir/framework/resilience_library/bft_smart/config/",
      runConfig,
      component
    )
  );

  sorrirLogger.info("END Transformation", {});

  return runConfig;
}
