import convict from "convict";
import * as _ from "lodash";
import { CommOption } from "./communication/comm-tech";
import * as reflect from "./util/reflect";

// Define config for list of units
const preConfig: any = convict({
  units: {
    doc: "The application environment.",
    format: Array,
    default: [],
    env: "UNITS",
  },
});

// Define application configuration schema
const schema: any = {
  env: {
    doc: "The application environment.",
    format: ["production", "development", "test", "replication_test"],
    default: "production",
    env: "NODE_ENV",
    arg: "env",
  },
  toExecute: {
    doc: "Unit name to execute",
    format: String,
    default: "",
    env: "TO_EXECUTE",
    arg: "to-execute",
  },
  HostConfiguration: {},
  DeploymentConfiguration: {},
  CommunicationConfiguration: {},
  MQTTConfiguration: {},
  BLEConfiguration: {},
  ShadowModeConfiguration: {},
  DegradationConfiguration: {},
  DebuggingConfiguration: {},
  ResilienceConfiguration: {},
};
const HostConfigurationSchema: any = {
  host: {
    doc: "Host of the unit",
    format: String,
    default: "localhost",
  },
  port: {
    doc: "Port of the unit",
    format: Number,
    default: 1234,
  },
};
const DeploymentConfigurationSchema: any = {
  components: {
    doc: "List of components for this unit",
    format: Array,
    default: [],
  },
  resilienceLibrary: {
    directoryPath: {
      doc: "path to resilience library",
      format: String,
      default: "./resilience_library/",
    },
  },
};
// todo: adapt analoguously to interface Connection definition
const CommunicationConfigurationSchema: any = {
  connectionTechs: {
    doc: "List of connection objects with fields: sourcePort, targetPort, commOption",
    format: function check(commArray: any[]) {
      if (!commArray || !Array.isArray(commArray)) {
        throw new Error(
          "Wrong format for CommunicationConfiguration json structure given"
        );
      }

      commArray.forEach(function (item: any, index: any) {
        if (!item.sourceComponent) {
          throw new Error(
            "sourceComponent must be given for indexed element".concat(index)
          );
        }
        if (!item.sourcePort) {
          throw new Error(
            "sourcePort must be given for indexed element".concat(index)
          );
        }
        if (!item.sourceContainer) {
          throw new Error(
            "sourceContainer must be given for indexed element".concat(index)
          );
        }
        if (!item.targetComponent) {
          throw new Error(
            "targetComponent must be given for indexed element".concat(index)
          );
        }
        if (!item.targetPort) {
          throw new Error(
            "targetPort must be given for indexed element".concat(index)
          );
        }
        if (!item.targetContainer) {
          throw new Error(
            "targetContainer must be given for indexed element".concat(index)
          );
        }
        if (item.sourceContainer === item.targetContainer) {
          throw new Error(
            "connectionTechs only usable for different containers, at indexed element".concat(
              index
            )
          );
        }
        if (!item.commOption) {
          throw new Error(
            "commOption must be given for indexed element".concat(index)
          );
        }
      });
    },
    default: [],
  },
};
const MQTTConfigurationSchema: any = {
  host: {
    doc: "Host for the broker.",
    format: String,
    default: "",
  },
  username: {
    doc: "username to use for secure connection.",
    format: String,
    default: "",
  },
  password: {
    doc: "password to use for secure connection.",
    format: String,
    default: "",
  },
};
const BLEConfigurationSchema: any = {
  sendHost: {
    doc: "Host name of the BLE proxy.",
    format: String,
    default: "localhost",
  },
  sendPort: {
    doc: "Port of the units BLE proxy server.",
    format: Number,
    default: 8080,
  },
  listenHost: {
    doc: "Host name that the unit shall listen for from the BLE proxy server.",
    format: String,
    default: "localhost",
  },
  listenPort: {
    doc: "Port that the unit shall listen for from the BLE proxy server.",
    format: Number,
    default: 8081,
  },
};

const resilienceComponentSchema: any = {
  id: {
    doc: "Id of the component to be made resilient",
    format: "String",
    default: "",
  },
  mechanisms: {
    activeReplication: {
      enabled: {
        doc: "If replication is enabled",
        format: "Boolean",
        default: false,
      },
      n: {
        doc: "Number of replicas",
        format: "int",
        default: 4,
      },
      f: {
        doc: "upper bound of faulty replicas",
        format: "int",
        default: 1,
      },
      faultModel: {
        doc: "fault model used for replication",
        format: "String",
        default: "BFT",
      },
      executionSites: {
        doc: "Sites to deploy replicas",
        format: "Array",
        default: [],
      },
    },
    checkpointRecovery: {
      checkpoint: {
        enabled: {
          doc: "If checkpointing is enabled",
          format: "Boolean",
          default: false,
        },
      },
      recovery: {
        enabled: {
          doc: "If recovery is enabled",
          format: "Boolean",
          default: false,
        },
      },
    },
  },
};

convict.addFormat({
  name: "components-array-with-resilience-mechanisms",
  validate: function (components) {
    if (!Array.isArray(components)) {
      throw new Error("must be of type Array");
    }

    for (const component of components) {
      convict(resilienceComponentSchema).load(component).validate();
    }
  },
});

const ResilienceConfigurationSchema: any = {
  components: {
    doc: "List of components to which resilience mechanisms are applied",
    format: "components-array-with-resilience-mechanisms",
    default: [],
  },
};

let appConfig: null | convict.Config<unknown> = null;
let appConfigValidated = false;

function loadAndValidateAppConfig(): void {
  // pre config
  preConfig.loadFile("./config/units.json");
  preConfig.validate({ allowed: "strict" });

  // config
  // Inject dynamic schema based on unit configuration
  for (const unit of preConfig.get("units")) {
    schema.HostConfiguration[unit] = _.cloneDeep(HostConfigurationSchema);
    schema.BLEConfiguration[unit] = _.cloneDeep(BLEConfigurationSchema);
    schema.ShadowModeConfiguration[unit] = _.cloneDeep(
      shadowModeConfigurationSchema
    );
    schema.DebuggingConfiguration[unit] = _.cloneDeep(
      debuggingConfigurationSchema
    );

    for (const key in schema.HostConfiguration[unit]) {
      // Generate ENV pattern for each host/post combo (eg C_HOST and C_PORT)
      schema.HostConfiguration[unit][key]["env"] =
        unit.toUpperCase() + "_" + key.toUpperCase();
    }
    for (const key in schema.BLEConfiguration[unit]) {
      // Generate ENV pattern for each host/post combo (eg C_HOST and C_PORT)
      schema.BLEConfiguration[unit][key]["env"] =
        unit.toUpperCase() + "_" + key.toUpperCase();
    }
    for (const key in schema.ShadowModeConfiguration[unit]) {
      schema.ShadowModeConfiguration[unit][key]["env"] =
        unit.toUpperCase() + "_" + key.toUpperCase();
    }
    for (const key in schema.DebuggingConfiguration[unit]) {
      schema.DebuggingConfiguration[unit][key]["env"] =
        unit.toUpperCase() + "_" + key.toUpperCase();
    }
    schema.DeploymentConfiguration[unit] = _.cloneDeep(
      DeploymentConfigurationSchema
    );
  }
  schema.CommunicationConfiguration = _.cloneDeep(
    CommunicationConfigurationSchema
  );
  schema.MQTTConfiguration = _.cloneDeep(MQTTConfigurationSchema);

  schema.ResilienceConfiguration = _.cloneDeep(ResilienceConfigurationSchema);

  schema.DegradationConfiguration = _.cloneDeep(degradationConfigurationSchema);

  // Load environment dependent configuration
  appConfig = convict(schema);
  const env = appConfig.get("env");
  appConfig.loadFile("./config/" + env + ".json");

  // Perform strict validation
  appConfig.validate({ allowed: "strict" });

  appConfigValidated = true;
}

export function getPreConfig(): convict.Config<unknown> {
  if (!appConfigValidated) {
    loadAndValidateAppConfig();
  }
  return preConfig;
}

export function getAppConfig(): convict.Config<unknown> {
  if (!appConfigValidated) {
    loadAndValidateAppConfig();
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return appConfig!;
}

//Security schema
const securitySchema: any = {
  ssl: {
    doc: "Enable HTTPS for this host",
    format: Boolean,
    default: false,
  },
  privateKey: {
    doc: "Location of the private key for ssl",
    format: String,
    default: "",
  },
  passphrase: {
    doc: "Private key's passphrase",
    format: String,
    default: "",
  },
  certificate: {
    doc: "Location of the certificate",
    format: String,
    default: "",
  },
  communicationSecret: {
    doc: "Secret",
    format: Array,
    default: [],
  },
};
//Shadow-mode configuration schema
const shadowModeConfigurationSchema: any = {
  inMessageSharing: {
    enabled: {
      doc: "Specifies if shadow modes are shared as part of regular messages.",
      format: Boolean,
      default: true,
    },
    limit: {
      doc: "Specifies the maximum number of entries to be shared in a message. '-1' disables the limit.",
      format: Number,
      default: -1,
    },
    content: {
      doc: "Specifies if only local components are shared or if entries of the whole shadow-map can be shared.",
      format: function check(val) {
        const types = ["local-only", "all"];
        if (!types.includes(val)) {
          throw new Error(`Contents needs to be one of ${types}`);
        }
      },
      default: "local-only",
    },
  },
  shadowAgent: {
    enabled: {
      doc: "Specifies if the shadow agent is enabled for this unit.",
      format: Boolean,
      default: false,
    },
    commOptions: {
      doc: "Communication technologies that shadow-agent uses.",
      format: function check(list: any) {
        // workaround for some objects being shown as empty array because of convict
        if (
          !Array.isArray(list) ||
          list.length !== Object.values(list).length
        ) {
          throw new Error(
            `'${JSON.stringify(
              _.fromPairs(_.toPairs(list))
            )}' is not of type Array`
          );
        }

        // check content of array
        const types = Object.values(CommOption);
        list.forEach((val: any) => {
          if (!Object.values(CommOption).includes(val)) {
            throw new Error(`Array needs to contain only elements of ${types}`);
          }
        });
      },
      default: ["REST"],
    },
    autoUpdate: {
      intervalSeconds: {
        doc: "Interval in which the shadow map is automatically updated. A value of '-1' disables auto-updating.",
        format: Number,
        default: -1,
      },
      strategy: {
        doc: "Strategy for auto-updates of shadow map",
        format: function check(val) {
          const types = ["push", "gossip"];
          if (!types.includes(val)) {
            throw new Error(`Update strategy needs to be one of ${types}`);
          }
        },
        default: "push",
      },
      limit: {
        doc: "Specifies the maximum number of entries to be shared in an auto-update message. '-1' disables the limit.",
        format: Number,
        default: -1,
      },
      content: {
        doc: "Specifies if only local components are shared or if entries of the whole shadow-map can be shared.",
        format: function check(val) {
          const types = ["local-only", "all"];
          if (!types.includes(val)) {
            throw new Error(`Contents needs to be one of ${types}`);
          }
        },
        default: "local-only",
      },
    },
  },
};

// Degradation configuration schema
const degradationConfigurationSchema: any = {
  degradableComponents: [
    {
      name: {
        doc: "The name of the degradable component",
        format: String,
        default: "",
      },
      subcomponents: {
        doc: "Specifies the set of required subcomponents with: id, name, shadowmodes",
        format: function check(componentArray: any[]) {
          if (!componentArray || !Array.isArray(componentArray)) {
            throw new Error(
              "The format of the DegradationConfiguration is invalid"
            );
          }
          componentArray.forEach(function (item: any, index: any) {
            // This value is actually never needed, but included by the degradation configuration GUI
            if (!item.id) {
              throw new Error(
                "The component is required to have an ID".concat(index)
              );
            }
            if (!item.name) {
              throw new Error(
                "The component is required to have a name".concat(index)
              );
            }
            if (!item.shadowmodes) {
              throw new Error(
                "The component is required to have a set of shadow modes".concat(
                  index
                )
              );
            }
          });
        },
        default: [],
      },
      degradationLevels: {
        doc: "Specifies the set of operating modes",
        format: function check(levelArray: any[]) {
          if (!levelArray || !Array.isArray(levelArray)) {
            throw new Error(
              "The format of the DegradationConfiguration is invalid"
            );
          }
          levelArray.forEach(function (item: any, index: any) {
            // This value is actually never needed, but included by the degradation configuration GUI
            if (!item.id) {
              throw new Error(
                "The operating mode is required to have an ID".concat(index)
              );
            }
            if (!item.label) {
              throw new Error(
                "The operating mode is required to have a label".concat(index)
              );
            }
            if (!item.dependencySets) {
              throw new Error(
                "The operating mode is required to have a set of dependency sets".concat(
                  index
                )
              );
            }
            if (!item.states) {
              throw new Error(
                "The operating mode is required to have a set of states".concat(
                  index
                )
              );
            }
          });
        },
        default: [],
      },
      degradations: {
        doc: "Specifies the set of transfer functions available for degradation",
        format: function check(degradationArray: any[]) {
          if (!degradationArray || !Array.isArray(degradationArray)) {
            throw new Error(
              "The format of the DegradationConfiguration is invalid"
            );
          }
          degradationArray.forEach(function (item: any, index: any) {
            // This value is actually never needed, but included by the degradation configuration GUI
            if (!item.resultingDegradationLeveId) {
              throw new Error(
                "The transfer function is required to have a resulting degradation level".concat(
                  index
                )
              );
            }
            if (!item.startDegradationLevelId) {
              throw new Error(
                "The transfer function is required to have a starting degradation level".concat(
                  index
                )
              );
            }
            if (!item.stateChanges) {
              throw new Error(
                "The transfer function is required to have a set of state mappings".concat(
                  index
                )
              );
            }
          });
        },
        default: [],
      },
      upgrades: {
        doc: "Specifies the set of transfer functions available for upgrades",
        format: function check(degradationArray: any[]) {
          if (!degradationArray || !Array.isArray(degradationArray)) {
            throw new Error(
              "The format of the DegradationConfiguration is invalid"
            );
          }
          degradationArray.forEach(function (item: any, index: any) {
            // This value is actually never needed, but included by the degradation configuration GUI
            if (!item.resultingDegradationLeveId) {
              throw new Error(
                "The transfer function is required to have a resulting degradation level".concat(
                  index
                )
              );
            }
            if (!item.startDegradationLevelId) {
              throw new Error(
                "The transfer function is required to have a starting degradation level".concat(
                  index
                )
              );
            }
            if (!item.stateChanges) {
              throw new Error(
                "The transfer function is required to have a set of state mappings".concat(
                  index
                )
              );
            }
          });
        },
        default: [],
      },
    },
  ],
};

//Debugging configuration schema
const debuggingConfigurationSchema: any = {
  debuggingAgent: {
    enabled: {
      doc: "Specifies if the debugging agent is enabled for this unit.",
      format: Boolean,
      default: false,
    },
    isServer: {
      doc: "Specifies if the debugging agent shall receive data from and be able to control other debugging agents.",
      format: Boolean,
      default: false,
    },
    checkForChangesIntervalMs: {
      doc: "The interval in which changes are being checked, potentially triggering an update to servers.",
      format: Number,
      default: 1000,
    },
    webSocketPort: {
      doc: "The port of the websocket of the debugging server.",
      format: Number,
      default: 3001,
    },
    commOptions: {
      doc: "Communication technologies that debugging-agent uses.",
      format: function check(list: any) {
        // workaround for some objects being shown as empty array because of convict
        if (
          !Array.isArray(list) ||
          list.length !== Object.values(list).length
        ) {
          throw new Error(
            `'${JSON.stringify(
              _.fromPairs(_.toPairs(list))
            )}' is not of type Array`
          );
        }

        // check content of array
        const types = Object.values(CommOption);
        list.forEach((val: any) => {
          if (!Object.values(CommOption).includes(val)) {
            throw new Error(`Array needs to contain only elements of ${types}`);
          }
        });
      },
      default: ["REST"],
    },
  },
};
// Define setup configuration schema
const connectionSchema: any = {
  sourceComponent: {
    doc: "Name of source component.",
    default: undefined,
    format: String,
  },
  targetComponent: {
    doc: "Name of target component",
    default: undefined,
    format: String,
  },
  sourcePort: {
    doc: "Name of source port",
    default: undefined,
    format: String,
  },
  targetPort: {
    doc: "Name of target port",
    default: undefined,
    format: String,
  },
};
const componentInstanceSchema: any = {
  name: {
    doc: "Name of component instance.",
    default: undefined,
    format: String,
  },
  startState: {
    doc: "Start state of component instance.",
    default: undefined,
    format: String,
  },
  startStateGenerator: {
    doc: "StateGenerator for start state of component instance.",
    default: undefined,
    format: String,
  },
  startStateArgs: {
    doc: "Args for StateGenerator for start state of component instance.",
    default: {},
    format: function check(obj: any) {
      if (typeof obj !== "object") {
        throw new Error(`${obj} is not of type Object`);
      }
      if (
        !_.every(Object.values(obj), (val) =>
          ["number", "boolean", "string"].includes(typeof val)
        )
      ) {
        throw new Error(
          `A value of '${obj}' is not of type number, string or boolean.`
        );
      }
    },
  },
};
const setupSchema: any = {
  componentInstances: {},
  connections: {
    doc: "Connections",
    default: null,
    format: function check(list: any) {
      // catch value not being set
      if (list === null) {
        throw new Error(
          `Value is 'null', must be list of schema '${JSON.stringify(
            connectionSchema,
            undefined,
            2
          )}'`
        );
      }
      // workaround for some objects being shown as empty array because of convict
      if (!Array.isArray(list) || list.length !== Object.values(list).length) {
        throw new Error(
          `'${JSON.stringify(
            _.fromPairs(_.toPairs(list))
          )}' is not of type Array`
        );
      }

      list.forEach((item: any) => {
        convict(connectionSchema).load(item).validate({ allowed: "strict" });
      });
    },
  },
};
const getComponentSchema = (componentName: string) => {
  return {
    doc: `Instances of ${componentName} component.`,
    default: null,
    format: function check(list: any) {
      // catch value not being set
      if (list === null) {
        throw new Error(
          `Value is 'null', must be list of schema '${JSON.stringify(
            componentInstanceSchema,
            undefined,
            2
          )}'`
        );
      }
      // workaround for some objects being shown as empty array because of convict
      if (!Array.isArray(list) || list.length !== Object.values(list).length) {
        throw new Error(
          `'${JSON.stringify(
            _.fromPairs(_.toPairs(list))
          )}' is not of type Array`
        );
      }

      list.forEach((item: any) => {
        convict(componentInstanceSchema)
          .load(item)
          .validate({ allowed: "strict" });
      });
    },
  };
};

// add components to schema
Object.keys(reflect.getAllComponents()).forEach((componentName) => {
  setupSchema.componentInstances[componentName] =
    getComponentSchema(componentName);
});

const setupConfig = convict(setupSchema);
let setupConfigValidated = false;

function loadAndValidateSetupConfig(): void {
  setupConfig.loadFile("./config/setup.json");
  setupConfig.validate({ allowed: "strict" });
  setupConfigValidated = true;
}

export function getSetupConfig(): convict.Config<unknown> {
  if (!setupConfigValidated) {
    loadAndValidateSetupConfig();
  }
  return setupConfig;
}

export function getSecurityConfig(): convict.Config<unknown> | null {
  const env = appConfig?.get("env");
  const securityConfig = convict(securitySchema);
  try {
    securityConfig.loadFile(`./config/${env}.sec.json`);
    securityConfig.validate({ allowed: "strict" });
    return securityConfig;
  } catch (e) {
    return null;
  }
}

export function getDegradationConfig(): convict.Config<unknown> | null {
  const env = appConfig?.get("env");
  const degradationConfig = convict(degradationConfigurationSchema);
  try {
    degradationConfig.loadFile(`./config/${env}.deg.json`);
    degradationConfig.validate({ allowed: "strict" });
    return degradationConfig;
  } catch (e) {
    return null;
  }
}
