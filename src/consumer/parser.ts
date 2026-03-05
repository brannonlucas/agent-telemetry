/**
 * JSONL Parser
 *
 * Reads .jsonl telemetry files line by line, validates basic structure,
 * and yields parsed records. Malformed lines are skipped with a count.
 *
 * Supports both single-file and directory mode with deterministic
 * (lexicographic) file discovery.
 */

import type { BaseRecord } from "../types.ts";

/** Result of parsing a single line. */
export interface ParsedLine {
	record: BaseRecord & Record<string, unknown>;
	source_file: string;
	source_line: number;
}

/** Diagnostic info from parsing. */
export interface ParseDiagnostics {
	malformed_lines: number;
	unknown_record_types: number;
	files_processed: number;
}

/**
 * Parse a single JSONL line.
 * Returns the parsed record or null if malformed.
 */
export function parseLine(line: string): (BaseRecord & Record<string, unknown>) | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) return null;

	try {
		const obj = JSON.parse(trimmed);
		if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
		// Must have record_type and spec_version
		if (obj.record_type !== "event" && obj.record_type !== "diagnostic") return null;
		if (obj.spec_version !== 1) return null;
		return obj as BaseRecord & Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Parse JSONL content string into records.
 * Yields parsed lines with source metadata.
 */
export function parseContent(
	content: string,
	sourceFile: string,
): { records: ParsedLine[]; diagnostics: ParseDiagnostics } {
	const lines = content.split("\n");
	const records: ParsedLine[] = [];
	const diagnostics: ParseDiagnostics = {
		malformed_lines: 0,
		unknown_record_types: 0,
		files_processed: 1,
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().length === 0) continue;

		const record = parseLine(line);
		if (record === null) {
			diagnostics.malformed_lines++;
			continue;
		}

		records.push({
			record: record,
			source_file: sourceFile,
			source_line: i + 1,
		});
	}

	return { records, diagnostics };
}

/**
 * Parse a JSONL file from the filesystem.
 * Async to support both Node and Bun runtimes.
 */
export async function parseFile(
	filePath: string,
): Promise<{ records: ParsedLine[]; diagnostics: ParseDiagnostics }> {
	const fsPromises = await import("node:fs/promises");
	const content = await fsPromises.readFile(filePath, "utf-8");
	return parseContent(content, filePath);
}

/**
 * Parse all .jsonl files in a directory.
 * Files are discovered in lexicographic order for determinism.
 */
export async function parseDirectory(
	dirPath: string,
): Promise<{ records: ParsedLine[]; diagnostics: ParseDiagnostics }> {
	const fsPromises = await import("node:fs/promises");
	const path = await import("node:path");

	const entries = await fsPromises.readdir(dirPath);
	const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl")).sort();

	const allRecords: ParsedLine[] = [];
	const diagnostics: ParseDiagnostics = {
		malformed_lines: 0,
		unknown_record_types: 0,
		files_processed: 0,
	};

	for (const file of jsonlFiles) {
		const result = await parseFile(path.join(dirPath, file));
		allRecords.push(...result.records);
		diagnostics.malformed_lines += result.diagnostics.malformed_lines;
		diagnostics.unknown_record_types += result.diagnostics.unknown_record_types;
		diagnostics.files_processed++;
	}

	return { records: allRecords, diagnostics };
}
