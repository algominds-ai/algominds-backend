import { z } from "zod";

const JsonValueSchema = z.json();

export type JsonValue = z.infer<typeof JsonValueSchema>;

function isPlainRecord(value: JsonValue): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullOnlySchema(value: JsonValue): boolean {
	return (
		isPlainRecord(value) &&
		value.type === "null" &&
		Object.keys(value).length === 1
	);
}

function typedMemberOf(
	members: readonly JsonValue[],
): Record<string, JsonValue> | null {
	if (members.length !== 2) return null;
	const first = members[0];
	const second = members[1];
	if (first === undefined || second === undefined) return null;
	if (isNullOnlySchema(first) && isPlainRecord(second)) return second;
	if (isNullOnlySchema(second) && isPlainRecord(first)) return first;
	return null;
}

function nullableType(typed: Record<string, JsonValue>): JsonValue[] | null {
	const kind = typed.type;
	return typeof kind === "string" ? [kind, "null"] : null;
}

/** Folds a nullable `anyOf: [{type}, {type:"null"}]` into `type: [<type>, "null"]` on the typed member, or returns `value` unchanged when the union is not that shape. */
function foldNullableAnyOf(
	value: Record<string, JsonValue>,
): Record<string, JsonValue> {
	const anyOf = value.anyOf;
	if (!Array.isArray(anyOf)) return value;
	const typed = typedMemberOf(anyOf);
	const type = typed ? nullableType(typed) : null;
	if (!typed || !type) return value;
	const { anyOf: _dropped, ...rest } = value;
	return { ...rest, ...typed, type };
}

const DROPPED_KEYS = new Set(["$schema", "pattern"]);

function encodeValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(encodeValue);
	if (!isPlainRecord(value)) return value;
	const folded = foldNullableAnyOf(value);
	const result: Record<string, JsonValue> = {};
	for (const [key, val] of Object.entries(folded)) {
		if (DROPPED_KEYS.has(key)) continue;
		result[key] = encodeValue(val);
	}
	return result;
}

/**
 * Rewrites a zod-generated JSON schema into the shape Exa's agent measurably
 * accepts: no top-level `$schema`, no `pattern` anywhere, and a nullable
 * union of one typed schema plus `{ type: "null" }` folded into that
 * schema's own `type` array. A request carrying the unrewritten shape
 * returned `companies: null` or invented rows; the rewritten shape returned
 * real ones.
 */
export function encodeAgentOutputSchema(schema: JsonValue): JsonValue {
	return encodeValue(schema);
}
