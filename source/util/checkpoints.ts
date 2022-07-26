import { AbstractState } from "./engine";
import * as fs from "fs";
import {
  ClockStates,
  INIT_SEQUENCER_CLOCK_STATE,
  SequencerClock,
} from "./clocks";
import { RunConfiguration } from "../exec-types";
import { AtomicComponent } from "./component";
import { computeLocallyDeployedConfiguration } from "../communication/comm-util";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import _ = require("lodash");

sorrirLogger.configLogger({ area: "resilience" });

export const FILE_DIR_PATH = process.cwd() + "/checkpoints/";

export class SenderSeq {
  sender = "";
  lastSeq = 0;

  constructor(sender: string, lastSeq: number) {
    this.sender = sender;
    this.lastSeq = lastSeq;
  }
}

export interface Checkpoint<S, E, P> {
  readonly abstractState: AbstractState<S, E, P>; // contains state AND events[]
  readonly timestamp: number;
  readonly memorizedRcvdMsgs: SenderSeq[];
}

/**
 * Snapshot all locally deployed components to stable storage. Creat.e checkpoints in JSON format.
 *
 * @param runConfig runconfiguration to be used
 */
export function snapshotAll(runConfig: RunConfiguration): void {
  // For each locally deployed component: create a new checkpoint to make newState persistent
  computeLocallyDeployedConfiguration(runConfig).components.forEach(
    (component) => {
      const c = _.find(
        runConfig.resilienceConfiguration?.components,
        (c) => c.id === component.id
      );
      const checkpointEnabled =
        c !== undefined
          ? c.mechanisms?.checkpointRecovery?.checkpoint?.enabled
          : false;
      if (
        component.prepareStateForSnapshot !== undefined &&
        component.id !== undefined &&
        checkpointEnabled
      ) {
        const abstractState: AbstractState<any, any, any> =
          component.prepareStateForSnapshot(
            runConfig.confState.componentState.get(component) ?? {
              state: {},
              events: [],
              tsType: "State",
            }
          );
        console.log(">>> Create Checkpoint");
        writeCheckpointToDisk(
          abstractState,
          component.id,
          runConfig.clockStates.get(component)
        );
      }
    }
  );
}

/**
 * Persists a Checkpoint fo the filesystem
 *
 * @param checkpointState AbstractState to be saved
 * @param checkPointName name of the Checkpoint
 * @param clockStates Current clock states
 */
export function writeCheckpointToDisk<E, P>(
  checkpointState: AbstractState<any, E, P>,
  checkPointName: string,
  clockStates: ClockStates | undefined
): void {
  console.log(
    "Perform checkpoint" + checkPointName + " " + JSON.stringify(clockStates)
  );

  const memorizedRcvdMsgs = new Map<string, number>();

  clockStates?.memorizedRcvdMsgs.forEach((seq, componentName) => {
    console.log("Component Name is " + componentName);
    memorizedRcvdMsgs.set(componentName, seq !== undefined ? seq : 0);
  });

  const senderSeqs: SenderSeq[] = [];
  memorizedRcvdMsgs.forEach((seq, componentName) => {
    senderSeqs.push(new SenderSeq(componentName, seq));
  });

  const checkpoint: Checkpoint<any, E, P> = {
    abstractState: checkpointState,
    timestamp: clockStates ? clockStates.myLocalClock.seq : 0,
    memorizedRcvdMsgs: senderSeqs,
  };

  const serializedState: string = JSON.stringify(checkpoint, replacer);

  sorrirLogger.info(Stakeholder.SYSTEM, ".> Write fo file", {
    file: serializedState,
  });

  try {
    if (!fs.existsSync(FILE_DIR_PATH)) {
      fs.mkdirSync(FILE_DIR_PATH);
    }

    fs.writeFileSync(FILE_DIR_PATH + checkPointName, serializedState, {
      mode: 0o755,
    });
  } catch (err: any) {
    // An error occurred
    sorrirLogger.error(Stakeholder.SYSTEM, err, {});
  }
}

/**
 * Installs a component snapshot and calls component-defined behavior for recovery
 *
 * @param fallbackState
 * @param component
 * @param runConfig
 */
export function installSnapshot<E, P>(
  fallbackState: AbstractState<any, E, P>,
  component: AtomicComponent<any, any>,
  runConfig: RunConfiguration
): AbstractState<any, E, P> {
  const checkpoint: Checkpoint<any, E, P> | undefined = readCheckpointFromDisk(
    component.id ?? component.name
  );

  if (typeof checkpoint === "undefined") {
    return fallbackState;
  } else {
    const myClockState: ClockStates = INIT_SEQUENCER_CLOCK_STATE;
    myClockState.myLocalClock = new SequencerClock(checkpoint.timestamp);
    myClockState.myLatestCheckpoint = new SequencerClock(checkpoint.timestamp);
    myClockState.memorizedRcvdMsgs = new Map<string, number>();

    checkpoint.memorizedRcvdMsgs.forEach((senderSeq) =>
      myClockState.memorizedRcvdMsgs.set(senderSeq.sender, senderSeq.lastSeq)
    );

    runConfig.clockStates.set(component, myClockState);

    // Custom restoration behavior can be overridden by component developer in prepareStateAfterRecovery mutator
    const recoveredState: AbstractState<any, E, P> =
      component.prepareStateAfterRecovery
        ? component.prepareStateAfterRecovery(checkpoint.abstractState)
        : checkpoint.abstractState;

    return recoveredState;
  }
}

/**
 * Loads state from some checkpoint on storage
 *
 * @param fallbackState if checkpoint can not be loaded, use a default state as fallback
 * @param checkPointName name of the checkpoint
 */
export function readCheckpointFromDisk<E, P>(
  checkPointName: string
): Checkpoint<any, E, P> | undefined {
  let toRead = "";
  let checkpoint;

  try {
    if (!fs.existsSync(FILE_DIR_PATH)) {
      fs.mkdirSync(FILE_DIR_PATH);
    }
    toRead = fs.readFileSync(FILE_DIR_PATH + checkPointName).toString();
    sorrirLogger.info(Stakeholder.SYSTEM, "<. read from file", {
      file: toRead,
    });
    checkpoint = JSON.parse(toRead, reviver);
  } catch (err) {
    // An error occurred
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "x. ERROR READING FILE! " + err + "... loading default state",
      {}
    );
  }

  return checkpoint;
}

function replacer(
  this: any,
  key: string | number,
  value: any
): any | { dataType: "Map"; value: [unknown, unknown][] } {
  const originalObject = this[key];
  if (originalObject instanceof Map) {
    sorrirLogger.warn(
      Stakeholder.SYSTEM,
      "Map should not use Object as key, please use string or number",
      { originalObject: originalObject }
    );
    return {
      dataType: "Map",
      value: Array.from(originalObject.entries()), // or with spread: value: [...originalObject]
    };
  } else {
    return value;
  }
}

function reviver(
  key: any,
  value: {
    dataType: string;
    value: Iterable<readonly [unknown, unknown]>;
  } | null
):
  | Map<unknown, unknown>
  | null
  | { dataType: string; value: Iterable<readonly [unknown, unknown]> } {
  if (typeof value === "object" && value !== null) {
    if (value.dataType === "Map") {
      return new Map(value.value);
    }
  }
  return value;
}
