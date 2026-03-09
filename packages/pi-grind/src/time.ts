function setTimeParts(base: Date, hours: number, minutes: number, seconds = 0): Date {
	const next = new Date(base);
	next.setHours(hours, minutes, seconds, 0);
	return next;
}

function parseClockValue(input: string): { hours: number; minutes: number } | null {
	const normalized = input
		.trim()
		.toLowerCase()
		.replace(/^at\s+/, "")
		.replace(/^by\s+/, "");
	const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
	if (!match) {
		return null;
	}

	let hours = Number(match[1]);
	const minutes = match[2] ? Number(match[2]) : 0;
	const meridiem = match[3]?.toLowerCase();

	if (minutes < 0 || minutes > 59) {
		return null;
	}

	if (meridiem) {
		if (hours < 1 || hours > 12) {
			return null;
		}
		if (meridiem === "pm" && hours !== 12) {
			hours += 12;
		}
		if (meridiem === "am" && hours === 12) {
			hours = 0;
		}
	} else if (hours > 23) {
		return null;
	}

	return { hours, minutes };
}

function stripTrailingContinuation(text: string): string {
	return text
		.trim()
		.replace(/\s+(?:and|then)\b[\s\S]*$/i, "")
		.trim();
}

export function parseDeadline(raw: string, now: Date = new Date()): Date | null {
	const candidate = raw.trim();
	if (!candidate) {
		return null;
	}

	const normalized = candidate
		.toLowerCase()
		.replace(/^until\s+/, "")
		.replace(/^by\s+/, "")
		.trim();

	if (!normalized) {
		return null;
	}

	const tomorrowMatch = normalized.match(/^tomorrow\s+(.+)$/);
	if (tomorrowMatch) {
		const time = parseClockValue(stripTrailingContinuation(tomorrowMatch[1]));
		if (!time) {
			return null;
		}
		const base = new Date(now);
		base.setDate(base.getDate() + 1);
		return setTimeParts(base, time.hours, time.minutes);
	}

	const todayMatch = normalized.match(/^today\s+(.+)$/);
	if (todayMatch) {
		const time = parseClockValue(stripTrailingContinuation(todayMatch[1]));
		if (!time) {
			return null;
		}
		return setTimeParts(now, time.hours, time.minutes);
	}

	const time = parseClockValue(stripTrailingContinuation(normalized));
	if (!time) {
		const direct = new Date(candidate);
		if (!Number.isNaN(direct.getTime())) {
			return direct;
		}
		return null;
	}

	const sameDay = setTimeParts(now, time.hours, time.minutes);
	if (sameDay.getTime() > now.getTime()) {
		return sameDay;
	}

	const nextDay = new Date(now);
	nextDay.setDate(nextDay.getDate() + 1);
	return setTimeParts(nextDay, time.hours, time.minutes);
}
