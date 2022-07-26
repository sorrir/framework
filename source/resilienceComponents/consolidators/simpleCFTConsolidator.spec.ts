import { createCFTConsolidatorComponent } from "./simpleCFTConsolidator";
import { ConsolidatorPorts } from "./consolidatorPorts";
import { Maybe, Just, isJust, fromJust } from "@typed/maybe";

describe("CFT Consolidator test", () => {
  enum Events {
    X = "X",
  }

  test(".. exists: 1 event in any of inport", () => {
    let [comp_1, comp_1_state] = createCFTConsolidatorComponent<
      Events,
      ConsolidatorPorts
    >(
      [
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
      ],
      {
        name: [ConsolidatorPorts.OUT, 1],
        eventTypes: Object.values(Events),
        direction: "out",
      }
    );
    comp_1_state = {
      ...comp_1_state,
      events: [
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 1],
          timestamp: 0,
          eventClass: "oneway",
          id: "",
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 2],
          timestamp: 0,
          eventClass: "oneway",
          id: "",
        },
      ],
    };
    const newState = comp_1.step(comp_1_state);
    expect(isJust(newState)).toBe(true);
    expect(fromJust(<Just<any>>newState).events).toEqual([
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 1],
        timestamp: 0,
        eventClass: "oneway",
        id: "",
      },
    ]);
  });

  test(".. with different timestamps", () => {
    let [comp_1, comp_1_state] = createCFTConsolidatorComponent<
      Events,
      ConsolidatorPorts
    >(
      [
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
      ],
      {
        name: [ConsolidatorPorts.OUT, 1],
        eventTypes: Object.values(Events),
        direction: "out",
      }
    );
    comp_1_state = {
      ...comp_1_state,
      events: [
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 1],
          timestamp: 0,
          eventClass: "oneway",
          id: "",
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 2],
          timestamp: 1,
          eventClass: "oneway",
          id: "",
        },
      ],
    };

    const newState = comp_1.step(comp_1_state);
    expect(isJust(newState)).toBe(true);
    expect(fromJust(<Just<any>>newState).events).toEqual([
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 1],
        timestamp: 0,
        eventClass: "oneway",
        id: "",
      },
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 1],
        timestamp: 1,
        eventClass: "oneway",
        id: "",
      },
    ]);
  });

  test(".. multiple events in any inport", () => {
    let [comp_1, comp_1_state] = createCFTConsolidatorComponent<
      Events,
      ConsolidatorPorts
    >(
      [
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
        name: [ConsolidatorPorts.OUT, 1],
        eventTypes: Object.values(Events),
        direction: "out",
      }
    );
    comp_1_state = {
      ...comp_1_state,
      events: [
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 1],
          timestamp: 0,
          eventClass: "oneway",
          id: "",
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 1],
          timestamp: 1,
          eventClass: "oneway",
          id: "",
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 2],
          timestamp: 1,
          eventClass: "oneway",
          id: "",
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 3],
          timestamp: 0,
          eventClass: "oneway",
          id: "",
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 3],
          timestamp: 1,
          eventClass: "oneway",
          id: "",
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 3],
          timestamp: 2,
          eventClass: "oneway",
          id: "",
        },
      ],
    };

    const newState = comp_1.step(comp_1_state);
    expect(isJust(newState)).toBe(true);
    expect(fromJust(<Just<any>>newState).events).toEqual([
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 1],
        timestamp: 0,
        eventClass: "oneway",
        id: "",
      },
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 1],
        timestamp: 1,
        eventClass: "oneway",
        id: "",
      },
      {
        type: Events.X,
        port: [ConsolidatorPorts.OUT, 1],
        timestamp: 2,
        eventClass: "oneway",
        id: "",
      },
    ]);
  });

  test("..  no sequence number provided", () => {
    let [comp_1, comp_1_state] = createCFTConsolidatorComponent<
      Events,
      ConsolidatorPorts
    >(
      [
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
      ],
      {
        name: [ConsolidatorPorts.OUT, 1],
        eventTypes: Object.values(Events),
        direction: "out",
      }
    );
    comp_1_state = {
      ...comp_1_state,
      events: [
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 1],
          eventClass: "oneway",
          id: "",
        },
        {
          type: Events.X,
          port: [ConsolidatorPorts.IN, 2],
          eventClass: "oneway",
          id: "",
        },
      ],
    };

    const newState = comp_1.step(comp_1_state);
    expect(isJust(newState)).toBe(true);
    expect(fromJust(<Just<any>>newState).events).toEqual([]);
  });
});
