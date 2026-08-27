type UnavailableModule = { readonly [key: string]: never };

const unavailable: UnavailableModule = new Proxy(Object.create(null), {
	get(_target, property) {
		throw new Error(
			`undici is not available on Workers (accessed "${String(property)}"). Use the global fetch.`,
		);
	},
});

export default unavailable;
