
const reject = (prop: string): never => {
	throw new Error(
		`undici is not available on Workers (accessed "${prop}"). Use the global fetch.`,
	);
};

export default new Proxy(
	{},
	{
		get: (_t, prop) => reject(String(prop)),
	},
);
