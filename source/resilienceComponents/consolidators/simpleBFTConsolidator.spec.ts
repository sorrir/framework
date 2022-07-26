import { createBFTConsolidatorComponent } from "./simpleBFTConsolidator";
import { ConsolidatorPorts } from "./consolidatorPorts";
import {
  Maybe,
  Just,
  Nothing,
  isJust,
  fromJust,
  withDefault,
} from "@typed/maybe";

describe("BFT Consolidator test", () => {
  enum Events {
    X = "X",
  }

  test(".. preserves event", () => {
    let [comp_1, comp_1_state] = createBFTConsolidatorComponent<
      Events,
      ConsolidatorPorts
    >(
      [
        {
          name: [ConsolidatorPorts.IN, 0],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 1],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 2],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 3],
          eventTypes: Object.values(Events),
          direction: "in",
        },
      ],
      {
        name: [ConsolidatorPorts.OUT, 0],
        eventTypes: Object.values(Events),
        direction: "out",
      },
      2
    );
    comp_1_state = {
      ...comp_1_state,
      events: [
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 0],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
      ],
    };
    const newState = comp_1.step(comp_1_state);
    expect(isJust(newState)).toBe(true);
    expect(fromJust(<Just<any>>newState).events).toEqual([
      {
        type: Events.X,
        port: [ConsolidatorPorts.IN, 0],
        timestamp: 0,
        id: "",
        eventClass: "oneway",
        param: { a: "a" },
      },
    ]);
  });

  test(".. filters old events", () => {
    let [comp_1, comp_1_state] = createBFTConsolidatorComponent<
      Events,
      ConsolidatorPorts
    >(
      [
        {
          name: [ConsolidatorPorts.IN, 0],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 1],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 2],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 3],
          eventTypes: Object.values(Events),
          direction: "in",
        },
      ],
      {
        name: [ConsolidatorPorts.OUT, 0],
        eventTypes: Object.values(Events),
        direction: "out",
      },
      2
    );
    comp_1_state = {
      ...comp_1_state,
      events: [
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 0],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.OUT, 0],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
      ],
    };
    comp_1_state.state.lastAcceptedSequence = 0;
    const newState = comp_1.step(comp_1_state);
    expect(isJust(newState)).toBe(true);
    expect(fromJust(<Just<any>>newState).events).toEqual([
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 0],
        timestamp: 0,
        id: "",
        eventClass: "oneway",
        param: { a: "a" },
      },
    ]);
  });

  test(".. exists: quorum of f+1 matching events in  inport for same sequence", () => {
    let [comp_1, comp_1_state] = createBFTConsolidatorComponent<
      Events,
      ConsolidatorPorts
    >(
      [
        {
          name: [ConsolidatorPorts.IN, 0],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 1],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 2],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 3],
          eventTypes: Object.values(Events),
          direction: "in",
        },
      ],
      {
        name: [ConsolidatorPorts.OUT, 0],
        eventTypes: Object.values(Events),
        direction: "out",
      },
      2
    );
    comp_1_state = {
      ...comp_1_state,
      events: [
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 0],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 1],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 2],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 3],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "X" },
        },
      ],
    };
    const newState = comp_1.step(comp_1_state);
    expect(isJust(newState)).toBe(true);
    expect(fromJust(<Just<any>>newState).events).toEqual([
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 0],
        timestamp: 0,
        id: "",
        eventClass: "oneway",
        param: { a: "a" },
      },
    ]);
  });

  test(".. with different sequence numbers..", () => {
    let [comp_1, comp_1_state] = createBFTConsolidatorComponent<
      Events,
      ConsolidatorPorts
    >(
      [
        {
          name: [ConsolidatorPorts.IN, 0],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 1],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 2],
          eventTypes: Object.values(Events),
          direction: "in",
        },
        {
          name: [ConsolidatorPorts.IN, 3],
          eventTypes: Object.values(Events),
          direction: "in",
        },
      ],
      {
        name: [ConsolidatorPorts.OUT, 0],
        eventTypes: Object.values(Events),
        direction: "out",
      },
      2
    );
    comp_1_state = {
      ...comp_1_state,
      events: [
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 0],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 1],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 2],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 3],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "X" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 0],
          timestamp: 1,
          id: "",
          eventClass: "oneway",
          param: { a: "b" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 1],
          timestamp: 1,
          id: "",
          eventClass: "oneway",
          param: { a: "b" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 2],
          timestamp: 2,
          id: "",
          eventClass: "oneway",
          param: { a: "b" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 3],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "X" },
        },
      ],
    };
    const newState = comp_1.step(comp_1_state);
    expect(isJust(newState)).toBe(true);
    expect(fromJust(<Just<any>>newState).events).toEqual([
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 0],
        timestamp: 0,
        id: "",
        eventClass: "oneway",
        param: { a: "a" },
      },
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 0],
        timestamp: 1,
        id: "",
        eventClass: "oneway",
        param: { a: "b" },
      },
      {
        type: Events.X,
        port: [ConsolidatorPorts.IN, 2],
        timestamp: 2,
        id: "",
        eventClass: "oneway",
        param: { a: "b" },
      },
    ]);
  });

  test(
    ".. with out messages in events[]: E.g., Messages with seq=0 were processed, and component crashed&recovered " +
      "with lastAcceptedSeq=0 and the outgoing event in events[]",
    () => {
      let [comp_1, comp_1_state] = createBFTConsolidatorComponent<
        Events,
        ConsolidatorPorts
      >(
        [
          {
            name: [ConsolidatorPorts.IN, 0],
            eventTypes: Object.values(Events),
            direction: "in",
          },
          {
            name: [ConsolidatorPorts.IN, 1],
            eventTypes: Object.values(Events),
            direction: "in",
          },
          {
            name: [ConsolidatorPorts.IN, 2],
            eventTypes: Object.values(Events),
            direction: "in",
          },
          {
            name: [ConsolidatorPorts.IN, 3],
            eventTypes: Object.values(Events),
            direction: "in",
          },
        ],
        {
          name: [ConsolidatorPorts.OUT, 0],
          eventTypes: Object.values(Events),
          direction: "out",
        },
        2
      );
      comp_1_state = {
        ...comp_1_state,
        events: [
          {
            type: Events.X,
            port: [ConsolidatorPorts.OUT, 0],
            timestamp: 0,
            id: "",
            eventClass: "oneway",
            param: { a: "a" },
          },
          {
            type: Events.X,
            port: [ConsolidatorPorts.IN, 0],
            timestamp: 1,
            id: "",
            eventClass: "oneway",
            param: { a: "b" },
          },
          {
            type: Events.X,
            port: [ConsolidatorPorts.IN, 1],
            timestamp: 1,
            id: "",
            eventClass: "oneway",
            param: { a: "b" },
          },
          {
            type: Events.X,
            port: [ConsolidatorPorts.IN, 2],
            timestamp: 1,
            id: "",
            eventClass: "oneway",
            param: { a: "X" },
          },
          {
            type: Events.X,
            port: [ConsolidatorPorts.IN, 3],
            timestamp: 1,
            id: "",
            eventClass: "oneway",
            param: { a: "b" },
          },
          {
            type: Events.X,
            port: [ConsolidatorPorts.IN, 2],
            timestamp: 2,
            id: "",
            eventClass: "oneway",
            param: { a: "c" },
          },
          {
            type: Events.X,
            port: [ConsolidatorPorts.IN, 3],
            timestamp: 2,
            id: "",
            eventClass: "oneway",
            param: { a: "c" },
          },
          {
            type: Events.X,
            port: [ConsolidatorPorts.IN, 3],
            timestamp: 3,
            id: "",
            eventClass: "oneway",
            param: { a: "d" },
          },
        ],
      };
      // Messages with seq=0 were processed, and component crashed&recovered with lastAcceptedSeq=0 and the outgoing event in events[]
      comp_1_state.state.lastAcceptedSequence = 0;

      const newState = comp_1.step(comp_1_state);
      expect(isJust(newState)).toBe(true);
      expect(fromJust(<Just<any>>newState).events).toEqual([
        {
          type: Events.X,
          port: [ConsolidatorPorts.OUT, 0],
          timestamp: 0,
          id: "",
          eventClass: "oneway",
          param: { a: "a" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.OUT, 0],
          timestamp: 1,
          id: "",
          eventClass: "oneway",
          param: { a: "b" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.OUT, 0],
          timestamp: 2,
          id: "",
          eventClass: "oneway",
          param: { a: "c" },
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 3],
          timestamp: 3,
          id: "",
          eventClass: "oneway",
          param: { a: "d" },
        },
      ]);
    }
  );
});
