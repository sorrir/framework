import {
  AbstractState,
  DegradableState,
  DegradableStateMachineState,
  StateMachine,
} from "../util/engine";

import {
  createStatemachineComponent,
  Component,
  TransferFunction,
  DegradationMode,
} from "../util/component";

import {
  ShadowEntry,
  degradedStep,
  DependencyFunction,
  reconfigureSMDegradationMode,
  updateOperatingMode,
  reconfigureDegradationMode,
  ShadowMap,
} from "../util/degradation";
import { Just, Maybe, withDefault, isJust } from "@typed/maybe";

import * as _ from "lodash";
import { sorrirLogger } from "@sorrir/sorrir-logging/dist/app";
import { level } from "winston";

describe("State-Machine Degradation Test", () => {
  enum StateMachineStates {
    A,
    B,
    C,
  }

  enum DegradationModes {
    L0 = "L0",
    L1_1 = "L1.1",
    L1_2 = "L1.2",
    L2 = "L2",
  }

  enum DegradationLevels {
    L0 = 0,
    L1_1 = 1,
    L1_2 = 2,
    L2 = 3,
  }

  enum SubComponents {
    C1 = "C1",
    C2 = "C2",
    C3 = "C3",
  }

  enum ShadowModes {
    OFF = "OFF",
    ON = "ON",
  }

  const levelMapping = new Map<number, DegradationModes>([
    [DegradationLevels.L0, DegradationModes.L0],
    [DegradationLevels.L1_1, DegradationModes.L1_1],
    [DegradationLevels.L1_2, DegradationModes.L1_2],
    [DegradationLevels.L2, DegradationModes.L2],
  ]);

  const stateMachineMapping: [
    DegradationModes,
    StateMachine<StateMachineStates, undefined, undefined, undefined>
  ][] = [
    [
      DegradationModes.L0,
      {
        transitions: [
          {
            sourceState: StateMachineStates.A,
            targetState: StateMachineStates.A,
          },
        ],
      },
    ],
    [
      DegradationModes.L1_1,
      {
        transitions: [
          {
            sourceState: StateMachineStates.A,
            targetState: StateMachineStates.C,
          },
          {
            sourceState: StateMachineStates.C,
            targetState: StateMachineStates.A,
          },
        ],
      },
    ],
    [
      DegradationModes.L1_2,
      {
        transitions: [
          {
            sourceState: StateMachineStates.B,
            targetState: StateMachineStates.B,
          },
        ],
      },
    ],
    [
      DegradationModes.L2,
      {
        transitions: [
          {
            sourceState: StateMachineStates.B,
            targetState: StateMachineStates.C,
          },
          {
            sourceState: StateMachineStates.C,
            targetState: StateMachineStates.B,
          },
        ],
      },
    ],
  ];

  const degradationDAG: [
    [DegradationModes, DegradationModes],
    TransferFunction<any, undefined, undefined, DegradationModes>
  ][] = [
    // L2 -> L1.1
    [
      [DegradationModes.L2, DegradationModes.L1_1],
      (currentState) => {
        // append the current operating mode and state machine state into the degradation history
        const updatedHistory = [...currentState.degradationHistory];
        updatedHistory.push([currentState.operatingMode, currentState.state]);

        if (currentState.state.fsm === StateMachineStates.C) {
          return {
            ...currentState,
            state: { fsm: StateMachineStates.C, my: currentState.state.my },
            operatingMode: DegradationModes.L1_1,
            degradationHistory: updatedHistory,
          };
        } else {
          return {
            ...currentState,
            state: { fsm: StateMachineStates.A, my: currentState.state.my },
            operatingMode: DegradationModes.L1_1,
            degradationHistory: updatedHistory,
          };
        }
      },
    ],
    // L1.1 -> L0
    [
      [DegradationModes.L1_1, DegradationModes.L0],
      (currentState) => {
        // append the current operating mode and state machine state into the degradation history
        const updatedHistory = [...currentState.degradationHistory];
        updatedHistory.push([currentState.operatingMode, currentState.state]);

        return {
          ...currentState,
          state: { fsm: StateMachineStates.A, my: currentState.state.my },
          operatingMode: DegradationModes.L0,
          degradationHistory: updatedHistory,
        };
      },
    ],
  ];

  const upgradeDAG: [
    [DegradationModes, DegradationModes],
    TransferFunction<any, undefined, undefined, DegradationModes>
  ][] = [
    // L1.1 -> L2
    [
      [DegradationModes.L1_1, DegradationModes.L2],
      (currentState) => {
        if (currentState.state.fsm === StateMachineStates.C) {
          return {
            ...currentState,
            state: { fsm: StateMachineStates.C, my: currentState.state.my },
            operatingMode: DegradationModes.L2,
            degradationHistory: [],
          };
        } else {
          return {
            ...currentState,
            state: { fsm: StateMachineStates.B, my: currentState.state.my },
            operatingMode: DegradationModes.L2,
            degradationHistory: [],
          };
        }
      },
    ],
    // L0 -> L1.1
    [
      [DegradationModes.L0, DegradationModes.L1_1],
      (currentState) => {
        const previousState = _.find(
          currentState.degradationHistory,
          (element) => _.isEqual(element[0], DegradationModes.L1_1)
        );
        if (previousState && previousState[1].fsm === StateMachineStates.C) {
          return {
            ...currentState,
            state: { fsm: StateMachineStates.C, my: currentState.state.my },
            operatingMode: DegradationModes.L1_1,
          };
        } else {
          return {
            ...currentState,
            state: { fsm: StateMachineStates.A, my: currentState.state.my },
            operatingMode: DegradationModes.L1_1,
          };
        }
      },
    ],
  ];

  const dependencyMap = new Map<
    number,
    DependencyFunction<any, undefined, undefined, DegradationModes, ShadowModes>
  >([
    // L0
    [
      DegradationLevels.L0,
      (state, shadows) => {
        return true;
      },
    ],
    // L1.1
    [
      DegradationLevels.L1_1,
      (state, shadows) => {
        const targetMode =
          state.degradationHistory.length > 0
            ? state.degradationHistory[0][0]
            : state.operatingMode;
        if (
          shadows.get(SubComponents.C1)?.mode === ShadowModes.ON &&
          shadows.get(SubComponents.C2)?.mode === ShadowModes.OFF &&
          targetMode >= DegradationModes.L1_1
        ) {
          return true;
        } else {
          return false;
        }
      },
    ],
    // L1.2
    [
      DegradationLevels.L1_2,
      (state, shadows) => {
        const targetMode =
          state.degradationHistory.length > 0
            ? state.degradationHistory[0][0]
            : state.operatingMode;
        if (
          shadows.get(SubComponents.C1)?.mode === ShadowModes.ON &&
          shadows.get(SubComponents.C3)?.mode === ShadowModes.OFF &&
          targetMode === DegradationModes.L2
        ) {
          return true;
        } else {
          return false;
        }
      },
    ],
    // L2
    [
      DegradationLevels.L2,
      (state, shadows) => {
        const targetMode =
          state.degradationHistory.length > 0
            ? state.degradationHistory[0][0]
            : state.operatingMode;

        if (
          shadows.get(SubComponents.C1)?.mode === ShadowModes.ON &&
          shadows.get(SubComponents.C2)?.mode === ShadowModes.ON &&
          shadows.get(SubComponents.C3)?.mode === ShadowModes.ON &&
          targetMode === DegradationModes.L2
        ) {
          return true;
        } else {
          return false;
        }
      },
    ],
  ]);

  const component: Component<undefined, undefined, DegradationModes> =
    createStatemachineComponent(
      [],
      stateMachineMapping,
      "Test Component",
      levelMapping,
      dependencyMap,
      degradationDAG,
      upgradeDAG
    );

  test("Degradation should lead to state C in degradation mode L1.1", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      undefined,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.C, my: undefined },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.OFF }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const degradedState = updateOperatingMode(component, initialState, shadows);

    expect(degradedState.operatingMode).toBe(DegradationModes.L1_1);
    expect(degradedState.state.fsm).toBe(StateMachineStates.C);
    expect(degradedState.degradationHistory).toStrictEqual([
      [DegradationModes.L2, { fsm: StateMachineStates.C, my: undefined }],
    ]);
  });

  test("Degradation should lead to state A in degradation mode L0", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      number,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.C, my: 42 },
      events: [],
      operatingMode: DegradationModes.L1_1,
      degradationHistory: [
        [DegradationModes.L2, { fsm: StateMachineStates.C, my: 42 }],
      ],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.OFF }],
      [SubComponents.C2, { mode: ShadowModes.ON }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const degradedState = updateOperatingMode(component, initialState, shadows);

    expect(degradedState.operatingMode).toBe(DegradationModes.L0);
    expect(degradedState.state.fsm).toBe(StateMachineStates.A);
    expect(degradedState.degradationHistory).toStrictEqual([
      [DegradationModes.L2, { fsm: StateMachineStates.C, my: 42 }],
      [DegradationModes.L1_1, { fsm: StateMachineStates.C, my: 42 }],
    ]);
  });

  test("Degradation should return the current state 1", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      undefined,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.A, my: undefined },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.ON }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const degradedState = updateOperatingMode(component, initialState, shadows);

    expect(degradedState.operatingMode).toBe(DegradationModes.L2);
    expect(degradedState.state.fsm).toBe(StateMachineStates.A);
    expect(degradedState.degradationHistory).toStrictEqual([]);
  });

  test("Degradation should return the current state 2", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      undefined,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.A, my: undefined },
      events: [],
      operatingMode: DegradationModes.L1_2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.OFF }],
      [SubComponents.C3, { mode: ShadowModes.OFF }],
    ]);

    const degradedState = updateOperatingMode(component, initialState, shadows);

    expect(degradedState.operatingMode).toBe(DegradationModes.L1_2);
    expect(degradedState.state.fsm).toBe(StateMachineStates.A);
    expect(degradedState.degradationHistory).toStrictEqual([]);
  });

  test("Upgrade should lead to state C in degradation mode L2", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      undefined,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.A, my: undefined },
      events: [],
      operatingMode: DegradationModes.L0,
      degradationHistory: [
        [DegradationModes.L2, { fsm: StateMachineStates.C, my: undefined }],
        [DegradationModes.L1_1, { fsm: StateMachineStates.C, my: undefined }],
      ],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.ON }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const promotedState = updateOperatingMode(component, initialState, shadows);

    console.log(promotedState);

    expect(promotedState.operatingMode).toBe(DegradationModes.L2);
    expect(promotedState.state.fsm).toBe(StateMachineStates.C);
    expect(promotedState.degradationHistory).toStrictEqual([]);
  });

  test("Upgrade should return the current state 2", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      undefined,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.B, my: undefined },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.ON }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const promotedState = updateOperatingMode(component, initialState, shadows);

    expect(promotedState.operatingMode).toBe(DegradationModes.L2);
    expect(promotedState.state.fsm).toBe(StateMachineStates.B);
    expect(promotedState.degradationHistory).toStrictEqual([]);
  });

  test("Reconfiguration should lead to state A in degradation mode L1.1", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      undefined,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.C, my: undefined },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.OFF }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const reconfiguredState = reconfigureSMDegradationMode(
      component,
      initialState,
      [DegradationModes.L1_1, StateMachineStates.A],
      shadows
    );

    expect(reconfiguredState.operatingMode).toBe(DegradationModes.L1_1);
    expect(reconfiguredState.state.fsm).toBe(StateMachineStates.A);
    expect(reconfiguredState.degradationHistory).toStrictEqual([]);
  });

  test("Reconfiguration should lead to state C in degradation mode L1.1", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      undefined,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.A, my: undefined },
      events: [],
      operatingMode: DegradationModes.L1_1,
      degradationHistory: [
        [DegradationModes.L2, { fsm: StateMachineStates.C, my: undefined }],
      ],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.OFF }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const reconfiguredState = reconfigureSMDegradationMode(
      component,
      initialState,
      [DegradationModes.L1_1, StateMachineStates.C],
      shadows
    );

    expect(reconfiguredState.operatingMode).toBe(DegradationModes.L1_1);
    expect(reconfiguredState.state.fsm).toBe(StateMachineStates.C);
    expect(reconfiguredState.degradationHistory).toStrictEqual([]);
  });

  test("Stepping should lead to state B in degradation mode L2", () => {
    const initialState: DegradableStateMachineState<
      StateMachineStates,
      undefined,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { fsm: StateMachineStates.C, my: undefined },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const newState = degradedStep(component, initialState);

    expect(newState.operatingMode).toBe(DegradationModes.L2);
    expect(newState.state.fsm).toBe(StateMachineStates.B);
    expect(newState.degradationHistory).toStrictEqual([]);
  });
});

// TODO fix this

describe("Non-State-Machine Degradation Test", () => {
  enum DegradationModes {
    L0 = "L0",
    L1_1 = "L1.1",
    L1_2 = "L1.2",
    L2 = "L2",
  }

  enum SubComponents {
    C1 = "C1",
    C2 = "C2",
    C3 = "C3",
  }

  enum ShadowModes {
    OFF = "OFF",
    ON = "ON",
  }

  enum DegradationLevels {
    L0 = 0,
    L1_1 = 1,
    L1_2 = 2,
    L2 = 3,
  }

  const levelMapping = new Map<number, DegradationModes>([
    [0, DegradationModes.L0],
    [1, DegradationModes.L1_1],
    [2, DegradationModes.L1_2],
    [3, DegradationModes.L2],
  ]);

  type StateType = {
    str: string;
    num: number;
  };

  const degradationDAG: [
    [DegradationModes, DegradationModes],
    TransferFunction<StateType, undefined, undefined, DegradationModes>
  ][] = [
    // L2 -> L1.1
    [
      [DegradationModes.L2, DegradationModes.L1_1],
      (
        currentState: DegradableState<
          StateType,
          undefined,
          undefined,
          DegradationModes
        >
      ) => {
        // append the current operating mode and state machine state into the degradation history
        const updatedHistory = [...currentState.degradationHistory];
        updatedHistory.push([currentState.operatingMode, currentState.state]);

        if (currentState.state.num === 1) {
          return {
            ...currentState,
            operatingMode: DegradationModes.L1_1,
            degradationHistory: updatedHistory,
          };
        } else {
          return {
            ...currentState,
            operatingMode: DegradationModes.L1_1,
            degradationHistory: updatedHistory,
          };
        }
      },
    ],
    // L1.1 -> L0
    [
      [DegradationModes.L1_1, DegradationModes.L0],
      (
        currentState: DegradableState<
          StateType,
          undefined,
          undefined,
          DegradationModes
        >
      ) => {
        // append the current operating mode and state machine state into the degradation history
        const updatedHistory = [...currentState.degradationHistory];
        updatedHistory.push([currentState.operatingMode, currentState.state]);

        return {
          ...currentState,
          operatingMode: DegradationModes.L0,
          degradationHistory: updatedHistory,
        };
      },
    ],
  ];

  const upgradeDAG: [
    [DegradationModes, DegradationModes],
    TransferFunction<any, undefined, undefined, DegradationModes>
  ][] = [
    // L1.1 -> L2
    [
      [DegradationModes.L1_1, DegradationModes.L2],
      (
        currentState: DegradableState<
          StateType,
          undefined,
          undefined,
          DegradationModes
        >
      ) => {
        if (currentState.state.str === "str") {
          return {
            ...currentState,
            operatingMode: DegradationModes.L2,
            degradationHistory: [],
          };
        } else {
          return {
            ...currentState,
            operatingMode: DegradationModes.L2,
            degradationHistory: [],
          };
        }
      },
    ],
    // L0 -> L1.1
    [
      [DegradationModes.L0, DegradationModes.L1_1],
      (
        currentState: DegradableState<
          StateType,
          undefined,
          undefined,
          DegradationModes
        >
      ) => {
        const previousState = _.find(
          currentState.degradationHistory,
          (element) => _.isEqual(element[0], DegradationModes.L1_1)
        );
        if (previousState && previousState[1].num === 1) {
          return {
            ...currentState,
            state: { num: 0, str: "str" },
            operatingMode: DegradationModes.L1_1,
          };
        } else {
          return {
            ...currentState,
            operatingMode: DegradationModes.L1_1,
          };
        }
      },
    ],
  ];

  const dependencyMap = new Map<
    number,
    DependencyFunction<any, undefined, undefined, DegradationModes, ShadowModes>
  >([
    // L0
    [
      DegradationLevels.L0,
      (state, shadows) => {
        return true;
      },
    ],
    // L1.1
    [
      DegradationLevels.L1_1,
      (state, shadows) => {
        const targetMode =
          state.degradationHistory.length > 0
            ? state.degradationHistory[0][0]
            : state.operatingMode;
        if (
          shadows.get(SubComponents.C1)?.mode === ShadowModes.ON &&
          shadows.get(SubComponents.C2)?.mode === ShadowModes.OFF &&
          targetMode >= DegradationModes.L1_1
        ) {
          return true;
        } else {
          return false;
        }
      },
    ],
    // L1.2
    [
      DegradationLevels.L1_2,
      (state, shadows) => {
        const targetMode =
          state.degradationHistory.length > 0
            ? state.degradationHistory[0][0]
            : state.operatingMode;
        if (
          shadows.get(SubComponents.C1)?.mode === ShadowModes.ON &&
          shadows.get(SubComponents.C3)?.mode === ShadowModes.OFF &&
          targetMode === DegradationModes.L2
        ) {
          return true;
        } else {
          return false;
        }
      },
    ],
    // L2
    [
      DegradationLevels.L2,
      (state, shadows) => {
        const targetMode =
          state.degradationHistory.length > 0
            ? state.degradationHistory[0][0]
            : state.operatingMode;

        if (
          shadows.get(SubComponents.C1)?.mode === ShadowModes.ON &&
          shadows.get(SubComponents.C2)?.mode === ShadowModes.ON &&
          shadows.get(SubComponents.C3)?.mode === ShadowModes.ON &&
          targetMode === DegradationModes.L2
        ) {
          return true;
        } else {
          return false;
        }
      },
    ],
  ]);

  const component: Component<undefined, undefined, DegradationModes> = {
    name: "Non-State-Machine Component",
    ports: [],
    step: (current) => {
      return Just.of(current);
    },
    allSteps: (current) => {
      process.exit(1);
    },
    degradationLevels: levelMapping,
    dependencyMap: dependencyMap,
    degradationDAG: degradationDAG,
    upgradeDAG: upgradeDAG,
    tsType: "Component",
  };

  test("Degradation should lead to state C in degradation mode L1.1", () => {
    const initialState: DegradableState<
      StateType,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { num: 0, str: "test" },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.OFF }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    sorrirLogger.debug("AABCD Logger Test");
    const degradedState = updateOperatingMode(component, initialState, shadows);

    expect(degradedState.operatingMode).toBe(DegradationModes.L1_1);
    expect(degradedState.degradationHistory).toStrictEqual([
      [DegradationModes.L2, { num: 0, str: "test" }],
    ]);
  });

  test("Degradation should lead to state A in degradation mode L0", () => {
    const initialState: DegradableState<
      StateType,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { num: 0, str: "test" },
      events: [],
      operatingMode: DegradationModes.L1_1,
      degradationHistory: [[DegradationModes.L2, { num: 0, str: "test" }]],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.OFF }],
      [SubComponents.C2, { mode: ShadowModes.ON }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const degradedState = updateOperatingMode(component, initialState, shadows);

    expect(degradedState.operatingMode).toBe(DegradationModes.L0);
    expect(degradedState.degradationHistory).toStrictEqual([
      [DegradationModes.L2, { num: 0, str: "test" }],
      [DegradationModes.L1_1, { num: 0, str: "test" }],
    ]);
  });

  test("Degradation should return the current state 1", () => {
    const initialState: DegradableState<
      StateType,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { num: 42, str: "test" },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.ON }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const degradedState = updateOperatingMode(component, initialState, shadows);

    expect(degradedState.operatingMode).toBe(DegradationModes.L2);
    expect(degradedState.degradationHistory).toStrictEqual([]);
  });

  test("Degradation should return the current state 2", () => {
    const initialState: DegradableState<
      StateType,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { num: 42, str: "test" },
      events: [],
      operatingMode: DegradationModes.L1_2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.OFF }],
      [SubComponents.C3, { mode: ShadowModes.OFF }],
    ]);

    const degradedState = updateOperatingMode(component, initialState, shadows);

    expect(degradedState.operatingMode).toBe(DegradationModes.L1_2);
    expect(degradedState.degradationHistory).toStrictEqual([]);
  });

  test("Upgrade should lead to state C in degradation mode L2", () => {
    const initialState: DegradableState<
      StateType,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { num: 41, str: "String" },
      events: [],
      operatingMode: DegradationModes.L0,
      degradationHistory: [
        [DegradationModes.L2, { num: 41, str: "String" }],
        [DegradationModes.L1_1, { num: 41, str: "String" }],
      ],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.ON }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const promotedState = updateOperatingMode(component, initialState, shadows);

    console.log(promotedState);

    expect(promotedState.operatingMode).toBe(DegradationModes.L2);
    expect(promotedState.degradationHistory).toStrictEqual([]);
  });

  test("Upgrade should return the current state 2", () => {
    const initialState: DegradableState<
      StateType,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { num: 41, str: "String" },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.ON }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const promotedState = updateOperatingMode(component, initialState, shadows);

    expect(promotedState.operatingMode).toBe(DegradationModes.L2);
    expect(promotedState.degradationHistory).toStrictEqual([]);
  });

  test("Reconfiguration should lead to state A in degradation mode L1.1", () => {
    const initialState: DegradableState<
      StateType,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { num: 41, str: "String" },
      events: [],
      operatingMode: DegradationModes.L2,
      degradationHistory: [],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.OFF }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const reconfiguredState = reconfigureDegradationMode(
      component,
      initialState,
      DegradationModes.L1_1,
      shadows
    );

    expect(reconfiguredState.operatingMode).toBe(DegradationModes.L1_1);
    expect(reconfiguredState.degradationHistory).toStrictEqual([]);
  });

  test("Reconfiguration should lead to state C in degradation mode L1.1", () => {
    const initialState: DegradableState<
      StateType,
      undefined,
      undefined,
      DegradationModes
    > = {
      state: { num: 41, str: "String" },
      events: [],
      operatingMode: DegradationModes.L1_1,
      degradationHistory: [[DegradationModes.L2, { num: 41, str: "String" }]],
      tsType: "State",
    };

    const shadows: ShadowMap<ShadowModes> = new Map<
      SubComponents,
      ShadowEntry<ShadowModes>
    >([
      [SubComponents.C1, { mode: ShadowModes.ON }],
      [SubComponents.C2, { mode: ShadowModes.OFF }],
      [SubComponents.C3, { mode: ShadowModes.ON }],
    ]);

    const reconfiguredState = reconfigureDegradationMode(
      component,
      initialState,
      DegradationModes.L1_1,
      shadows
    );

    expect(reconfiguredState.operatingMode).toBe(DegradationModes.L1_1);
    expect(reconfiguredState.degradationHistory).toStrictEqual([]);
  });
});
