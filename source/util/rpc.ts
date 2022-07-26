export type EventClassOneWay = "oneway";
export type EventClassRequest = "request";
export type EventClassResolve = "resolve";
export type EventClassError = "error";

export type EventClass =
  | EventClassOneWay
  | EventClassRequest
  | EventClassResolve
  | EventClassError;

export type UUID = string;

export type EventSourceApplicationLayer = "ApplicationLayer";
export type EventSourceFrameworkLayer = "FrameworkLayer";

export interface AbstractEvent<E, P> {
  readonly eventClass: EventClass;
  readonly type: E;
  readonly port?: P;
  readonly id: UUID;
}

export interface OneWayEvent<E, P> extends AbstractEvent<E, P> {
  readonly eventClass: EventClassOneWay;
  readonly payload: any;
}

export interface RequestEvent<E, P> extends AbstractEvent<E, P> {
  readonly eventClass: EventClassRequest;
  readonly param: any;
}

export interface ResolveEvent<E, P> extends AbstractEvent<E, P> {
  readonly eventClass: EventClassResolve;
  readonly rc: number;
  readonly value: any;
  readonly answerToRequestID: UUID;
}

export interface ErrorEvent<E, P> extends AbstractEvent<E, P> {
  readonly eventClass: EventClassError;
  readonly rc: number;
  readonly error: string;
  readonly answerToRequestID: UUID;
  readonly layer: EventSourceApplicationLayer | EventSourceFrameworkLayer;
}

export type Event<E, P> =
  | OneWayEvent<E, P>
  | RequestEvent<E, P>
  | ResolveEvent<E, P>
  | ErrorEvent<E, P>;

type RaiseEventCallBack<E, P> = (newEvent: Event<E, P>) => UUID;

type Action<F, M, E, P, R> = (
  myState: M,
  raiseEvent: RaiseEventCallBack<E, P>,
  event?: Event<E, P>
) => M;

export interface Transition<F, M, E, P, R> {
  readonly sourceState: F;
  readonly event?: [EventClass, E, P?];
  readonly condition?: (myState: M, event?: Event<E, P>) => boolean;
  readonly action?: Action<F, M, E, P, R>;
  readonly targetState: F;
}

// example below

enum EventTypes {
  A = "A",
  B = "B",
}
enum States {
  IDLE = "IDLE",
}

export interface ExampleEvent extends OneWayEvent<EventTypes, undefined> {
  readonly payload: string;
}

const transition: Transition<States, number, EventTypes, undefined, number> = {
  sourceState: States.IDLE,
  targetState: States.IDLE,
  action: (myState: number, raiseEvent, event?) => {
    const outgoingEvent: ExampleEvent = {
      eventClass: "oneway",
      type: EventTypes.A,
      port: undefined,
      payload: "HelloWorld",
      id: "42",
    };
    raiseEvent(outgoingEvent);
    return myState;
  },
};
