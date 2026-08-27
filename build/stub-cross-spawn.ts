
const reject = (prop: string): never => {
	throw new Error(
		`cross-spawn is not available on Workers (accessed "${prop}"). The MCP stdio transport cannot run here — use transport { type: "http" }.`,
	);
};

export default new Proxy(
	{},
	{
		get: (_t, prop) => reject(String(prop)),
	},
);
