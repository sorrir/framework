import * as _ from "lodash";

import { sorrirLogger } from "@sorrir/sorrir-logging/dist/app";
import { RunConfiguration, TransferFunctionConfig } from "../exec-types";
import { TransferFunction } from "../util/component";
import { DependencyFunction } from "../util/degradation";
import { AbstractState } from "../util/engine";
import { config } from "process";

export function setupDegradation(
  runConfig: RunConfiguration
): RunConfiguration {
  sorrirLogger.info(
    "START creating degradation configuration",
    runConfig.degradationConfiguration
  );

  runConfig.lsa.components.forEach(function (component) {
    // ensure that there is at least one degradable component
    if (!runConfig.degradationConfiguration) return runConfig;

    for (const degradationConfig of runConfig.degradationConfiguration
      .degradableComponents) {
      if (component.name === degradationConfig.name) {
        // Extract degradation Levels
        const degradationLevels = new Map<number, string>();
        for (const level of degradationConfig.degradationLevels) {
          degradationLevels.set(level.id, level.label);
        }

        // Add the dependency functions
        const dependencyMap = new Map<
          number,
          DependencyFunction<any, any, any, any, any>
        >();
        for (const level of degradationConfig.degradationLevels) {
          dependencyMap.set(level.id, (state, shadows) => {
            for (const dependencySet of level.dependencySets) {
              let fulfilled = true;
              for (const dependency of dependencySet.dependencies) {
                const shadowMode = shadows.get(dependency.subcomponentId)?.mode;
                if (shadowMode !== dependency.shadowmodeId) {
                  fulfilled = false;
                }
              }
              if (fulfilled) {
                return true;
              }
            }
            return false;
          });
        }

        // Create the Degradation DAG
        const degradationDAG: [
          [any, any],
          TransferFunction<any, any, any, any>
        ][] = [];
        for (const level of degradationConfig.degradations) {
          // extract the state changes
          const stateMapping = new Map<string, string>();
          for (const stateChange of level.stateChanges) {
            stateMapping.set(
              stateChange.startStateId,
              stateChange.resultStateId
            );
          }

          const transferFunction = (currentState) => {
            const newState = { ...currentState };
            // append the current operating mode and state machine state into the degradation history
            newState.degradationHistory.push([
              currentState.operatingMode,
              currentState.state,
            ]);
            newState.operatingMode = degradationLevels.get(
              level.resultDegradationLevelId
            );
            newState.state.fsm = stateMapping.get(currentState.state.fsm);

            return newState;
          };
          const start = degradationLevels.get(level.startDegradationLevelId);
          const end = degradationLevels.get(level.resultDegradationLevelId);

          degradationDAG.push([[start, end], transferFunction] as [
            [any, any],
            TransferFunction<any, any, any, any>
          ]);
        }

        // Create the Upgrade DAG
        const upgradeDAG: [[any, any], TransferFunction<any, any, any, any>][] =
          [];
        for (const level of degradationConfig.upgrades) {
          // extract the state changes
          const stateMapping = new Map<string, string>();
          for (const stateChange of level.stateChanges) {
            stateMapping.set(
              stateChange.startStateId,
              stateChange.resultStateId
            );
          }

          const transferFunction = (currentState) => {
            const operatingMode = degradationLevels.get(
              level.resultDegradationLevelId
            );
            const previousState = _.find(
              currentState.degradationHistory,
              (element) => _.isEqual(element[0], operatingMode)
            );

            const newState = { ...currentState };
            newState.operatingMode = operatingMode;
            const updatedHistory = [...currentState.degradationHistory];
            if (updatedHistory !== []) updatedHistory.splice(-1);
            if (previousState) {
              const updatedHistory = [...currentState.degradationHistory];
              updatedHistory.splice(-1);

              newState.state = previousState[1];
              newState.degradationHistory = updatedHistory;
            }
            return newState;
          };

          const start = degradationLevels.get(level.startDegradationLevelId);
          const end = degradationLevels.get(level.resultDegradationLevelId);
          upgradeDAG.push([[start, end], transferFunction] as [
            [any, any],
            TransferFunction<any, any, any, any>
          ]);
        }

        (component.degradationLevels as any) = degradationLevels;
        (component.degradationDAG as any) = degradationDAG;
        (component.upgradeDAG as any) = upgradeDAG;
        (component.dependencyMap as any) = dependencyMap;
      }
    }
  });

  return runConfig;
}
