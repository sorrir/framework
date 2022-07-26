import { AtomicComponent } from "..";
import { RunConfiguration } from "../exec-types";
import { startDebuggingAgent } from "./debugging-agent";
import { startShadowAgent } from "./shadow-agent";

/**
 * Start all enabled agents for the given RunConfiguration
 *
 * @param runConfig RunConfiguration
 */
export function startAgents(runConfig: RunConfiguration): void {
  // shadow agent
  if (
    runConfig.shadowModeConfiguration?.[runConfig.toExecute]?.shadowAgent
      ?.enabled === true
  ) {
    startShadowAgent(runConfig);
  }

  // debugging agent
  if (
    runConfig.debuggingConfiguration?.[runConfig.toExecute]?.debuggingAgent
      ?.enabled === true
  ) {
    startDebuggingAgent(runConfig);
  }
}

/**
 * Type to identify agent components
 */
export type AgentComponent<EVENT_TYPE, PORT_TYPE> = AtomicComponent<
  EVENT_TYPE,
  PORT_TYPE,
  unknown
> & {
  isAgent: true;
};
