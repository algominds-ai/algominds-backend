/** One structured log line for an external call. Omit `requestId` when the vendor gave none. */
export type LogLine = {
	provider: string;
	operation: string;
	ms: number;
	ok: boolean;
	costDollars: number;
	requestId?: string;
};

export function log(line: LogLine): void {
	console.log(JSON.stringify(line));
}
