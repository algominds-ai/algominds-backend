// ponytail: @ai-sdk/provider-utils pulls undici; Workers has a global fetch.
// A top-level throw would fire at import time and kill the Worker at startup,
// because the package is imported at module scope. This imports cleanly and
// fails loudly only if something actually reaches for undici.
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
