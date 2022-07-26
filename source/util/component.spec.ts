/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  StateMachine,
  StateMachineState,
  stateSpace,
  AbstractState,
  DegradableState,
  OutPort,
  InPort,
  createPort,
} from "./engine";
import {
  Configuration,
  AtomicComponent,
  configurationStep,
  createStatemachineComponent,
  createConnection,
  ConfigurationState,
  allConfigurationSteps,
  TransferFunction,
  applyTransferFunction,
  createHierarchicalComponent,
  StepFunction,
} from "./component";
import * as logger from "winston";
import * as _ from "lodash";
import { v4 as uuidv4 } from "uuid";
import { removeIdAndEventClass } from "./engine.spec";
import { Maybe, Just, isJust, fromJust, withDefault } from "@typed/maybe";

logger.configure({
  level: "info",
  transports: [new logger.transports.Console()],
});

describe("R-PM.2a_2b_3b_4: basic communication test", () => {
  enum FSMState {
    A = "A",
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
  }

  enum Ports {
    IN = "IN",
    OUT = "OUT",
  }

  const sm: StateMachine<FSMState, number, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.B,
        event: ["oneway", Events.X, Ports.IN],
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: Events.X, port: Ports.OUT });
          return myState + 1;
        },
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        event: ["oneway", Events.X, Ports.IN],
        condition: (myState) => myState === 1,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: Events.X, port: Ports.OUT });
          return myState + 1;
        },
      },
      {
        sourceState: FSMState.B,
        targetState: FSMState.FINISH,
        event: ["oneway", Events.X, Ports.IN],
        condition: (myState) => myState === 1,
        action: (myState) => myState + 1,
      },
    ],
  };

  const comp_1: AtomicComponent<Events, Ports> = createStatemachineComponent(
    [
      { name: Ports.IN, eventTypes: Object.values(Events), direction: "in" },
      { name: Ports.OUT, eventTypes: Object.values(Events), direction: "out" },
    ],
    sm
  );

  const comp_2: AtomicComponent<Events, Ports> = createStatemachineComponent(
    [
      { name: Ports.IN, eventTypes: Object.values(Events), direction: "in" },
      { name: Ports.OUT, eventTypes: Object.values(Events), direction: "out" },
    ],
    sm
  );

  const configuration: Configuration = {
    components: [comp_1, comp_2],
    connections: [
      createConnection(comp_1, Ports.OUT, comp_2, Ports.IN),
      createConnection(comp_2, Ports.OUT, comp_1, Ports.IN),
    ],
  };

  test("R-PM.2a_2b_3b_4: step by step", () => {
    const state_1: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: Ports.IN },
      ],
      tsType: "State",
    };
    const state_2: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 1 },
      events: [],
      tsType: "State",
    };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1],
        [comp_2, state_2],
      ]),
    };

    expect(
      confState.componentState.get(comp_1)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(FSMState.B);
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(FSMState.A);
    expect(confState.componentState.get(comp_1)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_2)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(FSMState.B);
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_1)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(2);
    expect(
      confState.componentState.get(comp_1)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_1)?.state.my).toBe(2);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(2);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });

  test("R-PM.2a_2b_3b_4: with run-to-completion", () => {
    const state_1: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: Ports.IN },
      ],
      tsType: "State",
    };
    const state_2: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 1 },
      events: [],
      tsType: "State",
    };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1],
        [comp_2, state_2],
      ]),
    };

    expect(
      confState.componentState.get(comp_1)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);
    expect(
      confState.componentState.get(comp_2)?.events.map(removeIdAndEventClass)
    ).toEqual([]);

    confState = configurationStep(configuration, confState);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_1)?.state.my).toBe(2);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(2);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });
});

describe("R-PM.2a_2b_3b_4: basic communication test 2", () => {
  enum FSMState1 {
    A = "A",
    FINISH = "FINISH",
  }

  enum FSMState2 {
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
  }

  enum Ports {
    IN = "IN",
    OUT = "OUT",
  }

  const sm1: StateMachine<FSMState1, undefined, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState1.A,
        targetState: FSMState1.FINISH,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: Events.X, port: Ports.OUT });
          return myState;
        },
      },
    ],
  };

  const sm2: StateMachine<FSMState2, undefined, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState2.B,
        targetState: FSMState2.FINISH,
        event: ["oneway", Events.X, Ports.IN],
      },
    ],
  };

  const comp_1: AtomicComponent<Events, Ports> = createStatemachineComponent(
    [
      { name: Ports.IN, eventTypes: Object.values(Events), direction: "in" },
      { name: Ports.OUT, eventTypes: Object.values(Events), direction: "out" },
    ],
    sm1
  );

  const comp_2: AtomicComponent<Events, Ports> = createStatemachineComponent(
    [
      { name: Ports.IN, eventTypes: Object.values(Events), direction: "in" },
      { name: Ports.OUT, eventTypes: Object.values(Events), direction: "out" },
    ],
    sm2
  );

  const configuration: Configuration = {
    components: [comp_1, comp_2],
    connections: [
      createConnection(comp_1, Ports.OUT, comp_2, Ports.IN),
      createConnection(comp_2, Ports.OUT, comp_1, Ports.IN),
    ],
  };

  test("R-PM.2a_2b_3b_4: step by step", () => {
    const state_1 = { state: { fsm: FSMState1.A, my: undefined }, events: [] };
    const state_2 = { state: { fsm: FSMState2.B, my: undefined }, events: [] };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(FSMState2.B);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_2)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });

  test("R-PM.2a_2b_3b_4: with run-to-completion", () => {
    const state_1 = { state: { fsm: FSMState1.A, my: undefined }, events: [] };
    const state_2 = { state: { fsm: FSMState2.B, my: undefined }, events: [] };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    confState = configurationStep(configuration, confState);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });
});

describe("R-PM.2a_2b_3b_4: different port types", () => {
  enum FSMState1 {
    A = "A",
    FINISH = "FINISH",
  }

  enum FSMState2 {
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
  }

  enum Ports_Comp1 {
    OUT = "OUT",
  }

  enum Ports_Comp2 {
    IN = "IN",
  }

  const sm1: StateMachine<FSMState1, undefined, Events, Ports_Comp1> = {
    transitions: [
      {
        sourceState: FSMState1.A,
        targetState: FSMState1.FINISH,
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events.X,
            port: Ports_Comp1.OUT,
          });
          return myState;
        },
      },
    ],
  };

  const sm2: StateMachine<FSMState2, undefined, Events, Ports_Comp2> = {
    transitions: [
      {
        sourceState: FSMState2.B,
        targetState: FSMState2.FINISH,
        event: ["oneway", Events.X, Ports_Comp2.IN],
      },
    ],
  };

  const comp_1: AtomicComponent<Events, Ports_Comp1> =
    createStatemachineComponent(
      [
        {
          name: Ports_Comp1.OUT,
          eventTypes: Object.values(Events),
          direction: "out",
        },
      ],
      sm1
    );

  const comp_2: AtomicComponent<Events, Ports_Comp2> =
    createStatemachineComponent(
      [
        {
          name: Ports_Comp2.IN,
          eventTypes: Object.values(Events),
          direction: "in",
        },
      ],
      sm2
    );

  const configuration: Configuration = {
    components: [comp_1, comp_2],
    connections: [
      createConnection(comp_1, Ports_Comp1.OUT, comp_2, Ports_Comp2.IN),
    ],
  };

  test("R-PM.2a_2b_3b_4: step by step", () => {
    const state_1 = { state: { fsm: FSMState1.A, my: undefined }, events: [] };
    const state_2 = { state: { fsm: FSMState2.B, my: undefined }, events: [] };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(FSMState2.B);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_2)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports_Comp2.IN }]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });

  test("R-PM.2a_2b_3b_4: with run-to-completion", () => {
    const state_1 = { state: { fsm: FSMState1.A, my: undefined }, events: [] };
    const state_2 = { state: { fsm: FSMState2.B, my: undefined }, events: [] };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    confState = configurationStep(configuration, confState);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });
});

describe("R-PM.2a_2b_3b_4: different events and ports with type checking", () => {
  enum FSMState1 {
    A = "A",
    FINISH = "FINISH",
  }

  enum FSMState2 {
    B = "B",
    FINISH = "FINISH",
  }

  enum Events_X {
    X = "X",
  }

  enum Events_Y {
    Y = "Y",
  }

  enum Events_Z {
    Z = "Z",
  }

  enum Ports_Comp1 {
    OUT = "OUT",
  }

  enum Ports_Comp2 {
    IN = "IN",
    OUT = "OUT",
  }

  enum Ports_Comp3 {
    IN = "IN",
    OUT = "OUT",
  }

  const sm1: StateMachine<FSMState1, undefined, Events_X, Ports_Comp1> = {
    transitions: [
      {
        sourceState: FSMState1.A,
        targetState: FSMState1.FINISH,
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events_X.X,
            port: Ports_Comp1.OUT,
          });
          return myState;
        },
      },
    ],
  };

  const sm2: StateMachine<
    FSMState2,
    undefined,
    Events_X | Events_Y,
    Ports_Comp2
  > = {
    transitions: [
      {
        sourceState: FSMState2.B,
        targetState: FSMState2.FINISH,
        event: ["oneway", Events_X.X, Ports_Comp2.IN],
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events_Y.Y,
            port: Ports_Comp2.OUT,
          });
          return myState;
        },
      },
    ],
  };

  const sm3: StateMachine<
    FSMState2,
    undefined,
    Events_Y | Events_Z,
    Ports_Comp3
  > = {
    transitions: [
      {
        sourceState: FSMState2.B,
        targetState: FSMState2.FINISH,
        event: ["oneway", Events_Y.Y, Ports_Comp3.IN],
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events_Z.Z,
            port: Ports_Comp3.OUT,
          });
          return myState;
        },
      },
    ],
  };

  const comp_1: AtomicComponent<Events_X, Ports_Comp1> =
    createStatemachineComponent(
      [
        {
          name: Ports_Comp1.OUT,
          eventTypes: Object.values(Events_X),
          direction: "out",
        },
      ],
      sm1
    );

  const comp_2: AtomicComponent<Events_Y | Events_X, Ports_Comp2> =
    createStatemachineComponent(
      [
        {
          name: Ports_Comp2.IN,
          eventTypes: Object.values(Events_X),
          direction: "in",
        },
        {
          name: Ports_Comp2.OUT,
          eventTypes: Object.values(Events_Y),
          direction: "out",
        },
      ],
      sm2
    );

  const comp_3: AtomicComponent<Events_Y | Events_Z, Ports_Comp3> =
    createStatemachineComponent(
      [
        {
          name: Ports_Comp3.IN,
          eventTypes: Object.values(Events_Y),
          direction: "in",
        },
        {
          name: Ports_Comp3.OUT,
          eventTypes: Object.values(Events_Z),
          direction: "out",
        },
      ],
      sm3
    );

  const configuration: Configuration = {
    components: [comp_1, comp_2, comp_3],
    connections: [
      createConnection(comp_1, Ports_Comp1.OUT, comp_2, Ports_Comp2.IN),
      createConnection(comp_2, Ports_Comp2.OUT, comp_3, Ports_Comp3.IN),
    ],
  };

  test("R-PM.2a_2b_3b_4: step by step", () => {
    const state_1 = { state: { fsm: FSMState1.A, my: undefined }, events: [] };
    const state_2 = { state: { fsm: FSMState2.B, my: undefined }, events: [] };
    const state_3 = { state: { fsm: FSMState2.B, my: undefined }, events: [] };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
        [comp_3, state_3] as [any, any],
      ]),
    };

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(FSMState2.B);
    expect(confState.componentState.get(comp_3)?.state.fsm).toBe(FSMState2.B);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_2)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events_X.X, port: Ports_Comp2.IN }]);
    expect(confState.componentState.get(comp_3)?.events).toEqual([]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_3)?.state.fsm).toBe(FSMState2.B);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_3)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events_Y.Y, port: Ports_Comp3.IN }]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_3)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_3)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events_Z.Z, port: Ports_Comp3.OUT }]);
  });

  test("R-PM.2a_2b_3b_4: with run-to-completion", () => {
    const state_1 = { state: { fsm: FSMState1.A, my: undefined }, events: [] };
    const state_2 = { state: { fsm: FSMState2.B, my: undefined }, events: [] };
    const state_3 = { state: { fsm: FSMState2.B, my: undefined }, events: [] };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
        [comp_3, state_3] as [any, any],
      ]),
    };
    confState = configurationStep(configuration, confState);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_3)?.state.fsm).toBe(
      FSMState2.FINISH
    );
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_3)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events_Z.Z, port: Ports_Comp3.OUT }]);
  });
});

describe("R-PM.2a_2b_3b_4: basic communication test 3", function () {
  enum FSMState {
    A = "A",
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
  }

  enum Ports {
    IN = "IN",
    OUT = "OUT",
  }

  const sm: StateMachine<FSMState, number, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.B,
        event: ["oneway", Events.X, Ports.IN],
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: Events.X, port: Ports.OUT });
          return myState + 1;
        },
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        event: ["oneway", Events.X, Ports.IN],
        condition: (myState) => myState === 1,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: Events.X, port: Ports.OUT });
          return myState + 1;
        },
      },
      {
        sourceState: FSMState.B,
        targetState: FSMState.FINISH,
        event: ["oneway", Events.X, Ports.IN],
        condition: (myState) => myState === 1,
        action: (myState) => myState + 1,
      },
    ],
  };

  const comp_1: AtomicComponent<Events, Ports> = createStatemachineComponent(
    [
      { name: Ports.IN, eventTypes: Object.values(Events), direction: "in" },
      { name: Ports.OUT, eventTypes: Object.values(Events), direction: "out" },
    ],
    sm
  );

  const comp_2: AtomicComponent<Events, Ports> = createStatemachineComponent(
    [
      { name: Ports.IN, eventTypes: Object.values(Events), direction: "in" },
      { name: Ports.OUT, eventTypes: Object.values(Events), direction: "out" },
    ],
    sm
  );

  const configuration: Configuration = {
    components: [comp_1, comp_2],
    connections: [
      createConnection(comp_1, Ports.OUT, comp_2, Ports.IN),
      createConnection(comp_2, Ports.OUT, comp_1, Ports.IN),
    ],
  };

  test("R-PM.2a_2b_3b_4: step by step", () => {
    const state_1: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: Ports.IN },
      ],
      tsType: "State",
    };
    const state_2: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 1 },
      events: [],
      tsType: "State",
    };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    expect(
      confState.componentState.get(comp_1)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(FSMState.B);
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(FSMState.A);
    expect(confState.componentState.get(comp_1)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_2)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(FSMState.B);
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_1)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(2);
    expect(
      confState.componentState.get(comp_1)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_1)?.state.my).toBe(2);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(2);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });

  test("R-PM.2a_2b_3b_4: with run-to-completion", () => {
    const state_1: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: Ports.IN },
      ],
      tsType: "State",
    };
    const state_2: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 1 },
      events: [],
      tsType: "State",
    };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    expect(
      confState.componentState.get(comp_1)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);

    confState = configurationStep(configuration, confState);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_1)?.state.my).toBe(2);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(2);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });
});

describe("R-PM.2a_2b_3b_4: P is a complex type", () => {
  enum FSMState {
    A = "A",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
  }

  enum Ports {
    P1 = "P1",
    P2 = "P2",
  }

  interface port_type {
    version: number;
    name: Ports;
  }

  const sm: StateMachine<FSMState, number, Events, port_type> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events.X,
            port: { version: 2, name: Ports.P2 },
          });
          return myState + 1;
        },
        event: ["oneway", Events.X, undefined],
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          return myState + 1;
        },
        event: ["oneway", Events.X, { version: 2, name: Ports.P1 }],
      },
    ],
  };

  const comp_1: AtomicComponent<Events, port_type> =
    createStatemachineComponent(
      [
        {
          name: { version: 2, name: Ports.P2 },
          eventTypes: Object.values(Events),
          direction: "out",
        },
      ],
      sm
    );

  const comp_2: AtomicComponent<Events, port_type> =
    createStatemachineComponent(
      [
        {
          name: { version: 2, name: Ports.P1 },
          eventTypes: Object.values(Events),
          direction: "in",
        },
      ],
      sm
    );

  const configuration: Configuration = {
    components: [comp_1, comp_2],
    connections: [
      createConnection(comp_1, { version: 2, name: Ports.P2 }, comp_2, {
        version: 2,
        name: Ports.P1,
      }),
    ],
  };

  test("R-PM.2a_2b_3b_4: step by step", () => {
    //check that equality is used not identity
    const state_1: StateMachineState<FSMState, number, Events, port_type> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: undefined },
      ],
      tsType: "State",
    };
    const state_2 = { state: { fsm: FSMState.A, my: 0 }, events: [] };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    expect(
      confState.componentState.get(comp_1)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: undefined }]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(FSMState.A);
    expect(confState.componentState.get(comp_1)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(0);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(
      confState.componentState.get(comp_2)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: { version: 2, name: Ports.P1 } }]);

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_1)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });

  test("R-PM.2a_2b_3b_4: with run-to-completion", () => {
    //check that equality is used not identity
    const state_1: StateMachineState<FSMState, number, Events, port_type> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: undefined },
      ],
      tsType: "State",
    };
    const state_2 = { state: { fsm: FSMState.A, my: 0 }, events: [] };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    expect(
      confState.componentState.get(comp_1)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: undefined }]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);

    confState = configurationStep(configuration, confState);
    expect(confState.componentState.get(comp_1)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_2)?.state.fsm).toBe(
      FSMState.FINISH
    );
    expect(confState.componentState.get(comp_1)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_2)?.state.my).toBe(1);
    expect(confState.componentState.get(comp_1)?.events).toEqual([]);
    expect(confState.componentState.get(comp_2)?.events).toEqual([]);
  });
});

test("R-PM.2a_2b_3b_4_5_6: state space test", () => {
  enum FSMState1 {
    A = "A",
    B = "B",
    FINISH = "FINISH",
  }

  enum FSMState2 {
    C = "C",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
  }

  enum Ports {
    IN = "IN",
    OUT = "OUT",
  }

  const sm1: StateMachine<FSMState1, number, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState1.A,
        targetState: FSMState1.B,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: Events.X, port: Ports.OUT });
          return myState;
        },
      },
      {
        sourceState: FSMState1.A,
        targetState: FSMState1.A,
        condition: (mystate) => mystate === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: Events.X, port: Ports.OUT });
          return myState + 1;
        },
      },
      {
        sourceState: FSMState1.B,
        targetState: FSMState1.FINISH,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: Events.X, port: Ports.OUT });
          return myState;
        },
      },
    ],
  };

  const sm2: StateMachine<FSMState2, number, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState2.C,
        targetState: FSMState2.FINISH,
        event: ["oneway", Events.X, Ports.IN],
      },
    ],
  };

  {
    const state_1: StateMachineState<FSMState1, number, Events, Ports> = {
      state: { fsm: FSMState1.A, my: 0 },
      events: [],
      tsType: "State",
    };
    const state_2: StateMachineState<FSMState2, number, Events, Ports> = {
      state: { fsm: FSMState2.C, my: 0 },
      events: [],
      tsType: "State",
    };

    const comp_1: AtomicComponent<Events, Ports> = createStatemachineComponent(
      [
        { name: Ports.IN, eventTypes: Object.values(Events), direction: "in" },
        {
          name: Ports.OUT,
          eventTypes: Object.values(Events),
          direction: "out",
        },
      ],
      sm1,
      "comp_1"
    );

    const comp_2: AtomicComponent<Events, Ports> = createStatemachineComponent(
      [
        { name: Ports.IN, eventTypes: Object.values(Events), direction: "in" },
        {
          name: Ports.OUT,
          eventTypes: Object.values(Events),
          direction: "out",
        },
      ],
      sm2,
      "comp_2"
    );

    const configuration: Configuration = {
      components: [comp_1, comp_2],
      connections: [createConnection(comp_1, Ports.OUT, comp_2, Ports.IN)],
    };

    const confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1] as [any, any],
        [comp_2, state_2] as [any, any],
      ]),
    };

    const allNextConfigurations = allConfigurationSteps(
      configuration,
      confState
    );
    expect(allNextConfigurations.length).toBe(2);
    expect(allNextConfigurations[0].componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.B
    );
    expect(allNextConfigurations[0].componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.C
    );
    expect(allNextConfigurations[1].componentState.get(comp_1)?.state.fsm).toBe(
      FSMState1.A
    );
    expect(allNextConfigurations[1].componentState.get(comp_2)?.state.fsm).toBe(
      FSMState2.C
    );

    const space = stateSpace(configuration, confState, allConfigurationSteps);
    expect(space.nodes().length).toBe(6);
  }
});

describe("degradation modes test", () => {
  enum States {
    A = "A",
    FINISH = "FINISH",
  }

  enum FSMState2 {
    B = "B",
    FINISH = "FINISH",
  }

  const sm1: StateMachine<States, number, undefined, undefined> = {
    transitions: [
      {
        sourceState: States.A,
        targetState: States.FINISH,
        action: (myState) => 42,
      },
    ],
  };

  const sm2: StateMachine<FSMState2, number, undefined, undefined> = {
    transitions: [
      {
        sourceState: FSMState2.B,
        targetState: FSMState2.FINISH,
        action: (mystate) => 4711,
      },
    ],
  };

  enum OperatingModes {
    NORMAL,
    BROKEN,
  }

  const transferFromNormalToBroken = (
    currentState: DegradableState<any, undefined, undefined, OperatingModes>
  ) => ({
    ...currentState,
    state: { fsm: States.FINISH, my: 4710 },
  });
  const transferFromBrokenToNormal = (
    currentState: DegradableState<any, undefined, undefined, OperatingModes>
  ) => ({
    ...currentState,
    state: {
      fsm: States.A,
      my: 41,
    },
  });
  const transferFunctions: [
    [OperatingModes, OperatingModes],
    TransferFunction<any, any, any, any>
  ][] = [
    [
      [OperatingModes.NORMAL, OperatingModes.BROKEN],
      transferFromNormalToBroken,
    ],
    [
      [OperatingModes.BROKEN, OperatingModes.NORMAL],
      transferFromBrokenToNormal,
    ],
  ];

  const comp: AtomicComponent<undefined, undefined, OperatingModes> = {
    ...createStatemachineComponent(
      [],
      [
        [OperatingModes.NORMAL, sm1],
        [OperatingModes.BROKEN, sm2],
      ]
    ),
    transferFunctions: transferFunctions,
  };

  test("step with transfer function", () => {
    const state: DegradableState<any, undefined, undefined, OperatingModes> = {
      state: { fsm: States.A, my: 41 },
      events: [],
      operatingMode: OperatingModes.NORMAL,
      degradationHistory: [],
      tsType: "State",
    };

    let nextState = withDefault(undefined, comp.step(state));
    expect(nextState?.state.my).toBe(42);
    expect(nextState?.state.fsm).toBe(States.FINISH);
    expect(nextState?.operatingMode).toBe(OperatingModes.NORMAL);

    nextState = applyTransferFunction(comp, OperatingModes.BROKEN, state);
    expect(nextState.state.my).toBe(4710);
    expect(nextState.state.fsm).toBe(States.FINISH);
    expect(nextState?.operatingMode).toBe(OperatingModes.BROKEN);

    nextState = applyTransferFunction(comp, OperatingModes.NORMAL, state);
    expect(nextState.state.my).toBe(41);
    expect(nextState.state.fsm).toBe(States.A);
    expect(nextState?.operatingMode).toBe(OperatingModes.NORMAL);
  });
});

describe("R-PM.2a_2b_3b: single hierarchy test", () => {
  // 4 components A1, A2, B1, B2
  // A1, A2 are in A, B1, B2 in B
  // communication: A1 -> A2 -> A -> B -> B1 -> B2

  enum Ports {
    IN = "IN",
    OUT = "OUT",
  }

  enum Events {
    X = "X",
  }

  type AtomicState = AbstractState<number, Events, Ports, undefined>;

  const a1: AtomicComponent<Events, Ports> = {
    name: "a1",
    ports: [
      { name: Ports.IN, eventTypes: [Events.X], direction: "in" },
      { name: Ports.OUT, eventTypes: [Events.X], direction: "out" },
    ],
    step: (current: AtomicState) => {
      const newState = { ...current };
      const incoming_msgs = current.events.filter((e) =>
        _.isEqual(e.port, Ports.IN)
      );
      if (incoming_msgs.length > 0) {
        // add 1 to state, replace all existing events with new event on the out-port
        newState.state += 1;
        newState.events = [
          {
            eventClass: "oneway",
            id: uuidv4(),
            type: Events.X,
            port: Ports.OUT,
          },
        ];
      }
      return Just.of(newState);
    },
    allSteps: (current) => {
      process.exit(1);
    }, // exit if called
    tsType: "Component",
  };

  // all atomic components are identical
  const a2 = { ...a1, name: "a2" };
  const b1 = { ...a1, name: "b1" };
  const b2 = { ...a1, name: "b2" };

  const A_configuration: Configuration = {
    components: [a1, a2],
    connections: [createConnection(a1, Ports.OUT, a2, Ports.IN)],
  };
  const B_configuration: Configuration = {
    components: [b1, b2],
    connections: [createConnection(b1, Ports.OUT, b2, Ports.IN)],
  };

  const A = createHierarchicalComponent<any, Events, Ports, undefined>(
    {
      name: "A",
      ports: [{ name: Ports.OUT, eventTypes: [Events.X], direction: "out" }],
      subConfiguration: A_configuration,
      delegations: [
        {
          type: "OutDelegation",
          source: {
            sourceComponent: a2,
            sourcePort: a2.ports[1] as OutPort<Events, unknown>,
          },
          target: {
            targetPort: {
              name: Ports.OUT,
              eventTypes: [Events.X],
              direction: "out",
            },
          },
        },
      ],
      tsType: "Component",
    },
    false
  );

  const B = createHierarchicalComponent<any, Events, Ports, undefined>(
    {
      name: "B",
      ports: [{ name: Ports.IN, eventTypes: [Events.X], direction: "in" }],
      subConfiguration: B_configuration,
      delegations: [
        {
          type: "IntoDelegation",
          source: {
            sourcePort: {
              name: Ports.IN,
              eventTypes: [Events.X],
              direction: "in",
            },
          },
          target: {
            targetComponent: b1,
            targetPort: b1.ports[0] as InPort<Events, unknown>,
          },
        },
      ],
      tsType: "Component",
    },
    false
  );

  const configuration: Configuration = {
    components: [A, B],
    connections: [createConnection(A, Ports.OUT, B, Ports.IN)],
  };

  test("R-PM.2a_2b_3b: test hierarchical step for A", () => {
    // states for a1, a2,
    // configstates for a

    const state_a1: AtomicState = {
      state: 0,
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: Ports.IN },
      ],
      tsType: "State",
    };
    const state_a2 = { ...state_a1, events: [] };

    const state_a: AbstractState<ConfigurationState, Events, Ports, undefined> =
      {
        state: {
          componentState: new Map([
            [a1, state_a1],
            [a2, state_a2],
          ]),
        },
        events: [],
        tsType: "State",
      };

    expect(state_a?.state.componentState.get(a1)?.events).toHaveLength(1);
    expect(state_a?.state.componentState.get(a2)?.events).toHaveLength(0);

    let nextState = withDefault(undefined, A.step(state_a));
    expect(nextState?.state.componentState.get(a1)?.events).toHaveLength(0);
    expect(nextState?.state.componentState.get(a2)?.events).toHaveLength(1);
    expect(nextState).toBeDefined();
    nextState = withDefault(undefined, A.step(nextState!));
    nextState = withDefault(undefined, A.step(nextState!));
    expect(nextState?.state.componentState.get(a1)?.events).toHaveLength(0);
    expect(nextState?.state.componentState.get(a2)?.events).toHaveLength(0);
  });

  test("R-PM.2a_2b_3b: hierarchical step test for full configuration", () => {
    // states for a1, a2, b1, b2
    // configstates for a, b

    const state_a1: AtomicState = {
      state: 0,
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: Ports.IN },
      ],
      tsType: "State",
    };
    const state_a2 = { ...state_a1, events: [] };
    const state_b1 = { ...state_a1, events: [] };
    const state_b2 = { ...state_a1, events: [] };

    const state_a: AbstractState<ConfigurationState, Events, Ports> = {
      state: {
        componentState: new Map([
          [a1, state_a1],
          [a2, state_a2],
        ]),
      },
      events: [],
      tsType: "State",
    };

    const state_b: AbstractState<ConfigurationState, Events, Ports> = {
      state: {
        componentState: new Map([
          [b1, state_b1],
          [b2, state_b2],
        ]),
      },
      events: [],
      tsType: "State",
    };

    const configurationState: ConfigurationState = {
      componentState: new Map([
        [A, state_a],
        [B, state_b],
      ]),
    };

    let nextState = configurationStep(configuration, configurationState, false);
    expect(
      nextState?.componentState.get(A)?.state.componentState.get(a1)?.events
    ).toHaveLength(0);
    expect(
      nextState?.componentState.get(A)?.state.componentState.get(a2)?.events
    ).toHaveLength(1);
    nextState = configurationStep(configuration, nextState, false);
    expect(
      nextState?.componentState.get(A)?.state.componentState.get(a1)?.events
    ).toHaveLength(0);
    expect(
      nextState?.componentState.get(A)?.state.componentState.get(a2)?.events
    ).toHaveLength(0);
    expect(nextState?.componentState.get(A)?.events).toHaveLength(0);
    expect(nextState?.componentState.get(B)?.events).toHaveLength(1);
    nextState = configurationStep(configuration, nextState, false);
    expect(nextState?.componentState.get(B)?.events).toHaveLength(0);
    expect(
      nextState?.componentState.get(B)?.state.componentState.get(b1)?.events
    ).toHaveLength(0);
    expect(
      nextState?.componentState.get(B)?.state.componentState.get(b2)?.events
    ).toHaveLength(1);
    nextState = configurationStep(configuration, nextState, false);
    expect(
      nextState?.componentState.get(B)?.state.componentState.get(b1)?.events
    ).toHaveLength(0);
    expect(
      nextState?.componentState.get(B)?.state.componentState.get(b2)?.events
    ).toHaveLength(1);
  });
});
