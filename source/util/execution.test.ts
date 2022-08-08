/* eslint-disable @typescript-eslint/no-var-requires */
// require("leaked-handles").set({
//   fullStack: false, // use full stack traces
//   timeout: 8000, // run every 30 seconds instead of 5.
//   debugSockets: false, // pretty print tcp thrown exceptions.
// });
import { v4 as uuidv4 } from "uuid";
import { WebSocket } from "ws";
import { CommOption } from "../communication/comm-tech";
import {
  computeLocallyDeployedConfiguration,
  restrictConfigurationStateToConfiguration,
} from "../communication/comm-util";
import {
  basicEventDecoder,
  basicPartialDecoder,
  DecodeEventFunction,
  setDecoder,
} from "../communication/decoding";
import {
  DebuggingConfiguration,
  DeploymentConfiguration,
  HostConfiguration,
  RunConfiguration,
  SecurityConfiguration,
} from "../exec-types";
import { CommunicationConfiguration } from "./../exec-types";
import {
  AtomicComponent,
  Configuration,
  ConfigurationState,
  configurationStep,
  createConnection,
  createStatemachineComponent,
} from "./component";
import {
  AbstractState,
  createPort,
  Event,
  OneWayEvent,
  PortDirection,
  StateMachine,
} from "./engine";
import { executeRunConfiguration, unitTests } from "./execution";
import { removeIdAndEventClass, removeSystemParameters } from "./engine.spec";
import { Server as createAedes } from "aedes";
import { createServer } from "net";
import {
  debuggingAgentName,
  getDebuggingAgentAndConnections,
} from "../agents/debugging-agent";
import { setupAgents } from "../setup/setup-agents";
import _ = require("lodash");
import { INIT_SEQUENCER_CLOCK_STATE } from "./clocks";
import {
  Maybe,
  Just,
  Nothing,
  isJust,
  fromJust,
  withDefault,
} from "@typed/maybe";
import Ajv from "ajv";
import {
  DebuggingAgentWebSocketConfigurationState,
  DebuggingAgentWebSocketConfigurationStateJSONSchema,
  DebuggingAgentWebSocketInjectMessage,
} from "@sorrir/sorrir-framework-interface";
import * as commUtil from "../communication/comm-util";
import { DefaultShadowMode } from "..";
import { encodeEvent } from "../communication/encoding";

//start local mqtt broker
const aedes = createAedes();
const server = createServer(aedes.handle);
beforeAll(
  async () =>
    new Promise((resolve, reject) => {
      server.listen(1883, () => {
        console.log("started MQTT broker");
        resolve(undefined);
      });
    })
);

// avoid warning for memory leak
process.setMaxListeners(50);

enum Events {
  X = "X",
}

enum Ports {
  IN = "IN",
  OUT = "OUT",
}

const portDirections: Record<Ports, PortDirection> = {
  IN: "in",
  OUT: "out",
};

function createEmptyComponent(
  name: string,
  ports: Ports[]
): AtomicComponent<Events, Ports> {
  return {
    name: name,
    step: (state) => Nothing,
    allSteps: (state) => [state],
    ports: ports.map((p) => createPort(p, [Events.X], portDirections[p])),
    tsType: "Component",
  };
}

describe("R-PM.8: computeLocallyDeployedConfiguration", () => {
  test("R-PM.8: 1:1 connections", () => {
    const comp1 = createEmptyComponent("comp1", [Ports.OUT]);
    const comp2 = createEmptyComponent("comp2", [Ports.IN, Ports.OUT]);
    const comp3 = createEmptyComponent("comp3", [Ports.IN, Ports.OUT]);
    const comp4 = createEmptyComponent("comp4", [Ports.IN]);

    const compState = { state: "dummy_state" };

    const lsa: Configuration = {
      components: [comp1, comp2, comp3, comp4],
      connections: [
        createConnection(comp1, Ports.OUT, comp2, Ports.IN),
        createConnection(comp2, Ports.OUT, comp3, Ports.IN),
        createConnection(comp3, Ports.OUT, comp4, Ports.IN),
      ],
    };

    const deploymentConfiguration: DeploymentConfiguration = {
      group1: {
        components: [comp1],
      },
      group2: {
        components: [comp2, comp3],
      },
      group3: {
        components: [comp4],
      },
    };

    const hostConfig: HostConfiguration = {
      // empty as not needed for test
    };

    const communicationConfiguration: CommunicationConfiguration = {
      // empty as not needed for test
      connectionTechs: [],
    };

    const runConfig: RunConfiguration = {
      lsa: lsa,
      toExecute: "group2",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfiguration,
      hostConfiguration: hostConfig,
      confState: {
        componentState: new Map([
          [comp1, { state: undefined, events: [], tsType: "State" }],
          [comp2, { state: undefined, events: [], tsType: "State" }],
          [comp3, { state: undefined, events: [], tsType: "State" }],
          [comp4, { state: undefined, events: [], tsType: "State" }],
        ]),
      },
      clockStates: new Map(),
      engineRoomState: {
        shadowMap: new Map(),
      },
      shutdownFunctions: [],
    };

    // check computeLocallyDeployedConfiguration

    expect(computeLocallyDeployedConfiguration(runConfig).components).toEqual([
      comp2,
      comp3,
    ]);
    expect(
      computeLocallyDeployedConfiguration(runConfig).connections.length
    ).toBe(1);
    expect(
      computeLocallyDeployedConfiguration(runConfig).connections[0]
    ).toEqual(lsa.connections[1]);

    expect(
      computeLocallyDeployedConfiguration({ ...runConfig, toExecute: "group1" })
        .components
    ).toEqual([comp1]);
    expect(
      computeLocallyDeployedConfiguration({ ...runConfig, toExecute: "group1" })
        .connections.length
    ).toBe(0);

    expect(
      computeLocallyDeployedConfiguration({ ...runConfig, toExecute: "group3" })
        .components
    ).toEqual([comp4]);
    expect(
      computeLocallyDeployedConfiguration({ ...runConfig, toExecute: "group3" })
        .connections.length
    ).toBe(0);

    {
      const deplConfig = computeLocallyDeployedConfiguration(runConfig);
      const newState = restrictConfigurationStateToConfiguration(
        deplConfig,
        runConfig.confState
      );
      expect(newState.componentState.size).toBe(2);
      expect(newState.componentState.keys()).toContain(comp2);
      expect(newState.componentState.keys()).toContain(comp3);
      expect(newState.componentState.keys()).not.toContain(comp1);
      expect(newState.componentState.keys()).not.toContain(comp4);
    }
  });
});

describe("R-PM.8: run to completion tests", () => {
  interface PingPongEvent<E, P> extends OneWayEvent<E, P> {
    param: {
      counter: number;
    };
  }

  test("R-PM.3b: locally", async () => {
    enum FSMState {
      PING = "PING",
      PONG = "PONG",
    }

    enum Events {
      X = "X",
    }

    enum Ports {}

    type MyState = undefined;

    const sm: StateMachine<FSMState, MyState, Events, Ports> = {
      transitions: [
        {
          sourceState: FSMState.PING,
          targetState: FSMState.PONG,
          action: (myState, raiseEvent, event) => {
            const receivedCounter = (event as PingPongEvent<Events, Ports>)
              .param.counter;
            if (receivedCounter - 1 > 0) {
              const sendCounter: Omit<PingPongEvent<Events, Ports>, "id"> = {
                eventClass: "oneway",
                type: Events.X,
                param: {
                  counter: receivedCounter - 1,
                },
              };
              raiseEvent(sendCounter);
            }
            return myState;
          },
          event: ["oneway", Events.X],
        },
        {
          sourceState: FSMState.PONG,
          targetState: FSMState.PING,
          action: (myState, raiseEvent, event) => {
            const receivedCounter = (event as PingPongEvent<Events, Ports>)
              .param.counter;
            if (receivedCounter - 1 > 0) {
              const sendCounter: Omit<PingPongEvent<Events, Ports>, "id"> = {
                eventClass: "oneway",
                type: Events.X,
                param: {
                  counter: receivedCounter - 1,
                },
              };
              raiseEvent(sendCounter);
            }
            return myState;
          },
          event: ["oneway", Events.X],
        },
      ],
    };

    const comp1: AtomicComponent<Events, Ports> = createStatemachineComponent(
      [],
      sm,
      "comp1"
    );

    const comp_state = {
      state: { fsm: FSMState.PING, my: undefined },
      events: [
        {
          eventClass: "oneway",
          id: "42",
          type: Events.X,
          param: {
            counter: 20,
          },
        } as PingPongEvent<Events, Ports>,
      ],
      tsType: "State",
    };

    const confState = {
      componentState: new Map([
        [comp1, comp_state] as [
          AtomicComponent<any, any>,
          AbstractState<any, any, any>
        ],
      ]),
    };

    const lsa: Configuration = {
      components: [comp1],
      connections: [],
    };

    const deploymentConfiguration: DeploymentConfiguration = {
      group1: {
        components: [comp1],
      },
    };

    const hostConfig: HostConfiguration = {
      group1: {
        host: "localhost",
        port: 1234,
      },
    };

    const communicationConfiguration: CommunicationConfiguration = {
      // empty as not needed for test
      connectionTechs: [],
    };

    const runConfig: RunConfiguration = {
      lsa: lsa,
      toExecute: "group1",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfiguration,
      hostConfiguration: hostConfig,
      confState: confState,
      shutdownFunctions: [],
      clockStates: _.reduce(
        deploymentConfiguration["group1"].components,
        (map, comp) => {
          map.set(comp, INIT_SEQUENCER_CLOCK_STATE);
          return map;
        },
        new Map()
      ),
      engineRoomState: {
        shadowMap: new Map(),
      },
    };

    expect.assertions(1);

    executeRunConfiguration(runConfig);
    await new Promise<void>((resolve) => {
      let remainingMessages: number | undefined = undefined;

      function checkCompletion() {
        remainingMessages = Array.from(
          runConfig.confState.componentState.values()
        )
          .map((abstractState) => abstractState.events)
          .reduce(
            (numberOfEvents, events) => numberOfEvents + events.length,
            0
          );
        if (remainingMessages === 0) {
          expect(remainingMessages).toBe(0);
          expect(runConfig.clockStates.get(comp1)?.myLocalClock.seq === 20);
          resolve();
        } else {
          setImmediate(checkCompletion);
        }
      }
      checkCompletion();
    }).then(() => {
      unitTests.shutdownRunConfiguration(runConfig);
    });
  });

  test("R-PM.8: remotely", async () => {
    enum PingStates {
      PING = "PING",
      PENG = "PENG",
    }

    enum PongStates {
      PONG = "PONG",
      PANG = "PANG",
    }

    enum Events {
      INTERN = "INTERN",
      EXTERN = "EXTERN",
    }

    enum PingPorts {
      FROM_PONG = "FROM_PONG",
      TO_PONG = "TO_PONG",
    }

    enum PongPorts {
      FROM_PING = "FROM_PING",
      TO_PING = "TO_PING",
    }

    type MyState = number;

    const ping_sm: StateMachine<PingStates, MyState, Events, PingPorts> = {
      transitions: [
        {
          sourceState: PingStates.PING,
          targetState: PingStates.PENG,
          action: (myState, raiseEvent, event) => {
            const receivedCounter = (event as PingPongEvent<Events, PingPorts>)
              .param.counter;
            const sendCounterEvent: Omit<
              PingPongEvent<Events, PingPorts>,
              "id"
            > = {
              eventClass: "oneway",
              type: Events.INTERN,
              param: {
                counter: receivedCounter,
              },
            };
            raiseEvent(sendCounterEvent);
            return receivedCounter;
          },
          event: ["oneway", Events.EXTERN, PingPorts.FROM_PONG],
        },
        {
          sourceState: PingStates.PENG,
          targetState: PingStates.PING,
          action: (myState, raiseEvent, event) => {
            const receivedCounter = (event as PingPongEvent<Events, PingPorts>)
              .param.counter;
            if (receivedCounter - 1 >= 0) {
              const sendCounterEvent: Omit<
                PingPongEvent<Events, PingPorts>,
                "id"
              > = {
                eventClass: "oneway",
                type: Events.EXTERN,
                port: PingPorts.TO_PONG,
                param: {
                  counter: receivedCounter - 1,
                },
              };
              raiseEvent(sendCounterEvent);
            }
            return myState;
          },
          event: ["oneway", Events.INTERN],
        },
      ],
    };

    const pong_sm: StateMachine<PongStates, MyState, Events, PongPorts> = {
      transitions: [
        {
          sourceState: PongStates.PONG,
          targetState: PongStates.PANG,
          action: (myState, raiseEvent, event) => {
            const receivedCounter = (event as PingPongEvent<Events, PongPorts>)
              .param.counter;
            const sendCounterEvent: Omit<
              PingPongEvent<Events, PongPorts>,
              "id"
            > = {
              eventClass: "oneway",
              type: Events.INTERN,
              param: {
                counter: receivedCounter,
              },
            };
            raiseEvent(sendCounterEvent);
            return receivedCounter;
          },
          event: ["oneway", Events.EXTERN, PongPorts.FROM_PING],
        },
        {
          sourceState: PongStates.PANG,
          targetState: PongStates.PONG,
          action: (myState, raiseEvent, event) => {
            const receivedCounter = (event as PingPongEvent<Events, PongPorts>)
              .param.counter;
            if (receivedCounter - 1 >= 0) {
              const sendCounterEvent: Omit<
                PingPongEvent<Events, PongPorts>,
                "id"
              > = {
                eventClass: "oneway",
                type: Events.EXTERN,
                port: PongPorts.TO_PING,
                param: {
                  counter: receivedCounter - 1,
                },
              };
              raiseEvent(sendCounterEvent);
            }
            return myState;
          },
          event: ["oneway", Events.INTERN],
        },
      ],
    };

    const FROM_PONG = createPort(
      PingPorts.FROM_PONG,
      Object.values(Events),
      "in"
    );
    const TO_PONG = createPort(PingPorts.TO_PONG, Object.values(Events), "out");

    const ping_comp: AtomicComponent<Events, PingPorts> =
      createStatemachineComponent([FROM_PONG, TO_PONG], ping_sm, "ping_comp");

    const FROM_PING = createPort(
      PongPorts.FROM_PING,
      Object.values(Events),
      "in"
    );
    const TO_PING = createPort(PongPorts.TO_PING, Object.values(Events), "out");

    const pong_comp: AtomicComponent<Events, PongPorts> =
      createStatemachineComponent([FROM_PING, TO_PING], pong_sm, "pong_comp");

    const ping_state = {
      state: { fsm: PingStates.PING, my: 20 },
      events: [
        {
          eventClass: "oneway",
          type: Events.EXTERN,
          param: {
            counter: 20,
          },
          port: PingPorts.FROM_PONG,
        } as PingPongEvent<Events, PingPorts>,
      ],
      tsType: "State",
    };

    const pong_state = {
      state: { fsm: PongStates.PONG, my: 20 },
      events: [],
      tsType: "State",
    };

    const confState = {
      componentState: new Map([
        [ping_comp, ping_state] as [
          AtomicComponent<any, any>,
          AbstractState<any, any, any>
        ],
        [pong_comp, pong_state] as [
          AtomicComponent<any, any>,
          AbstractState<any, any, any>
        ],
      ]),
    };

    const lsa: Configuration = {
      components: [ping_comp, pong_comp],
      connections: [
        createConnection(
          ping_comp,
          PingPorts.TO_PONG,
          pong_comp,
          PongPorts.FROM_PING
        ),
        createConnection(
          pong_comp,
          PongPorts.TO_PING,
          ping_comp,
          PingPorts.FROM_PONG
        ),
      ],
    };

    const deploymentConfiguration: DeploymentConfiguration = {
      ping: {
        components: [ping_comp],
      },
      pong: {
        components: [pong_comp],
      },
    };

    const hostConfig: HostConfiguration = {
      ping: {
        host: "localhost",
        port: 1234,
      },
      pong: {
        host: "localhost",
        port: 1235,
      },
    };

    const communicationConfiguration: CommunicationConfiguration = {
      // empty as not needed for test
      connectionTechs: [
        {
          sourceContainer: "ping",
          sourceComponent: ping_comp,
          sourcePort: TO_PONG,
          targetContainer: "pong",
          targetComponent: pong_comp,
          targetPort: FROM_PING,
          commOption: CommOption.REST,
        },
        {
          sourceContainer: "pong",
          sourceComponent: pong_comp,
          sourcePort: TO_PING,
          targetContainer: "ping",
          targetComponent: ping_comp,
          targetPort: FROM_PONG,
          commOption: CommOption.REST,
        },
      ],
    };

    let runConfigPing: RunConfiguration = {
      lsa: lsa,
      toExecute: "ping",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfiguration,
      hostConfiguration: hostConfig,
      confState: confState,
      shutdownFunctions: [],
      clockStates: _.reduce(
        deploymentConfiguration["ping"].components,
        (map, comp) => {
          map.set(comp, INIT_SEQUENCER_CLOCK_STATE);
          return map;
        },
        new Map()
      ),
      engineRoomState: {
        shadowMap: new Map(),
      },
    };

    let runConfigPong: RunConfiguration = {
      lsa: lsa,
      toExecute: "pong",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfiguration,
      hostConfiguration: hostConfig,
      confState: confState,
      shutdownFunctions: [],
      clockStates: _.reduce(
        deploymentConfiguration["pong"].components,
        (map, comp) => {
          map.set(comp, INIT_SEQUENCER_CLOCK_STATE);
          return map;
        },
        new Map()
      ),
      engineRoomState: {
        shadowMap: new Map(),
      },
    };

    const pingPongDecoder: DecodeEventFunction = (
      payload: Readonly<Record<string, unknown>>,
      partialEvent: Event<unknown, unknown>
    ) => {
      return {
        ...partialEvent,
        param: {
          counter: payload["counter"] as number,
        },
      };
    };

    runConfigPong = setDecoder(runConfigPong, Events.EXTERN, pingPongDecoder);
    runConfigPing = setDecoder(runConfigPing, Events.EXTERN, pingPongDecoder);

    executeRunConfiguration(runConfigPong);
    executeRunConfiguration(runConfigPing);

    await new Promise<void>((resolve) => {
      function checkCompletion() {
        const pingComponent =
          computeLocallyDeployedConfiguration(runConfigPing);
        const pongComponent =
          computeLocallyDeployedConfiguration(runConfigPong);

        const pingCounter = Array.from(
          runConfigPing.confState.componentState.entries()
        )
          .filter((entry) => {
            const [comp, abState] = entry;
            return pingComponent.components.includes(comp);
          })
          .map((entry) => {
            const [comp, abstractState] = entry;
            return abstractState.state.my as number;
          })
          .reduce((sum, currentCounter) => sum + currentCounter, 0);

        console.log(`Ping Counter: ${pingCounter}`);

        const pongCounter = Array.from(
          runConfigPong.confState.componentState.entries()
        )
          .filter((entry) => {
            const [comp, abState] = entry;
            return pongComponent.components.includes(comp);
          })
          .map((entry) => {
            const [comp, abstractState] = entry;
            return abstractState.state.my as number;
          })
          .reduce((sum, currentCounter) => sum + currentCounter, 0);
        console.log(`Pong Counter: ${pongCounter}`);

        if (pingCounter === 0 && pongCounter === 1) {
          expect(pingCounter).toBe(0);
          expect(pongCounter).toBe(1);
          expect(
            runConfigPing.clockStates.get(ping_comp)?.myLocalClock.seq === 42
          );
          expect(
            runConfigPong.clockStates.get(pong_comp)?.myLocalClock.seq === 42
          );
          resolve();
        } else {
          setTimeout(checkCompletion, 1000);
        }
      }
      checkCompletion();
    }).then(() => {
      unitTests.shutdownRunConfiguration(runConfigPing);
      unitTests.shutdownRunConfiguration(runConfigPong);
    });
  });
});

describe("R-PM.3a_3b: multiple 1-1 connections", () => {
  type StateType = AbstractState<number, Events, Ports, undefined>;

  enum Events {
    X = "X",
  }

  enum Ports {
    OUT = "OUT",
    IN = "IN",
  }

  const comp_1: AtomicComponent<Events, Ports> = {
    name: "comp_1",
    id: "comp_1",
    ports: [createPort(Ports.OUT, [Events.X], "out")],
    step: (current: StateType) => {
      return Nothing;
    },
    allSteps: (current: StateType) => {
      return [{ ...current }];
    },
    tsType: "Component",
  };

  const comp_2 = {
    ...comp_1,
    name: "comp_2",
    id: "comp_2",
    ports: [
      createPort(Ports.IN, [Events.X], "in"),
      createPort(Ports.OUT, [Events.X], "out"),
    ],
  };
  const comp_3 = { ...comp_2, name: "comp_3", id: "comp_3" };
  const comp_4 = {
    ...comp_1,
    name: "comp_4",
    id: "comp_4",
    ports: [createPort(Ports.IN, [Events.X], "in")],
  };

  // create a diamond configuration comp_1 --> (comp_2 and comp_3) --> comp_4
  const configuration: Configuration = {
    components: [comp_1, comp_2, comp_3, comp_4],
    connections: [
      createConnection(comp_1, Ports.OUT, comp_2, Ports.IN),
      createConnection(comp_1, Ports.OUT, comp_3, Ports.IN),
      createConnection(comp_2, Ports.OUT, comp_4, Ports.IN),
      createConnection(comp_3, Ports.OUT, comp_4, Ports.IN),
    ],
  };

  test("R-PM.3a_3b: multiple 1-1 incoming connections", () => {
    const state_1: AbstractState<number, Events, Ports> = {
      state: 0,
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: Ports.OUT },
      ],
      tsType: "State",
    };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, state_1],
        [comp_2, { ...state_1, events: [] }],
        [comp_3, { ...state_1, events: [] }],
        [comp_4, { ...state_1, events: [] }],
      ]),
    };

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.events).toHaveLength(0);
    expect(confState.componentState.get(comp_2)?.events).toHaveLength(1);
    expect(
      confState.componentState.get(comp_2)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);
    expect(confState.componentState.get(comp_3)?.events).toHaveLength(1);
    expect(
      confState.componentState.get(comp_3)?.events.map(removeIdAndEventClass)
    ).toEqual([{ type: Events.X, port: Ports.IN }]);
    expect(confState.componentState.get(comp_4)?.events).toHaveLength(0);
  });

  test("R-PM.3a_3b: multiple 1-1 outgoing connections", () => {
    const state_2: AbstractState<number, Events, Ports> = {
      state: 0,
      events: [
        { eventClass: "oneway", id: uuidv4(), type: Events.X, port: Ports.OUT },
      ],
      tsType: "State",
    };

    let confState: ConfigurationState = {
      componentState: new Map([
        [comp_1, { ...state_2, events: [] }],
        [comp_2, state_2],
        [comp_3, { ...state_2 }],
        [comp_4, { ...state_2, events: [] }],
      ]),
    };

    confState = configurationStep(configuration, confState, false);
    expect(confState.componentState.get(comp_1)?.events).toHaveLength(0);
    expect(confState.componentState.get(comp_2)?.events).toHaveLength(0);
    expect(confState.componentState.get(comp_3)?.events).toHaveLength(0);
    expect(confState.componentState.get(comp_4)?.events).toHaveLength(2);
    expect(
      confState.componentState.get(comp_4)?.events.map(removeIdAndEventClass)
    ).toEqual([
      { type: Events.X, port: Ports.IN },
      { type: Events.X, port: Ports.IN },
    ]);
  });

  describe("R-PM.3a_3b: multiple 1-1 outgoing connections via REST", () => {
    const confStateGenerator: () => ConfigurationState = () => {
      return {
        componentState: new Map([
          [
            comp_1,
            {
              state: 0,
              events: [
                {
                  eventClass: "oneway",
                  id: uuidv4(),
                  type: Events.X,
                  port: Ports.OUT,
                },
              ],
              tsType: "State",
            },
          ],
          [comp_2, { state: 0, events: [], tsType: "State" }],
          [comp_3, { state: 0, events: [], tsType: "State" }],
        ]),
      };
    };

    const deploymentConfiguration: DeploymentConfiguration = {
      u1: {
        components: [comp_1],
      },
      u2: {
        components: [comp_2],
      },
      u3: {
        components: [comp_3],
      },
    };

    const hostConfig: HostConfiguration = {
      u1: {
        host: "localhost",
        port: 1244,
      },
      u2: {
        host: "localhost",
        port: 1245,
      },
      u3: {
        host: "localhost",
        port: 1246,
      },
    };

    const communicationConfiguration: CommunicationConfiguration = {
      connectionTechs: [
        {
          sourceContainer: "u1",
          sourceComponent: comp_1,
          sourcePort: Ports.OUT,
          targetContainer: "u2",
          targetComponent: comp_2,
          targetPort: Ports.IN,
          commOption: CommOption.REST,
        },
        {
          sourceContainer: "u1",
          sourceComponent: comp_1,
          sourcePort: Ports.OUT,
          targetContainer: "u3",
          targetComponent: comp_3,
          targetPort: Ports.IN,
          commOption: CommOption.REST,
        },
      ],
    };

    const sampleRunConfig: RunConfiguration = {
      lsa: configuration,
      toExecute: "u1",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfiguration,
      hostConfiguration: hostConfig,
      confState: confStateGenerator(),
      shutdownFunctions: [],
      clockStates: new Map(),
      engineRoomState: {
        shadowMap: new Map(),
      },
    };

    const cloneRunConfig = (
      runConfig: RunConfiguration,
      toExecute: string
    ): RunConfiguration => {
      return {
        ...runConfig,
        deploymentConfiguration: _.mapValues(deploymentConfiguration, (u) => {
          return {
            components: [...u.components],
          };
        }),
        confState: confStateGenerator(),
        toExecute: toExecute,
        shutdownFunctions: [],
        clockStates: new Map(),
        engineRoomState: {
          shadowMap: new Map(),
        },
      };
    };

    test("communicate via Rest", async () => {
      const runConfigU1 = cloneRunConfig(sampleRunConfig, "u1");
      const runConfigU2 = cloneRunConfig(sampleRunConfig, "u2");
      const runConfigU3 = cloneRunConfig(sampleRunConfig, "u3");

      await executeRunConfiguration(runConfigU1);
      await executeRunConfiguration(runConfigU2);
      await executeRunConfiguration(runConfigU3);

      await new Promise<void>((resolve) => {
        function checkCompletion() {
          const c1Event =
            runConfigU1.confState.componentState.get(comp_1)?.events.length;
          const c2Event =
            runConfigU2.confState.componentState.get(comp_2)?.events.length;
          const c3Event =
            runConfigU3.confState.componentState.get(comp_3)?.events.length;

          //console.log("\x1b[33m%s\x1b[0m", `${c1Event}/${c2Event}/${c3Event}`);

          if (c1Event === 0 && c2Event === 1 && c3Event === 1) {
            expect(
              runConfigU2.confState.componentState
                .get(comp_2)
                ?.events.map(removeSystemParameters)
            ).toEqual([{ type: Events.X, port: Ports.IN }]);
            expect(
              runConfigU3.confState.componentState
                .get(comp_3)
                ?.events.map(removeSystemParameters)
            ).toEqual([{ type: Events.X, port: Ports.IN }]);
            resolve();
          } else {
            setTimeout(checkCompletion, 1000);
          }
        }
        //console.log("\x1b[33m%s\x1b[0m", "start waiting");

        setTimeout(checkCompletion, 1000);
      }).then(() => {
        unitTests.shutdownRunConfiguration(runConfigU1);
        unitTests.shutdownRunConfiguration(runConfigU2);
        unitTests.shutdownRunConfiguration(runConfigU3);
      });
    });

    test("communicate via Rest with encryption enabled", async () => {
      const securityConfiguration: SecurityConfiguration = {
        ssl: false,
        privateKey: "",
        certificate: "",
        passphrase: "",
        communicationSecret: [
          {
            from: "u1",
            to: "u2",
            secret: "abcdefgh",
          },
          {
            from: "u1",
            to: "u3",
            secret: "abcdefghijk",
          },
        ],
      };

      const runConfigU1 = cloneRunConfig(sampleRunConfig, "u1");
      runConfigU1.securityConfiguration = securityConfiguration;
      const runConfigU2 = cloneRunConfig(sampleRunConfig, "u2");
      runConfigU2.securityConfiguration = securityConfiguration;
      const runConfigU3 = cloneRunConfig(sampleRunConfig, "u3");
      runConfigU3.securityConfiguration = securityConfiguration;

      await executeRunConfiguration(runConfigU1);
      await executeRunConfiguration(runConfigU2);
      await executeRunConfiguration(runConfigU3);

      await new Promise<void>((resolve) => {
        function checkCompletion() {
          const c1Event =
            runConfigU1.confState.componentState.get(comp_1)?.events.length;
          const c2Event =
            runConfigU2.confState.componentState.get(comp_2)?.events.length;
          const c3Event =
            runConfigU3.confState.componentState.get(comp_3)?.events.length;

          //console.log("\x1b[33m%s\x1b[0m", `${c1Event}/${c2Event}/${c3Event}`);

          if (c1Event === 0 && c2Event === 1 && c3Event === 1) {
            expect(
              runConfigU2.confState.componentState
                .get(comp_2)
                ?.events.map(removeSystemParameters)
            ).toEqual([{ type: Events.X, port: Ports.IN }]);
            expect(
              runConfigU3.confState.componentState
                .get(comp_3)
                ?.events.map(removeSystemParameters)
            ).toEqual([{ type: Events.X, port: Ports.IN }]);
            resolve();
          } else {
            setTimeout(checkCompletion, 1000);
          }
        }
        //console.log("\x1b[33m%s\x1b[0m", "start waiting");

        setTimeout(checkCompletion, 1000);
      }).then(() => {
        unitTests.shutdownRunConfiguration(runConfigU1);
        unitTests.shutdownRunConfiguration(runConfigU2);
        unitTests.shutdownRunConfiguration(runConfigU3);
      });
    });

    const restrictConfigStateToExecutedUnit = (runConfig: RunConfiguration) => {
      for (const comp of runConfig.confState.componentState.keys()) {
        if (
          !runConfig.deploymentConfiguration[
            runConfig.toExecute
          ].components.includes(comp)
        )
          runConfig.confState.componentState.delete(comp);
      }
    };

    const sampleDebuggingConfiguration: DebuggingConfiguration = {
      u1: {
        debuggingAgent: {
          enabled: true,
          isServer: true,
          commOptions: [CommOption.REST],
          checkForChangesIntervalMs: 1000,
          webSocketPort: 3001,
        },
      },
      u2: {
        debuggingAgent: {
          enabled: true,
          isServer: false,
          commOptions: [CommOption.REST],
          checkForChangesIntervalMs: 1000,
        },
      },
      u3: {
        debuggingAgent: {
          enabled: true,
          isServer: false,
          commOptions: [CommOption.REST],
          checkForChangesIntervalMs: 1000,
        },
      },
    };

    const setupDebuggingAgentRunConfig = (
      unit: string,
      debuggingConfig: DebuggingConfiguration = sampleDebuggingConfiguration,
      baseRunConfig: RunConfiguration = sampleRunConfig
    ) => {
      let runConfig = cloneRunConfig(baseRunConfig, unit);
      restrictConfigStateToExecutedUnit(runConfig);
      (runConfig as any).debuggingConfiguration = debuggingConfig;
      runConfig = setupAgents(runConfig);
      Object.entries(runConfig.shadowModeConfiguration ?? []).forEach(
        ([unit, value]) => {
          (<any>value).inMessageSharing.enabled = false;
        }
      );
      return runConfig;
    };

    test("debugging agent communication", async () => {
      const dbgRunConfigU1 = setupDebuggingAgentRunConfig("u1");
      const dbgRunConfigU2 = setupDebuggingAgentRunConfig("u2");
      const dbgRunConfigU3 = setupDebuggingAgentRunConfig("u3");

      // remove event out of component comp_1 as it is put into the event queue by the debugging server via websocket
      const eventQueue =
        dbgRunConfigU1.confState.componentState.get(comp_1)?.events;
      if (eventQueue) {
        eventQueue.length = 0;
      }

      // shadow agents are not needed
      dbgRunConfigU1.engineRoomState.shadowAgentEnabled = false;
      dbgRunConfigU2.engineRoomState.shadowAgentEnabled = false;
      dbgRunConfigU3.engineRoomState.shadowAgentEnabled = false;

      // start websocket client
      const ws = new WebSocket(
        `ws://${dbgRunConfigU1.hostConfiguration.u1.host}:${sampleDebuggingConfiguration.u1.debuggingAgent.webSocketPort}`
      );

      let properComponentStateReceived = false;
      const ajv = new Ajv(); // options can be passed, e.g. {allErrors: true}
      const validator = ajv.compile(
        DebuggingAgentWebSocketConfigurationStateJSONSchema
      );

      await executeRunConfiguration(dbgRunConfigU1);
      await executeRunConfiguration(dbgRunConfigU2);
      await executeRunConfiguration(dbgRunConfigU3);

      ws.on("open", function open() {
        const msg: DebuggingAgentWebSocketInjectMessage = {
          ts_type: "EnqueueEventMessage",
          unit: "u1",
          component: "comp_1",
          port: Ports.OUT,
          event: { type: Events.X, eventClass: "oneway" },
          sequenceNumber: 0,
        };
        const json = JSON.stringify(msg);
        //console.log('"\x1b[33mmessage: %s\x1b[0m",', json);
        ws.send(json);
        //console.log('"\x1b[33mmessage: %s\x1b[0m",', json);
        ws.send(
          JSON.stringify({
            ...msg,
            unit: "u3",
            component: "comp_3",
            port: Ports.IN,
          })
        );
      });

      ws.on("message", function message(data) {
        //console.log('"\x1b[33mmessage: %s\x1b[0m",', data);
        try {
          const obj = JSON.parse(data.toLocaleString());
          const valid = validator(obj);
          // console.log('"\x1b[33mvalidator: %s\x1b[0m",', valid);
          // validator.errors?.forEach((err) =>
          //   console.log('"\x1b[33merror: %s\x1b[0m"', err.message)
          // );
          const confState: DebuggingAgentWebSocketConfigurationState = obj;

          expect(confState.units).toEqual(["u1", "u2", "u3"]);
          expect(
            confState.components.filter((c) => c.name === "comp_1")[0].unit
          ).toEqual("u1");
          expect(
            confState.components.filter((c) => c.name === "comp_2")[0].unit
          ).toEqual("u2");
          expect(
            confState.components.filter((c) => c.name === "comp_3")[0].unit
          ).toEqual("u3");
          console.log(
            '"\x1b[33mconfState.components: %s\x1b[0m"',
            JSON.stringify(confState.components[1].ports)
          );
          expect(
            confState.components.filter((c) => c.name === "comp_1")[0].ports
          ).toEqual([{ name: "OUT", eventTypes: ["X"] }]);
          expect(
            confState.components.filter((c) => c.name === "comp_2")[0].ports
          ).toEqual([
            { name: "IN", eventTypes: ["X"] },
            { name: "OUT", eventTypes: ["X"] },
          ]);
          expect(
            confState.components.filter((c) => c.name === "comp_3")[0].ports
          ).toEqual([
            { name: "IN", eventTypes: ["X"] },
            { name: "OUT", eventTypes: ["X"] },
          ]);

          properComponentStateReceived =
            valid &&
            confState.components.length === 3 &&
            confState.components.filter((c) => c.name === "comp_1")[0].events
              .length === 0 &&
            confState.components.filter((c) => c.name === "comp_2")[0].events
              .length === 1 &&
            confState.components.filter((c) => c.name === "comp_3")[0].events
              .length === 2;
        } catch (ex) {
          // data could not be parsed to JSON
          properComponentStateReceived = false;
        }
      });

      await new Promise<void>((resolve) => {
        function checkCompletion() {
          const c1Event =
            dbgRunConfigU1.confState.componentState.get(comp_1)?.events.length;
          const c2Event =
            dbgRunConfigU2.confState.componentState.get(comp_2)?.events.length;
          const c3Event =
            dbgRunConfigU3.confState.componentState.get(comp_3)?.events.length;

          const debuggingAgentU1 =
            getDebuggingAgentAndConnections(dbgRunConfigU1)!.debuggingAgent;
          const debuggingAgentU2 =
            getDebuggingAgentAndConnections(dbgRunConfigU2)!.debuggingAgent;
          const debuggingAgentU3 =
            getDebuggingAgentAndConnections(dbgRunConfigU3)!.debuggingAgent;

          const dbgServerStateU1 =
            dbgRunConfigU1.confState.componentState.get(debuggingAgentU1)!.state
              .my.componentStates;
          const dbgServerStateU2 =
            dbgRunConfigU2.confState.componentState.get(debuggingAgentU2)!.state
              .my.componentStates;
          const dbgServerStateU3 =
            dbgRunConfigU3.confState.componentState.get(debuggingAgentU3)!.state
              .my.componentStates;
          expect(dbgServerStateU1).toBeDefined();
          expect(dbgServerStateU2).toBeDefined();
          expect(dbgServerStateU3).toBeDefined();

          // console.log(
          //   "\x1b[33mU1: %s\x1b[0m",
          //   `${JSON.stringify(dbgServerStateU1)}`
          // );
          // console.log(
          //   "\x1b[33mU2: %s\x1b[0m",
          //   `${JSON.stringify(dbgServerStateU2)}`
          // );
          // console.log(
          //   "\x1b[33mU3: %s\x1b[0m",
          //   `${JSON.stringify(dbgServerStateU3)}`
          // );

          const correctState =
            dbgServerStateU1.comp_1?.state === 0 &&
            dbgServerStateU1.comp_2?.state === 0 &&
            dbgServerStateU1.comp_3?.state === 0 &&
            dbgServerStateU1.comp_1?.events?.length === 0 &&
            dbgServerStateU1.comp_2?.events?.length === 1 &&
            dbgServerStateU1.comp_2?.events[0]?.type === "X" &&
            dbgServerStateU1.comp_3?.events?.length === 2 &&
            dbgServerStateU1.comp_3?.events[0]?.type === "X";
          if (correctState && properComponentStateReceived) {
            expect(
              dbgServerStateU1.comp_2.events.map(removeSystemParameters)
            ).toEqual([{ type: Events.X, port: Ports.IN }]);
            expect(
              dbgServerStateU1.comp_3.events.map(removeSystemParameters)
            ).toEqual([
              { type: Events.X, port: Ports.IN },
              { type: Events.X, port: Ports.IN },
            ]);
            resolve();
          } else {
            setTimeout(checkCompletion, 1000);
          }
        }
        //console.log("\x1b[33m%s\x1b[0m", "start waiting");

        setTimeout(checkCompletion, 1000);
      }).then(() => {
        unitTests.shutdownRunConfiguration(dbgRunConfigU1);
        unitTests.shutdownRunConfiguration(dbgRunConfigU2);
        unitTests.shutdownRunConfiguration(dbgRunConfigU3);
        ws.close();
      });
    });

    test("debugging agent send external message", async () => {
      const dbgRunConfigU1 = setupDebuggingAgentRunConfig("u1");
      const dbgRunConfigU2 = setupDebuggingAgentRunConfig("u2");

      // remove event out of component comp_1 as it is to be sent by the debugging server manually
      const eventQueue =
        dbgRunConfigU1.confState.componentState.get(comp_1)?.events;
      if (eventQueue) {
        eventQueue.length = 0;
      }

      // shadow agents are not needed
      dbgRunConfigU1.engineRoomState.shadowAgentEnabled = false;
      dbgRunConfigU2.engineRoomState.shadowAgentEnabled = false;

      // start websocket client
      const ws = new WebSocket(
        `ws://${dbgRunConfigU1.hostConfiguration.u1.host}:${sampleDebuggingConfiguration.u1.debuggingAgent.webSocketPort}`
      );

      await executeRunConfiguration(dbgRunConfigU1);
      await executeRunConfiguration(dbgRunConfigU2);

      ws.on("open", function open() {
        const msg: DebuggingAgentWebSocketInjectMessage = {
          ts_type: "SendExternalMessage",
          unit: "u1",
          targetComponent: "comp_2",
          targetPort: Ports.IN,
          targetUnit: "u2",
          data: encodeEvent(
            { type: Events.X, eventClass: "oneway", id: "42" },
            comp_1,
            0,
            1
          ),
          sequenceNumber: 0,
        };
        const json = JSON.stringify(msg);
        ws.send(json);
      });

      await new Promise<void>((resolve) => {
        function checkCompletion() {
          const c2state = dbgRunConfigU2.confState.componentState.get(comp_2);

          const correctState =
            c2state?.state === 0 &&
            c2state?.events?.length === 1 &&
            c2state?.events[0]?.type === "X";
          if (correctState) {
            resolve();
          } else {
            setTimeout(checkCompletion, 1000);
          }
        }
        //console.log("\x1b[33m%s\x1b[0m", "start waiting");

        setTimeout(checkCompletion, 1000);
      }).then(() => {
        unitTests.shutdownRunConfiguration(dbgRunConfigU1);
        unitTests.shutdownRunConfiguration(dbgRunConfigU2);
        ws.close();
      });
    });

    test("debugging agent heartbeat", async () => {
      const dbgRunConfigU1 = setupDebuggingAgentRunConfig("u1");
      const dbgRunConfigU2 = setupDebuggingAgentRunConfig("u2");
      const dbgRunConfigU3 = setupDebuggingAgentRunConfig("u3");

      // remove event out of component comp_1 as it is put into the event queue by the debugging server via websocket
      const eventQueue =
        dbgRunConfigU1.confState.componentState.get(comp_1)?.events;
      if (eventQueue) {
        eventQueue.length = 0;
      }

      // check that shadow agents have been configured
      expect(
        dbgRunConfigU1.shadowModeConfiguration?.["u1"].shadowAgent.enabled
      ).toBe(true);
      expect(
        dbgRunConfigU1.shadowModeConfiguration?.["u2"].shadowAgent.enabled
      ).toBe(true);
      expect(
        dbgRunConfigU1.shadowModeConfiguration?.["u3"].shadowAgent.enabled
      ).toBe(true);
      expect(
        dbgRunConfigU2.shadowModeConfiguration?.["u2"].shadowAgent.enabled
      ).toBe(true);
      expect(
        dbgRunConfigU3.shadowModeConfiguration?.["u3"].shadowAgent.enabled
      ).toBe(true);

      const ws = new WebSocket(
        `ws://${dbgRunConfigU1.hostConfiguration.u1.host}:${sampleDebuggingConfiguration.u1.debuggingAgent.webSocketPort}`
      );

      let properComponentStateReceived = false;
      const ajv = new Ajv(); // options can be passed, e.g. {allErrors: true}
      const validator = ajv.compile(
        DebuggingAgentWebSocketConfigurationStateJSONSchema
      );

      await executeRunConfiguration(dbgRunConfigU1);

      let operatingModeC1: DefaultShadowMode | undefined;
      let operatingModeC2: DefaultShadowMode | undefined;
      let operatingModeC3: DefaultShadowMode | undefined;

      ws.on("message", function message(data) {
        //console.log('"\x1b[33mmessage: %s\x1b[0m",', data);
        try {
          const obj = JSON.parse(data.toLocaleString());
          const valid = validator(obj);
          const confState: DebuggingAgentWebSocketConfigurationState = obj;

          operatingModeC1 = _.find(
            confState.components,
            (c) => c.name === comp_1.name
          )?.operatingMode;
          operatingModeC2 = _.find(
            confState.components,
            (c) => c.name === comp_2.name
          )?.operatingMode;
          operatingModeC3 = _.find(
            confState.components,
            (c) => c.name === comp_3.name
          )?.operatingMode;
        } catch (ex) {
          // data could not be parsed to JSON
          properComponentStateReceived = false;
        }
      });

      await new Promise<void>((resolve) => {
        async function check1() {
          if (operatingModeC1 === DefaultShadowMode.OK) {
            expect(operatingModeC2).toBe(DefaultShadowMode.UNREACHABLE);
            expect(operatingModeC3).toBe(DefaultShadowMode.UNREACHABLE);

            await executeRunConfiguration(dbgRunConfigU2);
            await executeRunConfiguration(dbgRunConfigU3);
            setTimeout(check2, 100);
          } else {
            setTimeout(check1, 100);
          }
        }
        async function check2() {
          if (
            operatingModeC2 === DefaultShadowMode.OK &&
            operatingModeC3 === DefaultShadowMode.OK
          ) {
            unitTests.shutdownRunConfiguration(dbgRunConfigU2);
            setTimeout(check3, 500);
          } else {
            setTimeout(check2, 100);
          }
        }
        function check3() {
          if (operatingModeC2 === DefaultShadowMode.UNREACHABLE) {
            expect(operatingModeC1).toBe(DefaultShadowMode.OK);
            expect(operatingModeC3).toBe(DefaultShadowMode.OK);
            resolve();
          } else {
            setTimeout(check3, 500);
          }
        }
        setTimeout(check1, 100);
      }).then(() => {
        unitTests.shutdownRunConfiguration(dbgRunConfigU1);
        unitTests.shutdownRunConfiguration(dbgRunConfigU2);
        unitTests.shutdownRunConfiguration(dbgRunConfigU3);
        ws.close();
      });
    });

    test("debugging agent fail unit", async () => {
      const dbgRunConfigU1 = setupDebuggingAgentRunConfig("u1");
      const dbgRunConfigU2 = setupDebuggingAgentRunConfig("u2");
      const dbgRunConfigU3 = setupDebuggingAgentRunConfig("u3");

      // start websocket client
      const ws = new WebSocket(
        `ws://${dbgRunConfigU1.hostConfiguration.u1.host}:${sampleDebuggingConfiguration.u1.debuggingAgent.webSocketPort}`
      );

      // mock the process.exit function, otherwise jest will hang
      let exitHasBeenCalledWithErrorCode: number | undefined;
      const mockExit = jest
        .spyOn(process, "exit")
        .mockImplementation((errorCode) => {
          exitHasBeenCalledWithErrorCode = errorCode;
          return undefined as never;
        });

      // shadow agents are not needed
      dbgRunConfigU1.engineRoomState.shadowAgentEnabled = false;
      dbgRunConfigU2.engineRoomState.shadowAgentEnabled = false;
      dbgRunConfigU3.engineRoomState.shadowAgentEnabled = false;

      await executeRunConfiguration(dbgRunConfigU1);
      await executeRunConfiguration(dbgRunConfigU2);
      await executeRunConfiguration(dbgRunConfigU3);

      ws.on("open", function open() {
        const msg: DebuggingAgentWebSocketInjectMessage = {
          ts_type: "FailUnitMessage",
          unit: "u1",
          sequenceNumber: 0,
        };
        const json = JSON.stringify(msg);
        //console.log('"\x1b[33mmessage: %s\x1b[0m",', json);
        ws.send(json);
      });

      await new Promise<void>((resolve) => {
        function checkCompletion() {
          if (exitHasBeenCalledWithErrorCode !== undefined) {
            expect(mockExit).toHaveBeenCalledWith(1);
            resolve();
          } else {
            setTimeout(checkCompletion, 1000);
          }
        }
        setTimeout(checkCompletion, 1000);
      }).then(() => {
        unitTests.shutdownRunConfiguration(dbgRunConfigU1);
        unitTests.shutdownRunConfiguration(dbgRunConfigU2);
        unitTests.shutdownRunConfiguration(dbgRunConfigU3);
        ws.close();
        // restore the mocked process.exit function
        mockExit.mockRestore();
      });
    });

    test("debugging agent modify abstract state", async () => {
      const debuggingConfiguration: DebuggingConfiguration = {
        u2: {
          debuggingAgent: {
            enabled: true,
            isServer: true,
            commOptions: [CommOption.REST],
            checkForChangesIntervalMs: 1000,
            webSocketPort: 3001,
          },
        },
        u3: {
          debuggingAgent: {
            enabled: true,
            isServer: false,
            commOptions: [CommOption.REST],
            checkForChangesIntervalMs: 1000,
          },
        },
      };

      const dbgRunConfigU2 = setupDebuggingAgentRunConfig(
        "u2",
        debuggingConfiguration
      );
      const dbgRunConfigU3 = setupDebuggingAgentRunConfig(
        "u3",
        debuggingConfiguration
      );

      // shadow agents are not needed
      dbgRunConfigU2.engineRoomState.shadowAgentEnabled = false;
      dbgRunConfigU3.engineRoomState.shadowAgentEnabled = false;

      // start websocket client
      const ws = new WebSocket(
        `ws://${dbgRunConfigU2.hostConfiguration.u2.host}:${debuggingConfiguration.u2.debuggingAgent.webSocketPort}`
      );

      // mock the process.exit function, otherwise jest will hang
      let exitHasBeenCalledWithErrorCode: number | undefined;
      const mockExit = jest
        .spyOn(process, "exit")
        .mockImplementation((errorCode) => {
          exitHasBeenCalledWithErrorCode = errorCode;
          return undefined as never;
        });

      // alter state of comp_3 to test paths
      const c3state = dbgRunConfigU3.confState.componentState.get(comp_3);
      expect(c3state?.state).toBe(0);
      (<any>c3state).state = { a: { b: { c: 0 } } };

      await executeRunConfiguration(dbgRunConfigU2);
      await executeRunConfiguration(dbgRunConfigU3);

      expect(dbgRunConfigU2.confState.componentState.get(comp_2)?.state).toBe(
        0
      );
      expect(
        dbgRunConfigU3.confState.componentState.get(comp_3)?.state
      ).toEqual({ a: { b: { c: 0 } } });

      ws.on("open", function open() {
        const msg: DebuggingAgentWebSocketInjectMessage = {
          ts_type: "ModifyAbstractStateMessage",
          unit: "u2",
          component: "comp_2",
          path: undefined,
          value: 42,
          sequenceNumber: 0,
        };
        const json = JSON.stringify(msg);
        ws.send(json);

        const msg2: DebuggingAgentWebSocketInjectMessage = {
          ts_type: "ModifyAbstractStateMessage",
          unit: "u3",
          component: "comp_3",
          path: "a/b/c",
          value: 42,
          sequenceNumber: 0,
        };
        ws.send(JSON.stringify(msg2));
      });

      await new Promise<void>((resolve) => {
        function checkCompletion() {
          if (
            dbgRunConfigU3.confState.componentState.get(comp_3)?.state?.a?.b
              ?.c === 42
          ) {
            expect(
              dbgRunConfigU2.confState.componentState.get(comp_2)?.state
            ).toBe(42);
            resolve();
          } else {
            setTimeout(checkCompletion, 1000);
          }
        }
        setTimeout(checkCompletion, 1000);
      }).then(() => {
        unitTests.shutdownRunConfiguration(dbgRunConfigU2);
        unitTests.shutdownRunConfiguration(dbgRunConfigU3);
        ws.close();
      });
    });

    test("debugging agent disconnect unit", async () => {
      const dbgRunConfigU1 = setupDebuggingAgentRunConfig("u1");
      const dbgRunConfigU2 = setupDebuggingAgentRunConfig("u2");
      const dbgRunConfigU3 = setupDebuggingAgentRunConfig("u3");

      // remove event out of component comp_1 as it is put into the event queue by the debugging server via websocket
      const eventQueue =
        dbgRunConfigU1.confState.componentState.get(comp_1)?.events;
      if (eventQueue) {
        eventQueue.length = 0;
      }

      // shadow agents are not needed
      dbgRunConfigU1.engineRoomState.shadowAgentEnabled = false;
      dbgRunConfigU2.engineRoomState.shadowAgentEnabled = false;
      dbgRunConfigU3.engineRoomState.shadowAgentEnabled = false;

      // start websocket client
      const ws = new WebSocket(
        `ws://${dbgRunConfigU1.hostConfiguration.u1.host}:${sampleDebuggingConfiguration.u1.debuggingAgent.webSocketPort}`
      );

      // mock the process.exit function, otherwise jest will hang
      let exitHasBeenCalledWithErrorCode: number | undefined;
      const mockExit = jest
        .spyOn(process, "exit")
        .mockImplementation((errorCode) => {
          exitHasBeenCalledWithErrorCode = errorCode;
          return undefined as never;
        });

      // mock the onCommError function the see if the expected
      // comm error occurs on the given
      let lastCommError:
        | undefined
        | { targetComponent: string; targetContainer: string } = undefined;
      const mockOnCommError = jest
        .spyOn(commUtil, "onCommError")
        .mockImplementation(
          (runConfig, sourceComponent, targetComponent, container) => {
            lastCommError = {
              targetComponent: targetComponent.name,
              targetContainer: container,
            };
          }
        );

      await executeRunConfiguration(dbgRunConfigU1);
      await executeRunConfiguration(dbgRunConfigU2);
      await executeRunConfiguration(dbgRunConfigU3);

      ws.on("open", function open() {
        // send disconnect unit message to unit 2
        const msg: DebuggingAgentWebSocketInjectMessage = {
          ts_type: "DisconnectUnitMessage",
          unit: "u2",
          sequenceNumber: 0,
        };
        const json = JSON.stringify(msg);
        ws.send(json);

        // inject event to comp_1 and comp_3
        // event should trigger a transmission of events in regular operation
        // however, since u2 is disconnected, events should not be able
        // to reach it.
        const msg2: DebuggingAgentWebSocketInjectMessage = {
          ts_type: "EnqueueEventMessage",
          unit: "u1",
          component: "comp_1",
          port: Ports.OUT,
          event: { type: Events.X, eventClass: "oneway" },
          sequenceNumber: 0,
        };
        const json2 = JSON.stringify(msg2);
        ws.send(json2);
        ws.send(
          JSON.stringify({
            ...msg2,
            unit: "u3",
            component: "comp_3",
            port: Ports.IN,
          })
        );
      });

      await new Promise<void>((resolve) => {
        function checkForCommError() {
          if (lastCommError !== undefined) {
            // check that expected comm error ocurred
            expect(lastCommError).toEqual({
              targetComponent: "comp_2",
              targetContainer: "u2",
            });

            // check that connection techs have been disabled
            dbgRunConfigU2.communicationConfiguration.connectionTechs.forEach(
              (connTech) => {
                if (connTech.sourceComponent.name !== debuggingAgentName) {
                  expect(connTech.commOption).toBe(
                    "DISABLED_BY_DEBUGGING_AGENT"
                  );
                } else {
                  expect(connTech.commOption).toBe(CommOption.REST);
                }
              }
            );

            // make disconnected unit fail completely after
            // the regular communication failed
            // this is to check if debugging agent is still
            // connected, while the rest is disconnected
            const msg: DebuggingAgentWebSocketInjectMessage = {
              ts_type: "FailUnitMessage",
              unit: "u2",
              sequenceNumber: 0,
            };
            const json = JSON.stringify(msg);
            ws.send(json);

            // check if the exit function has been called
            setTimeout(checkForExit, 100);
          } else {
            setTimeout(checkForCommError, 1000);
          }
        }
        function checkForExit() {
          if (
            lastCommError !== undefined &&
            exitHasBeenCalledWithErrorCode !== undefined
          ) {
            expect(mockExit).toHaveBeenCalledWith(1);
            resolve();
          } else {
            setTimeout(checkForExit, 1000);
          }
        }
        setTimeout(checkForCommError, 1000);
      }).then(() => {
        unitTests.shutdownRunConfiguration(dbgRunConfigU1);
        unitTests.shutdownRunConfiguration(dbgRunConfigU2);
        unitTests.shutdownRunConfiguration(dbgRunConfigU3);
        ws.close();
        // restore mock functions
        mockExit.mockRestore();
        mockOnCommError.mockRestore();
      });
    });
  });
});

describe("R-PM.8: test shutdown functions", () => {
  const comp1 = createEmptyComponent("comp1", [Ports.OUT]);
  const comp2 = createEmptyComponent("comp2", [Ports.IN]);

  const compState = { state: "dummy_state" };

  const lsa: Configuration = {
    components: [comp1, comp2],
    connections: [createConnection(comp1, Ports.OUT, comp2, Ports.IN)],
  };

  const hostConfig: HostConfiguration = {
    group1: {
      host: "localhost",
      port: 1234,
    },
    group2: {
      host: "localhost",
      port: 1235,
    },
  };

  const PORT_OUT = createPort(Ports.OUT, [], "out");
  const PORT_IN = createPort(Ports.IN, [], "in");

  const communicationConfigurationRest: CommunicationConfiguration = {
    connectionTechs: [
      {
        sourceContainer: "empty1",
        sourceComponent: comp1,
        sourcePort: PORT_OUT,
        targetContainer: "empty2",
        targetComponent: comp2,
        targetPort: PORT_IN,
        commOption: CommOption.REST,
      },
    ],
  };

  const communicationConfigurationMqtt: CommunicationConfiguration = {
    connectionTechs: [
      {
        sourceContainer: "empty1",
        sourceComponent: comp1,
        sourcePort: PORT_OUT,
        targetContainer: "empty2",
        targetComponent: comp2,
        targetPort: PORT_IN,
        commOption: CommOption.MQTT,
      },
    ],
  };

  const deploymentConfiguration: DeploymentConfiguration = {
    group1: {
      components: [comp1],
    },
    group2: {
      components: [comp2],
    },
  };

  test("R-PM.8: shutdown of REST", async () => {
    const runConfigRest: RunConfiguration = {
      lsa: lsa,
      toExecute: "group2",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfigurationRest,
      hostConfiguration: hostConfig,
      confState: {
        componentState: new Map([
          [comp1, { state: undefined, events: [], tsType: "State" }],
          [comp2, { state: undefined, events: [], tsType: "State" }],
        ]),
      },
      clockStates: new Map(),
      engineRoomState: {
        shadowMap: new Map(),
      },
      shutdownFunctions: [],
    };

    const commTechs = await unitTests.testExecuteRunConfiguration(
      runConfigRest
    );
    expect(commTechs.length).toBe(1);
    const commTech = commTechs[0];
    let connectionStatus = commTech.isConnected();
    expect(connectionStatus).toBe(true);
    unitTests.shutdownRunConfiguration(runConfigRest);
    connectionStatus = commTech.isConnected();
    expect(connectionStatus).toBe(false);
  });

  test("R-PM.8: shutdown of MQTT", async () => {
    const runConfigMqtt: RunConfiguration = {
      lsa: lsa,
      toExecute: "group2",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfigurationMqtt,
      hostConfiguration: hostConfig,
      mqttConfiguration: {
        host: "localhost",
      },
      confState: {
        componentState: new Map([
          [comp1, { state: undefined, events: [], tsType: "State" }],
          [comp2, { state: undefined, events: [], tsType: "State" }],
        ]),
      },
      clockStates: new Map(),
      shutdownFunctions: [],
      engineRoomState: {
        shadowMap: new Map(),
      },
    };
    const commTechs = await unitTests.testExecuteRunConfiguration(
      runConfigMqtt
    );
    expect(commTechs.length).toBe(1);
    const commTech = commTechs[0];

    // already connected?
    if (!commTech.isConnected()) {
      await commTech.onConnect();
    }
    expect(commTech.isConnected()).toBe(true);

    // shutdown
    unitTests.shutdownRunConfiguration(runConfigMqtt);
    if (commTech.isConnected()) {
      await commTech.onDisconnect();
    }
    expect(commTech.isConnected()).toBe(false);
  }, 10000);
});

describe("R-PM.8: test mixed communication", () => {
  enum PingStates {
    PING_START = "PING_START",
    PING_REST = "PING_REST",
    GET_REST = "GET_REST",
    PING_MQTT = "PING_MQTT",
    GET_MQTT = "GET_MQTT",
    PING_END = "PING_END",
  }

  enum PongStates {
    PONG_START = "PONG_START",
    PONG_REST = "PONG_REST",
    GET_REST = "GET_REST",
    PONG_MQTT = "PONG_MQTT",
    GET_MQTT = "GET_MQTT",
    PONG_END = "PONG_END",
  }

  enum Events {
    INIT = "INIT",
    TO_EXT_MQTT_PING = "TO_EXT_MQTT_PING",
    TO_EXT_MQTT_PONG = "TO_EXT_MQTT_PONG",
    FROM_EXT_MQTT = "FROM_EXT_MQTT",
    TO_EXT_REST_PING = "TO_EXT_REST_PING",
    TO_EXT_REST_PONG = "TO_EXT_REST_PONG",
    FROM_EXT_REST = "FROM_EXT_REST",
    FINISH = "FINISH",
  }

  test("Use multiple ports, one connection per port", async () => {
    enum PingPorts {
      FROM_PONG_REST = "FROM_PONG_REST",
      TO_PONG_REST = "TO_PONG_REST",
      FROM_PONG_MQTT = "FROM_PONG_MQTT",
      TO_PONG_MQTT = "TO_PONG_MQTT",
    }

    enum PongPorts {
      FROM_PING_REST = "FROM_PING_REST",
      TO_PING_REST = "TO_PING_REST",
      FROM_PING_MQTT = "FROM_PING_MQTT",
      TO_PING_MQTT = "TO_PING_MQTT",
    }

    const FROM_PONG_MQTT = createPort(
      PingPorts.FROM_PONG_MQTT,
      // gets transformed later
      Object.values(Events).filter((e) => e === "TO_EXT_MQTT_PONG"),
      "in"
    );
    const FROM_PONG_REST = createPort(
      PingPorts.FROM_PONG_REST,
      // gets transformed later
      Object.values(Events).filter((e) => e === "TO_EXT_REST_PONG"),
      "in"
    );
    const TO_PONG_MQTT = createPort(
      PingPorts.TO_PONG_MQTT,
      Object.values(Events).filter((e) => e === "TO_EXT_MQTT_PING"),
      "out"
    );
    const TO_PONG_REST = createPort(
      PingPorts.TO_PONG_REST,
      Object.values(Events).filter((e) => e === "TO_EXT_REST_PING"),
      "out"
    );

    const FROM_PING_MQTT = createPort(
      PongPorts.FROM_PING_MQTT,
      // gets transformed later
      Object.values(Events).filter((e) => e === "TO_EXT_MQTT_PING"),
      "in"
    );
    const FROM_PING_REST = createPort(
      PongPorts.FROM_PING_REST,
      // gets transformed later
      Object.values(Events).filter((e) => e === "TO_EXT_REST_PING"),
      "in"
    );
    const TO_PING_MQTT = createPort(
      PongPorts.TO_PING_MQTT,
      Object.values(Events).filter((e) => e === "TO_EXT_MQTT_PONG"),
      "out"
    );
    const TO_PING_REST = createPort(
      PongPorts.TO_PING_REST,
      Object.values(Events).filter((e) => e === "TO_EXT_REST_PONG"),
      "out"
    );

    type MyState = undefined;

    const ping_sm: StateMachine<PingStates, MyState, Events, PingPorts> = {
      transitions: [
        {
          sourceState: PingStates.PING_START,
          targetState: PingStates.PING_REST,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.TO_EXT_REST_PING,
              port: PingPorts.TO_PONG_REST,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.INIT],
        },
        // transform
        {
          sourceState: PingStates.PING_REST,
          targetState: PingStates.GET_MQTT,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.FROM_EXT_MQTT,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.TO_EXT_MQTT_PONG, PingPorts.FROM_PONG_MQTT],
        },
        {
          sourceState: PingStates.GET_MQTT,
          targetState: PingStates.GET_MQTT,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.TO_EXT_MQTT_PING,
              port: PingPorts.TO_PONG_MQTT,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.FROM_EXT_MQTT],
        },
        {
          sourceState: PingStates.GET_MQTT,
          targetState: PingStates.PING_MQTT,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.TO_EXT_MQTT_PING,
              port: PingPorts.TO_PONG_MQTT,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.TO_EXT_MQTT_PING, PingPorts.TO_PONG_MQTT],
        },
        // transform
        {
          sourceState: PingStates.PING_MQTT,
          targetState: PingStates.GET_REST,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.FROM_EXT_REST,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.TO_EXT_REST_PONG, PingPorts.FROM_PONG_REST],
        },
        {
          sourceState: PingStates.GET_REST,
          targetState: PingStates.GET_REST,
          action: (myState, raiseEvent, event) => {
            // asymmetric cuz nothing more to be send
            raiseEvent({
              type: Events.FINISH,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.FROM_EXT_REST],
        },
        {
          sourceState: PingStates.GET_REST,
          targetState: PingStates.PING_END,
          action: (myState, raiseEvent, event) => {
            return myState;
          },
          event: ["oneway", Events.FINISH],
        },
      ],
    };

    const pong_sm: StateMachine<PongStates, MyState, Events, PongPorts> = {
      transitions: [
        {
          sourceState: PongStates.PONG_START,
          targetState: PongStates.PONG_MQTT,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.TO_EXT_MQTT_PONG,
              port: PongPorts.TO_PING_MQTT,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.TO_EXT_REST_PING, PongPorts.FROM_PING_REST],
        },
        // transform
        {
          sourceState: PongStates.PONG_MQTT,
          targetState: PongStates.GET_MQTT,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.FROM_EXT_MQTT,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.TO_EXT_MQTT_PING, PongPorts.FROM_PING_MQTT],
        },
        {
          sourceState: PongStates.GET_MQTT,
          targetState: PongStates.GET_MQTT,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.TO_EXT_REST_PONG,
              port: PongPorts.TO_PING_REST,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.FROM_EXT_MQTT],
        },
        {
          sourceState: PongStates.GET_MQTT,
          targetState: PongStates.PONG_REST,
          action: (myState, raiseEvent, event) => {
            raiseEvent({
              type: Events.TO_EXT_REST_PONG,
              port: PongPorts.TO_PING_REST,
              eventClass: "oneway",
            } as Event<any, any>);
            return myState;
          },
          event: ["oneway", Events.TO_EXT_REST_PONG, PongPorts.TO_PING_REST],
        },
      ],
    };

    const ping_comp: AtomicComponent<Events, PingPorts> =
      createStatemachineComponent(
        [FROM_PONG_MQTT, FROM_PONG_REST, TO_PONG_MQTT, TO_PONG_REST],
        ping_sm,
        "ping_comp"
      );

    const pong_comp: AtomicComponent<Events, PongPorts> =
      createStatemachineComponent(
        [FROM_PING_MQTT, FROM_PING_REST, TO_PING_MQTT, TO_PING_REST],
        pong_sm,
        "pong_comp"
      );

    const ping_state = {
      state: { fsm: PingStates.PING_START },
      events: [
        {
          type: Events.INIT,
          eventClass: "oneway",
        } as Event<any, any>,
      ],
      tsType: "State",
    };

    const pong_state = {
      state: { fsm: PongStates.PONG_START },
      events: [],
      tsType: "State",
    };

    const confState = {
      componentState: new Map([
        [ping_comp, ping_state] as [
          AtomicComponent<any, any>,
          AbstractState<any, any, any>
        ],
        [pong_comp, pong_state] as [
          AtomicComponent<any, any>,
          AbstractState<any, any, any>
        ],
      ]),
    };

    const hostConfig: HostConfiguration = {
      group1: {
        host: "localhost",
        port: 1234,
      },
      group2: {
        host: "localhost",
        port: 1235,
      },
    };

    const communicationConfiguration: CommunicationConfiguration = {
      connectionTechs: [
        {
          sourceContainer: "cont1",
          sourceComponent: ping_comp,
          sourcePort: TO_PONG_MQTT,
          targetContainer: "cont2",
          targetComponent: pong_comp,
          targetPort: FROM_PING_MQTT,
          commOption: CommOption.MQTT,
        },
        {
          sourceContainer: "cont1",
          sourceComponent: ping_comp,
          sourcePort: TO_PONG_REST,
          targetContainer: "cont2",
          targetComponent: pong_comp,
          targetPort: FROM_PING_REST,
          commOption: CommOption.REST,
        },
        {
          sourceContainer: "cont2",
          sourceComponent: pong_comp,
          sourcePort: TO_PING_MQTT,
          targetContainer: "cont1",
          targetComponent: ping_comp,
          targetPort: FROM_PONG_MQTT,
          commOption: CommOption.MQTT,
        },
        {
          sourceContainer: "cont2",
          sourceComponent: pong_comp,
          sourcePort: TO_PING_REST,
          targetContainer: "cont1",
          targetComponent: ping_comp,
          targetPort: FROM_PONG_REST,
          commOption: CommOption.REST,
        },
      ],
    };

    const deploymentConfiguration: DeploymentConfiguration = {
      group1: {
        components: [ping_comp],
      },
      group2: {
        components: [pong_comp],
      },
    };

    const lsa: Configuration = {
      components: [ping_comp, pong_comp],
      connections: [
        createConnection(
          ping_comp,
          PingPorts.TO_PONG_MQTT,
          pong_comp,
          PongPorts.FROM_PING_MQTT
        ),
        createConnection(
          ping_comp,
          PingPorts.TO_PONG_REST,
          pong_comp,
          PongPorts.FROM_PING_REST
        ),
        createConnection(
          pong_comp,
          PongPorts.TO_PING_MQTT,
          ping_comp,
          PingPorts.FROM_PONG_MQTT
        ),
        createConnection(
          pong_comp,
          PongPorts.TO_PING_REST,
          ping_comp,
          PingPorts.FROM_PONG_REST
        ),
      ],
    };

    const runConfigPing: RunConfiguration = {
      lsa: lsa,
      toExecute: "group1",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfiguration,
      hostConfiguration: hostConfig,
      confState: confState,
      clockStates: new Map(),
      mqttConfiguration: {
        host: "localhost",
      },
      shutdownFunctions: [],
      engineRoomState: {
        shadowMap: new Map(),
      },
    };

    const runConfigPong: RunConfiguration = {
      lsa: lsa,
      toExecute: "group2",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfiguration,
      hostConfiguration: hostConfig,
      confState: confState,
      clockStates: new Map(),
      mqttConfiguration: {
        host: "localhost",
      },
      shutdownFunctions: [],
      engineRoomState: {
        shadowMap: new Map(),
      },
    };

    const commTechsPing = await unitTests.testExecuteRunConfiguration(
      runConfigPing
    );

    const commTechsPong = await unitTests.testExecuteRunConfiguration(
      runConfigPong
    );

    // await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(commTechsPing.length).toBe(2);
    if (!commTechsPing[0].isConnected()) {
      await commTechsPing[0].onConnect();
    }
    expect(commTechsPing[0].isConnected()).toBe(true);
    if (!commTechsPing[1].isConnected()) {
      await commTechsPing[1].onConnect();
    }
    expect(commTechsPing[1].isConnected()).toBe(true);

    expect(commTechsPong.length).toBe(2);
    if (!commTechsPong[0].isConnected()) {
      await commTechsPong[0].onConnect();
    }
    expect(commTechsPong[0].isConnected()).toBe(true);
    if (!commTechsPong[1].isConnected()) {
      await commTechsPong[1].onConnect();
    }
    expect(commTechsPong[1].isConnected()).toBe(true);

    let compStateCurrentPing = runConfigPing.confState.componentState.get(
      ping_comp
    )?.state.fsm as PingStates;

    while (compStateCurrentPing !== PingStates.PING_END) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      compStateCurrentPing = runConfigPing.confState.componentState.get(
        ping_comp
      )?.state.fsm as PingStates;
      const compStateCurrentPong = runConfigPong.confState.componentState.get(
        pong_comp
      )?.state.fsm as PongStates;
      console.log(compStateCurrentPing, compStateCurrentPong);
    }

    expect(compStateCurrentPing).toBe(PingStates.PING_END);

    let compStateCurrentPong = runConfigPong.confState.componentState.get(
      pong_comp
    )?.state.fsm as PongStates;

    while (compStateCurrentPong !== PongStates.PONG_REST) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      compStateCurrentPong = runConfigPong.confState.componentState.get(
        pong_comp
      )?.state.fsm as PongStates;
    }

    expect(compStateCurrentPong).toBe(PongStates.PONG_REST);

    unitTests.shutdownRunConfiguration(runConfigPing);
    for (const commTech of commTechsPing) {
      if (commTech.isConnected()) {
        await commTech.onDisconnect();
      }
      expect(commTech.isConnected()).toBe(false);
    }
    unitTests.shutdownRunConfiguration(runConfigPong);
    for (const commTech of commTechsPong) {
      if (commTech.isConnected()) {
        await commTech.onDisconnect();
      }
      expect(commTech.isConnected()).toBe(false);
    }
  }, 10000);
});

//shutdown mqtt server
afterAll(
  async () =>
    await new Promise((resolve, reject) => {
      server.close(() => {
        aedes.close(() => {
          console.log("Closed MQTT broker");
          resolve(undefined);
        });
      });
    })
);
