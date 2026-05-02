	const BASE = 'http://127.0.0.1:7432';

	export async function getStatus(): Promise<any> {
		try {
			const res = await fetch(`${BASE}/status`);
			if (!res.ok) { return null; }
			return await res.json();
		} catch {
			return null;
		}
	}

	export async function sendCommand(action: string, extra: object = {}): Promise<void> {
		try {
			await fetch(`${BASE}/command`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, ...extra })
			});
		} catch {
			// agent offline, silently fail
		}
	}

	export async function getLog(): Promise<any> {
		try {
			const res = await fetch(`${BASE}/log`);
			if (!res.ok) { return null; }
			return await res.json();
		} catch {
			return null;
		}
	}