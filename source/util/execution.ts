import { CommunicationTech } from "../communication/comm-tech";
import { RunConfiguration } from "../exec-types";
import {
  setupCommLayers,
  initConnectionLess,
  executeAndCommunicate,
} from "../communication/comm-engine";
import { debuggingAgentName, startAgents } from "../agents";
import {
  computeConnectionsFromLocalToExternal,
  computeLocallyDeployedConfiguration,
} from "..";

enum LOCAL_EXTERNAL {
  LOCAL,
  EXTERNAL,
}

/**
 * This function is for testing purposes only. Instead of just execute
 * the run configuration, this function returns the internal commTechs
 * array promise for further inspection / testing purposes.
 *
 * To access this non exported function use unitTests object below.
 *
 * @param runConfig
 * @return CommunicationTech
 */
async function testExecuteRunConfiguration(
  runConfig: RunConfiguration
): Promise<CommunicationTech[]> {
  const commTechs: CommunicationTech[] = await setupCommLayers(runConfig);
  console.log("Finished set up comm layer");

  if (commTechs.length === 0) {
    initConnectionLess(runConfig);
  }

  for (const commTech of commTechs) {
    await commTech.setupEndPoint();
    console.log("Finished set up Endpoint for commTech");
    commTech.bootStrap();
  }

  // start background agents
  startAgents(runConfig);

  // Initiate initial execution step, has no effect if no prepared event is stored within event queue
  executeAndCommunicate(
    runConfig,
    computeLocallyDeployedConfiguration(runConfig),
    computeConnectionsFromLocalToExternal(runConfig)
  );

  // do something when app is closing
  process.on("exit", (code) => {
    console.log(`About to exit with code: ${code}`);
    shutdownRunConfiguration(runConfig);
    process.exit();
  });

  // catches ctrl+c event
  process.on("SIGINT", (code) => {
    console.log(`About to exit with code: ${code}`);
    shutdownRunConfiguration(runConfig);
    process.exit();
  });

  // catches "kill pid" (for example: nodemon restart)
  process.on("SIGUSR1", (code) => {
    console.log(`About to exit with code: ${code}`);
    shutdownRunConfiguration(runConfig);
    process.exit();
  });
  process.on("SIGUSR2", (code) => {
    console.log(`About to exit with code: ${code}`);
    shutdownRunConfiguration(runConfig);
    process.exit();
  });

  // catches uncaught exceptions
  process.on("uncaughtException", (code) => {
    console.log(`About to exit with code: ${code}`);
    shutdownRunConfiguration(runConfig);
    process.exit();
  });

  return commTechs;
}

/**
 * Setups communication layer, endpoints, and executes
 * bootstrap functions of given runConfig. If runConfig
 * holds any prepared messages, the messages will be
 * processed automatically.
 *
 * @param runConfig
 */
export async function executeRunConfiguration(
  runConfig: RunConfiguration
): Promise<void> {
  await testExecuteRunConfiguration(runConfig);
}

/**
 * Calls each shutdown function of given runConfig.
 *
 * @param runConfig
 */
function shutdownRunConfiguration(runConfig: RunConfiguration): void {
  runConfig.shutdownFunctions?.forEach((shutdownFunction) =>
    shutdownFunction.fn()
  );
}

/**
 * Export "raw" executeRunConfiguration a.k.a testExecuteRunConfiguration
 * and shutdownRunConfiguration wrapped into unitTests object to make them
 * accessible for unit tests.
 *
 * @todo: is there any better solution?
 */
export const unitTests = {
  testExecuteRunConfiguration: testExecuteRunConfiguration,
  shutdownRunConfiguration: shutdownRunConfiguration,
};
