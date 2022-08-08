import { Nothing } from "@typed/maybe";
import {
  consumeEvent,
  eventExists,
  step,
  StateMachineState,
  StateMachine,
  Event,
  allSteps,
  stateSpace,
  singleStep,
  EventClassOneWay,
  OneWayEvent,
  ErrorEvent,
  ResolveEvent,
} from "./engine";

// some helpers

// eslint-disable-next-line @typescript-eslint/ban-types
export const removeIdAndEventClass = (x: Event<unknown, unknown>): object => {
  const { id, eventClass, ...remaining } = x;
  return remaining;
};

// eslint-disable-next-line @typescript-eslint/ban-types
export const removeSystemParameters = (x: Event<unknown, unknown>): object => {
  const {
    id,
    eventClass,
    timestamp,
    param,
    rc,
    answerToRequestID,
    layer,
    ...remaining
  } = <any>x;
  return remaining;
};

// eslint-disable-next-line @typescript-eslint/ban-types
export const removeEventId = (x: Event<unknown, unknown>): object => {
  const { id, ...remaining } = x;
  return remaining;
};

//

describe("R-PM.4: basic tests", () => {
  enum FSMState {
    A = "A",
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {}

  enum Ports {}

  type MyState = number;

  const sm: StateMachine<FSMState, MyState, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.B,
        condition: (myState) => myState === 0,
        action: (myState) => myState + 1,
      },
      {
        sourceState: FSMState.B,
        targetState: FSMState.FINISH,
        condition: () => true,
        action: (myState) => myState + 1,
      },
    ],
  };

  test("should be in state B after single step", () => {
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [],
      tsType: "State",
    };
    const firstState = singleStep(sm, state);
    expect(firstState.state.fsm).toBe(FSMState.B);
    expect(firstState.state.my).toBe(1);
  });
  test("should be in state FINISH after two steps", () => {
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [],
      tsType: "State",
    };
    const secondState = singleStep(sm, singleStep(sm, state));
    expect(secondState.state.fsm).toBe(FSMState.FINISH);
    expect(secondState.state.my).toBe(2);
  });

  test("should not switch and remain in state A", () => {
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 1 },
      events: [],
      tsType: "State",
    };
    const nextState = singleStep(sm, state);
    expect(nextState.state.fsm).toBe(FSMState.A);
    expect(nextState.state.my).toBe(1);
  });

  test("should not be able to switch and therefore return undefined", () => {
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 1 },
      events: [],
      tsType: "State",
    };
    const nextState = step(sm, state);
    expect(nextState).toBe(Nothing);
  });
});

test("R-PM.2b_4: eventExists", () => {
  const firstEvent: Event<number, undefined> = {
    eventClass: "oneway",
    type: 1,
    id: "42",
  };
  const events: Event<number, undefined>[] = [
    firstEvent,
    { ...firstEvent, type: 3 },
    { ...firstEvent, type: 3 },
  ];
  const existingEvent = { eventClass: "oneway", type: 1 };
  const notExistingEvent = { eventClass: "oneway", type: 2 };
  const doubleExist = { eventClass: "oneway", type: 3 };

  expect(eventExists(events, ["oneway", existingEvent.type])).toBeDefined();
  expect(
    eventExists(events, ["oneway", notExistingEvent.type])
  ).toBeUndefined();
  expect(eventExists(events, ["oneway", doubleExist.type])).toBeDefined();
  expect(eventExists(events, undefined)).toBeUndefined();
});

test("R-PM.2b_4: consumeEvent", () => {
  const firstEvent: Event<number, undefined> = {
    eventClass: "oneway",
    type: 1,
    id: "42",
  };
  const events: Event<number, undefined>[] = [
    firstEvent,
    { ...firstEvent, type: 3 },
    { ...firstEvent, type: 3 },
  ];
  const existingEvent = { eventClass: "oneway", type: 1 };
  const notExistingEvent = { eventClass: "oneway", type: 2 };
  const doubleExist = { eventClass: "oneway", type: 3 };

  expect(
    consumeEvent(events, ["oneway", existingEvent.type]).map(
      removeIdAndEventClass
    )
  ).toEqual([{ type: 3 }, { type: 3 }]);
  expect(consumeEvent(events, ["oneway", notExistingEvent.type])).toEqual(
    events
  );
  expect(
    consumeEvent(events, ["oneway", doubleExist.type]).map(
      removeIdAndEventClass
    )
  ).toEqual([{ type: 1 }, { type: 3 }]);
  expect(consumeEvent(events, undefined)).toEqual(events);
});

test("R-PM.2b_4: event w/ w/o ports", () => {
  const events: Event<number, number>[] = [
    { type: 1, port: 12 },
    { type: 3, port: 12 },
    { type: 3 },
  ].map((x) => {
    return { ...x, id: "42", eventClass: "oneway" };
  });

  expect(eventExists(events, ["oneway", 1, 12])).toBeDefined();
  expect(eventExists(events, ["oneway", 1, 32])).toBeUndefined();
  expect(eventExists(events, ["oneway", 1])).toBeUndefined();
  expect(eventExists(events, ["oneway", 3])).toBeDefined();
  expect(eventExists(events, ["oneway", 3, 12])).toBeDefined();
  expect(eventExists(events, ["oneway", 2])).toBeUndefined();
  expect(eventExists(events, ["oneway", 2, 12])).toBeUndefined();

  expect(
    consumeEvent(events, ["oneway", 1, 12]).map(removeIdAndEventClass)
  ).toEqual([{ type: 3, port: 12 }, { type: 3 }]);
  expect(consumeEvent(events, ["oneway", 1, 32])).toEqual(events);
  expect(consumeEvent(events, ["oneway", 1])).toEqual(events);
  expect(
    consumeEvent(events, ["oneway", 3]).map(removeIdAndEventClass)
  ).toEqual([
    { type: 1, port: 12 },
    { type: 3, port: 12 },
  ]);
  expect(
    consumeEvent(events, ["oneway", 3, 12]).map(removeIdAndEventClass)
  ).toEqual([{ type: 1, port: 12 }, { type: 3 }]);
  expect(consumeEvent(events, ["oneway", 2])).toEqual(events);
  expect(consumeEvent(events, ["oneway", 2, 12])).toEqual(events);
});

describe("R-PM.2b_4: test events", () => {
  enum FSMState {
    A = "A",
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
    Y = "Y",
  }

  enum Ports {}

  type MyState = number;

  const sm: StateMachine<FSMState, MyState, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.B,
        condition: (myState) => myState === 0,
        action: (myState) => myState + 1,
        event: ["oneway", Events.X],
      },
      {
        sourceState: FSMState.B,
        targetState: FSMState.FINISH,
        action: (myState) => myState + 1,
      },
    ],
  };

  test("R-PM.2b_4: should consume one of two Event.X", () => {
    // event available
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [{ type: Events.X }, { type: Events.Y }, { type: Events.X }].map(
        (x) => {
          return { ...x, id: "42", eventClass: "oneway" };
        }
      ),
      tsType: "State",
    };
    const nextState = singleStep(sm, state);
    expect(nextState.state.fsm).toBe(FSMState.B);
    expect(nextState.state.my).toBe(1);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: Events.Y },
      { type: Events.X },
    ]);
  });

  describe("R-PM.2b_4: should not be able to switch and not consuming event of wrong type", () => {
    test("R-PM.2b_4: step by step", () => {
      // event not available
      const state: { ports: any } & StateMachineState<
        FSMState,
        number,
        Events,
        Ports
      > = {
        state: { fsm: FSMState.A, my: 0 },
        events: [{ eventClass: "oneway", id: "42", type: Events.Y }],
        ports: [],
        tsType: "State",
      };
      const nextState = singleStep(sm, state);
      expect(nextState.state.fsm).toBe(FSMState.A);
      expect(nextState.state.my).toBe(0);
      expect(nextState.events.map(removeIdAndEventClass)).toEqual([
        { type: Events.Y },
      ]);
    });

    test("R-PM.2b_4: run2completion ", () => {
      // event not available
      const state: { ports: any } & StateMachineState<
        FSMState,
        number,
        Events,
        Ports
      > = {
        state: { fsm: FSMState.A, my: 0 },
        events: [{ eventClass: "oneway", id: "42", type: Events.Y }],
        ports: [],
        tsType: "State",
      };
      const nextState = step(sm, state);
      expect(nextState).toBe(Nothing);
    });
  });
});

describe("R-PM.2b_4: events with parameter", () => {
  enum FSMState {
    A = "A",
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
  }

  enum Ports {}

  interface EventX extends OneWayEvent<Events, Ports> {
    payload: {
      speed: number;
    };
  }

  type MyState = number;

  const sm: StateMachine<FSMState, MyState, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.B,
        condition: (myState: number, event?: Event<Events, Ports>) =>
          myState === 0 &&
          event !== undefined &&
          (event as EventX).param.speed === 50,
        action: (myState) => myState + 1,
        event: ["oneway", Events.X],
      },
      {
        sourceState: FSMState.B,
        targetState: FSMState.FINISH,
        action: (myState) => myState + 1,
      },
    ],
  };

  test("R-PM.2b_4: should switch because condition should be evaluated to true", () => {
    // event available
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        {
          eventClass: "oneway",
          id: "42",
          type: Events.X,
          param: { speed: 50 },
        },
      ],
      tsType: "State",
    };
    const nextState = singleStep(sm, state);
    expect(nextState.state.fsm).toBe(FSMState.B);
    expect(nextState.state.my).toBe(1);
    expect(nextState.events).toEqual([]);
  });

  describe("R-PM.2b_4: should not switch because condition should be evaluated to false", () => {
    test("R-PM.2b_4: step by step", () => {
      const state: StateMachineState<FSMState, number, Events, Ports> = {
        state: { fsm: FSMState.A, my: 0 },
        events: [],
        tsType: "State",
      };
      const nextState = singleStep(sm, state);
      expect(nextState.state.fsm).toBe(FSMState.A);
      expect(nextState.state.my).toBe(0);
      expect(nextState.events).toEqual([]);
    });

    test("R-PM.2b_4: run2completion ", () => {
      const state: StateMachineState<FSMState, number, Events, Ports> = {
        state: { fsm: FSMState.A, my: 0 },
        events: [],
        tsType: "State",
      };
      const nextState = step(sm, state);
      expect(nextState).toBe(Nothing);
    });
  });
});

describe("R-PM.2b_4: raisedEvents", () => {
  enum FSMState {
    A = "A",
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
    Y = "Y",
  }

  enum Ports {}

  interface EventY extends OneWayEvent<Events, Ports> {
    param: {
      incr: number;
    };
  }

  type MyState = number;

  const sm: StateMachine<FSMState, MyState, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.B,
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          const event: Omit<OneWayEvent<Events, Ports>, "id"> = {
            type: Events.Y,
            eventClass: "oneway",
            param: { incr: 10 },
          };
          raiseEvent(event);
          return myState + 1;
        },
        event: ["oneway", Events.X],
      },
      {
        sourceState: FSMState.B,
        targetState: FSMState.FINISH,
        event: ["oneway", Events.Y],
        action: (myState, _, event?: Event<Events, Ports>) => {
          return myState + (event as EventY).param.incr;
        },
      },
    ],
  };

  test("R-PM.2b_4: should consume newly raised event", () => {
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [{ type: Events.X }, { type: Events.X }].map((x) => {
        return { ...x, id: "42", eventClass: "oneway" };
      }),
      tsType: "State",
    };
    const nextState = singleStep(sm, singleStep(sm, state));
    expect(nextState.state.fsm).toBe(FSMState.FINISH);
    expect(nextState.state.my).toBe(11);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: Events.X },
    ]);
  });

  test("R-PM.2b_4: Y event already available should be consumed before the newly raised event ", () => {
    // Y event already available should be consumed before the newly raised event
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { type: Events.X },
        { type: Events.Y, param: { incr: 20 } },
        { type: Events.X },
      ].map((x) => {
        return { ...x, id: "42", eventClass: "oneway" };
      }),
      tsType: "State",
    };
    const nextState = singleStep(sm, singleStep(sm, state));
    expect(nextState.state.fsm).toBe(FSMState.FINISH);
    expect(nextState.state.my).toBe(21);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: Events.X },
      { type: Events.Y, param: { incr: 10 } },
    ]);
  });
});

describe("R-PM.2b_4: incoming/outgoing Events via Port", () => {
  enum FSMState {
    A = "A",
    B = "B",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
    Y = "Y",
  }

  enum Ports {
    IN = "IN",
    OUT = "OUT",
  }

  interface EventY extends OneWayEvent<Events, Ports> {
    param: {
      incr: number;
    };
  }

  type EventX = OneWayEvent<Events, Ports>;

  type MyState = number;

  const sm: StateMachine<FSMState, MyState, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.B,
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events.Y,
            port: Ports.OUT,
            param: {
              incr: 10,
            },
          });
          return myState + 1;
        },
        event: ["oneway", Events.X, Ports.IN],
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events.Y,
            port: Ports.OUT,
            param: {
              incr: 10,
            },
          });
          return myState + 1;
        },
        event: ["oneway", Events.X, undefined],
      },
    ],
  };

  test("R-PM.2b_4: should consume event at port", () => {
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { eventClass: "oneway", id: "42", type: Events.X, port: Ports.IN },
      ],
      tsType: "State",
    };
    const nextState = singleStep(sm, state);
    expect(nextState.state.fsm).toBe(FSMState.B);
    expect(nextState.state.my).toBe(1);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: Events.Y, port: Ports.OUT, param: { incr: 10 } },
    ]);
  });

  test("R-PM.2b_4: should consume internal event while event at port is earlier", () => {
    // consume internal event while event at port is earlier
    const state: StateMachineState<FSMState, number, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [{ type: Events.X, port: Ports.OUT }, { type: Events.X }].map(
        (x) => {
          return {
            ...x,
            id: "42",
            eventClass: "oneway",
          };
        }
      ),
      tsType: "State",
    };
    const nextState = singleStep(sm, state);
    expect(nextState.state.fsm).toBe(FSMState.FINISH);
    expect(nextState.state.my).toBe(1);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: Events.X, port: Ports.OUT },
      { type: Events.Y, port: Ports.OUT, param: { incr: 10 } },
    ]);
  });
});

test("R-PM.2b_4: E is a String", () => {
  enum FSMState {
    A = "A",
    FINISH = "FINISH",
  }

  const sm: StateMachine<FSMState, number, string, undefined> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.A,
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: "Y" });
          return myState + 1;
        },
        event: ["oneway", "X", undefined],
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: (myState) => myState === 1,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: "Z" });
          return myState;
        },
        event: ["oneway", "Y", undefined],
      },
    ],
  };
  {
    //check that equality is used not identity
    const state: StateMachineState<FSMState, number, any, any> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [{ eventClass: "oneway", id: "42", type: "X" }],
      tsType: "State",
    };
    let nextState = singleStep(sm, state);
    expect(nextState.state.fsm).toBe(FSMState.A);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: "Y" },
    ]);
    nextState = singleStep(sm, nextState);
    expect(nextState.state.fsm).toBe(FSMState.FINISH);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: "Z" },
    ]);
  }
});

describe("R-PM.2b_4: E is a complex type", () => {
  enum FSMState {
    A = "A",
    FINISH = "FINISH",
  }

  interface event_type {
    version: number;
    name: string;
  }

  const sm: StateMachine<FSMState, number, event_type, undefined> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.A,
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: { name: "Y", version: 1 },
          });
          return myState + 1;
        },
        event: ["oneway", { name: "X", version: 0 }, undefined],
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: (myState) => myState === 1,
        action: (myState, raiseEvent) => {
          raiseEvent({ eventClass: "oneway", type: { name: "Z", version: 1 } });
          return myState;
        },
        event: ["oneway", { name: "Y", version: 1 }, undefined],
      },
    ],
  };
  test("R-PM.2b_4: check that equality is used not identity", () => {
    const state: StateMachineState<FSMState, number, any, any> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        { eventClass: "oneway", id: "42", type: { name: "X", version: 0 } },
      ],
      tsType: "State",
    };
    let nextState = singleStep(sm, state);
    expect(nextState.state.fsm).toBe(FSMState.A);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: { name: "Y", version: 1 } },
    ]);
    nextState = singleStep(sm, nextState);
    expect(nextState.state.fsm).toBe(FSMState.FINISH);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: { name: "Z", version: 1 } },
    ]);
  });

  describe("R-PM.2b_4: should not switch because of wrong event ", () => {
    test("R-PM.2b_4: step by step", () => {
      const state: StateMachineState<FSMState, number, any, any> = {
        state: { fsm: FSMState.A, my: 0 },
        events: [
          { eventClass: "oneway", id: "42", type: { name: "X", version: 1 } },
        ],
        tsType: "State",
      };
      const nextState = singleStep(sm, state);
      expect(nextState.state.fsm).toBe(FSMState.A);
      expect(nextState.events.map(removeIdAndEventClass)).toEqual([
        { type: { name: "X", version: 1 } },
      ]);
    });

    test("R-PM.2b_4: run2completion", () => {
      const state: StateMachineState<FSMState, number, any, any> = {
        state: { fsm: FSMState.A, my: 0 },
        events: [
          { eventClass: "oneway", id: "42", type: { name: "X", version: 1 } },
        ],
        tsType: "State",
      };
      const nextState = step(sm, state);
      expect(nextState).toBe(Nothing);
    });
  });
});

describe("R-PM.2b_4: P is a complex type", () => {
  enum FSMState {
    A = "A",
    FINISH = "FINISH",
  }

  enum Events {
    X = "X",
  }

  enum Ports {
    P1,
    P2,
  }

  interface port_type {
    version: number;
    name: Ports;
  }

  const sm: StateMachine<FSMState, number, Events, port_type> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.A,
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events.X,
            port: { version: 2, name: Ports.P2 },
          });
          return myState + 1;
        },
        event: ["oneway", Events.X, { version: 1, name: Ports.P1 }],
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: (myState) => myState === 1,
        action: (myState, raiseEvent) => {
          raiseEvent({
            eventClass: "oneway",
            type: Events.X,
            port: { version: 1, name: Ports.P1 },
          });
          return myState;
        },
        event: ["oneway", Events.X, { version: 2, name: Ports.P2 }],
      },
    ],
  };
  test("R-PM.2b_4: check that equality is used not identity", () => {
    const state: StateMachineState<FSMState, number, any, any> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [
        {
          eventClass: "oneway",
          id: "42",
          type: Events.X,
          port: { version: 1, name: Ports.P1 },
        },
      ],
      tsType: "State",
    };
    let nextState = singleStep(sm, state);
    expect(nextState.state.fsm).toBe(FSMState.A);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: Events.X, port: { version: 2, name: Ports.P2 } },
    ]);
    nextState = singleStep(sm, nextState);
    expect(nextState.state.fsm).toBe(FSMState.FINISH);
    expect(nextState.events.map(removeIdAndEventClass)).toEqual([
      { type: Events.X, port: { version: 1, name: Ports.P1 } },
    ]);
  });

  describe("R-PM.2b_4: check with wrong port", () => {
    test("R-PM.2b_4: step by step", () => {
      const state: StateMachineState<FSMState, number, any, any> = {
        state: { fsm: FSMState.A, my: 0 },
        events: [
          {
            eventClass: "oneway",
            id: "42",
            type: Events.X,
            port: { version: 2, name: Ports.P1 },
          },
        ],
        tsType: "State",
      };
      const nextState = singleStep(sm, state);
      expect(nextState.state.fsm).toBe(FSMState.A);
      expect(nextState.events.map(removeIdAndEventClass)).toEqual([
        { type: Events.X, port: { version: 2, name: Ports.P1 } },
      ]);
    });

    test("R-PM.2b_4: run2completion ", () => {
      const state: StateMachineState<FSMState, number, any, any> = {
        state: { fsm: FSMState.A, my: 0 },
        events: [
          {
            eventClass: "oneway",
            id: "42",
            type: Events.X,
            port: { version: 2, name: Ports.P1 },
          },
        ],
        tsType: "State",
      };
      const nextState = step(sm, state);
      expect(nextState).toBe(Nothing);
    });
  });
});

test("R-PM.5_6: allSteps tests", () => {
  enum FSMState {
    A = "A",
    FINISH = "FINISH",
  }

  enum Events {}

  enum Ports {}

  type MyState = number;

  const sm: StateMachine<FSMState, MyState, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: (myState) => myState === 0,
        action: (myState) => myState + 1,
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: () => true,
        action: (myState) => myState + 2,
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        condition: () => true,
        action: (myState) => myState + 3,
      },
    ],
  };

  {
    const state: StateMachineState<FSMState, number, any, any> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [],
      tsType: "State",
    };
    const newStates = allSteps(sm, state);
    expect(newStates.length).toBe(3);
    expect(newStates[0].state.fsm).toBe(FSMState.FINISH);
    expect(newStates[0].state.my).toBe(1);
    expect(newStates[1].state.fsm).toBe(FSMState.FINISH);
    expect(newStates[1].state.my).toBe(2);
    expect(newStates[2].state.fsm).toBe(FSMState.FINISH);
    expect(newStates[2].state.my).toBe(3);
  }
});

test("R-PM.5_6: stateSpace tests", () => {
  enum FSMState {
    A = "A",
  }

  enum Events {}

  enum Ports {}

  type MyState = number;

  const sm: StateMachine<FSMState, MyState, Events, Ports> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.A,
        condition: (myState) => myState === 0 && myState < 4,
        action: (myState) => myState + 1,
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.A,
        condition: (myState) => myState < 4,
        action: (myState) => myState + 2,
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.A,
        condition: (myState) => myState < 4,
        action: (myState) => myState + 3,
      },
    ],
  };

  {
    const state: StateMachineState<FSMState, MyState, Events, Ports> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [],
      tsType: "State",
    };
    const space = stateSpace(sm, state, allSteps);
    // this should create states with 0, 1, 2, 3, 4, 5, 6
    expect(space.nodes().length).toBe(7);
  }
});

describe("R-PM.2b_4: rpc event tests", () => {
  enum FSMState {
    A = "A",
    FINISH = "FINISH",
  }

  enum Events {
    A = "A",
    B = "B",
  }

  type MyState = number;

  const sm: StateMachine<FSMState, MyState, Events, undefined> = {
    transitions: [
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        event: ["request", Events.A],
        condition: (myState) => myState === 0,
        action: (myState, raiseEvent, inEvent) => {
          const event: Omit<ResolveEvent<Events, undefined>, "id"> = {
            eventClass: "resolve",
            rc: 42,
            answerToRequestID: inEvent?.id ?? "",
            type: Events.B,
          };
          raiseEvent(event);
          return myState + 1;
        },
      },
      {
        sourceState: FSMState.A,
        targetState: FSMState.FINISH,
        event: ["request", Events.A],
        condition: (myState) => myState === 1,
        action: (myState, raiseEvent, inEvent) => {
          const event: Omit<ErrorEvent<Events, undefined>, "id"> = {
            eventClass: "error",
            rc: 42,
            error: "test error message",
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            answerToRequestID: inEvent!.id,
            layer: "ApplicationLayer",
            type: Events.B,
          };
          raiseEvent(event);
          return myState + 1;
        },
      },
    ],
  };

  test("R-PM.2b_4: no event", () => {
    const state: StateMachineState<FSMState, number, Events, undefined> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [],
      tsType: "State",
    };

    const newState = step(sm, state);
    expect(newState).toBe(Nothing);
  });

  test("R-PM.2b_4: request --> resolve", () => {
    const state: StateMachineState<FSMState, number, Events, undefined> = {
      state: { fsm: FSMState.A, my: 0 },
      events: [{ type: Events.A, eventClass: "request", id: "12" }],
      tsType: "State",
    };

    const newState = singleStep(sm, state);
    expect(newState).toBeDefined();
    expect(newState.state.fsm).toBe(FSMState.FINISH);
    expect(newState.events.map(removeEventId)).toEqual([
      {
        type: Events.B,
        eventClass: "resolve",
        rc: 42,
        answerToRequestID: "12",
      },
    ]);
  });

  test("R-PM.2b_4: request --> error", () => {
    const state: StateMachineState<FSMState, number, Events, undefined> = {
      state: { fsm: FSMState.A, my: 1 },
      events: [{ type: Events.A, eventClass: "request", id: "12" }],
      tsType: "State",
    };

    const newState = singleStep(sm, state);
    expect(newState).toBeDefined();
    expect(newState.state.fsm).toBe(FSMState.FINISH);
    expect(newState.events.map(removeEventId)).toEqual([
      {
        type: Events.B,
        eventClass: "error",
        layer: "ApplicationLayer",
        error: "test error message",
        rc: 42,
        answerToRequestID: "12",
      },
    ]);
  });
});
