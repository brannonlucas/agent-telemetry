/**
 * Entity Pivoting
 *
 * Aggregates entity data across events for domain queries
 * (e.g., "all events for user X").
 */

import type { ParsedLine } from "./parser.ts";

/** Entity index: maps entity keys to maps of values to their events. */
export interface EntityIndex {
	/** Lookup: entityKey → entityValue → events containing that entity. */
	index: Map<string, Map<string, ParsedLine[]>>;
	/** All unique entity keys. */
	keys: string[];
}

/**
 * Build an entity index from parsed records.
 *
 * Scans all events for `entities` fields and builds a two-level index:
 * entity key → entity value → list of events.
 */
export function buildEntityIndex(records: ParsedLine[]): EntityIndex {
	const index = new Map<string, Map<string, ParsedLine[]>>();

	for (const parsed of records) {
		const { record } = parsed;
		const entities = record.entities as Record<string, string> | undefined;
		if (!entities || typeof entities !== "object") continue;

		for (const [key, value] of Object.entries(entities)) {
			if (typeof value !== "string") continue;

			let keyMap = index.get(key);
			if (!keyMap) {
				keyMap = new Map();
				index.set(key, keyMap);
			}

			let events = keyMap.get(value);
			if (!events) {
				events = [];
				keyMap.set(value, events);
			}
			events.push(parsed);
		}
	}

	return {
		index,
		keys: Array.from(index.keys()).sort(),
	};
}

/**
 * Look up all events associated with a specific entity value.
 */
export function lookupEntity(entityIndex: EntityIndex, key: string, value: string): ParsedLine[] {
	return entityIndex.index.get(key)?.get(value) ?? [];
}

/**
 * Get all unique values for an entity key.
 */
export function getEntityValues(entityIndex: EntityIndex, key: string): string[] {
	const keyMap = entityIndex.index.get(key);
	if (!keyMap) return [];
	return Array.from(keyMap.keys()).sort();
}
