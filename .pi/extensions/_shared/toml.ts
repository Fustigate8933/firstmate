/**
 * Minimal dependency-free TOML reader/writer for firstmate-lite.
 *
 * Scoped deliberately to the shapes our config/registry files use — NOT a full
 * TOML implementation. Supported:
 *   - top-level key = value  (string, boolean, integer, string-array)
 *   - [table] and [table.subtable] headers
 *   - "# comment" lines and inline trailing comments on simple scalars
 *   - double-quoted strings (with \" and \\ escapes), bare booleans/integers
 *   - single-line arrays of quoted strings, possibly spanning lines until ]
 *
 * This keeps the extensions self-contained (no transitive npm dependency that
 * may not resolve from the extension dir). If we ever need full TOML, swap this
 * for a real parser behind the same parseToml/stringifyToml signatures.
 */

type TomlValue = string | boolean | number | string[] | TomlTable;
interface TomlTable {
	[key: string]: TomlValue;
}

function stripComment(line: string): string {
	// Remove a trailing # comment that is not inside a string.
	let inStr = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
		else if (c === "#" && !inStr) return line.slice(0, i);
	}
	return line;
}

function parseScalar(raw: string): TomlValue {
	const s = raw.trim();
	if (s === "true") return true;
	if (s === "false") return false;
	if (/^-?\d+$/.test(s)) return Number(s);
	if (s.startsWith('"') && s.endsWith('"')) {
		return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	// bare string fallback
	return s;
}

function parseStringArray(body: string): string[] {
	// body is the content between [ and ]
	const out: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		out.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
	}
	return out;
}

export function parseToml(text: string): TomlTable {
	const root: TomlTable = {};
	let current: TomlTable = root;

	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		let line = stripComment(lines[i]).trim();
		if (line.length === 0) continue;

		// Table header
		const th = /^\[([^\]]+)\]$/.exec(line);
		if (th) {
			const parts = th[1].split(".").map((p) => p.trim());
			let node: TomlTable = root;
			for (const part of parts) {
				if (typeof node[part] !== "object" || Array.isArray(node[part])) node[part] = {} as TomlTable;
				node = node[part] as TomlTable;
			}
			current = node;
			continue;
		}

		// key = value
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let valuePart = line.slice(eq + 1).trim();

		if (valuePart.startsWith("[")) {
			// array, possibly multi-line until closing ]
			let body = valuePart;
			while (!body.includes("]") && i + 1 < lines.length) {
				i++;
				body += "\n" + stripComment(lines[i]);
			}
			const inner = body.slice(body.indexOf("[") + 1, body.lastIndexOf("]"));
			current[key] = parseStringArray(inner);
		} else {
			current[key] = parseScalar(valuePart);
		}
	}
	return root;
}

function formatScalar(v: string | boolean | number): string {
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function stringifyToml(obj: TomlTable): string {
	const topLines: string[] = [];
	const tableBlocks: string[] = [];

	const emitTable = (table: TomlTable, prefix: string) => {
		const scalarLines: string[] = [];
		const nested: Array<[string, TomlTable]> = [];
		for (const [k, v] of Object.entries(table)) {
			if (v && typeof v === "object" && !Array.isArray(v)) {
				nested.push([k, v as TomlTable]);
			} else if (Array.isArray(v)) {
				scalarLines.push(`${k} = [${v.map((s) => formatScalar(s)).join(", ")}]`);
			} else {
				scalarLines.push(`${k} = ${formatScalar(v)}`);
			}
		}
		const header = prefix ? `[${prefix}]` : "";
		const block = (header ? header + "\n" : "") + scalarLines.join("\n");
		if (prefix) tableBlocks.push(block);
		else topLines.push(...scalarLines);
		for (const [k, sub] of nested) emitTable(sub, prefix ? `${prefix}.${k}` : k);
	};

	emitTable(obj, "");
	return [topLines.join("\n"), ...tableBlocks].filter((b) => b.trim().length > 0).join("\n\n") + "\n";
}
