// Times, sizes and spans, in the words an operator reads.
//
// Radio times are UTC and say so: a call at 13:02 is 13:02Z, never "14:02" because the
// browser is in another zone. Spans are lengths, not times, and carry no Z.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function utcTime(ms: number): string {
	const when = new Date(ms);
	const day = String(when.getUTCDate()).padStart(2, '0');
	const month = MONTHS[when.getUTCMonth()] ?? '';
	const hh = String(when.getUTCHours()).padStart(2, '0');
	const mm = String(when.getUTCMinutes()).padStart(2, '0');
	return `${day} ${month} ${hh}:${mm}Z`;
}

export function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes} m` : `${minutes} m ${rest} s`;
}

export function bytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
