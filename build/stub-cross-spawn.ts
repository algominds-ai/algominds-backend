type UnavailableModule = { readonly [key: string]: never };

const unavailable: UnavailableModule = new Proxy(Object.create(null), {
	get(_target, property) {
		throw new Error(
			`cross-spawn is not available on Workers (accessed "${String(property)}"). The MCP stdio transport cannot run here; use transport { type: "http" }.`,
		);
	},
});

export default unavailable;
