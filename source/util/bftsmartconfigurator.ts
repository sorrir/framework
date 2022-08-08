import * as fs from "fs";
import * as fse from "fs-extra";
import { RunConfiguration } from "../exec-types";
import { Component } from "./component";
import * as _ from "lodash";
import { sorrirLogger } from "@sorrir/sorrir-logging/dist/app";

export function createNewReplicationConfig(
  configPath: string,
  fileDirPath: string,
  runConfiguration: RunConfiguration,
  component: Component<any, any, any>
): boolean {
  const config = _.find(
    runConfiguration.resilienceConfiguration?.components,
    (c) => c.id === component.id
  );

  if (config === undefined) {
    return false;
  }

  // Check if path exists
  if (!fs.existsSync(fileDirPath)) {
    console.error("ERROR, Template in path " + fileDirPath + " does not exist");
  }

  // create new config folder in some path <configPath>
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configPath, { recursive: true });
  }

  // copy template, but do not copy currentView object
  fse.copySync(fileDirPath, configPath, {
    recursive: true,
    filter: (path) => path.indexOf("currentView") <= -1,
  });

  // Delete current view object
  if (fs.existsSync(configPath + "/currentView")) {
    fs.unlinkSync(configPath + "/currentView");
  }

  // Check if config is correct
  if (!isValidConfig(config)) {
    return false;
  }

  // write java.security
  const securityConfig: string = configPath + "/java.security";
  console.log("Writing Java security properties to " + securityConfig);
  if (fs.existsSync(securityConfig)) {
    fs.unlinkSync(securityConfig);
  }
  fs.appendFileSync(
    securityConfig,
    "security.provider.10=org.bouncycastle.jce.provider.BouncyCastleProvider"
  );
  fs.appendFileSync(securityConfig, "\njdk.tls.disabledAlgorithms=");

  // modify the system.config to match component-specific requirements
  const systemConfig: string = configPath + "/system.config";

  // BFT or CFT? overwrite fault model in config;
  if (config?.mechanisms?.activeReplication?.faultModel === "CFT") {
    replace(systemConfig, "system.bft", "false");
  }

  // overwrite faulty servers assumption
  if (config?.mechanisms?.activeReplication?.f > -1) {
    replace(
      systemConfig,
      "system.servers.f",
      config?.mechanisms?.activeReplication?.f
    );
  }

  // overwrite total nodes used
  if (config?.mechanisms?.activeReplication?.n > -1) {
    replace(
      systemConfig,
      "system.servers.num",
      config?.mechanisms?.activeReplication?.n
    );
  }
  let defaultN =
    config?.mechanisms?.activeReplication?.faultModel === "CFT" ? 3 : 4;
  if (config?.mechanisms?.activeReplication?.n === undefined) {
    const defaultMultiplicator =
      config?.mechanisms?.activeReplication?.faultModel === "CFT" ? 2 : 3;

    const defaultF = config?.mechanisms?.activeReplication?.f
      ? config?.mechanisms?.activeReplication?.f
      : 1;
    defaultN = defaultF * defaultMultiplicator + 1;
    replace(systemConfig, "system.servers.num", defaultN);
  }

  // create initial view, convention: enumerate replicas from 0 to n-1
  let viewString = "";
  const N =
    config?.mechanisms?.activeReplication?.n > -1
      ? config?.mechanisms?.activeReplication?.n
      : defaultN;
  for (let i = 0; i < N; i++) {
    viewString += i;
    if (i !== N - 1) {
      viewString += ",";
    }
  }

  replace(systemConfig, "system.initial.view", viewString);

  // modify the hosts.config

  const hostsConfig: string = configPath + "/hosts.config";

  let index = -1;
  runConfiguration.resilienceConfiguration?.components?.forEach((comp) => {
    // Active replication should be used with this component
    if (
      component.id === comp.id &&
      comp.mechanisms?.activeReplication?.enabled
    ) {
      index++;
      // Execution sites define where replicas are deployed
      const executionSites = comp.mechanisms?.activeReplication?.executionSites;
      for (let i = 0; i < executionSites.length; i++) {
        const unitDefaultPort =
          runConfiguration.hostConfiguration[executionSites[i]].port;
        const bftSMaRt = 1000;
        const compSpecific = 100;
        const usePort = unitDefaultPort + bftSMaRt + compSpecific * index;
        const usePort2 = usePort + 1;
        const host: string =
          runConfiguration.hostConfiguration[executionSites[i]].host;

        const entry = "" + i + " " + host + " " + usePort + " " + usePort2;
        const templateport1 = 11000 + 10 * i;
        const templateport2 = 11001 + 10 * i;
        const option =
          "" + i + " 127.0.0.1" + " " + templateport1 + " " + templateport2;
        replace(hostsConfig, option, entry, true);
      }
    }
  });
  return true;
}

function replace(file: string, option: string, newValue, hostConfig?: boolean) {
  const old = fse.readFileSync(file, { encoding: "utf8" });

  const re = new RegExp("^.*" + option + ".*$", "gm");
  let value = newValue;
  if (!hostConfig) {
    value = option + " = " + newValue;
  }
  const formatted = old.replace(re, value);

  fse.writeFileSync(file, formatted, "utf8", function (err) {
    if (err) return sorrirLogger.error(err);
  });
}

function isValidConfig(config: any): boolean {
  // Condition 1: Enough replicas / execution sites to satisfy faultmodel/f specification?
  if (config?.mechanisms?.activeReplication?.n > -1) {
    if (
      (config?.mechanisms?.activeReplication?.faultModel === "BFT" &&
        config?.mechanisms?.activeReplication?.n <
          3 * config?.mechanisms?.activeReplication?.f + 1) ||
      (config?.mechanisms?.activeReplication?.faultModel === "CFT" &&
        config?.mechanisms?.activeReplication?.n <
          2 * config?.mechanisms?.activeReplication?.f + 1)
    ) {
      sorrirLogger.error(
        "Too few replicas specified to support this configuration"
      );
      return false;
    }
  }

  // To be completed

  return true;
}
