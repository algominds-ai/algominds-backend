export type Channel =
	| "company"
	| "people"
	| "employment"
	| "email"
	| "linkedin";

export type Provider<I, O> = {
	id: string;
	channels: Channel[];
	cost: number;
	run(input: I, env: Env): Promise<O | null>;
};
