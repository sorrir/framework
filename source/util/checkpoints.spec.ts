import {
  AbstractState,
  createPort,
  Event,
  Internal,
  OneWayEvent,
  RaiseEventCallBack,
  StateMachine,
} from "./engine";
import {
  Component,
  Configuration,
  createConnection,
  createStatemachineComponent,
} from "./component";
import {
  CommunicationConfiguration,
  DeploymentConfiguration,
  HostConfiguration,
  ResilienceConfiguration,
  RunConfiguration,
} from "../exec-types";
import { readCheckpointFromDisk, snapshotAll } from "./checkpoints";
import { executeRunConfiguration, unitTests } from "./execution";

describe("run to checkpoint tests", () => {
  test("locally", async () => {
    enum FSMState {
      PING = "PING",
      PONG = "PONG",
    }
    enum Events {
      X = "X",
    }
    enum Ports {}

    type PingPongEvent = OneWayEvent<Events, Ports> & {
      param: {
        counter: number;
      };
    };

    type MyState = undefined;

    const sm: StateMachine<FSMState, MyState, Events, Ports> = {
      transitions: [
        {
          sourceState: FSMState.PING,
          targetState: FSMState.PONG,
          action: (
            myState: MyState,
            raiseEvent: RaiseEventCallBack<Events, Ports>,
            event?: OneWayEvent<Events, Ports>
          ) => {
            const receivedCounter =
              (event as PingPongEvent)?.param?.counter ?? 0;
            if (receivedCounter - 1 > 0) {
              raiseEvent({
                eventClass: "oneway",
                type: Events.X,
                port: Internal,
                param: {
                  counter: receivedCounter - 1,
                },
              } as PingPongEvent);
            }
            return myState;
          },
          event: ["oneway", Events.X],
        },
        {
          sourceState: FSMState.PONG,
          targetState: FSMState.PING,
          action: (
            myState: MyState,
            raiseEvent: RaiseEventCallBack<Events, Ports>,
            event?: OneWayEvent<Events, Ports>
          ) => {
            const receivedCounter =
              (event as PingPongEvent)?.param?.counter ?? 0;
            if (receivedCounter - 1 > 0) {
              raiseEvent({
                eventClass: "oneway",
                type: Events.X,
                port: Internal,
                param: {
                  counter: receivedCounter - 1,
                },
              } as PingPongEvent);
            }
            return myState;
          },
          event: ["oneway", Events.X],
        },
      ],
    };

    let comp1: Component<Events, Ports, undefined> =
      createStatemachineComponent([], sm, "comp1");

    comp1 = { ...comp1, id: "comp1" };

    const comp_state: AbstractState<any, any, any, undefined> = {
      state: { fsm: FSMState.PING, my: null },
      events: [
        {
          eventClass: "oneway",
          type: Events.X,
          param: { counter: 20 },
        } as PingPongEvent,
      ],
      tsType: "State",
    };

    const confState = {
      componentState: new Map([
        [comp1, comp_state] as [
          Component<any, any, undefined>,
          AbstractState<any, any, any, undefined>
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

    const resilienceConfiguration: ResilienceConfiguration = {
      components: [
        {
          id: "comp1",
          mechanisms: {
            checkpointRecovery: {
              recovery: {
                enabled: true,
              },
              checkpoint: {
                enabled: true,
              },
            },
          },
        },
      ],
    };

    const runConfig: RunConfiguration = {
      lsa: lsa,
      toExecute: "group1",
      deploymentConfiguration: deploymentConfiguration,
      communicationConfiguration: communicationConfiguration,
      hostConfiguration: hostConfig,
      confState: confState,
      shutdownFunctions: [],
      clockStates: new Map(),
      resilienceConfiguration: resilienceConfiguration,
      engineRoomState: {
        shadowMap: new Map(),
        shadowAgentEnabled: false,
        shadowAgentTargets: [],
      },
    };

    expect.assertions(5);

    snapshotAll(runConfig);

    const checkpoint1 = readCheckpointFromDisk("comp1");

    // Test if reading from snapshot yields the same state as the component currently holds
    expect(JSON.stringify(checkpoint1?.abstractState)).toBe(
      JSON.stringify(comp_state)
    );

    expect(checkpoint1?.timestamp).toBe(0);

    expect(JSON.stringify(checkpoint1?.memorizedRcvdMsgs)).toBe(
      JSON.stringify([])
    );

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

          snapshotAll(runConfig);
          const newState = {
            state: { fsm: FSMState.PING, my: null },
            events: [],
            tsType: "State",
          };
          const checkpoint1 = readCheckpointFromDisk("comp1");

          // Test if reading from snapshot yields the same state as the component currently holds
          expect(JSON.stringify(checkpoint1?.abstractState)).toBe(
            JSON.stringify(newState)
          );

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
});
