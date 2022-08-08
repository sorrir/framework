import * as _ from "lodash";
import { AtomicComponent, shadowAgentName } from "..";
import { RunConfiguration } from "../exec-types";

import { Component, TransferFunction } from "./component";
import { DegradableState, DegradableStateMachineState } from "./engine";
import {
  Maybe,
  Nothing,
  Just,
  isJust,
  fromJust,
  withDefault,
} from "@typed/maybe";
import { sorrirLogger } from "@sorrir/sorrir-logging/dist/app";
import { CommOption } from "../communication/comm-tech";

/**
 * Type aliases for the degradation mechanism
 */
export type ShadowEntry<ShadowMode> = {
  mode: ShadowMode | DefaultShadowMode;
  timestamp?: ShadowTimestamp;
};
export type Subcomponent = string;
export type ShadowTimestamp = number;
export type ShadowMapAsArray<ShadowMode> = [
  string,
  ShadowEntry<ShadowMode | DefaultShadowMode>
][];

/**
 * Default shadow modes that every component shares
 */
export enum DefaultShadowMode {
  OK = "__ok",
  ERROR = "__error",
  UNREACHABLE = "__unreachable",
}

/**
 * This type is used as a look-up table for a subcomponent's current shadow operating mode
 */
export type ShadowMap<ShadowMode> = Map<Subcomponent, ShadowEntry<ShadowMode>>;

/**
 * Returns a shadowmap derived from the state of locally deployed components
 *
 * @param runConfig RunConfiguration
 * @returns the shadowmap
 */
export function getLocalShadowMap<ShadowMode>(
  runConfig: RunConfiguration
): ShadowMap<ShadowMode> {
  return _.reduce(
    Array.from(runConfig.confState.componentState),
    (obj, entry) => {
      const id = entry[0].id;
      if (id !== undefined) {
        obj.set(id, {
          mode: entry[1].operatingMode ?? DefaultShadowMode.OK,
          timestamp: getCurrentShadowTimeStamp(runConfig),
        });
      }
      return obj;
    },
    new Map()
  ) as ShadowMap<ShadowMode>;
}

/**
 * Defines which shadow entries are allowed to be included into
 * a partial shadow map.
 */
export enum PartialShadowMapContent {
  LOCAL_ONLY = "local-only",
  ALL = "all",
}

/**
 * Returns a partial shadow map derived from the existing shadow map.
 * Used to retrieve the information that is to be sent
 * via communication protocols. Increments the shadow timestamp of local components.
 *
 * @param runConfig RunConfiguration
 * @param content "local-only" means that only information about local components is included
 *                "all" includes information about all known components
 * @param limit if set, applies a limit to the number entries in the returned shadow map
 * @returns Shadow map
 */

export function preparePartialShadowMapToSend<ShadowMode>(
  runConfig: RunConfiguration,
  content: PartialShadowMapContent,
  limit?: number
): ShadowMap<ShadowMode> {
  const applyLimit = (shadowMap: ShadowMap<unknown>) =>
    limit !== undefined && limit > 0
      ? new Map(_.sampleSize(Array.from(shadowMap), limit))
      : limit === 0
      ? new Map()
      : shadowMap;

  // update shadow map before returning it
  updateShadowMap(runConfig);

  switch (content) {
    case PartialShadowMapContent.LOCAL_ONLY:
      return applyLimit(getLocalShadowMap(runConfig));
    case PartialShadowMapContent.ALL:
      return applyLimit(runConfig.engineRoomState.shadowMap);
  }
}

/**
 * Converts a shadow map into an array of entries that
 * can be encoded/decoded by the framework
 *
 * @param shadowMap
 * @returns shadow map as array
 */
export function shadowMapToArray<ShadowMode>(
  shadowMap: ShadowMap<ShadowMode>
): ShadowMapAsArray<ShadowMode> {
  return Array.from(shadowMap.entries());
}

/**
 * Converts a shadow map entry array
 * back to a shadow map.
 *
 * @param shadowMapAsArray
 * @returns shadow map
 */
export function arrayToShadowMap<ShadowMode>(
  shadowMapAsArray: ShadowMapAsArray<ShadowMode>
): ShadowMap<ShadowMode> {
  return new Map(<any>shadowMapAsArray);
}

/**
 * Updates the shadow map of a RunConfiguration with the given entries.
 * Als updates entries corresponding to local components.
 * If no shadow map is given, only updates local components.
 *
 * TODO: advanced logic for detecting inconsistencies
 * e.g.: data received indicates local component is unreachable
 * but local component works fine --> channel broken? undetected error? etc.
 *
 * @param runConfig RunConfiguration
 * @param shadowMap ShadowMap with data to be updated
 * @param ignoreTimestamp if set, timestamps are ignored and all entries of
 * the given shadow map are written into the runConfig even if they appear older.
 *
 * @returns a shadow map containing all updated entries
 */
export function updateShadowMap<ShadowMode>(
  runConfig: RunConfiguration,
  shadowMap?: ShadowMap<ShadowMode>,
  ignoreTimestamp?: boolean
): ShadowMap<ShadowMode> {
  const currentShadowMap = runConfig.engineRoomState.shadowMap;
  const updatedSubShadowMap = new Map();
  const applySM = (shadow: ShadowEntry<unknown>, component: Subcomponent) => {
    const currentShadowTimestamp =
      currentShadowMap.get(component)?.timestamp ?? 0;
    if (
      ignoreTimestamp === true ||
      shadow.timestamp === undefined ||
      currentShadowTimestamp < shadow.timestamp
    ) {
      currentShadowMap.set(component, shadow);
      updatedSubShadowMap.set(component, shadow);
    }
  };
  if (shadowMap !== undefined) shadowMap.forEach(applySM);
  // update locally known components
  getLocalShadowMap(runConfig).forEach(applySM);
  // trigger the degradation functionality for each component
  triggerDegradation(runConfig, currentShadowMap);
  return updatedSubShadowMap;
}

/**
 * This function triggers the degradation functionality with the updated shadow map for all component's of this unit
 *
 * @param runConfig RunConfiguration
 * @param shadowMap previously updated ShadowMap
 *
 */
function triggerDegradation<ShadowMode>(
  runConfig: RunConfiguration,
  shadowMap: ShadowMap<ShadowMode>
): void {
  const components = runConfig.lsa.components;
  components.forEach(function (
    component: AtomicComponent<any, any, undefined>
  ) {
    const state = runConfig.confState.componentState.get(component);
    // ensure that both the operatingMode and degradationHistory are not undefined
    if (state !== undefined) {
      const degradableState = {
        ...state,
        operatingMode: state.operatingMode ?? DefaultShadowMode.OK,
        degradationHistory: state.degradationHistory ?? [],
      };
      const newState = updateOperatingMode(
        component,
        degradableState,
        shadowMap
      );

      runConfig.confState.componentState.set(component, newState);
    }
  });
}

/**
 * Sets the shadow-mode of a component to unreachable.
 * This is to be called as a result of an error while trying to communicate.
 *
 * @param runConfig RunConfiguration
 * @param component the component's name
 */
export function setComponentUnreachable(
  runConfig: RunConfiguration,
  component: Subcomponent
): void {
  const rcsm = runConfig.engineRoomState.shadowMap;
  const timestamp = rcsm.get(component)?.timestamp;
  rcsm.set(component, {
    mode: DefaultShadowMode.UNREACHABLE,
    timestamp: timestamp,
  });
}

/**
 * Sets the shadow-mode of all components of a unit to unreachable.
 * This is to be called as a result of an error while trying to communicate.
 *
 * @param runConfig RunConfiguration
 * @param unit the unit
 */
export function setUnitUnreachable(
  runConfig: RunConfiguration,
  unit: string
): void {
  const components =
    runConfig.deploymentConfiguration?.[unit]?.components ?? [];
  components.forEach((component) => {
    if (component.name !== shadowAgentName) {
      setComponentUnreachable(runConfig, component.name);
    }
  });
}

/**
 * Derives the current timestamp from the runconfiguration
 *
 * @param runConfig RunConfiguration
 *
 * @returns the ShadowTimestamp
 */
export function getCurrentShadowTimeStamp(
  runConfig: RunConfiguration
): ShadowTimestamp {
  return Math.floor(Date.now());
}

/**
 * This type is used to express the requirements to the shadow operating modes of the subcomponents
 * and the internal state for a given operating mode in form of a boolean function
 */
export type DependencyFunction<S, E, P, D, SM> = (
  state: DegradableState<S, E, P, D>,
  shadowOperatingModes: ShadowMap<SM>
) => boolean;

/**
 * This function attempts to degrade the operating mode of a given component.
 * If the degradation is successful the component's new state is returned,
 * otherwise the state is returned unaltered
 * @param component the component to be degraded
 * @param currentState the component's current state
 * @param targetMode the target operating mode
 */
function degrade<S, E, P, D>(
  component: Component<E, P, D>,
  currentState: DegradableState<S, E, P, D>,
  targetMode: D
): DegradableState<S, E, P, D> {
  // select all TransferFunctions that return a state in the target degradation mode
  const degradationPath = findPath(
    component.degradationDAG || [],
    currentState.operatingMode,
    targetMode,
    []
  );

  let updatedState = { ...currentState };

  for (const t of degradationPath) {
    updatedState = t(updatedState);
  }

  return updatedState;
}

/**
 * This function attempts to find a path that connects the current operating mode
 * with the target operating mode in the provided DAG.
 * @param component the component to be degraded
 * @param currentState the component's current state
 * @param targetMode the target operating mode
 * @param path an array of TransferFunctions that lead from the current to the target operating mode
 */
function findPath<S, E, P, D>(
  DAG: [[D, D], TransferFunction<S, E, P, D>][],
  current: D,
  target: D,
  path: TransferFunction<S, E, P, D>[]
): TransferFunction<S, E, P, D>[] {
  // recursive exit condition
  if (current === target) return path;

  const transferFunctions = _.chain(DAG)
    // filter the TransferFunctions that start from the current operating mode
    .filter((element) => _.isEqual(element[0][0], current))
    // return the filtered TransferFunctions
    .value() as [[[D, D], TransferFunction<S, E, P, D>]];

  // loop through the available TransferFunctions
  for (const t of transferFunctions) {
    const updatedPath = [...path];
    updatedPath.push(t[1]);

    const newPath = findPath(DAG, t[0][1], target, updatedPath);
    if (newPath.length > 0) {
      return newPath;
    }
  }
  // if this point is reached, no suitable path has been found
  return [];
}

/**
 * This function attempts to upgrade the operating mode of a given component.
 * If the upgrade is successful the component's new state is returned,
 * otherwise the state is returned unaltered
 * @param component the component to be degraded
 * @param currentState the component's current state
 * @param targetMode the target operating mode
 */
function upgrade<S, E, P, D>(
  component: Component<E, P, D>,
  currentState: DegradableState<S, E, P, D>,
  targetMode: D
): DegradableState<S, E, P, D> {
  // verify that the target mode is (indirectly) connected to original operating mode
  if (currentState.degradationHistory.length > 0) {
    const originalOperatingMode = currentState.degradationHistory[0][0];
    const path = findPath(
      component.upgradeDAG || [],
      currentState.operatingMode,
      originalOperatingMode,
      []
    );
    if (path.length === 0) {
      return currentState;
    }
  }
  // select all Transferfunctions that return a state in the target degradation mode
  const upgradePath = findPath(
    component.upgradeDAG || [],
    currentState.operatingMode,
    targetMode,
    []
  );

  let updatedState = { ...currentState };
  for (const t of upgradePath) updatedState = t(updatedState);
  // if no suitable transition has been found, the loop is not executed
  // and therefore the current state is returned
  if (!upgradePath) console.log("No suitable TransferFunction has been found");

  return updatedState;
}

/**
 * This function automatically handles the degradation/upgrade
 * of a component's operating mode.
 * It should be called whenever there are changes to the shadow
 * operating modes or the component's internal state.
 * @param component the component to be degraded
 * @param currentState the component's current state
 * @param shadows the shadow operating modes of the subcomponents
 */
export function updateOperatingMode<S, E, P, D, SM>(
  component: Component<E, P, D>,
  currentState: DegradableState<S, E, P, D>,
  shadows: ShadowMap<SM>
): DegradableState<S, E, P, D> {
  const degradationLevel = [
    ...(component.degradationLevels?.keys()
      ? component.degradationLevels?.keys()
      : []),
  ]
    .sort()
    .reverse();

  let currentLevel = -1;
  for (const level of degradationLevel) {
    const currentTarget = component.degradationLevels?.get(level);

    if (currentTarget === currentState.operatingMode) {
      currentLevel = level;
    }
    const dependency = component.dependencyMap?.get(level);
    if (currentTarget && dependency && dependency(currentState, shadows)) {
      if (level > currentLevel) {
        const newState = upgrade(component, currentState, currentTarget);
        if (newState !== currentState) return newState;
      } else if (level < currentLevel) {
        const newState = degrade(component, currentState, currentTarget);
        if (newState !== currentState) {
          return newState;
        }
      } else {
        return currentState;
      }
    }
  }
  return currentState;
}

/**
 * This function allows to manually reconfigure
 * a non-state-machine component's operating mode
 * @param component a non-state-machine component to be degraded
 * @param currentState the component's current state
 * @param target a tuple composed of the target operating mode
 *               and target state machine state
 * @param shadows the shadow operating modes of the subcomponents
 */
export function reconfigureDegradationMode<S, E, P, D, SM>(
  component: Component<E, P, D>,
  currentState: DegradableState<S, E, P, D>,
  target: D,
  shadows: ShadowMap<SM>
): DegradableState<S, E, P, D> {
  // assemble the target state
  const targetState = {
    ...currentState,
    operatingMode: target,
    degradationHistory: [],
  };

  return updateOperatingMode(component, targetState, shadows);
}

/**
 * This function allows to manually reconfigure the operating
 * mode of component that implements a State-Machine
 * @param component the component to be degraded
 * @param currentState the component's current state
 * @param target a tuple composed of the target operating mode
 *               and target state machine state
 * @param shadows the shadow operating modes of the subcomponents
 */
export function reconfigureSMDegradationMode<F, M, E, P, D, SM>(
  component: Component<E, P, D>,
  currentState: DegradableStateMachineState<F, M, E, P, D>,
  target: [D, F],
  shadows: ShadowMap<SM>
): DegradableStateMachineState<F, M, E, P, D> {
  // assemble the target state
  const targetState: DegradableState<{ fsm: F; my: M }, E, P, D> = {
    state: { fsm: target[1], my: currentState.state.my },
    events: [...currentState.events],
    operatingMode: target[0],
    degradationHistory: [],
    tsType: "State",
  };

  return updateOperatingMode(component, targetState, shadows);
}

/**
 * This function has only been created for testing purposes.
 * It is a wrapper for the component's step function and
 * piggybacks the degradation history.
 * @param component the component to be degraded
 * @param currentState the component's current state
 */
export function degradedStep<S, E, P, D>(
  component: Component<E, P, D>,
  currentState: DegradableState<S, E, P, D>
): DegradableState<S, E, P, D> {
  const newState = component.step(currentState);
  if (isJust(newState)) {
    return {
      state: fromJust(newState).state,
      events: fromJust(newState).events,
      operatingMode: currentState.operatingMode,
      degradationHistory: currentState.degradationHistory,
      tsType: "State",
    };
  }
  return currentState;
}
