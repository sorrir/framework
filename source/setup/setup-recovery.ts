import { RunConfiguration } from "../exec-types";
import {
  AtomicComponent,
  Component,
  computeLocallyDeployedConfiguration,
  INIT_SEQUENCER_CLOCK_STATE,
  installSnapshot,
} from "..";

export function setupRecovery(runConfig: RunConfiguration): RunConfiguration {
  // Init logical clocks for each component here..
  computeLocallyDeployedConfiguration(runConfig).components.forEach(
    (component) =>
      runConfig.clockStates.set(component, INIT_SEQUENCER_CLOCK_STATE)
  );

  // Recovery happens here!
  runConfig.confState = {
    componentState: new Map(
      [...runConfig.confState.componentState].map(([c, state]) => [
        c,
        isRecoverable(c, runConfig)
          ? installSnapshot(state, c, runConfig)
          : state,
      ])
    ),
  };

  return runConfig;
}

function isRecoverable(
  c: AtomicComponent<any, any, any>,
  runConfig: RunConfiguration
): boolean {
  let recoverySpcecified = false;

  runConfig.resilienceConfiguration?.components?.forEach((comp) => {
    if (
      comp.id === c.id &&
      comp.mechanisms?.checkpointRecovery?.recovery?.enabled
    ) {
      recoverySpcecified = true;
    }
  });
  return c.prepareStateAfterRecovery !== undefined && recoverySpcecified;
}
