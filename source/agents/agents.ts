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
  if (runConfig.engineRoomState.shadowAgentEnabled) {
    startShadowAgent(runConfig);
  }

  // debugging agent
  if (runConfig.engineRoomState.debuggingAgentEnabled) {
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
