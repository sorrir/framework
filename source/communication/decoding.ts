import * as _ from "lodash";
import {
  Event,
  DistributiveOmit,
  EventClass,
  UUID,
  EventSourceApplicationLayer,
  EventSourceFrameworkLayer,
} from "../util/engine";
import { RunConfiguration } from "../exec-types";
import { raw } from "express";
import { ShadowMap, ShadowEntry } from "../util/degradation";
import * as sorrirLogger from "@sorrir/sorrir-logging";
import { Stakeholder } from "@sorrir/sorrir-logging";

/**
 * Decodes the given payload and combines it with a partial event to create a full [Event].
 */
export type DecodeEventFunction = (
  payload: Readonly<Record<string, unknown>>,
  partialEvent: PartialEvent<unknown, unknown>
) => Event<unknown, unknown>;

/**
 * Partial event that only includes non-nullable keys of events.
 */
export type PartialEvent<EVENT_TYPE, PORT_TYPE> = DistributiveOmit<
  Event<EVENT_TYPE, PORT_TYPE>,
  "param" | "port" | "timestamp"
>;

/**
 * Decodes common parameters of a JSON encoded event to create a partial event.
 */
export type PartialDecodeEventFunction = (
  json: any
) => PartialEvent<unknown, unknown> | undefined;

export function setDecoder(
  runc: RunConfiguration,
  event: string, // Shouldn't this be EVENT_TYPE as type?
  decoder: DecodeEventFunction | undefined
): RunConfiguration {
  if (decoder) {
    (runc.decodeEventFunctions as any) = {
      ...runc.decodeEventFunctions,
      [event]: decoder,
    };
  } else {
    (runc.decodeEventFunctions as any) = _.omit(
      runc.decodeEventFunctions,
      event
    );
  }
  return runc;
}

/**
 * Basic partial decoder that decodes a partial event from an event, given as arbitrary object.
 *
 * @param event the event as object
 * @returns partial event
 */
export const basicPartialDecoder: PartialDecodeEventFunction = (
  event: Record<string, unknown>
) => {
  // TODO: decrypt things

  if (typeof event !== "object") {
    sorrirLogger.error(Stakeholder.SYSTEM, "Event is not an object.", {});
    return undefined;
  }
  if (!("type" in event)) {
    sorrirLogger.error(Stakeholder.SYSTEM, "Event has no type.", {});
    return undefined;
  }
  if (!("id" in event)) {
    sorrirLogger.error(Stakeholder.SYSTEM, "Event has no id.", {});
    return undefined;
  }
  if (!("eventClass" in event)) {
    sorrirLogger.error(Stakeholder.SYSTEM, "Event has no eventClass.", {});
    return undefined;
  }

  const commonAttributes = {
    type: event.type,
    id: <UUID>event.id,
    eventClass: <EventClass>event.eventClass,
  };

  switch (commonAttributes.eventClass) {
    case "oneway": {
      return <PartialEvent<unknown, unknown>>{ ...commonAttributes };
    }
    case "request": {
      return <PartialEvent<unknown, unknown>>{ ...commonAttributes };
    }
    case "resolve": {
      const rc = parseInt(<string>event.rc);
      if (isNaN(rc)) {
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          "Event return code is not a number.",
          { rc: rc }
        );
        return undefined;
      }
      if (!("answerToRequestID" in event)) {
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          "Event has no answerToRequestID.",
          {}
        );
        return undefined;
      }

      return <PartialEvent<unknown, unknown>>{
        ...commonAttributes,
        rc: rc,
        answerToRequestID: event.answerToRequestID,
      };
    }
    case "error": {
      if (
        event.layer !== "FrameworkLayer" &&
        event.layer !== "ApplicationLayer"
      ) {
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          "Event layer is not valid - 'FrameworkLayer' or 'ApplicationLayer' expected.",
          {
            layer: event.layer,
          }
        );
        return undefined;
      }

      const rc = parseInt(<string>event.rc);
      if (isNaN(rc)) {
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          "Event return code is not a number.",
          { rc: rc }
        );
        return undefined;
      }
      if (!("answerToRequestID" in event)) {
        sorrirLogger.error(
          Stakeholder.SYSTEM,
          "Event has no answerToRequestID.",
          {}
        );
        return undefined;
      }
      if (!("error" in event)) return undefined;

      return {
        ...commonAttributes,
        rc: rc,
        answerToRequestID: <UUID>event.answerToRequestID,
        error: <string>event.error,
        layer: <EventSourceApplicationLayer | EventSourceFrameworkLayer>(
          event.layer
        ),
      };
    }
    default:
      return undefined;
  }
};

/**
 * Directly merges a payload and given optional parameters into a partial event to create a full event.
 *
 * @param payload the payload
 * @param partialEvent the partial event
 * @returns the merged full event
 */
export const basicEventDecoder: DecodeEventFunction = (
  payload: Readonly<Record<string, unknown>>,
  partialEvent: PartialEvent<unknown, unknown>
) => {
  return {
    ...partialEvent,
    param: {
      ...payload,
    },
  };
};

export type ExtraDataDecodeFunction = (
  rawEvent: Record<string, unknown>
) => ExtraData;

export const basicExtraDataDecoder: ExtraDataDecodeFunction = (
  rawEvent: Record<string, unknown>
) => {
  const shadowMap =
    typeof rawEvent.shadowMap === "object" && rawEvent.shadowMap !== null
      ? new Map(Object.entries(rawEvent.shadowMap))
      : undefined;
  return {
    shadowMap: shadowMap,
  };
};

export type ExtraData = {
  shadowMap?: ShadowMap<unknown>;
};

export type DecoderOutput = {
  event?: Event<unknown, unknown>;
  extraData?: ExtraData;
};

/**
 * Decodes a raw event given as an object to an event if possible, using the given suiting DecodeEventFunction depending on the event type.
 *
 * @param runc run configuration that contains the decode event functions
 * @param rawEvent the event to be decoded
 * @returns the event, or undefined if no DecodeEventFunction is given for this particular EventType
 */
export function decodeRawEvent(
  runc: RunConfiguration,
  rawEvent: Record<string, unknown>,
  partialDecodeFunction: PartialDecodeEventFunction = basicPartialDecoder,
  extraDataDecodeFunction: ExtraDataDecodeFunction = basicExtraDataDecoder
): DecoderOutput {
  //TODO decrypt and check EVENT exist on components
  const partialEvent = partialDecodeFunction(rawEvent);
  if (partialEvent === undefined) {
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "Error while decoding Event: Partial Event could not be decoded.",
      {}
    );
    return { event: undefined };
  }

  const extraData = extraDataDecodeFunction(rawEvent);

  const payload = <Record<string, unknown>>rawEvent.payload ?? {};
  if (typeof payload !== "object") {
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "Error while decoding Event: Payload is not an object.",
      { payload: payload }
    );
    return { event: undefined, extraData: extraData };
  }

  const decodeEventFunction =
    runc.decodeEventFunctions?.[<string>partialEvent.type] ?? basicEventDecoder;
  try {
    return {
      event: decodeEventFunction(payload, partialEvent),
      extraData: extraData, // wasEncrypted, ...
    };
  } catch {
    sorrirLogger.error(
      Stakeholder.SYSTEM,
      "Error while decoding Event: EventDecoder failed.",
      {}
    );
    return { event: undefined, extraData: extraData };
  }
}
