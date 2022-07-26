import { RunConfiguration } from "../exec-types";
import { setupRunConfig } from "./setup-run-config";
import { setupReplication } from "./setup-replication";
import { setupRecovery } from "./setup-recovery";
import { setupAgents } from "./setup-agents";

export function setup(): RunConfiguration {
  let runConfig = setupRunConfig();
  runConfig = setupReplication(runConfig);
  runConfig = setupRecovery(runConfig);
  // must be called last
  runConfig = setupAgents(runConfig);
  return runConfig;
}
