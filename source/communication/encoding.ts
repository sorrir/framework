import * as _ from "lodash";
import { identity } from "lodash";
import { eventNames } from "process";
import { AtomicComponent } from "../util/component";
import { ShadowMap } from "../util/degradation";
import { AbstractState, Event, RequestEvent, ErrorEvent } from "../util/engine";

/**
 * Encodes an event so that it can be sent via communication protocols.
 *
 * @param event the event to be encoded
 * @param sourceComponent the component the event was sent from
 * @param lastCheckpoint id of the last checkpoint
 * @param timestamp last timestamp
 * @returns the encoded event
 */
export function encodeEvent(
  event: Event<unknown, unknown>,
  sourceComponent?: AtomicComponent<any, any, undefined>,
  lastCheckpoint?: number,
  timestamp?: number,
  shadowMap?: ShadowMap<unknown>
): Record<string, unknown> {
  return _.pickBy(
    {
      type: event.type,
      id: event.id,
      eventClass: event.eventClass,
      payload: (<any>event).param,
      timestamp: timestamp,
      lastCheckpoint: lastCheckpoint,
      sender: sourceComponent?.id ?? sourceComponent?.name,
      rc: (<any>event).rc,
      answerToRequestID: (<any>event).answerToRequestID,
      layer: (<ErrorEvent<any, any>>event).layer,
      error: (<ErrorEvent<any, any>>event).error,
      shadowMap:
        shadowMap !== undefined
          ? _.reduce(
              Array.from(<any>shadowMap),
              (obj, entry) => {
                obj[(<any>entry)[0]] = (<any>entry)[1];
                return obj;
              },
              {}
            )
          : {},
    },
    (e) => e !== undefined
  );
}
