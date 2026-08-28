/** Splits `items` into consecutive groups of at most `size`, keeping their order. */
export function toBatches<T>(items: readonly T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		batches.push(items.slice(start, start + size));
	}
	return batches;
}
