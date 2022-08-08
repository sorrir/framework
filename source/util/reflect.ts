import * as _ from "lodash";
import { SignatureHelpTriggerCharacter } from "typescript";
import { AtomicComponent } from "./component";
import { AbstractState, AbstractStateGenerator } from "./engine";

export interface ReflectableType {
  readonly tsType: "Component" | "State" | "StateGeneratorFunction";
}

const allModules: Record<string, any> = <Record<string, any>>(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(`${process.cwd()}/dist/index.js`)
);

export function getAllComponents(): Record<string, AtomicComponent<any, any>> {
  return getModulesWithTsType("Component");
}

export function getAllStates(): Record<string, AbstractState<any, any, any>> {
  return getModulesWithTsType("State");
}

export function getAllStateGenerators(): Record<
  string,
  AbstractStateGenerator<any, any, any, any>
> {
  return getModulesWithTsType("StateGenerator");
}

function getModulesWithTsType(tsType: string) {
  const modules = _.fromPairs(
    _.filter(
      Object.entries(allModules),
      ([name, module]) => module?.tsType === tsType
    )
  );

  return modules;
}

export function getReflectableModules(): {
  components: Record<string, AtomicComponent<any, any>>;
  states: Record<string, AbstractState<any, any, any>>;
  stateGenerators: Record<string, AbstractStateGenerator<any, any, any>>;
} {
  return {
    components: getAllComponents(),
    states: getAllStates(),
    stateGenerators: getAllStateGenerators(),
  };
}

export function getSetupInfo(): {
  components: Record<string, AtomicComponent<any, any>>;
  startStates: Record<string, AbstractState<any, any, any>>;
  stateGenerators: {
    [name: string]: { [param: string]: "number" | "string" | "boolean" };
  };
} {
  const { components, states, stateGenerators } = getReflectableModules();
  return {
    components,
    startStates: states,
    stateGenerators: _.reduce(
      Object.entries(stateGenerators),
      (acc, [name, obj]) => {
        acc[name] = obj.argTypes;
        return acc;
      },
      {}
    ),
  };
}

export function getAllModules(): Record<string, any> {
  return allModules;
}
