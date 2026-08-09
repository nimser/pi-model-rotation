#!/usr/bin/env node
import { readQuotas } from "../src/quota.ts";

const entries = await readQuotas({ refresh: process.argv.includes("--refresh") });
if (process.argv.includes("--json")) {
	console.log(JSON.stringify(entries));
} else {
	for (const entry of entries) {
		const quota = entry.reachable
			? `${entry.usedPercent?.toFixed(1)}% used, resets ${entry.resetsAt}`
			: `unreachable: ${entry.reason}`;
		console.log(`${entry.active ? "*" : " "} ${entry.provider}/${entry.account}: ${quota}`);
	}
}
