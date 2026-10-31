/** A JSON-serializable value. Optional object properties may be undefined (JSON.stringify drops them). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type JsonObject = Record<string, JsonValue | undefined>;
