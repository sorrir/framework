import {
  Event,
  StateMachine,
  AbstractState,
  Port,
  createPort,
  step as statemachineStep,
  allSteps,
  DegradableState,
  OutPort,
  InPort,
} from "./engine";
import { DependencyFunction } from "./degradation";
import * as _ from "lodash";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";
import { ReflectableType } from "./reflect";
import { Maybe, Just, Nothing, isJust, fromJust } from "@typed/maybe";

export type TransferFunction<S, E, P, D> = (
  currentState: DegradableState<S, E, P, D>
) => DegradableState<S, E, P, D>;

export type DegradationMode<E, P> = StepFunction<E, P, undefined>;

export type StepFunction<E, P, D> = (
  currentState: AbstractState<any, E, P, D>
) => Maybe<AbstractState<any, E, P, D>>;

export type AllStepsFunction<E, P, D> = (
  currentState: AbstractState<any, E, P, D>
) => AbstractState<any, E, P, D>[];

export interface AtomicComponent<EVENT_TYPE, PORT_TYPE, D = undefined>
  extends ReflectableType {
  readonly name: string; // instance type of component
  readonly id?: string; // unique identifier of component
  readonly ports: Port<EVENT_TYPE, PORT_TYPE>[];
  readonly step: StepFunction<EVENT_TYPE, PORT_TYPE, D>;
  readonly allSteps: AllStepsFunction<EVENT_TYPE, PORT_TYPE, D>;
  readonly shutdown?: (
    mystate: AbstractState<any, EVENT_TYPE, PORT_TYPE>
  ) => void;
  readonly transferFunctions?: [[D, D], TransferFunction<any, any, any, any>][];
  readonly tsType: "Component";
  /**
   * Mutator on AbstractState: Used to specify component-specific behavior and can be overridden by component developers
   * Creates an abstract state to be saved in a checkpoint.
   * To be overwritten by components that only want to serialize a part of their state.
   */
  readonly prepareStateForSnapshot?: (
    currentState: AbstractState<any, EVENT_TYPE, PORT_TYPE>
  ) => AbstractState<any, EVENT_TYPE, PORT_TYPE>;

  /**
   * Mutator on AbstractState: Used to specify component-specific behavior and can be overridden by component developers
   * Can be used by components developers to define additional recovery routines.. or to only recover some parts of
   * the recovered State.
   */
  readonly prepareStateAfterRecovery?: (
    snapshotState: AbstractState<any, EVENT_TYPE, PORT_TYPE>
  ) => AbstractState<any, EVENT_TYPE, PORT_TYPE>;

  readonly degradationLevels?: Map<number, D>;

  readonly dependencyMap?: Map<
    number,
    DependencyFunction<any, EVENT_TYPE, PORT_TYPE, D, any>
  >;
  readonly degradationDAG?: [
    [D, D],
    TransferFunction<any, EVENT_TYPE, PORT_TYPE, D>
  ][];
  readonly upgradeDAG?: [
    [D, D],
    TransferFunction<any, EVENT_TYPE, PORT_TYPE, D>
  ][];
}

// the semantics of multiple source target connections are just syntactic sugar for multiple 1:1 connections
// [c1p1,c2p2] -> [c3p3,c4p4] is equal to
// c1p1 -> c3p3, c1p1 -> c4p4, c2p2 -> c3p3, c2p2 -> c4p4,
export interface Connection<EVENT_TYPE> {
  source: {
    readonly sourceComponent: AtomicComponent<any, any>;
    readonly sourcePort: OutPort<EVENT_TYPE, any>;
  };
  target: {
    readonly targetComponent: AtomicComponent<any, any>;
    readonly targetPort: InPort<EVENT_TYPE, any>;
  };
}

export interface Configuration {
  readonly components: AtomicComponent<any, any, any>[];
  readonly connections: Connection<any>[];
}

type IntoDelegation<E> = {
  type: "IntoDelegation";
  source: {
    readonly sourcePort: InPort<E, any>;
  };
  target: {
    readonly targetComponent: Component<any, any, any>;
    readonly targetPort: InPort<E, any>;
  };
};

type OutDelegation<E> = {
  type: "OutDelegation";
  source: {
    readonly sourceComponent: Component<any, any, any>;
    readonly sourcePort: OutPort<E, any>;
  };
  target: {
    readonly targetPort: OutPort<E, any>;
  };
};

type Delegation<E> = IntoDelegation<E> | OutDelegation<E>;

export interface HierarchicalComponent<E, P, D>
  extends AtomicComponent<E, P, D> {
  readonly subConfiguration: Configuration;
  readonly delegations: Delegation<E>[];
}

export type Component<E, P, D> =
  | HierarchicalComponent<E, P, D>
  | AtomicComponent<E, P, D>;

export interface ConfigurationState {
  readonly componentState: Map<
    AtomicComponent<any, any, any>,
    AbstractState<any, any, any, any>
  >;
}

export function createConnection<P_SOURCE, P_TARGET, EVENT_TYPE>(
  sourceComponent: AtomicComponent<any, P_SOURCE, any>,
  sourcePortName: P_SOURCE,
  targetComponent: AtomicComponent<any, P_TARGET, any>,
  targetPortName: P_TARGET
): Connection<EVENT_TYPE> {
  const outPort = getPortFromName(sourceComponent, sourcePortName);
  if (outPort === undefined) {
    const err = {
      message: `Cannot create connection, no port with given name.`,
      data: {
        sourceComponent: sourceComponent,
        sourcePortName: sourcePortName,
      },
    };
    sorrirLogger.error(Stakeholder.SYSTEM, err.message, err.data);
    throw Error(err.message + " " + JSON.stringify(err.data));
  } else if (outPort.direction === "in") {
    const err = {
      message: `Cannot create connection, port with given name is an in-port, out-port expected.`,
      data: {
        sourceComponent: sourceComponent,
        sourcePortName: sourcePortName,
      },
    };
    sorrirLogger.error(Stakeholder.SYSTEM, err.message, err.data);
    throw Error(err.message + " " + JSON.stringify(err.data));
  }
  const inPort = getPortFromName(targetComponent, targetPortName);
  if (inPort === undefined) {
    const err = {
      message: `Cannot create connection, no port with given name.`,
      data: {
        targetComponent: targetComponent,
        targetPortName: targetPortName,
      },
    };
    sorrirLogger.error(Stakeholder.SYSTEM, err.message, err.data);
    throw Error(err.message + " " + JSON.stringify(err.data));
  } else if (inPort.direction === "out") {
    const err = {
      message: `Cannot create connection, port with given name is an out-port, in-port expected.`,
      data: {
        targetComponent: targetComponent,
        targetPortName: targetPortName,
      },
    };
    sorrirLogger.error(Stakeholder.SYSTEM, err.message, err.data);
    throw Error(err.message + " " + JSON.stringify(err.data));
  }
  // TODO: implement this check
  // if (_.intersection(outPort.eventTypes, inPort.eventTypes).length === 0) {
  //   sorrirLogger.error(
  //     Stakeholder.SYSTEM,
  //     `Cannot create connection, the event types of given ports are not compatible.`,
  //     { sourcePort: outPort, targetPort: inPort }
  //   );
  //   throw Error();
  // }
  return {
    source: {
      sourceComponent: sourceComponent,
      sourcePort: outPort,
    },
    target: {
      targetComponent: targetComponent,
      targetPort: inPort,
    },
  };
}

function exchangeMsgsIntoHierarchicalComponent<E, P, D>(
  currentState: AbstractState<ConfigurationState, E, P, D>,
  structure: Omit<Omit<HierarchicalComponent<E, P, D>, "step">, "allSteps">
) {
  const newState = { ...currentState };

  structure.delegations.forEach((d) => {
    if (d.type === "IntoDelegation") {
      const movingEvents = newState.events.filter((e: Event<E, any>) =>
        _.isEqual(e.port, d.source.sourcePort.name)
      );
      _.pullAll(newState.events, movingEvents);
      const targetComponentState = newState.state.componentState.get(
        d.target.targetComponent
      );
      const newEventsAtTarget = movingEvents?.map((e) => {
        return { ...e, port: d.target.targetPort.name };
      });
      if (newEventsAtTarget !== undefined) {
        targetComponentState?.events.push(...newEventsAtTarget);
      }
    }
  });

  return newState;
}

function exchangeMsgsOutofHierarchicalComponent<E, P, D>(
  currentState: AbstractState<ConfigurationState, E, P, D>,
  structure: Omit<Omit<HierarchicalComponent<E, P, D>, "step">, "allSteps">
) {
  const newState = { ...currentState };

  structure.delegations.forEach((d) => {
    if (d.type === "OutDelegation") {
      const sourceComponentState = newState.state.componentState.get(
        d.source.sourceComponent
      );
      const movingEvents = sourceComponentState?.events.filter(
        (e: Event<E, any>) => _.isEqual(e.port, d.source.sourcePort.name)
      );
      if (sourceComponentState !== undefined) {
        _.pullAll(sourceComponentState.events, movingEvents);
      }
      const newEventsAtTarget = movingEvents?.map((e) => {
        return { ...e, port: d.target.targetPort.name };
      });
      if (newEventsAtTarget !== undefined) {
        newState.events.push(...newEventsAtTarget);
      }
    }
  });

  return newState;
}

export function createHierarchicalComponent<S, E, P, D>(
  structure: Omit<Omit<HierarchicalComponent<E, P, D>, "step">, "allSteps">,
  runToCompletion = true
): HierarchicalComponent<E, P, D> {
  // should we check well-formedness of the structure?

  const stepFunction: StepFunction<E, P, D> = (
    currentState: AbstractState<ConfigurationState, E, P, D>
  ) => {
    // exchange messages
    let newState = exchangeMsgsIntoHierarchicalComponent(
      currentState,
      structure
    );

    newState.state = configurationStep(
      structure.subConfiguration,
      newState.state,
      runToCompletion
    );

    // exchange messages
    newState = exchangeMsgsOutofHierarchicalComponent(newState, structure);

    return Just.of(newState);
  };

  const allStepFunction: AllStepsFunction<E, P, D> = (
    currentState: AbstractState<ConfigurationState, E, P, D>
  ) => {
    // intoDelegation
    const newState = exchangeMsgsIntoHierarchicalComponent(
      currentState,
      structure
    );

    const allNewConfigurations = allConfigurationSteps(
      structure.subConfiguration,
      newState.state
    );

    // for each configuration, outdelegation
    return allNewConfigurations.map((c) =>
      exchangeMsgsOutofHierarchicalComponent(
        { ...newState, state: c },
        structure
      )
    );
  };

  return {
    ...structure,
    step: stepFunction,
    allSteps: allStepFunction,
  };
}

export function createStatemachineComponent<E, P, D>(
  ports: Port<E, P>[],
  sm: [D, StateMachine<any, any, E, P>][] | StateMachine<any, any, E, P>,
  name?: string,
  degradationLevels?: Map<number, D>,
  dependencyMap?: Map<number, DependencyFunction<any, E, P, D, any>>,
  degradationDAG?: [[D, D], TransferFunction<any, E, P, any>][],
  upgradeDAG?: [[D, D], TransferFunction<any, E, P, any>][]
): AtomicComponent<E, P, D> {
  sorrirLogger.configLogger({ area: "operation" });
  if ("transitions" in sm) {
    // this is a normal state machine
    const step = (
      currentState: AbstractState<any, E, P, D>
    ): Maybe<AbstractState<any, E, P, D>> =>
      statemachineStep(sm, currentState) as Maybe<AbstractState<any, E, P, D>>;
    const all = (
      currentState: AbstractState<any, E, P, D>
    ): AbstractState<any, E, P, D>[] =>
      allSteps(sm, currentState) as AbstractState<any, E, P, D>[];

    return {
      name: name !== undefined ? name : "no-name",
      ports: ports.map((p) => createPort(p.name, p.eventTypes, p.direction)),
      step: step,
      allSteps: all,
      prepareStateForSnapshot: (
        state: AbstractState<any, E, P>
      ): AbstractState<any, E, P> => state,
      prepareStateAfterRecovery: (
        state: AbstractState<any, E, P>
      ): AbstractState<any, E, P> => state,
      tsType: "Component",
    };
  } else {
    // multiple state machines with degradation modes

    const modeStepMap = new Map<unknown, StepFunction<E, P, D>>();
    sm.forEach(([mode, machine]) =>
      modeStepMap.set(
        mode,
        (currentState: AbstractState<any, E, P, D>) =>
          statemachineStep(machine, currentState) as Maybe<
            AbstractState<any, E, P, D>
          >
      )
    );

    const step = (
      currentState: AbstractState<any, E, P, D>
    ): Maybe<AbstractState<any, E, P, D>> => {
      const stepFunction = modeStepMap.get(currentState.operatingMode);

      if (!stepFunction) {
        // log error
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          "there does not exist a step function for the current degradation mode",
          { operatingMode: currentState.operatingMode }
        );
      } else {
        return stepFunction(currentState);
      }
      return Nothing;
    };

    const modeAllStepsMap = new Map<unknown, AllStepsFunction<E, P, D>>();
    sm.forEach(([mode, machine]) =>
      modeAllStepsMap.set(
        mode,
        (currentState: AbstractState<any, E, P, D>) =>
          allSteps(machine, currentState) as AbstractState<any, E, P, D>[]
      )
    );

    const allStepsFunction = (
      currentState: AbstractState<any, E, P, D>
    ): AbstractState<any, E, P, D>[] => {
      const allStepsFunction = modeAllStepsMap.get(currentState.operatingMode);
      if (allStepsFunction) {
        return allStepsFunction(currentState);
      } else {
        // log error
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          "there does not exist an allSteps function for the current degradation mode",
          { operatingMode: currentState.operatingMode }
        );
        return [];
      }
    };

    return {
      name: name !== undefined ? name : "no-name",
      ports: ports.map((p) => createPort(p.name, p.eventTypes, p.direction)),
      step: step,
      allSteps: allStepsFunction,
      prepareStateForSnapshot: (
        state: AbstractState<any, E, P>
      ): AbstractState<any, E, P> => state,
      prepareStateAfterRecovery: (
        state: AbstractState<any, E, P>
      ): AbstractState<any, E, P> => state,
      degradationLevels: degradationLevels,
      dependencyMap: dependencyMap,
      degradationDAG: degradationDAG,
      upgradeDAG: upgradeDAG,
      tsType: "Component",
    };
  }
}

export function getPortFromName<EVENT_TYPE, PORT_TYPES>(
  component: AtomicComponent<EVENT_TYPE, PORT_TYPES, any>,
  name: PORT_TYPES
):
  | InPort<EVENT_TYPE, PORT_TYPES>
  | OutPort<EVENT_TYPE, PORT_TYPES>
  | undefined {
  return component.ports.find((p) => _.isEqual(p.name, name)) as
    | InPort<EVENT_TYPE, PORT_TYPES>
    | undefined;
}

export function getInPortFromName<EVENT_TYPE, PORT_TYPES>(
  component: AtomicComponent<EVENT_TYPE, PORT_TYPES, any>,
  name: PORT_TYPES
): InPort<EVENT_TYPE, PORT_TYPES> | undefined {
  return component.ports.find(
    (p) => p.direction === "in" && _.isEqual(p.name, name)
  ) as InPort<EVENT_TYPE, PORT_TYPES> | undefined;
}

export function getOutPortFromName<EVENT_TYPE, PORT_TYPES>(
  component: AtomicComponent<EVENT_TYPE, PORT_TYPES, any>,
  name: PORT_TYPES
): OutPort<EVENT_TYPE, PORT_TYPES> | undefined {
  return component.ports.find(
    (p) => p.direction === "out" && _.isEqual(p.name, name)
  ) as OutPort<EVENT_TYPE, PORT_TYPES> | undefined;
}

/**
 * Executes all components of current configuration until stable state is reached.
 * @param configuration
 * @param currentState
 * @param runToCompletion default true, if set to false, only one single configuratino step is executed, run-
 * to completion otherwise.
 * @param onTransition function that is called whenever a component has performed a transition
 */
export function configurationStep<E>(
  configuration: Configuration,
  currentState: ConfigurationState,
  runToCompletion = true,
  onTransition?: (component: AtomicComponent<any, any, any>) => void
): ConfigurationState {
  let nextConfigurationState: ConfigurationState = {
    // one step in each component
    componentState: currentState.componentState,
  };
  let hasSwitched = false;

  // Execute step function until all components of current machine / container return undefined.
  // Returning of undefined corresponds to component can not switch (anymore).
  // Note: Currently this is implemented in a "blocking" way. If the developer develops an endless ping
  // pong state machine, the application will never leave the loop.
  do {
    hasSwitched = false;
    const intermediateStates = new Map(
      [...nextConfigurationState.componentState].map(
        ([component, componentState]) => {
          console.log("Component", component.name);
          console.log("State", componentState.state);
          console.log("OperatingMode", componentState.operatingMode);
          const newComponentState = component.step(componentState);
          // handle new state if a transition has occured
          if (isJust(newComponentState)) {
            hasSwitched = true;
            // execute callback
            if (onTransition !== undefined) onTransition(component);
            return [component, fromJust(newComponentState)];
          }
          // Return old (in case of no update) state
          return [component, componentState];
        }
      )
    );
    nextConfigurationState = {
      // one step in each component
      componentState: intermediateStates,
    };

    // exchange messages
    nextConfigurationState = exchangeMessages(
      configuration,
      nextConfigurationState
    );
  } while (hasSwitched && runToCompletion);
  return nextConfigurationState;
}

// this function is impure as it mutates the event queues in the states
function exchangeMessages<E>(
  configuration: Configuration,
  configurationState: ConfigurationState
): ConfigurationState {
  sorrirLogger.configLogger({ area: "execution" });
  // exchange messages

  type OutgoingEvent = {
    source: AtomicComponent<any, any, any>;
    evt: Event<E, any>;
    transported: boolean;
  };

  //1: collect all outgoing events in an object[]
  const movingEventSets = configuration.components.map((sourceComponent) => {
    const sourceComponentState =
      configurationState.componentState.get(sourceComponent);
    const events = sourceComponentState?.events.filter((e: Event<E, any>) =>
      sourceComponent.ports.some(
        (p) => p.direction === "out" && _.isEqual(e.port, p.name)
      )
    );
    return events !== undefined
      ? events.map((e) => {
          return { source: sourceComponent, evt: e, transported: false };
        })
      : [];
  });

  const movingEvents: OutgoingEvent[] = _.flatten(movingEventSets);
  sorrirLogger.debug(Stakeholder.SYSTEM, "movingEvents->", {
    movingEvents: _.map(movingEvents, (e) => {
      return {
        ...e,
        source: e.source.name,
      };
    }),
  });

  //2: for all events iterate over all connections at the respective "outgoing" port
  movingEvents.forEach((e) => {
    sorrirLogger.debug(Stakeholder.SYSTEM, "outgoing event->", {
      event: {
        ...e,
        source: e.source.name,
      },
    });

    configuration.connections
      .filter(
        (c) =>
          c.source.sourceComponent === e.source &&
          (e.evt.port === undefined ||
            _.isEqual(c.source.sourcePort.name, e.evt.port)) &&
          c.source.sourcePort.direction === "out"
      )
      .forEach((conn) => {
        //3:    deep clone event, change to target port
        const targetComponentState = configurationState.componentState.get(
          conn.target.targetComponent
        );
        const clonedEvent = {
          ..._.cloneDeep(e.evt),
          port: conn.target.targetPort.name,
          // we keep the event-id the same to ensure request/reply-coherence
          // id: uuidv4(),
        };
        //5:    put in target components event queue
        targetComponentState?.events.push(clonedEvent);
        sorrirLogger.debug(Stakeholder.SYSTEM, "->push event", {
          clonedEvent: clonedEvent,
        });
        //6:    mark old event as "transported"
        e.transported = true;
      });
  });

  //7: remove all transported events from original event queues
  const movedEvents = movingEvents.filter((e) => e.transported);
  sorrirLogger.debug(Stakeholder.SYSTEM, "->moved Events", {
    movedEvents: _.map(movedEvents, (e) => {
      return {
        ...e,
        source: e.source.name,
      };
    }),
  });
  configuration.components.forEach((sourceComponent) => {
    const sourceComponentState =
      configurationState.componentState.get(sourceComponent);
    if (sourceComponentState) {
      const pulledEvents = _.pullAll(
        sourceComponentState.events,
        movedEvents.map((e) => e.evt)
      );
      if (pulledEvents.length > 0) {
        sorrirLogger.debug(Stakeholder.SYSTEM, "->pulled events", {
          pulledEvents: pulledEvents,
        });
      }
    }
  });

  return configurationState;
}

// cartesian product taken from https://stackoverflow.com/questions/12303989/cartesian-product-of-multiple-arrays-in-javascript/36234242#36234242
function product(arr: any[][]) {
  return arr.reduce(
    function (a: any[], b: any[]) {
      return a
        .map(function (x: any) {
          return b.map(function (y: any) {
            return x.concat([y]);
          });
        })
        .reduce(function (a: any, b: any) {
          return a.concat(b);
        }, []);
    },
    [[]]
  );
}

export function allConfigurationSteps<E>(
  configuration: Configuration,
  currentState: ConfigurationState
): ConfigurationState[] {
  // nextStates holds the all potential states for each component
  const compAllStates = [...currentState.componentState].map(([c, state]) =>
    c.allSteps(state)
  );
  //logger.debug(compAllStates);
  //logger.debug({"compAllStates.length": compAllStates.length});

  // we need now to create a potential configuration for each combination of component state
  const productStates: AbstractState<any, any, any>[][] = [
    ...product(compAllStates),
  ];

  const confs: ConfigurationState[] = productStates.map((states) => {
    return {
      componentState: new Map(
        _.zip([...currentState.componentState.keys()], states) as [
          AtomicComponent<any, any>,
          AbstractState<any, any, any>
        ][]
      ),
    };
  });

  return confs.map((c) => exchangeMessages(configuration, c));
}

export function applyTransferFunction<S, E, P, D>(
  comp: AtomicComponent<E, P, D>,
  newD: D,
  current: DegradableState<S, E, P, D>
): DegradableState<S, E, P, D> {
  sorrirLogger.configLogger({ area: "execution" });
  const currentD = current.operatingMode;
  if (currentD === undefined || comp.transferFunctions === undefined) {
    // we don't care about degradation modes, don't do anything
    sorrirLogger.warn(
      Stakeholder.SYSTEM,
      "applyTransferFunction missing data",
      {
        currentD: currentD,
        newD: newD,
        transferFunctions: comp.transferFunctions,
      }
    );
    return current;
  }

  if (newD === currentD) {
    // no change
    return current;
  }

  const transferFunction = _.chain(comp.transferFunctions)
    .filter((element) => _.isEqual(element[0], [currentD, newD]))
    .head()
    .value() as [[D, D], TransferFunction<any, any, any, any>] | undefined;

  if (!transferFunction) {
    // no transferfunction to new D don't do anything
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "there does not exist a transferFunction",
      { currentD: currentD, newD: newD }
    );
    return current;
  }

  return {
    ...current,
    state: transferFunction[1](current).state,
    operatingMode: newD,
  };
}

export function attachIDtoComponent<E, P, D>(
  comp: AtomicComponent<E, P, D>,
  id: string
): AtomicComponent<E, P, D> {
  return {
    ...comp,
    id: id,
  };
}
