/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as _ from "lodash";
import { setup } from "../setup/setup";
import convict from "convict";
import { Event } from "../util/engine";
import { v4 as uuidv4 } from "uuid";
import { outDemux } from "../communication/comm-engine";
import { AtomicComponent } from "..";

export function sendEvent(eventArgs: Record<string, unknown> = {}): void {
  // transform args if set
  if (eventArgs.param !== undefined) {
    eventArgs.param = JSON.stringify(eventArgs.param);
  }

  // command line arguments
  const args = convict({
    source: {
      doc: "The source component.",
      format: String,
      default: undefined,
      arg: "source",
    },
    target: {
      doc: "The target component.",
      format: String,
      default: undefined,
      arg: "target",
    },
    port: {
      doc: "The target port name.",
      format: String,
      default: undefined,
      arg: "port",
    },
    env: {
      doc: "The environment. Defaults to 'production'.",
      format: String,
      default: "production",
      arg: "env",
    },
    class: {
      doc: "The event class. Defaults to 'oneway'.",
      format: String,
      default: "oneway",
      arg: "class",
    },
    type: {
      doc: "The event type",
      format: String,
      default: undefined,
      arg: "type",
    },
    rc: {
      doc: "The return code (optional).",
      format: String,
      default: undefined,
      arg: "rc",
    },
    param: {
      doc: "The event parameters (optional).",
      format: "*",
      default: undefined,
      arg: "param",
    },
  });

  // display help
  if (process.argv.includes("--help")) {
    Object.entries(args.getSchema().properties).forEach(([key, val]) =>
      console.log(key, val)
    );
    return;
  }

  // workaround for dumb behaviour of convict
  // convict skips the first process argument
  // this breaks the script if arguments are being passed via '--',
  // e.g. by doing `npm run sendEvent -- -- --someArgument`
  process.argv.unshift("dummy");

  // load config
  args.load(eventArgs);
  args.validate({ allowed: "strict" });

  // load the configuration file
  const config: any = require(`${process.cwd()}/config/${args.get(
    "env"
  )}.json`);

  // source unit
  const sourceUnit = _.find(
    Object.keys(config.DeploymentConfiguration),
    (unit) =>
      _.find(
        config.DeploymentConfiguration[unit].components,
        (comp) => comp === args.get("source")
      ) !== undefined
  );

  // set a default env variable for execution
  process.env.TO_EXECUTE =
    <string>sourceUnit ?? Object.keys(config.DeploymentConfiguration)[0];

  // load mock runConfig
  const runConfig = setup();

  // disable inMessageSharing
  // we're external, we don't have any information
  // not disabling would lead to events being cluttered
  (<any>runConfig).shadowModeConfiguration[
    runConfig.toExecute
  ].inMessageSharing.enabled = false;

  // disable clockstates
  // external events don't have an incrementing timestamp
  // not disabling would lead to events being dropped as duplicates
  runConfig.clockStates.clear();

  //source component
  let sourceComponent: AtomicComponent<any, any, undefined> | undefined;
  const sourceContainer = _.find(
    Object.keys(runConfig.deploymentConfiguration),
    (unit) => {
      sourceComponent = _.find(
        runConfig.deploymentConfiguration[unit].components,
        (comp) => comp.name === args.get("source")
      );
      return sourceComponent !== undefined;
    }
  );

  //target component
  let targetComponent: AtomicComponent<any, any, undefined> | undefined;
  const targetContainer = _.find(
    Object.keys(runConfig.deploymentConfiguration),
    (unit) => {
      targetComponent = _.find(
        runConfig.deploymentConfiguration[unit].components,
        (comp) => comp.name === args.get("target")
      );
      return targetComponent !== undefined;
    }
  );
  const targetPort = _.find(
    targetComponent?.ports,
    (port) => port.name === args.get("port")
  );

  // find out source port
  const sourcePort = _.find(
    runConfig.lsa.connections,
    (conn) =>
      conn.source.sourceComponent.name === sourceComponent?.name &&
      conn.target.targetComponent.name === targetComponent?.name &&
      conn.target.targetPort.name === targetPort?.name
  )?.source.sourcePort;

  // read params
  const param = JSON.parse(<any>args.get("param") ?? "{}");

  // create event
  const event: Event<any, any> = {
    eventClass: <any>args.get("class"),
    type: args.get("type"),
    rc: args.get("rc") ?? 0,
    answerToRequestID: "",
    id: uuidv4(),
    param: param,
  };

  // send event via outDemuxer of framework
  outDemux(runConfig, [event], sourceComponent!, sourcePort!, {
    targetComponent: targetComponent!,
    targetPort: targetPort!,
  });
}
